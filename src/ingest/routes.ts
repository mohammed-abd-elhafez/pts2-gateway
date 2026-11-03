import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { extractSecret, findStationBySecret, redactSecret, redactUrl, type AuthedStation } from './auth.js';
import { storeUpload } from './store.js';

declare module 'fastify' {
  interface FastifyRequest {
    ingestStation?: AuthedStation;
    ingestSecret?: string;
  }
}

/**
 * Capture mode: authenticate the station, store the upload untouched, answer with the
 * configured reply. Nothing is parsed or rejected on content, so whatever the controller
 * sends is kept for later analysis.
 */
export function registerIngestRoutes(app: FastifyInstance, deps: { pool: Pool; config: Config }): void {
  const { pool, config } = deps;

  // Keep every body as raw bytes, whatever its content type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.bodyLimitBytes }, (_req, body, done) =>
    done(null, body),
  );

  // The secret needs only the URL and headers, so it is checked before the body is read: an
  // unauthenticated caller costs a lookup, not a buffered upload.
  async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
    const secret = extractSecret(req.headers, req.url);
    const station = secret ? await findStationBySecret(pool, secret) : null;
    if (!secret || !station) {
      return reply.code(401).header('www-authenticate', 'Basic realm="pts"').send({ error: 'unauthorized' });
    }
    req.ingestStation = station;
    req.ingestSecret = secret;
  }

  async function handle(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const station = req.ingestStation!;
    const secret = req.ingestSecret!;

    const qIndex = req.url.indexOf('?');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const uploadId = await storeUpload(pool, {
      stationId: station.id,
      secret,
      method: req.method,
      path: redactSecret(redactUrl(qIndex === -1 ? req.url : req.url.slice(0, qIndex)), secret),
      query: qIndex === -1 ? null : redactSecret(req.url.slice(qIndex + 1), secret),
      headers: req.headers,
      contentType: req.headers['content-type'] ?? null,
      body,
    });
    req.log.info({ station: station.operatorStationCode, uploadId, bytes: body.length }, 'upload captured');

    return reply.code(config.captureReplyStatus).type('application/json').send(config.captureReplyBody);
  }

  for (const url of ['/pts', '/pts/*']) {
    app.route({
      method: ['POST', 'PUT', 'GET'],
      url,
      bodyLimit: config.bodyLimitBytes,
      onRequest: authenticate,
      handler: handle,
    });
  }
}
