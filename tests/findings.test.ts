/**
 * Review reproductions. Each test states the behaviour we want, so a FAILING test is a confirmed finding.
 * A passing test is a hypothesis that did not hold.
 */
import { mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '../src/api/clients.js';
import { buildApp } from '../src/app.js';
import { getOrCreateNextBatch } from '../src/batches/builder.js';
import { applyResult } from '../src/batches/result.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { parseMilli } from '../src/domain/quantity.js';
import { processTank, setAnchor } from '../src/ledger/service.js';
import { hashSecret } from '../src/ingest/auth.js';
import { resetDb, testPool, TEST_DB_URL } from './helpers/db.js';
import { insertReading, insertStation, minuteAt, seedCodedStation, seedCodedTank, seedRefs, type CodedStation, type CodedTank } from './helpers/fixtures.js';
import { cycle, FakeMoEnergy, ledgerAccepted, LEDGER, moenergyError, OPTS } from './review-helpers.js';

const pool = testPool(12);
const config = loadConfig({ DATABASE_URL: TEST_DB_URL });

let ST: CodedStation;
let A: CodedTank;

beforeEach(async () => {
  await resetDb(pool);
  await seedRefs(pool);
  ST = await seedCodedStation(pool, 1);
  A = await seedCodedTank(pool, ST, 1);
});
afterAll(() => pool.end());

const status = async (tankId: number) =>
  (await pool.query<{ ledger_status: string }>(`SELECT ledger_status FROM readings WHERE tank_id = $1 ORDER BY effective_at`, [tankId])).rows.map(
    (r) => r.ledger_status,
  );
const held = async (tankId: number) => (await pool.query(`SELECT chain_held FROM tanks WHERE id = $1`, [tankId])).rows[0].chain_held as boolean;
const at = (m: number) => minuteAt(m).replace('.000Z', 'Z');

describe('chain: a low reading must not kill the tank', () => {
  it('F1a: a tank that read 0 L goes on after a refill', async () => {
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '1000', water: '0' });
    await insertReading(pool, A.id, { at: minuteAt(1), fuel: '0', water: '0' });
    for (let m = 2; m < 7; m += 1) await insertReading(pool, A.id, { at: minuteAt(m), fuel: '5000', water: '0' });
    await processTank(pool, A.id, LEDGER);
    expect(await status(A.id)).not.toContain('quarantined');
  });

  it('F1b: a reading below the water level does not make every later reading unsendable', async () => {
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '1000', water: '10' });
    await insertReading(pool, A.id, { at: minuteAt(1), fuel: '5', water: '10' });
    for (let m = 2; m < 7; m += 1) await insertReading(pool, A.id, { at: minuteAt(m), fuel: '5000', water: '10' });
    await processTank(pool, A.id, LEDGER);
    const s = await status(A.id);
    expect(s.slice(2).filter((x) => x === 'quarantined')).toEqual([]);
  });

  it('F2: a corrupt volume the column accepts is set aside, not a tank that fails forever', async () => {
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '4294967295' });
    await insertReading(pool, A.id, { at: minuteAt(1), fuel: '1000' });
    await expect(processTank(pool, A.id, LEDGER)).resolves.toBeDefined();
    expect(await status(A.id)).toEqual(['quarantined', 'emitted']);
  });

  it('F3: a second late reading is re-chained when everything after it is unsent, even if the first late one could not be', async () => {
    await insertReading(pool, A.id, { at: minuteAt(10), fuel: '1000' });
    const fake = new FakeMoEnergy();
    await cycle(pool, ST.id, fake); // minute 10 is at MoEnergy
    await insertReading(pool, A.id, { at: minuteAt(20), fuel: '990' });
    await insertReading(pool, A.id, { at: minuteAt(30), fuel: '970' });
    await processTank(pool, A.id, LEDGER); // 20 and 30 are chained and unsent
    await insertReading(pool, A.id, { at: minuteAt(5), fuel: '1005' }); // really late
    const q = await insertReading(pool, A.id, { at: minuteAt(25), fuel: '980' }); // can go back in order
    await processTank(pool, A.id, LEDGER);
    const row = (await pool.query(`SELECT ledger_status FROM readings WHERE id = $1`, [q])).rows[0];
    expect(row.ledger_status).toBe('emitted');
  });
});

describe('item 3 and anchors: readings MoEnergy already holds', () => {
  it('F4: first start of an existing tank with an overlapping backlog loses nothing', async () => {
    const fake = new FakeMoEnergy();
    fake.seed(A.code, at(0), 1000);
    fake.seed(A.code, at(1), 990);
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '1000' });
    await insertReading(pool, A.id, { at: minuteAt(1), fuel: '990' });
    await insertReading(pool, A.id, { at: minuteAt(2), fuel: '980' });
    await insertReading(pool, A.id, { at: minuteAt(3), fuel: '970' });
    await setAnchor(pool, A.id, parseMilli('990'), 'MoEnergy support confirmed', 'test', { requireNoUnsent: true });

    for (let i = 0; i < 6; i += 1) await cycle(pool, ST.id, fake);
    const storedTimes = (fake.stored.get(A.code) ?? []).map((r) => r.reading_at);
    // everything we call accepted must really be at MoEnergy
    for (const t of await ledgerAccepted(pool, A.id)) expect(storedTimes).toContain(t);
    expect(storedTimes).toContain(at(3));
  });

  it('F5: a tank whose backlog holds a stored reading in the middle has a way out', async () => {
    const fake = new FakeMoEnergy();
    fake.seed(A.code, at(2), 980);
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '1000' });
    await insertReading(pool, A.id, { at: minuteAt(1), fuel: '990' });
    await insertReading(pool, A.id, { at: minuteAt(2), fuel: '980' });
    await insertReading(pool, A.id, { at: minuteAt(3), fuel: '970' });
    for (let round = 0; round < 4; round += 1) {
      await setAnchor(pool, A.id, parseMilli('980'), 'what MoEnergy holds', 'test', { requireNoUnsent: true });
      await cycle(pool, ST.id, fake);
    }
    expect(await held(A.id)).toBe(false);
  });

  it('F6: a batch that came back with a short count can still be closed', async () => {
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '1000' });
    await insertReading(pool, A.id, { at: minuteAt(1), fuel: '990' });
    const batch = (await (async () => {
      await processTank(pool, A.id, LEDGER);
      return getOrCreateNextBatch(pool, ST.id, OPTS);
    })())!;
    await applyResult(pool, ST.id, batch.id, { status: 200, body: { accepted_count: 1 } });
    const resend = await applyResult(pool, ST.id, batch.id, { status: 422, body: moenergyError(0, 'DUPLICATE_READING_STORED') });
    expect(resend.outcome.batch_status).not.toBe('open');
  });
});

describe('anchor semantics', () => {
  it('F7: under the hold policy a refill can be passed by anchoring what MoEnergy really holds', async () => {
    const fake = new FakeMoEnergy();
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '1000' });
    await cycle(pool, ST.id, fake, 'hold');
    await insertReading(pool, A.id, { at: minuteAt(1), fuel: '5000' }); // refill
    await cycle(pool, ST.id, fake, 'hold');
    expect(await held(A.id)).toBe(true);
    await setAnchor(pool, A.id, parseMilli(String(fake.last(A.code)!.remaining_quantity)), 'what MoEnergy holds', 'test', { requireNoUnsent: true });
    await cycle(pool, ST.id, fake, 'hold');
    expect(await held(A.id)).toBe(false);
  });

  it('F8: when MoEnergy refuses negative consumed, a true anchor does not set aside one good reading per round', async () => {
    const fake = new FakeMoEnergy();
    fake.refuseNegative = true;
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '1000' });
    await cycle(pool, ST.id, fake);
    for (let m = 1; m <= 5; m += 1) await insertReading(pool, A.id, { at: minuteAt(m), fuel: String(5000 - m) });
    for (let round = 0; round < 3; round += 1) {
      await cycle(pool, ST.id, fake);
      await setAnchor(pool, A.id, parseMilli(String(fake.last(A.code)!.remaining_quantity)), 'what MoEnergy holds', 'test', { requireNoUnsent: true });
    }
    const quarantined = (await status(A.id)).filter((s) => s === 'quarantined').length;
    expect(quarantined).toBeLessThanOrEqual(1);
  });

  it('F9: an anchor above the tank capacity is refused', async () => {
    const app = buildApp({ pool, config, now: OPTS.now });
    const { key } = await createClient(pool, 'k');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/stations/${ST.operatorCode}/tanks/${A.code}/anchor`,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: { remaining_quantity: 60000000, reason: 'typo' },
    });
    await app.close();
    expect(res.statusCode).toBe(422);
  });

  it('F10: an anchor with more than 3 decimals is refused, as the guide says', async () => {
    const app = buildApp({ pool, config, now: OPTS.now });
    const { key } = await createClient(pool, 'k');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/stations/${ST.operatorCode}/tanks/${A.code}/anchor`,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: { remaining_quantity: '505.0005', reason: 'rounding' },
    });
    await app.close();
    expect(res.statusCode).toBe(422);
  });
});

describe('concurrency', () => {
  it('F11: a re-chain landing inside a batch build cannot produce a batch that differs from its rows', async () => {
    await insertReading(pool, A.id, { at: minuteAt(10), fuel: '1000' });
    await insertReading(pool, A.id, { at: minuteAt(20), fuel: '980' });
    await processTank(pool, A.id, LEDGER);
    await insertReading(pool, A.id, { at: minuteAt(15), fuel: '990' }); // late, everything after is unsent

    // The second GET's ledger run commits between the first GET's candidate read and its UPDATE.
    let fired = false;
    const spy = Object.create(pool) as Pool;
    spy.connect = (async () => {
      const client = await pool.connect();
      const original = client.query.bind(client);
      const release = client.release.bind(client);
      (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        if (!fired && typeof args[0] === 'string' && args[0].includes('UPDATE emitted_readings e SET batch_id')) {
          fired = true;
          await processTank(pool, A.id, LEDGER);
        }
        return (original as (...a: unknown[]) => unknown)(...args);
      };
      client.release = (...r) => {
        (client as unknown as { query: unknown }).query = original;
        client.release = release;
        return release(...r);
      };
      return client;
    }) as Pool['connect'];

    const built = await getOrCreateNextBatch(spy, ST.id, OPTS);
    expect(fired).toBe(true);
    const inBatch = (await pool.query(`SELECT count(*)::int AS n FROM emitted_readings WHERE batch_id = $1`, [built?.id ?? 0])).rows[0].n;
    expect.soft(inBatch).toBe(built?.itemCount ?? 0);
    await expect.soft(getOrCreateNextBatch(pool, ST.id, OPTS)).resolves.toBeDefined();
  });

  it('F12: one station waiting on its lock does not stop another station uploading', async () => {
    const small = createPool(TEST_DB_URL, 10, { connectionTimeoutMs: 1000, lockTimeoutMs: 8000 });
    const other = await insertStation(pool, { code: 'OTHER' });
    const app = buildApp({ pool: small, config, now: OPTS.now });
    await app.ready();
    const { key } = await createClient(pool, 'k');
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(727002, $1::int)', [ST.id]);
    const waiting = Array.from({ length: 12 }, () =>
      app.inject({ method: 'GET', url: `/v1/stations/${ST.operatorCode}/readings/batches/next`, headers: { authorization: `Bearer ${key}` } }),
    );
    await new Promise((r) => setTimeout(r, 1500));
    const upload = await app.inject({ method: 'POST', url: `/pts/${other.secret}`, headers: { 'content-type': 'application/json' }, payload: '{}' });
    await holder.query('ROLLBACK');
    holder.release();
    await Promise.all(waiting);
    await app.close();
    await small.end();
    expect(upload.statusCode).toBe(200);
  }, 30000);
});

describe('security', () => {
  const logged = () => {
    const lines: string[] = [];
    const logStream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    return { lines, logStream };
  };

  it.each(['//pts/%s', '/PTS/%s', '/api/pts/%s'])('F13: a mistyped upload URL (%s) keeps the secret out of the log', async (shape) => {
    const secret = 'Sup3rS3cretValueOfTheStation';
    await insertStation(pool, { code: 'S', secret });
    const { lines, logStream } = logged();
    const app = buildApp({ pool, config: { ...config, logLevel: 'info' }, logStream, now: OPTS.now });
    await app.inject({ method: 'POST', url: shape.replace('%s', secret), headers: { 'content-type': 'application/json' }, payload: '{}' });
    await app.close();
    expect(lines.join('')).not.toContain(secret);
  });

  it('F14: the secret repeated later in the path is not stored', async () => {
    const secret = 'AnotherSecretValue1234567';
    await insertStation(pool, { code: 'S', secret });
    const app = buildApp({ pool, config, now: OPTS.now });
    await app.inject({ method: 'POST', url: `/pts/${secret}/${secret}`, headers: { 'content-type': 'application/json' }, payload: '{}' });
    await app.close();
    const row = (await pool.query(`SELECT path FROM raw_uploads`)).rows[0];
    expect(row.path).not.toContain(secret);
  });

  it('F15: a malformed percent escape does not echo the secret or answer outside the error contract', async () => {
    const secret = 'ThirdSecretValue123456789';
    await insertStation(pool, { code: 'S', secret });
    const { lines, logStream } = logged();
    const app = buildApp({ pool, config, logStream, now: OPTS.now });
    const res = await app.inject({ method: 'POST', url: `/pts/${secret}/%E0%A4%A`, headers: { 'content-type': 'application/json' }, payload: '{}' });
    await app.close();
    expect(res.body).not.toContain(secret);
    expect(lines.join('')).not.toContain(secret);
  });

  it('F16: a NUL byte in the anchor reason answers 422, not 500', async () => {
    const app = buildApp({ pool, config, now: OPTS.now });
    const { key } = await createClient(pool, 'k');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/stations/${ST.operatorCode}/tanks/${A.code}/anchor`,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: '{"remaining_quantity":1,"reason":"a\\u0000b"}',
    });
    await app.close();
    expect(res.statusCode).toBe(422);
  });

  it('F17: a NUL byte in the tank code answers 404, not 500', async () => {
    const app = buildApp({ pool, config, now: OPTS.now });
    const { key } = await createClient(pool, 'k');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/stations/${ST.operatorCode}/tanks/%00/anchor`,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: { remaining_quantity: 1, reason: 'x' },
    });
    await app.close();
    expect(res.statusCode).toBe(404);
  });

  it('H1: a station-bound key cannot tell a foreign station from a missing one, or touch its batch or tank', async () => {
    const other = await seedCodedStation(pool, 2);
    const otherTank = await seedCodedTank(pool, other, 1);
    await insertReading(pool, otherTank.id, { at: minuteAt(0), fuel: '1000' });
    await processTank(pool, otherTank.id, LEDGER);
    const otherBatch = (await getOrCreateNextBatch(pool, other.id, OPTS))!;
    const app = buildApp({ pool, config, now: OPTS.now });
    const { key } = await createClient(pool, 'bound', { stationId: ST.id });
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: headers.authorization } });
    const foreign = await get(`/v1/stations/${other.operatorCode}/readings/batches/next`);
    const missing = await get(`/v1/stations/NOPE/readings/batches/next`);
    expect([foreign.statusCode, foreign.body]).toEqual([missing.statusCode, missing.body]);
    const byOwnPath = await app.inject({ method: 'POST', url: `/v1/stations/${ST.operatorCode}/readings/batches/${otherBatch.id}/result`, headers, payload: { status_code: 200, body: { accepted_count: 1 } } });
    expect(byOwnPath.statusCode).toBe(404);
    const anchorForeign = await app.inject({ method: 'POST', url: `/v1/stations/${ST.operatorCode}/tanks/${otherTank.code}/anchor`, headers, payload: { remaining_quantity: 1, reason: 'x' } });
    expect(anchorForeign.statusCode).toBe(404);
    await app.close();
  });
});

describe('numbers', () => {
  it('H2: values at the third decimal round half away from zero and stay plain JSON numbers', () => {
    expect(parseMilli('0.0005')).toBe(1);
    expect(parseMilli('-0.0005')).toBe(-1);
    expect(parseMilli('0.9995')).toBe(1000);
    expect(parseMilli('1.0005')).toBe(1001);
    expect(parseMilli(1e-7)).toBe(0);
    expect(() => parseMilli('1e3')).toThrow();
  });
});

describe('result replay', () => {
  it('F18: the same answer with its keys in another order is a replay, not a different answer', async () => {
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '1000' });
    await processTank(pool, A.id, LEDGER);
    const b = (await getOrCreateNextBatch(pool, ST.id, OPTS))!;
    await applyResult(pool, ST.id, b.id, { status: 200, body: { status: 'accepted', accepted_count: 1 } });
    const again = await applyResult(pool, ST.id, b.id, { status: 200, body: { accepted_count: 1, status: 'accepted' } });
    expect(again.replayed).toBe(true);
  });
});

describe('schema', () => {
  it('F19: migration 004 runs on a database that has a held tank', async () => {
    const admin = new pg.Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS pts2_review_mig_test');
    await admin.query('CREATE DATABASE pts2_review_mig_test');
    await admin.end();
    const url = new URL(TEST_DB_URL);
    url.pathname = '/pts2_review_mig_test';
    const p = createPool(url.toString(), 2);
    const all = fileURLToPath(new URL('../migrations', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    for (const f of readdirSync(all).filter((x) => /^00[123]/.test(x))) copyFileSync(join(all, f), join(dir, f));
    let failure: string | null = null;
    try {
      await migrate(p, dir);
      const s = await p.query(`INSERT INTO stations (name, operator_station_code, secret_hash) VALUES ('x','x',$1) RETURNING id`, [hashSecret('x')]);
      await p.query(`INSERT INTO tanks (station_id, tank_number, operator_tank_code, capacity_litres, total_height_m, chain_held) VALUES ($1, 1, 'T', 100, 1, true)`, [s.rows[0].id]);
      copyFileSync(join(all, '004_hardening.sql'), join(dir, '004_hardening.sql'));
      await migrate(p, dir);
    } catch (e) {
      failure = (e as Error).message;
    } finally {
      await p.end();
    }
    expect(failure).toBeNull();
  });
});

describe('third review', () => {
  it('F20: GET next for one station waiting on a tank lock does not stop another station uploading', async () => {
    const small = createPool(TEST_DB_URL, 10, { connectionTimeoutMs: 1000, lockTimeoutMs: 8000 });
    const other = await insertStation(pool, { code: 'OTHER' });
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '1000' });
    const app = buildApp({ pool: small, config, now: () => new Date('2026-11-03T23:00:00Z') });
    await app.ready();
    const { key } = await createClient(pool, 'k');
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM tanks WHERE id = $1 FOR UPDATE', [A.id]);
    const waiting = Array.from({ length: 12 }, () =>
      app.inject({ method: 'GET', url: `/v1/stations/${ST.operatorCode}/readings/batches/next`, headers: { authorization: `Bearer ${key}` } }),
    );
    await new Promise((r) => setTimeout(r, 1500));
    const upload = await app.inject({ method: 'POST', url: `/pts/${other.secret}`, headers: { 'content-type': 'application/json' }, payload: '{}' });
    await holder.query('ROLLBACK');
    holder.release();
    await Promise.all(waiting);
    await app.close();
    await small.end();
    expect(upload.statusCode).toBe(200);
  }, 30000);

  it('batch_results keeps a bounded number of repeat attempts and no oversized body', async () => {
    await insertReading(pool, A.id, { at: minuteAt(0), fuel: '1000' });
    await processTank(pool, A.id, LEDGER);
    const batch = (await getOrCreateNextBatch(pool, ST.id, OPTS))!;
    const big = { status: 503, body: { pad: 'x'.repeat(70_000) } };
    await applyResult(pool, ST.id, batch.id, big);
    const closing = { status: 200, body: { accepted_count: 1 } };
    await applyResult(pool, ST.id, batch.id, closing);
    for (let i = 0; i < 40; i += 1) await applyResult(pool, ST.id, batch.id, closing);
    const rows = (await pool.query(`SELECT body, replayed FROM batch_results WHERE batch_id = $1 ORDER BY id`, [batch.id])).rows;
    expect(rows[0].body).toBeNull(); // 70 KB is not kept
    expect(rows).toHaveLength(20);
    expect(rows.slice(2).every((r) => r.replayed && r.body === null)).toBe(true);
  });

  it('a tank cannot hold more than 10 million litres', async () => {
    await expect(pool.query(`UPDATE tanks SET capacity_litres = 20000000 WHERE id = $1`, [A.id])).rejects.toThrow(/tanks_capacity_max_chk/);
  });
});
