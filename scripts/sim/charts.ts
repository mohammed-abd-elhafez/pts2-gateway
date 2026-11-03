/**
 * A tank calibration chart as the PTS-2 stores it (`NNCALIB.CSV`): lines `height,volume` where the height is in
 * 0.1 mm and the volume in litres, both zero padded. The controller reads the volume between two lines linearly.
 */
export interface Chart {
  /** millimetres, ascending, starting with the first chart line */
  heightsMm: number[];
  volumesL: number[];
}

export function parseChart(text: string): Chart {
  const heightsMm: number[] = [];
  const volumesL: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const [h, v] = line.split(',');
    heightsMm.push(Number(h) / 10);
    volumesL.push(Number(v));
  }
  return { heightsMm, volumesL };
}

export const topHeightMm = (c: Chart): number => c.heightsMm[c.heightsMm.length - 1]!;
export const capacityL = (c: Chart): number => c.volumesL[c.volumesL.length - 1]!;

/** Index of the last element that is <= x in an ascending array (-1 when x is below the first). */
function floorIndex(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function interpolate(xs: number[], ys: number[], x: number): number {
  // the chart has an implicit first line at 0
  if (x <= 0) return 0;
  const last = xs.length - 1;
  if (x >= xs[last]!) return ys[last]!;
  const i = floorIndex(xs, x);
  const x0 = i < 0 ? 0 : xs[i]!;
  const y0 = i < 0 ? 0 : ys[i]!;
  const x1 = xs[i + 1]!;
  const y1 = ys[i + 1]!;
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

export const volumeAtMm = (c: Chart, mm: number): number => interpolate(c.heightsMm, c.volumesL, mm);
export const heightMmAt = (c: Chart, litres: number): number => interpolate(c.volumesL, c.heightsMm, litres);
