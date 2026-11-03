import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from '../../src/db/pool.js';

export async function seedRefs(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO ref_regions (id, name) VALUES (1, 'Riyadh'), (2, 'Makkah')`);
  await pool.query(`INSERT INTO ref_cities (id, region_id, name) VALUES (10, 1, 'Riyadh'), (20, 2, 'Jeddah')`);
  await pool.query(`INSERT INTO ref_products (product_id, name) VALUES (91, 'Gasoline 91'), (1, 'Diesel')`);
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function insertStation(
  pool: Pool,
  o: { code?: string; secret?: string; extra?: Record<string, unknown> } = {},
): Promise<{ id: number; secret: string }> {
  const secret = o.secret ?? randomBytes(16).toString('hex');
  const cols: Record<string, unknown> = {
    name: 'Station',
    operator_station_code: o.code ?? `OP-${randomBytes(3).toString('hex')}`,
    secret_hash: sha256(secret),
    ...o.extra,
  };
  const keys = Object.keys(cols);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO stations (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    keys.map((k) => cols[k]),
  );
  return { id: Number(rows[0]!.id), secret };
}

export async function insertTank(
  pool: Pool,
  stationId: number,
  o: { number?: number; capacity?: string; heightM?: string; extra?: Record<string, unknown> } = {},
): Promise<number> {
  const n = o.number ?? 1;
  const cols: Record<string, unknown> = {
    station_id: stationId,
    tank_number: n,
    operator_tank_code: `T${n}`,
    capacity_litres: o.capacity ?? '50000',
    total_height_m: o.heightM ?? '3.5',
    ...o.extra,
  };
  const keys = Object.keys(cols);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tanks (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    keys.map((k) => cols[k]),
  );
  return Number(rows[0]!.id);
}

export interface ReadingSeed {
  at: string;                 // ISO instant; used as device_time and effective_at
  fuel?: string | null;
  water?: string;
  fuelHeightMm?: string;
  waterHeightMm?: string;
  temperature?: string | null;
  delivery?: boolean;
  /** when the gateway stored it; fixed by default so settle-window tests are deterministic */
  createdAt?: string;
}

export async function insertReading(pool: Pool, tankId: number, r: ReadingSeed): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO readings (tank_id, device_time, effective_at, fuel_volume_l, water_volume_l,
                           fuel_height_mm, water_height_mm, delivery, temperature_c, created_at)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      tankId,
      r.at,
      r.fuel === undefined ? '1000' : r.fuel,
      r.water ?? '0.5',
      r.fuelHeightMm ?? '500',
      r.waterHeightMm ?? '10',
      r.delivery ?? false,
      r.temperature ?? null,
      r.createdAt ?? '2026-11-03T09:00:00Z',
    ],
  );
  return Number(rows[0]!.id);
}

/** Resolves to the Postgres error code of a rejected query. */
export async function pgCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_ERROR';
}

// ------------------------------------------------------------------ MoEnergy-coded stations and tanks

export const minuteAt = (m: number): string => new Date(Date.UTC(2026, 10, 3, 10, m)).toISOString();

export interface CodedStation { id: number; code: string; operatorCode: string }
export interface CodedTank { id: number; code: string; stationCode: string }

export async function seedCodedStation(pool: Pool, n = 1): Promise<CodedStation> {
  const code = `ST-${String(n).padStart(6, '0')}`;
  const operatorCode = `OP-${n}`;
  const { id } = await insertStation(pool, { code: operatorCode, extra: { moenergy_station_code: code } });
  return { id, code, operatorCode };
}

export async function seedCodedTank(pool: Pool, st: CodedStation, tankNo = 1, capacity = '50000'): Promise<CodedTank> {
  const code = `${st.code}-${tankNo}`;
  const id = await insertTank(pool, st.id, { number: tankNo, capacity, extra: { moenergy_tank_code: code } });
  return { id, code, stationCode: st.code };
}

/** Stores readings and runs them through the ledger, so emitted rows exist. */
export async function emitReadings(
  pool: Pool,
  tankId: number,
  items: Array<{ minute: number; fuel: string } & Partial<ReadingSeed>>,
  policy: 'allow' | 'hold' = 'allow',
): Promise<number[]> {
  const { processTank } = await import('../../src/ledger/service.js');
  const ids: number[] = [];
  for (const it of items) {
    const { minute, ...rest } = it;
    ids.push(await insertReading(pool, tankId, { at: minuteAt(minute), ...rest }));
  }
  await processTank(pool, tankId, { policy, now: () => new Date('2026-11-03T23:00:00Z') });
  return ids;
}
