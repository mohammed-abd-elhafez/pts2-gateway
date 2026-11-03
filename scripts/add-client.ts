import { parseArgs } from 'node:util';
import { createClient } from '../src/api/clients.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { findStationByOperatorCode } from '../src/stations/lookup.js';

const { values } = parseArgs({ options: { name: { type: 'string' }, station: { type: 'string' }, all: { type: 'boolean' } } });
if (!values.name || (!values.station && !values.all) || (values.station && values.all)) {
  console.error('usage: npm run client:add -- --name "client system" (--station RYD-01 | --all)');
  console.error('  --station: the key works for that station only;  --all: for every station, including later ones');
  process.exit(2);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  let stationId: number | undefined;
  if (values.station) {
    const station = await findStationByOperatorCode(pool, values.station);
    if (!station) {
      console.error(`no station with code "${values.station}"`);
      process.exit(1);
    }
    stationId = station.id;
  }
  const { id, key } = await createClient(pool, values.name, { stationId });
  console.log(`client ${id} created${values.station ? ` for station ${values.station}` : ' for all stations'}`);
  console.log(`API key (shown once): ${key}`);
  console.log('send it as:  Authorization: Bearer <key>');
} finally {
  await pool.end();
}
