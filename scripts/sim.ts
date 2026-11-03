/**
 * Simulated stations end to end, in a scratch database (name ends _sim). Prints what happened and checks it.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/pts2_test \
 *     npx tsx scripts/sim.ts --stations 38 --days 30 --seed 1 [--faults] [--refuse-negative] [--outage 10:5] [--csv-dir out]
 *
 * --faults           inject the faults of the real data (00:00:00 bursts, same-second pairs, small rises, probe glitches), per station
 * --refuse-negative  MoEnergy answers 422 to a negative consumed quantity (a refill)
 * --outage D:N       the controllers are away for N days from day D
 * --csv-dir DIR      also write each station's TANKMSR.CSV there
 * Exit code 1 when a check fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { runScenario } from './sim/run.js';

const { values } = parseArgs({
  options: {
    stations: { type: 'string', default: '38' },
    days: { type: 'string', default: '30' },
    seed: { type: 'string', default: '1' },
    start: { type: 'string', default: '2026-09-01' },
    faults: { type: 'boolean', default: false },
    'refuse-negative': { type: 'boolean', default: false },
    outage: { type: 'string' },
    'csv-dir': { type: 'string' },
    pool: { type: 'string', default: '8' },
  },
});

const base = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/pts2_test';
const url = new URL(base);
url.pathname = '/pts2_sim';

const admin = new pg.Client({ connectionString: base });
await admin.connect();
await admin.query('DROP DATABASE IF EXISTS pts2_sim');
await admin.query('CREATE DATABASE pts2_sim');
await admin.end();

const pool = createPool(url.toString(), Number(values.pool), { statementTimeoutMs: 600_000, lockTimeoutMs: 60_000, connectionTimeoutMs: 60_000 });
try {
  await migrate(pool, join(process.cwd(), 'migrations'));
  const outage = values.outage ? values.outage.split(':').map(Number) : null;
  const r = await runScenario(pool, {
    stations: Number(values.stations),
    days: Number(values.days),
    seed: Number(values.seed),
    startDate: values.start,
    refuseNegative: values['refuse-negative'],
    faults: values.faults ? { clockInvalidBursts: 2, sameSecondPairs: 3, noiseRises: 4, probeGlitches: 2 } : undefined,
    outages: outage ? [{ startDay: outage[0]!, days: outage[1]! }] : undefined,
  });
  if (values['csv-dir']) {
    mkdirSync(values['csv-dir'], { recursive: true });
    for (const s of r.ctx.stations) writeFileSync(join(values['csv-dir'], `${s.code}_TANKMSR.CSV`), s.csv);
  }
  const s = r.stats;
  console.log(`stations ${s.stations}, days ${s.days}: ${s.recordsGenerated} records generated (${(s.recordsGenerated / s.stations / s.days).toFixed(0)} per station per day)`);
  console.log(`imported ${s.imported} (${s.clockInvalidStored} set aside as clock_invalid, ${s.duplicateTime} same-second duplicates dropped)`);
  console.log(`chained ${s.emitted}, stored at MoEnergy ${s.storedAtMoEnergy}, batches ${s.batches}, largest ${s.maxBatchBytes} bytes`);
  console.log(`refills in the chain ${s.refillsSeen}, small rises ${s.smallNegatives}, probe glitches skipped ${s.skippedGlitches}, tanks held ${s.heldTanks}, answers refused ${s.refusedByMoEnergy}`);
  console.log(`client actions ${JSON.stringify(s.actions)}`);
  console.log(`took ${(s.ms / 1000).toFixed(1)} s`);
  if (r.violations.length > 0) {
    console.log(`\n${r.violations.length} CHECK(S) FAILED:`);
    for (const v of r.violations.slice(0, 40)) console.log(` - ${v}`);
    process.exitCode = 1;
  } else {
    console.log('\nall checks passed');
  }
} finally {
  await pool.end();
}
