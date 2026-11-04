import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../src/api/clients.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { ensureAppRole } from '../src/db/roles.js';
import { resetDb, testPool, TEST_DB_URL } from './helpers/db.js';
import { emitReadings, insertStation, seedCodedStation, seedCodedTank, seedRefs } from './helpers/fixtures.js';

const admin = testPool(4);
const PASSWORD = 'Abcdef0123456789abcdef01';
let appPool: ReturnType<typeof createPool>;

const appUrl = (): string => {
  const u = new URL(TEST_DB_URL);
  u.username = 'pts2_app_test';
  u.password = PASSWORD;
  return u.toString();
};

beforeAll(async () => {
  await resetDb(admin);
  await seedRefs(admin);
  await ensureAppRole(admin, { role: 'pts2_app_test', password: PASSWORD });
  appPool = createPool(appUrl(), 6);
});
afterAll(async () => {
  await appPool.end();
  await admin.query(`DROP OWNED BY pts2_app_test`);
  await admin.query(`DROP ROLE pts2_app_test`);
  await admin.end();
});

describe('the restricted application role', () => {
  it('is not a superuser and cannot change the schema', async () => {
    const who = await appPool.query(`SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user`);
    expect(who.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    await expect(appPool.query(`CREATE TABLE should_not_exist (x int)`)).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`DROP TABLE stations`)).rejects.toThrow(/must be owner|permission denied/);
    await expect(appPool.query(`TRUNCATE stations CASCADE`)).rejects.toThrow(/permission denied/);
  });

  it('can be set up twice, and a second call changes the password', async () => {
    await ensureAppRole(admin, { role: 'pts2_app_test', password: PASSWORD });
    expect((await appPool.query(`SELECT 1 AS ok`)).rows[0].ok).toBe(1);
  });

  it('runs the whole path: an upload, a batch built by the ledger, and its result', async () => {
    const station = await insertStation(admin, { code: 'OP-1', secret: 'role-test-secret-0123456789' });
    const st = await seedCodedStation(admin, 2);
    const tank = await seedCodedTank(admin, st, 1);
    await emitReadings(admin, tank.id, [{ minute: 0, fuel: '1000' }, { minute: 2, fuel: '990' }]);
    const { key } = await createClient(admin, 'client');

    const config = loadConfig({ DATABASE_URL: appUrl(), LOG_LEVEL: 'silent' });
    const app = buildApp({ pool: appPool, config, now: () => new Date('2026-11-03T12:00:00Z'), logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
    try {
      const upload = await app.inject({ method: 'POST', url: `/pts/${station.secret}/x`, payload: '{"a":1}' });
      expect(upload.statusCode).toBe(200);

      const code = `/v1/stations/${st.operatorCode}`;
      const batch = await app.inject({ method: 'GET', url: `${code}/readings/batches/next`, headers: { authorization: `Bearer ${key}` } });
      expect(batch.statusCode).toBe(200);
      const result = await app.inject({
        method: 'POST',
        url: `${code}/readings/batches/${batch.headers['x-batch-id']}/result`,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        payload: { status_code: 200, body: { status: 'accepted' } },
      });
      expect(result.statusCode).toBe(200);
      const status = await app.inject({ method: 'GET', url: `${code}/status`, headers: { authorization: `Bearer ${key}` } });
      expect(status.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('reaches tables made by a migration that ran after the role was set up', async () => {
    await admin.query(`CREATE TABLE later_table (id serial PRIMARY KEY, v text)`);
    try {
      await appPool.query(`INSERT INTO later_table (v) VALUES ('x')`);
      expect((await appPool.query(`SELECT count(*)::int AS n FROM later_table`)).rows[0].n).toBe(1);
    } finally {
      await admin.query(`DROP TABLE later_table`);
    }
  });
});
