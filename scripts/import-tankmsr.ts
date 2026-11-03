/**
 * Loads a controller's TANKMSR.CSV into a station's readings (rows without litres and rows stamped 00:00:00 are not chained).
 * Safe to run twice on the same file.
 *
 *   npm run import:tankmsr -- --station RYD-01 --file TANKMSR.CSV [--since 2026-10-04T00:00:00+03:00] [--offset 180]
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { importTankMsr } from '../src/import/tankmsr.js';

const { values } = parseArgs({
  options: { station: { type: 'string' }, file: { type: 'string' }, since: { type: 'string' }, offset: { type: 'string' } },
});
if (!values.station || !values.file) {
  console.error('usage: npm run import:tankmsr -- --station RYD-01 --file TANKMSR.CSV [--since ISO] [--offset 180]');
  process.exit(2);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM stations WHERE lower(operator_station_code) = lower($1)`, [values.station]);
  if (!rows[0]) {
    console.error(`no station with the code ${values.station}`);
    process.exit(1);
  }
  const report = await importTankMsr(pool, Number(rows[0].id), readFileSync(values.file, 'utf8'), {
    since: values.since ? new Date(values.since) : undefined,
    utcOffsetMinutes: values.offset ? Number(values.offset) : undefined,
  });
  const { errors, ...rest } = report;
  console.log(JSON.stringify(rest, null, 2));
  if (errors.length > 0) {
    console.log(`${errors.length} unreadable line(s), first ones:`);
    for (const e of errors.slice(0, 10)) console.log(`  line ${e.line}: ${e.message}`);
  }
} finally {
  await pool.end();
}
