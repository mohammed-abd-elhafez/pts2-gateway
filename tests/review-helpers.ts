import { getOrCreateNextBatch, type BuiltBatch } from '../src/batches/builder.js';
import { applyResult, type ResultOutcome } from '../src/batches/result.js';
import type { Pool } from '../src/db/pool.js';
import { runLedgerOnce } from '../src/ledger/worker.js';

export const LEDGER = { policy: 'allow' as const, now: () => new Date('2026-11-03T23:00:00Z') };
export const OPTS = { now: () => new Date('2026-11-03T23:00:00Z') };

interface Item {
  tank_code: string;
  fuel_quantity: number;
  consumed_quantity: number;
  remaining_quantity: number;
  reading_at: string;
}

export const moenergyError = (index: number, code: string, field = 'fuel_quantity') => ({
  errors: [{ code: 'x', message: `item_index: ${index} - field: ${field}`, sourceErrorCode: code, sourceMessage: code }],
});

/**
 * The smallest MoEnergy the docs describe: a batch is all-or-nothing, a reading_at already stored for
 * the tank is DUPLICATE_READING_STORED, and fuel_quantity must match the last stored remaining.
 */
export class FakeMoEnergy {
  readonly stored = new Map<string, Item[]>();
  refuseNegative = false;

  seed(tank: string, at: string, remaining: number): void {
    const list = this.stored.get(tank) ?? [];
    this.stored.set(tank, [
      ...list,
      { tank_code: tank, fuel_quantity: remaining, consumed_quantity: 0, remaining_quantity: remaining, reading_at: at },
    ]);
  }

  last(tank: string): Item | undefined {
    return this.stored.get(tank)?.at(-1);
  }

  /** true when the tank's stored readings form one unbroken chain */
  chainIsWhole(tank: string): boolean {
    const list = this.stored.get(tank) ?? [];
    return list.every((r, i) => i === 0 || Math.abs(r.fuel_quantity - list[i - 1]!.remaining_quantity) <= 0.001);
  }

  send(body: string): { status: number; body: unknown } {
    const items = (JSON.parse(body) as { readings: Item[] }).readings;
    const view = new Map([...this.stored].map(([k, v]) => [k, [...v]]));
    for (const [i, item] of items.entries()) {
      const list = view.get(item.tank_code) ?? [];
      if (list.some((r) => r.reading_at === item.reading_at)) return { status: 422, body: moenergyError(i, 'DUPLICATE_READING_STORED') };
      const prev = list.at(-1);
      if (prev && Math.abs(item.fuel_quantity - prev.remaining_quantity) > 0.001) {
        return { status: 422, body: moenergyError(i, 'REMAINING_QUANTITY_INCONSISTENT') };
      }
      if (this.refuseNegative && item.consumed_quantity < 0) return { status: 422, body: moenergyError(i, 'NEGATIVE_CONSUMED', 'consumed_quantity') };
      view.set(item.tank_code, [...list, item]);
    }
    for (const [k, v] of view) this.stored.set(k, v);
    return { status: 200, body: { status: 'accepted', accepted_count: items.length } };
  }
}

/** One round of the documented flow: fetch, forward unchanged, report. */
export async function cycle(
  pool: Pool,
  stationId: number,
  fake: FakeMoEnergy,
  policy: 'allow' | 'hold' = 'allow',
): Promise<{ batch: BuiltBatch | null; outcome: ResultOutcome | null }> {
  await runLedgerOnce(pool, { ...LEDGER, policy }, { stationId });
  const batch = await getOrCreateNextBatch(pool, stationId, OPTS);
  if (!batch) return { batch: null, outcome: null };
  const answer = fake.send(batch.body);
  const { outcome } = await applyResult(pool, stationId, batch.id, answer);
  return { batch, outcome };
}

/** Readings our ledger says MoEnergy has (accepted batches). */
export async function ledgerAccepted(pool: Pool, tankId: number): Promise<string[]> {
  const { rows } = await pool.query<{ at: Date }>(
    `SELECT e.effective_at AS at FROM emitted_readings e JOIN batches b ON b.id = e.batch_id
      WHERE e.tank_id = $1 AND b.status = 'accepted' ORDER BY e.seq`,
    [tankId],
  );
  return rows.map((r) => r.at.toISOString().replace('.000Z', 'Z'));
}
