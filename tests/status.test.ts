import { Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '../src/api/clients.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { resetDb, testPool, TEST_DB_URL } from './helpers/db.js';
import { emitReadings, insertReading, insertStation, insertTank, minuteAt, seedCodedStation, seedCodedTank, seedRefs } from './helpers/fixtures.js';

const pool = testPool(8);
const NOW = new Date('2026-11-03T23:00:00Z');
const config = loadConfig({ DATABASE_URL: TEST_DB_URL, LOG_LEVEL: 'silent' });
const app = buildApp({ pool, config, now: () => NOW, logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
let key: string;

beforeEach(async () => {
  await resetDb(pool);
  await seedRefs(pool);
  key = (await createClient(pool, 'client system')).key;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const S = '/v1/stations/OP-1';
const status = (url = `${S}/status`, headers: Record<string, string> = { authorization: `Bearer ${key}` }) => app.inject({ method: 'GET', url, headers });
const json = async (url?: string) => JSON.parse((await status(url)).body);

describe('GET /v1/stations/{code}/status', () => {
  it('needs a key, and a station the key may use', async () => {
    expect((await status(`${S}/status`, {})).statusCode).toBe(401);
    const st = await seedCodedStation(pool, 1);
    await seedCodedTank(pool, st, 1);
    const other = await seedCodedStation(pool, 2);
    const bound = (await createClient(pool, 'one station', { stationId: other.id })).key;
    expect((await status(`${S}/status`, { authorization: `Bearer ${bound}` })).statusCode).toBe(404);
    expect((await status('/v1/stations/NOPE/status')).statusCode).toBe(404);
  });

  it('describes the station and each tank: codes, go-live time, what waits, what was sent', async () => {
    const st = await seedCodedStation(pool, 1);
    await pool.query(`UPDATE stations SET last_seen_at = $2 WHERE id = $1`, [st.id, '2026-11-03T22:58:00Z']);
    const a = await seedCodedTank(pool, st, 1);
    await pool.query(`UPDATE tanks SET send_from = $2, product_id = 91 WHERE id = $1`, [a.id, '2026-11-03T09:00:00Z']);
    await emitReadings(pool, a.id, [{ minute: 0, fuel: '1000' }, { minute: 1, fuel: '990' }, { minute: 2, fuel: '980' }]);
    await insertReading(pool, a.id, { at: minuteAt(5), fuel: '970' }); // not yet through the ledger

    const body = await json();
    expect(body).toMatchObject({ station_code: 'OP-1', moenergy_station_code: 'ST-000001', last_upload_at: '2026-11-03T22:58:00.000Z', open_batch: null });
    expect(body.tanks).toHaveLength(1);
    expect(body.tanks[0]).toMatchObject({
      tank_code: 'ST-000001-1',
      tank_number: 1,
      active: true,
      state: 'ok',
      held_reason: null,
      go_live_at: '2026-11-03T09:00:00.000Z',
      pending: 1,
      ready: 3,
      in_open_batch: 0,
      sent: 0,
      last_reading_at: minuteAt(5).replace('.000Z', '.000Z'),
      last_ready_remaining_quantity: 980,
      set_aside: {},
    });
  });

  it('shows a held tank with the reason, and a tank that still lacks its MoEnergy code', async () => {
    const st = await seedCodedStation(pool, 1);
    const held = await seedCodedTank(pool, st, 1);
    await pool.query(`UPDATE tanks SET chain_held = true, held_reason = 'chain_break', held_at = now() WHERE id = $1`, [held.id]);
    await insertTank(pool, st.id, { number: 2 }); // no MoEnergy tank code
    const tanks = (await json()).tanks;
    expect(tanks[0]).toMatchObject({ tank_number: 1, state: 'held', held_reason: 'chain_break' });
    expect(tanks[1]).toMatchObject({ tank_number: 2, tank_code: null, state: 'waiting_for_codes' });
  });

  it('counts what was set aside, by rule', async () => {
    const st = await seedCodedStation(pool, 1);
    const t = await seedCodedTank(pool, st, 1);
    const r1 = await insertReading(pool, t.id, { at: minuteAt(0), fuel: '1000' });
    const r2 = await insertReading(pool, t.id, { at: minuteAt(1), fuel: '1000' });
    const r3 = await insertReading(pool, t.id, { at: minuteAt(2), fuel: '1000' });
    for (const [id, rule] of [[r1, 'clock_invalid'], [r2, 'clock_invalid'], [r3, 'before_start']] as const) {
      await pool.query(`UPDATE readings SET ledger_status = 'quarantined' WHERE id = $1`, [id]);
      await pool.query(`INSERT INTO quarantine (reading_id, rule_code, detail) VALUES ($1, $2, '')`, [id, rule]);
    }
    expect((await json()).tanks[0].set_aside).toEqual({ clock_invalid: 2, before_start: 1 });
  });

  it('does not run the ledger or change anything: it only reads', async () => {
    const st = await seedCodedStation(pool, 1);
    const t = await seedCodedTank(pool, st, 1);
    await insertReading(pool, t.id, { at: minuteAt(0), fuel: '1000' });
    await json();
    expect(Number((await pool.query(`SELECT count(*) FROM readings WHERE ledger_status = 'pending'`)).rows[0].count)).toBe(1);
    expect(Number((await pool.query(`SELECT count(*) FROM emitted_readings`)).rows[0].count)).toBe(0);
  });

  it('follows a reading through the open batch to sent', async () => {
    const st = await seedCodedStation(pool, 1);
    const t = await seedCodedTank(pool, st, 1);
    await emitReadings(pool, t.id, [{ minute: 0, fuel: '1000' }, { minute: 1, fuel: '990' }]);
    const next = await app.inject({ method: 'GET', url: `${S}/readings/batches/next`, headers: { authorization: `Bearer ${key}` } });
    expect(next.statusCode).toBe(200);
    let tank = (await json()).tanks[0];
    expect(tank).toMatchObject({ pending: 0, ready: 0, in_open_batch: 2, sent: 0 });
    expect((await json()).open_batch).toMatchObject({ id: Number(next.headers['x-batch-id']), items: 2 });
    await app.inject({
      method: 'POST',
      url: `${S}/readings/batches/${next.headers['x-batch-id']}/result`,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: { status_code: 200, body: { status: 'accepted', accepted_count: 2 } },
    });
    tank = (await json()).tanks[0];
    expect(tank).toMatchObject({ in_open_batch: 0, sent: 2, last_sent_at: minuteAt(1), last_sent_remaining_quantity: 990 });
    expect((await json()).open_batch).toBeNull();
  });
});
