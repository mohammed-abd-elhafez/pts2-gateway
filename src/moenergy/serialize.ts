import { milliToJsonNumber, type Milli } from '../domain/quantity.js';

/** One tank reading as the gateway holds it, ready to be sent. */
export interface ReadingForBatch {
  stationCode: string;
  tankCode: string;
  fuel: Milli;
  consumed: Milli;
  remaining: Milli;
  /** metres in thousandths */
  fuelHeightM: Milli;
  waterVolume: Milli;
  waterHeightM: Milli;
  temperature: number | null;
  effectiveAt: Date;
}

/** MoEnergy's readings item (guide section 2.7). Numbers are JSON numbers, codes and time are strings. */
export interface MoEnergyReading {
  station_code: string;
  tank_code: string;
  fuel_quantity: number;
  consumed_quantity: number;
  fuel_height: number;
  water_quantity: number;
  water_height: number;
  temperature?: number;
  remaining_quantity: number;
  reading_at: string;
}

/** UTC with an explicit offset, no milliseconds when they are zero. */
export function formatReadingAt(d: Date): string {
  return d.toISOString().replace('.000Z', 'Z');
}

/**
 * Builds the item field by field. Nothing is spread from the input, so a field MoEnergy does not
 * define can never reach the body (they answer 422 to unknown properties).
 */
export function toMoEnergyReading(r: ReadingForBatch): MoEnergyReading {
  const item: MoEnergyReading = {
    station_code: r.stationCode,
    tank_code: r.tankCode,
    fuel_quantity: milliToJsonNumber(r.fuel),
    consumed_quantity: milliToJsonNumber(r.consumed),
    fuel_height: milliToJsonNumber(r.fuelHeightM),
    water_quantity: milliToJsonNumber(r.waterVolume),
    water_height: milliToJsonNumber(r.waterHeightM),
    remaining_quantity: milliToJsonNumber(r.remaining),
    reading_at: formatReadingAt(r.effectiveAt),
  };
  if (r.temperature !== null) {
    // keep the guide's field order: temperature sits before remaining_quantity
    return {
      station_code: item.station_code,
      tank_code: item.tank_code,
      fuel_quantity: item.fuel_quantity,
      consumed_quantity: item.consumed_quantity,
      fuel_height: item.fuel_height,
      water_quantity: item.water_quantity,
      water_height: item.water_height,
      temperature: r.temperature,
      remaining_quantity: item.remaining_quantity,
      reading_at: item.reading_at,
    };
  }
  return item;
}

const WRAPPER_BYTES = Buffer.byteLength('{"readings":[]}');

/** Bytes one item adds to a batch body (its JSON plus a separating comma). */
export function readingJsonBytes(item: MoEnergyReading): number {
  return Buffer.byteLength(JSON.stringify(item)) + 1;
}

export const EMPTY_BATCH_BYTES = WRAPPER_BYTES;

export function serializeBatch(items: MoEnergyReading[]): string {
  return JSON.stringify({ readings: items });
}
