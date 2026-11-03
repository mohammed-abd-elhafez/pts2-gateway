import type { Pool } from '../db/pool.js';

export interface StationRef {
  id: number;
  operatorCode: string;
}

/** A station is addressed by the operator's own code, ignoring case. */
export async function findStationByOperatorCode(pool: Pool, code: string): Promise<StationRef | null> {
  // Codes are 1 to 64 printable characters; anything else cannot match and must not reach the database
  // (a NUL byte in a text parameter is an error there).
  if (code.length < 1 || code.length > 64 || /[\u0000-\u001f\u007f]/.test(code)) return null;
  const { rows } = await pool.query<{ id: string; operator_station_code: string }>(
    `SELECT id, operator_station_code FROM stations WHERE lower(operator_station_code) = lower($1)`,
    [code],
  );
  const row = rows[0];
  return row ? { id: Number(row.id), operatorCode: row.operator_station_code } : null;
}
