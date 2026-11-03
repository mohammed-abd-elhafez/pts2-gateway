import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from './pool.js';

const LOCK_KEY = 727_001;

/**
 * Applies every `*.sql` file in `dir` that is not yet recorded, in name order,
 * one transaction per file. Returns the names applied by this call.
 */
export async function migrate(pool: Pool, dir: string, table = 'schema_migrations'): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`invalid migrations table name "${table}"`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS ${table} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>(`SELECT name FROM ${table}`)).rows.map((r) => r.name));

    for (const name of files) {
      if (done.has(name)) continue;
      const sql = await readFile(join(dir, name), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`INSERT INTO ${table} (name) VALUES ($1)`, [name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${name} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(name);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}
