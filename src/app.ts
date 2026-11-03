import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import type { Writable } from 'node:stream';
import { registerApiRoutes } from './api/routes.js';
import type { Config } from './config.js';
import type { Pool } from './db/pool.js';
import { loggablePath } from './ingest/auth.js';
import { registerIngestRoutes } from './ingest/routes.js';

export interface AppDeps {
  pool: Pool;
  config: Config;
  /** Tests pass a stream to inspect what gets logged. */
  logStream?: Writable;
  /** Tests pass a fixed clock. */
  now?: () => Date;
}

/** Routes other than ingest take small bodies; ingest sets its own, larger limit. */
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

const BAD_JSON_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

export function buildApp({ pool, config, logStream, now = () => new Date() }: AppDeps): FastifyInstance {
  const logger = pino(
    {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: {
        // The query string is never logged: a controller URI can carry the station secret there.
        req: (req: { method: string; url: string; hostname?: string; ip?: string }) => {
          const q = req.url.indexOf('?');
          return {
            method: req.method,
            url: loggablePath(req.url),
            ...(q === -1 ? {} : { query: '[omitted]' }),
            host: req.hostname,
            remoteAddress: req.ip,
          };
        },
      },
    },
    logStream,
  );

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    trustProxy: false,
    // A client that opens a request and then stalls must not hold a socket for ever.
    requestTimeout: 300_000,
    // Fastify's own answer to an invalid URL echoes the whole path, which may carry a station secret.
    frameworkErrors: (_err, _req, reply) => {
      (reply as unknown as { code(n: number): { send(b: unknown): void } }).code(400).send({ error: 'bad_request' });
    },
    // Unknown properties and wrong types are errors, never silently dropped or coerced.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false, allowUnionTypes: true } },
  });

  // The default 404 echoes the requested URL, which for an ingest path contains the station secret.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation && err.validation.length > 0) {
      const v = err.validation[0]!;
      const params = (v.params ?? {}) as { missingProperty?: string; additionalProperty?: string };
      const field = params.missingProperty ?? params.additionalProperty ?? v.instancePath.replace(/^\//, '').replace(/\//g, '.');
      return reply.code(422).send({ error: 'invalid_request', field: field || 'body', message: v.message });
    }
    if (err.code && BAD_JSON_CODES.has(err.code)) {
      return reply.code(422).send({ error: 'invalid_request', field: 'body', message: 'body is not valid JSON' });
    }
    // A wait that was bounded (lock, statement, pool) is "try again", not a server fault.
    if (err.code === 'STATION_BUSY' || err.code === '55P03' || err.code === '57014' || /timeout exceeded when trying to connect/.test(err.message)) {
      req.log.warn({ code: err.code, message: err.message }, 'database busy');
      return reply.code(503).header('retry-after', '2').send({ error: 'busy' });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: status === 500 ? 'internal' : err.message });
  });

  // Liveness: the process is running. Readiness: the database answers.
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'database unavailable' });
    }
  });

  // Ingest keeps raw bytes for every content type; it lives in its own scope so that choice
  // does not reach the JSON API.
  app.register(async (ingest) => registerIngestRoutes(ingest, { pool, config }));
  registerApiRoutes(app, { pool, config, now });
  return app;
}
