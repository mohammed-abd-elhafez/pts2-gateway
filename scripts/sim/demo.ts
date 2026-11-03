/**
 * A demo deployment: a few simulated stations with a week of readings and one client key the operator chose, so the client API can be
 * tried by hand (curl, Postman) on a fresh server. Does nothing when the demo stations already exist.
 */
import { createClient } from '../../src/api/clients.js';
import type { Pool } from '../../src/db/pool.js';
import { seedStations } from './seed.js';

export interface DemoOptions {
  stations?: number;
  days?: number;
  seed?: number;
  /** local date of the first day; default: `days` days before today */
  startDate?: string;
  apiKey: string;
  chartDir?: string;
}

export async function seedDemo(pool: Pool, o: DemoOptions): Promise<{ seeded: boolean; stations: string[]; readings: number }> {
  if (o.apiKey.length < 24) throw new Error('the demo API key must be at least 24 characters');
  const existing = await pool.query(`SELECT 1 FROM stations WHERE operator_station_code = 'SIM-001'`);
  if (existing.rowCount) return { seeded: false, stations: [], readings: 0 };

  const days = o.days ?? 7;
  const startDate = o.startDate ?? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { stations } = await seedStations(pool, {
    stations: o.stations ?? 3,
    days,
    seed: o.seed ?? 1,
    startDate,
    chartDir: o.chartDir ?? `${process.cwd()}/scripts/sim/data`,
  });
  // readings wait two minutes after they are stored before they are chained; a person who tries the API at once should get a batch
  await pool.query(`UPDATE readings SET created_at = now() - interval '1 hour'`);
  await createClient(pool, 'demo client', { key: o.apiKey });
  return { seeded: true, stations: stations.map((s) => s.code), readings: stations.reduce((n, s) => n + s.report.inserted, 0) };
}
