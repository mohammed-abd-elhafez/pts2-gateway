/**
 * Loads stations and tanks, with the codes MoEnergy generated for them, from a CSV file (one row per tank; template:
 * docs/stations.example.csv). All or nothing; safe to run again; a file that disagrees with what is stored is refused
 * unless --update. New stations get their upload secret, shown once.
 *
 *   npm run stations:load -- --file stations.csv [--send-from 2026-11-01T00:00:00+03:00] [--dry-run] [--update]
 *
 * --send-from  go-live time for new tanks whose row has none (default: now). Readings stamped before it are never sent,
 *              so the months a controller has stored are not pushed to MoEnergy when it starts uploading.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { loadStations, parseStationsCsv, StationsFileError } from '../src/stations/load.js';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    'send-from': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    update: { type: 'boolean', default: false },
  },
});
if (!values.file) {
  console.error('usage: npm run stations:load -- --file stations.csv [--send-from ISO] [--dry-run] [--update]');
  process.exit(2);
}
const sendFromDefault = values['send-from'] ? new Date(values['send-from']) : new Date();
if (Number.isNaN(sendFromDefault.getTime())) {
  console.error(`--send-from "${values['send-from']}" is not a date and time`);
  process.exit(2);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const rows = parseStationsCsv(readFileSync(values.file, 'utf8'));
  const r = await loadStations(pool, rows, { sendFromDefault, update: values.update, dryRun: values['dry-run'] });
  console.log(r.dryRun ? 'DRY RUN: nothing was written\n' : '');
  for (const s of r.stations) console.log(`${s.status.padEnd(9)} ${s.code}  (${s.moenergyCode})`);
  console.log(`tanks: ${r.tanks.created} created, ${r.tanks.updated} updated, ${r.tanks.existing} already there`);
  console.log(`go-live time of new tanks without one in the file: ${sendFromDefault.toISOString()}`);
  const fresh = r.stations.filter((s) => s.secret);
  if (fresh.length > 0) {
    console.log('\nUpload secrets, shown once. On the controller (Server tab) set the request URI to the path below and keep the secret safe:');
    for (const s of fresh) console.log(`  ${s.code}: ${s.uploadPath}`);
  }
} catch (err) {
  if (err instanceof StationsFileError) {
    console.error(`the file was not loaded, nothing was written:\n${err.problems.map((p) => `  line ${p.line}: ${p.message}`).join('\n')}`);
    process.exitCode = 1;
  } else throw err;
} finally {
  await pool.end();
}
