import pg from 'pg';

export type Pool = pg.Pool;

export interface PoolOptions {
  /** how long a request waits for a free connection before giving up */
  connectionTimeoutMs?: number;
  /** longest a single statement may run */
  statementTimeoutMs?: number;
  /** longest a statement waits for a lock (advisory locks included) */
  lockTimeoutMs?: number;
  /** a transaction left open and idle this long is closed by the server */
  idleInTransactionTimeoutMs?: number;
  /** called when the pool loses an idle connection (for example the database restarted) */
  onError?: (err: Error) => void;
  /** TLS to the database; default: from the PGSSL variable, else whatever the connection string says */
  ssl?: pg.PoolConfig['ssl'];
}

/**
 * PGSSL=require: encrypt and check the server certificate. PGSSL=no-verify: encrypt without checking it (some managed
 * databases reached from outside their network). Unset: the connection string decides.
 */
export function sslFromEnv(value: string | undefined): pg.PoolConfig['ssl'] {
  if (value === undefined || value === '') return undefined;
  if (value === 'require') return { rejectUnauthorized: true };
  if (value === 'no-verify') return { rejectUnauthorized: false };
  throw new Error(`PGSSL must be "require" or "no-verify", not "${value}"`);
}

/**
 * Every wait is bounded, so a stuck request cannot hold the whole pool, and ingest keeps working
 * while one station's API calls queue behind a lock.
 */
export function createPool(connectionString: string, max = 10, opts: PoolOptions = {}): Pool {
  const ssl = opts.ssl ?? sslFromEnv(process.env.PGSSL);
  const pool = new pg.Pool({
    connectionString,
    max,
    ...(ssl === undefined ? {} : { ssl }),
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
    statement_timeout: opts.statementTimeoutMs ?? 60_000,
    // A connection that died without telling us (a failover) must fail, not hang while holding a pool slot.
    keepAlive: true,
    query_timeout: (opts.statementTimeoutMs ?? 60_000) + 5_000,
    idle_in_transaction_session_timeout: opts.idleInTransactionTimeoutMs ?? 60_000,
    options: `-c lock_timeout=${opts.lockTimeoutMs ?? 10_000}`,
  });
  // Without a listener, an error on an idle connection is an uncaught exception and ends the process.
  pool.on('error', opts.onError ?? ((err) => console.error('database pool error:', err.message)));
  return pool;
}
