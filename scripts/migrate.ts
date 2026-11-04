import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ensureAppRole } from '../src/db/roles.js';

// Run from the project root (or the image's /app), where the migrations folder lives.
const dir = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'migrations');

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const applied = await migrate(pool, dir);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
  // Production: the server runs as a restricted role. It is set up here, after the migrations, by the owner of the tables.
  const appPassword = process.env.APP_DB_PASSWORD;
  if (appPassword) {
    await ensureAppRole(pool, { role: process.env.APP_DB_ROLE, password: appPassword });
    console.log(`application role ${process.env.APP_DB_ROLE ?? 'pts2_app'} is ready`);
  }
} finally {
  await pool.end();
}
