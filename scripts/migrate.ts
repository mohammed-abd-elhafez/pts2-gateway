import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

// Run from the project root (or the image's /app), where the migrations folder lives.
const dir = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'migrations');

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const applied = await migrate(pool, dir);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
} finally {
  await pool.end();
}
