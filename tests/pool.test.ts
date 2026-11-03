import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPool, sslFromEnv } from '../src/db/pool.js';
import { TEST_DB_URL, testPool } from './helpers/db.js';

const admin = testPool(2);
afterAll(() => admin.end());

describe('createPool', () => {
  it('bounds every wait', async () => {
    const pool = createPool(TEST_DB_URL, 2, { lockTimeoutMs: 300, statementTimeoutMs: 5_000, idleInTransactionTimeoutMs: 7_000 });
    const show = async (name: string) => (await pool.query(`SHOW ${name}`)).rows[0][name];
    expect(await show('lock_timeout')).toBe('300ms');
    expect(await show('statement_timeout')).toBe('5s');
    expect(await show('idle_in_transaction_session_timeout')).toBe('7s');
    // a dead connection must fail instead of hanging: keep-alive on, client-side timeout just above the server's
    const opts = (pool as unknown as { options: { keepAlive?: boolean; query_timeout?: number } }).options;
    expect(opts.keepAlive).toBe(true);
    expect(opts.query_timeout).toBe(10_000);
    await pool.end();
  });

  it('survives the database dropping an idle connection, and reports it', async () => {
    const onError = vi.fn();
    const pool = createPool(TEST_DB_URL, 2, { onError });
    const pid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; // leaves one idle client
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await new Promise((r) => setTimeout(r, 300));
    expect(onError).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1); // a fresh connection is made
    await pool.end();
  });

  it('gives up waiting for a free connection instead of queueing forever', async () => {
    const pool = createPool(TEST_DB_URL, 1, { connectionTimeoutMs: 200 });
    const held = await pool.connect();
    await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout exceeded when trying to connect/);
    held.release();
    await pool.end();
  });
});

describe('loadConfig', () => {
  it('refuses the example database password', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://postgres:change-me@db:5432/pts2' })).toThrow(/change-me/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://postgres:s3cret@db:5432/pts2' })).not.toThrow();
  });

  it('reads the database timeouts and validates them', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u@h/d', DB_LOCK_TIMEOUT_MS: '2500' });
    expect(c.dbLockTimeoutMs).toBe(2500);
    expect(c.dbConnectionTimeoutMs).toBe(5000);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://u@h/d', DB_LOCK_TIMEOUT_MS: '5' })).toThrow(/DB_LOCK_TIMEOUT_MS/);
  });
});

describe('QUANTITY_DECIMALS', () => {
  it('is 2 by default, accepts 3, refuses anything else', () => {
    const base = { DATABASE_URL: 'postgres://u:p@h/db' };
    expect(loadConfig(base).quantityDecimals).toBe(2);
    expect(loadConfig({ ...base, QUANTITY_DECIMALS: '3' }).quantityDecimals).toBe(3);
    expect(() => loadConfig({ ...base, QUANTITY_DECIMALS: '4' })).toThrow(/QUANTITY_DECIMALS/);
  });
});

describe('sslFromEnv (for a database reached over the internet, such as a managed one)', () => {
  it('leaves SSL to the connection string when PGSSL is not set', () => {
    expect(sslFromEnv(undefined)).toBeUndefined();
    expect(sslFromEnv('')).toBeUndefined();
  });

  it('"require" encrypts and checks the server certificate', () => {
    expect(sslFromEnv('require')).toEqual({ rejectUnauthorized: true });
  });

  it('"no-verify" encrypts without checking the certificate', () => {
    expect(sslFromEnv('no-verify')).toEqual({ rejectUnauthorized: false });
  });

  it('refuses any other value rather than guessing', () => {
    expect(() => sslFromEnv('yes')).toThrow(/PGSSL/);
  });

  it('is passed on to the connection', () => {
    const pool = createPool(TEST_DB_URL, 1, { ssl: { rejectUnauthorized: false } });
    expect((pool as unknown as { options: { ssl?: unknown } }).options.ssl).toEqual({ rejectUnauthorized: false });
    return pool.end();
  });
});
