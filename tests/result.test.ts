import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getOrCreateNextBatch, loadBatchBody, type BuiltBatch } from '../src/batches/builder.js';
import { releaseBatch, applyResult, BatchClosedError, BatchNotFoundError, CorrelationMismatchError } from '../src/batches/result.js';
import { parseMilli } from '../src/domain/quantity.js';
import { runLedgerOnce } from '../src/ledger/worker.js';
import { setAnchor } from '../src/ledger/service.js';
import { resetDb, testPool } from './helpers/db.js';
import { emitReadings, seedCodedStation, seedCodedTank, seedRefs, type CodedStation, type CodedTank } from './helpers/fixtures.js';

const pool = testPool(12);
const NOW = new Date('2026-11-03T12:00:00Z');
const opts = { now: () => NOW };
const ledger = { policy: 'allow' as const, now: () => new Date('2026-11-03T23:00:00Z') };

let ST: CodedStation;
let A: CodedTank;
let B: CodedTank;

beforeEach(async () => {
  await resetDb(pool);
  await seedRefs(pool);
  ST = await seedCodedStation(pool, 1);
  A = await seedCodedTank(pool, ST, 1);
  B = await seedCodedTank(pool, ST, 2);
});
afterAll(() => pool.end());

/** Five items in this order: A@0, B@1, A@2, B@3, A@4 (positions 0 to 4). */
async function fiveItemBatch(): Promise<BuiltBatch> {
  await emitReadings(pool, A.id, [
    { minute: 0, fuel: '1000' },
    { minute: 2, fuel: '990' },
    { minute: 4, fuel: '980' },
  ]);
  await emitReadings(pool, B.id, [
    { minute: 1, fuel: '500' },
    { minute: 3, fuel: '490' },
  ]);
  return (await getOrCreateNextBatch(pool, ST.id, opts))!;
}

const moenergyError = (itemIndex: number, sourceErrorCode: string, field = 'fuel_quantity') => ({
  errors: [
    {
      code: 'b1f462f96a7d74323e8fae21',
      message: `item_index: ${itemIndex} - field: ${field}`,
      sourceErrorCode,
      sourceMessage: `${sourceErrorCode} happened`,
    },
  ],
});

const batchRow = async (id: number) =>
  (await pool.query(`SELECT status, moenergy_result_code AS code, item_index FROM batches WHERE id = $1`, [id])).rows[0];
const loadBody = async (id: number) => {
  const c = await pool.connect();
  try {
    return await loadBatchBody(c, id);
  } finally {
    c.release();
  }
};
const emittedFor = async (tank: CodedTank) =>
  (
    await pool.query(
      `SELECT seq, fuel_quantity::float8 AS fuel, consumed_quantity::float8 AS consumed, remaining_quantity::float8 AS remaining, batch_id::int AS batch_id
         FROM emitted_readings WHERE tank_id = $1 ORDER BY seq`,
      [tank.id],
    )
  ).rows;
const readingStatuses = async (tank: CodedTank) =>
  (await pool.query(`SELECT effective_at, ledger_status FROM readings WHERE tank_id = $1 ORDER BY effective_at`, [tank.id])).rows.map(
    (r) => r.ledger_status,
  );
const tankHeld = async (tank: CodedTank) =>
  (await pool.query(`SELECT chain_held FROM tanks WHERE id = $1`, [tank.id])).rows[0].chain_held as boolean;
const bodyCodes = (b: BuiltBatch) => JSON.parse(b.body).readings.map((r: { tank_code: string }) => r.tank_code);

describe('success', () => {
  it('closes the batch as accepted when accepted_count equals the item count', async () => {
    const batch = await fiveItemBatch();
    const { outcome, replayed } = await applyResult(pool, ST.id, batch.id, {
      status: 200,
      body: { status: 'accepted', message: 'Batch accepted.', accepted_count: 5 },
    });
    expect(outcome).toEqual({ batch_id: batch.id, batch_status: 'accepted', action: 'accepted' });
    expect(replayed).toBe(false);
    expect(await batchRow(batch.id)).toEqual({ status: 'accepted', code: '200', item_index: null });
    expect(await getOrCreateNextBatch(pool, ST.id, opts)).toBeNull();
    expect((await emittedFor(A)).every((r) => r.batch_id === batch.id)).toBe(true);
  });

  it('keeps the batch open when accepted_count does not match, or there is no body', async () => {
    const batch = await fiveItemBatch();
    for (const body of [{ accepted_count: 4 }, {}, null, 'ok']) {
      const { outcome } = await applyResult(pool, ST.id, batch.id, { status: 200, body });
      expect(outcome).toMatchObject({ batch_status: 'open', action: 'needs_attention' });
    }
    expect((await batchRow(batch.id)).status).toBe('open');
  });

  it('treats a stored duplicate at the first item as the confirmation of a lost reply', async () => {
    const batch = await fiveItemBatch();
    const { outcome } = await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(0, 'DUPLICATE_READING_STORED', 'reading_at') });
    expect(outcome).toMatchObject({ batch_status: 'accepted', action: 'accepted_assumed_resend' });
    expect(await batchRow(batch.id)).toEqual({ status: 'accepted', code: 'DUPLICATE_READING_STORED', item_index: 0 });
  });
});

describe('a broken chain', () => {
  it('holds only that tank, sends the others, and resumes after an anchor', async () => {
    const batch = await fiveItemBatch();
    const { outcome } = await applyResult(pool, ST.id, batch.id, {
      status: 422,
      body: moenergyError(1, 'REMAINING_QUANTITY_INCONSISTENT'),
    });
    expect(outcome).toMatchObject({ batch_status: 'rejected', action: 'tank_held_rebuilt', held_tank: B.code });
    expect(await batchRow(batch.id)).toEqual({ status: 'rejected', code: 'REMAINING_QUANTITY_INCONSISTENT', item_index: 1 });

    expect(await tankHeld(B)).toBe(true);
    expect(await tankHeld(A)).toBe(false);
    expect(await emittedFor(B)).toEqual([]);
    expect(await readingStatuses(B)).toEqual(['pending', 'pending']);
    expect((await emittedFor(A)).map((r) => r.batch_id)).toEqual([null, null, null]);

    // the rebuilt batch carries tank A only, in order
    await runLedgerOnce(pool, ledger);
    const next = (await getOrCreateNextBatch(pool, ST.id, opts))!;
    expect(next.id).not.toBe(batch.id);
    expect(bodyCodes(next)).toEqual([A.code, A.code, A.code]);
    await applyResult(pool, ST.id, next.id, { status: 200, body: { accepted_count: 3 } });

    // a person tells us MoEnergy holds 505 L for tank B; its readings chain from there
    await setAnchor(pool, B.id, parseMilli('505'), 'read from MoEnergy support', 'ops', { requireNoUnsent: true });
    expect(await runLedgerOnce(pool, ledger)).toMatchObject({ emitted: 2 });
    expect(await tankHeld(B)).toBe(false);
    expect(await emittedFor(B)).toMatchObject([
      { seq: 1, fuel: 505, consumed: 5, remaining: 500 },
      { seq: 2, fuel: 500, consumed: 10, remaining: 490 },
    ]);
  });
});

describe('one bad item', () => {
  it('quarantines it, re-chains the tank behind it, and keeps everything before it', async () => {
    const batch = await fiveItemBatch();
    const { outcome } = await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(2, 'TANK_FUEL_QUANTITY_EXCEEDS_CAPACITY') });
    expect(outcome).toMatchObject({ batch_status: 'rejected', action: 'item_quarantined_rebuilt' });
    expect(outcome.held_tank).toBeUndefined();

    const q = await pool.query(`SELECT rule_code, detail FROM quarantine`);
    expect(q.rows).toEqual([{ rule_code: 'moenergy:TANK_FUEL_QUANTITY_EXCEEDS_CAPACITY', detail: 'TANK_FUEL_QUANTITY_EXCEEDS_CAPACITY happened' }]);
    expect(await readingStatuses(A)).toEqual(['emitted', 'quarantined', 'pending']);
    expect(await tankHeld(A)).toBe(false);

    await runLedgerOnce(pool, ledger);
    const next = (await getOrCreateNextBatch(pool, ST.id, opts))!;
    expect(bodyCodes(next)).toEqual([A.code, B.code, B.code, A.code]);
    // A's last reading now chains from A's first (1000), because the middle one is gone
    expect(await emittedFor(A)).toMatchObject([
      { seq: 1, fuel: 1000, consumed: 0, remaining: 1000 },
      { seq: 2, fuel: 1000, consumed: 20, remaining: 980 },
    ]);
    expect((await emittedFor(B)).map((r) => r.batch_id)).toEqual([next.id, next.id]);
  });

  it('also holds the tank when the rejected reading was a refill (negative consumed)', async () => {
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }, { minute: 1, fuel: '20000', delivery: true }, { minute: 2, fuel: '19990' }]);
    const batch = (await getOrCreateNextBatch(pool, ST.id, opts))!;
    const { outcome } = await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(1, 'CONSUMED_QUANTITY_NEGATIVE', 'consumed_quantity') });
    expect(outcome).toMatchObject({ action: 'item_quarantined_rebuilt', held_tank: A.code });
    expect(await tankHeld(A)).toBe(true);
    expect(await readingStatuses(A)).toEqual(['emitted', 'quarantined', 'pending']);

    // the held tank adds nothing more, so the next batch is just the first reading
    expect(await runLedgerOnce(pool, ledger)).toMatchObject({ emitted: 0, heldTanks: 1 });
    expect(bodyCodes((await getOrCreateNextBatch(pool, ST.id, opts))!)).toEqual([A.code]);
  });

  it('treats a stored duplicate in the middle of the batch as a broken chain, not a lost reply', async () => {
    const batch = await fiveItemBatch();
    const { outcome } = await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(2, 'DUPLICATE_READING_STORED', 'reading_at') });
    expect(outcome).toMatchObject({ batch_status: 'rejected', action: 'tank_held_rebuilt', held_tank: A.code });
    expect(await tankHeld(A)).toBe(true);
    expect(await emittedFor(A)).toEqual([]);
    // the reading MoEnergy says it holds is never sent again, so an anchor can get past it (F5)
    expect(await readingStatuses(A)).toEqual(['pending', 'skipped', 'pending']);
    expect((await pool.query(`SELECT held_reason FROM tanks WHERE id = $1`, [A.id])).rows[0].held_reason).toBe('chain_break');
  });

  it('records the reason when a rejected refill stops the tank', async () => {
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }, { minute: 1, fuel: '20000', delivery: true }]);
    const batch = (await getOrCreateNextBatch(pool, ST.id, opts))!;
    await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(1, 'CONSUMED_QUANTITY_NEGATIVE', 'consumed_quantity') });
    expect((await pool.query(`SELECT held_reason FROM tanks WHERE id = $1`, [A.id])).rows[0].held_reason).toBe('moenergy_negative_rejection');
  });
});

describe('a refusal that keeps coming back', () => {
  it('stops setting readings aside after the breaker limit and asks for a person', async () => {
    const batch = await fiveItemBatch();
    const first = await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(2, 'SOME_NEW_RULE') }, { breakerLimit: 1 });
    expect(first.outcome.action).toBe('item_quarantined_rebuilt');

    await runLedgerOnce(pool, ledger);
    const next = (await getOrCreateNextBatch(pool, ST.id, opts))!;
    const before = await pool.query(`SELECT id, batch_id, batch_position FROM emitted_readings ORDER BY id`);
    const second = await applyResult(pool, ST.id, next.id, { status: 422, body: moenergyError(1, 'SOME_NEW_RULE') }, { breakerLimit: 1 });

    expect(second.outcome).toMatchObject({ batch_status: 'open', action: 'needs_attention' });
    expect(second.outcome.detail).toMatch(/not setting more aside/);
    expect((await batchRow(next.id)).status).toBe('open');
    expect((await pool.query(`SELECT count(*)::int AS n FROM quarantine`)).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT id, batch_id, batch_position FROM emitted_readings ORDER BY id`)).rows).toEqual(before.rows);
  });

  it('counts only this station, and only recent refusals', async () => {
    const batch = await fiveItemBatch();
    const other = await seedCodedStation(pool, 2);
    const C = await seedCodedTank(pool, other, 1);
    const old = await emitReadings(pool, C.id, [{ minute: 0, fuel: '10' }]);
    // five refusals at another station, and five at this one long ago
    await pool.query(`UPDATE readings SET ledger_status = 'quarantined' WHERE id = ANY($1)`, [old]);
    await pool.query(`INSERT INTO quarantine (reading_id, rule_code, created_at) SELECT unnest($1::bigint[]), 'moenergy:X', now()`, [old]);
    const aged = await pool.query(
      `INSERT INTO readings (tank_id, device_time, effective_at, fuel_volume_l) SELECT $1, now() - g * interval '1 hour', now() - g * interval '1 hour', 1 FROM generate_series(10, 12) g RETURNING id`,
      [A.id],
    );
    await pool.query(`INSERT INTO quarantine (reading_id, rule_code, created_at) SELECT id, 'moenergy:X', now() - interval '3 hours' FROM readings WHERE id = ANY($1)`, [aged.rows.map((r) => r.id)]);

    const { outcome } = await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(2, 'SOME_NEW_RULE') }, { breakerLimit: 1 });
    expect(outcome.action).toBe('item_quarantined_rebuilt');
  });
});

describe('a count that does not add up', () => {
  it('confirms only item 0 of a later "stored duplicate", never the whole batch (F4, F6)', async () => {
    const batch = await fiveItemBatch();
    // MoEnergy accepted only part of what the client forwarded
    const partial = await applyResult(pool, ST.id, batch.id, { status: 200, body: { accepted_count: 3 } });
    expect(partial.outcome).toMatchObject({ batch_status: 'open', action: 'needs_attention' });
    expect((await pool.query(`SELECT attention FROM batches WHERE id = $1`, [batch.id])).rows[0].attention).toBe(true);

    // the client then resends the whole batch and MoEnergy answers a stored duplicate at item 0
    const resend = await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(0, 'DUPLICATE_READING_STORED', 'reading_at') });
    expect(resend.outcome).toMatchObject({ batch_status: 'accepted', action: 'accepted_assumed_resend' });
    expect(resend.outcome.detail).toMatch(/other 4 items go in the next batch/);
    expect(await batchRow(batch.id)).toMatchObject({ status: 'accepted' });
    const closed = (await pool.query(`SELECT item_count, size_bytes FROM batches WHERE id = $1`, [batch.id])).rows[0];
    expect(closed.item_count).toBe(1);
    expect(closed.size_bytes).toBe(Buffer.byteLength(await loadBody(batch.id)));
    // the other four are unsent again and form the next batch
    const next = (await getOrCreateNextBatch(pool, ST.id, opts))!;
    expect(next.itemCount).toBe(4);
    expect(JSON.parse(next.body).readings).toHaveLength(4);
  });

  it('lets the client release a batch it cannot resolve; asking twice answers the same (F6)', async () => {
    const batch = await fiveItemBatch();
    await applyResult(pool, ST.id, batch.id, { status: 418, body: null });
    const first = await releaseBatch(pool, ST.id, batch.id, 'cannot tell what MoEnergy stored');
    expect(first).toMatchObject({ replayed: false, outcome: { batch_status: 'rejected', action: 'released' } });
    expect((await getOrCreateNextBatch(pool, ST.id, opts))!.itemCount).toBe(5);
    expect(await releaseBatch(pool, ST.id, batch.id, 'again')).toMatchObject({ replayed: true });
    await expect(releaseBatch(pool, ST.id + 1000, batch.id, 'x')).rejects.toBeInstanceOf(BatchNotFoundError);
  });
});

describe('what MoEnergy said is kept', () => {
  it('records every result posted: retryable answers, the closing one, a replay and a refused one', async () => {
    const batch = await fiveItemBatch();
    await applyResult(pool, ST.id, batch.id, { status: 503, body: { message: 'try later' } });
    const closing = { status: 200, body: { status: 'accepted', accepted_count: 5 } };
    await applyResult(pool, ST.id, batch.id, closing);
    await applyResult(pool, ST.id, batch.id, closing);
    await expect(applyResult(pool, ST.id, batch.id, { status: 500, body: null })).rejects.toBeInstanceOf(BatchClosedError);

    const rows = (await pool.query(`SELECT status_code, body, action, replayed FROM batch_results WHERE batch_id = $1 ORDER BY id`, [batch.id])).rows;
    expect(rows).toEqual([
      { status_code: 503, body: { message: 'try later' }, action: 'resend_same_body', replayed: false },
      { status_code: 200, body: closing.body, action: 'accepted', replayed: false },
      { status_code: 200, body: null, action: 'accepted', replayed: true },
      { status_code: 500, body: null, action: 'refused_batch_closed', replayed: false },
    ]);
  });

  it('cannot be edited afterwards', async () => {
    const batch = await fiveItemBatch();
    await applyResult(pool, ST.id, batch.id, { status: 200, body: { accepted_count: 5 } });
    await expect(pool.query(`UPDATE batch_results SET status_code = 500`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM batch_results`)).rejects.toThrow(/append-only/);
  });

  it('keeps a result whose body PostgreSQL cannot store as JSON, without the body', async () => {
    const batch = await fiveItemBatch();
    await applyResult(pool, ST.id, batch.id, { status: 503, body: { note: 'nul \u0000 inside' } });
    const rows = (await pool.query(`SELECT status_code, body, action FROM batch_results WHERE batch_id = $1`, [batch.id])).rows;
    expect(rows).toEqual([{ status_code: 503, body: null, action: 'resend_same_body' }]);
  });
});

describe('the correlation id', () => {
  it('refuses a result that names another send, and changes nothing', async () => {
    const batch = await fiveItemBatch();
    await expect(
      applyResult(pool, ST.id, batch.id, { status: 200, body: { accepted_count: 5 } }, { correlationId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toBeInstanceOf(CorrelationMismatchError);
    expect((await batchRow(batch.id)).status).toBe('open');
  });

  it('accepts the result when it names this send', async () => {
    const batch = await fiveItemBatch();
    const { outcome } = await applyResult(pool, ST.id, batch.id, { status: 200, body: { accepted_count: 5 } }, { correlationId: batch.correlationId });
    expect(outcome.batch_status).toBe('accepted');
  });
});

describe('answers that change nothing', () => {
  it.each([409, 429, 500, 502, 503])('keeps the batch open on %i and asks for the same body again', async (status) => {
    const batch = await fiveItemBatch();
    const { outcome } = await applyResult(pool, ST.id, batch.id, { status, body: { whatever: true } });
    expect(outcome).toEqual({ batch_id: batch.id, batch_status: 'open', action: 'resend_same_body' });
    expect(await getOrCreateNextBatch(pool, ST.id, opts)).toEqual(batch);
  });

  it.each([401, 403, 413])('keeps the batch open on %i and says the fix is on the client side', async (status) => {
    const batch = await fiveItemBatch();
    const { outcome } = await applyResult(pool, ST.id, batch.id, { status, body: null });
    expect(outcome).toMatchObject({ batch_status: 'open', action: 'fix_client_side' });
    expect(await getOrCreateNextBatch(pool, ST.id, opts)).toEqual(batch);
  });

  it('keeps the batch open on a status nobody planned for', async () => {
    const batch = await fiveItemBatch();
    expect((await applyResult(pool, ST.id, batch.id, { status: 404, body: {} })).outcome).toMatchObject({ batch_status: 'open', action: 'needs_attention' });
  });

  it.each([
    ['a string', 'Unprocessable'],
    ['null', null],
    ['no errors list', { message: 'x' }],
    ['an empty errors list', { errors: [] }],
    ['an error without item_index', { errors: [{ message: 'field: x', sourceErrorCode: 'WHATEVER' }] }],
    ['an item_index past the end', moenergyError(99, 'WHATEVER')],
    ['a negative item_index', { errors: [{ message: 'item_index: -1 - field: x', sourceErrorCode: 'WHATEVER' }] }],
  ])('keeps the batch open on a 422 with %s, and touches nothing', async (_name, body) => {
    const batch = await fiveItemBatch();
    const before = await pool.query(`SELECT id, batch_id, batch_position FROM emitted_readings ORDER BY id`);
    const { outcome } = await applyResult(pool, ST.id, batch.id, { status: 422, body });
    expect(outcome).toMatchObject({ batch_status: 'open', action: 'needs_attention' });
    expect((await pool.query(`SELECT id, batch_id, batch_position FROM emitted_readings ORDER BY id`)).rows).toEqual(before.rows);
    expect((await pool.query(`SELECT count(*)::int AS n FROM quarantine`)).rows[0].n).toBe(0);
  });
});

describe('repeats and mistakes', () => {
  it('answers a repeated identical result with the same outcome and no second effect', async () => {
    const batch = await fiveItemBatch();
    const result = { status: 422, body: moenergyError(2, 'TANK_FUEL_QUANTITY_EXCEEDS_CAPACITY') };
    const first = await applyResult(pool, ST.id, batch.id, result);
    const second = await applyResult(pool, ST.id, batch.id, result);
    expect(second.replayed).toBe(true);
    expect(second.outcome).toEqual(first.outcome);
    expect((await pool.query(`SELECT count(*)::int AS n FROM quarantine`)).rows[0].n).toBe(1);
  });

  it('refuses a different result for a batch that is already closed', async () => {
    const batch = await fiveItemBatch();
    await applyResult(pool, ST.id, batch.id, { status: 200, body: { accepted_count: 5 } });
    await expect(applyResult(pool, ST.id, batch.id, { status: 500, body: null })).rejects.toBeInstanceOf(BatchClosedError);
  });

  it('refuses a result for a batch that does not exist', async () => {
    await expect(applyResult(pool, ST.id, 424242, { status: 200, body: {} })).rejects.toBeInstanceOf(BatchNotFoundError);
  });

  it('acts once when the same result arrives from several places at once', async () => {
    const batch = await fiveItemBatch();
    const result = { status: 422, body: moenergyError(2, 'TANK_FUEL_QUANTITY_EXCEEDS_CAPACITY') };
    const all = await Promise.all(Array.from({ length: 5 }, () => applyResult(pool, ST.id, batch.id, result)));
    expect(all.filter((r) => !r.replayed)).toHaveLength(1);
    for (const r of all) expect(r.outcome).toEqual(all[0]!.outcome);
    expect((await pool.query(`SELECT count(*)::int AS n FROM quarantine`)).rows[0].n).toBe(1);
  });

describe('stations are independent', () => {
  it("treats another station's batch id as not found and changes nothing", async () => {
    const batch = await fiveItemBatch();
    const st2 = await seedCodedStation(pool, 2);
    await expect(applyResult(pool, st2.id, batch.id, { status: 200, body: { accepted_count: 5 } })).rejects.toBeInstanceOf(
      BatchNotFoundError,
    );
    expect((await batchRow(batch.id)).status).toBe('open');
  });

  it("a rejection at one station leaves another station's open batch alone", async () => {
    const batch = await fiveItemBatch();
    const st2 = await seedCodedStation(pool, 2);
    const C = await seedCodedTank(pool, st2, 1);
    await emitReadings(pool, C.id, [{ minute: 0, fuel: '700' }, { minute: 1, fuel: '690' }]);
    const other = (await getOrCreateNextBatch(pool, st2.id, opts))!;

    await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(2, 'TANK_FUEL_QUANTITY_EXCEEDS_CAPACITY') });
    expect((await batchRow(other.id)).status).toBe('open');
    expect(await getOrCreateNextBatch(pool, st2.id, opts)).toEqual(other);
    expect((await applyResult(pool, st2.id, other.id, { status: 200, body: { accepted_count: 2 } })).outcome.batch_status).toBe('accepted');
  });
});
});

describe('which refusals count as a refused refill', () => {
  it('a refill reading refused for another field is an ordinary bad item: nothing held, nothing learned', async () => {
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }, { minute: 1, fuel: '20000', delivery: true }]);
    const batch = (await getOrCreateNextBatch(pool, ST.id, opts))!;
    const { outcome } = await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(1, 'FUEL_HEIGHT_EXCEEDS_TOTAL', 'fuel_height') });
    expect(outcome.action).toBe('item_quarantined_rebuilt');
    expect(outcome.held_tank).toBeUndefined();
    const t = (await pool.query(`SELECT chain_held, negative_refused_at FROM tanks WHERE id = $1`, [A.id])).rows[0];
    expect(t).toEqual({ chain_held: false, negative_refused_at: null });
  });

  it('a refill refused on consumed_quantity holds the tank and is remembered', async () => {
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }, { minute: 1, fuel: '20000', delivery: true }]);
    const batch = (await getOrCreateNextBatch(pool, ST.id, opts))!;
    const { outcome } = await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(1, 'CONSUMED_QUANTITY_NEGATIVE', 'consumed_quantity') });
    expect(outcome.held_tank).toBe(A.code);
    const t = (await pool.query(`SELECT chain_held, negative_refused_at IS NOT NULL AS learned FROM tanks WHERE id = $1`, [A.id])).rows[0];
    expect(t).toEqual({ chain_held: true, learned: true });
  });
});
