/**
 * A synthetic PTS-2 station: what its tank-measurement records would look like, with the numbers (records per day,
 * litres sold, refills, faults) taken from the first real station's files. Pure and seeded: no clock, no database.
 *
 * Time runs in minutes. Each tank has a true volume that falls with sales and rises with refills. The controller
 * stores a record when the probe height has moved by 3 mm, or by anything at all once 5 minutes have passed; while a
 * delivery is running it stores nothing and then writes one record that shows the whole rise (as the real file does).
 */
import { capacityL, heightMmAt, topHeightMm, volumeAtMm, type Chart } from './charts.js';
import { createRng } from './rng.js';

export interface TankProfile {
  probe: number;
  chart: Chart;
  /** litres sold on an average day */
  soldPerDay: number;
  /** the probe's constant water reading: height in mm and volume in litres */
  waterMm: number;
  waterL: number;
  /** share of the usable volume the tank holds at the start */
  startFraction: number;
}

export interface Faults {
  /** bursts of rows stamped exactly 00:00:00 (the clock was not set after a restart) */
  clockInvalidBursts?: number;
  /** extra records with the same tank and second as another record and a different value */
  sameSecondPairs?: number;
  /** extra records 1 to 5 litres above the one before, on a tank that did not move */
  noiseRises?: number;
  /** extra records where the probe reads 0 mm and 0 litres */
  probeGlitches?: number;
}

export interface SimOptions {
  seed: number;
  /** local date of the first day, YYYY-MM-DD */
  startDate: string;
  days: number;
  /** local time zone, minutes east of UTC (default 180, Saudi Arabia) */
  utcOffsetMinutes?: number;
  tanks: TankProfile[];
  /** average days between refills of the station (default 3.5); 0 or less: none */
  refillEveryDays?: number;
  /** the controller is away: whole local days counted from day 0 */
  outages?: { startDay: number; days: number }[];
  /** the first N days have no calibration chart, so no litre values */
  noVolumeDays?: number;
  faults?: Faults;
}

export type RecordKind = 'normal' | 'no_volume' | 'clock_invalid' | 'same_second' | 'noise_rise' | 'glitch';

export interface SimRecord {
  probe: number;
  /** the UTC instant the stamped local time stands for */
  at: Date;
  /** `YY.MM.DD HH:MM:SS`, local, as the controller writes it */
  localTime: string;
  heightMm: number;
  volumeL: number | null;
  waterMm: number;
  waterL: number | null;
  ullageL: number | null;
  tempC: number;
  kind: RecordKind;
}

export interface SimTruth {
  /** litres sold per probe */
  soldL: Record<number, number>;
  /** refills that show in the records */
  refills: number;
  clockInvalidRows: number;
  sameSecondPairs: number;
  noiseRises: number;
  glitches: number;
  noVolumeRows: number;
}

/** Litres sold by hour of the day on the real station (hour 0 smoothed: the real value included restart rows). */
const SALES_BY_HOUR = [1000, 579, 452, 575, 298, 402, 932, 883, 677, 1025, 1632, 1860, 2022, 2456, 3119, 4011, 4566, 3285, 3594, 2299, 3424, 2316, 2927, 2460];
const MEAN_HOUR_WEIGHT = SALES_BY_HOUR.reduce((s, x) => s + x, 0) / 24;
const MEAN_SALE_L = 35;
const MOVE_MM = 3;
const TICK_MIN = 5;

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const round1 = (x: number) => Math.round(x * 10) / 10;

interface TankState {
  profile: TankProfile;
  capacity: number;
  volume: number;
  lastHeight: number;
  forceNext: boolean;
  /** minute of the last stored record, or null before the first */
  lastMinute: number | null;
  /** whether that record carried litres */
  lastHadVolume: boolean;
  refillLeft: number;
  refillPerMin: number;
  refillPending: boolean;
  /** true volume at the top of each hour, for the rows a restart writes late */
  history: number[];
}

export function generateStation(o: SimOptions): { records: SimRecord[]; truth: SimTruth } {
  const rng = createRng(o.seed);
  const offset = o.utcOffsetMinutes ?? 180;
  const [y, mo, d] = o.startDate.split('-').map(Number) as [number, number, number];
  const startMs = Date.UTC(y, mo - 1, d) - offset * 60_000;
  const minutes = o.days * 1440;
  const noVolumeMinutes = (o.noVolumeDays ?? 0) * 1440;
  const outages = (o.outages ?? []).map((x) => [x.startDay * 1440, (x.startDay + x.days) * 1440] as const);
  const faults = o.faults ?? {};

  const truth: SimTruth = {
    soldL: Object.fromEntries(o.tanks.map((t) => [t.probe, 0])),
    refills: 0,
    clockInvalidRows: 0,
    sameSecondPairs: 0,
    noiseRises: 0,
    glitches: 0,
    noVolumeRows: 0,
  };

  const tanks: TankState[] = o.tanks.map((profile) => {
    const capacity = capacityL(profile.chart);
    const volume = Math.round(profile.startFraction * (capacity - profile.waterL));
    return {
      profile,
      capacity,
      volume,
      lastHeight: round1(heightMmAt(profile.chart, volume + profile.waterL)),
      forceNext: false,
      lastMinute: null,
      lastHadVolume: false,
      refillLeft: 0,
      refillPerMin: 0,
      refillPending: false,
      history: [],
    };
  });

  const refillMinutes: number[] = [];
  if ((o.refillEveryDays ?? 3.5) > 0) {
    for (let t = rng.exp((o.refillEveryDays ?? 3.5) * 1440); t < minutes; t += rng.exp((o.refillEveryDays ?? 3.5) * 1440)) refillMinutes.push(Math.floor(t));
  }
  let nextRefill = 0;

  const localTime = (minute: number, second: number): string => {
    const day = Math.floor(minute / 1440);
    const dt = new Date(Date.UTC(y, mo - 1, d + day));
    const mod = minute % 1440;
    return `${pad(dt.getUTCFullYear() % 100, 2)}.${pad(dt.getUTCMonth() + 1, 2)}.${pad(dt.getUTCDate(), 2)} ${pad(Math.floor(mod / 60), 2)}:${pad(mod % 60, 2)}:${pad(second, 2)}`;
  };

  interface Draft {
    rec: SimRecord;
    seq: number;
  }
  const drafts: Draft[] = [];
  let seq = 0;
  const push = (rec: SimRecord): SimRecord => {
    drafts.push({ rec, seq: seq++ });
    return rec;
  };

  /** A record for a tank holding `volume` litres of fuel at the stamped time. */
  const makeRecord = (t: TankState, volume: number, minute: number, second: number, kind: RecordKind, withVolume: boolean): SimRecord => {
    const p = t.profile;
    const h = round1(heightMmAt(p.chart, volume + p.waterL));
    const hour = Math.floor((minute % 1440) / 60);
    const temp = round1(33 + 1.5 * Math.sin((2 * Math.PI * (hour - 16)) / 24) + rng.normal(0, 0.15));
    const vol = Math.max(0, Math.round(volumeAtMm(p.chart, h) - p.waterL));
    return {
      probe: p.probe,
      at: new Date(startMs + (minute * 60 + second) * 1000),
      localTime: localTime(minute, second),
      heightMm: h,
      volumeL: withVolume ? vol : null,
      waterMm: round1(p.waterMm + rng.normal(0, 0.1)),
      waterL: withVolume ? p.waterL : null,
      ullageL: withVolume ? t.capacity - vol - p.waterL : null,
      tempC: Math.min(37, Math.max(29, temp)),
      kind,
    };
  };

  /** A second inside the minute that never makes 00:00:00 for a normal record. */
  const secondFor = (minute: number): number => {
    const s = rng.int(0, 59);
    return minute % 1440 === 0 && s === 0 ? 1 : s;
  };

  for (let m = 0; m < minutes; m++) {
    const hour = Math.floor((m % 1440) / 60);
    const inOutage = outages.some(([a, b]) => m >= a && m < b);
    if (m % 60 === 0) for (const t of tanks) t.history.push(t.volume);

    // a delivery starts: for the tank that will run out first
    while (nextRefill < refillMinutes.length && refillMinutes[nextRefill]! <= m) {
      nextRefill++;
      const free = tanks.filter((t) => t.refillLeft === 0 && t.volume < 0.7 * t.capacity);
      if (free.length === 0) continue;
      const chosen = free.reduce((a, b) => (a.volume / a.profile.soldPerDay <= b.volume / b.profile.soldPerDay ? a : b));
      const target = chosen.capacity * (0.8 + 0.15 * rng.next());
      const amount = Math.round(Math.min(32000, target - chosen.volume));
      if (amount < 4000) continue;
      chosen.refillLeft = rng.int(15, 70);
      chosen.refillPerMin = amount / chosen.refillLeft;
    }

    for (const t of tanks) {
      const p = t.profile;
      // sales
      const weight = SALES_BY_HOUR[hour]! / MEAN_HOUR_WEIGHT;
      const sales = rng.poisson((p.soldPerDay / 1440 / MEAN_SALE_L) * weight);
      for (let s = 0; s < sales; s++) {
        const litres = Math.min(90, Math.max(5, Math.round(rng.normal(MEAN_SALE_L, 15))));
        if (t.volume - litres < 100) continue;
        t.volume -= litres;
        truth.soldL[p.probe]! += litres;
      }

      // delivery in progress: the controller writes nothing until it is over
      if (t.refillLeft > 0) {
        t.volume += t.refillPerMin;
        t.refillLeft--;
        if (t.refillLeft === 0) {
          t.forceNext = true;
          t.refillPending = true;
        }
        continue;
      }
      if (inOutage) continue;

      const withVolume = m >= noVolumeMinutes;
      const height = round1(heightMmAt(p.chart, t.volume + p.waterL));
      const moved = Math.abs(height - t.lastHeight);
      const sinceLast = t.lastMinute === null ? TICK_MIN : m - t.lastMinute;
      if (!(t.forceNext || moved >= MOVE_MM || (sinceLast >= TICK_MIN && moved >= 0.1))) continue;

      const rec = makeRecord(t, t.volume, m, secondFor(m), withVolume ? 'normal' : 'no_volume', withVolume);
      push(rec);
      if (!withVolume) truth.noVolumeRows++;
      if (t.refillPending) {
        // a rise shows only between two records with litres: the tank needs one from before the delivery
        if (t.lastMinute !== null && t.lastHadVolume && withVolume) truth.refills++;
        t.refillPending = false;
      }
      t.forceNext = false;
      t.lastHeight = rec.heightMm;
      t.lastMinute = m;
      t.lastHadVolume = withVolume;
    }
  }

  // ---- faults, added on top of the clean records
  const normals = (): SimRecord[] => drafts.map((x) => x.rec).filter((r) => r.kind === 'normal');
  const tankOf = (probe: number) => tanks.find((t) => t.profile.probe === probe)!;

  for (let b = 0; b < (faults.clockInvalidBursts ?? 0); b++) {
    const day = rng.int(1, Math.max(1, o.days - 1));
    const rows = rng.int(10, 40);
    for (let i = 0; i < rows; i++) {
      const t = tanks[rng.int(0, tanks.length - 1)]!;
      const hourIdx = rng.int(Math.max(0, (day - 1) * 24), day * 24 - 1);
      const volume = t.history[Math.min(hourIdx, t.history.length - 1)]!;
      push(makeRecord(t, volume, day * 1440, 0, 'clock_invalid', day * 1440 >= noVolumeMinutes));
      truth.clockInvalidRows++;
    }
  }

  const taken = new Set<SimRecord>();
  const candidates = (cond: (r: SimRecord) => boolean) => normals().filter((r) => !taken.has(r) && cond(r));
  const choose = (list: SimRecord[], n: number): SimRecord[] => {
    const pool = [...list];
    const out: SimRecord[] = [];
    while (out.length < n && pool.length > 0) {
      const r = pool.splice(rng.int(0, pool.length - 1), 1)[0]!;
      taken.add(r);
      out.push(r);
    }
    return out;
  };

  for (const base of choose(candidates((r) => r.volumeL !== null), faults.sameSecondPairs ?? 0)) {
    const t = tankOf(base.probe);
    const delta = (rng.chance(0.5) ? 1 : -1) * rng.int(20, 60);
    const volume = Math.min(t.capacity - base.waterL! - 1, Math.max(0, base.volumeL! + delta));
    const twin = makeRecord(t, volume, 0, 0, 'same_second', true);
    push({ ...twin, at: base.at, localTime: base.localTime });
    truth.sameSecondPairs++;
  }

  const idle = (r: SimRecord) => r.volumeL !== null && r.at.getTime() % 60_000 <= 15_000;
  for (const base of choose(candidates(idle), faults.noiseRises ?? 0)) {
    const t = tankOf(base.probe);
    const volume = Math.min(t.capacity - base.waterL! - 1, base.volumeL! + rng.int(1, 5));
    const rec = makeRecord(t, volume, 0, 0, 'noise_rise', true);
    push({ ...rec, volumeL: volume, ullageL: t.capacity - volume - base.waterL!, at: new Date(base.at.getTime() + 20_000), localTime: shift(base.localTime, 20) });
    truth.noiseRises++;
  }

  for (const base of choose(candidates(idle), faults.probeGlitches ?? 0)) {
    const t = tankOf(base.probe);
    push({
      ...base,
      kind: 'glitch',
      heightMm: 0,
      volumeL: 0,
      ullageL: t.capacity - base.waterL!,
      at: new Date(base.at.getTime() + 40_000),
      localTime: shift(base.localTime, 40),
    });
    truth.glitches++;
  }

  drafts.sort((a, b) => a.rec.at.getTime() - b.rec.at.getTime() || a.seq - b.seq);
  return { records: drafts.map((x) => x.rec), truth };
}

/** Adds seconds to a `YY.MM.DD HH:MM:SS` time that stays inside the same minute. */
function shift(local: string, seconds: number): string {
  const ss = Number(local.slice(-2)) + seconds;
  return `${local.slice(0, -2)}${pad(ss, 2)}`;
}

