import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { pruneRawUploads } from '../src/maintenance/prune.js';

// RAW_UPLOADS_RETENTION_DAYS (default 90): how long the raw controller uploads are kept.
const days = Number(process.env.RAW_UPLOADS_RETENTION_DAYS ?? 90);
const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const n = await pruneRawUploads(pool, { days });
  console.log(`removed ${n} raw uploads older than ${days} days`);
} finally {
  await pool.end();
}
