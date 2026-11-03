/**
 * Load test: how long does the gateway take to drain a backlog?
 *
 * Builds its own database (name must end in _load), fills it with `stations` x `tanks` of readings as if every
 * controller replayed `hours` of history at once (what happens after a regional outage), then plays the client:
 * for every station, GET next (ledger + batch), "send" it to a MoEnergy that accepts everything, post the result,
 * until nothing is left. Several stations are served in parallel, like a client that polls them all.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/pts2_test \
 *     npx tsx scripts/load-test.ts --stations 38 --tanks 5 --hours 24 --parallel 4
 *
 * The parser does not exist yet, so readings are inserted directly with one SQL statement; that part only shows
 * how fast PostgreSQL takes rows, not how fast uploads will be parsed.
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import pg from 'pg';
import { buildOrReturnOpen, enterStation } from '../src/batches/builder.js';
import { applyResult } from '../src/batches/result.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { runLedgerOnce } from '../src/ledger/worker.js';

const { values } = parseArgs({
  options: {
    stations: { type: 'string', default: '38' },
    tanks: { type: 'string', default: '5' },
    hours: { type: 'string', default: '24' },
    interval: { type: 'string', default: '1' },
    parallel: { type: 'string', default: '4' },
    pool: { type: 'string', default: '10' },
  },
});
const stations = Number(values.stations);
const tanksPer = Number(values.tanks);
const hours = Number(values.hours);
const interval = Number(values.interval);
const parallel = Number(values.parallel);
const perTank = Math.floor((hours * 60) / interval);

const base = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/pts2_test';
const url = new URL(base);
const dbName = 'pts2_load';
url.pathname = `/${dbName}`;

const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;

const admin = new pg.Client({ connectionString: base });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();

const pool = createPool(url.toString(), Number(values.pool), { statementTimeoutMs: 600_000, lockTimeoutMs: 60_000, connectionTimeoutMs: 60_000 });
try {
  await migrate(pool, join(process.cwd(), 'migrations'));
  await pool.query(`INSERT INTO ref_regions (id, name) VALUES (1, 'R')`);
  await pool.query(`INSERT INTO ref_products (product_id, name) VALUES (91, 'Gasoline 91')`);

  // stations and tanks, with MoEnergy codes
  await pool.query(
    `INSERT INTO stations (name, operator_station_code, secret_hash, moenergy_station_code)
     SELECT 'S' || g, 'OP-' || g, md5(g::text), 'ST-' || lpad(g::text, 6, '0') FROM generate_series(1, $1) g`,
    [stations],
  );
  await pool.query(
    `INSERT INTO tanks (station_id, tank_number, operator_tank_code, capacity_litres, total_height_m, moenergy_tank_code)
     SELECT s.id, t, 'T' || t, 50000, 3.5, s.moenergy_station_code || '-' || t
       FROM stations s CROSS JOIN generate_series(1, $1) t`,
    [tanksPer],
  );

  // the backlog: perTank readings per tank, oldest first, fuel slowly falling (water small, so every reading is valid)
  let t0 = process.hrtime.bigint();
  await pool.query(
    `INSERT INTO readings (tank_id, device_time, effective_at, fuel_volume_l, water_volume_l, fuel_height_mm, water_height_mm, created_at)
     SELECT t.id, ts, ts, 40000 - i * 0.5, 5, 1800, 15, now() - interval '1 hour'
       FROM tanks t
       CROSS JOIN generate_series(0, $1 - 1) i
       CROSS JOIN LATERAL (SELECT now() - interval '2 hours' - ($1 - i) * ($2 || ' minutes')::interval AS ts) x(ts)`,
    [perTank, String(interval)],
  );
  const insertMs = ms(t0);
  const total = stations * tanksPer * perTank;
  console.log(`seed:    ${total.toLocaleString()} readings (${stations} stations x ${tanksPer} tanks x ${perTank}) in ${(insertMs / 1000).toFixed(1)} s`);

  // the client: one loop per station
  const ledgerMs: number[] = [];
  const buildMs: number[] = [];
  const applyMs: number[] = [];
  const getMs: number[] = [];
  let batches = 0;
  let items = 0;
  let maxBody = 0;
  const stationIds = (await pool.query<{ id: string }>(`SELECT id FROM stations ORDER BY id`)).rows.map((r) => Number(r.id));
  const now = () => new Date();

  async function serve(stationId: number): Promise<void> {
    for (;;) {
      const g0 = process.hrtime.bigint();
      const leave = await enterStation(stationId);
      let batch;
      try {
        let a = process.hrtime.bigint();
        await runLedgerOnce(pool, { policy: 'allow', now }, { stationId });
        ledgerMs.push(ms(a));
        a = process.hrtime.bigint();
        batch = await buildOrReturnOpen(pool, stationId, { now });
        buildMs.push(ms(a));
      } finally {
        leave();
      }
      getMs.push(ms(g0));
      if (!batch) return;
      batches += 1;
      items += batch.itemCount;
      maxBody = Math.max(maxBody, batch.sizeBytes);
      const a = process.hrtime.bigint();
      await applyResult(pool, stationId, batch.id, { status: 200, body: { status: 'accepted', accepted_count: batch.itemCount } });
      applyMs.push(ms(a));
    }
  }

  t0 = process.hrtime.bigint();
  const queue = [...stationIds];
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await serve(id);
    }),
  );
  const drainMs = ms(t0);

  const left = (await pool.query(`SELECT count(*)::int AS n FROM readings WHERE ledger_status = 'pending'`)).rows[0].n;
  const sent = (await pool.query(`SELECT count(*)::int AS n FROM emitted_readings e JOIN batches b ON b.id = e.batch_id WHERE b.status = 'accepted'`)).rows[0].n;
  const size = (await pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`)).rows[0].s;
  const row = (name: string, xs: number[]) =>
    console.log(`${name.padEnd(8)} n=${String(xs.length).padStart(5)}  p50=${pct(xs, 0.5).toFixed(0).padStart(6)} ms  p95=${pct(xs, 0.95).toFixed(0).padStart(6)} ms  max=${Math.max(0, ...xs).toFixed(0).padStart(6)} ms`);

  console.log(`drain:   ${(drainMs / 1000).toFixed(1)} s with ${parallel} stations in parallel, pool ${values.pool}`);
  console.log(`result:  ${sent.toLocaleString()} of ${total.toLocaleString()} readings accepted, ${left} still pending, ${batches} batches, largest body ${(maxBody / 1024).toFixed(0)} KB`);
  console.log(`speed:   ${Math.round(sent / (drainMs / 1000)).toLocaleString()} readings/s end to end`);
  row('GET', getMs);
  row('ledger', ledgerMs);
  row('build', buildMs);
  row('result', applyMs);
  console.log(`size:    database ${size}`);
  console.log(`memory:  rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
} finally {
  await pool.end();
}
