import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { insertReading, insertStation, insertTank, pgCode, seedRefs } from './helpers/fixtures.js';
import { resetDb, testPool } from './helpers/db.js';

const pool = testPool(4);

beforeEach(async () => {
  await resetDb(pool);
  await seedRefs(pool);
});
afterAll(() => pool.end());

describe('stations', () => {
  it('rejects the same operator code ignoring case', async () => {
    await insertStation(pool, { code: 'RYD-01' });
    expect(await pgCode(insertStation(pool, { code: 'ryd-01' }))).toBe('23505');
  });

  it('rejects coordinates outside Saudi Arabia', async () => {
    expect(await pgCode(insertStation(pool, { extra: { latitude: 40, longitude: 46 } }))).toBe('23514');
    expect(await pgCode(insertStation(pool, { extra: { latitude: 24, longitude: 60 } }))).toBe('23514');
  });

  it('rejects a city that is not inside the given region, accepts one that is', async () => {
    expect(await pgCode(insertStation(pool, { extra: { region_id: 2, city_id: 10 } }))).toBe('23503');
    expect(await pgCode(insertStation(pool, { extra: { region_id: 1, city_id: 10 } }))).toBe('NO_ERROR');
  });

  it('rejects an address over 250 characters', async () => {
    expect(await pgCode(insertStation(pool, { extra: { address: 'x'.repeat(251) } }))).toBe('23514');
  });

  it('rejects a malformed MoEnergy code and a duplicate one', async () => {
    expect(await pgCode(insertStation(pool, { extra: { moenergy_station_code: 'bad' } }))).toBe('23514');
    await insertStation(pool, { extra: { moenergy_station_code: 'ST-000001' } });
    expect(await pgCode(insertStation(pool, { extra: { moenergy_station_code: 'ST-000001' } }))).toBe('23505');
  });
});

describe('tanks', () => {
  it('rejects zero capacity, zero height, and a repeated probe number', async () => {
    const { id } = await insertStation(pool);
    expect(await pgCode(insertTank(pool, id, { capacity: '0' }))).toBe('23514');
    expect(await pgCode(insertTank(pool, id, { heightM: '0' }))).toBe('23514');
    await insertTank(pool, id, { number: 1 });
    expect(await pgCode(insertTank(pool, id, { number: 1 }))).toBe('23505');
  });

  it('rejects an unknown product', async () => {
    const { id } = await insertStation(pool);
    expect(await pgCode(insertTank(pool, id, { extra: { product_id: 777 } }))).toBe('23503');
  });
});

describe('raw_uploads', () => {
  it('refuses to edit the payload but allows parse bookkeeping', async () => {
    const { id } = await insertStation(pool);
    const { rows } = await pool.query(
      `INSERT INTO raw_uploads (station_id, method, path, headers, body_bytes, body_raw)
       VALUES ($1, 'POST', '/pts', '{}', 3, 'abc') RETURNING id`,
      [id],
    );
    const uploadId = rows[0].id;
    await expect(pool.query(`UPDATE raw_uploads SET body_raw = 'xyz' WHERE id = $1`, [uploadId])).rejects.toThrow(
      /immutable/,
    );
    await pool.query(`UPDATE raw_uploads SET parse_status = 'parsed', packet_types = '{tank}' WHERE id = $1`, [uploadId]);
  });
});

describe('readings', () => {
  it('rejects a second reading with the same tank and device time', async () => {
    const { id } = await insertStation(pool);
    const tank = await insertTank(pool, id);
    await insertReading(pool, tank, { at: '2026-11-03T10:00:00Z' });
    expect(await pgCode(insertReading(pool, tank, { at: '2026-11-03T10:00:00Z' }))).toBe('23505');
  });

  it('dedupes by content hash when there is no device time', async () => {
    const { id } = await insertStation(pool);
    const tank = await insertTank(pool, id);
    const ins = () =>
      pool.query(`INSERT INTO readings (tank_id, content_hash, effective_at) VALUES ($1, 'h1', now())`, [tank]);
    await ins();
    expect(await pgCode(ins())).toBe('23505');
  });

  it('requires either a device time or a content hash', async () => {
    const { id } = await insertStation(pool);
    const tank = await insertTank(pool, id);
    expect(await pgCode(pool.query(`INSERT INTO readings (tank_id, effective_at) VALUES ($1, now())`, [tank]))).toBe(
      '23514',
    );
  });
});

describe('emitted_readings', () => {
  async function emit(fuel: string, consumed: string, remaining: string, seq = 1) {
    const { id } = await insertStation(pool);
    const tank = await insertTank(pool, id);
    const reading = await insertReading(pool, tank, { at: '2026-11-03T10:00:00Z' });
    return pool.query(
      `INSERT INTO emitted_readings (tank_id, seq, reading_id, effective_at, fuel_quantity, consumed_quantity, remaining_quantity)
       VALUES ($1, $2, $3, '2026-11-03T10:00:00Z', $4, $5, $6)`,
      [tank, seq, reading, fuel, consumed, remaining],
    );
  }

  it('enforces remaining = fuel - consumed within 1 L', async () => {
    expect(await pgCode(emit('1000', '10', '990'))).toBe('NO_ERROR');
    await resetDb(pool);
    await seedRefs(pool);
    expect(await pgCode(emit('1000', '10', '980'))).toBe('23514');
  });

  it('rejects consumed above fuel', async () => {
    expect(await pgCode(emit('10', '20', '-10'))).toBe('23514');
  });

  it('rejects a repeated sequence number for a tank', async () => {
    const { id } = await insertStation(pool);
    const tank = await insertTank(pool, id);
    const r1 = await insertReading(pool, tank, { at: '2026-11-03T10:00:00Z' });
    const r2 = await insertReading(pool, tank, { at: '2026-11-03T10:01:00Z' });
    const ins = (r: number, at: string) =>
      pool.query(
        `INSERT INTO emitted_readings (tank_id, seq, reading_id, effective_at, fuel_quantity, consumed_quantity, remaining_quantity)
         VALUES ($1, 1, $2, $3, 100, 0, 100)`,
        [tank, r, at],
      );
    await ins(r1, '2026-11-03T10:00:00Z');
    expect(await pgCode(ins(r2, '2026-11-03T10:01:00Z'))).toBe('23505');
  });
});

describe('batches and anchors', () => {
  it('allows one open batch per station, not one overall', async () => {
    const a = (await insertStation(pool)).id;
    const b = (await insertStation(pool)).id;
    const ins = (station: number | null) =>
      pool.query(`INSERT INTO batches (station_id, item_count, size_bytes) VALUES ($1, 1, 100)`, [station]);
    await ins(a);
    expect(await pgCode(ins(a))).toBe('23505');
    expect(await pgCode(ins(b))).toBe('NO_ERROR');
    await pool.query(`UPDATE batches SET status = 'accepted', closed_at = now() WHERE station_id = $1`, [a]);
    expect(await pgCode(ins(a))).toBe('NO_ERROR');
  });

  it('refuses an open batch that names no station', async () => {
    expect(await pgCode(pool.query(`INSERT INTO batches (item_count, size_bytes) VALUES (1, 100)`))).toBe('23514');
  });

  it('rejects a batch of 1 MB or more', async () => {
    const { id } = await insertStation(pool);
    expect(
      await pgCode(pool.query(`INSERT INTO batches (station_id, item_count, size_bytes) VALUES ($1, 1, 1048576)`, [id])),
    ).toBe('23514');
  });

  it('keeps anchors append-only', async () => {
    const { id } = await insertStation(pool);
    const tank = await insertTank(pool, id);
    await pool.query(
      `INSERT INTO chain_anchors (tank_id, remaining_quantity, reason, set_by) VALUES ($1, 500, 'test', 'me')`,
      [tank],
    );
    await expect(pool.query(`UPDATE chain_anchors SET remaining_quantity = 1`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM chain_anchors`)).rejects.toThrow(/append-only/);
  });
});

describe('quarantine', () => {
  it('keeps one row per reading and rule', async () => {
    const { id } = await insertStation(pool);
    const tank = await insertTank(pool, id);
    const reading = await insertReading(pool, tank, { at: '2026-11-03T10:00:00Z' });
    const ins = () =>
      pool.query(`INSERT INTO quarantine (reading_id, rule_code) VALUES ($1, 'volume_above_capacity')`, [reading]);
    await ins();
    expect(await pgCode(ins())).toBe('23505');
    expect((await pool.query(`SELECT count(*)::int AS n FROM quarantine`)).rows[0].n).toBe(1);
  });
});

describe('what the database now guards', () => {
  async function emittedInBatch(status: 'open' | 'accepted') {
    const { id: station } = await insertStation(pool);
    const tank = await insertTank(pool, station);
    const reading = await insertReading(pool, tank, { at: '2026-11-03T10:00:00Z' });
    const batch = (
      await pool.query(
        status === 'open'
          ? `INSERT INTO batches (station_id, item_count, size_bytes) VALUES ($1, 1, 100) RETURNING id`
          : `INSERT INTO batches (station_id, item_count, size_bytes, status, closed_at) VALUES ($1, 1, 100, 'accepted', now()) RETURNING id`,
        [station],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO emitted_readings (tank_id, seq, reading_id, effective_at, fuel_quantity, consumed_quantity, remaining_quantity, batch_id, batch_position)
       VALUES ($1, 1, $2, '2026-11-03T10:00:00Z', 100, 0, 100, $3, 0)`,
      [tank, reading, batch],
    );
    return { station, tank, batch };
  }

  it('makes the emitted readings of an accepted batch immutable', async () => {
    const { tank } = await emittedInBatch('accepted');
    await expect(pool.query(`UPDATE emitted_readings SET flags = '{x}' WHERE tank_id = $1`, [tank])).rejects.toThrow(/immutable/);
    await expect(pool.query(`UPDATE emitted_readings SET batch_id = NULL, batch_position = NULL WHERE tank_id = $1`, [tank])).rejects.toThrow(/immutable/);
    await expect(pool.query(`DELETE FROM emitted_readings WHERE tank_id = $1`, [tank])).rejects.toThrow(/immutable/);
  });

  it('still lets the readings of an open batch be released and unsent ones be removed', async () => {
    const { tank } = await emittedInBatch('open');
    await pool.query(`UPDATE emitted_readings SET batch_id = NULL, batch_position = NULL WHERE tank_id = $1`, [tank]);
    await pool.query(`DELETE FROM emitted_readings WHERE tank_id = $1`, [tank]);
  });

  it('never lets a closed batch change or reopen, and keeps closed_at in step with the status', async () => {
    const { batch } = await emittedInBatch('accepted');
    await expect(pool.query(`UPDATE batches SET status = 'open', closed_at = NULL WHERE id = $1`, [batch])).rejects.toThrow(/closed batch/);
    await expect(pool.query(`UPDATE batches SET item_count = 9 WHERE id = $1`, [batch])).rejects.toThrow(/closed batch/);

    const { id: station } = await insertStation(pool);
    expect(await pgCode(pool.query(`INSERT INTO batches (station_id, item_count, size_bytes, status) VALUES ($1, 1, 1, 'accepted')`, [station]))).toBe('23514');
    expect(await pgCode(pool.query(`INSERT INTO batches (station_id, item_count, size_bytes, closed_at) VALUES ($1, 1, 1, now())`, [station]))).toBe('23514');
  });

  it('demands an exact chain and no negative stock in the emitted readings', async () => {
    const { id: station } = await insertStation(pool);
    const tank = await insertTank(pool, station);
    const ins = async (fuel: string, consumed: string, remaining: string, at: string) => {
      const reading = await insertReading(pool, tank, { at });
      return pool.query(
        `INSERT INTO emitted_readings (tank_id, seq, reading_id, effective_at, fuel_quantity, consumed_quantity, remaining_quantity)
         VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM emitted_readings WHERE tank_id = $1), $2, $3, $4, $5, $6)`,
        [tank, reading, at, fuel, consumed, remaining],
      );
    };
    expect(await pgCode(ins('1000', '10', '990.5', '2026-11-03T10:00:00Z'))).toBe('23514'); // within 1 L is not exact
    expect(await pgCode(ins('-5', '-10', '5', '2026-11-03T10:01:00Z'))).toBe('23514'); // negative fuel_quantity
    expect(await pgCode(ins('1000', '10', '990', '2026-11-03T10:02:00Z'))).toBe('NO_ERROR');
  });

  it('refuses a city without a region, and a registered station or tank without its MoEnergy codes', async () => {
    expect(await pgCode(insertStation(pool, { extra: { city_id: 10 } }))).toBe('23514');
    expect(await pgCode(insertStation(pool, { extra: { registration_state: 'registered' } }))).toBe('23514');
    const { id } = await insertStation(pool);
    expect(await pgCode(insertTank(pool, id, { extra: { registration_state: 'registered' } }))).toBe('23514');
    expect(await pgCode(insertTank(pool, id, { number: 2, extra: { registration_state: 'registered', moenergy_tank_code: 'ST-000009-2', product_id: 91 } }))).toBe('NO_ERROR');
  });

  it('keeps raw_uploads.body_bytes equal to the stored bytes', async () => {
    const { id } = await insertStation(pool);
    expect(
      await pgCode(pool.query(`INSERT INTO raw_uploads (station_id, method, path, headers, body_bytes, body_raw) VALUES ($1, 'POST', '/pts', '{}', 99, 'abc')`, [id])),
    ).toBe('23514');
  });

  it('keeps a tank hold and its reason together', async () => {
    const { id } = await insertStation(pool);
    const tank = await insertTank(pool, id);
    expect(await pgCode(pool.query(`UPDATE tanks SET chain_held = true WHERE id = $1`, [tank]))).toBe('23514');
    expect(await pgCode(pool.query(`UPDATE tanks SET held_reason = 'chain_break', held_at = now() WHERE id = $1`, [tank]))).toBe('23514');
    expect(await pgCode(pool.query(`UPDATE tanks SET chain_held = true, held_reason = 'because', held_at = now() WHERE id = $1`, [tank]))).toBe('23514');
    expect(await pgCode(pool.query(`UPDATE tanks SET chain_held = true, held_reason = 'chain_break', held_at = now() WHERE id = $1`, [tank]))).toBe('NO_ERROR');
  });

  it('lets a raw upload be pruned without losing the readings that came from it', async () => {
    const { id } = await insertStation(pool);
    const tank = await insertTank(pool, id);
    const upload = (
      await pool.query(`INSERT INTO raw_uploads (station_id, method, path, headers, body_bytes, body_raw) VALUES ($1, 'POST', '/pts', '{}', 2, '{}') RETURNING id`, [id])
    ).rows[0].id;
    const reading = await insertReading(pool, tank, { at: '2026-11-03T10:00:00Z' });
    await pool.query(`UPDATE readings SET upload_id = $1 WHERE id = $2`, [upload, reading]);

    await pool.query(`DELETE FROM raw_uploads WHERE id = $1`, [upload]);
    expect((await pool.query(`SELECT upload_id FROM readings WHERE id = $1`, [reading])).rows[0].upload_id).toBeNull();
  });
});
