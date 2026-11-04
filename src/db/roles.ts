import type { Pool } from './pool.js';

export interface AppRoleOptions {
  /** name of the login role the running application uses (default pts2_app) */
  role?: string;
  /** letters and digits only: it is placed inside a database URL */
  password: string;
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Creates (or updates) the role the server runs as. It may read and write the application's tables and use their
 * sequences, and nothing else: it cannot change the schema, create roles, or touch the migration bookkeeping, so a
 * flaw in the web application cannot rewrite the database structure. Tables that later migrations create get the
 * same rights. Run by the migration step, as the owner of the tables, after the migrations.
 */
export async function ensureAppRole(pool: Pool, opts: AppRoleOptions): Promise<void> {
  const role = opts.role ?? 'pts2_app';
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`invalid role name "${role}"`);
  if (!/^[A-Za-z0-9]{16,}$/.test(opts.password)) {
    throw new Error('the application database password must be at least 16 letters and digits');
  }
  const r = quote(role);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = (await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rowCount === 1;
    const flags = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
    // the password is validated above to letters and digits, so quoting it is safe (DDL cannot take parameters)
    await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${r} WITH ${flags} PASSWORD '${opts.password}'`);
    const db = (await client.query<{ name: string }>(`SELECT current_database() AS name`)).rows[0]!.name;
    await client.query(`GRANT CONNECT ON DATABASE ${quote(db)} TO ${r}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${r}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${r}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${r}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${r}`);
    // the application never reads or writes the record of which migrations ran
    if ((await client.query(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t) {
      await client.query(`REVOKE ALL ON TABLE schema_migrations FROM ${r}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
