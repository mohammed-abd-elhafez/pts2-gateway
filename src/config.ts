export type NegativeConsumedPolicy = 'allow' | 'hold';

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: string;
  /** Largest accepted upload. A controller can replay a backlog of up to 100,000 records at once. */
  bodyLimitBytes: number;
  /** What the capture endpoint answers to the controller. Swapped for a real jsonPTS reply later. */
  captureReplyStatus: number;
  captureReplyBody: string;
  negativeConsumedPolicy: NegativeConsumedPolicy;
  /** decimals of the litre quantities we send (the guide's examples have two) */
  quantityDecimals: 2 | 3;
  /** most readings per batch we hand out; unset = limited by size only */
  batchMaxItems?: number;
  dbConnectionTimeoutMs: number;
  dbStatementTimeoutMs: number;
  dbLockTimeoutMs: number;
}

export class ConfigError extends Error {}

function int(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');

  if (/:change-me@/.test(databaseUrl)) throw new ConfigError('DATABASE_URL still uses the example password "change-me"');

  const decimalsText = env.QUANTITY_DECIMALS ?? '2';
  if (decimalsText !== '2' && decimalsText !== '3') throw new ConfigError(`QUANTITY_DECIMALS must be 2 or 3, got "${decimalsText}"`);
  const decimals: 2 | 3 = decimalsText === '3' ? 3 : 2;

  const policy = env.NEGATIVE_CONSUMED_POLICY ?? 'allow';
  if (policy !== 'allow' && policy !== 'hold') {
    throw new ConfigError(`NEGATIVE_CONSUMED_POLICY must be "allow" or "hold", got "${policy}"`);
  }

  return {
    host: env.HOST ?? '0.0.0.0',
    port: int('PORT', env.PORT, 8080, 1, 65535),
    databaseUrl,
    logLevel: env.LOG_LEVEL ?? 'info',
    bodyLimitBytes: int('BODY_LIMIT_BYTES', env.BODY_LIMIT_BYTES, 20 * 1024 * 1024, 1024, 200 * 1024 * 1024),
    captureReplyStatus: int('CAPTURE_REPLY_STATUS', env.CAPTURE_REPLY_STATUS, 200, 200, 299),
    captureReplyBody: env.CAPTURE_REPLY_BODY ?? '{"ok":true}',
    negativeConsumedPolicy: policy,
    quantityDecimals: decimals,
    batchMaxItems: env.BATCH_MAX_ITEMS ? int('BATCH_MAX_ITEMS', env.BATCH_MAX_ITEMS, 1, 1, 100_000) : undefined,
    dbConnectionTimeoutMs: int('DB_CONNECTION_TIMEOUT_MS', env.DB_CONNECTION_TIMEOUT_MS, 5_000, 100, 120_000),
    dbStatementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', env.DB_STATEMENT_TIMEOUT_MS, 60_000, 1_000, 600_000),
    dbLockTimeoutMs: int('DB_LOCK_TIMEOUT_MS', env.DB_LOCK_TIMEOUT_MS, 10_000, 100, 120_000),
  };
}
