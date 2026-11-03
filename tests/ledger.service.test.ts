import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseMilli } from '../src/domain/quantity.js';
import { processTank, setAnchor, type ProcessOptions } from '../src/ledger/service.js';
import { resetDb, testPool } from './helpers/db.js';
import { setAnchor as anchorTank } from '../src/ledger/service.js';
import { insertReading, insertStation, insertTank, seedRefs } from './helpers/fixtures.js';

const pool = testPool(12);
const now = new Date('2026-11-03T23:00:00Z');
const opts = (policy: 'allow' | 'hold' = 'allow'): ProcessOptions => ({ policy, now: () => now });
const minute = (m: number) => new Date(Date.UTC(2026, 10, 3, 10, m)).toISOString();

let tank: number;
let stationId: number;

beforeEach(async () => {
  await resetDb(pool);
  await seedRefs(pool);
  const { id } = await insertStation(pool);
  stationId = id;
  tank = await insertTank(pool, id, { capacity: '50000', heightM: '3.5' });
});
afterAll(() => pool.end());

const emitted = async () =>
  (
    await pool.query(
      `SELECT seq, fuel_quantity::text AS fuel, consumed_quantity::text AS consumed, remaining_quantity::text AS remaining, flags
         FROM emitted_readings WHERE tank_id = $1 ORDER BY seq`,
      [tank],
    )
  ).rows;
const status = async (id: number) =>
  (await pool.query(`SELECT ledger_status FROM readings WHERE id = $1`, [id])).rows[0].ledger_status;

describe('processTank', () => {
  it('emits pending readings in time order with a gapless sequence and an exact chain', async () => {
    // inserted out of order on purpose
    await insertReading(pool, tank, { at: minute(2), fuel: '31700.5' });
    await insertReading(pool, tank, { at: minute(0), fuel: '31790' });
    await insertReading(pool, tank, { at: minute(1), fuel: '31776' });

    expect(await processTank(pool, tank, opts())).toEqual({ emitted: 3, quarantined: 0, skipped: 0, held: false });
    expect(await emitted()).toEqual([
      { seq: 1, fuel: '31790.000', consumed: '0.000', remaining: '31790.000', flags: [] },
      { seq: 2, fuel: '31790.000', consumed: '14.000', remaining: '31776.000', flags: [] },
      { seq: 3, fuel: '31776.000', consumed: '75.500', remaining: '31700.500', flags: [] },
    ]);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    await insertReading(pool, tank, { at: minute(0) });
    await processTank(pool, tank, opts());
    expect(await processTank(pool, tank, opts())).toEqual({ emitted: 0, quarantined: 0, skipped: 0, held: false });
    expect(await emitted()).toHaveLength(1);
  });

  it('continues the chain across separate runs', async () => {
    await insertReading(pool, tank, { at: minute(0), fuel: '1000' });
    await processTank(pool, tank, opts());
    await insertReading(pool, tank, { at: minute(1), fuel: '990' });
    await processTank(pool, tank, opts());
    expect((await emitted())[1]).toMatchObject({ seq: 2, fuel: '1000.000', consumed: '10.000', remaining: '990.000' });
  });

  it('quarantines with the rule code and leaves the chain untouched', async () => {
    const a = await insertReading(pool, tank, { at: minute(0), fuel: '1000' });
    const bad = await insertReading(pool, tank, { at: minute(1), fuel: '99999' });
    const c = await insertReading(pool, tank, { at: minute(2), fuel: '990' });

    expect(await processTank(pool, tank, opts())).toEqual({ emitted: 2, quarantined: 1, skipped: 0, held: false });
    expect(await status(a)).toBe('emitted');
    expect(await status(bad)).toBe('quarantined');
    expect(await status(c)).toBe('emitted');
    const q = await pool.query(`SELECT rule_code FROM quarantine WHERE reading_id = $1`, [bad]);
    expect(q.rows).toEqual([{ rule_code: 'volume_above_capacity' }]);
    expect((await emitted())[1]).toMatchObject({ fuel: '1000.000', consumed: '10.000', remaining: '990.000' });
  });

  it('puts an older reading back in order when everything after it is still unsent', async () => {
    await insertReading(pool, tank, { at: minute(10), fuel: '1000' });
    await processTank(pool, tank, opts());
    const old = await insertReading(pool, tank, { at: minute(3), fuel: '1200' });

    expect(await processTank(pool, tank, opts())).toEqual({ emitted: 2, quarantined: 0, skipped: 0, held: false });
    expect(await status(old)).toBe('emitted');
    expect(await emitted()).toEqual([
      { seq: 1, fuel: '1200.000', consumed: '0.000', remaining: '1200.000', flags: [] },
      { seq: 2, fuel: '1200.000', consumed: '200.000', remaining: '1000.000', flags: [] },
    ]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM quarantine`)).rows[0].n).toBe(0);
  });

  it('sets an older reading aside as late_arrival once later readings may already be at MoEnergy', async () => {
    await insertReading(pool, tank, { at: minute(10), fuel: '1000' });
    await processTank(pool, tank, opts());
    const batch = await pool.query(
      `INSERT INTO batches (station_id, item_count, size_bytes, status, closed_at) VALUES ($1, 1, 100, 'accepted', now()) RETURNING id`,
      [stationId],
    );
    await pool.query(`UPDATE emitted_readings SET batch_id = $1, batch_position = 0`, [batch.rows[0].id]);

    const old = await insertReading(pool, tank, { at: minute(3), fuel: '1200' });
    expect(await processTank(pool, tank, opts())).toEqual({ emitted: 0, quarantined: 1, skipped: 0, held: false });
    expect((await pool.query(`SELECT rule_code FROM quarantine WHERE reading_id = $1`, [old])).rows).toEqual([
      { rule_code: 'late_arrival' },
    ]);
    expect(await emitted()).toHaveLength(1);
  });

  it('leaves unsent readings untouched when the late reading cannot be placed anyway', async () => {
    await insertReading(pool, tank, { at: minute(10), fuel: '1000' });
    await processTank(pool, tank, opts());
    const batch = await pool.query(
      `INSERT INTO batches (station_id, item_count, size_bytes, status, closed_at) VALUES ($1, 1, 100, 'accepted', now()) RETURNING id`,
      [stationId],
    );
    await pool.query(`UPDATE emitted_readings SET batch_id = $1, batch_position = 0`, [batch.rows[0].id]);
    await insertReading(pool, tank, { at: minute(12), fuel: '990' });
    await processTank(pool, tank, opts());
    const ids = async () => (await pool.query(`SELECT id::int AS id FROM emitted_readings ORDER BY seq`)).rows;
    const before = await ids();
    expect(before).toHaveLength(2);

    await insertReading(pool, tank, { at: minute(3), fuel: '1200' });
    expect(await processTank(pool, tank, opts())).toEqual({ emitted: 0, quarantined: 1, skipped: 0, held: false });
    expect(await ids()).toEqual(before); // the unsent reading was neither deleted nor re-created
  });

  it('does not chain a reading until it has settled, and lets it hold back the ones after it', async () => {
    const clock = (iso: string): ProcessOptions => ({ policy: 'allow', now: () => new Date(iso) });
    // stored 30 s before "now": inside the 2 minute window
    const fresh = await insertReading(pool, tank, { at: minute(3), fuel: '1200', createdAt: '2026-11-03T22:59:30Z' });
    const later = await insertReading(pool, tank, { at: minute(5), fuel: '1190', createdAt: '2026-11-03T22:00:00Z' });

    expect(await processTank(pool, tank, clock('2026-11-03T23:00:00Z'))).toEqual({ emitted: 0, quarantined: 0, skipped: 0, held: false });
    expect(await status(fresh)).toBe('pending');
    expect(await status(later)).toBe('pending');

    expect(await processTank(pool, tank, clock('2026-11-03T23:05:00Z'))).toEqual({ emitted: 2, quarantined: 0, skipped: 0, held: false });
    expect((await emitted()).map((r) => r.remaining)).toEqual(['1200.000', '1190.000']);
  });

  it('lets a replayed older reading take its place when it arrives inside the window', async () => {
    const clock = (iso: string): ProcessOptions => ({ policy: 'allow', now: () => new Date(iso) });
    await insertReading(pool, tank, { at: minute(10), fuel: '1000', createdAt: '2026-11-03T22:00:00Z' });
    // the backlog's older reading arrives 30 s ago: before anything was chained
    await insertReading(pool, tank, { at: minute(3), fuel: '1200', createdAt: '2026-11-03T22:59:30Z' });

    expect(await processTank(pool, tank, clock('2026-11-03T23:00:00Z'))).toMatchObject({ emitted: 0 });
    expect(await processTank(pool, tank, clock('2026-11-03T23:05:00Z'))).toMatchObject({ emitted: 2, quarantined: 0 });
    expect((await emitted()).map((r) => [r.fuel, r.remaining])).toEqual([
      ['1200.000', '1200.000'],
      ['1200.000', '1000.000'],
    ]);
  });

  it('quarantines a reading with no litre volume', async () => {
    const r = await insertReading(pool, tank, { at: minute(0), fuel: null });
    await processTank(pool, tank, opts());
    expect((await pool.query(`SELECT rule_code FROM quarantine WHERE reading_id = $1`, [r])).rows).toEqual([
      { rule_code: 'volume_missing' },
    ]);
  });

  it('converts heights from millimetres to metres before comparing with the tank height', async () => {
    const ok = await insertReading(pool, tank, { at: minute(0), fuelHeightMm: '3500' });
    const bad = await insertReading(pool, tank, { at: minute(1), fuelHeightMm: '3501' });
    await processTank(pool, tank, opts());
    expect(await status(ok)).toBe('emitted');
    expect(await status(bad)).toBe('quarantined');
  });

  it('marks refills when policy is allow', async () => {
    await insertReading(pool, tank, { at: minute(0), fuel: '1000' });
    await insertReading(pool, tank, { at: minute(1), fuel: '20000', delivery: true });
    await processTank(pool, tank, opts('allow'));
    expect((await emitted())[1]).toMatchObject({ consumed: '-19000.000', flags: ['negative_consumed', 'delivery'] });
  });

  it('honours the limit and carries on in the next call', async () => {
    for (let i = 0; i < 5; i++) await insertReading(pool, tank, { at: minute(i), fuel: String(1000 - i) });
    expect(await processTank(pool, tank, { ...opts(), limit: 2 })).toMatchObject({ emitted: 2 });
    expect(await processTank(pool, tank, { ...opts(), limit: 10 })).toMatchObject({ emitted: 3 });
    expect((await emitted()).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('works in whole seconds: two readings in one second are not both sent', async () => {
    await insertReading(pool, tank, { at: '2026-11-03T10:00:00.200Z', fuel: '1000' });
    const second = await insertReading(pool, tank, { at: '2026-11-03T10:00:00.700Z', fuel: '990' });
    await insertReading(pool, tank, { at: '2026-11-03T10:00:01.100Z', fuel: '980' });

    expect(await processTank(pool, tank, opts())).toEqual({ emitted: 2, quarantined: 1, skipped: 0, held: false });
    expect(await status(second)).toBe('quarantined');
    const times = (await pool.query(`SELECT to_char(effective_at AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') AS t FROM emitted_readings ORDER BY seq`)).rows;
    expect(times).toEqual([{ t: '10:00:00.000' }, { t: '10:00:01.000' }]);
  });

  it('fails clearly for an unknown tank', async () => {
    await expect(processTank(pool, 999_999, opts())).rejects.toThrow(/not found/);
  });
});

describe('hold policy and anchors', () => {
  it('holds the tank at a refill, keeps later readings pending, and resumes from the anchor', async () => {
    await insertReading(pool, tank, { at: minute(0), fuel: '1000' });
    const refill = await insertReading(pool, tank, { at: minute(1), fuel: '20000', delivery: true });
    const next = await insertReading(pool, tank, { at: minute(2), fuel: '19990' });

    expect(await processTank(pool, tank, opts('hold'))).toEqual({ emitted: 1, quarantined: 0, skipped: 0, held: true });
    expect(await status(refill)).toBe('pending');
    expect(await status(next)).toBe('pending');
    expect((await pool.query(`SELECT chain_held FROM tanks WHERE id = $1`, [tank])).rows[0].chain_held).toBe(true);

    // still held on the next call, nothing moves
    expect(await processTank(pool, tank, opts('hold'))).toEqual({ emitted: 0, quarantined: 0, skipped: 0, held: true });

    // MoEnergy resets the tank's chain at the refilled level; the anchor says so.
    await setAnchor(pool, tank, parseMilli('20000'), 'MoEnergy reset the chain after the refill', 'ops@example.com');
    expect(await processTank(pool, tank, opts('hold'))).toEqual({ emitted: 2, quarantined: 0, skipped: 0, held: false });

    const rows = await emitted();
    expect(rows[1]).toMatchObject({ seq: 2, fuel: '20000.000', consumed: '0.000', remaining: '20000.000', flags: ['delivery'] });
    expect(rows[2]).toMatchObject({ seq: 3, fuel: '20000.000', consumed: '10.000', remaining: '19990.000' });
  });

  it('holds again if the anchor still leaves the next reading below the measurement', async () => {
    await insertReading(pool, tank, { at: minute(0), fuel: '1000' });
    await insertReading(pool, tank, { at: minute(1), fuel: '20000', delivery: true });
    await processTank(pool, tank, opts('hold'));

    await setAnchor(pool, tank, parseMilli('19995'), 'wrong level', 'ops', { acceptNegative: false });
    expect(await processTank(pool, tank, opts('hold'))).toEqual({ emitted: 0, quarantined: 0, skipped: 0, held: true });
  });

  it('lets the reading that stopped the tank pass once a person has anchored it (F7)', async () => {
    await insertReading(pool, tank, { at: minute(0), fuel: '1000' });
    await insertReading(pool, tank, { at: minute(1), fuel: '20000', delivery: true });
    await insertReading(pool, tank, { at: minute(2), fuel: '20500', delivery: true });
    await processTank(pool, tank, opts('hold'));

    await setAnchor(pool, tank, parseMilli('1000'), 'what MoEnergy holds', 'ops');
    // the refill passes once; the next rise is held again, the person has not looked at that one
    expect(await processTank(pool, tank, opts('hold'))).toEqual({ emitted: 1, quarantined: 0, skipped: 0, held: true });
  });

  it('sets aside readings at or before the anchor time as already at MoEnergy (F4)', async () => {
    await insertReading(pool, tank, { at: minute(0), fuel: '1000' });
    await insertReading(pool, tank, { at: minute(1), fuel: '990' });
    await insertReading(pool, tank, { at: minute(2), fuel: '980' });
    await setAnchor(pool, tank, parseMilli('990'), 'MoEnergy support', 'ops', { asOf: new Date(minute(1)) });
    expect(await processTank(pool, tank, opts())).toEqual({ emitted: 1, quarantined: 2, skipped: 0, held: false });
    const rows = await emitted();
    expect(rows[0]).toMatchObject({ fuel: '990.000', remaining: '980.000' });
  });

  it('records why and since when a tank is held, and clears both on an anchor', async () => {
    await insertReading(pool, tank, { at: minute(0), fuel: '1000' });
    await insertReading(pool, tank, { at: minute(1), fuel: '20000' });
    await processTank(pool, tank, opts('hold'));
    const held = (await pool.query(`SELECT chain_held, held_reason, held_at IS NOT NULL AS has_time FROM tanks WHERE id = $1`, [tank])).rows[0];
    expect(held).toEqual({ chain_held: true, held_reason: 'negative_consumed', has_time: true });

    await anchorTank(pool, tank, parseMilli('20000'), 'reset', 'ops');
    const freed = (await pool.query(`SELECT chain_held, held_reason, held_at FROM tanks WHERE id = $1`, [tank])).rows[0];
    expect(freed).toEqual({ chain_held: false, held_reason: null, held_at: null });
  });

  it('releases a hold made by the hold policy when the deployment now allows negative consumed', async () => {
    await insertReading(pool, tank, { at: minute(0), fuel: '1000' });
    const refill = await insertReading(pool, tank, { at: minute(1), fuel: '20000', delivery: true });
    expect(await processTank(pool, tank, opts('hold'))).toEqual({ emitted: 1, quarantined: 0, skipped: 0, held: true });
    expect(await processTank(pool, tank, opts('hold'))).toEqual({ emitted: 0, quarantined: 0, skipped: 0, held: true });

    expect(await processTank(pool, tank, opts('allow'))).toEqual({ emitted: 1, quarantined: 0, skipped: 0, held: false });
    expect(await status(refill)).toBe('emitted');
    expect((await emitted())[1]).toMatchObject({ consumed: '-19000.000', flags: ['negative_consumed', 'delivery'] });
    expect((await pool.query(`SELECT chain_held FROM tanks WHERE id = $1`, [tank])).rows[0].chain_held).toBe(false);
  });

  it('does not release any other kind of hold when the policy changes', async () => {
    await pool.query(`UPDATE tanks SET chain_held = true, held_reason = 'chain_break', held_at = now() WHERE id = $1`, [tank]);
    await insertReading(pool, tank, { at: minute(0), fuel: '1000' });
    expect(await processTank(pool, tank, opts('allow'))).toEqual({ emitted: 0, quarantined: 0, skipped: 0, held: true });
    expect(await emitted()).toEqual([]);
  });

  it('applies an anchor to a tank with no readings yet, then ignores it once the chain has moved on', async () => {
    await setAnchor(pool, tank, parseMilli('5000'), 'tank already reporting to MoEnergy', 'ops');
    await insertReading(pool, tank, { at: minute(0), fuel: '4990' });
    await processTank(pool, tank, opts());
    await insertReading(pool, tank, { at: minute(1), fuel: '4980' });
    await processTank(pool, tank, opts());

    const rows = await emitted();
    expect(rows[0]).toMatchObject({ fuel: '5000.000', consumed: '10.000', remaining: '4990.000' });
    expect(rows[1]).toMatchObject({ fuel: '4990.000', consumed: '10.000', remaining: '4980.000' });
  });

  it('keeps every anchor and records who set it and when it applies', async () => {
    await setAnchor(pool, tank, parseMilli('100'), 'first', 'a');
    await setAnchor(pool, tank, parseMilli('200'), 'second', 'b');
    const { rows } = await pool.query(`SELECT reason, set_by, after_seq FROM chain_anchors ORDER BY id`);
    expect(rows).toEqual([
      { reason: 'first', set_by: 'a', after_seq: 0 },
      { reason: 'second', set_by: 'b', after_seq: 0 },
    ]);
  });
});

describe('concurrency', () => {
  it('never forks a chain when several runs process one tank at once', async () => {
    for (let i = 0; i < 60; i++) await insertReading(pool, tank, { at: minute(i), fuel: String(40000 - i * 7) });

    const results = await Promise.all(Array.from({ length: 6 }, () => processTank(pool, tank, opts())));
    expect(results.reduce((n, r) => n + r.emitted, 0)).toBe(60);

    const rows = await emitted();
    expect(rows).toHaveLength(60);
    rows.forEach((r, i) => {
      expect(r.seq).toBe(i + 1);
      if (i > 0) expect(r.fuel).toBe(rows[i - 1]!.remaining);
    });
  });

  it('lets different tanks run in parallel without touching each other', async () => {
    const { id: st } = await insertStation(pool);
    const other = await insertTank(pool, st);
    for (let i = 0; i < 10; i++) {
      await insertReading(pool, tank, { at: minute(i), fuel: String(1000 - i) });
      await insertReading(pool, other, { at: minute(i), fuel: String(2000 - i) });
    }
    await Promise.all([processTank(pool, tank, opts()), processTank(pool, other, opts())]);
    const counts = await pool.query(`SELECT tank_id::int AS t, count(*)::int AS n FROM emitted_readings GROUP BY tank_id ORDER BY tank_id`);
    expect(counts.rows.map((r) => r.n)).toEqual([10, 10]);
  });

  it('rolls back entirely when a write fails midway', async () => {
    const r1 = await insertReading(pool, tank, { at: minute(0), fuel: '1000' });
    const r2 = await insertReading(pool, tank, { at: minute(1), fuel: '990' });

    // a pool whose connections fail on the write that follows the bulk insert (the status update), so the
    // insert that already happened must be rolled back with it
    const failing = {
      connect: async () => {
        const client = await pool.connect();
        const original = client.query.bind(client) as (...a: unknown[]) => unknown;
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].includes("SET ledger_status = 'emitted'")) {
            throw new Error('boom');
          }
          return original(...args);
        };
        // hand the connection back unpatched, or the next test that borrows it would fail too
        const release = client.release.bind(client);
        client.release = (...r) => {
          (client as unknown as { query: unknown }).query = original;
          client.release = release;
          return release(...r);
        };
        return client;
      },
    } as unknown as typeof pool;

    await expect(processTank(failing, tank, opts())).rejects.toThrow('boom');
    expect(await emitted()).toHaveLength(0);
    expect(await status(r1)).toBe('pending');
    expect(await status(r2)).toBe('pending');

    // the same readings process cleanly afterwards
    expect(await processTank(pool, tank, opts())).toMatchObject({ emitted: 2 });
  });
});

describe('emission window', () => {
  it('emits at most the window ahead of what has been sent and leaves the rest pending', async () => {
    const { EMISSION_WINDOW } = await import('../src/ledger/service.js');
    await pool.query(
      `INSERT INTO readings (tank_id, device_time, effective_at, fuel_volume_l, created_at)
       SELECT $1, ts, ts, 40000 - i, now() - interval '1 hour'
         FROM generate_series(0, $2) i, LATERAL (SELECT timestamptz '2026-10-30 00:00:00+00' + i * interval '1 minute' AS ts) x`,
      [tank, EMISSION_WINDOW + 499],
    );
    const first = await processTank(pool, tank, opts());
    expect(first.emitted).toBe(EMISSION_WINDOW);
    expect(await processTank(pool, tank, opts())).toMatchObject({ emitted: 0 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM readings WHERE ledger_status = 'pending'`)).rows[0].n).toBe(500);

    // once the unsent rows are claimed by a batch, the next call continues the same chain
    await pool.query(`INSERT INTO batches (station_id, item_count, size_bytes) VALUES ($1, 1, 1)`, [stationId]);
    await pool.query(`UPDATE emitted_readings SET batch_id = (SELECT max(id) FROM batches), batch_position = seq - 1 WHERE tank_id = $1`, [tank]);
    const second = await processTank(pool, tank, opts());
    expect(second.emitted).toBe(500);
    const chain = (await pool.query(`SELECT seq, fuel_quantity::float AS f FROM emitted_readings WHERE tank_id = $1 AND seq IN (${EMISSION_WINDOW}, ${EMISSION_WINDOW + 1})`, [tank])).rows;
    expect(chain[1].f).toBe(40000 - (EMISSION_WINDOW - 1)); // fuel_quantity = the previous remaining across the two calls
  });
});

describe('decimals', () => {
  it('rounds the measurement once, so the next fuel_quantity equals the previous remaining exactly', async () => {
    await insertReading(pool, tank, { at: minute(0), fuel: '1000.125', water: '0.004' });
    await insertReading(pool, tank, { at: minute(1), fuel: '990.994' });
    await processTank(pool, tank, opts());
    const rows = await emitted();
    expect(rows[0]).toMatchObject({ fuel: '1000.130', remaining: '1000.130' });
    expect(rows[1]).toMatchObject({ fuel: '1000.130', consumed: '9.140', remaining: '990.990' });
  });

  it('keeps three decimals when asked to', async () => {
    await insertReading(pool, tank, { at: minute(0), fuel: '1000.125' });
    await processTank(pool, tank, { ...opts(), decimals: 3 });
    expect((await emitted())[0]).toMatchObject({ remaining: '1000.125' });
  });
});
