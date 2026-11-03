import { createPool, type Pool, type PoolOptions } from '../../src/db/pool.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/pts2_test';

export function testPool(max = 10, opts: PoolOptions = {}): Pool {
  return createPool(TEST_DB_URL, max, opts);
}

/** Empties every application table. Migration bookkeeping stays. */
export async function resetDb(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
