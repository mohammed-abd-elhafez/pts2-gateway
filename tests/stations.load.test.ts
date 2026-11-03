import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { findStationBySecret } from '../src/ingest/auth.js';
import { loadStations, parseStationsCsv, StationsFileError } from '../src/stations/load.js';
import { resetDb, testPool } from './helpers/db.js';

const HEADER = 'station_code,station_name,moenergy_station_code,utc_offset_minutes,tank_number,moenergy_tank_code,product_id,capacity_litres,total_height_m,send_from';
const GOOD = [
  HEADER,
  'HMD-01,AL HMAIDAN,ST-000027,180,1,ST-000027-1,91,42847,2.75,',
  'HMD-01,AL HMAIDAN,ST-000027,180,2,ST-000027-2,1,20596,2.75,',
  'RYD-02,"North, Riyadh",ST-000028,,1,ST-000028-1,95,25000.5,3.75,2026-11-01T00:00:00+03:00',
].join('\r\n');

const problems = (text: string): { line: number; message: string }[] => {
  try {
    parseStationsCsv(text);
  } catch (e) {
    if (e instanceof StationsFileError) return e.problems;
    throw e;
  }
  return [];
};
const row = (over: Record<string, string>): string => {
  const base: Record<string, string> = {
    station_code: 'HMD-01', station_name: 'X', moenergy_station_code: 'ST-000027', utc_offset_minutes: '180',
    tank_number: '1', moenergy_tank_code: 'ST-000027-1', product_id: '91', capacity_litres: '1000', total_height_m: '2', send_from: '',
  };
  const merged = { ...base, ...over };
  return `${HEADER}\n${HEADER.split(',').map((k) => merged[k]).join(',')}`;
};

describe('parseStationsCsv', () => {
  it('reads one row per tank, with quoted names, empty optional columns and a CRLF file', () => {
    const rows = parseStationsCsv(GOOD);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ line: 2, stationCode: 'HMD-01', stationName: 'AL HMAIDAN', moenergyStationCode: 'ST-000027', utcOffsetMinutes: 180, tankNumber: 1, moenergyTankCode: 'ST-000027-1', productId: 91, capacityLitres: '42847', totalHeightM: '2.75', sendFrom: null });
    expect(rows[2]).toMatchObject({ stationName: 'North, Riyadh', utcOffsetMinutes: 180, capacityLitres: '25000.5' });
    expect(rows[2]!.sendFrom!.toISOString()).toBe('2026-10-31T21:00:00.000Z');
  });

  it('accepts columns in any order and in any letter case', () => {
    const text = 'Tank_Number,STATION_CODE,moenergy_station_code,moenergy_tank_code,product_id,capacity_litres,total_height_m\n1,A-1,ST-000001,ST-000001-1,95,1000,2';
    expect(parseStationsCsv(text)[0]).toMatchObject({ stationCode: 'A-1', stationName: 'A-1', tankNumber: 1 });
  });

  it('refuses a file that lacks a required column, naming it', () => {
    expect(problems('station_code,tank_number\nA,1')[0]!.message).toMatch(/moenergy_station_code/);
  });

  it.each([
    ['a station code with characters that do not belong in a URL', { station_code: 'A B/1' }, /station_code/],
    ['a station code that is not ST-000000', { moenergy_station_code: 'ST-27' }, /moenergy_station_code/],
    ['a tank code of another station', { moenergy_tank_code: 'ST-000099-1' }, /moenergy_tank_code/],
    ['a tank code that does not end with a number', { moenergy_tank_code: 'ST-000027-A' }, /moenergy_tank_code/],
    ['a product MoEnergy does not list', { product_id: '92' }, /product_id/],
    ['a capacity of zero', { capacity_litres: '0' }, /capacity_litres/],
    ['a capacity with four decimals', { capacity_litres: '100.1234' }, /capacity_litres/],
    ['a height of zero', { total_height_m: '0' }, /total_height_m/],
    ['a tank number that is not a positive integer', { tank_number: '0' }, /tank_number/],
    ['a time zone out of range', { utc_offset_minutes: '900' }, /utc_offset_minutes/],
    ['a go-live time without an offset', { send_from: '2026-11-01T00:00:00' }, /send_from/],
  ])('refuses %s', (_name, over, message) => {
    const p = problems(row(over));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ line: 2 });
    expect(p[0]!.message).toMatch(message);
  });

  it('refuses the same tank twice, two codes for one station, and one MoEnergy code for two stations', () => {
    const twice = [HEADER, 'A,A,ST-000001,180,1,ST-000001-1,91,1000,2,', 'A,A,ST-000001,180,1,ST-000001-2,91,1000,2,'].join('\n');
    expect(problems(twice).map((x) => x.line)).toEqual([3]);
    const twoCodes = [HEADER, 'A,A,ST-000001,180,1,ST-000001-1,91,1000,2,', 'A,A,ST-000002,180,2,ST-000002-2,91,1000,2,'].join('\n');
    expect(problems(twoCodes).map((x) => x.line)).toEqual([3]);
    const shared = [HEADER, 'A,A,ST-000001,180,1,ST-000001-1,91,1000,2,', 'B,B,ST-000001,180,1,ST-000001-1,91,1000,2,'].join('\n');
    expect(problems(shared).length).toBeGreaterThan(0);
  });

  it('reports every bad line, not just the first', () => {
    const text = [HEADER, 'A,A,ST-1,180,1,ST-000001-1,91,1000,2,', 'B,B,ST-000002,180,1,ST-000002-1,92,1000,2,'].join('\n');
    expect(problems(text).map((x) => x.line)).toEqual([2, 3]);
  });
});

describe('loadStations', () => {
  const pool = testPool(6);
  const sendFromDefault = new Date('2026-11-03T12:00:00Z');
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  const count = async (t: string) => Number((await pool.query(`SELECT count(*) FROM ${t}`)).rows[0].count);

  it('creates the stations and their tanks, loads the reference products, and gives each new station its upload secret', async () => {
    const report = await loadStations(pool, parseStationsCsv(GOOD), { sendFromDefault });
    expect(report.stations.map((s) => [s.code, s.status])).toEqual([['HMD-01', 'created'], ['RYD-02', 'created']]);
    expect(report.tanks).toEqual({ created: 3, existing: 0, updated: 0 });
    expect(await count('ref_products')).toBe(4);
    const hmd = report.stations[0]!;
    expect(hmd.uploadPath).toBe(`/pts/${hmd.secret}`);
    expect((await findStationBySecret(pool, hmd.secret!))?.operatorStationCode).toBe('HMD-01');
    const { rows } = await pool.query(
      `SELECT s.operator_station_code AS st, s.moenergy_station_code AS mo, s.utc_offset_minutes AS off, t.tank_number AS n, t.moenergy_tank_code AS tc,
              t.product_id AS p, t.capacity_litres::float AS cap, t.total_height_m::float AS h, t.send_from, t.operator_tank_code AS oc
         FROM tanks t JOIN stations s ON s.id = t.station_id ORDER BY 1, 4`,
    );
    expect(rows[0]).toMatchObject({ st: 'HMD-01', mo: 'ST-000027', off: 180, n: 1, tc: 'ST-000027-1', p: 91, cap: 42847, h: 2.75, oc: 'T1' });
    expect(rows[0].send_from).toEqual(sendFromDefault);
    expect(rows[2].send_from).toEqual(new Date('2026-10-31T21:00:00Z'));
  });

  it('does nothing the second time, and shows no secret again', async () => {
    await loadStations(pool, parseStationsCsv(GOOD), { sendFromDefault });
    const again = await loadStations(pool, parseStationsCsv(GOOD), { sendFromDefault: new Date('2027-01-01T00:00:00Z') });
    expect(again.stations.every((s) => s.status === 'existing' && s.secret === undefined)).toBe(true);
    expect(again.tanks).toEqual({ created: 0, existing: 3, updated: 0 });
    expect(await count('stations')).toBe(2);
    expect(await count('tanks')).toBe(3);
    // the go-live time of a tank already there is not moved by a later load
    expect((await pool.query(`SELECT send_from FROM tanks WHERE moenergy_tank_code = 'ST-000027-1'`)).rows[0].send_from).toEqual(sendFromDefault);
  });

  it('adds the tanks and stations that are new when the file grows', async () => {
    await loadStations(pool, parseStationsCsv(GOOD), { sendFromDefault });
    const grown = `${GOOD}\r\nHMD-01,AL HMAIDAN,ST-000027,180,3,ST-000027-3,1,20596,2.75,\r\nNEW-03,New,ST-000029,180,1,ST-000029-1,98,5000,2,`;
    const r = await loadStations(pool, parseStationsCsv(grown), { sendFromDefault });
    expect(r.stations.map((s) => s.status)).toEqual(['existing', 'existing', 'created']);
    expect(r.tanks).toEqual({ created: 2, existing: 3, updated: 0 });
  });

  it('refuses a file that disagrees with what is stored, and writes nothing from it, unless told to update', async () => {
    await loadStations(pool, parseStationsCsv(GOOD), { sendFromDefault });
    const changed = GOOD.replace('ST-000027,180,1,ST-000027-1,91,42847', 'ST-000027,180,1,ST-000027-1,91,40000') + '\r\nNEW-03,New,ST-000029,180,1,ST-000029-1,98,5000,2,';
    const err = await loadStations(pool, parseStationsCsv(changed), { sendFromDefault }).catch((e) => e);
    expect(err).toBeInstanceOf(StationsFileError);
    expect(err.problems[0].message).toMatch(/capacity_litres.*42847.*40000/);
    expect(await count('stations')).toBe(2); // NEW-03 was not created
    const ok = await loadStations(pool, parseStationsCsv(changed), { sendFromDefault, update: true });
    expect(ok.tanks.updated).toBe(1);
    expect(ok.stations.find((s) => s.code === 'NEW-03')!.status).toBe('created');
    expect(Number((await pool.query(`SELECT capacity_litres FROM tanks WHERE moenergy_tank_code = 'ST-000027-1'`)).rows[0].capacity_litres)).toBe(40000);
  });

  it('refuses a different MoEnergy code for a station that has one, and a code another station already uses', async () => {
    await loadStations(pool, parseStationsCsv(GOOD), { sendFromDefault });
    const recoded = row({ station_code: 'HMD-01', moenergy_station_code: 'ST-000099', moenergy_tank_code: 'ST-000099-1' });
    expect((await loadStations(pool, parseStationsCsv(recoded), { sendFromDefault }).catch((e) => e)).problems[0].message).toMatch(/moenergy_station_code/);
    const stolen = row({ station_code: 'OTHER-9', moenergy_station_code: 'ST-000027', moenergy_tank_code: 'ST-000027-9' });
    expect((await loadStations(pool, parseStationsCsv(stolen), { sendFromDefault }).catch((e) => e)).problems[0].message).toMatch(/already (belongs|used)/);
  });

  it('shows what it would do and writes nothing in a dry run', async () => {
    const r = await loadStations(pool, parseStationsCsv(GOOD), { sendFromDefault, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.stations.map((s) => s.status)).toEqual(['created', 'created']);
    expect(r.stations.every((s) => s.secret === undefined)).toBe(true);
    expect(r.tanks.created).toBe(3);
    expect(await count('stations')).toBe(0);
    expect(await count('ref_products')).toBe(0);
  });
});
