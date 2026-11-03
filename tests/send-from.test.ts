import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyState, step } from '../src/domain/ledger.js';
import { parseMilli as L } from '../src/domain/quantity.js';
import type { MeasuredReading, TankLimits } from '../src/domain/rules.js';
import { processTank } from '../src/ledger/service.js';
import { resetDb, testPool } from './helpers/db.js';
import { insertReading, insertStation, insertTank, seedRefs } from './helpers/fixtures.js';

const tank: TankLimits = { capacity: L('50000'), totalHeightM: L('3.5') };
const now = new Date('2026-11-03T12:00:00Z');
const at = (m: number) => new Date(Date.UTC(2026, 10, 3, 10, m));
const measured = (volume: string, minute: number): MeasuredReading => ({
  fuelVolume: L(volume),
  waterVolume: L('0.5'),
  fuelHeightM: L('1.8'),
  waterHeightM: L('0.015'),
  temperatureC: 28.5,
  effectiveAt: at(minute),
});

describe('step with a go-live time (notBefore)', () => {
  const state = { ...emptyState, notBefore: at(5) };

  it('skips a reading before it and leaves the chain where it was', () => {
    const r = step(state, { measured: measured('900', 4), delivery: false }, tank, 'allow', now);
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') {
      expect(r.rule).toBe('before_start');
      expect(r.state).toBe(state);
    }
  });

  it('chains a reading exactly at it, as the start of the chain', () => {
    const r = step(state, { measured: measured('900', 5), delivery: false }, tank, 'allow', now);
    expect(r.kind).toBe('emit');
    if (r.kind === 'emit') expect(r.chain).toEqual({ fuel: L('900'), consumed: L('0'), remaining: L('900') });
  });

  it('skips a reading before it even when the tank is held: it could never be sent', () => {
    const r = step({ ...state, held: true }, { measured: measured('900', 1), delivery: false }, tank, 'allow', now);
    expect(r.kind).toBe('skip');
  });
});

describe('processTank with tanks.send_from', () => {
  const pool = testPool(6);
  const opts = { policy: 'allow' as const, now: () => new Date('2026-11-03T23:00:00Z') };
  let stationId: number;

  beforeEach(async () => {
    await resetDb(pool);
    await seedRefs(pool);
    stationId = (await insertStation(pool)).id;
  });
  afterAll(() => pool.end());

  const emitted = async (tankId: number) =>
    (await pool.query(`SELECT fuel_quantity::float AS fuel, consumed_quantity::float AS consumed, remaining_quantity::float AS remaining FROM emitted_readings WHERE tank_id = $1 ORDER BY seq`, [tankId])).rows;

  it('does not send a controller backlog older than the go-live time, and says why', async () => {
    const t = await insertTank(pool, stationId, { extra: { send_from: at(5).toISOString() } });
    for (const [m, v] of [[0, '1000'], [4, '990'], [5, '980'], [10, '970']] as const) await insertReading(pool, t, { at: at(m).toISOString(), fuel: v });
    const r = await processTank(pool, t, opts);
    expect(r).toMatchObject({ emitted: 2, skipped: 2, quarantined: 0 });
    expect(await emitted(t)).toEqual([
      { fuel: 980, consumed: 0, remaining: 980 },
      { fuel: 980, consumed: 10, remaining: 970 },
    ]);
    const q = await pool.query(`SELECT rule_code FROM quarantine q JOIN readings r ON r.id = q.reading_id WHERE r.tank_id = $1`, [t]);
    expect(q.rows).toEqual([{ rule_code: 'before_start' }, { rule_code: 'before_start' }]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM readings WHERE tank_id = $1 AND ledger_status = 'skipped'`, [t])).rows[0].n).toBe(2);
  });

  it('keeps sending everything for a tank that has no go-live time', async () => {
    const t = await insertTank(pool, stationId);
    for (const [m, v] of [[0, '1000'], [4, '990']] as const) await insertReading(pool, t, { at: at(m).toISOString(), fuel: v });
    expect(await processTank(pool, t, opts)).toMatchObject({ emitted: 2, skipped: 0 });
  });

  it('applies to a backlog that arrives in two uploads', async () => {
    const t = await insertTank(pool, stationId, { extra: { send_from: at(5).toISOString() } });
    await insertReading(pool, t, { at: at(1).toISOString(), fuel: '1000' });
    await processTank(pool, t, opts);
    await insertReading(pool, t, { at: at(6).toISOString(), fuel: '990' });
    await insertReading(pool, t, { at: at(2).toISOString(), fuel: '995' });
    await processTank(pool, t, opts);
    expect(await emitted(t)).toEqual([{ fuel: 990, consumed: 0, remaining: 990 }]);
  });
});
