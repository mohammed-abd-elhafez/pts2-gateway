import { milli, subMilli, type Milli } from './quantity.js';
import {
  validateReading,
  type ChainValues,
  type MeasuredReading,
  type RuleCode,
  type TankLimits,
  type Violation,
} from './rules.js';

export type NegativePolicy = 'allow' | 'hold';

/** Where one tank's stock chain stands. */
export interface TankState {
  /** what the next reading's fuel_quantity must equal; null before the first emitted reading */
  lastRemaining: Milli | null;
  /** effective time of the last emitted reading */
  lastEffectiveAt: Date | null;
  /** true while the tank waits for a person to anchor it */
  held: boolean;
  /** set by an anchor that accepts a refill: the next reading may be negative even under the hold policy */
  acceptNegativeOnce?: boolean;
}

export const emptyState: TankState = { lastRemaining: null, lastEffectiveAt: null, held: false };

export interface LedgerInput {
  measured: MeasuredReading;
  /** the controller detected an in-tank delivery while this reading was taken */
  delivery: boolean;
}

export type LedgerResult =
  | { kind: 'emit'; chain: ChainValues; temperature: number | null; flags: string[]; state: TankState }
  /** the reading can never be sent; the chain does not move */
  | { kind: 'quarantine'; rule: RuleCode | 'late_arrival'; violations: Violation[]; flags: string[]; state: TankState }
  /** the reading stays pending until the tank is anchored */
  | { kind: 'hold'; reason: 'negative_consumed' | 'tank_held'; state: TankState }
  /**
   * A valid measurement the chain cannot carry: its remaining quantity would not stay above the water volume,
   * so MoEnergy's own "water below fuel" rule would refuse every reading that follows it. It is set aside and
   * the chain does not move, so the next good reading chains from the last value MoEnergy really holds.
   */
  | { kind: 'skip'; rule: 'remaining_not_above_water'; detail: string; state: TankState };

/**
 * Turns one measured reading into the next link of the chain, or sets it aside.
 *
 * We never copy the measured value into fuel_quantity. fuel_quantity is the previous remaining,
 * remaining is the measurement and consumed is the difference, so MoEnergy's two chain rules
 * (fuel = previous remaining, remaining = fuel - consumed) hold exactly by construction.
 * Readings must arrive in time order; one at or before the last emitted time is a late arrival.
 */
export function step(
  state: TankState,
  input: LedgerInput,
  tank: TankLimits,
  policy: NegativePolicy,
  now: Date,
): LedgerResult {
  if (state.held) return { kind: 'hold', reason: 'tank_held', state };

  const { measured } = input;

  if (state.lastEffectiveAt && measured.effectiveAt.getTime() <= state.lastEffectiveAt.getTime()) {
    return {
      kind: 'quarantine',
      rule: 'late_arrival',
      violations: [],
      flags: [],
      state,
    };
  }

  const m = measured.fuelVolume;
  // Without a volume there is no chain to build; validation reports volume_missing.
  const chain: ChainValues =
    m === null
      ? { fuel: milli(0), consumed: milli(0), remaining: milli(0) }
      : state.lastRemaining === null
        ? { fuel: m, consumed: milli(0), remaining: m }
        : { fuel: state.lastRemaining, consumed: subMilli(state.lastRemaining, m), remaining: m };

  const result = validateReading(measured, tank, chain, now);
  if (result.violations.length > 0) {
    return {
      kind: 'quarantine',
      rule: result.violations[0]!.rule,
      violations: result.violations,
      flags: result.flags,
      state,
    };
  }

  if (!(chain.remaining > measured.waterVolume)) {
    return {
      kind: 'skip',
      rule: 'remaining_not_above_water',
      detail: `measured ${chain.remaining} is not above water ${measured.waterVolume} (milli-litres): the next reading could not satisfy water < fuel`,
      state,
    };
  }

  const flags = [...result.flags];
  if (chain.consumed < 0) {
    if (policy === 'hold' && !state.acceptNegativeOnce) {
      return { kind: 'hold', reason: 'negative_consumed', state: { ...state, held: true } };
    }
    flags.push('negative_consumed');
  }
  if (input.delivery) flags.push('delivery');

  return {
    kind: 'emit',
    chain,
    temperature: result.temperature,
    flags,
    state: { lastRemaining: chain.remaining, lastEffectiveAt: measured.effectiveAt, held: false },
  };
}

/**
 * A person says MoEnergy holds this remaining quantity for the tank: continue from it.
 * `asOf` is the time of that value at MoEnergy: readings at or before it are already there.
 */
export function anchor(state: TankState, remaining: Milli, asOf?: Date, acceptNegative = false): TankState {
  const lastEffectiveAt =
    asOf && (!state.lastEffectiveAt || asOf.getTime() > state.lastEffectiveAt.getTime()) ? asOf : state.lastEffectiveAt;
  return { lastRemaining: remaining, lastEffectiveAt, held: false, ...(acceptNegative ? { acceptNegativeOnce: true } : {}) };
}
