import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { createStation } from '../src/stations/create.js';

const { values } = parseArgs({
  options: {
    code: { type: 'string' },
    name: { type: 'string' },
    offset: { type: 'string', default: '180' },
  },
});
if (!values.code || !values.name) {
  console.error('usage: npm run station:add -- --code RYD-01 --name "Riyadh North" [--offset 180]');
  process.exit(2);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const { id, secret } = await createStation(pool, {
    operatorStationCode: values.code,
    name: values.name,
    utcOffsetMinutes: Number(values.offset),
  });
  console.log(`station ${id} created`);
  console.log(`secret (shown once): ${secret}`);
  console.log(`controller URI:      /pts/${secret}`);
} finally {
  await pool.end();
}
