import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capacityL, heightMmAt, parseChart, topHeightMm, volumeAtMm } from '../scripts/sim/charts.js';
import { createRng } from '../scripts/sim/rng.js';

const chartText = (n: string) => readFileSync(join(__dirname, '../scripts/sim/data', `${n}CALIB.CSV`), 'utf8');

describe('rng', () => {
  it('gives the same sequence for the same seed and a different one for another seed', () => {
    const a = createRng(7);
    const b = createRng(7);
    const c = createRng(8);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('draws integers inside the inclusive range', () => {
    const r = createRng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(r.int(3, 6));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('draws a Poisson count whose mean is close to lambda', () => {
    const r = createRng(2);
    const n = 4000;
    const mean = Array.from({ length: n }, () => r.poisson(0.4)).reduce((s, x) => s + x, 0) / n;
    expect(mean).toBeGreaterThan(0.35);
    expect(mean).toBeLessThan(0.45);
  });
});

describe('calibration charts (the real ones of the first station)', () => {
  const chart1 = parseChart(chartText('01'));

  it('reads CRLF files: heights in 0.1 mm, volumes in litres', () => {
    expect(chart1.heightsMm[0]).toBe(10);
    expect(chart1.volumesL[0]).toBe(16);
    expect(topHeightMm(chart1)).toBe(2750);
    expect(capacityL(chart1)).toBe(42847);
  });

  it('interpolates linearly between two chart lines', () => {
    // 1420.0 mm = 22316 L and 1430.0 mm = 22514 L
    expect(volumeAtMm(chart1, 1425)).toBeCloseTo(22415, 6);
  });

  it('is zero at the bottom and capped at the top', () => {
    expect(volumeAtMm(chart1, 0)).toBe(0);
    expect(volumeAtMm(chart1, 3000)).toBe(42847);
  });

  it('is inverted by heightMmAt to within a tenth of a millimetre', () => {
    for (const v of [0, 5, 226, 5700, 22360, 42000, 42847]) {
      expect(volumeAtMm(chart1, heightMmAt(chart1, v))).toBeCloseTo(v, 0);
    }
    for (const h of [10, 91.5, 810.2, 1423.6, 2700]) {
      expect(heightMmAt(chart1, volumeAtMm(chart1, h))).toBeCloseTo(h, 1);
    }
  });

  it('knows the five capacities the data showed', () => {
    expect(['01', '02', '03', '04', '05'].map((n) => capacityL(parseChart(chartText(n))))).toEqual([
      42847, 20596, 20596, 18614, 18614,
    ]);
  });
});
