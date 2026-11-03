/**
 * Runs a real TANKMSR.CSV through the importer, the ledger and the client's loop against a strict MoEnergy, in a scratch
 * database (name ends _replay), and prints what happened. The tanks are those of the first real station (AL HMAIDAN).
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/pts2_test \
 *     npx tsx scripts/replay-tankmsr.ts path/to/TANKMSR.CSV [--since 2026-10-04T00:00:00+03:00] [--refuse-negative]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { importTankMsr } from '../src/import/tankmsr.js';
import { capacityL } from './sim/charts.js';
import { StrictMoEnergy, type FakeTank } from './sim/fake-moenergy.js';
import { hmaidanTanks } from './sim/profiles.js';
import { driveStation, type ClientEnv } from './sim/run.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { since: { type: 'string' }, 'refuse-negative': { type: 'boolean', default: false } },
});
const file = positionals[0];
if (!file) {
  console.error('usage: npx tsx scripts/replay-tankmsr.ts TANKMSR.CSV [--since ISO] [--refuse-negative]');
  process.exit(2);
}

const base = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/pts2_test';
const url = new URL(base);
url.pathname = '/pts2_replay';
const admin = new pg.Client({ connectionString: base });
await admin.connect();
await admin.query('DROP DATABASE IF EXISTS pts2_replay');
await admin.query('CREATE DATABASE pts2_replay');
await admin.end();

const pool = createPool(url.toString(), 6, { statementTimeoutMs: 300_000, lockTimeoutMs: 60_000, connectionTimeoutMs: 60_000 });
try {
  await migrate(pool, join(process.cwd(), 'migrations'));
  await pool.query(`INSERT INTO ref_regions (id, name) VALUES (1, 'R')`);
  await pool.query(`INSERT INTO ref_products (product_id, name) VALUES (91, '91'), (95, '95'), (1, 'Diesel')`);
  const st = await pool.query(
    `INSERT INTO stations (name, operator_station_code, secret_hash, moenergy_station_code) VALUES ('AL HMAIDAN', 'HMD-01', 'x', 'ST-000001') RETURNING id`,
  );
  const sid = Number(st.rows[0].id);
  const profiles = hmaidanTanks(join(process.cwd(), 'scripts/sim/data'));
  const heights = [2.75, 2.75, 2.75, 2.75, 3.0];
  const products = [91, 1, 1, 95, 95];
  const fakeTanks: FakeTank[] = [];
  for (const [k, p] of profiles.entries()) {
    const code = `ST-000001-${p.probe}`;
    await pool.query(
      `INSERT INTO tanks (station_id, tank_number, operator_tank_code, capacity_litres, total_height_m, moenergy_tank_code, product_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sid, p.probe, `T${p.probe}`, capacityL(p.chart), heights[k], code, products[k]],
    );
    fakeTanks.push({ stationCode: 'ST-000001', tankCode: code, capacityL: capacityL(p.chart), totalHeightM: heights[k]! });
  }

  const t0 = Date.now();
  const rep = await importTankMsr(pool, sid, readFileSync(file, 'utf8'), { since: values.since ? new Date(values.since) : undefined });
  console.log('import', JSON.stringify({ ...rep, errors: rep.errors.length }));

  const now = () => new Date(Math.max(Date.now() + 3_600_000, Date.parse('2026-11-04T00:00:00Z')));
  const env: ClientEnv = {
    policy: 'allow',
    now,
    fake: new StrictMoEnergy(fakeTanks, { now, refuseNegative: values['refuse-negative'] }),
    refused: 0,
    actions: {},
    batches: 0,
  };
  const problems: string[] = [];
  await driveStation(pool, env, { id: sid, code: 'HMD-01' }, problems);

  const q = async (sql: string) => (await pool.query(sql)).rows;
  console.log('readings by status', JSON.stringify(await q(`SELECT ledger_status, count(*)::int n FROM readings GROUP BY 1 ORDER BY 1`)));
  console.log('set aside by rule', JSON.stringify(await q(`SELECT rule_code, count(*)::int n FROM quarantine GROUP BY 1 ORDER BY 2 DESC`)));
  console.log('batches', env.batches, 'actions', JSON.stringify(env.actions), 'refused by MoEnergy', env.refused);
  console.log('stored at MoEnergy', [...env.fake.stored.values()].reduce((s, l) => s + l.length, 0));
  console.log('per tank', JSON.stringify(await q(`
    SELECT t.tank_number AS tank, count(e.*)::int AS sent,
           count(*) FILTER (WHERE e.consumed_quantity < -3000)::int AS refills,
           min(e.consumed_quantity)::float AS biggest_refill, max(e.consumed_quantity)::float AS biggest_drop,
           min(e.effective_at) AS first, max(e.effective_at) AS last, t.chain_held AS held
      FROM tanks t LEFT JOIN emitted_readings e ON e.tank_id = t.id GROUP BY t.id ORDER BY 1`)));
  console.log('chains whole at MoEnergy:', fakeTanks.every((t) => env.fake.chainIsWhole(t.tankCode)));
  if (problems.length > 0) console.log('PROBLEMS', problems);
  console.log(`took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} finally {
  await pool.end();
}
