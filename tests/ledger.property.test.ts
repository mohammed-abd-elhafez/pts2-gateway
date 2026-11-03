import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { emptyState, step, type NegativePolicy, type TankState } from '../src/domain/ledger.js';
import { milli, parseMilli } from '../src/domain/quantity.js';
import type { TankLimits } from '../src/domain/rules.js';

const tank: TankLimits = { capacity: parseMilli('50000'), totalHeightM: parseMilli('3.5') };
const now = new Date('2026-11-03T23:59:00Z');
const base = Date.UTC(2026, 10, 3, 0, 0);

// Mostly sound readings with a minority of bad ones: invalid volumes, missing volumes,
// water above fuel, heights above the tank, and time stepping backwards.
const stepArb = fc.record({
  volume: fc.oneof(
    { weight: 8, arbitrary: fc.integer({ min: 1, max: 49_000_000 }) },
    { weight: 1, arbitrary: fc.integer({ min: -2_000_000, max: 60_000_000 }) },
    { weight: 1, arbitrary: fc.constant(null) },
  ),
  water: fc.oneof(
    { weight: 8, arbitrary: fc.integer({ min: 0, max: 2000 }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 60_000_000 }) },
  ),
  height: fc.oneof(
    { weight: 8, arbitrary: fc.integer({ min: 0, max: 3500 }) },
    { weight: 1, arbitrary: fc.integer({ min: 3501, max: 4000 }) },
  ),
  temperature: fc.option(fc.integer({ min: -80, max: 130 }), { nil: null }),
  minutes: fc.oneof(
    { weight: 7, arbitrary: fc.integer({ min: 1, max: 5 }) },
    { weight: 1, arbitrary: fc.integer({ min: -3, max: 0 }) },
  ),
  delivery: fc.boolean(),
});

describe('ledger properties', () => {
  const seen = { emit: 0, quarantine: 0, hold: 0, skip: 0 };

  it('every emitted reading satisfies both MoEnergy chain rules, whatever else is dropped or held', () => {
    fc.assert(
      fc.property(
        fc.array(stepArb, { maxLength: 80 }),
        fc.constantFrom<NegativePolicy>('allow', 'hold'),
        (steps, policy) => {
          let state: TankState = emptyState;
          let minute = 0;
          let prevRemaining: number | null = null;
          let prevTime = -Infinity;

          for (const s of steps) {
            minute += s.minutes;
            const effectiveAt = new Date(base + minute * 60_000);
            const result = step(
              state,
              {
                measured: {
                  fuelVolume: s.volume === null ? null : milli(s.volume),
                  waterVolume: milli(s.water),
                  fuelHeightM: milli(s.height),
                  waterHeightM: milli(15),
                  temperatureC: s.temperature,
                  effectiveAt,
                },
                delivery: s.delivery,
              },
              tank,
              policy,
              now,
            );

            seen[result.kind]++;
            if (result.kind === 'emit') {
              const { fuel, consumed, remaining } = result.chain;
              // chain rule 1: fuel_quantity equals the previous remaining (tolerance 0.001 L = 1 milli)
              if (prevRemaining !== null) expect(Math.abs(fuel - prevRemaining)).toBeLessThanOrEqual(1);
              // chain rule 2: remaining = fuel - consumed (tolerance 1 L = 1000 milli)
              expect(Math.abs(remaining - (fuel - consumed))).toBeLessThanOrEqual(1000);
              expect(consumed).toBeLessThanOrEqual(fuel);
              expect(fuel).toBeLessThanOrEqual(tank.capacity);
              expect(remaining).toBeLessThanOrEqual(tank.capacity);
              expect(effectiveAt.getTime()).toBeGreaterThan(prevTime);
              if (policy === 'hold') expect(consumed).toBeGreaterThanOrEqual(0);
              prevRemaining = remaining;
              prevTime = effectiveAt.getTime();
            } else if (result.kind === 'quarantine') {
              // a rejected reading must not move the chain
              expect(result.state).toEqual(state);
            } else if (result.kind === 'skip') {
              // a skipped reading must not move the chain either
              expect(result.state).toEqual(state);
            } else if (result.reason === 'tank_held') {
              expect(result.state).toEqual(state);
            }
            state = result.state;
          }
        },
      ),
      { numRuns: 500 },
    );
    // the property is only meaningful if all three outcomes were really exercised
    expect(seen.emit).toBeGreaterThan(300); // about 1,000 on average; the count varies with the seed
    expect(seen.quarantine).toBeGreaterThan(100);
    expect(seen.hold).toBeGreaterThan(30);
  });

  it('dropping any readings from a valid run leaves a valid chain', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 49_000_000 }), fc.boolean()), { minLength: 1, maxLength: 60 }),
        (items) => {
          let state: TankState = emptyState;
          let prevRemaining: number | null = null;
          items.forEach(([volume, keep], i) => {
            if (!keep) return; // the reading was lost on the way
            const result = step(
              state,
              {
                measured: {
                  fuelVolume: milli(volume),
                  waterVolume: milli(0), // every generated volume is at least 0.001 L, so 0 stays below the fuel
                  fuelHeightM: milli(1000),
                  waterHeightM: milli(15),
                  temperatureC: 20,
                  effectiveAt: new Date(base + i * 60_000),
                },
                delivery: false,
              },
              tank,
              'allow',
              now,
            );
            expect(result.kind).toBe('emit');
            if (result.kind === 'emit') {
              if (prevRemaining !== null) expect(result.chain.fuel).toBe(prevRemaining);
              expect(result.chain.remaining).toBe(volume);
              prevRemaining = result.chain.remaining;
            }
            state = result.state;
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});
