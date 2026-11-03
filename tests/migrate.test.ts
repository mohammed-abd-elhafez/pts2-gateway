import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { testPool } from './helpers/db.js';

const pool = testPool(3);
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mig-'));
  await writeFile(join(dir, '001_a.sql'), 'CREATE TABLE mig_probe_a (id int primary key);');
  await writeFile(join(dir, '002_b.sql'), 'CREATE TABLE mig_probe_b (id int primary key);');
});

afterAll(async () => {
  await pool.query('DROP TABLE IF EXISTS mig_probe_a, mig_probe_b, mig_probe_bad, mig_probe_table');
  await rm(dir, { recursive: true, force: true });
  await pool.end();
});

describe('migrate', () => {
  it('applies each file once and is idempotent', async () => {
    expect(await migrate(pool, dir, 'mig_probe_table')).toEqual(['001_a.sql', '002_b.sql']);
    expect(await migrate(pool, dir, 'mig_probe_table')).toEqual([]);
  });

  it('rolls a failing file back completely and reports its name', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'mig-bad-'));
    await writeFile(join(bad, '001_bad.sql'), 'CREATE TABLE mig_probe_bad (id int); SELECT 1/0;');
    await expect(migrate(pool, bad, 'mig_probe_table')).rejects.toThrow(/001_bad\.sql/);
    const { rows } = await pool.query(`SELECT to_regclass('mig_probe_bad') AS t`);
    expect(rows[0].t).toBeNull();
    await rm(bad, { recursive: true, force: true });
  });

  it('rejects an unsafe table name', async () => {
    await expect(migrate(pool, dir, 'x; DROP TABLE y')).rejects.toThrow(/invalid migrations table/);
  });
});
