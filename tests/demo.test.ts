import { Writable } from 'node:stream';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, findClientByKey } from '../src/api/clients.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { StrictMoEnergy, type FakeTank } from '../scripts/sim/fake-moenergy.js';
import { seedDemo } from '../scripts/sim/demo.js';
import { resetDb, testPool, TEST_DB_URL } from './helpers/db.js';

const pool = testPool(10);
const config = loadConfig({ DATABASE_URL: TEST_DB_URL, LOG_LEVEL: 'silent' });
const now = () => new Date();
const app = buildApp({ pool, config, now, logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
const chartDir = join(__dirname, '../scripts/sim/data');
const KEY = 'demo_key_for_tests_0123456789abcdef';

beforeEach(() => resetDb(pool));
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('a client key chosen by the operator', () => {
  it('can be given instead of generated, and then opens the API', async () => {
    const { key } = await createClient(pool, 'fixed', { key: KEY });
    expect(key).toBe(KEY);
    expect(await findClientByKey(pool, KEY)).toMatchObject({ name: 'fixed', stationId: null });
  });

  it('is refused when it is too short to be a secret', async () => {
    await expect(createClient(pool, 'weak', { key: 'short' })).rejects.toThrow(/at least 24/);
  });
});

describe('seedDemo', () => {
  const opts = { stations: 2, days: 3, seed: 1, apiKey: KEY, chartDir };

  it('creates stations with five tanks, their readings, and a client key', async () => {
    const r = await seedDemo(pool, opts);
    expect(r).toMatchObject({ seeded: true, stations: ['SIM-001', 'SIM-002'] });
    const { rows } = await pool.query(
      `SELECT s.operator_station_code AS code, s.moenergy_station_code AS mo, count(t.id)::int AS tanks
         FROM stations s JOIN tanks t ON t.station_id = s.id GROUP BY s.id ORDER BY 1`,
    );
    expect(rows).toEqual([
      { code: 'SIM-001', mo: 'ST-000001', tanks: 5 },
      { code: 'SIM-002', mo: 'ST-000002', tanks: 5 },
    ]);
    expect(Number((await pool.query(`SELECT count(*) FROM readings`)).rows[0].count)).toBeGreaterThan(100);
    expect(await findClientByKey(pool, KEY)).not.toBeNull();
  });

  it('does nothing the second time, so a restart of the service does not pile up data', async () => {
    await seedDemo(pool, opts);
    const before = (await pool.query(`SELECT (SELECT count(*) FROM readings) + (SELECT count(*) FROM stations) + (SELECT count(*) FROM api_clients) AS n`)).rows[0].n;
    expect((await seedDemo(pool, opts)).seeded).toBe(false);
    const after = (await pool.query(`SELECT (SELECT count(*) FROM readings) + (SELECT count(*) FROM stations) + (SELECT count(*) FROM api_clients) AS n`)).rows[0].n;
    expect(after).toBe(before);
  });

  it('has its readings ready at once: a person trying the API right after the deploy gets a batch, not a 204', async () => {
    await seedDemo(pool, opts);
    const { rows } = await pool.query<{ station: string; code: string; cap: string; h: string }>(
      `SELECT s.moenergy_station_code AS station, t.moenergy_tank_code AS code, t.capacity_litres AS cap, t.total_height_m AS h
         FROM tanks t JOIN stations s ON s.id = t.station_id`,
    );
    const fakeTanks: FakeTank[] = rows.map((r) => ({ stationCode: r.station, tankCode: r.code, capacityL: Number(r.cap), totalHeightM: Number(r.h) }));
    const fake = new StrictMoEnergy(fakeTanks, { now });
    const auth = { authorization: `Bearer ${KEY}` };

    let sent = 0;
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/stations/SIM-001/readings/batches/next', headers: auth });
      if (res.statusCode === 204) break;
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-batch-id']).toBeDefined();
      const body = JSON.parse(res.body) as { readings: Record<string, unknown>[] };
      expect(Object.keys(body)).toEqual(['readings']);
      expect(Object.keys(body.readings[0]!).sort()).toEqual(
        ['consumed_quantity', 'fuel_height', 'fuel_quantity', 'reading_at', 'remaining_quantity', 'station_code', 'tank_code', 'temperature', 'water_height', 'water_quantity'].sort(),
      );
      expect(body.readings[0]!.station_code).toBe('ST-000001');
      const answer = fake.send(res.body);
      expect(answer.status).toBe(200);
      sent += body.readings.length;
      const posted = await app.inject({
        method: 'POST',
        url: `/v1/stations/SIM-001/readings/batches/${res.headers['x-batch-id']}/result`,
        headers: auth,
        payload: { status_code: answer.status, body: answer.body, correlation_id: res.headers['x-correlation-id'] },
      });
      expect(posted.statusCode).toBe(200);
      expect(JSON.parse(posted.body)).toMatchObject({ batch_status: 'accepted', action: 'accepted' });
    }
    expect(sent).toBeGreaterThan(100);
    expect((await app.inject({ method: 'GET', url: '/v1/stations/SIM-001/readings/batches/next', headers: auth })).statusCode).toBe(204);
    // the other station was not touched by this walk
    expect(fake.stored.get('ST-000002-1') ?? []).toHaveLength(0);
  });

  it('refuses to seed without a key long enough to be a secret', async () => {
    await expect(seedDemo(pool, { ...opts, apiKey: 'short' })).rejects.toThrow(/at least 24/);
  });
});
