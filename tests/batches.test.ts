import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getOrCreateNextBatch, PER_TANK_CANDIDATES } from '../src/batches/builder.js';
import { resetDb, testPool } from './helpers/db.js';
import {
  emitReadings,
  insertStation,
  insertTank,
  minuteAt,
  seedCodedStation,
  seedCodedTank,
  seedRefs,
  type CodedStation,
} from './helpers/fixtures.js';

const pool = testPool(12);
const NOW = new Date('2026-11-03T12:00:00Z');
const opts = { now: () => NOW };

let st: CodedStation;

beforeEach(async () => {
  await resetDb(pool);
  await seedRefs(pool);
  st = await seedCodedStation(pool, 1);
});
afterAll(() => pool.end());

const parse = (body: string) => JSON.parse(body).readings as Array<Record<string, unknown>>;
const closeBatch = (id: number) =>
  pool.query(`UPDATE batches SET status = 'accepted', closed_at = now() WHERE id = $1`, [id]);

describe('getOrCreateNextBatch', () => {
  it('returns null when nothing is ready', async () => {
    expect(await getOrCreateNextBatch(pool, st.id, opts)).toBeNull();
  });

  it('builds one batch in time order across tanks, with exact positions and size', async () => {
    const a = await seedCodedTank(pool, st, 1);
    const b = await seedCodedTank(pool, st, 2);
    await emitReadings(pool, a.id, [{ minute: 0, fuel: '1000' }, { minute: 2, fuel: '990' }]);
    await emitReadings(pool, b.id, [{ minute: 1, fuel: '500' }]);

    const batch = (await getOrCreateNextBatch(pool, st.id, opts))!;
    expect(batch.itemCount).toBe(3);
    expect(parse(batch.body).map((r) => r.tank_code)).toEqual([a.code, b.code, a.code]);
    expect(Buffer.byteLength(batch.body)).toBe(batch.sizeBytes);

    const rows = await pool.query(`SELECT batch_id::int AS b, batch_position AS p FROM emitted_readings ORDER BY batch_position`);
    expect(rows.rows).toEqual([
      { b: batch.id, p: 0 },
      { b: batch.id, p: 1 },
      { b: batch.id, p: 2 },
    ]);
    const rec = await pool.query(`SELECT status, item_count, size_bytes FROM batches WHERE id = $1`, [batch.id]);
    expect(rec.rows[0]).toEqual({ status: 'open', item_count: 3, size_bytes: batch.sizeBytes });
  });

  it('uses the guide field names and converts heights from millimetres to metres', async () => {
    const a = await seedCodedTank(pool, st, 1);
    await emitReadings(pool, a.id, [{ minute: 0, fuel: '31790', fuelHeightMm: '1878.4', waterHeightMm: '15.6', temperature: '28.5' }]);
    const [item] = parse((await getOrCreateNextBatch(pool, st.id, opts))!.body);
    expect(item).toEqual({
      station_code: st.code,
      tank_code: a.code,
      fuel_quantity: 31790,
      consumed_quantity: 0,
      fuel_height: 1.878,
      water_quantity: 0.5,
      water_height: 0.016,
      temperature: 28.5,
      remaining_quantity: 31790,
      reading_at: '2026-11-03T10:00:00Z',
    });
  });

  it('returns the same open batch again, even after more readings were emitted', async () => {
    const a = await seedCodedTank(pool, st, 1);
    await emitReadings(pool, a.id, [{ minute: 0, fuel: '1000' }]);
    const first = (await getOrCreateNextBatch(pool, st.id, opts))!;

    await emitReadings(pool, a.id, [{ minute: 1, fuel: '990' }]);
    const again = (await getOrCreateNextBatch(pool, st.id, opts))!;

    expect(again).toEqual(first);
    const unsent = await pool.query(`SELECT count(*)::int AS n FROM emitted_readings WHERE batch_id IS NULL`);
    expect(unsent.rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM batches`)).rows[0].n).toBe(1);
  });

  it('builds the next batch only after the open one is closed, continuing where it stopped', async () => {
    const a = await seedCodedTank(pool, st, 1);
    await emitReadings(pool, a.id, [{ minute: 0, fuel: '1000' }]);
    const first = (await getOrCreateNextBatch(pool, st.id, opts))!;
    await emitReadings(pool, a.id, [{ minute: 1, fuel: '990' }]);

    await closeBatch(first.id);
    const second = (await getOrCreateNextBatch(pool, st.id, opts))!;
    expect(second.id).not.toBe(first.id);
    expect(parse(second.body)).toHaveLength(1);
    expect(parse(second.body)[0]).toMatchObject({ fuel_quantity: 1000, remaining_quantity: 990, reading_at: minuteAt(1).replace('.000Z', 'Z') });
  });

  it('skips tanks and stations that do not have MoEnergy codes yet', async () => {
    const coded = await seedCodedTank(pool, st, 1);
    const plain = await insertStation(pool);
    const uncodedTank = await insertTank(pool, plain.id);
    const codeless = await insertTank(pool, st.id, { number: 2 });
    await emitReadings(pool, coded.id, [{ minute: 0, fuel: '1000' }]);
    await emitReadings(pool, uncodedTank, [{ minute: 0, fuel: '1000' }]);
    await emitReadings(pool, codeless, [{ minute: 0, fuel: '1000' }]);

    const batch = (await getOrCreateNextBatch(pool, st.id, opts))!;
    expect(parse(batch.body).map((r) => r.tank_code)).toEqual([coded.code]);
    expect(await getOrCreateNextBatch(pool, plain.id, opts)).toBeNull();
  });

  it('holds back a reading inside the settle window and everything after it on that tank only', async () => {
    const a = await seedCodedTank(pool, st, 1);
    const b = await seedCodedTank(pool, st, 2);
    await emitReadings(pool, a.id, [
      { minute: 0, fuel: '1000' },
      { minute: 1, fuel: '990', createdAt: '2026-11-03T11:59:30Z' }, // stored 30 s ago
      { minute: 2, fuel: '980' },
    ]);
    await emitReadings(pool, b.id, [{ minute: 3, fuel: '500' }]);

    const batch = (await getOrCreateNextBatch(pool, st.id, opts))!;
    expect(parse(batch.body).map((r) => [r.tank_code, r.reading_at])).toEqual([
      [a.code, '2026-11-03T10:00:00Z'],
      [b.code, '2026-11-03T10:03:00Z'],
    ]);
  });

  it('respects the size cap and keeps each tank in time order across batches', async () => {
    const a = await seedCodedTank(pool, st, 1);
    const b = await seedCodedTank(pool, st, 2);
    await emitReadings(pool, a.id, Array.from({ length: 6 }, (_, i) => ({ minute: i * 2, fuel: String(1000 - i) })));
    await emitReadings(pool, b.id, Array.from({ length: 4 }, (_, i) => ({ minute: i * 2 + 1, fuel: String(500 - i) })));

    const sent: Array<{ tank: unknown; at: string }> = [];
    let batches = 0;
    for (;;) {
      const batch = await getOrCreateNextBatch(pool, st.id, { ...opts, maxBytes: 1000 });
      if (!batch) break;
      batches += 1;
      expect(batch.sizeBytes).toBeLessThanOrEqual(1000);
      for (const r of parse(batch.body)) sent.push({ tank: r.tank_code, at: String(r.reading_at) });
      await closeBatch(batch.id);
    }
    expect(batches).toBeGreaterThan(2);
    expect(sent).toHaveLength(10);
    for (const code of [a.code, b.code]) {
      const times = sent.filter((s) => s.tank === code).map((s) => s.at);
      expect(times).toEqual([...times].sort());
      expect(new Set(times).size).toBe(times.length);
    }
  });

  it('stops at maxItems and carries the rest into the next batch, in order', async () => {
    const a = await seedCodedTank(pool, st, 1);
    await emitReadings(pool, a.id, Array.from({ length: 5 }, (_, i) => ({ minute: i * 2, fuel: String(1000 - i) })));

    const first = (await getOrCreateNextBatch(pool, st.id, { ...opts, maxItems: 2 }))!;
    expect(first.itemCount).toBe(2);
    await closeBatch(first.id);
    const second = (await getOrCreateNextBatch(pool, st.id, { ...opts, maxItems: 2 }))!;
    expect(second.itemCount).toBe(2);
    const times = [...parse(first.body), ...parse(second.body)].map((r) => String(r.reading_at));
    expect(times).toEqual([...times].sort());
    expect(new Set(times).size).toBe(4);
  });

  it('still sends a single reading that alone exceeds the cap, so the queue never stalls', async () => {
    const a = await seedCodedTank(pool, st, 1);
    await emitReadings(pool, a.id, [{ minute: 0, fuel: '1000' }]);
    const batch = await getOrCreateNextBatch(pool, st.id, { ...opts, maxBytes: 10 });
    expect(batch?.itemCount).toBe(1);
  });

  it('builds exactly one batch when many callers ask at once', async () => {
    const a = await seedCodedTank(pool, st, 1);
    await emitReadings(pool, a.id, Array.from({ length: 5 }, (_, i) => ({ minute: i, fuel: String(1000 - i) })));

    const results = await Promise.all(Array.from({ length: 8 }, () => getOrCreateNextBatch(pool, st.id, opts)));
    expect(new Set(results.map((r) => r!.id)).size).toBe(1);
    expect(new Set(results.map((r) => r!.body)).size).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM batches`)).rows[0].n).toBe(1);
  });

  describe('stations are independent', () => {
    it('gives each station its own batch with only its own tanks, open at the same time', async () => {
      const st2 = await seedCodedStation(pool, 2);
      const a = await seedCodedTank(pool, st, 1);
      const b = await seedCodedTank(pool, st2, 1);
      await emitReadings(pool, a.id, [{ minute: 0, fuel: '1000' }]);
      await emitReadings(pool, b.id, [{ minute: 0, fuel: '2000' }]);

      const first = (await getOrCreateNextBatch(pool, st.id, opts))!;
      const second = (await getOrCreateNextBatch(pool, st2.id, opts))!;
      expect(first.id).not.toBe(second.id);
      expect(parse(first.body).map((r) => r.tank_code)).toEqual([a.code]);
      expect(parse(second.body).map((r) => r.tank_code)).toEqual([b.code]);
      const open = await pool.query(`SELECT station_id::int AS s FROM batches WHERE status = 'open' ORDER BY station_id`);
      expect(open.rows).toEqual([{ s: st.id }, { s: st2.id }]);
    });

    it('does not let one station\'s open batch hold up another', async () => {
      const st2 = await seedCodedStation(pool, 2);
      const a = await seedCodedTank(pool, st, 1);
      const b = await seedCodedTank(pool, st2, 1);
      await emitReadings(pool, a.id, [{ minute: 0, fuel: '1000' }]);
      const stuck = (await getOrCreateNextBatch(pool, st.id, opts))!; // never closed

      await emitReadings(pool, b.id, [{ minute: 0, fuel: '2000' }]);
      const other = (await getOrCreateNextBatch(pool, st2.id, opts))!;
      expect(other.id).not.toBe(stuck.id);
      await closeBatch(other.id);
      await emitReadings(pool, b.id, [{ minute: 1, fuel: '1990' }]);
      expect(parse((await getOrCreateNextBatch(pool, st2.id, opts))!.body)).toHaveLength(1);
      expect((await getOrCreateNextBatch(pool, st.id, opts))!.id).toBe(stuck.id);
    });

    it('builds one batch per station when many callers ask for both at once', async () => {
      const st2 = await seedCodedStation(pool, 2);
      const a = await seedCodedTank(pool, st, 1);
      const b = await seedCodedTank(pool, st2, 1);
      await emitReadings(pool, a.id, [{ minute: 0, fuel: '1000' }]);
      await emitReadings(pool, b.id, [{ minute: 0, fuel: '2000' }]);

      const calls = Array.from({ length: 6 }, (_, i) => getOrCreateNextBatch(pool, i % 2 === 0 ? st.id : st2.id, opts));
      const results = await Promise.all(calls);
      expect(new Set(results.map((r) => r!.id)).size).toBe(2);
      expect((await pool.query(`SELECT count(*)::int AS n FROM batches`)).rows[0].n).toBe(2);
    });

    it('returns null for a station that does not exist', async () => {
      expect(await getOrCreateNextBatch(pool, 424242, opts)).toBeNull();
    });
  });

  it('refuses to serve an open batch whose underlying rows changed since it was built, even by one character', async () => {
    const a = await seedCodedTank(pool, st, 1);
    await emitReadings(pool, a.id, [{ minute: 0, fuel: '1000' }]);
    const batch = (await getOrCreateNextBatch(pool, st.id, opts))!;
    await pool.query(`UPDATE tanks SET moenergy_tank_code = 'ST-000001-9' WHERE id = $1`, [a.id]); // same length: size alone would not notice
    await expect(getOrCreateNextBatch(pool, st.id, opts)).rejects.toThrow(/no longer matches/);
    await pool.query(`UPDATE tanks SET moenergy_tank_code = $2 WHERE id = $1`, [a.id, a.code]);
    expect((await getOrCreateNextBatch(pool, st.id, opts))!.body).toBe(batch.body);
  });

  it('reads a tank as a prefix when it has more unsent readings than one build looks at, skipping none', async () => {
    const a = await seedCodedTank(pool, st, 1);
    const total = PER_TANK_CANDIDATES + 300;
    await pool.query(
      `INSERT INTO readings (tank_id, device_time, effective_at, fuel_volume_l, created_at)
       SELECT $1, '2026-11-03T00:00:00Z'::timestamptz + g * interval '1 second', '2026-11-03T00:00:00Z'::timestamptz + g * interval '1 second', 1000, '2026-11-03T01:00:00Z'
         FROM generate_series(1, $2) g`,
      [a.id, total],
    );
    await pool.query(
      `INSERT INTO emitted_readings (tank_id, seq, reading_id, effective_at, fuel_quantity, consumed_quantity, remaining_quantity)
       SELECT tank_id, row_number() OVER (ORDER BY effective_at), id, effective_at, 1000, 0, 1000 FROM readings WHERE tank_id = $1`,
      [a.id],
    );

    const first = (await getOrCreateNextBatch(pool, st.id, { ...opts, maxBytes: 10_000_000 }))!;
    expect(parse(first.body)).toHaveLength(PER_TANK_CANDIDATES);
    await closeBatch(first.id);
    const second = (await getOrCreateNextBatch(pool, st.id, { ...opts, maxBytes: 10_000_000 }))!;
    expect(parse(second.body)).toHaveLength(300);

    const times = [...parse(first.body), ...parse(second.body)].map((r) => String(r.reading_at));
    expect(times).toHaveLength(total);
    expect(new Set(times).size).toBe(total); // no reading twice
    expect(times).toEqual([...times].sort()); // none skipped, in order
  });
});

describe('inactive tanks', () => {
  it('are not put into a batch', async () => {
    const { seedCodedStation, seedCodedTank, emitReadings } = await import('./helpers/fixtures.js');
    const st = await seedCodedStation(pool, 77);
    const live = await seedCodedTank(pool, st, 1);
    const off = await seedCodedTank(pool, st, 2);
    await emitReadings(pool, live.id, [{ minute: 0, fuel: '1000' }]);
    await emitReadings(pool, off.id, [{ minute: 0, fuel: '1000' }]);
    await pool.query(`UPDATE tanks SET is_active = false WHERE id = $1`, [off.id]);
    const batch = (await getOrCreateNextBatch(pool, st.id, { now: () => new Date('2026-11-03T23:00:00Z') }))!;
    const tanks = (JSON.parse(batch.body) as { readings: Array<{ tank_code: string }> }).readings.map((r) => r.tank_code);
    expect(tanks).toEqual([live.code]);
  });
});
