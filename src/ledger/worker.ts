import type { Pool } from '../db/pool.js';
import { processTank, type ProcessOptions } from './service.js';

export interface LedgerRunResult {
  emitted: number;
  quarantined: number;
  skipped: number;
  heldTanks: number;
  /** tanks whose processing failed; the others were still processed */
  failedTanks: number;
}

/** Runs the ledger once for every tank that has pending readings, optionally for one station only. */
export async function runLedgerOnce(
  pool: Pool,
  opts: ProcessOptions,
  filter: { stationId?: number; onError?: (tankId: number, err: unknown) => void } = {},
): Promise<LedgerRunResult> {
  const { rows } = await pool.query<{ tank_id: string }>(
    `SELECT DISTINCT r.tank_id
       FROM readings r JOIN tanks t ON t.id = r.tank_id
      WHERE r.ledger_status = 'pending' AND ($1::bigint IS NULL OR t.station_id = $1)
      ORDER BY r.tank_id`,
    [filter.stationId ?? null],
  );
  const total: LedgerRunResult = { emitted: 0, quarantined: 0, skipped: 0, heldTanks: 0, failedTanks: 0 };
  for (const row of rows) {
    // One tank that cannot be processed must not stop the others, nor the station's open batch.
    try {
      const r = await processTank(pool, Number(row.tank_id), opts);
      total.emitted += r.emitted;
      total.quarantined += r.quarantined;
      total.skipped += r.skipped;
      if (r.held) total.heldTanks += 1;
    } catch (err) {
      total.failedTanks += 1;
      filter.onError?.(Number(row.tank_id), err);
    }
  }
  return total;
}
