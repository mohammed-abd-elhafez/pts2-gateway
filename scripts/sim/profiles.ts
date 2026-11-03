import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseChart } from './charts.js';
import type { TankProfile } from './model.js';

/**
 * The five tanks of the first real station (AL HMAIDAN), with its real calibration charts and the daily sales,
 * water readings and fill levels seen on 2026-11-03. `chartDir` holds `01CALIB.CSV` to `05CALIB.CSV`.
 */
export function hmaidanTanks(chartDir: string): TankProfile[] {
  const spec = [
    { probe: 1, soldPerDay: 2072, waterMm: 15.9, waterL: 33, startFraction: 0.52 },
    { probe: 2, soldPerDay: 542, waterMm: 15.7, waterL: 18, startFraction: 0.69 },
    { probe: 3, soldPerDay: 913, waterMm: 17.5, waterL: 21, startFraction: 0.3 },
    { probe: 4, soldPerDay: 856, waterMm: 17.8, waterL: 21, startFraction: 0.72 },
    { probe: 5, soldPerDay: 397, waterMm: 17.5, waterL: 21, startFraction: 0.31 },
  ];
  return spec.map((s) => ({
    ...s,
    chart: parseChart(readFileSync(join(chartDir, `0${s.probe}CALIB.CSV`), 'utf8')),
  }));
}
