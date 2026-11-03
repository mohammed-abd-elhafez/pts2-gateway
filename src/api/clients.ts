import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from '../db/pool.js';

export interface ApiClient {
  id: number;
  name: string;
  /** the one station this key may use, or null for every station */
  stationId: number | null;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The key is shown once; only its SHA-256 hash is stored. A key chosen by the operator (a demo deployment) can be given. */
export async function createClient(
  pool: Pool,
  name: string,
  opts: { stationId?: number; key?: string } = {},
): Promise<{ id: number; key: string }> {
  if (opts.key !== undefined && opts.key.length < 24) throw new Error('an API key must be at least 24 characters');
  const key = opts.key ?? `pts2_${randomBytes(24).toString('base64url')}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO api_clients (name, key_hash, station_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, hashKey(key), opts.stationId ?? null],
  );
  return { id: Number(rows[0]!.id), key };
}

export async function findClientByKey(pool: Pool, key: string): Promise<ApiClient | null> {
  const { rows } = await pool.query<{ id: string; name: string; station_id: string | null }>(
    `SELECT id, name, station_id FROM api_clients WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashKey(key)],
  );
  const row = rows[0];
  return row
    ? { id: Number(row.id), name: row.name, stationId: row.station_id === null ? null : Number(row.station_id) }
    : null;
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}
