import { randomBytes } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import { hashSecret } from '../ingest/auth.js';

/**
 * Loads stations and their tanks, with the codes MoEnergy generated for them, from a CSV file with one row per tank.
 * The whole file is applied in one transaction: a problem anywhere writes nothing. Loading the same file again changes
 * nothing; a file that disagrees with what is stored is refused unless `update` is set.
 */

/** MoEnergy's product ids (guide 2.11). */
export const PRODUCTS: Record<number, string> = { 1: 'Diesel', 91: 'Gasoline 91', 95: 'Gasoline 95', 98: 'Gasoline 98' };

export interface Problem {
  line: number;
  message: string;
}

export class StationsFileError extends Error {
  constructor(readonly problems: Problem[]) {
    super(`${problems.length} problem(s) in the stations file: ${problems.slice(0, 3).map((p) => `line ${p.line}: ${p.message}`).join('; ')}`);
  }
}

export interface LoadRow {
  line: number;
  stationCode: string;
  stationName: string;
  moenergyStationCode: string;
  utcOffsetMinutes: number;
  tankNumber: number;
  operatorTankCode: string;
  moenergyTankCode: string;
  productId: number;
  capacityLitres: string;
  totalHeightM: string;
  sendFrom: Date | null;
}

const REQUIRED = ['station_code', 'moenergy_station_code', 'tank_number', 'moenergy_tank_code', 'product_id', 'capacity_litres', 'total_height_m'];
const STATION_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MO_STATION = /^ST-\d{6,}$/;
const MO_TANK = /^ST-\d{6,}-\d+$/;
const QUANTITY = /^\d+(\.\d{1,3})?$/;
const WITH_OFFSET = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;

/** RFC 4180 enough for this file: quoted fields, doubled quotes, CRLF or LF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseStationsCsv(text: string): LoadRow[] {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length > 0) throw new StationsFileError([{ line: 1, message: `missing column(s): ${missing.join(', ')}` }]);

  const problems: Problem[] = [];
  const rows: LoadRow[] = [];
  const firstOfStation = new Map<string, LoadRow>();
  const stationOfMoCode = new Map<string, string>();
  const seenTank = new Set<string>();
  const seenMoTank = new Set<string>();
  const seenOperatorTank = new Set<string>();

  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!;
    if (cells.every((c) => c.trim() === '')) continue;
    const line = i + 1;
    const get = (name: string): string => (cells[header.indexOf(name)] ?? '').trim();
    const bad = (message: string) => problems.push({ line, message });
    const before = problems.length;

    const stationCode = get('station_code');
    if (!STATION_CODE.test(stationCode)) bad(`station_code "${stationCode}": use letters, digits, . _ - (up to 64, starting with a letter or digit)`);
    const moStation = get('moenergy_station_code');
    if (!MO_STATION.test(moStation)) bad(`moenergy_station_code "${moStation}": expected the form ST-000027`);
    const moTank = get('moenergy_tank_code');
    if (!MO_TANK.test(moTank) || (MO_STATION.test(moStation) && !moTank.startsWith(`${moStation}-`))) bad(`moenergy_tank_code "${moTank}": expected the station code, a dash and the tank number (ST-000027-1)`);
    const productId = Number(get('product_id'));
    if (!(productId in PRODUCTS)) bad(`product_id "${get('product_id')}": MoEnergy lists ${Object.keys(PRODUCTS).join(', ')}`);
    const capacity = get('capacity_litres');
    if (!QUANTITY.test(capacity) || Number(capacity) <= 0 || Number(capacity) > 10_000_000) bad(`capacity_litres "${capacity}": a number above 0 with at most 3 decimals`);
    const height = get('total_height_m');
    if (!QUANTITY.test(height) || Number(height) <= 0 || Number(height) > 100) bad(`total_height_m "${height}": metres, a number above 0 with at most 3 decimals`);
    const tankNumber = Number(get('tank_number'));
    if (!/^\d+$/.test(get('tank_number')) || tankNumber < 1) bad(`tank_number "${get('tank_number')}": a positive whole number (the probe number)`);
    const offsetText = get('utc_offset_minutes');
    const offset = offsetText === '' ? 180 : Number(offsetText);
    if (!Number.isInteger(offset) || offset < -840 || offset > 840) bad(`utc_offset_minutes "${offsetText}": minutes east of UTC, between -840 and 840`);
    const sendText = get('send_from');
    let sendFrom: Date | null = null;
    if (sendText !== '') {
      sendFrom = WITH_OFFSET.test(sendText) ? new Date(sendText) : null;
      if (!sendFrom || Number.isNaN(sendFrom.getTime())) {
        sendFrom = null;
        bad(`send_from "${sendText}": a date and time with a UTC offset, such as 2026-11-01T00:00:00+03:00`);
      }
    }
    const operatorTankCode = get('operator_tank_code') || `T${tankNumber}`;
    const name = get('station_name') || stationCode;

    if (problems.length === before) {
      const row: LoadRow = { line, stationCode, stationName: name, moenergyStationCode: moStation, utcOffsetMinutes: offset, tankNumber, operatorTankCode, moenergyTankCode: moTank, productId, capacityLitres: capacity, totalHeightM: height, sendFrom };
      const key = stationCode.toLowerCase();
      const first = firstOfStation.get(key);
      if (!first) firstOfStation.set(key, row);
      else if (first.moenergyStationCode !== moStation || first.utcOffsetMinutes !== offset || first.stationName !== name) {
        bad(`station ${stationCode} has different name, code or time zone than on line ${first.line}`);
      }
      const owner = stationOfMoCode.get(moStation);
      if (owner !== undefined && owner !== key) bad(`moenergy_station_code ${moStation} is also used for station ${owner}`);
      stationOfMoCode.set(moStation, key);
      if (seenTank.has(`${key}#${tankNumber}`)) bad(`tank ${tankNumber} of station ${stationCode} appears twice`);
      seenTank.add(`${key}#${tankNumber}`);
      if (seenMoTank.has(moTank)) bad(`moenergy_tank_code ${moTank} appears twice`);
      seenMoTank.add(moTank);
      if (problems.length === before && seenOperatorTank.has(`${key}#${operatorTankCode.toLowerCase()}`)) bad(`operator_tank_code ${operatorTankCode} appears twice in station ${stationCode}`);
      seenOperatorTank.add(`${key}#${operatorTankCode.toLowerCase()}`);
      if (problems.length === before) rows.push(row);
    }
  }
  if (problems.length > 0) throw new StationsFileError(problems);
  return rows;
}

export interface LoadOptions {
  /** go-live time of a new tank whose row gives none */
  sendFromDefault: Date;
  /** change what is stored when the file differs */
  update?: boolean;
  /** report what would happen and write nothing */
  dryRun?: boolean;
}

export interface LoadReport {
  stations: { code: string; moenergyCode: string; status: 'created' | 'existing' | 'updated'; secret?: string; uploadPath?: string }[];
  tanks: { created: number; existing: number; updated: number };
  dryRun: boolean;
}

interface StationRow {
  id: string;
  operator_station_code: string;
  name: string;
  moenergy_station_code: string | null;
  utc_offset_minutes: number;
}

interface TankRow {
  id: string;
  operator_tank_code: string;
  moenergy_tank_code: string | null;
  product_id: number | null;
  capacity_litres: string;
  total_height_m: string;
  send_from: Date | null;
}

export async function loadStations(pool: Pool, rows: LoadRow[], opts: LoadOptions): Promise<LoadReport> {
  const problems: Problem[] = [];
  const report: LoadReport = { stations: [], tanks: { created: 0, existing: 0, updated: 0 }, dryRun: opts.dryRun === true };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [id, name] of Object.entries(PRODUCTS)) {
      await client.query(`INSERT INTO ref_products (product_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [Number(id), name]);
    }

    const byStation = new Map<string, LoadRow[]>();
    for (const r of rows) byStation.set(r.stationCode.toLowerCase(), [...(byStation.get(r.stationCode.toLowerCase()) ?? []), r]);

    for (const list of byStation.values()) {
      const first = list[0]!;
      const stationProblems = (message: string) => problems.push({ line: first.line, message });
      const found = (
        await client.query<StationRow>(
          `SELECT id, operator_station_code, name, moenergy_station_code, utc_offset_minutes FROM stations WHERE lower(operator_station_code) = lower($1)`,
          [first.stationCode],
        )
      ).rows[0];
      const owner = (
        await client.query<{ operator_station_code: string }>(
          `SELECT operator_station_code FROM stations WHERE moenergy_station_code = $1 AND id <> $2`,
          [first.moenergyStationCode, found?.id ?? 0],
        )
      ).rows[0];
      if (owner) {
        stationProblems(`moenergy_station_code ${first.moenergyStationCode} already belongs to station ${owner.operator_station_code}`);
        continue;
      }

      let stationId: number;
      let status: 'created' | 'existing' | 'updated' = 'existing';
      let secret: string | undefined;
      if (!found) {
        secret = randomBytes(24).toString('base64url');
        const ins = await client.query<{ id: string }>(
          `INSERT INTO stations (name, operator_station_code, utc_offset_minutes, moenergy_station_code, registration_state, secret_hash)
           VALUES ($1, $2, $3, $4, 'registered', $5) RETURNING id`,
          [first.stationName, first.stationCode, first.utcOffsetMinutes, first.moenergyStationCode, hashSecret(secret)],
        );
        stationId = Number(ins.rows[0]!.id);
        status = 'created';
      } else {
        stationId = Number(found.id);
        const diffs: string[] = [];
        if (found.moenergy_station_code !== null && found.moenergy_station_code !== first.moenergyStationCode) diffs.push(`moenergy_station_code is ${found.moenergy_station_code} in the database and ${first.moenergyStationCode} in the file`);
        if (found.utc_offset_minutes !== first.utcOffsetMinutes) diffs.push(`utc_offset_minutes is ${found.utc_offset_minutes} in the database and ${first.utcOffsetMinutes} in the file`);
        if (found.name !== first.stationName) diffs.push(`station_name is "${found.name}" in the database and "${first.stationName}" in the file`);
        if (diffs.length > 0 && !opts.update) for (const d of diffs) stationProblems(`station ${first.stationCode}: ${d} (use update to change it)`);
        if ((diffs.length > 0 && opts.update) || found.moenergy_station_code === null) {
          await client.query(
            `UPDATE stations SET name = $2, utc_offset_minutes = $3, moenergy_station_code = $4, registration_state = 'registered' WHERE id = $1`,
            [stationId, first.stationName, first.utcOffsetMinutes, first.moenergyStationCode],
          );
          status = 'updated';
        }
      }
      report.stations.push({
        code: first.stationCode,
        moenergyCode: first.moenergyStationCode,
        status,
        ...(secret ? { secret, uploadPath: `/pts/${secret}` } : {}),
      });

      for (const r of list) {
        const tankProblem = (message: string) => problems.push({ line: r.line, message });
        const existing = (
          await client.query<TankRow>(
            `SELECT id, operator_tank_code, moenergy_tank_code, product_id, capacity_litres, total_height_m, send_from FROM tanks WHERE station_id = $1 AND tank_number = $2`,
            [stationId, r.tankNumber],
          )
        ).rows[0];
        const taken = (
          await client.query<{ tank_number: number; operator_station_code: string }>(
            `SELECT t.tank_number, s.operator_station_code FROM tanks t JOIN stations s ON s.id = t.station_id WHERE t.moenergy_tank_code = $1 AND t.id <> $2`,
            [r.moenergyTankCode, existing?.id ?? 0],
          )
        ).rows[0];
        if (taken) {
          tankProblem(`moenergy_tank_code ${r.moenergyTankCode} already belongs to tank ${taken.tank_number} of station ${taken.operator_station_code}`);
          continue;
        }
        if (!existing) {
          await client.query(
            `INSERT INTO tanks (station_id, tank_number, operator_tank_code, moenergy_tank_code, product_id, capacity_litres, total_height_m, send_from, registration_state)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'registered')`,
            [stationId, r.tankNumber, r.operatorTankCode, r.moenergyTankCode, r.productId, r.capacityLitres, r.totalHeightM, r.sendFrom ?? opts.sendFromDefault],
          );
          report.tanks.created++;
          continue;
        }
        const diffs: string[] = [];
        const num = (a: string, b: string) => Number(a) === Number(b);
        if (existing.moenergy_tank_code !== null && existing.moenergy_tank_code !== r.moenergyTankCode) diffs.push(`moenergy_tank_code is ${existing.moenergy_tank_code} in the database and ${r.moenergyTankCode} in the file`);
        if (existing.product_id !== null && existing.product_id !== r.productId) diffs.push(`product_id is ${existing.product_id} in the database and ${r.productId} in the file`);
        if (!num(existing.capacity_litres, r.capacityLitres)) diffs.push(`capacity_litres is ${Number(existing.capacity_litres)} in the database and ${Number(r.capacityLitres)} in the file`);
        if (!num(existing.total_height_m, r.totalHeightM)) diffs.push(`total_height_m is ${Number(existing.total_height_m)} in the database and ${Number(r.totalHeightM)} in the file`);
        if (r.sendFrom && (!existing.send_from || existing.send_from.getTime() !== r.sendFrom.getTime())) diffs.push(`send_from differs`);
        const unregistered = existing.moenergy_tank_code === null;
        if (diffs.length > 0 && !opts.update) {
          for (const d of diffs) tankProblem(`tank ${r.tankNumber} of station ${r.stationCode}: ${d} (use update to change it)`);
          continue;
        }
        if (diffs.length > 0 || unregistered) {
          await client.query(
            `UPDATE tanks SET moenergy_tank_code = $2, product_id = $3, capacity_litres = $4, total_height_m = $5, send_from = coalesce($6, send_from), registration_state = 'registered' WHERE id = $1`,
            [existing.id, r.moenergyTankCode, r.productId, r.capacityLitres, r.totalHeightM, r.sendFrom],
          );
          report.tanks.updated++;
        } else report.tanks.existing++;
      }
    }

    if (problems.length > 0) {
      await client.query('ROLLBACK');
      throw new StationsFileError(problems);
    }
    await client.query(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
    if (opts.dryRun) for (const s of report.stations) delete s.secret, delete s.uploadPath;
    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
