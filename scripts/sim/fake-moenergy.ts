/**
 * A stand-in for MoEnergy's readings endpoint (ATG APIs guide v1.1.0, section 2.7), written from the guide's rules and
 * not from our own validator, so a mistake in our rules does not hide behind the same mistake here.
 *
 * A batch is all-or-nothing and only its first bad item is reported, as `item_index: N - field: name`.
 * The order in which two problems of one item are reported is our assumption (the guide does not say): shape, then
 * limits, then duplicate, then chain.
 */

export interface FakeTank {
  stationCode: string;
  tankCode: string;
  capacityL: number;
  totalHeightM: number;
}

export interface FakeOptions {
  now: () => Date;
  /** answer 422 for a negative consumed_quantity (one of the open questions to Preproduction) */
  refuseNegative?: boolean;
}

export interface StoredItem {
  tank_code: string;
  fuel_quantity: number;
  consumed_quantity: number;
  remaining_quantity: number;
  reading_at: string;
}

const KEYS = new Set([
  'station_code', 'tank_code', 'fuel_quantity', 'consumed_quantity', 'fuel_height', 'water_quantity',
  'water_height', 'temperature', 'remaining_quantity', 'reading_at',
]);
const MAX_BODY = 1_048_576;
const WITH_OFFSET = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;

const error = (index: number, field: string, code: string) => ({
  errors: [{ code: 'x', message: `item_index: ${index} - field: ${field}`, sourceErrorCode: code, sourceMessage: code }],
});

export class StrictMoEnergy {
  readonly stored = new Map<string, StoredItem[]>();
  private readonly byTank: Map<string, FakeTank>;

  constructor(tanks: FakeTank[], private readonly opts: FakeOptions) {
    this.byTank = new Map(tanks.map((t) => [t.tankCode, t]));
  }

  last(tank: string): StoredItem | undefined {
    return this.stored.get(tank)?.at(-1);
  }

  /** true when the tank's stored readings form one unbroken chain in time order */
  chainIsWhole(tank: string): boolean {
    const list = this.stored.get(tank) ?? [];
    return list.every(
      (r, i) => i === 0 || (Math.abs(r.fuel_quantity - list[i - 1]!.remaining_quantity) <= 0.001 && r.reading_at > list[i - 1]!.reading_at),
    );
  }

  send(body: string): { status: number; body: unknown } {
    if (Buffer.byteLength(body) > MAX_BODY) return { status: 413, body: { error: 'payload too large' } };
    const items = (JSON.parse(body) as { readings: Record<string, unknown>[] }).readings;
    // work on a copy: nothing is stored unless every item passes
    const view = new Map([...this.stored].map(([k, v]) => [k, [...v]]));
    const lastTime = new Map<string, number>();

    for (const [i, r] of items.entries()) {
      for (const k of Object.keys(r)) if (!KEYS.has(k)) return { status: 422, body: error(i, k, 'UNKNOWN_PROPERTY') };
      const tank = this.byTank.get(String(r.tank_code));
      if (!tank || tank.stationCode !== r.station_code) return { status: 422, body: error(i, 'tank_code', 'TANK_NOT_FOUND') };

      const at = String(r.reading_at);
      const atMs = WITH_OFFSET.test(at) ? Date.parse(at) : NaN;
      if (Number.isNaN(atMs)) return { status: 422, body: error(i, 'reading_at', 'INVALID_READING_AT') };
      if (atMs > this.opts.now().getTime() + 5 * 60_000) return { status: 422, body: error(i, 'reading_at', 'READING_AT_IN_FUTURE') };

      const fuel = r.fuel_quantity as number;
      const consumed = r.consumed_quantity as number;
      const remaining = r.remaining_quantity as number;
      if (fuel > tank.capacityL) return { status: 422, body: error(i, 'fuel_quantity', 'TANK_FUEL_QUANTITY_EXCEEDS_CAPACITY') };
      if (consumed > fuel) return { status: 422, body: error(i, 'consumed_quantity', 'CONSUMED_EXCEEDS_FUEL') };
      if ((r.fuel_height as number) > tank.totalHeightM) return { status: 422, body: error(i, 'fuel_height', 'FUEL_HEIGHT_EXCEEDS_TOTAL') };
      if ((r.water_quantity as number) >= fuel) return { status: 422, body: error(i, 'water_quantity', 'WATER_NOT_BELOW_FUEL') };
      if ((r.water_height as number) >= 10_000_000) return { status: 422, body: error(i, 'water_height', 'WATER_HEIGHT_TOO_LARGE') };
      if (r.temperature !== undefined && ((r.temperature as number) < -50 || (r.temperature as number) > 100)) {
        return { status: 422, body: error(i, 'temperature', 'TEMPERATURE_OUT_OF_RANGE') };
      }
      if (Math.abs(remaining - (fuel - consumed)) > 1) return { status: 422, body: error(i, 'remaining_quantity', 'REMAINING_QUANTITY_MISMATCH') };
      if (this.opts.refuseNegative && consumed < 0) return { status: 422, body: error(i, 'consumed_quantity', 'NEGATIVE_CONSUMED') };

      const list = view.get(tank.tankCode) ?? [];
      if (list.some((s) => s.reading_at === at)) return { status: 422, body: error(i, 'reading_at', 'DUPLICATE_READING_STORED') };
      if (atMs < (lastTime.get(tank.tankCode) ?? -Infinity)) return { status: 422, body: error(i, 'reading_at', 'READINGS_NOT_ORDERED') };
      const prev = list.at(-1);
      if (prev && Math.abs(fuel - prev.remaining_quantity) > 0.001) return { status: 422, body: error(i, 'fuel_quantity', 'REMAINING_QUANTITY_INCONSISTENT') };

      lastTime.set(tank.tankCode, atMs);
      view.set(tank.tankCode, [...list, { tank_code: tank.tankCode, fuel_quantity: fuel, consumed_quantity: consumed, remaining_quantity: remaining, reading_at: at }]);
    }
    for (const [k, v] of view) this.stored.set(k, v);
    return { status: 200, body: { status: 'accepted', message: 'Batch accepted.', accepted_count: items.length } };
  }
}
