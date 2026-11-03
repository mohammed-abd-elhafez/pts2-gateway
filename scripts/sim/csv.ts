import type { SimRecord } from './model.js';

/** The header line of a real `TANKMSR.CSV` (Technotrade guide pp. 67-68). */
export const TANKMSR_HEADER =
  'DateTime,Probe,Status,Alarms,PHPresent,ProductHeight,WHPresent,WaterHeight,TPresent,Temperature,PVPresent,ProductVolume,' +
  'WVPresent,WaterVolume,UPresent,Ullage,PTCVPresent,ProductTCVolume,DPresent,Density,MPresent,Mass,FPPresent,FillingPercentage';

const zeros = (n: number, width: number): string => String(Math.round(n)).padStart(width, '0');
const decimal = (n: number, width: number): string => n.toFixed(1).padStart(width, '0');

/** One record as the controller writes it: zero padded, heights in mm, volumes in litres. */
export function formatTankMsrRow(r: SimRecord, totalHeightMm: number): string {
  const hasVolume = r.volumeL !== null;
  const temp = `${r.tempC < 0 ? '-' : '+'}${decimal(Math.abs(r.tempC), 10)}`;
  return [
    r.localTime,
    zeros(r.probe, 2),
    '0',
    '00',
    '1',
    decimal(r.heightMm, 10),
    '1',
    decimal(r.waterMm, 10),
    '1',
    temp,
    hasVolume ? '1' : '0',
    zeros(r.volumeL ?? 0, 10),
    hasVolume ? '1' : '0',
    zeros(r.waterL ?? 0, 10),
    hasVolume ? '1' : '0',
    zeros(r.ullageL ?? 0, 10),
    '0',
    '0000000000',
    '0',
    '00000000.0',
    '0',
    '00000000.0',
    '1',
    zeros((100 * r.heightMm) / totalHeightMm, 3),
  ].join(',');
}

/** A whole file, CRLF like the controller's. `totalHeightMm` is the configured tank height per probe. */
export function tankMsrCsv(records: SimRecord[], totalHeightMm: Record<number, number>): string {
  const lines = [TANKMSR_HEADER, ...records.map((r) => formatTankMsrRow(r, totalHeightMm[r.probe] ?? 2750))];
  return `${lines.join('\r\n')}\r\n`;
}
