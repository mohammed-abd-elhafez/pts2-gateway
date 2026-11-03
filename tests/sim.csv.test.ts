import { describe, expect, it } from 'vitest';
import type { SimRecord } from '../scripts/sim/model.js';
import { formatTankMsrRow, TANKMSR_HEADER } from '../scripts/sim/csv.js';

const rec = (over: Partial<SimRecord>): SimRecord => ({
  probe: 1,
  at: new Date('2026-11-03T08:42:12Z'),
  localTime: '26.11.03 11:42:12',
  heightMm: 1425.5,
  volumeL: 22400,
  waterMm: 15.9,
  waterL: 33,
  ullageL: 20414,
  tempC: 32.2,
  kind: 'normal',
  ...over,
});

describe('TANKMSR.CSV writer', () => {
  it('writes the header the real controller writes', () => {
    expect(TANKMSR_HEADER).toBe(
      'DateTime,Probe,Status,Alarms,PHPresent,ProductHeight,WHPresent,WaterHeight,TPresent,Temperature,PVPresent,ProductVolume,' +
        'WVPresent,WaterVolume,UPresent,Ullage,PTCVPresent,ProductTCVolume,DPresent,Density,MPresent,Mass,FPPresent,FillingPercentage',
    );
  });

  it('writes a record with litres exactly like a real row of tank 1', () => {
    expect(formatTankMsrRow(rec({}), 2750)).toBe(
      '26.11.03 11:42:12,01,0,00,1,00001425.5,1,00000015.9,1,+00000032.2,1,0000022400,1,0000000033,1,0000020414,0,0000000000,0,00000000.0,0,00000000.0,1,052',
    );
  });

  it('writes a record without a chart exactly like a real early row', () => {
    const r = rec({ localTime: '26.06.15 21:06:30', heightMm: 2505.3, waterMm: 1288.4, tempC: 33.2, volumeL: null, waterL: null, ullageL: null, kind: 'no_volume' });
    expect(formatTankMsrRow(r, 2750)).toBe(
      '26.06.15 21:06:30,01,0,00,1,00002505.3,1,00001288.4,1,+00000033.2,0,0000000000,0,0000000000,0,0000000000,0,0000000000,0,00000000.0,0,00000000.0,1,091',
    );
  });
});
