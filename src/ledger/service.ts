import type { PoolClient } from 'pg';
import type { Pool } from '../db/pool.js';
import { step, type NegativePolicy, type TankState } from '../domain/ledger.js';
import { milliToDecimalString, mmToMetersMilli, parseMilli, QuantityError, roundMilli, type Milli } from '../domain/quantity.js';
import type { MeasuredReading, TankLimits } from '../domain/rules.js';
import { DEFAULT_SETTLE_MS } from '../domain/settle.js';
import { unemitFrom } from './unemit.js';

export interface ProcessOptions {
  policy: NegativePolicy;
  now: () => Date;
  /** most readings handled per call; call again for a bigger backlog */
  limit?: number;
  /** how long a reading must have been stored before it is chained (default 2 minutes) */
  settleMs?: number;
  /** decimals of the litre volumes; the measurement is rounded once, so fuel = previous remaining stays exact (default 2) */
  decimals?: 2 | 3;
}

export interface ProcessResult {
  emitted: number;
  quarantined: number;
  /** valid readings the chain cannot carry (see the 'skip' result in domain/ledger.ts) */
  skipped: number;
  held: boolean;
}

interface ReadingRow {
  id: string;
  effective_at: Date;
  created_at: Date;
  fuel_volume_l: string | null;
  water_volume_l: string;
  fuel_height_mm: string;
  water_height_mm: string;
  temperature_c: string | null;
  delivery: boolean;
}

/** MoEnergy's times are whole seconds, so two readings in one second would collide there. */
const floorToSecond = (d: Date): Date => new Date(Math.floor(d.getTime() / 1000) * 1000);

async function inTransaction<T>(pool: Pool, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await work(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Locks the tank row: the one place where two writers on the same tank are made to take turns. */
async function lockTank(c: PoolClient, tankId: number) {
  const { rows } = await c.query<{
    capacity_litres: string;
    total_height_m: string;
    chain_held: boolean;
    held_reason: string | null;
    negative_refused_at: Date | null;
    send_from: Date | null;
  }>(
    `SELECT capacity_litres, total_height_m, chain_held, held_reason, negative_refused_at, send_from FROM tanks WHERE id = $1 FOR NO KEY UPDATE`,
    [tankId],
  );
  const row = rows[0];
  if (!row) throw new Error(`tank ${tankId} not found`);
  return row;
}

async function lastEmitted(c: PoolClient, tankId: number) {
  const { rows } = await c.query<{ seq: number; effective_at: Date; remaining_quantity: string }>(
    `SELECT seq, effective_at, remaining_quantity FROM emitted_readings WHERE tank_id = $1 ORDER BY seq DESC LIMIT 1`,
    [tankId],
  );
  return rows[0] ?? null;
}

async function loadState(c: PoolClient, tankId: number, held: boolean, notBefore: Date | null): Promise<{ state: TankState; seq: number }> {
  const last = await lastEmitted(c, tankId);
  const anchorRow = (
    await c.query<{ remaining_quantity: string; after_seq: number; as_of: Date | null; accept_negative: boolean }>(
      `SELECT remaining_quantity, after_seq, as_of, accept_negative FROM chain_anchors WHERE tank_id = $1 ORDER BY id DESC LIMIT 1`,
      [tankId],
    )
  ).rows[0];

  // An anchor counts only while nothing has been emitted since it was set.
  const anchored = anchorRow && anchorRow.after_seq === (last?.seq ?? 0);
  const lastAt = last ? last.effective_at : null;
  const asOf = anchored ? anchorRow.as_of : null;
  return {
    state: {
      lastRemaining: anchored ? parseMilli(anchorRow.remaining_quantity) : last ? parseMilli(last.remaining_quantity) : null,
      lastEffectiveAt: asOf && (!lastAt || asOf.getTime() > lastAt.getTime()) ? asOf : lastAt,
      held,
      notBefore,
      ...(anchored && anchorRow.accept_negative ? { acceptNegativeOnce: true } : {}),
    },
    seq: last?.seq ?? 0,
  };
}

/** The tank's pending readings in time order, as far as they have settled: the first one that has not stops the list. */
async function loadSettled(c: PoolClient, tankId: number, limit: number, cutoff: Date): Promise<ReadingRow[]> {
  const { rows } = await c.query<ReadingRow>(
    `SELECT id, effective_at, created_at, fuel_volume_l, water_volume_l, fuel_height_mm, water_height_mm, temperature_c, delivery
       FROM readings WHERE tank_id = $1 AND ledger_status = 'pending'
      ORDER BY effective_at, id LIMIT $2`,
    [tankId, limit],
  );
  const settled: ReadingRow[] = [];
  for (const row of rows) {
    if (row.created_at.getTime() > cutoff.getTime()) break;
    settled.push(row);
  }
  return settled;
}

/**
 * Moves one tank's pending readings, oldest first, through the ledger: each becomes the next
 * emitted link of the chain, is set aside in quarantine, or stops the tank (hold policy).
 * Safe to call from several processes at once: they take turns on the tank row.
 *
 * - A reading is chained only after the settle window, so a replayed backlog can still fill in
 *   behind newer readings. A reading that is still older than something already emitted is re-chained
 *   into place when everything after it is unsent; if MoEnergy may already hold later readings, it is
 *   set aside as late.
 * - A tank held under the hold policy is released when the deployment now allows negative consumed
 *   quantities. A tank held for any other reason waits for an anchor.
 */
export async function processTank(pool: Pool, tankId: number, opts: ProcessOptions): Promise<ProcessResult> {
  const now = opts.now();
  const cutoff = new Date(now.getTime() - (opts.settleMs ?? DEFAULT_SETTLE_MS));
  const limit = opts.limit ?? 10_000;
  const decimals = opts.decimals ?? 2;

  return inTransaction(pool, async (c) => {
    const tankRow = await lockTank(c, tankId);
    const tank: TankLimits = {
      capacity: parseMilli(tankRow.capacity_litres),
      totalHeightM: parseMilli(tankRow.total_height_m),
    };

    // A tank whose negative readings MoEnergy has refused holds them whatever the deployment setting says.
    const policy: NegativePolicy = tankRow.negative_refused_at ? 'hold' : opts.policy;
    let held = tankRow.chain_held;
    if (held && policy === 'allow' && tankRow.held_reason === 'negative_consumed') {
      await c.query(`UPDATE tanks SET chain_held = false, held_reason = NULL, held_at = NULL WHERE id = $1`, [tankId]);
      held = false;
    }
    if (held) return { emitted: 0, quarantined: 0, skipped: 0, held: true };

    let { state, seq } = await loadState(c, tankId, false, tankRow.send_from);
    let pending = await loadSettled(c, tankId, limit, cutoff);

    // Settled readings older than something already emitted: take the unsent tail back and chain again in order.
    // Only what MoEnergy may already hold is out of reach, so the cut is the newest SENT row, not the first late
    // reading: a reading that is too late must not stop a later one, which can still go in front of the unsent tail.
    if (pending.length > 0 && state.lastEffectiveAt) {
      const lastAt = state.lastEffectiveAt.getTime();
      const sentUntil = (
        await c.query<{ at: Date | null }>(
          `SELECT max(effective_at) AS at FROM emitted_readings WHERE tank_id = $1 AND batch_id IS NOT NULL`,
          [tankId],
        )
      ).rows[0]!.at;
      const fit = pending.find((r) => {
        const t = floorToSecond(r.effective_at).getTime();
        return t < lastAt && (sentUntil === null || t > sentUntil.getTime());
      });
      if (fit) {
        const tail = (
          await c.query<{ first_seq: number | null }>(
            `SELECT min(seq) AS first_seq FROM emitted_readings WHERE tank_id = $1 AND effective_at > $2`,
            [tankId, floorToSecond(fit.effective_at)],
          )
        ).rows[0]!;
        if (tail.first_seq !== null) {
          await unemitFrom(c, tankId, tail.first_seq);
          ({ state, seq } = await loadState(c, tankId, false, tankRow.send_from));
          pending = await loadSettled(c, tankId, limit, cutoff);
        }
      }
    }

    const out: ProcessResult = { emitted: 0, quarantined: 0, skipped: 0, held: false };
    const emits: EmitRow[] = [];

    // At most EMISSION_WINDOW emitted-but-unsent readings per tank, so that putting a tank's unsent tail back
    // (a refusal by MoEnergy, a late reading) never has to rebuild more than that. The rest stays pending.
    const unsent = (
      await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM emitted_readings WHERE tank_id = $1 AND batch_id IS NULL`, [tankId])
    ).rows[0]!.n;
    const room = Math.max(0, EMISSION_WINDOW - unsent);

    for (const row of pending) {
      if (out.emitted >= room) break;
      const effectiveAt = floorToSecond(row.effective_at);
      let measured: MeasuredReading;
      try {
        measured = {
          fuelVolume: row.fuel_volume_l === null ? null : roundMilli(parseMilli(row.fuel_volume_l), decimals),
          waterVolume: roundMilli(parseMilli(row.water_volume_l), decimals),
          fuelHeightM: mmToMetersMilli(row.fuel_height_mm),
          waterHeightM: mmToMetersMilli(row.water_height_mm),
          temperatureC: row.temperature_c === null ? null : Number(row.temperature_c),
          effectiveAt,
        };
      } catch (err) {
        if (!(err instanceof QuantityError)) throw err;
        // The column holds more digits than a quantity we can send. Set it aside instead of failing the tank forever.
        await c.query(`INSERT INTO quarantine (reading_id, rule_code, detail) VALUES ($1, 'value_out_of_range', $2) ON CONFLICT DO NOTHING`, [
          row.id,
          err.message,
        ]);
        await c.query(`UPDATE readings SET ledger_status = 'quarantined' WHERE id = $1`, [row.id]);
        out.quarantined += 1;
        continue;
      }
      const result = step(state, { measured, delivery: row.delivery }, tank, policy, now);

      if (result.kind === 'emit') {
        seq += 1;
        // Written in bulk after the loop: one round trip per reading is what made a replay slow.
        emits.push({
          seq,
          readingId: row.id,
          effectiveAt,
          fuel: milliToDecimalString(result.chain.fuel),
          consumed: milliToDecimalString(result.chain.consumed),
          remaining: milliToDecimalString(result.chain.remaining),
          temperature: result.temperature,
          flags: result.flags,
        });
        out.emitted += 1;
      } else if (result.kind === 'quarantine') {
        if (result.violations.length === 0) {
          await c.query(
            `INSERT INTO quarantine (reading_id, rule_code, detail) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [row.id, result.rule, `effective ${row.effective_at.toISOString()} is not after the last emitted reading or the anchor's as_of`],
          );
        }
        for (const v of result.violations) {
          await c.query(
            `INSERT INTO quarantine (reading_id, rule_code, detail) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [row.id, v.rule, v.detail],
          );
        }
        await c.query(`UPDATE readings SET ledger_status = 'quarantined', quality_flags = $2 WHERE id = $1`, [
          row.id,
          result.flags,
        ]);
        out.quarantined += 1;
      } else if (result.kind === 'skip') {
        await c.query(
          `INSERT INTO quarantine (reading_id, rule_code, detail) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [row.id, result.rule, result.detail],
        );
        await c.query(`UPDATE readings SET ledger_status = 'skipped' WHERE id = $1`, [row.id]);
        out.skipped += 1;
      } else {
        // hold: the reading stays pending until the tank is released
        if (result.reason === 'negative_consumed') {
          await c.query(
            `UPDATE tanks SET chain_held = true, held_reason = 'negative_consumed', held_at = now() WHERE id = $1`,
            [tankId],
          );
        }
        out.held = true;
        break;
      }
      state = result.state;
    }

    if (emits.length > 0) {
      await c.query(
        `INSERT INTO emitted_readings
           (tank_id, seq, reading_id, effective_at, fuel_quantity, consumed_quantity, remaining_quantity, temperature_c, flags)
         SELECT $1, v.seq, v.reading_id, v.effective_at, v.fuel, v.consumed, v.remaining, v.temperature, string_to_array(v.flags, ',')
           FROM unnest($2::int[], $3::bigint[], $4::timestamptz[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::text[])
                AS v(seq, reading_id, effective_at, fuel, consumed, remaining, temperature, flags)`,
        [
          tankId,
          emits.map((e) => e.seq),
          emits.map((e) => e.readingId),
          emits.map((e) => e.effectiveAt),
          emits.map((e) => e.fuel),
          emits.map((e) => e.consumed),
          emits.map((e) => e.remaining),
          emits.map((e) => e.temperature),
          emits.map((e) => e.flags.join(',')),
        ],
      );
      await c.query(`UPDATE readings SET ledger_status = 'emitted' WHERE id = ANY($1::bigint[])`, [emits.map((e) => e.readingId)]);
    }
    return out;
  });
}

interface EmitRow {
  seq: number;
  readingId: string;
  effectiveAt: Date;
  fuel: string;
  consumed: string;
  remaining: string;
  temperature: number | null;
  flags: string[];
}

/** Most emitted-but-unsent readings kept per tank; see processTank. Equal to the batch builder's per-tank read. */
export const EMISSION_WINDOW = 2000;

export class UnsentReadingsError extends Error {}

export interface AnchorOptions {
  /**
   * Refuse while the tank still has emitted readings that MoEnergy has not accepted. They were
   * chained from the old value, so they would sit in front of the anchor and break the chain.
   */
  requireNoUnsent?: boolean;
  /** when MoEnergy held this value: readings at or before this time are already there and are set aside */
  asOf?: Date;
  /**
   * Let the next reading pass as a refill even under the hold policy. Default: yes when the tank is held
   * for a negative consumed quantity under the deployment's hold policy (the person has now looked at it),
   * no after MoEnergy itself refused one. Passing true also clears that refusal.
   */
  acceptNegative?: boolean;
}

/**
 * Records what MoEnergy holds as the tank's remaining quantity and lifts a hold. The next reading
 * chains from this value. Append-only: the previous anchors stay as the audit trail.
 */
export async function setAnchor(
  pool: Pool,
  tankId: number,
  remaining: Milli,
  reason: string,
  by: string,
  opts: AnchorOptions = {},
): Promise<void> {
  if (remaining < 0) throw new Error('anchor must not be negative');
  await inTransaction(pool, async (c) => {
    const tankRow = await lockTank(c, tankId);
    if (opts.requireNoUnsent) {
      const unsent = await c.query(
        `SELECT 1 FROM emitted_readings e
          WHERE e.tank_id = $1
            AND (e.batch_id IS NULL OR e.batch_id IN (SELECT id FROM batches WHERE status = 'open'))
          LIMIT 1`,
        [tankId],
      );
      if (unsent.rowCount) throw new UnsentReadingsError(`tank ${tankId} still has readings MoEnergy has not accepted`);
    }
    const last = await lastEmitted(c, tankId);
    const acceptNegative =
      opts.acceptNegative ?? (tankRow.chain_held && tankRow.held_reason === 'negative_consumed' && !tankRow.negative_refused_at);
    await c.query(
      `INSERT INTO chain_anchors (tank_id, remaining_quantity, after_seq, reason, set_by, as_of, accept_negative)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tankId, milliToDecimalString(remaining), last?.seq ?? 0, reason, by, opts.asOf ?? null, acceptNegative],
    );
    await c.query(
      `UPDATE tanks SET chain_held = false, held_reason = NULL, held_at = NULL,
              negative_refused_at = CASE WHEN $2 THEN NULL ELSE negative_refused_at END
        WHERE id = $1`,
      [tankId, opts.acceptNegative === true],
    );
  });
}
