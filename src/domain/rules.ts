import type { Milli } from './quantity.js';

/** Every rule in MoEnergy's readings endpoint (guide section 2.7) that depends on one reading. */
export type RuleCode =
  | 'volume_missing'
  | 'volume_above_capacity'
  | 'consumed_above_fuel'
  | 'water_not_below_fuel'
  | 'fuel_height_above_total'
  | 'water_height_too_large'
  | 'timestamp_in_future';

export interface TankLimits {
  /** capacity_litres, in thousandths of a litre */
  capacity: Milli;
  /** total_height, in thousandths of a metre */
  totalHeightM: Milli;
}

export interface MeasuredReading {
  /** null when the controller has no calibration chart for the tank */
  fuelVolume: Milli | null;
  waterVolume: Milli;
  /** metres in thousandths (1 mm = 1) */
  fuelHeightM: Milli;
  waterHeightM: Milli;
  temperatureC: number | null;
  effectiveAt: Date;
}

export interface ChainValues {
  fuel: Milli;
  consumed: Milli;
  remaining: Milli;
}

export interface Violation {
  rule: RuleCode;
  detail: string;
}

export interface ValidationResult {
  violations: Violation[];
  /** the temperature to send: null when absent or out of range */
  temperature: number | null;
  flags: string[];
}

export const MAX_FUTURE_MS = 5 * 60_000;
export const WATER_HEIGHT_LIMIT_M = 10_000_000;
export const TEMPERATURE_MIN = -50;
export const TEMPERATURE_MAX = 100;

export function validateReading(
  r: MeasuredReading,
  tank: TankLimits,
  chain: ChainValues,
  now: Date,
): ValidationResult {
  const violations: Violation[] = [];
  const flags: string[] = [];

  let temperature = r.temperatureC;
  if (temperature !== null && !(temperature >= TEMPERATURE_MIN && temperature <= TEMPERATURE_MAX)) {
    temperature = null;
    flags.push('temperature_dropped');
  }

  if (r.fuelVolume === null) {
    violations.push({ rule: 'volume_missing', detail: 'no litre volume (calibration chart missing)' });
    return { violations, temperature, flags };
  }

  if (r.fuelVolume > tank.capacity) {
    violations.push({ rule: 'volume_above_capacity', detail: `measured ${r.fuelVolume} > capacity ${tank.capacity} (milli-litres)` });
  } else if (chain.fuel > tank.capacity) {
    violations.push({ rule: 'volume_above_capacity', detail: `chained fuel_quantity ${chain.fuel} > capacity ${tank.capacity} (milli-litres)` });
  }

  if (chain.consumed > chain.fuel) {
    violations.push({ rule: 'consumed_above_fuel', detail: `consumed ${chain.consumed} > fuel ${chain.fuel} (milli-litres)` });
  }

  if (!(r.waterVolume < chain.fuel)) {
    violations.push({ rule: 'water_not_below_fuel', detail: `water ${r.waterVolume} is not below fuel ${chain.fuel} (milli-litres)` });
    if (chain.fuel === 0 && r.waterVolume === 0) flags.push('tank_empty');
  }

  if (r.fuelHeightM > tank.totalHeightM) {
    violations.push({ rule: 'fuel_height_above_total', detail: `fuel height ${r.fuelHeightM} > total height ${tank.totalHeightM} (milli-metres)` });
  }

  if (r.waterHeightM >= WATER_HEIGHT_LIMIT_M * 1000) {
    violations.push({ rule: 'water_height_too_large', detail: `water height ${r.waterHeightM} (milli-metres) is not below ${WATER_HEIGHT_LIMIT_M} m` });
  }

  if (r.effectiveAt.getTime() > now.getTime() + MAX_FUTURE_MS) {
    violations.push({ rule: 'timestamp_in_future', detail: `${r.effectiveAt.toISOString()} is more than 5 minutes ahead of ${now.toISOString()}` });
  }

  return { violations, temperature, flags };
}
