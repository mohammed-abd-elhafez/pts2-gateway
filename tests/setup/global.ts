import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { TEST_DB_URL } from '../helpers/db.js';

const scriptsDir = fileURLToPath(new URL('../../scripts', import.meta.url));
const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

async function tryConnect(): Promise<boolean> {
  const pool = createPool(TEST_DB_URL, 1);
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export default async function setup(): Promise<void> {
  if (!/test/.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error('refusing to reset a database whose name does not contain "test"');
  }
  if (!(await tryConnect())) {
    // scripts/pg-test.sh needs the PostgreSQL server binaries and bash: Linux only, and only when no URL was given.
    if (process.platform !== 'linux' || process.env.TEST_DATABASE_URL) {
      throw new Error(
        `Cannot reach the test database at ${TEST_DB_URL}.\n` +
          'Start a PostgreSQL 16 and set TEST_DATABASE_URL, for example:\n' +
          '  docker run -d --name pts2-test -p 54329:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=pts2_test postgres:16\n' +
          '  PowerShell:  $env:TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:54329/pts2_test"',
      );
    }
    execFileSync('bash', [`${scriptsDir}/pg-test.sh`, 'start'], { stdio: 'inherit' });
  }
  const pool = createPool(TEST_DB_URL, 2);
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool, migrationsDir);
  } finally {
    await pool.end();
  }
}
