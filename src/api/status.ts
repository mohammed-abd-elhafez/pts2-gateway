import type { Pool } from '../db/pool.js';

export interface TankStatus {
  tank_code: string | null;
  tank_number: number;
  active: boolean;
  /** ok, held (waits for a person), waiting_for_codes (no MoEnergy code yet) or inactive */
  state: 'ok' | 'held' | 'waiting_for_codes' | 'inactive';
  held_reason: string | null;
  /** readings stamped before this are never sent */
  go_live_at: Date | null;
  /** stored readings the ledger has not looked at yet */
  pending: number;
  /** chained, in no batch yet */
  ready: number;
  in_open_batch: number;
  /** in batches MoEnergy accepted */
  sent: number;
  last_reading_at: Date | null;
  last_ready_remaining_quantity: number | null;
  last_sent_at: Date | null;
  last_sent_remaining_quantity: number | null;
  /** readings that are not sent, by rule (clock_invalid, before_start, ...) */
  set_aside: Record<string, number>;
}

export interface StationStatus {
  station_code: string;
  moenergy_station_code: string | null;
  last_upload_at: Date | null;
  open_batch: { id: number; items: number; created_at: Date } | null;
  tanks: TankStatus[];
}

/** A read-only picture of one station: nothing here runs the ledger or changes a row. */
export async function stationStatus(pool: Pool, stationId: number): Promise<StationStatus | null> {
  const station = (
    await pool.query<{ operator_station_code: string; moenergy_station_code: string | null; last_seen_at: Date | null }>(
      `SELECT operator_station_code, moenergy_station_code, last_seen_at FROM stations WHERE id = $1`,
      [stationId],
    )
  ).rows[0];
  if (!station) return null;

  const open = (
    await pool.query<{ id: string; item_count: number; created_at: Date }>(
      `SELECT id, item_count, created_at FROM batches WHERE station_id = $1 AND status = 'open'`,
      [stationId],
    )
  ).rows[0];

  const { rows } = await pool.query<{
    id: string;
    tank_number: number;
    moenergy_tank_code: string | null;
    is_active: boolean;
    chain_held: boolean;
    held_reason: string | null;
    send_from: Date | null;
    pending: number;
    ready: number;
    in_open_batch: number;
    sent: number;
    last_reading_at: Date | null;
    ready_remaining: string | null;
    sent_at: Date | null;
    sent_remaining: string | null;
  }>(
    `SELECT t.id, t.tank_number, t.moenergy_tank_code, t.is_active, t.chain_held, t.held_reason, t.send_from,
            (SELECT count(*) FROM readings r WHERE r.tank_id = t.id AND r.ledger_status = 'pending')::int AS pending,
            (SELECT count(*) FROM emitted_readings e WHERE e.tank_id = t.id AND e.batch_id IS NULL)::int AS ready,
            (SELECT count(*) FROM emitted_readings e JOIN batches b ON b.id = e.batch_id WHERE e.tank_id = t.id AND b.status = 'open')::int AS in_open_batch,
            (SELECT count(*) FROM emitted_readings e JOIN batches b ON b.id = e.batch_id WHERE e.tank_id = t.id AND b.status = 'accepted')::int AS sent,
            (SELECT max(r.effective_at) FROM readings r WHERE r.tank_id = t.id) AS last_reading_at,
            (SELECT e.remaining_quantity FROM emitted_readings e WHERE e.tank_id = t.id ORDER BY e.seq DESC LIMIT 1) AS ready_remaining,
            (SELECT e.effective_at FROM emitted_readings e JOIN batches b ON b.id = e.batch_id WHERE e.tank_id = t.id AND b.status = 'accepted' ORDER BY e.seq DESC LIMIT 1) AS sent_at,
            (SELECT e.remaining_quantity FROM emitted_readings e JOIN batches b ON b.id = e.batch_id WHERE e.tank_id = t.id AND b.status = 'accepted' ORDER BY e.seq DESC LIMIT 1) AS sent_remaining
       FROM tanks t WHERE t.station_id = $1 ORDER BY t.tank_number`,
    [stationId],
  );

  const aside = await pool.query<{ tank_id: string; rule_code: string; n: number }>(
    `SELECT r.tank_id, q.rule_code, count(*)::int AS n
       FROM quarantine q JOIN readings r ON r.id = q.reading_id JOIN tanks t ON t.id = r.tank_id
      WHERE t.station_id = $1 GROUP BY r.tank_id, q.rule_code`,
    [stationId],
  );
  const asideBy = new Map<string, Record<string, number>>();
  for (const a of aside.rows) asideBy.set(a.tank_id, { ...(asideBy.get(a.tank_id) ?? {}), [a.rule_code]: a.n });

  return {
    station_code: station.operator_station_code,
    moenergy_station_code: station.moenergy_station_code,
    last_upload_at: station.last_seen_at,
    open_batch: open ? { id: Number(open.id), items: open.item_count, created_at: open.created_at } : null,
    tanks: rows.map((t) => ({
      tank_code: t.moenergy_tank_code,
      tank_number: t.tank_number,
      active: t.is_active,
      state: !t.is_active ? 'inactive' : t.moenergy_tank_code === null || station.moenergy_station_code === null ? 'waiting_for_codes' : t.chain_held ? 'held' : 'ok',
      held_reason: t.chain_held ? t.held_reason : null,
      go_live_at: t.send_from,
      pending: t.pending,
      ready: t.ready,
      in_open_batch: t.in_open_batch,
      sent: t.sent,
      last_reading_at: t.last_reading_at,
      last_ready_remaining_quantity: t.ready_remaining === null ? null : Number(t.ready_remaining),
      last_sent_at: t.sent_at,
      last_sent_remaining_quantity: t.sent_remaining === null ? null : Number(t.sent_remaining),
      set_aside: asideBy.get(t.id) ?? {},
    })),
  };
}
