import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { importTankMsr, parseTankMsr, TankMsrFormatError } from '../src/import/tankmsr.js';
import { runLedgerOnce } from '../src/ledger/worker.js';
import { resetDb, testPool } from './helpers/db.js';
import { insertStation, insertTank, seedRefs } from './helpers/fixtures.js';

const sample = readFileSync(join(__dirname, 'fixtures/hmaidan/TANKMSR_sample.csv'), 'utf8');
const HEADER = sample.split(/\r?\n/)[0]!;
const GOLDEN = '26.11.03 11:42:12,01,0,00,1,00001425.5,1,00000015.9,1,+00000032.2,1,0000022400,1,0000000033,1,0000020414,0,0000000000,0,00000000.0,0,00000000.0,1,052';

describe('parseTankMsr', () => {
  it('reads a real row: local time to UTC, millimetres, litres', () => {
    const { rows, errors } = parseTankMsr(`${HEADER}\r\n${GOLDEN}\r\n`, 180);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      line: 2,
      probe: 1,
      heightMm: 1425.5,
      waterMm: 15.9,
      tempC: 32.2,
      volumeL: 22400,
      waterL: 33,
      ullageL: 20414,
      status: '0',
      alarms: [],
      clockInvalid: false,
    });
    expect(rows[0]!.at.toISOString()).toBe('2026-11-03T08:42:12.000Z');
  });

  it('reads the zone from the argument', () => {
    const { rows } = parseTankMsr(`${HEADER}\n${GOLDEN}\n`, 0);
    expect(rows[0]!.at.toISOString()).toBe('2026-11-03T11:42:12.000Z');
  });

  it('gives no volume when the controller has no chart for the row', () => {
    const line = sample.split(/\r?\n/)[1]!;
    const { rows } = parseTankMsr(`${HEADER}\n${line}\n`, 180);
    expect(rows[0]!.volumeL).toBeNull();
    expect(rows[0]!.ullageL).toBeNull();
    expect(rows[0]!.status).toBe('1');
  });

  it('marks a row stamped 00:00:00 as clock_invalid', () => {
    const line = GOLDEN.replace('11:42:12', '00:00:00');
    expect(parseTankMsr(`${HEADER}\n${line}\n`, 180).rows[0]!.clockInvalid).toBe(true);
  });

  it('refuses a file whose header is not a TANKMSR.CSV header', () => {
    expect(() => parseTankMsr(`DateTime,Probe\n${GOLDEN}\n`, 180)).toThrow(TankMsrFormatError);
  });

  it('reports bad lines with their line number and keeps the good ones', () => {
    const text = [
      HEADER,
      GOLDEN,
      '26.11.03 11:43:12,01,0,00',
      GOLDEN.replace('26.11.03 11:42:12', '26.13.40 25:61:00'),
      GOLDEN.replace('0000022400', 'abcdefghij'),
      '',
      GOLDEN.replace('11:42:12', '11:47:15'),
    ].join('\n');
    const { rows, errors } = parseTankMsr(text, 180);
    expect(rows.map((r) => r.line)).toEqual([2, 7]);
    expect(errors.map((e) => e.line)).toEqual([3, 4, 5]);
  });
});

describe('importTankMsr', () => {
  const pool = testPool(6);
  let stationId: number;

  beforeEach(async () => {
    await resetDb(pool);
    await seedRefs(pool);
    stationId = (await insertStation(pool, { code: 'HMD-01', extra: { utc_offset_minutes: 180 } })).id;
    for (let n = 1; n <= 5; n++) await insertTank(pool, stationId, { number: n, capacity: '42847', heightM: '2.75' });
  });
  afterAll(() => pool.end());

  const count = async (where = 'true') => Number((await pool.query(`SELECT count(*) FROM readings WHERE ${where}`)).rows[0].count);

  it('stores what MoEnergy can use, sets the 00:00:00 rows aside, and skips rows without litres', async () => {
    const report = await importTankMsr(pool, stationId, sample);
    expect(report).toMatchObject({ lines: 20, noVolume: 8, beforeSince: 0, unknownProbes: [], inserted: 11, clockInvalid: 3, duplicates: 1, duplicateTime: 0, duplicateClock: 1 });
    expect(report.errors).toEqual([]);
    expect(await count()).toBe(11);
    expect(await count(`ledger_status = 'pending'`)).toBe(8);
    expect(await count(`ledger_status = 'quarantined'`)).toBe(3);
    const q = await pool.query(`SELECT rule_code, count(*)::int AS n FROM quarantine GROUP BY rule_code`);
    expect(q.rows).toEqual([{ rule_code: 'clock_invalid', n: 3 }]);
  });

  it('stores the golden row with every value and the UTC time', async () => {
    await importTankMsr(pool, stationId, sample);
    const { rows } = await pool.query(
      `SELECT effective_at, device_time, fuel_volume_l::float AS vol, fuel_height_mm::float AS h, water_height_mm::float AS wh,
              water_volume_l::float AS wv, ullage_l::float AS u, temperature_c::float AS t, probe_status, alarms
         FROM readings WHERE effective_at = '2026-11-03T08:42:12Z'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vol: 22400, h: 1425.5, wh: 15.9, wv: 33, u: 20414, t: 32.2, probe_status: '0', alarms: [] });
    expect(rows[0].device_time).toEqual(rows[0].effective_at);
  });

  it('is safe to run twice on the same file', async () => {
    await importTankMsr(pool, stationId, sample);
    const again = await importTankMsr(pool, stationId, sample);
    expect(again.inserted).toBe(0);
    expect(await count()).toBe(11);
  });

  it('leaves out rows before the start date', async () => {
    const report = await importTankMsr(pool, stationId, sample, { since: new Date('2026-10-22T00:00:00+03:00') });
    expect(report).toMatchObject({ noVolume: 8, beforeSince: 4, inserted: 8, clockInvalid: 0 });
  });

  it('reports a probe the station has no tank for, and imports the rest', async () => {
    await pool.query(`DELETE FROM tanks WHERE tank_number > 1`);
    const report = await importTankMsr(pool, stationId, sample);
    expect(report.unknownProbes).toEqual([3]);
    expect(report.inserted).toBe(8);
  });

  it('uses the zone of the station unless told otherwise', async () => {
    await importTankMsr(pool, stationId, sample, { utcOffsetMinutes: 0 });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM readings WHERE effective_at = '2026-11-03T11:42:12Z'`);
    expect(rows[0].n).toBe(1);
  });

  it('feeds the ledger: the refill becomes one negative consumed, nothing else is held back', async () => {
    await importTankMsr(pool, stationId, sample);
    const result = await runLedgerOnce(pool, { policy: 'allow', now: () => new Date('2026-12-01T00:00:00Z') });
    expect(result).toMatchObject({ emitted: 8, quarantined: 0, skipped: 0, heldTanks: 0 });
    const { rows } = await pool.query(`SELECT consumed_quantity::float AS c FROM emitted_readings WHERE consumed_quantity < 0`);
    expect(rows).toEqual([{ c: -32046 }]);
  });
});
