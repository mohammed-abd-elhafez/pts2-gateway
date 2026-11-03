import { Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '../src/api/clients.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { resetDb, testPool, TEST_DB_URL } from './helpers/db.js';
import { createPool } from '../src/db/pool.js';
import {
  emitReadings,
  insertReading,
  minuteAt,
  seedCodedStation,
  seedCodedTank,
  seedRefs,
  type CodedTank,
} from './helpers/fixtures.js';

const pool = testPool(12);
const NOW = new Date('2026-11-03T12:00:00Z');
const config = loadConfig({ DATABASE_URL: TEST_DB_URL, LOG_LEVEL: 'silent' });
const app = buildApp({ pool, config, now: () => NOW, logStream: new Writable({ write: (_c, _e, cb) => cb() }) });

let key: string;
let A: CodedTank;
let B: CodedTank;

beforeEach(async () => {
  await resetDb(pool);
  await seedRefs(pool);
  const st = await seedCodedStation(pool, 1);
  A = await seedCodedTank(pool, st, 1);
  B = await seedCodedTank(pool, st, 2);
  key = (await createClient(pool, 'client system')).key;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const S = '/v1/stations/OP-1';
const bearer = () => ({ authorization: `Bearer ${key}` });
const get = (url: string, headers: Record<string, string> = bearer()) => app.inject({ method: 'GET', url, headers });
const post = (url: string, payload: unknown, headers: Record<string, string> = bearer()) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload: payload as never });

describe('authentication', () => {
  const routes: Array<['GET' | 'POST', string]> = [
    ['GET', S + '/readings/batches/next'],
    ['POST', S + '/readings/batches/1/result'],
    ['POST', S + '/tanks/ST-000001-1/anchor'],
  ];

  it.each(routes)('%s %s refuses a missing key', async (method, url) => {
    const res = await app.inject({ method, url, payload: method === 'POST' ? '{}' : undefined, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it.each(routes)('%s %s refuses a wrong key, a revoked key and another scheme', async (method, url) => {
    const send = (authorization: string) =>
      app.inject({ method, url, headers: { authorization, 'content-type': 'application/json' }, payload: method === 'POST' ? '{}' : undefined });
    expect((await send('Bearer pts2_not-a-key')).statusCode).toBe(401);
    expect((await send(`Basic ${Buffer.from(`x:${key}`).toString('base64')}`)).statusCode).toBe(401);
    await pool.query(`UPDATE api_clients SET revoked_at = now()`);
    expect((await send(`Bearer ${key}`)).statusCode).toBe(401);
  });

  it('refuses before reading the body: broken JSON without a key is 401, not 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: S + '/readings/batches/1/result',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(401);
  });

  it('stores only a hash of the key', async () => {
    const { rows } = await pool.query(`SELECT key_hash FROM api_clients`);
    expect(JSON.stringify(rows)).not.toContain(key);
  });
});

describe('GET /v1/readings/batches/next', () => {
  it('answers 204 with no body when nothing is ready', async () => {
    const res = await get(S + '/readings/batches/next');
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('runs the ledger first, so stored readings appear without any other step', async () => {
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '31790', temperature: '28.5' });
    const res = await get(S + '/readings/batches/next');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['x-batch-id']).toMatch(/^\d+$/);
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.json()).toEqual({
      readings: [
        {
          station_code: A.stationCode,
          tank_code: A.code,
          fuel_quantity: 31790,
          consumed_quantity: 0,
          fuel_height: 0.5,
          water_quantity: 0.5,
          water_height: 0.01,
          temperature: 28.5,
          remaining_quantity: 31790,
          reading_at: '2026-11-03T10:00:00Z',
        },
      ],
    });
  });

  it('returns the same batch, id and body until its result is posted', async () => {
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }]);
    const first = await get(S + '/readings/batches/next');
    await emitReadings(pool, A.id, [{ minute: 1, fuel: '990' }]);
    const again = await get(S + '/readings/batches/next');
    expect(again.headers['x-batch-id']).toBe(first.headers['x-batch-id']);
    expect(again.body).toBe(first.body);
  });
});

describe('POST /v1/readings/batches/:id/result', () => {
  async function openBatch(): Promise<string> {
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }, { minute: 2, fuel: '990' }]);
    return (await get(S + '/readings/batches/next')).headers['x-batch-id'] as string;
  }

  it('closes the batch on a 200 answer, replays an identical repeat, and refuses a different one', async () => {
    const id = await openBatch();
    const ok = { status_code: 200, body: { status: 'accepted', message: 'Batch accepted.', accepted_count: 2 } };

    const first = await post(`${S}/readings/batches/${id}/result`, ok);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ batch_id: Number(id), batch_status: 'accepted', action: 'accepted', replayed: false });

    const again = await post(`${S}/readings/batches/${id}/result`, ok);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ batch_status: 'accepted', replayed: true });

    const different = await post(`${S}/readings/batches/${id}/result`, { status_code: 500 });
    expect(different.statusCode).toBe(409);
    expect(different.json()).toEqual({ error: 'batch_closed', field: 'id' });

    expect((await get(S + '/readings/batches/next')).statusCode).toBe(204);
  });

  it('tells the client to resend on a retryable answer and keeps the same batch', async () => {
    const id = await openBatch();
    const res = await post(`${S}/readings/batches/${id}/result`, { status_code: 503 });
    expect(res.json()).toMatchObject({ batch_status: 'open', action: 'resend_same_body' });
    expect((await get(S + '/readings/batches/next')).headers['x-batch-id']).toBe(id);
  });

  it('answers 404 for a batch that does not exist or an id that is not a number', async () => {
    expect((await post(S + '/readings/batches/999999/result', { status_code: 200 })).json()).toEqual({ error: 'not_found', field: 'id' });
    expect((await post(S + '/readings/batches/abc/result', { status_code: 200 })).statusCode).toBe(404);
  });

  it.each([
    ['a missing status_code', {}, 'status_code'],
    ['an extra property', { status_code: 200, extra: 1 }, 'extra'],
    ['a status_code that is not an integer', { status_code: '200' }, 'status_code'],
    ['a status_code below 100', { status_code: 99 }, 'status_code'],
    ['a status_code above 599', { status_code: 600 }, 'status_code'],
  ])('answers 422 naming the field for %s', async (_name, payload, field) => {
    const id = await openBatch();
    const res = await post(`${S}/readings/batches/${id}/result`, payload);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'invalid_request', field });
  });

  it('answers 422 for a body that is not JSON or not an object, and 415 for an unsupported content type', async () => {
    const id = await openBatch();
    const send = (contentType: string, payload: string) =>
      app.inject({
        method: 'POST',
        url: `${S}/readings/batches/${id}/result`,
        headers: { ...bearer(), 'content-type': contentType },
        payload,
      });

    const broken = await send('application/json', '{ nope');
    expect(broken.statusCode).toBe(422);
    expect(broken.json()).toMatchObject({ error: 'invalid_request', field: 'body' });

    expect((await send('application/json', '')).statusCode).toBe(422);
    expect((await send('application/json', '[1,2]')).statusCode).toBe(422);
    expect((await send('text/plain', 'hello')).statusCode).toBe(422);
    expect((await send('application/xml', '<a/>')).statusCode).toBe(415);
  });

  it('carries a chain break through to a held tank, a rebuilt batch, an anchor and a resumed chain', async () => {
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }, { minute: 2, fuel: '990' }]);
    await emitReadings(pool, B.id, [{ minute: 1, fuel: '500' }, { minute: 3, fuel: '490' }]);
    const first = await get(S + '/readings/batches/next');
    const id = first.headers['x-batch-id'];

    const broken = await post(`${S}/readings/batches/${id}/result`, {
      status_code: 422,
      body: { errors: [{ code: 'x', message: 'item_index: 1 - field: fuel_quantity', sourceErrorCode: 'REMAINING_QUANTITY_INCONSISTENT', sourceMessage: 'Continuity break' }] },
    });
    expect(broken.json()).toMatchObject({ batch_status: 'rejected', action: 'tank_held_rebuilt', held_tank: B.code });

    // the rebuilt batch has tank A only
    const second = await get(S + '/readings/batches/next');
    expect(second.headers['x-batch-id']).not.toBe(id);
    expect(second.json().readings.map((r: { tank_code: string }) => r.tank_code)).toEqual([A.code, A.code]);

    // tank B cannot be anchored while A's batch is open? B has nothing unsent, so it can
    const anchored = await post(`${S}/tanks/${B.code}/anchor`, { remaining_quantity: '505.000', reason: 'MoEnergy support confirmed' });
    expect(anchored.statusCode).toBe(200);
    expect(anchored.json()).toEqual({ tank_code: B.code, remaining_quantity: 505, chain_held: false });

    await post(`${S}/readings/batches/${second.headers['x-batch-id']}/result`, { status_code: 200, body: { accepted_count: 2 } });
    const third = await get(S + '/readings/batches/next');
    expect(third.json().readings).toMatchObject([
      { tank_code: B.code, fuel_quantity: 505, consumed_quantity: 5, remaining_quantity: 500 },
      { tank_code: B.code, fuel_quantity: 500, consumed_quantity: 10, remaining_quantity: 490 },
    ]);
  });
});

describe('POST /v1/tanks/:tank_code/anchor', () => {
  const body = { remaining_quantity: 5000, reason: 'tank already reports to MoEnergy' };

  it('answers 404 for an unknown tank code', async () => {
    expect((await post(S + '/tanks/ST-999999-1/anchor', body)).json()).toEqual({ error: 'not_found', field: 'tank_code' });
  });

  it.each([
    ['a text that is not a number', { ...body, remaining_quantity: 'abc' }, 'remaining_quantity'],
    ['a negative quantity', { ...body, remaining_quantity: -1 }, 'remaining_quantity'],
    ['an exponent form', { ...body, remaining_quantity: '1e3' }, 'remaining_quantity'],
    ['a missing reason', { remaining_quantity: 5 }, 'reason'],
    ['an empty reason', { remaining_quantity: 5, reason: '' }, 'reason'],
    ['an unknown property', { ...body, who: 'me' }, 'who'],
  ])('answers 422 for %s', async (_name, payload, field) => {
    const res = await post(`${S}/tanks/${A.code}/anchor`, payload);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ field });
  });

  it('uses the configured number of decimals for the value it keeps (two by default)', async () => {
    const res = await post(`${S}/tanks/${A.code}/anchor`, { ...body, remaining_quantity: '505.125' });
    expect(res.statusCode).toBe(200);
    expect(res.json().remaining_quantity).toBe(505.13);
    expect((await post(`${S}/tanks/${A.code}/anchor`, { ...body, remaining_quantity: '505.1255' })).statusCode).toBe(422);
  });

  it('answers 409 while the tank still has readings MoEnergy has not accepted', async () => {
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }]);
    const res = await post(`${S}/tanks/${A.code}/anchor`, body);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'tank_has_unsent_readings', field: 'tank_code' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM chain_anchors`)).rows[0].n).toBe(0);
  });

  it('starts a tank that already reports to MoEnergy from the given quantity and records who set it', async () => {
    expect((await post(`${S}/tanks/${A.code}/anchor`, body)).statusCode).toBe(200);
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '4990' });
    const batch = await get(S + '/readings/batches/next');
    expect(batch.json().readings[0]).toMatchObject({ fuel_quantity: 5000, consumed_quantity: 10, remaining_quantity: 4990 });
    const row = (await pool.query(`SELECT set_by, reason FROM chain_anchors`)).rows[0];
    expect(row).toEqual({ set_by: 'client system', reason: 'tank already reports to MoEnergy' });
  });
});

describe('one link per station', () => {
  async function secondStation() {
    const st2 = await seedCodedStation(pool, 2);
    const C = await seedCodedTank(pool, st2, 1);
    return { st2, C, base: `/v1/stations/${st2.operatorCode}` };
  }

  it("gives every station its own batch, carrying only that station's tanks", async () => {
    const { C, base } = await secondStation();
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }]);
    await emitReadings(pool, C.id, [{ minute: 0, fuel: '2000' }]);

    const one = await get(`${S}/readings/batches/next`);
    const two = await get(`${base}/readings/batches/next`);
    expect(one.headers['x-batch-id']).not.toBe(two.headers['x-batch-id']);
    expect(one.json().readings.map((r: { tank_code: string }) => r.tank_code)).toEqual([A.code]);
    expect(two.json().readings.map((r: { tank_code: string }) => r.tank_code)).toEqual([C.code]);
  });

  it("keeps one station's unreported batch from holding up another", async () => {
    const { C, base } = await secondStation();
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }]);
    const stuck = await get(`${S}/readings/batches/next`); // station 1 never posts a result

    await emitReadings(pool, C.id, [{ minute: 0, fuel: '2000' }, { minute: 1, fuel: '1990' }]);
    const other = await get(`${base}/readings/batches/next`);
    expect(other.statusCode).toBe(200);
    const done = await post(`${base}/readings/batches/${other.headers['x-batch-id']}/result`, { status_code: 200, body: { accepted_count: 2 } });
    expect(done.json()).toMatchObject({ batch_status: 'accepted' });
    expect((await get(`${base}/readings/batches/next`)).statusCode).toBe(204);
    expect((await get(`${S}/readings/batches/next`)).headers['x-batch-id']).toBe(stuck.headers['x-batch-id']);
  });

  it("only runs the ledger for the station that asked", async () => {
    const { C, base } = await secondStation();
    const pending = await insertReading(pool, C.id, { at: minuteAt(0), fuel: '2000' });
    expect((await get(`${S}/readings/batches/next`)).statusCode).toBe(204);
    expect((await pool.query(`SELECT ledger_status FROM readings WHERE id = $1`, [pending])).rows[0].ledger_status).toBe('pending');
    expect((await get(`${base}/readings/batches/next`)).statusCode).toBe(200);
  });

  it("answers 404 when a batch id from another station is used", async () => {
    const { C, base } = await secondStation();
    await emitReadings(pool, C.id, [{ minute: 0, fuel: '2000' }]);
    const theirs = (await get(`${base}/readings/batches/next`)).headers['x-batch-id'];
    const res = await post(`${S}/readings/batches/${theirs}/result`, { status_code: 200, body: { accepted_count: 1 } });
    expect(res.statusCode).toBe(404);
    expect((await pool.query(`SELECT status FROM batches WHERE id = $1`, [theirs])).rows[0].status).toBe('open');
  });

  it("answers 404 when an anchor names a tank of another station", async () => {
    const { C } = await secondStation();
    const res = await post(`${S}/tanks/${C.code}/anchor`, { remaining_quantity: 5, reason: 'x' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', field: 'tank_code' });
  });

  it('finds the station by its code whatever the case, and answers 404 for an unknown one', async () => {
    expect((await get('/v1/stations/op-1/readings/batches/next')).statusCode).toBe(204);
    const unknown = await get('/v1/stations/NOPE/readings/batches/next');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not_found', field: 'station_code' });
  });

  it('checks the key before the station, so an unknown station is not revealed without one', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/stations/NOPE/readings/batches/next' });
    expect(res.statusCode).toBe(401);
  });

  it('answers 404 for an unknown station before reading the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stations/NOPE/readings/batches/1/result',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(404);
  });

  describe('a key bound to one station', () => {
    it('opens that station and no other, on every route, and hides the other as not found', async () => {
      const { base } = await secondStation();
      const { key: own } = await createClient(pool, 'station one only', { stationId: (await pool.query(`SELECT id FROM stations WHERE operator_station_code = 'OP-1'`)).rows[0].id });
      const as = { authorization: `Bearer ${own}` };

      expect((await get(`${S}/readings/batches/next`, as)).statusCode).toBe(204);
      expect((await get(`${base}/readings/batches/next`, as)).statusCode).toBe(404);
      expect((await post(`${base}/readings/batches/1/result`, { status_code: 200 }, as)).statusCode).toBe(404);
      expect((await post(`${base}/tanks/ST-000002-1/anchor`, { remaining_quantity: 1, reason: 'x' }, as)).statusCode).toBe(404);

      // the all-stations key still reaches both
      expect((await get(`${base}/readings/batches/next`)).statusCode).toBe(204);
      expect((await get(`${S}/readings/batches/next`)).statusCode).toBe(204);
    });

    it("answers a foreign station exactly as it answers a station that does not exist", async () => {
      const { base } = await secondStation();
      const { key: own } = await createClient(pool, 'station one only', { stationId: (await pool.query(`SELECT id FROM stations WHERE operator_station_code = 'OP-1'`)).rows[0].id });
      const as = { authorization: `Bearer ${own}` };
      const foreign = await get(`${base}/readings/batches/next`, as);
      const missing = await get('/v1/stations/NOPE/readings/batches/next', as);
      expect(foreign.statusCode).toBe(missing.statusCode);
      expect(foreign.json()).toEqual(missing.json());
    });
  });
});

describe('requests that do not match a route or a station', () => {
  it('answers a plain 404 that never echoes the path', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope/secret-looking-thing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('refuses a body over 1 MB on any route that is not ingest', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/nope',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it.each([
    ['a NUL byte', '/v1/stations/a%00b/readings/batches/next'],
    ['a control character', '/v1/stations/a%0Ab/readings/batches/next'],
    ['65 characters', '/v1/stations/' + 'x'.repeat(65) + '/readings/batches/next'],
  ])('answers the same 404 for a station code with %s', async (_name, url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', field: 'station_code' });
  });
});

describe('result correlation id', () => {
  it('refuses a result that names another send with 409, and accepts the right one', async () => {
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }]);
    const batch = await get(S + '/readings/batches/next');
    const id = batch.headers['x-batch-id'];

    const wrong = await post(`${S}/readings/batches/${id}/result`, { status_code: 200, body: { accepted_count: 1 }, correlation_id: 'someone-elses-send' });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toEqual({ error: 'correlation_mismatch', field: 'correlation_id' });

    const right = await post(`${S}/readings/batches/${id}/result`, { status_code: 200, body: { accepted_count: 1 }, correlation_id: batch.headers['x-correlation-id'] });
    expect(right.json()).toMatchObject({ batch_status: 'accepted' });
  });
});

describe('when the database is slow or busy', () => {
  it('answers 503 busy instead of hanging when a station lock cannot be taken in time', async () => {
    const quick = createPool(TEST_DB_URL, 4, { lockTimeoutMs: 300 });
    const busy = buildApp({ pool: quick, config, now: () => NOW, logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
    const stationId = (await pool.query(`SELECT id FROM stations WHERE operator_station_code = 'OP-1'`)).rows[0].id;
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(727002, $1::int)', [stationId]);
      const started = Date.now();
      const res = await busy.inject({ method: 'GET', url: `${S}/readings/batches/next`, headers: bearer() });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'busy' });
      expect(res.headers['retry-after']).toBe('2');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
      await busy.close();
      await quick.end();
    }
    expect((await get(S + '/readings/batches/next')).statusCode).toBe(204);
  });
});

describe('one tank that cannot be processed', () => {
  it("does not stop the station's other tanks or its open batch", async () => {
    await emitReadings(pool, A.id, [{ minute: 0, fuel: '1000' }]);
    const first = await get(S + '/readings/batches/next');
    expect(first.statusCode).toBe(200);

    // from now on, writing tank B's emitted readings fails
    await pool.query(`
      CREATE FUNCTION poison_b() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tank_id = ${B.id} THEN RAISE EXCEPTION 'poisoned'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER poison_b BEFORE INSERT ON emitted_readings FOR EACH ROW EXECUTE FUNCTION poison_b();`);
    try {
      await insertReading(pool, B.id, { at: minuteAt(0), fuel: '500' });
      await insertReading(pool, A.id, { at: minuteAt(5), fuel: '990' });
      const again = await get(S + '/readings/batches/next');
      expect(again.statusCode).toBe(200);
      expect(again.headers['x-batch-id']).toBe(first.headers['x-batch-id']); // the open batch is still served

      await post(`${S}/readings/batches/${first.headers['x-batch-id']}/result`, { status_code: 200, body: { accepted_count: 1 } });
      const next = await get(S + '/readings/batches/next');
      expect(next.statusCode).toBe(200);
      expect(next.json().readings.map((r: { tank_code: string }) => r.tank_code)).toEqual([A.code]); // A went on, B waits
      expect((await pool.query(`SELECT ledger_status FROM readings WHERE tank_id = $1`, [B.id])).rows[0].ledger_status).toBe('pending');
    } finally {
      await pool.query('DROP TRIGGER poison_b ON emitted_readings; DROP FUNCTION poison_b();');
    }
  });
});
