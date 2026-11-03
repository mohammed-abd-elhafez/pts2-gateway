import { describe, expect, it } from 'vitest';
import { milli, parseMilli } from '../src/domain/quantity.js';
import { validateReading, type ChainValues, type MeasuredReading, type TankLimits } from '../src/domain/rules.js';

const L = parseMilli;
const now = new Date('2026-11-03T12:00:00Z');
const tank: TankLimits = { capacity: L('50000'), totalHeightM: L('3.5') };

const reading = (o: Partial<MeasuredReading> = {}): MeasuredReading => ({
  fuelVolume: L('30000'),
  waterVolume: L('0.5'),
  fuelHeightM: L('1.878'),
  waterHeightM: L('0.016'),
  temperatureC: 28.5,
  effectiveAt: new Date('2026-11-03T11:59:00Z'),
  ...o,
});
const chain = (o: Partial<ChainValues> = {}): ChainValues => ({
  fuel: L('30010'),
  consumed: L('10'),
  remaining: L('30000'),
  ...o,
});

const rules = (r: MeasuredReading, c: ChainValues = chain(), t: TankLimits = tank) =>
  validateReading(r, t, c, now).violations.map((v) => v.rule);

describe('validateReading', () => {
  it('passes the guide-shaped sample reading', () => {
    const res = validateReading(reading(), tank, chain(), now);
    expect(res.violations).toEqual([]);
    expect(res.temperature).toBe(28.5);
    expect(res.flags).toEqual([]);
  });

  it('volume_missing: no litre volume, and nothing else is checked', () => {
    expect(rules(reading({ fuelVolume: null, waterVolume: L('999999') }))).toEqual(['volume_missing']);
  });

  it('volume_above_capacity: measured volume over capacity', () => {
    expect(rules(reading({ fuelVolume: L('50000.001') }), chain({ fuel: L('49000'), consumed: L('-1000.001'), remaining: L('50000.001') }))).toContain(
      'volume_above_capacity',
    );
    expect(rules(reading({ fuelVolume: L('50000') }), chain({ fuel: L('49000'), consumed: L('-1000'), remaining: L('50000') }))).toEqual([]);
  });

  it('volume_above_capacity: an anchor above capacity is caught through the chained fuel_quantity', () => {
    expect(rules(reading(), chain({ fuel: L('60000'), consumed: L('30000'), remaining: L('30000') }))).toEqual([
      'volume_above_capacity',
    ]);
  });

  it('consumed_above_fuel: consumed larger than the fuel it comes from', () => {
    expect(rules(reading(), chain({ fuel: L('10'), consumed: L('20'), remaining: L('-10') }))).toEqual(['consumed_above_fuel']);
  });

  it('consumed_above_fuel: a negative measured volume on a first reading', () => {
    const c = chain({ fuel: L('-5'), consumed: milli(0), remaining: L('-5') });
    expect(rules(reading({ fuelVolume: L('-5'), waterVolume: L('-6') }), c)).toContain('consumed_above_fuel');
  });

  it('water_not_below_fuel: water equal to or above fuel fails, strictly', () => {
    expect(rules(reading({ waterVolume: L('30010') }))).toEqual(['water_not_below_fuel']);
    expect(rules(reading({ waterVolume: L('30009.999') }))).toEqual([]);
  });

  it('water_not_below_fuel: compares against the chained fuel, not the measured volume', () => {
    // measured 100 L, chained fuel 30010 L: water 5000 L is below the chained fuel
    expect(rules(reading({ fuelVolume: L('100'), waterVolume: L('5000') }), chain({ fuel: L('30010'), consumed: L('29910'), remaining: L('100') }))).toEqual([]);
  });

  it('water_not_below_fuel: an empty tank (0 and 0) fails and is flagged tank_empty', () => {
    const c = chain({ fuel: milli(0), consumed: milli(0), remaining: milli(0) });
    const res = validateReading(reading({ fuelVolume: milli(0), waterVolume: milli(0) }), tank, c, now);
    expect(res.violations.map((v) => v.rule)).toEqual(['water_not_below_fuel']);
    expect(res.flags).toContain('tank_empty');
  });

  it('fuel_height_above_total: height over the tank height fails, equal passes', () => {
    expect(rules(reading({ fuelHeightM: L('3.501') }))).toEqual(['fuel_height_above_total']);
    expect(rules(reading({ fuelHeightM: L('3.5') }))).toEqual([]);
  });

  it('water_height_too_large: 10,000,000 or more fails', () => {
    expect(rules(reading({ waterHeightM: L('10000000') }))).toEqual(['water_height_too_large']);
    expect(rules(reading({ waterHeightM: L('9999999.999') }))).toEqual([]);
  });

  it('timestamp_in_future: more than 5 minutes ahead fails, exactly 5 passes', () => {
    expect(rules(reading({ effectiveAt: new Date(now.getTime() + 5 * 60_000 + 1) }))).toEqual(['timestamp_in_future']);
    expect(rules(reading({ effectiveAt: new Date(now.getTime() + 5 * 60_000) }))).toEqual([]);
  });

  it('temperature: out of range is dropped and flagged, absent stays absent, bounds are inclusive', () => {
    const hot = validateReading(reading({ temperatureC: 101 }), tank, chain(), now);
    expect(hot.violations).toEqual([]);
    expect(hot.temperature).toBeNull();
    expect(hot.flags).toEqual(['temperature_dropped']);

    expect(validateReading(reading({ temperatureC: -50.1 }), tank, chain(), now).temperature).toBeNull();
    expect(validateReading(reading({ temperatureC: -50 }), tank, chain(), now).temperature).toBe(-50);
    expect(validateReading(reading({ temperatureC: 100 }), tank, chain(), now).temperature).toBe(100);
    expect(validateReading(reading({ temperatureC: Number.NaN }), tank, chain(), now).temperature).toBeNull();

    const none = validateReading(reading({ temperatureC: null }), tank, chain(), now);
    expect(none.temperature).toBeNull();
    expect(none.flags).toEqual([]);
  });

  it('reports every broken rule at once, in a stable order', () => {
    const bad = reading({ waterVolume: L('40000'), fuelHeightM: L('9'), waterHeightM: L('20000000') });
    expect(rules(bad)).toEqual(['water_not_below_fuel', 'fuel_height_above_total', 'water_height_too_large']);
  });
});
