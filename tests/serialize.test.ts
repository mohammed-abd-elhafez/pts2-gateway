import { describe, expect, it } from 'vitest';
import { milli, parseMilli as L } from '../src/domain/quantity.js';
import {
  EMPTY_BATCH_BYTES,
  formatReadingAt,
  readingJsonBytes,
  serializeBatch,
  toMoEnergyReading,
  type ReadingForBatch,
} from '../src/moenergy/serialize.js';

// The guide's own sample body, section 2.7.3.
const GUIDE_SAMPLE = {
  readings: [
    {
      station_code: 'ST-000027',
      tank_code: 'ST-000027-5',
      fuel_quantity: 14500.5,
      consumed_quantity: 250.0,
      fuel_height: 1.85,
      water_quantity: 0.5,
      water_height: 0.02,
      temperature: 28.5,
      remaining_quantity: 14250.5,
      reading_at: '2026-07-29T12:00:00Z',
    },
    {
      station_code: 'ST-000027',
      tank_code: 'ST-000027-6',
      fuel_quantity: 15000.5,
      consumed_quantity: 250.0,
      fuel_height: 1.85,
      water_quantity: 0.5,
      water_height: 0.02,
      temperature: 28.5,
      remaining_quantity: 14750.5,
      reading_at: '2026-07-29T13:00:00Z',
    },
  ],
};

const base = (o: Partial<ReadingForBatch> = {}): ReadingForBatch => ({
  stationCode: 'ST-000027',
  tankCode: 'ST-000027-5',
  fuel: L('14500.5'),
  consumed: L('250'),
  remaining: L('14250.5'),
  fuelHeightM: L('1.85'),
  waterVolume: L('0.5'),
  waterHeightM: L('0.02'),
  temperature: 28.5,
  effectiveAt: new Date('2026-07-29T12:00:00Z'),
  ...o,
});

describe('serialize', () => {
  it("reproduces the guide's sample body exactly, including field order", () => {
    const items = [
      toMoEnergyReading(base()),
      toMoEnergyReading(
        base({
          tankCode: 'ST-000027-6',
          fuel: L('15000.5'),
          remaining: L('14750.5'),
          effectiveAt: new Date('2026-07-29T13:00:00Z'),
        }),
      ),
    ];
    const body = serializeBatch(items);
    expect(JSON.parse(body)).toEqual(GUIDE_SAMPLE);
    expect(Object.keys(JSON.parse(body).readings[0])).toEqual(Object.keys(GUIDE_SAMPLE.readings[0]!));
  });

  it('gives every field the same JSON type as the guide sample', () => {
    const item = toMoEnergyReading(base()) as unknown as Record<string, unknown>;
    for (const [key, sample] of Object.entries(GUIDE_SAMPLE.readings[0]!)) {
      expect(typeof item[key], key).toBe(typeof sample);
    }
  });

  it('omits temperature when there is none, and keeps the other fields in order', () => {
    const item = toMoEnergyReading(base({ temperature: null }));
    expect('temperature' in item).toBe(false);
    expect(Object.keys(item)).toEqual([
      'station_code', 'tank_code', 'fuel_quantity', 'consumed_quantity', 'fuel_height',
      'water_quantity', 'water_height', 'remaining_quantity', 'reading_at',
    ]);
  });

  it('writes quantities as plain JSON numbers with no float noise', () => {
    const text = JSON.stringify(
      toMoEnergyReading(base({ fuel: L('31790.001'), consumed: L('0.1'), remaining: L('31789.901'), fuelHeightM: L('1.878') })),
    );
    expect(text).toContain('"fuel_quantity":31790.001');
    expect(text).toContain('"consumed_quantity":0.1');
    expect(text).toContain('"remaining_quantity":31789.901');
    expect(text).toContain('"fuel_height":1.878');
  });

  it('writes a refill as a negative consumed quantity', () => {
    const item = toMoEnergyReading(base({ fuel: L('1000'), consumed: L('-19000'), remaining: L('20000') }));
    expect(item.consumed_quantity).toBe(-19000);
  });

  it('never lets an unknown property through', () => {
    const polluted = { ...base(), secret: 'x', note: 'y' } as ReadingForBatch;
    expect(Object.keys(toMoEnergyReading(polluted))).not.toContain('secret');
    expect(Object.keys(toMoEnergyReading(polluted))).not.toContain('note');
  });

  it('formats the time in UTC without milliseconds when they are zero', () => {
    expect(formatReadingAt(new Date('2026-07-29T12:00:00.000Z'))).toBe('2026-07-29T12:00:00Z');
    expect(formatReadingAt(new Date('2026-07-29T12:00:00.250Z'))).toBe('2026-07-29T12:00:00.250Z');
  });

  it('counts bytes the way the body grows (item plus a comma, multi-byte safe)', () => {
    const a = toMoEnergyReading(base({ stationCode: 'ST-000027' }));
    const b = toMoEnergyReading(base({ tankCode: 'ST-000027-é' }));
    const total = serializeBatch([a, b]);
    expect(Buffer.byteLength(total)).toBe(EMPTY_BATCH_BYTES + readingJsonBytes(a) + readingJsonBytes(b) - 1);
    expect(readingJsonBytes(b)).toBeGreaterThan(readingJsonBytes(a));
  });

  it('serialises an empty batch', () => {
    expect(serializeBatch([])).toBe('{"readings":[]}');
    expect(milli(0)).toBe(0);
  });
});
