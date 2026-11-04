import type { Pool } from '../db/pool.js';

export interface PruneOptions {
  /** keep uploads that arrived within this many days (at least 7) */
  days: number;
  /** rows deleted per statement, so a large backlog never holds one long lock */
  batchSize?: number;
  now?: () => Date;
}

/**
 * Deletes raw controller uploads older than the retention. A reading that came from one keeps its row (its upload
 * reference becomes empty): the raw bytes are kept for diagnosis, not as the record of the data. Returns the number deleted.
 */
export async function pruneRawUploads(pool: Pool, opts: PruneOptions): Promise<number> {
  if (!Number.isInteger(opts.days) || opts.days < 7) throw new Error('the retention must be a whole number of at least 7 days');
  const batch = opts.batchSize ?? 2000;
  if (!Number.isInteger(batch) || batch < 1) throw new Error('batchSize must be a positive whole number');
  const cutoff = new Date((opts.now?.() ?? new Date()).getTime() - opts.days * 86_400_000);
  let total = 0;
  for (;;) {
    const res = await pool.query(
      `DELETE FROM raw_uploads WHERE id IN (SELECT id FROM raw_uploads WHERE arrived_at < $1 ORDER BY arrived_at LIMIT $2)`,
      [cutoff, batch],
    );
    total += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < batch) return total;
  }
}
