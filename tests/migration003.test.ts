import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { TEST_DB_URL } from './helpers/db.js';

// Migration 003 is run here on a database that already holds data, inside a scratch schema.
const SCHEMA = 'mig003_test';
const pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path=${SCHEMA}` });
const root = fileURLToPath(new URL('../migrations/', import.meta.url));
let dir: string;

beforeEach(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  dir = await mkdtemp(join(tmpdir(), 'mig003-'));
  for (const f of ['001_init.sql', '002_batches_api.sql']) await copyFile(join(root, f), join(dir, f));
  await migrate(pool, dir);
  await copyFile(join(root, '003_per_station.sql'), join(dir, '003_per_station.sql'));
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

/** Two stations with a tank each, and an emitted reading per tank. Returns the reading ids. */
async function seed() {
  await pool.query(`INSERT INTO stations (name, operator_station_code, secret_hash) VALUES ('a','A','ha'), ('b','B','hb')`);
  await pool.query(`INSERT INTO tanks (station_id, tank_number, operator_tank_code, capacity_litres, total_height_m)
                    SELECT id, 1, 'T1', 1000, 3 FROM stations`);
  const ids: number[] = [];
  for (const tank of [1, 2]) {
    const r = await pool.query(
      `INSERT INTO readings (tank_id, device_time, effective_at) VALUES ($1, now(), now()) RETURNING id`, [tank]);
    ids.push(Number(r.rows[0].id));
    await pool.query(
      `INSERT INTO emitted_readings (tank_id, seq, reading_id, effective_at, fuel_quantity, consumed_quantity, remaining_quantity)
       VALUES ($1, 1, $2, now(), 10, 0, 10)`, [tank, r.rows[0].id]);
  }
  return ids;
}

describe('migration 003 on a database that has data', () => {
  it('refuses to run while one open batch holds readings of several stations', async () => {
    await seed();
    const b = await pool.query(`INSERT INTO batches (item_count, size_bytes) VALUES (2, 100) RETURNING id`);
    await pool.query(`UPDATE emitted_readings SET batch_id = $1, batch_position = tank_id - 1`, [b.rows[0].id]);

    await expect(migrate(pool, dir)).rejects.toThrow(/several stations/);
    const cols = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'batches' AND column_name = 'station_id'`, [SCHEMA]);
    expect(cols.rowCount).toBe(0); // rolled back as a whole
  });

  it('gives an open batch and an accepted batch their station, leaves history it cannot place empty, and then guards new rows', async () => {
    await seed();
    const open = (await pool.query(`INSERT INTO batches (item_count, size_bytes) VALUES (1, 100) RETURNING id`)).rows[0].id;
    await pool.query(`UPDATE emitted_readings SET batch_id = $1, batch_position = 0 WHERE tank_id = 1`, [open]);
    const accepted = (await pool.query(`INSERT INTO batches (item_count, size_bytes, status, closed_at) VALUES (1, 100, 'accepted', now()) RETURNING id`)).rows[0].id;
    await pool.query(`UPDATE emitted_readings SET batch_id = $1, batch_position = 0 WHERE tank_id = 2`, [accepted]);
    const rejected = (await pool.query(`INSERT INTO batches (item_count, size_bytes, status, closed_at) VALUES (1, 100, 'rejected', now()) RETURNING id`)).rows[0].id;

    expect(await migrate(pool, dir)).toEqual(['003_per_station.sql']);
    const rows = (await pool.query(`SELECT id::int AS id, station_id::int AS station_id FROM batches ORDER BY id`)).rows;
    expect(rows).toEqual([
      { id: Number(open), station_id: 1 },
      { id: Number(accepted), station_id: 2 },
      { id: Number(rejected), station_id: null },
    ]);

    // every new batch must name its station, and there is one open batch per station
    await expect(pool.query(`INSERT INTO batches (item_count, size_bytes) VALUES (1, 1)`)).rejects.toThrow(/batches_station_required_chk/);
    await expect(pool.query(`INSERT INTO batches (station_id, item_count, size_bytes) VALUES (1, 1, 1)`)).rejects.toThrow(/one_open_per_station/);
    await pool.query(`INSERT INTO batches (station_id, item_count, size_bytes) VALUES (2, 1, 1)`);
  });
});
