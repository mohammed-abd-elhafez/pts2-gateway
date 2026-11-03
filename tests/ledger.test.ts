import { describe, expect, it } from 'vitest';
import { anchor, emptyState, step, type LedgerInput, type NegativePolicy, type TankState } from '../src/domain/ledger.js';
import { parseMilli as L } from '../src/domain/quantity.js';
import type { MeasuredReading, TankLimits } from '../src/domain/rules.js';

const tank: TankLimits = { capacity: L('50000'), totalHeightM: L('3.5') };
const now = new Date('2026-11-03T12:00:00Z');
const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 10, minute));

const input = (volume: string | null, minute: number, o: Partial<MeasuredReading> = {}, delivery = false): LedgerInput => ({
  measured: {
    fuelVolume: volume === null ? null : L(volume),
    waterVolume: L('0.5'),
    fuelHeightM: L('1.8'),
    waterHeightM: L('0.015'),
    temperatureC: 28.5,
    effectiveAt: at(minute),
    ...o,
  },
  delivery,
});

function run(inputs: LedgerInput[], policy: NegativePolicy = 'allow', from: TankState = emptyState) {
  let state = from;
  return inputs.map((i) => {
    const r = step(state, i, tank, policy, now);
    state = r.state;
    return r;
  });
}

describe('step', () => {
  it('starts a chain from the first measurement with nothing consumed', () => {
    const [r] = run([input('31790', 0)]);
    expect(r).toMatchObject({ kind: 'emit', chain: { fuel: 31_790_000, consumed: 0, remaining: 31_790_000 } });
  });

  it('chains each reading from the previous remaining', () => {
    const [, second, third] = run([input('31790', 0), input('31776', 1), input('31700.5', 2)]);
    expect(second).toMatchObject({ kind: 'emit', chain: { fuel: 31_790_000, consumed: 14_000, remaining: 31_776_000 } });
    expect(third).toMatchObject({ kind: 'emit', chain: { fuel: 31_776_000, consumed: 75_500, remaining: 31_700_500 } });
  });

  it('skips a measurement at or below the water volume and chains the next one from the last real value (F1)', () => {
    const [a, low, empty, refill] = run([
      input('1000', 0, { waterVolume: L('10') }),
      input('5', 1, { waterVolume: L('10') }),
      input('0', 2, { waterVolume: L('0') }),
      input('5000', 3, { waterVolume: L('10') }),
    ]);
    expect(a!.kind).toBe('emit');
    expect(low).toMatchObject({ kind: 'skip', rule: 'remaining_not_above_water' });
    expect(empty).toMatchObject({ kind: 'skip', rule: 'remaining_not_above_water' });
    expect(refill).toMatchObject({ kind: 'emit', chain: { fuel: 1_000_000, consumed: -4_000_000, remaining: 5_000_000 } });
    if (low!.kind === 'skip') expect(low!.state).toEqual(a!.state);
  });

  it('keeps the chain intact across a quarantined reading', () => {
    const [a, bad, c] = run([input('1000', 0), input('99999', 1), input('990', 2)]);
    expect(a!.kind).toBe('emit');
    expect(bad).toMatchObject({ kind: 'quarantine', rule: 'volume_above_capacity' });
    expect(bad!.state).toEqual(a!.state);
    expect(c).toMatchObject({ kind: 'emit', chain: { fuel: 1_000_000, consumed: 10_000, remaining: 990_000 } });
  });

  it('quarantines a reading without a litre volume', () => {
    const [r] = run([input(null, 0)]);
    expect(r).toMatchObject({ kind: 'quarantine', rule: 'volume_missing' });
  });

  it('quarantines a reading at or before the last emitted time as late_arrival', () => {
    const [, same, older] = run([input('1000', 5), input('900', 5), input('900', 2)]);
    expect(same).toMatchObject({ kind: 'quarantine', rule: 'late_arrival' });
    expect(older).toMatchObject({ kind: 'quarantine', rule: 'late_arrival' });
  });

  it('under allow, emits a refill with negative consumed and marks it', () => {
    const [, refill] = run([input('1000', 0), input('20000', 1, {}, true)], 'allow');
    expect(refill).toMatchObject({
      kind: 'emit',
      chain: { fuel: 1_000_000, consumed: -19_000_000, remaining: 20_000_000 },
      flags: ['negative_consumed', 'delivery'],
    });
  });

  it('under allow, a small negative value without a delivery flag is noise but still emitted', () => {
    const [, noise] = run([input('1000', 0), input('1000.002', 1)], 'allow');
    expect(noise).toMatchObject({ kind: 'emit', chain: { consumed: -2 }, flags: ['negative_consumed'] });
  });

  it('under hold, stops at negative consumed and keeps the chain where it was', () => {
    const [a, refill, next] = run([input('1000', 0), input('20000', 1, {}, true), input('19990', 2)], 'hold');
    expect(refill).toMatchObject({ kind: 'hold', reason: 'negative_consumed' });
    expect(refill!.state).toEqual({ ...a!.state, held: true });
    expect(next).toMatchObject({ kind: 'hold', reason: 'tank_held' });
  });

  it('resumes from the anchor after a hold', () => {
    const [, refill] = run([input('1000', 0), input('20000', 1)], 'hold');
    const resumed = anchor(refill!.state, L('19995'));
    expect(resumed.held).toBe(false);
    const [r] = run([input('19990', 2)], 'hold', resumed);
    expect(r).toMatchObject({ kind: 'emit', chain: { fuel: 19_995_000, consumed: 5000, remaining: 19_990_000 } });
  });

  it('rejects an anchor above capacity through the next reading', () => {
    const [r] = run([input('1000', 1)], 'allow', anchor({ ...emptyState, lastEffectiveAt: at(0) }, L('60000')));
    expect(r).toMatchObject({ kind: 'quarantine', rule: 'volume_above_capacity' });
  });

  it('first reading of an empty tank is quarantined (water must stay below fuel)', () => {
    const [r] = run([input('0', 0, { waterVolume: L('0') })]);
    expect(r).toMatchObject({ kind: 'quarantine', rule: 'water_not_below_fuel', flags: ['tank_empty'] });
  });

  it('carries a dropped temperature flag onto the emitted reading', () => {
    const [r] = run([input('1000', 0, { temperatureC: 250 })]);
    expect(r).toMatchObject({ kind: 'emit', temperature: null, flags: ['temperature_dropped'] });
  });
});
