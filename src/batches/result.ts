import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Pool } from '../db/pool.js';
import { unemitFrom } from '../ledger/unemit.js';
import { enterStation, loadBatchBody, lockStation } from './builder.js';

/** What the client posts: MoEnergy's HTTP status and response body, unchanged. */
export interface MoEnergyResult {
  status: number;
  body: unknown;
}

export type Action =
  | 'accepted'
  | 'accepted_assumed_resend'
  | 'tank_held_rebuilt'
  | 'item_quarantined_rebuilt'
  | 'resend_same_body'
  | 'fix_client_side'
  | 'needs_attention'
  | 'released';

export interface ResultOutcome {
  batch_id: number;
  batch_status: 'open' | 'accepted' | 'rejected';
  action: Action;
  detail?: string;
  held_tank?: string;
  quarantined_reading?: number;
}

/** JSON with object keys sorted at every level, so the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class BatchNotFoundError extends Error {}
export class BatchClosedError extends Error {}
/** The result names a different send (correlation id) than the batch it was posted to. */
export class CorrelationMismatchError extends Error {}

export interface ResultOptions {
  /** the correlation id the client says it sent to MoEnergy with this batch */
  correlationId?: string;
  /**
   * How many readings MoEnergy may refuse one by one, per station per window, before we stop setting
   * them aside. MoEnergy reports only the first bad item, so a systemic cause (a rule change, a wrong
   * code) would otherwise quarantine one good reading per round trip.
   */
  breakerLimit?: number;
  breakerWindowMs?: number;
}

export const DEFAULT_BREAKER_LIMIT = 5;
export const DEFAULT_BREAKER_WINDOW_MS = 3_600_000;

interface ParsedError {
  /** the property MoEnergy names in `message` ("item_index: 1 - field: fuel_quantity") */
  field: string | null;
  sourceErrorCode: string | null;
  itemIndex: number | null;
  sourceMessage: string;
}

/** MoEnergy's first reported error. item_index sits in `message` ("item_index: 1 - field: x"). */
function firstError(body: unknown): ParsedError | null {
  if (typeof body !== 'object' || body === null) return null;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const e = errors[0] as Record<string, unknown> | null;
  if (typeof e !== 'object' || e === null) return null;

  const message = typeof e.message === 'string' ? e.message : '';
  const fromMessage = /item_index:\s*(\d+)/.exec(message);
  const itemIndex =
    typeof e.item_index === 'number' && Number.isInteger(e.item_index) && e.item_index >= 0
      ? e.item_index
      : fromMessage
        ? Number(fromMessage[1])
        : null;
  const fromField = /field:\s*([A-Za-z_]+)/.exec(message);
  return {
    field: typeof e.field === 'string' ? e.field : fromField ? fromField[1]! : null,
    sourceErrorCode: typeof e.sourceErrorCode === 'string' ? e.sourceErrorCode : null,
    itemIndex,
    sourceMessage: typeof e.sourceMessage === 'string' ? e.sourceMessage : message,
  };
}

interface BatchRow {
  id: string;
  station_id: string;
  correlation_id: string;
  status: 'open' | 'accepted' | 'rejected';
  item_count: number;
  attention: boolean;
  result_digest: string | null;
  result_response: ResultOutcome | null;
}

interface ItemRow {
  reading_id: string;
  tank_id: string;
  seq: number;
  consumed_quantity: string;
  tank_code: string;
}

interface Decision {
  outcome: ResultOutcome;
  /** the code recorded on the batch when it closes */
  resultCode: string;
  itemIndex: number | null;
}

const open = (batchId: number, action: Action, detail?: string): Decision => ({
  outcome: { batch_id: batchId, batch_status: 'open', action, ...(detail ? { detail } : {}) },
  resultCode: '',
  itemIndex: null,
});

async function lockTank(c: PoolClient, tankId: string): Promise<void> {
  await c.query(`SELECT 1 FROM tanks WHERE id = $1 FOR NO KEY UPDATE`, [tankId]);
}

/** After a rejection nothing in the batch was stored by MoEnergy, so every item is unsent again. */
async function releaseItems(c: PoolClient, batchId: number): Promise<void> {
  await c.query(`UPDATE emitted_readings SET batch_id = NULL, batch_position = NULL WHERE batch_id = $1`, [batchId]);
}

async function holdTank(c: PoolClient, tankId: string, reason: 'chain_break' | 'moenergy_negative_rejection'): Promise<void> {
  await c.query(`UPDATE tanks SET chain_held = true, held_reason = $2, held_at = now() WHERE id = $1`, [tankId, reason]);
}

async function recentRejections(c: PoolClient, stationId: string, windowMs: number): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM quarantine q JOIN readings r ON r.id = q.reading_id JOIN tanks t ON t.id = r.tank_id
      WHERE t.station_id = $1 AND q.rule_code LIKE 'moenergy:%'
        AND q.created_at > now() - ($2::double precision * interval '1 millisecond')`,
    [stationId, windowMs],
  );
  return rows[0]!.n;
}

async function decide(c: PoolClient, batch: BatchRow, result: MoEnergyResult, opts: ResultOptions): Promise<Decision> {
  const batchId = Number(batch.id);
  const { status, body } = result;

  if (status === 200 || status === 201) {
    const count = (body as { accepted_count?: unknown } | null)?.accepted_count;
    if (count === batch.item_count) {
      return { outcome: { batch_id: batchId, batch_status: 'accepted', action: 'accepted' }, resultCode: String(status), itemIndex: null };
    }
    // MoEnergy may now hold only part of this batch. Remember that for the people who read the batch.
    await c.query(`UPDATE batches SET attention = true WHERE id = $1`, [batchId]);
    return open(batchId, 'needs_attention', `accepted_count ${String(count)} does not match the ${batch.item_count} items sent`);
  }

  if (status === 422) {
    const err = firstError(body);
    if (!err || err.itemIndex === null) return open(batchId, 'needs_attention', '422 without a readable item_index');

    // A stored duplicate at the very first item. It confirms that item and nothing more: an earlier send of
    // this batch may have persisted with its reply lost (guide FAQ), but the same answer comes when MoEnergy
    // holds only that reading (a backlog that overlaps what it has). The rest goes into the next batch, whose
    // first item answers the same question again, so nothing is ever marked stored without MoEnergy saying so.
    if (err.sourceErrorCode === 'DUPLICATE_READING_STORED' && err.itemIndex === 0) {
      const rest = batch.item_count - 1;
      if (rest > 0) {
        await c.query(
          `UPDATE emitted_readings SET batch_id = NULL, batch_position = NULL WHERE batch_id = $1 AND batch_position > 0`,
          [batchId],
        );
        const body = await loadBatchBody(c, batchId);
        await c.query(`UPDATE batches SET item_count = 1, size_bytes = $2, body_sha256 = $3 WHERE id = $1`, [
          batchId,
          Buffer.byteLength(body),
          createHash('sha256').update(body).digest('hex'),
        ]);
      }
      return {
        outcome: {
          batch_id: batchId,
          batch_status: 'accepted',
          action: 'accepted_assumed_resend',
          detail: rest > 0 ? `item 0 is stored at MoEnergy; the other ${rest} items go in the next batch` : 'the only item is stored at MoEnergy',
        },
        resultCode: 'DUPLICATE_READING_STORED',
        itemIndex: 0,
      };
    }

    const item = (
      await c.query<ItemRow>(
        `SELECT e.reading_id, e.tank_id, e.seq, e.consumed_quantity, t.moenergy_tank_code AS tank_code
           FROM emitted_readings e JOIN tanks t ON t.id = e.tank_id
          WHERE e.batch_id = $1 AND e.batch_position = $2`,
        [batchId, err.itemIndex],
      )
    ).rows[0];
    if (!item) return open(batchId, 'needs_attention', `item_index ${err.itemIndex} is outside the batch`);

    const code = err.sourceErrorCode ?? 'UNKNOWN';

    // MoEnergy already holds a reading we are about to send (a duplicate in the middle of the batch),
    // or holds a different last value than we do: either way our picture of this tank is wrong, and
    // nothing we hold for it can be trusted until a person says what MoEnergy has.
    if (code === 'REMAINING_QUANTITY_INCONSISTENT' || code === 'DUPLICATE_READING_STORED') {
      await lockTank(c, item.tank_id);
      await releaseItems(c, batchId);
      await unemitFrom(c, Number(item.tank_id), 1);
      if (code === 'DUPLICATE_READING_STORED') {
        // MoEnergy says it holds this very reading: never send it again, so that an anchor can get past it.
        await c.query(`UPDATE readings SET ledger_status = 'skipped' WHERE id = $1`, [item.reading_id]);
        await c.query(
          `INSERT INTO quarantine (reading_id, rule_code, detail) VALUES ($1, 'already_at_moenergy', $2) ON CONFLICT DO NOTHING`,
          [item.reading_id, err.sourceMessage],
        );
      }
      await holdTank(c, item.tank_id, 'chain_break');
      return {
        outcome: { batch_id: batchId, batch_status: 'rejected', action: 'tank_held_rebuilt', held_tank: item.tank_code, detail: err.sourceMessage },
        resultCode: code,
        itemIndex: err.itemIndex,
      };
    }

    // One bad item. If MoEnergy has been refusing readings one by one for a while, something systemic is
    // wrong and quarantining more good readings would only make it worse: stop and ask for a person.
    const limit = opts.breakerLimit ?? DEFAULT_BREAKER_LIMIT;
    if ((await recentRejections(c, batch.station_id, opts.breakerWindowMs ?? DEFAULT_BREAKER_WINDOW_MS)) >= limit) {
      return open(
        batchId,
        'needs_attention',
        `MoEnergy refused ${limit} readings of this station within the hour; not setting more aside: ${code}`,
      );
    }

    // Set it aside, and let the tank's later readings be chained again without it.
    await lockTank(c, item.tank_id);
    await releaseItems(c, batchId);
    await unemitFrom(c, Number(item.tank_id), item.seq);
    await c.query(`UPDATE readings SET ledger_status = 'quarantined' WHERE id = $1`, [item.reading_id]);
    await c.query(
      `INSERT INTO quarantine (reading_id, rule_code, detail) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [item.reading_id, `moenergy:${code}`, err.sourceMessage],
    );
    // A refill rejected as negative consumed would repeat for every reading after it: stop the tank.
    // Only a refusal that names a quantity of the chain counts as MoEnergy refusing a refill; a refused height or
    // temperature on a refill reading is an ordinary bad item and must not stop the tank or teach it anything.
    const quantityField = err.field === null || err.field === 'consumed_quantity' || err.field === 'remaining_quantity';
    const heldTank = parseFloat(item.consumed_quantity) < 0 && quantityField;
    if (heldTank) {
      await holdTank(c, item.tank_id, 'moenergy_negative_rejection');
      // From now on this tank holds negative readings itself instead of sending each one to be refused.
      await c.query(`UPDATE tanks SET negative_refused_at = now() WHERE id = $1`, [item.tank_id]);
    }
    return {
      outcome: {
        batch_id: batchId,
        batch_status: 'rejected',
        action: 'item_quarantined_rebuilt',
        quarantined_reading: Number(item.reading_id),
        ...(heldTank ? { held_tank: item.tank_code } : {}),
        detail: err.sourceMessage,
      },
      resultCode: code,
      itemIndex: err.itemIndex,
    };
  }

  if (status === 409 || status === 429 || status >= 500) return open(batchId, 'resend_same_body');
  if (status === 401 || status === 403 || status === 413) return open(batchId, 'fix_client_side', `MoEnergy answered ${status}`);
  return open(batchId, 'needs_attention', `unexpected status ${status}`);
}

/** Keeps what MoEnergy said, as received. A body the database cannot store as JSON is recorded without it. */
/** MoEnergy's answers are small. A longer body is not kept, and a batch keeps only so many attempts after its first. */
const MAX_STORED_BODY_BYTES = 65_536;
const MAX_ATTEMPTS_KEPT = 20;

async function recordResult(c: PoolClient, batchId: number, result: MoEnergyResult, action: string, replayed: boolean): Promise<void> {
  const first = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM batch_results WHERE batch_id = $1`, [batchId])).rows[0]!.n;
  if (first >= MAX_ATTEMPTS_KEPT && (replayed || action === 'refused_batch_closed')) return;
  const insert = (bodyJson: string | null) =>
    c.query(
      `INSERT INTO batch_results (batch_id, status_code, body, action, replayed) VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [batchId, result.status, bodyJson, action, replayed],
    );
  await c.query('SAVEPOINT audit');
  try {
    // A replay carries the body of the answer already kept for this batch.
    const text = replayed ? null : JSON.stringify(result.body ?? null);
    await insert(text !== null && Buffer.byteLength(text) > MAX_STORED_BODY_BYTES ? null : text);
  } catch {
    await c.query('ROLLBACK TO SAVEPOINT audit');
    await insert(null);
  }
  await c.query('RELEASE SAVEPOINT audit');
}

/**
 * Applies MoEnergy's answer to a station's open batch. A batch id that belongs to another station
 * is reported as not found. Posting the same answer again returns the same outcome without acting
 * twice; a different answer for a closed batch is refused. Every answer posted is kept in batch_results.
 */
export async function applyResult(
  pool: Pool,
  stationId: number,
  batchId: number,
  result: MoEnergyResult,
  opts: ResultOptions = {},
): Promise<{ outcome: ResultOutcome; replayed: boolean }> {
  // Keys in another order are the same answer: hash a canonical form.
  const digest = createHash('sha256').update(canonicalJson({ status: result.status, body: result.body ?? null })).digest('hex');

  const leave = await enterStation(stationId);
  const c = await pool.connect().catch((err) => {
    leave();
    throw err;
  });
  try {
    await c.query('BEGIN');
    await lockStation(c, stationId);

    const batch = (
      await c.query<BatchRow>(
        `SELECT id, station_id, correlation_id, status, item_count, attention, result_digest, result_response
           FROM batches WHERE id = $1 AND station_id = $2 FOR UPDATE`,
        [batchId, stationId],
      )
    ).rows[0];
    if (!batch) throw new BatchNotFoundError(`batch ${batchId} not found`);

    if (opts.correlationId !== undefined && opts.correlationId !== batch.correlation_id) {
      throw new CorrelationMismatchError(`batch ${batchId} was not sent with correlation id ${opts.correlationId}`);
    }

    if (batch.status !== 'open') {
      if (batch.result_digest === digest && batch.result_response) {
        await recordResult(c, batchId, result, batch.result_response.action, true);
        await c.query('COMMIT');
        return { outcome: batch.result_response, replayed: true };
      }
      // The attempt is kept even though it is refused: a different answer for a closed batch is worth knowing about.
      await recordResult(c, batchId, result, 'refused_batch_closed', false);
      await c.query('COMMIT');
      throw new BatchClosedError(`batch ${batchId} is already ${batch.status}`);
    }

    const decision = await decide(c, batch, result, opts);
    await recordResult(c, batchId, result, decision.outcome.action, false);
    if (decision.outcome.batch_status !== 'open') {
      await c.query(
        `UPDATE batches SET status = $2, closed_at = now(), moenergy_result_code = $3, item_index = $4,
                result_digest = $5, result_response = $6::jsonb
          WHERE id = $1`,
        [batchId, decision.outcome.batch_status, decision.resultCode, decision.itemIndex, digest, JSON.stringify(decision.outcome)],
      );
    }
    await c.query('COMMIT');
    return { outcome: decision.outcome, replayed: false };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
    leave();
  }
}

/**
 * Lets the client give up on an open batch it cannot resolve (an answer that needs attention again and again).
 * Nothing is assumed about MoEnergy: every item becomes unsent again and goes into the next batch. If MoEnergy
 * did store some of them, the next batch's first item comes back as a stored duplicate and is confirmed on its
 * own, so releasing is always safe. Asking twice returns the same outcome.
 */
export async function releaseBatch(
  pool: Pool,
  stationId: number,
  batchId: number,
  reason: string,
): Promise<{ outcome: ResultOutcome; replayed: boolean }> {
  const leave = await enterStation(stationId);
  const c = await pool.connect().catch((err) => {
    leave();
    throw err;
  });
  try {
    await c.query('BEGIN');
    await lockStation(c, stationId);
    const batch = (
      await c.query<BatchRow>(
        `SELECT id, station_id, correlation_id, status, item_count, attention, result_digest, result_response
           FROM batches WHERE id = $1 AND station_id = $2 FOR UPDATE`,
        [batchId, stationId],
      )
    ).rows[0];
    if (!batch) throw new BatchNotFoundError(`batch ${batchId} not found`);

    if (batch.status !== 'open') {
      if (batch.result_response?.action === 'released') {
        await c.query('COMMIT');
        return { outcome: batch.result_response, replayed: true };
      }
      throw new BatchClosedError(`batch ${batchId} is already ${batch.status}`);
    }

    await releaseItems(c, batchId);
    const outcome: ResultOutcome = { batch_id: batchId, batch_status: 'rejected', action: 'released', detail: reason };
    await recordResult(c, batchId, { status: 0, body: { released: true, reason } }, 'released', false);
    await c.query(
      `UPDATE batches SET status = 'rejected', closed_at = now(), moenergy_result_code = 'RELEASED', result_digest = $2, result_response = $3::jsonb
        WHERE id = $1`,
      [batchId, createHash('sha256').update(`released:${reason}`).digest('hex'), JSON.stringify(outcome)],
    );
    await c.query('COMMIT');
    return { outcome, replayed: false };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
    leave();
  }
}
