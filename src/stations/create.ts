import { randomBytes } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import { hashSecret } from '../ingest/auth.js';

export interface NewStation {
  operatorStationCode: string;
  name: string;
  utcOffsetMinutes?: number;
}

/**
 * Registers a station and returns its upload secret. The secret is shown once;
 * only its SHA-256 hash is stored.
 */
export async function createStation(pool: Pool, s: NewStation): Promise<{ id: number; secret: string }> {
  const secret = randomBytes(24).toString('base64url');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO stations (name, operator_station_code, utc_offset_minutes, secret_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [s.name, s.operatorStationCode, s.utcOffsetMinutes ?? 180, hashSecret(secret)],
  );
  return { id: Number(rows[0]!.id), secret };
}
