import type { FastifyInstance } from 'fastify';
import { buildOrReturnOpen, enterStation } from '../batches/builder.js';
import { applyResult, BatchClosedError, BatchNotFoundError, CorrelationMismatchError, releaseBatch } from '../batches/result.js';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { milliToJsonNumber, parseMilli, QuantityError, roundMilli } from '../domain/quantity.js';
import { setAnchor, UnsentReadingsError } from '../ledger/service.js';
import { runLedgerOnce } from '../ledger/worker.js';
import { findStationByOperatorCode, type StationRef } from '../stations/lookup.js';
import { bearerToken, findClientByKey, type ApiClient } from './clients.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiClient?: ApiClient;
    station?: StationRef;
  }
}

export interface ApiDeps {
  pool: Pool;
  config: Config;
  now: () => Date;
}

/** PostgreSQL text cannot hold a NUL byte. */
const NO_NUL = '^[^\\u0000]*$';

const resultRoute = {
  bodyLimit: 256 * 1024,
  schema: {
    body: {
      type: 'object',
      required: ['status_code'],
      additionalProperties: false,
      properties: {
        status_code: { type: 'integer', minimum: 100, maximum: 599 },
        // MoEnergy's response body, exactly as received: any JSON value
        body: {},
        // the X-Correlation-Id the batch was sent with; when given, a result for another send is refused
        correlation_id: { type: 'string', minLength: 1, maxLength: 64 },
      },
    },
  },
} as const;

const anchorRoute = {
  bodyLimit: 4 * 1024,
  schema: {
    body: {
      type: 'object',
      required: ['remaining_quantity', 'reason'],
      additionalProperties: false,
      properties: {
        remaining_quantity: { type: ['number', 'string'] },
        reason: { type: 'string', minLength: 1, maxLength: 500, pattern: NO_NUL },
        // when MoEnergy held this value: readings at or before this time are already there
        as_of: { type: 'string', format: 'date-time', maxLength: 40 },
        // let the next reading pass as a refill (default: only when the tank is held for one under the hold policy)
        accept_negative: { type: 'boolean' },
      },
    },
  },
} as const;

const releaseRoute = {
  bodyLimit: 4 * 1024,
  schema: {
    body: {
      type: 'object',
      additionalProperties: false,
      properties: { reason: { type: 'string', minLength: 1, maxLength: 500, pattern: NO_NUL } },
    },
  },
} as const;

/**
 * The routes the client's system calls. Every station has its own set, under
 * /v1/stations/{operator_station_code}, behind a bearer key that is either bound to that station
 * or valid for all of them. Stations never share a batch.
 */
export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { pool, config, now } = deps;

  app.register(
    async (api) => {
      // Key and station need only the headers and the path, so both are checked before the body is
      // read or parsed. A station the key may not use looks exactly like one that does not exist.
      api.addHook('onRequest', async (req, reply) => {
        const key = bearerToken(req.headers.authorization);
        const client = key ? await findClientByKey(pool, key) : null;
        if (!client) {
          return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' });
        }
        const code = (req.params as { station_code?: string }).station_code ?? '';
        const station = await findStationByOperatorCode(pool, code);
        if (!station || (client.stationId !== null && client.stationId !== station.id)) {
          return reply.code(404).send({ error: 'not_found', field: 'station_code' });
        }
        req.apiClient = client;
        req.station = station;
      });

      // The open batch, or a new one, or 204. The ledger runs first so fresh readings are included.
      api.get('/readings/batches/next', async (req, reply) => {
        const stationId = req.station!.id;
        // The ledger run and the build form one turn for this station, so requests that wait do not hold connections.
        const leave = await enterStation(stationId);
        let batch;
        try {
          await runLedgerOnce(
            pool,
            { policy: config.negativeConsumedPolicy, now, decimals: config.quantityDecimals },
            {
              stationId,
              onError: (tankId, err) =>
                req.log.error({ station: req.station!.operatorCode, tankId, err }, 'ledger failed for a tank; the others went on'),
            },
          );
          batch = await buildOrReturnOpen(pool, stationId, { now });
        } finally {
          leave();
        }
        if (!batch) return reply.code(204).send();
        return reply
          .header('x-batch-id', String(batch.id))
          .header('x-correlation-id', batch.correlationId)
          .type('application/json')
          .send(batch.body);
      });

      api.post<{ Params: { station_code: string; id: string }; Body: { status_code: number; body?: unknown; correlation_id?: string } }>(
        '/readings/batches/:id/result',
        resultRoute,
        async (req, reply) => {
          const id = /^\d{1,15}$/.test(req.params.id) ? Number(req.params.id) : null;
          if (id === null) return reply.code(404).send({ error: 'not_found', field: 'id' });
          try {
            const { outcome, replayed } = await applyResult(
              pool,
              req.station!.id,
              id,
              { status: req.body.status_code, body: req.body.body ?? null },
              { correlationId: req.body.correlation_id },
            );
            // Normal outcomes are not worth an alert; the ones that stop or change something are.
            const ctx = { station: req.station!.operatorCode, batchId: id, outcome, replayed };
            if (outcome.action === 'needs_attention' || outcome.action === 'fix_client_side') {
              req.log.error(ctx, 'batch result needs a person');
            } else if (outcome.batch_status === 'rejected' || outcome.action === 'accepted_assumed_resend') {
              req.log.warn(ctx, 'batch result changed the ledger');
            } else {
              req.log.info(ctx, 'batch result recorded');
            }
            return { ...outcome, replayed };
          } catch (err) {
            if (err instanceof BatchNotFoundError) return reply.code(404).send({ error: 'not_found', field: 'id' });
            if (err instanceof BatchClosedError) return reply.code(409).send({ error: 'batch_closed', field: 'id' });
            if (err instanceof CorrelationMismatchError) {
              return reply.code(409).send({ error: 'correlation_mismatch', field: 'correlation_id' });
            }
            throw err;
          }
        },
      );

      // A person tells us what MoEnergy holds for the tank; its next readings chain from that.
      // The client gives up on an open batch it cannot resolve; its items go into the next batch. Always safe:
      // anything MoEnergy did store comes back as a stored duplicate and is confirmed on its own.
      api.post<{ Params: { station_code: string; id: string }; Body: { reason?: string } | undefined }>(
        '/readings/batches/:id/release',
        releaseRoute,
        async (req, reply) => {
          const id = /^\d{1,15}$/.test(req.params.id) ? Number(req.params.id) : null;
          if (id === null) return reply.code(404).send({ error: 'not_found', field: 'id' });
          try {
            const { outcome, replayed } = await releaseBatch(pool, req.station!.id, id, req.body?.reason ?? 'released by the client');
            req.log.warn({ station: req.station!.operatorCode, batchId: id, replayed }, 'batch released by the client');
            return { ...outcome, replayed };
          } catch (err) {
            if (err instanceof BatchNotFoundError) return reply.code(404).send({ error: 'not_found', field: 'id' });
            if (err instanceof BatchClosedError) return reply.code(409).send({ error: 'batch_closed', field: 'id' });
            throw err;
          }
        },
      );

      api.post<{
        Params: { station_code: string; tank_code: string };
        Body: { remaining_quantity: number | string; reason: string; as_of?: string; accept_negative?: boolean };
      }>(
        '/tanks/:tank_code/anchor',
        anchorRoute,
        async (req, reply) => {
          // a NUL byte cannot be in any stored code, and PostgreSQL would refuse it as a parameter
          if (req.params.tank_code.includes('\u0000')) return reply.code(404).send({ error: 'not_found', field: 'tank_code' });
          const tank = (
            await pool.query<{ id: string; capacity_litres: string }>(
              `SELECT id, capacity_litres FROM tanks WHERE moenergy_tank_code = $1 AND station_id = $2`,
              [req.params.tank_code, req.station!.id],
            )
          ).rows[0];
          if (!tank) return reply.code(404).send({ error: 'not_found', field: 'tank_code' });

          // MoEnergy holds a positive remaining quantity below the tank's capacity: anything else would make
          // every following reading fail its own rules (water below fuel, fuel within capacity).
          let remaining;
          try {
            remaining = roundMilli(parseMilli(req.body.remaining_quantity, { strict: true }), config.quantityDecimals);
            if (remaining <= 0 || remaining > parseMilli(tank.capacity_litres)) throw new QuantityError('out of range');
          } catch (err) {
            if (err instanceof QuantityError) {
              return reply.code(422).send({
                error: 'invalid_request',
                field: 'remaining_quantity',
                message: 'must be a plain number with at most 3 decimals, above 0 and not above the tank capacity',
              });
            }
            throw err;
          }
          const asOf = req.body.as_of === undefined ? undefined : new Date(req.body.as_of);
          if (asOf !== undefined && (Number.isNaN(asOf.getTime()) || asOf.getTime() > now().getTime() + 5 * 60_000)) {
            return reply.code(422).send({ error: 'invalid_request', field: 'as_of' });
          }

          try {
            await setAnchor(pool, Number(tank.id), remaining, req.body.reason, req.apiClient!.name, {
              requireNoUnsent: true,
              asOf,
              acceptNegative: req.body.accept_negative,
            });
          } catch (err) {
            if (err instanceof UnsentReadingsError) {
              return reply.code(409).send({ error: 'tank_has_unsent_readings', field: 'tank_code' });
            }
            throw err;
          }
          req.log.info({ tank: req.params.tank_code, by: req.apiClient!.name }, 'tank anchored');
          return { tank_code: req.params.tank_code, remaining_quantity: milliToJsonNumber(remaining), chain_held: false };
        },
      );
    },
    { prefix: '/v1/stations/:station_code' },
  );
}
