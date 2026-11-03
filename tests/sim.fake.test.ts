import { describe, expect, it } from 'vitest';
import { StrictMoEnergy } from '../scripts/sim/fake-moenergy.js';

const now = new Date('2026-11-03T12:00:00Z');
const tanks = [{ stationCode: 'ST-000001', tankCode: 'ST-000001-1', capacityL: 10000, totalHeightM: 2.5 }];
const make = (opts: { refuseNegative?: boolean } = {}) => new StrictMoEnergy(tanks, { now: () => now, ...opts });

const item = (over: Record<string, unknown> = {}) => ({
  station_code: 'ST-000001',
  tank_code: 'ST-000001-1',
  fuel_quantity: 5000,
  consumed_quantity: 100,
  fuel_height: 1.2,
  water_quantity: 20,
  water_height: 0.016,
  temperature: 33.1,
  remaining_quantity: 4900,
  reading_at: '2026-11-03T08:00:00Z',
  ...over,
});
const send = (m: StrictMoEnergy, ...items: Record<string, unknown>[]) => m.send(JSON.stringify({ readings: items }));
const firstError = (r: { body: unknown }) => (r.body as { errors: { message: string; sourceErrorCode: string }[] }).errors[0]!;

describe('StrictMoEnergy (the rules of the guide, written again independently)', () => {
  it('accepts a good batch and chains the next one from its remaining quantity', () => {
    const m = make();
    expect(send(m, item()).status).toBe(200);
    expect(send(m, item({ fuel_quantity: 4900, consumed_quantity: 50, remaining_quantity: 4850, reading_at: '2026-11-03T08:05:00Z' })).status).toBe(200);
    expect(m.stored.get('ST-000001-1')).toHaveLength(2);
    expect(m.chainIsWhole('ST-000001-1')).toBe(true);
  });

  it.each([
    ['an unknown property', { extra: 1 }, 'extra', 'UNKNOWN_PROPERTY'],
    ['fuel above the tank capacity', { fuel_quantity: 10001, remaining_quantity: 9901 }, 'fuel_quantity', 'TANK_FUEL_QUANTITY_EXCEEDS_CAPACITY'],
    ['consumed above fuel', { consumed_quantity: 5001, remaining_quantity: -1 }, 'consumed_quantity', 'CONSUMED_EXCEEDS_FUEL'],
    ['water not below fuel', { water_quantity: 5000 }, 'water_quantity', 'WATER_NOT_BELOW_FUEL'],
    ['fuel height above the tank height', { fuel_height: 2.6 }, 'fuel_height', 'FUEL_HEIGHT_EXCEEDS_TOTAL'],
    ['a time more than 5 minutes ahead', { reading_at: '2026-11-03T12:06:00Z' }, 'reading_at', 'READING_AT_IN_FUTURE'],
    ['a time without an offset', { reading_at: '2026-11-03T08:00:00' }, 'reading_at', 'INVALID_READING_AT'],
    ['remaining that is not fuel minus consumed', { remaining_quantity: 4898 }, 'remaining_quantity', 'REMAINING_QUANTITY_MISMATCH'],
    ['a temperature out of range', { temperature: 101 }, 'temperature', 'TEMPERATURE_OUT_OF_RANGE'],
    ['an unknown tank', { tank_code: 'ST-000001-9' }, 'tank_code', 'TANK_NOT_FOUND'],
  ])('refuses %s, naming the item and the field', (_n, over, field, code) => {
    const r = send(make(), item(), item(over));
    expect(r.status).toBe(422);
    const e = firstError(r);
    expect(e.sourceErrorCode).toBe(code);
    expect(e.message).toBe(`item_index: 1 - field: ${field}`);
  });

  it('accepts remaining within one litre of fuel minus consumed', () => {
    expect(send(make(), item({ remaining_quantity: 4900.9 })).status).toBe(200);
  });

  it('reports a broken chain at the item where fuel is not the previous remaining', () => {
    const m = make();
    send(m, item());
    const r = send(m, item({ fuel_quantity: 4890, consumed_quantity: 0, remaining_quantity: 4890, reading_at: '2026-11-03T08:05:00Z' }));
    expect(r.status).toBe(422);
    expect(firstError(r).sourceErrorCode).toBe('REMAINING_QUANTITY_INCONSISTENT');
    expect(firstError(r).message).toBe('item_index: 0 - field: fuel_quantity');
  });

  it('reports a duplicate before a broken chain', () => {
    const m = make();
    send(m, item());
    const r = send(m, item({ fuel_quantity: 4000, consumed_quantity: 0, remaining_quantity: 4000 }));
    expect(firstError(r).sourceErrorCode).toBe('DUPLICATE_READING_STORED');
  });

  it('stores nothing from a batch with one bad item, and reports only the first bad one', () => {
    const m = make();
    const r = send(
      m,
      item(),
      item({ fuel_quantity: 4900, consumed_quantity: 10, remaining_quantity: 4890, reading_at: '2026-11-03T08:05:00Z', water_quantity: 6000 }),
      item({ fuel_quantity: 1, reading_at: '2026-11-03T08:10:00Z', temperature: 500 }),
    );
    expect(firstError(r).message).toBe('item_index: 1 - field: water_quantity');
    expect(m.stored.size).toBe(0);
  });

  it('refuses a negative consumed quantity only when it is told to', () => {
    const refill = item({ fuel_quantity: 100, consumed_quantity: -4000, remaining_quantity: 4100, fuel_height: 0.5, water_quantity: 20 });
    expect(send(make(), refill).status).toBe(200);
    const r = send(make({ refuseNegative: true }), refill);
    expect(r.status).toBe(422);
    expect(firstError(r).message).toBe('item_index: 0 - field: consumed_quantity');
  });

  it('refuses a tank whose items are not in time order', () => {
    const r = send(make(), item({ reading_at: '2026-11-03T08:10:00Z' }), item({ fuel_quantity: 4900, remaining_quantity: 4800, consumed_quantity: 100, reading_at: '2026-11-03T08:05:00Z' }));
    expect(r.status).toBe(422);
    expect(firstError(r).message).toBe('item_index: 1 - field: reading_at');
  });

  it('refuses a body over 1 MB', () => {
    const big = Array.from({ length: 6000 }, (_, i) => item({ reading_at: new Date(Date.UTC(2026, 10, 3, 0, 0, i)).toISOString() }));
    expect(send(make(), ...big).status).toBe(413);
  });
});
