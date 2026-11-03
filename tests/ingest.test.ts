import { Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createStation } from '../src/stations/create.js';
import { resetDb, testPool, TEST_DB_URL } from './helpers/db.js';

const pool = testPool(6);
const config = loadConfig({ DATABASE_URL: TEST_DB_URL, LOG_LEVEL: 'info', CAPTURE_REPLY_BODY: '{"reply":"stub"}' });

let logs = '';
const logStream = new Writable({
  write(chunk, _enc, cb) {
    logs += chunk.toString();
    cb();
  },
});
const app = buildApp({ pool, config, logStream });

beforeEach(async () => {
  logs = '';
  await resetDb(pool);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const rows = async () => (await pool.query(`SELECT * FROM raw_uploads ORDER BY id`)).rows;

describe('capture endpoint', () => {
  it('refuses an unknown secret and stores nothing', async () => {
    await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    const res = await app.inject({ method: 'POST', url: '/pts/not-a-real-secret', payload: '{"x":1}' });
    expect(res.statusCode).toBe(401);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a request that carries no secret at all', async () => {
    const res = await app.inject({ method: 'POST', url: '/pts', payload: '{}' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the secret in the path, stores exact bytes and answers with the configured reply', async () => {
    const { id, secret } = await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    const body = '{"Packets":[{"Id":1,"Type":"Anything"}]}';
    const res = await app.inject({
      method: 'POST',
      url: `/pts/${secret}/upload?a=1`,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"reply":"stub"}');

    const [row] = await rows();
    expect(Number(row.station_id)).toBe(id);
    expect(row.path).toBe('/pts/***/upload');
    expect(row.query).toBe('a=1');
    expect(row.body_raw.toString('utf8')).toBe(body);
    expect(row.body_json).toEqual(JSON.parse(body));
    expect(row.parse_status).toBe('captured');

    const seen = await pool.query(`SELECT last_seen_at FROM stations WHERE id = $1`, [id]);
    expect(seen.rows[0].last_seen_at).not.toBeNull();
  });

  it('accepts the secret as the Basic password', async () => {
    const { secret } = await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    const auth = 'Basic ' + Buffer.from(`pts:${secret}`).toString('base64');
    const res = await app.inject({ method: 'POST', url: '/pts', headers: { authorization: auth }, payload: '{}' });
    expect(res.statusCode).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it('keeps a body that is not JSON, and an empty body', async () => {
    const { secret } = await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    const bin = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    const a = await app.inject({
      method: 'POST',
      url: `/pts/${secret}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: bin,
    });
    const b = await app.inject({ method: 'GET', url: `/pts/${secret}` });
    const c = await app.inject({
      method: 'POST',
      url: `/pts/${secret}`,
      headers: { 'content-type': 'application/json' },
      payload: '{broken json',
    });
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([200, 200, 200]);

    const [r1, r2, r3] = await rows();
    expect(Buffer.compare(r1.body_raw, bin)).toBe(0);
    expect(r1.body_json).toBeNull();
    expect(r2.body_bytes).toBe(0);
    expect(r3.body_raw.toString()).toBe('{broken json');
    expect(r3.body_json).toBeNull();
  });

  it('keeps a 100,000-record backlog intact', async () => {
    const { secret } = await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    const records = Array.from({ length: 100_000 }, (_, i) => ({ T: 1, V: i }));
    const body = JSON.stringify({ Packets: records });
    expect(body.length).toBeGreaterThan(1_000_000);

    const res = await app.inject({
      method: 'POST',
      url: `/pts/${secret}`,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const [row] = await rows();
    expect(row.body_bytes).toBe(Buffer.byteLength(body));
    expect(row.body_json.Packets).toHaveLength(100_000);
  });

  it('answers 413 above the body limit and stores nothing', async () => {
    const small = buildApp({ pool, config: { ...config, bodyLimitBytes: 2048 }, logStream });
    const { secret } = await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    const res = await small.inject({
      method: 'POST',
      url: `/pts/${secret}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(5000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(await rows()).toHaveLength(0);
    await small.close();
  });

  it('never writes the secret or credentials to storage or logs', async () => {
    const { secret } = await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    const auth = 'Basic ' + Buffer.from(`pts:${secret}`).toString('base64');
    await app.inject({ method: 'POST', url: `/pts/${secret}/x`, headers: { authorization: auth }, payload: '{}' });
    await app.inject({ method: 'POST', url: `/pts/${secret}/x`, payload: '{}' });
    await app.inject({ method: 'POST', url: `/pts/wrong-secret-value/x`, payload: '{}' });

    // The check below is only meaningful if requests were really logged.
    expect(logs).toContain('upload captured');
    expect(logs).toContain('/pts/***/x');

    const stored = JSON.stringify(await rows());
    expect(stored).not.toContain(secret);
    expect(stored.toLowerCase()).not.toContain('authorization');
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain(Buffer.from(`pts:${secret}`).toString('base64'));
    expect(logs).not.toContain('wrong-secret-value');
  });
});

describe('before the body is read', () => {
  it('answers 401 for an unknown secret without reading a body far over the limit', async () => {
    await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    const big = Buffer.alloc(config.bodyLimitBytes + 5 * 1024 * 1024, 0x61);
    const res = await app.inject({ method: 'POST', url: '/pts/not-a-real-secret', headers: { 'content-type': 'application/json' }, payload: big });
    expect(res.statusCode).toBe(401); // not 413: the secret is checked first
    expect(await rows()).toHaveLength(0);
  });

  it('does not take a secret from a path with an empty segment', async () => {
    const { secret } = await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    for (const url of [`/pts//${secret}`, `/pts///${secret}/x`, `/pts/${secret}//x`]) {
      const res = await app.inject({ method: 'POST', url, payload: '{}', headers: { 'content-type': 'application/json' } });
      expect(res.statusCode, url).toBe(401);
    }
    expect(await rows()).toHaveLength(0);
    expect(logs).not.toContain(secret);
  });
});

describe('the secret never lands anywhere', () => {
  it('is removed from header values and the query string before storing, and kept out of the logs', async () => {
    const { secret } = await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    logs = '';
    const res = await app.inject({
      method: 'POST',
      url: `/pts/${secret}/x?token=${secret}&a=1`,
      headers: { 'content-type': 'application/json', 'x-original-uri': `/pts/${secret}/x`, referer: `https://h/pts/${secret}` },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    const [row] = await rows();
    expect(JSON.stringify(row.headers)).not.toContain(secret);
    expect(row.headers['x-original-uri']).toBe('/pts/***/x');
    expect(row.query).toBe('token=***&a=1');
    expect(row.path).toBe('/pts/***/x');
    // and the request log has the path only, never the query string
    expect(logs).not.toContain(secret);
    expect(logs).toContain('/pts/***/x');
    expect(logs).toContain('[omitted]');
  });

  it('is not echoed or logged when a method nobody handles is used', async () => {
    const { secret } = await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    logs = '';
    for (const method of ['DELETE', 'PATCH'] as const) {
      const res = await app.inject({ method, url: `/pts/${secret}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
      expect(res.body).not.toContain(secret);
    }
    expect(logs).not.toContain(secret);
  });
});

describe('JSON that PostgreSQL refuses', () => {
  it.each([
    ['a lone surrogate escape', '"\\ud800"'],
    ['a lone low surrogate inside an object', '{"a":"\\udc00x"}'],
    ['an array nested 20,000 deep', '['.repeat(20_000) + ']'.repeat(20_000)],
  ])('keeps the raw bytes of %s and answers 200, so the controller does not resend forever', async (_name, body) => {
    const { secret } = await createStation(pool, { operatorStationCode: 'A', name: 'A' });
    const res = await app.inject({ method: 'POST', url: `/pts/${secret}`, headers: { 'content-type': 'application/json' }, payload: body });
    expect(res.statusCode).toBe(200);
    const [row] = await rows();
    expect(row.body_raw.toString('utf8')).toBe(body);
    expect(row.body_json).toBeNull();
    expect(row.body_bytes).toBe(Buffer.byteLength(body));
  });
});

describe('health', () => {
  it('reports liveness without touching the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('reports ready while the database answers and 503 when it does not', async () => {
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);

    const dead = testPool(1);
    const deadApp = buildApp({ pool: dead, config, logStream });
    await dead.end();
    expect((await deadApp.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    await deadApp.close();
  });
});
