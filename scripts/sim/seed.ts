/**
 * Creates simulated stations in a database: stations with MoEnergy-style codes, the five tanks of the first real station, and their
 * generated records imported through the same importer a real TANKMSR.CSV goes through.
 */
import type { Pool } from '../../src/db/pool.js';
import { importTankMsr, type ImportReport } from '../../src/import/tankmsr.js';
import { capacityL } from './charts.js';
import { tankMsrCsv } from './csv.js';
import type { FakeTank } from './fake-moenergy.js';
import { generateStation, type Faults, type SimTruth } from './model.js';
import { hmaidanTanks } from './profiles.js';

export const PRODUCTS = [91, 1, 1, 95, 95];
export const TOTAL_HEIGHT_MM = [2750, 2750, 2750, 2750, 3000];

export async function seedReference(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO ref_regions (id, name) VALUES (1, 'Region') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO ref_products (product_id, name) VALUES (91, 'Gasoline 91'), (95, 'Gasoline 95'), (1, 'Diesel') ON CONFLICT DO NOTHING`);
}

export interface StationCtx {
  id: number;
  code: string;
  offsetMinutes: number;
  truth: SimTruth;
  report: ImportReport;
  csv: string;
  csvDataLines: number;
  /** the UTC seconds of every record the generator stamped with a real time, as MoEnergy would write them */
  instants: Set<string>;
  tankCodes: string[];
}

export interface SeedOptions {
  stations: number;
  days: number;
  seed: number;
  /** local date of the first simulated day, YYYY-MM-DD */
  startDate: string;
  chartDir: string;
  faults?: Faults;
  outages?: { startDay: number; days: number }[];
  noVolumeDays?: number;
  refillEveryDays?: number;
  since?: Date;
}

export async function seedStations(
  pool: Pool,
  o: SeedOptions,
): Promise<{ stations: StationCtx[]; fakeTanks: FakeTank[]; generated: number }> {
  const profiles = hmaidanTanks(o.chartDir);
  await seedReference(pool);
  const fakeTanks: FakeTank[] = [];
  const stations: StationCtx[] = [];
  let generated = 0;
  for (let i = 0; i < o.stations; i++) {
    const code = `SIM-${String(i + 1).padStart(3, '0')}`;
    const moCode = `ST-${String(i + 1).padStart(6, '0')}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO stations (name, operator_station_code, secret_hash, moenergy_station_code) VALUES ($1, $2, md5($2), $3) RETURNING id`,
      [`Simulated ${i + 1}`, code, moCode],
    );
    const id = Number(rows[0]!.id);
    for (const [k, p] of profiles.entries()) {
      const tankCode = `${moCode}-${p.probe}`;
      await pool.query(
        `INSERT INTO tanks (station_id, tank_number, operator_tank_code, capacity_litres, total_height_m, moenergy_tank_code, product_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, p.probe, `T${p.probe}`, capacityL(p.chart), TOTAL_HEIGHT_MM[k]! / 1000, tankCode, PRODUCTS[k]],
      );
      fakeTanks.push({ stationCode: moCode, tankCode, capacityL: capacityL(p.chart), totalHeightM: TOTAL_HEIGHT_MM[k]! / 1000 });
    }
    const { records, truth } = generateStation({
      seed: o.seed * 1000 + i,
      startDate: o.startDate,
      days: o.days,
      tanks: profiles,
      faults: o.faults,
      outages: o.outages,
      noVolumeDays: o.noVolumeDays,
      refillEveryDays: o.refillEveryDays,
    });
    generated += records.length;
    const csv = tankMsrCsv(records, Object.fromEntries(profiles.map((p, k) => [p.probe, TOTAL_HEIGHT_MM[k]!])));
    const report = await importTankMsr(pool, id, csv, { since: o.since });
    const instants = new Set(
      records.filter((r) => r.kind === 'normal' || r.kind === 'noise_rise').map((r) => r.at.toISOString().replace('.000Z', 'Z')),
    );
    stations.push({
      id,
      code,
      offsetMinutes: 180,
      truth,
      report,
      csv,
      csvDataLines: records.length,
      instants,
      tankCodes: profiles.map((p) => `${moCode}-${p.probe}`),
    });
  }
  return { stations, fakeTanks, generated };
}
