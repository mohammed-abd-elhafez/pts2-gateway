/**
 * Fills a fresh deployment with a few simulated stations and one client key so the API can be tried by hand.
 * Does nothing unless DEMO_SEED=true, and nothing the second time. The key is DEMO_API_KEY (at least 24 characters); it is never printed.
 *
 *   DEMO_SEED=true DEMO_API_KEY=... DATABASE_URL=... node dist/scripts/seed-demo.js     (DEMO_STATIONS, DEMO_DAYS optional)
 */
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { seedDemo } from './sim/demo.js';

if (process.env.DEMO_SEED !== 'true') {
  console.log('demo data: off (DEMO_SEED is not "true")');
  process.exit(0);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const r = await seedDemo(pool, {
    apiKey: process.env.DEMO_API_KEY ?? '',
    stations: process.env.DEMO_STATIONS ? Number(process.env.DEMO_STATIONS) : undefined,
    days: process.env.DEMO_DAYS ? Number(process.env.DEMO_DAYS) : undefined,
  });
  console.log(r.seeded ? `demo data: ${r.stations.join(', ')} with ${r.readings} readings` : 'demo data: already there, nothing changed');
} finally {
  await pool.end();
}
