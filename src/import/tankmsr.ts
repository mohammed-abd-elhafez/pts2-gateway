import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Pool } from '../db/pool.js';

/**
 * Reads a `TANKMSR.CSV` (the controller's own tank-record file, downloadable from its web page) into `readings`,
 * so the whole pipeline can run on real data before the controller uploads anything.
 *
 * Rules, each from what the first real file showed (docs/REAL_DATA_FINDINGS.md):
 *  - a row without a litre volume (no calibration chart yet) is of no use to MoEnergy and is left out;
 *  - a row stamped exactly 00:00:00 carries no real time (the clock was not set after a restart): it is kept for
 *    the record, in quarantine as `clock_invalid`, and never chained;
 *  - the same tank and second twice: the first stays; reading the same file twice adds nothing;
 *  - `since` leaves out older rows (litre values before 2026-10-04 do not match today's charts of tanks 1 to 3).
 */

export const TANKMSR_COLUMNS = [
  'DateTime', 'Probe', 'Status', 'Alarms', 'PHPresent', 'ProductHeight', 'WHPresent', 'WaterHeight', 'TPresent', 'Temperature',
  'PVPresent', 'ProductVolume', 'WVPresent', 'WaterVolume', 'UPresent', 'Ullage', 'PTCVPresent', 'ProductTCVolume',
  'DPresent', 'Density', 'MPresent', 'Mass', 'FPPresent', 'FillingPercentage',
] as const;

export class TankMsrFormatError extends Error {}

export interface TankMsrRow {
  /** line number in the file, the header being line 1 */
  line: number;
  probe: number;
  /** the stamped local time, as written */
  localTime: string;
  /** the UTC instant it stands for */
  at: Date;
  heightMm: number;
  waterMm: number;
  tempC: number | null;
  volumeL: number | null;
  waterL: number;
  ullageL: number | null;
  status: string;
  alarms: string[];
  clockInvalid: boolean;
  /** of the line as written: tells identical lines apart from different values */
  hash: string;
}

export interface LineError {
  line: number;
  message: string;
}

const NUMBER = /^[+-]?\d+(\.\d+)?$/;
const TIME = /^(\d\d)\.(\d\d)\.(\d\d) (\d\d):(\d\d):(\d\d)$/;

function localToUtc(text: string, offsetMinutes: number): Date | null {
  const m = TIME.exec(text);
  if (!m) return null;
  const [yy, mo, dd, hh, mi, ss] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(2000 + yy, mo - 1, dd, hh, mi, ss);
  const check = new Date(ms);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== dd || hh > 23 || mi > 59 || ss > 59) return null;
  return new Date(ms - offsetMinutes * 60_000);
}

export function parseTankMsr(text: string, utcOffsetMinutes: number): { rows: TankMsrRow[]; errors: LineError[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]!.trim() !== TANKMSR_COLUMNS.join(',')) throw new TankMsrFormatError('not a TANKMSR.CSV: the header line differs');

  const rows: TankMsrRow[] = [];
  const errors: LineError[] = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '') continue;
    const line = i + 1;
    const f = raw.split(',');
    if (f.length !== TANKMSR_COLUMNS.length) {
      errors.push({ line, message: `expected ${TANKMSR_COLUMNS.length} fields, found ${f.length}` });
      continue;
    }
    const at = localToUtc(f[0]!, utcOffsetMinutes);
    if (!at) {
      errors.push({ line, message: `bad time "${f[0]}"` });
      continue;
    }
    const value = (present: string, v: string): number | null | 'bad' => {
      if (present !== '1') return null;
      return NUMBER.test(v) ? Number(v) : 'bad';
    };
    const height = value(f[4]!, f[5]!);
    const water = value(f[6]!, f[7]!);
    const temp = value(f[8]!, f[9]!);
    const volume = value(f[10]!, f[11]!);
    const waterL = value(f[12]!, f[13]!);
    const ullage = value(f[14]!, f[15]!);
    if (!/^\d+$/.test(f[1]!) || [height, water, temp, volume, waterL, ullage].includes('bad')) {
      errors.push({ line, message: 'a field is not a number' });
      continue;
    }
    rows.push({
      line,
      probe: Number(f[1]),
      localTime: f[0]!,
      at,
      heightMm: (height as number | null) ?? 0,
      waterMm: (water as number | null) ?? 0,
      tempC: temp as number | null,
      volumeL: volume as number | null,
      waterL: (waterL as number | null) ?? 0,
      ullageL: ullage as number | null,
      status: f[2]!,
      alarms: f[3] === '00' ? [] : [f[3]!],
      clockInvalid: f[0]!.endsWith(' 00:00:00'),
      hash: createHash('sha256').update(raw).digest('hex'),
    });
  }
  return { rows, errors };
}

export interface ImportOptions {
  /** minutes east of UTC; default: the station's own setting */
  utcOffsetMinutes?: number;
  /** leave out rows stamped before this instant */
  since?: Date;
}

export interface ImportReport {
  /** data lines in the file */
  lines: number;
  errors: LineError[];
  /** rows without litres, left out */
  noVolume: number;
  beforeSince: number;
  /** probe numbers the station has no tank for */
  unknownProbes: number[];
  /** new readings stored, the clock_invalid ones included */
  inserted: number;
  /** of those, set aside as clock_invalid */
  clockInvalid: number;
  /** rows that were already there: the same file read again, or the same tank and second twice */
  duplicates: number;
  /** of those, normal rows: the same tank and second as a stored row */
  duplicateTime: number;
  /** of those, 00:00:00 rows: the same line as a stored one */
  duplicateClock: number;
}

const CHUNK = 2000;

async function insertChunk(c: PoolClient, rows: { tankId: number; row: TankMsrRow }[], clock: boolean): Promise<number[]> {
  if (rows.length === 0) return [];
  const col = <T>(f: (x: { tankId: number; row: TankMsrRow }) => T): T[] => rows.map(f);
  const target = clock
    ? `ON CONFLICT (tank_id, content_hash) WHERE device_time IS NULL DO NOTHING`
    : `ON CONFLICT (tank_id, device_time) WHERE device_time IS NOT NULL DO NOTHING`;
  const { rows: out } = await c.query<{ id: string }>(
    `INSERT INTO readings (tank_id, device_time, content_hash, effective_at, fuel_volume_l, water_volume_l, fuel_height_mm,
                           water_height_mm, ullage_l, temperature_c, probe_status, alarms, quality_flags, ledger_status)
     SELECT t, CASE WHEN $12 THEN NULL ELSE a END, CASE WHEN $12 THEN h END, a, v, wv, fh, wh, u, tc, st,
            CASE WHEN al = '' THEN '{}'::text[] ELSE string_to_array(al, ',') END,
            CASE WHEN $12 THEN ARRAY['clock_invalid'] ELSE '{}'::text[] END,
            CASE WHEN $12 THEN 'quarantined' ELSE 'pending' END
       FROM unnest($1::bigint[], $2::timestamptz[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[],
                   $8::numeric[], $9::numeric[], $10::text[], $11::text[]) AS x(t, a, h, v, wv, fh, wh, u, tc, st, al)
     ${target}
     RETURNING id`,
    [
      col((x) => x.tankId),
      col((x) => x.row.at),
      col((x) => x.row.hash),
      col((x) => x.row.volumeL),
      col((x) => x.row.waterL),
      col((x) => x.row.heightMm),
      col((x) => x.row.waterMm),
      col((x) => x.row.ullageL),
      col((x) => x.row.tempC),
      col((x) => x.row.status),
      col((x) => x.row.alarms.join(',')),
      clock,
    ],
  );
  return out.map((r) => Number(r.id));
}

export async function importTankMsr(pool: Pool, stationId: number, text: string, opts: ImportOptions = {}): Promise<ImportReport> {
  let offset = opts.utcOffsetMinutes;
  if (offset === undefined) {
    const { rows } = await pool.query<{ utc_offset_minutes: number }>(`SELECT utc_offset_minutes FROM stations WHERE id = $1`, [stationId]);
    if (!rows[0]) throw new Error(`station ${stationId} not found`);
    offset = rows[0].utc_offset_minutes;
  }
  const { rows, errors } = parseTankMsr(text, offset);
  const { rows: tankRows } = await pool.query<{ id: string; tank_number: number }>(`SELECT id, tank_number FROM tanks WHERE station_id = $1`, [stationId]);
  const tankByProbe = new Map(tankRows.map((t) => [t.tank_number, Number(t.id)]));

  const report: ImportReport = { lines: rows.length + errors.length, errors, noVolume: 0, beforeSince: 0, unknownProbes: [], inserted: 0, clockInvalid: 0, duplicates: 0, duplicateTime: 0, duplicateClock: 0 };
  const normal: { tankId: number; row: TankMsrRow }[] = [];
  const clock: { tankId: number; row: TankMsrRow }[] = [];
  const unknown = new Set<number>();
  for (const row of rows) {
    if (row.volumeL === null) report.noVolume++;
    else if (opts.since && row.at < opts.since) report.beforeSince++;
    else if (!tankByProbe.has(row.probe)) unknown.add(row.probe);
    else (row.clockInvalid ? clock : normal).push({ tankId: tankByProbe.get(row.probe)!, row });
  }
  report.unknownProbes = [...unknown].sort((a, b) => a - b);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let insertedNormal = 0;
    for (let i = 0; i < normal.length; i += CHUNK) insertedNormal += (await insertChunk(client, normal.slice(i, i + CHUNK), false)).length;
    report.inserted += insertedNormal;
    report.duplicateTime = normal.length - insertedNormal;
    for (let i = 0; i < clock.length; i += CHUNK) {
      const ids = await insertChunk(client, clock.slice(i, i + CHUNK), true);
      if (ids.length > 0) {
        await client.query(
          `INSERT INTO quarantine (reading_id, rule_code, detail)
           SELECT id, 'clock_invalid', 'stamped 00:00:00: the controller clock was not set' FROM unnest($1::bigint[]) AS id
           ON CONFLICT DO NOTHING`,
          [ids],
        );
      }
      report.inserted += ids.length;
      report.clockInvalid += ids.length;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  report.duplicateClock = clock.length - report.clockInvalid;
  report.duplicates = report.duplicateTime + report.duplicateClock;
  return report;
}
