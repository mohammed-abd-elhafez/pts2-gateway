import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Pool } from '../db/pool.js';
import { mmToMetersMilli, parseMilli } from '../domain/quantity.js';
import { DEFAULT_SETTLE_MS } from '../domain/settle.js';
import {
  EMPTY_BATCH_BYTES,
  readingJsonBytes,
  serializeBatch,
  toMoEnergyReading,
  type ReadingForBatch,
} from '../moenergy/serialize.js';

/** First half of the advisory lock key; the second half is the station id. */
export const BATCH_LOCK_KEY = 727_002;

/**
 * Serialises batch building and result handling for one station. Different stations take
 * different locks, so they never wait for each other.
 */
export async function lockStation(c: PoolClient, stationId: number): Promise<void> {
  if (!Number.isInteger(stationId) || stationId < 1 || stationId > 2_147_483_647) {
    throw new Error(`station id out of range: ${stationId}`);
  }
  await c.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [BATCH_LOCK_KEY, stationId]);
}

/** More requests than this waiting for one station are answered "busy" at once. */
const MAX_STATION_QUEUE = 32;

/** The station already has a full queue of requests waiting for its lock. */
export class StationBusyError extends Error {
  readonly code = 'STATION_BUSY';
}

const gates = new Map<number, { tail: Promise<void>; count: number }>();

/**
 * Makes requests for one station take turns inside this process BEFORE they take a database connection.
 * Without it every waiting request would hold a pooled connection while it waited for the advisory lock, and
 * a handful of them could use up the pool and stop uploads from every other station (review F12).
 * The advisory lock still decides between processes. Returns the function that ends the turn.
 */
export async function enterStation(stationId: number): Promise<() => void> {
  let gate = gates.get(stationId);
  if (!gate) {
    gate = { tail: Promise.resolve(), count: 0 };
    gates.set(stationId, gate);
  }
  if (gate.count >= MAX_STATION_QUEUE) throw new StationBusyError(`station ${stationId} has ${gate.count} requests waiting`);
  gate.count += 1;
  const previous = gate.tail;
  let done!: () => void;
  gate.tail = new Promise<void>((resolve) => (done = resolve));
  const g = gate;
  await previous;
  return () => {
    g.count -= 1;
    if (g.count === 0 && gates.get(stationId) === g) gates.delete(stationId);
    done();
  };
}

/** Under MoEnergy's 1 MB request limit with room to spare. */
export const DEFAULT_MAX_BYTES = 900_000;
export { DEFAULT_SETTLE_MS };
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface BatchOptions {
  now: () => Date;
  settleMs?: number;
  maxBytes?: number;
  /** most readings in one batch (MoEnergy's own limit is unknown; a smaller batch costs less if it is refused) */
  maxItems?: number;
  /** most unsent rows examined per build */
  candidateLimit?: number;
}

export interface BuiltBatch {
  id: number;
  correlationId: string;
  itemCount: number;
  sizeBytes: number;
  /** exactly the JSON MoEnergy accepts */
  body: string;
}

interface ItemRow {
  id: string;
  tank_id: string;
  effective_at: Date;
  fuel_quantity: string;
  consumed_quantity: string;
  remaining_quantity: string;
  temperature_c: string | null;
  water_volume_l: string;
  fuel_height_mm: string;
  water_height_mm: string;
  stored_at: Date;
  moenergy_station_code: string;
  moenergy_tank_code: string;
}

const ITEM_COLUMNS = `
  e.id, e.tank_id, e.effective_at, e.fuel_quantity, e.consumed_quantity, e.remaining_quantity, e.temperature_c,
  r.water_volume_l, r.fuel_height_mm, r.water_height_mm, r.created_at AS stored_at,
  s.moenergy_station_code, t.moenergy_tank_code`;

const ITEM_JOINS = `
  FROM emitted_readings e
  JOIN readings r ON r.id = e.reading_id
  JOIN tanks t ON t.id = e.tank_id
  JOIN stations s ON s.id = t.station_id`;

/**
 * The most unsent rows read per tank in one build. A batch under 900 KB holds a few thousand
 * readings, so this is plenty, and it matters for speed: with a large LIMIT PostgreSQL expects a huge
 * row count, abandons the index lookups and joins against the whole readings table (measured: 0.8 s
 * against 38 ms with 200,000 unsent rows elsewhere).
 */
export const PER_TANK_CANDIDATES = 2000;

/**
 * Per tank of the station, its oldest unsent rows: the work stays proportional to this station, not
 * to every station's backlog. A tank is read as a prefix, so cutting it short never skips a reading.
 */
const CANDIDATES = `
  SELECT e.id, e.tank_id, e.effective_at, e.fuel_quantity, e.consumed_quantity, e.remaining_quantity, e.temperature_c,
         e.water_volume_l, e.fuel_height_mm, e.water_height_mm, e.stored_at,
         s.moenergy_station_code, t.moenergy_tank_code
    FROM tanks t
    JOIN stations s ON s.id = t.station_id
    CROSS JOIN LATERAL (
      SELECT x.id, x.tank_id, x.effective_at, x.fuel_quantity, x.consumed_quantity, x.remaining_quantity, x.temperature_c,
             r.water_volume_l, r.fuel_height_mm, r.water_height_mm, r.created_at AS stored_at
        FROM emitted_readings x JOIN readings r ON r.id = x.reading_id
       WHERE x.tank_id = t.id AND x.batch_id IS NULL
       ORDER BY x.effective_at, x.id
       LIMIT ${PER_TANK_CANDIDATES}
    ) e
   WHERE t.station_id = $1 AND t.is_active
     AND s.moenergy_station_code IS NOT NULL AND t.moenergy_tank_code IS NOT NULL
   ORDER BY e.effective_at, e.id
   LIMIT $2`;

function toReading(row: ItemRow): ReadingForBatch {
  return {
    stationCode: row.moenergy_station_code,
    tankCode: row.moenergy_tank_code,
    fuel: parseMilli(row.fuel_quantity),
    consumed: parseMilli(row.consumed_quantity),
    remaining: parseMilli(row.remaining_quantity),
    fuelHeightM: mmToMetersMilli(row.fuel_height_mm),
    waterVolume: parseMilli(row.water_volume_l),
    waterHeightM: mmToMetersMilli(row.water_height_mm),
    temperature: row.temperature_c === null ? null : Number(row.temperature_c),
    effectiveAt: row.effective_at,
  };
}

/** The items of a batch in body order. Rebuilding an open batch reads these, so it never changes. */
export async function loadBatchBody(c: PoolClient, batchId: number): Promise<string> {
  const { rows } = await c.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE e.batch_id = $1 ORDER BY e.batch_position`,
    [batchId],
  );
  return serializeBatch(rows.map((r) => toMoEnergyReading(toReading(r))));
}

/**
 * Returns the station's open batch if there is one, otherwise builds its next one from unsent
 * emitted readings, or returns null when nothing is ready. A station has at most one open batch,
 * because MoEnergy checks each reading against the last one it stored for the tank. Stations are
 * independent: one station's open batch never holds up another's.
 */
export async function getOrCreateNextBatch(pool: Pool, stationId: number, opts: BatchOptions): Promise<BuiltBatch | null> {
  const leave = await enterStation(stationId);
  try {
    return await buildOrReturnOpen(pool, stationId, opts);
  } finally {
    leave();
  }
}

/** A build that finds the ledger moved under it is thrown away and done again, this many times at most. */
const BUILD_ATTEMPTS = 3;

/** The same as getOrCreateNextBatch, for a caller that already holds the station's turn (see enterStation). */
export async function buildOrReturnOpen(pool: Pool, stationId: number, opts: BatchOptions): Promise<BuiltBatch | null> {
  for (let attempt = 1; ; attempt += 1) {
    const built = await buildOnce(pool, stationId, opts);
    if (built !== 'ledger_moved') return built;
    if (attempt >= BUILD_ATTEMPTS) throw new StationBusyError(`station ${stationId}: the ledger kept changing while a batch was built`);
  }
}

async function buildOnce(pool: Pool, stationId: number, opts: BatchOptions): Promise<BuiltBatch | null | 'ledger_moved'> {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const cutoff = new Date(opts.now().getTime() - settleMs);

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await lockStation(c, stationId);

    const open = (
      await c.query<{ id: string; correlation_id: string; size_bytes: number; item_count: number; body_sha256: string | null }>(
        `SELECT id, correlation_id, size_bytes, item_count, body_sha256 FROM batches WHERE status = 'open' AND station_id = $1`,
        [stationId],
      )
    ).rows[0];
    if (open) {
      const body = await loadBatchBody(c, Number(open.id));
      // An open batch is re-read from live rows. If anything it is built from changed (a renamed
      // MoEnergy code, say) the bytes would differ from what was promised: stop loudly.
      if (Buffer.byteLength(body) !== open.size_bytes || (open.body_sha256 !== null && sha256(body) !== open.body_sha256)) {
        throw new Error(`open batch ${open.id} no longer matches what was built`);
      }
      await c.query('COMMIT');
      return {
        id: Number(open.id),
        correlationId: open.correlation_id,
        itemCount: open.item_count,
        sizeBytes: open.size_bytes,
        body,
      };
    }

    // Oldest first. A tank is taken as a gapless prefix: once one of its readings is not ready,
    // none of its later readings may go either.
    const candidates = (await c.query<ItemRow>(CANDIDATES, [stationId, opts.candidateLimit ?? 20_000])).rows;

    const blocked = new Set<string>();
    const picked: ItemRow[] = [];
    const items: ReturnType<typeof toMoEnergyReading>[] = [];
    let bytes = EMPTY_BATCH_BYTES - 1;
    for (const row of candidates) {
      if (blocked.has(row.tank_id)) continue;
      if (row.stored_at.getTime() > cutoff.getTime()) {
        blocked.add(row.tank_id);
        continue;
      }
      const item = toMoEnergyReading(toReading(row));
      const add = readingJsonBytes(item);
      if (opts.maxItems !== undefined && picked.length >= opts.maxItems) break;
      if (bytes + add > maxBytes && picked.length > 0) break;
      picked.push(row);
      items.push(item);
      bytes += add;
    }

    if (picked.length === 0) {
      await c.query('COMMIT');
      return null;
    }

    const body = serializeBatch(items);
    const sizeBytes = Buffer.byteLength(body);
    const created = (
      await c.query<{ id: string; correlation_id: string }>(
        `INSERT INTO batches (station_id, item_count, size_bytes, body_sha256) VALUES ($1, $2, $3, $4) RETURNING id, correlation_id`,
        [stationId, picked.length, sizeBytes, sha256(body)],
      )
    ).rows[0]!;
    const claimed = await c.query(
      `UPDATE emitted_readings e SET batch_id = $1, batch_position = v.pos
         FROM unnest($2::bigint[], $3::int[]) AS v(id, pos) WHERE e.id = v.id AND e.batch_id IS NULL`,
      [created.id, picked.map((r) => r.id), picked.map((_, i) => i)],
    );
    if (claimed.rowCount !== picked.length) {
      // The ledger re-chained some of these rows between our read and now (it does not take the station lock).
      // The body we built no longer describes the ledger: throw it away and build again from the new rows.
      await c.query('ROLLBACK');
      return 'ledger_moved';
    }
    await c.query('COMMIT');
    return {
      id: Number(created.id),
      correlationId: created.correlation_id,
      itemCount: picked.length,
      sizeBytes,
      body,
    };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
