import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { storeUpload } from '../src/ingest/store.js';
import { pruneRawUploads } from '../src/maintenance/prune.js';
import { resetDb, testPool } from './helpers/db.js';
import { insertReading, insertStation, insertTank, seedRefs } from './helpers/fixtures.js';

const pool = testPool(4);
const NOW = new Date('2026-11-04T12:00:00Z');
let stationId: number;

beforeEach(async () => {
  await resetDb(pool);
  await seedRefs(pool);
  stationId = (await insertStation(pool)).id;
});
afterAll(() => pool.end());

async function upload(daysAgo: number): Promise<number> {
  const id = await storeUpload(pool, {
    stationId, secret: null, method: 'POST', path: '/pts/***', query: null, headers: {}, contentType: 'application/json',
    body: Buffer.from('{"a":1}'),
  });
  // the payload guard forbids changing arrived_at; a test backdates a row with the guard off, in one transaction
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`ALTER TABLE raw_uploads DISABLE TRIGGER raw_uploads_payload_guard`);
    await c.query(`UPDATE raw_uploads SET arrived_at = $2::timestamptz - make_interval(days => $3) WHERE id = $1`, [id, NOW, daysAgo]);
    await c.query(`ALTER TABLE raw_uploads ENABLE TRIGGER raw_uploads_payload_guard`);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  return id;
}
const count = async (): Promise<number> => (await pool.query(`SELECT count(*)::int AS n FROM raw_uploads`)).rows[0].n;

describe('pruneRawUploads', () => {
  it('removes uploads older than the retention and keeps newer ones', async () => {
    await upload(200); await upload(91); const keepA = await upload(89); const keepB = await upload(1);
    const n = await pruneRawUploads(pool, { days: 90, now: () => NOW });
    expect(n).toBe(2);
    const left = (await pool.query(`SELECT id FROM raw_uploads ORDER BY id`)).rows.map((r) => Number(r.id));
    expect(left).toEqual([keepA, keepB]);
  });

  it('works through a large backlog in small batches', async () => {
    for (let i = 0; i < 7; i++) await upload(120 + i);
    expect(await pruneRawUploads(pool, { days: 90, batchSize: 3, now: () => NOW })).toBe(7);
    expect(await count()).toBe(0);
  });

  it('keeps the readings that came from a pruned upload', async () => {
    const id = await upload(200);
    const tankId = await insertTank(pool, stationId);
    const readingId = await insertReading(pool, tankId, { at: '2026-05-01T10:00:00Z' });
    await pool.query(`UPDATE readings SET upload_id = $1 WHERE id = $2`, [id, readingId]);
    await pruneRawUploads(pool, { days: 90, now: () => NOW });
    const r = await pool.query(`SELECT upload_id FROM readings WHERE id = $1`, [readingId]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].upload_id).toBeNull();
  });

  it('refuses a retention that would delete almost everything', async () => {
    await upload(5);
    await expect(pruneRawUploads(pool, { days: 0, now: () => NOW })).rejects.toThrow(/at least 7/);
    await expect(pruneRawUploads(pool, { days: 3, now: () => NOW })).rejects.toThrow(/at least 7/);
    expect(await count()).toBe(1);
  });
});
