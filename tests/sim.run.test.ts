import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { checkInvariants, runScenario } from '../scripts/sim/run.js';
import { resetDb, testPool } from './helpers/db.js';

const pool = testPool(10);
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

describe('runScenario: simulated stations through importer, ledger, batches and a strict MoEnergy', () => {
  it('a clean fortnight passes every invariant, refills included', async () => {
    const r = await runScenario(pool, { stations: 2, days: 14, seed: 1 });
    expect(r.violations).toEqual([]);
    expect(r.stats.storedAtMoEnergy).toBeGreaterThan(1000);
    expect(r.stats.refillsSeen).toBeGreaterThan(0);
    expect(r.stats.heldTanks).toBe(0);
  });

  it('the faults of the real data are all accounted for: set aside, never sent, nothing lost', async () => {
    const r = await runScenario(pool, {
      stations: 1,
      days: 12,
      seed: 3,
      faults: { clockInvalidBursts: 2, sameSecondPairs: 3, noiseRises: 4, probeGlitches: 2 },
    });
    expect(r.violations).toEqual([]);
    expect(r.stats.clockInvalidStored).toBeGreaterThan(0);
    expect(r.stats.skippedGlitches).toBe(2);
  });

  it('survives an outage of a few days and tanks without a chart at the start', async () => {
    const r = await runScenario(pool, { stations: 1, days: 12, seed: 5, outages: [{ startDay: 4, days: 3 }], noVolumeDays: 2 });
    expect(r.violations).toEqual([]);
  });

  it('when MoEnergy refuses negative consumed, a refilled tank is held once and the run ends', async () => {
    const r = await runScenario(pool, { stations: 1, days: 14, seed: 1, refuseNegative: true });
    expect(r.violations).toEqual([]);
    expect(r.stats.heldTanks).toBeGreaterThan(0);
    expect(r.stats.refusedByMoEnergy).toBeLessThanOrEqual(r.stats.heldTanks + 5);
  });

  it('gives the same numbers for the same seed', async () => {
    const a = await runScenario(pool, { stations: 1, days: 6, seed: 9 });
    await resetDb(pool);
    const b = await runScenario(pool, { stations: 1, days: 6, seed: 9 });
    expect({ ...a.stats, ms: 0 }).toEqual({ ...b.stats, ms: 0 });
  });

  it('the checker is not blind: a hole in the chain at MoEnergy is found', async () => {
    const r = await runScenario(pool, { stations: 1, days: 6, seed: 2 });
    expect(r.violations).toEqual([]);
    const code = [...r.ctx.fake.stored.keys()][0]!;
    r.ctx.fake.stored.get(code)!.splice(3, 1);
    const found = await checkInvariants(pool, r.ctx);
    expect(found.some((v) => v.includes('chain'))).toBe(true);
  });

  it('the checker is not blind: a reading stored at a time the data never had is found', async () => {
    const r = await runScenario(pool, { stations: 1, days: 6, seed: 2 });
    expect(r.violations).toEqual([]);
    const code = [...r.ctx.fake.stored.keys()][0]!;
    r.ctx.fake.stored.get(code)![2]!.reading_at = '2026-09-01T00:00:07Z';
    const found = await checkInvariants(pool, r.ctx);
    expect(found.some((v) => v.includes('time'))).toBe(true);
  });

  it('the checker is not blind: a clock_invalid reading that reached a batch is found', async () => {
    const r = await runScenario(pool, { stations: 1, days: 6, seed: 2, faults: { clockInvalidBursts: 1 } });
    expect(r.violations).toEqual([]);
    await pool.query(`UPDATE readings SET quality_flags = ARRAY['clock_invalid'] WHERE id = (SELECT reading_id FROM emitted_readings LIMIT 1)`);
    const found = await checkInvariants(pool, r.ctx);
    expect(found.some((v) => v.includes('clock_invalid'))).toBe(true);
  });
});
