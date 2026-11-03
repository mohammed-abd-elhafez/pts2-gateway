import type { PoolClient } from 'pg';

/**
 * Takes a tank's unsent emitted readings from `minSeq` onwards back out of the ledger and returns
 * them to pending, so the ledger rebuilds the chain from the last reading that stays. Readings in
 * an accepted batch are never touched: only rows with no batch qualify. The caller holds the tank lock.
 */
export async function unemitFrom(c: PoolClient, tankId: number, minSeq: number): Promise<number[]> {
  const { rows } = await c.query<{ id: string }>(
    `WITH gone AS (
       DELETE FROM emitted_readings
        WHERE tank_id = $1 AND batch_id IS NULL AND seq >= $2
        RETURNING reading_id
     )
     UPDATE readings SET ledger_status = 'pending'
      WHERE id IN (SELECT reading_id FROM gone)
      RETURNING id`,
    [tankId, minSeq],
  );
  return rows.map((r) => Number(r.id));
}
