import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { storeUpload } from '../src/ingest/store.js';
import { findStationByOperatorCode } from '../src/stations/lookup.js';
import type { Pool } from '../src/db/pool.js';
import { resetDb, testPool } from './helpers/db.js';
import { insertStation } from './helpers/fixtures.js';

const pool = testPool(4);
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

describe('findStationByOperatorCode', () => {
  const noDatabase = { query: () => { throw new Error('the database must not be asked'); } } as unknown as Pool;

  it.each([
    ['empty', ''],
    ['a NUL byte', 'a\u0000b'],
    ['a newline', 'a\nb'],
    ['a DEL character', 'a\u007fb'],
    ['65 characters', 'x'.repeat(65)],
  ])('never asks the database about a code that is %s', async (_name, code) => {
    expect(await findStationByOperatorCode(noDatabase, code)).toBeNull();
  });

  it('finds a station by its code whatever the case, up to 64 characters', async () => {
    const code = 'R'.repeat(64);
    const { id } = await insertStation(pool, { code });
    expect(await findStationByOperatorCode(pool, code.toLowerCase())).toEqual({ id, operatorCode: code });
    expect(await findStationByOperatorCode(pool, 'nope')).toBeNull();
  });
});

describe('storeUpload', () => {
  it('removes the secret from the query and from header values by itself, not only because the route did', async () => {
    const { id, secret } = await insertStation(pool);
    await storeUpload(pool, {
      stationId: id,
      secret,
      method: 'POST',
      path: '/pts/***',
      query: `token=${secret}&a=1`,
      headers: { 'x-forwarded-uri': `/pts/${secret}`, authorization: `Basic ${secret}`, 'x-list': [`a-${secret}`, 'b'] },
      contentType: null,
      body: Buffer.from('{}'),
    });
    const row = (await pool.query(`SELECT query, headers FROM raw_uploads`)).rows[0];
    expect(row.query).toBe('token=***&a=1');
    expect(row.headers).toEqual({ 'x-forwarded-uri': '/pts/***', 'x-list': ['a-***', 'b'] });
  });
});
