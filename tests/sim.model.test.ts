import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capacityL, topHeightMm } from '../scripts/sim/charts.js';
import { generateStation, type SimRecord } from '../scripts/sim/model.js';
import { hmaidanTanks } from '../scripts/sim/profiles.js';

const tanks = hmaidanTanks(join(__dirname, '../scripts/sim/data'));
const base = { startDate: '2026-10-04', tanks } as const;

const byProbe = (records: SimRecord[]) => {
  const m = new Map<number, SimRecord[]>();
  for (const r of records) m.set(r.probe, [...(m.get(r.probe) ?? []), r]);
  return m;
};
const normal = (records: SimRecord[]) => records.filter((r) => r.kind === 'normal');

describe('generateStation: shape of the data', () => {
  it('gives the same records for the same seed and other records for another seed', () => {
    const a = generateStation({ ...base, seed: 5, days: 3 });
    const b = generateStation({ ...base, seed: 5, days: 3 });
    const c = generateStation({ ...base, seed: 6, days: 3 });
    expect(b).toEqual(a);
    expect(c.records).not.toEqual(a.records);
  });

  it('stores about a hundred records a day for a five-tank station, like the real controller', () => {
    const { records } = generateStation({ ...base, seed: 1, days: 14 });
    const perDay = records.length / 14;
    expect(perDay).toBeGreaterThan(70);
    expect(perDay).toBeLessThan(170);
  });

  it('keeps every record of a tank in strictly increasing time when there are no faults', () => {
    const { records } = generateStation({ ...base, seed: 2, days: 7 });
    for (const list of byProbe(records).values()) {
      for (let i = 1; i < list.length; i++) expect(list[i]!.at.getTime()).toBeGreaterThan(list[i - 1]!.at.getTime());
    }
  });

  it('keeps volume, ullage and water consistent with the tank chart: volume + ullage + water = capacity', () => {
    const { records } = generateStation({ ...base, seed: 3, days: 5 });
    for (const r of records) {
      const t = tanks.find((x) => x.probe === r.probe)!;
      expect(r.volumeL).not.toBeNull();
      expect(r.volumeL!).toBeGreaterThanOrEqual(0);
      expect(r.heightMm).toBeLessThanOrEqual(topHeightMm(t.chart));
      expect(Math.abs(r.volumeL! + r.ullageL! + r.waterL! - capacityL(t.chart))).toBeLessThanOrEqual(1);
      expect(r.tempC).toBeGreaterThan(27);
      expect(r.tempC).toBeLessThan(38);
    }
  });

  it('formats the stamped time as the controller does, local and without a zone', () => {
    const { records } = generateStation({ ...base, seed: 1, days: 1 });
    const first = records[0]!;
    expect(first.localTime).toMatch(/^26\.10\.04 \d\d:\d\d:\d\d$/);
    // 03:00 local is UTC+3
    const [, hh, mm, ss] = /(\d\d):(\d\d):(\d\d)$/.exec(first.localTime)!.map(Number) as [number, number, number, number];
    const utc = Date.UTC(2026, 9, 4, hh - 3, mm, ss);
    expect(first.at.getTime()).toBe(utc);
  });

  it('sells about the configured litres a day per tank', () => {
    const days = 14;
    const { truth } = generateStation({ ...base, seed: 4, days });
    for (const t of tanks) {
      const perDay = truth.soldL[t.probe]! / days;
      expect(perDay).toBeGreaterThan(t.soldPerDay * 0.65);
      expect(perDay).toBeLessThan(t.soldPerDay * 1.35);
    }
  });
});

describe('generateStation: refills, outages, tanks without a chart', () => {
  it('shows each refill as one big rise between two records, and counts them', () => {
    const { records, truth } = generateStation({ ...base, seed: 7, days: 30, refillEveryDays: 3.5 });
    expect(truth.refills).toBeGreaterThanOrEqual(4);
    expect(truth.refills).toBeLessThanOrEqual(16);
    let rises = 0;
    for (const list of byProbe(records).values()) {
      for (let i = 1; i < list.length; i++) {
        const d = list[i]!.volumeL! - list[i - 1]!.volumeL!;
        if (d > 3500) {
          rises++;
          expect(d).toBeLessThan(33000);
        }
      }
    }
    expect(rises).toBe(truth.refills);
  });

  it('counts only the refills that two records with litres show, also when the first days have no chart', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { records, truth } = generateStation({ ...base, seed, days: 12, noVolumeDays: 2, refillEveryDays: 2 });
      let rises = 0;
      for (const list of byProbe(records).values()) {
        for (let i = 1; i < list.length; i++) {
          const a = list[i - 1]!.volumeL;
          const b = list[i]!.volumeL;
          if (a !== null && b !== null && b - a > 3500) rises++;
        }
      }
      expect(rises, `seed ${seed}`).toBe(truth.refills);
    }
  });

  it('writes nothing while the controller is away and then shows the difference', () => {
    const { records } = generateStation({ ...base, seed: 8, days: 8, outages: [{ startDay: 3, days: 2 }] });
    const from = Date.UTC(2026, 9, 7, -3); // local day 3 starts at 2026-10-07 00:00 (UTC+3)
    const to = Date.UTC(2026, 9, 9, -3);
    expect(records.some((r) => r.at.getTime() >= from && r.at.getTime() < to)).toBe(false);
    expect(records.some((r) => r.at.getTime() < from)).toBe(true);
    expect(records.some((r) => r.at.getTime() >= to)).toBe(true);
  });

  it('writes no litre values while a tank has no chart, as the real controller did until early September', () => {
    const { records, truth } = generateStation({ ...base, seed: 9, days: 4, noVolumeDays: 2 });
    const cut = Date.UTC(2026, 9, 6, -3);
    const early = records.filter((r) => r.at.getTime() < cut);
    const late = records.filter((r) => r.at.getTime() >= cut);
    expect(early.length).toBeGreaterThan(0);
    for (const r of early) {
      expect(r.kind).toBe('no_volume');
      expect(r.volumeL).toBeNull();
      expect(r.ullageL).toBeNull();
      expect(r.waterL).toBeNull();
      expect(r.heightMm).toBeGreaterThan(0);
    }
    expect(late.every((r) => r.volumeL !== null)).toBe(true);
    expect(truth.noVolumeRows).toBe(early.length);
  });
});

describe('generateStation: the faults of the real data', () => {
  const faulty = generateStation({
    ...base,
    seed: 11,
    days: 10,
    faults: { clockInvalidBursts: 2, sameSecondPairs: 3, noiseRises: 4, probeGlitches: 2 },
  });

  it('injects nothing when no fault is asked for', () => {
    const clean = generateStation({ ...base, seed: 11, days: 10 });
    expect(clean.records.every((r) => r.kind === 'normal')).toBe(true);
    expect(clean.truth).toMatchObject({ clockInvalidRows: 0, sameSecondPairs: 0, noiseRises: 0, glitches: 0 });
  });

  it('stamps a burst of rows exactly 00:00:00 and never lets a normal record take that time', () => {
    const burst = faulty.records.filter((r) => r.kind === 'clock_invalid');
    expect(burst.length).toBe(faulty.truth.clockInvalidRows);
    expect(burst.length).toBeGreaterThan(0);
    expect(burst.every((r) => r.localTime.endsWith(' 00:00:00'))).toBe(true);
    expect(normal(faulty.records).some((r) => r.localTime.endsWith(' 00:00:00'))).toBe(false);
  });

  it('writes pairs of records with the same tank and second but different values', () => {
    const twins = faulty.records.filter((r) => r.kind === 'same_second');
    expect(twins.length).toBe(3);
    expect(faulty.truth.sameSecondPairs).toBe(3);
    for (const twin of twins) {
      const mate = faulty.records.find((r) => r !== twin && r.kind === 'normal' && r.probe === twin.probe && r.at.getTime() === twin.at.getTime());
      expect(mate).toBeDefined();
      expect(mate!.volumeL).not.toBe(twin.volumeL);
    }
  });

  it('adds small rises of 1 to 5 litres on an idle tank', () => {
    const list = faulty.records;
    const rises = list.filter((r) => r.kind === 'noise_rise');
    expect(rises.length).toBe(4);
    expect(faulty.truth.noiseRises).toBe(4);
    for (const r of rises) {
      const prev = list.slice(0, list.indexOf(r)).reverse().find((x) => x.probe === r.probe && x.kind === 'normal')!;
      const d = r.volumeL! - prev.volumeL!;
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(5);
    }
  });

  it('adds probe glitches that read 0 litres at 0 mm', () => {
    const g = faulty.records.filter((r) => r.kind === 'glitch');
    expect(g.length).toBe(2);
    expect(faulty.truth.glitches).toBe(2);
    expect(g.every((r) => r.volumeL === 0 && r.heightMm === 0)).toBe(true);
  });
});
