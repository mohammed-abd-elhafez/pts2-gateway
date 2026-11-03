import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';

const config = loadConfig();
let log: (msg: string) => void = (msg) => console.error(msg);
const pool = createPool(config.databaseUrl, 10, {
  connectionTimeoutMs: config.dbConnectionTimeoutMs,
  statementTimeoutMs: config.dbStatementTimeoutMs,
  lockTimeoutMs: config.dbLockTimeoutMs,
  onError: (err) => log(`database pool error: ${err.message}`),
});
const app = buildApp({ pool, config });
log = (msg) => app.log.error(msg);
app.log.info({ negativeConsumedPolicy: config.negativeConsumedPolicy }, 'starting');

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  // Stop accepting uploads and let in-flight ones finish, then release the database.
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
