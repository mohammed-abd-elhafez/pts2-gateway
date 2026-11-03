/**
 * Random flows against a fake MoEnergy. After every round: what the ledger calls accepted must be at
 * MoEnergy, MoEnergy's chain must be whole, and no reading may be in two places. A failure prints its seed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { getOrCreateNextBatch } from '../src/batches/builder.js';
import { applyResult } from '../src/batches/result.js';
import { parseMilli } from '../src/domain/quantity.js';
import { setAnchor, UnsentReadingsError } from '../src/ledger/service.js';
import { runLedgerOnce } from '../src/ledger/worker.js';
import { resetDb, testPool } from './helpers/db.js';
import { insertReading, minuteAt, seedCodedStation, seedCodedTank } from './helpers/fixtures.js';
import { FakeMoEnergy, ledgerAccepted, LEDGER, moenergyError, OPTS } from './review-helpers.js';

const pool = testPool(4);
afterAll(() => pool.end());

function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

async function run(seed: number): Promise<string | null> {
  const rand = rng(seed);
  await resetDb(pool);
  const st = await seedCodedStation(pool, 1);
  const tanks = [await seedCodedTank(pool, st, 1), await seedCodedTank(pool, st, 2)];
  const fake = new FakeMoEnergy();
  const used = new Set<string>();
  const trail: string[] = [];
  const level = new Map(tanks.map((t) => [t.id, 20000]));

  for (let round = 0; round < 25; round += 1) {
    // new readings, sometimes behind what is already there
    for (let k = rand(4); k > 0; k -= 1) {
      const t = tanks[rand(2)]!;
      const minute = round * 2 + (rand(5) === 0 ? -rand(6) : rand(2));
      const key = `${t.id}:${minute}`;
      if (minute < 0 || used.has(key)) continue;
      used.add(key);
      const next = rand(12) === 0 ? 30000 : level.get(t.id)! - rand(200);
      level.set(t.id, next);
      await insertReading(pool, t.id, { at: new Date(Date.UTC(2026, 10, 3, 1, minute)).toISOString(), fuel: String(next) });
      trail.push(`reading ${t.code} m${minute} ${next}`);
    }
    await runLedgerOnce(pool, LEDGER, { stationId: st.id });
    const batch = await getOrCreateNextBatch(pool, st.id, OPTS);
    if (batch) {
      const fate = rand(10);
      if (fate === 0) {
        fake.send(batch.body); // stored, reply lost: the next round fetches the same batch and resends
        trail.push(`batch ${batch.id} reply lost`);
      } else if (fate === 1) {
        const r = await applyResult(pool, st.id, batch.id, { status: 503, body: null });
        trail.push(`batch ${batch.id} 503 -> ${r.outcome.action}`);
      } else if (fate === 2 && batch.itemCount > 0) {
        const r = await applyResult(pool, st.id, batch.id, { status: 422, body: moenergyError(rand(batch.itemCount), 'SOME_FIELD_RULE') });
        trail.push(`batch ${batch.id} refused one -> ${r.outcome.action}`);
      } else {
        const answer = fake.send(batch.body);
        const r = await applyResult(pool, st.id, batch.id, answer);
        trail.push(`batch ${batch.id} sent ${JSON.stringify(answer.body).slice(0, 80)} -> ${r.outcome.action}`);
      }
    }
    // a held tank gets the truthful anchor when it can
    for (const t of tanks) {
      const { rows } = await pool.query(`SELECT chain_held FROM tanks WHERE id = $1`, [t.id]);
      if (rows[0].chain_held) {
        const last = fake.last(t.code);
        if (last) {
          try {
            await setAnchor(pool, t.id, parseMilli(String(last.remaining_quantity)), 'truth', 'model', { requireNoUnsent: true });
            trail.push(`anchor ${t.code} ${last.remaining_quantity}`);
          } catch (e) {
            if (!(e instanceof UnsentReadingsError)) throw e;
          }
        }
      }
    }

    for (const t of tanks) {
      const stored = (fake.stored.get(t.code) ?? []).map((r) => r.reading_at);
      if (!fake.chainIsWhole(t.code)) return `seed ${seed}: MoEnergy chain broken for ${t.code}\n${trail.join('\n')}`;
      for (const a of await ledgerAccepted(pool, t.id)) {
        if (!stored.includes(a)) return `seed ${seed}: ledger says accepted but MoEnergy lacks ${t.code} ${a}\n${trail.join('\n')}`;
      }
      const both = await pool.query(
        `SELECT r.id FROM readings r JOIN emitted_readings e ON e.reading_id = r.id WHERE r.tank_id = $1 AND r.ledger_status <> 'emitted'`,
        [t.id],
      );
      if (both.rowCount) return `seed ${seed}: emitted row with a reading not marked emitted\n${trail.join('\n')}`;
    }
  }

  // Drain: no new readings, the documented flow only. Everything sendable must arrive.
  for (let i = 0; i < 12; i += 1) {
    await runLedgerOnce(pool, LEDGER, { stationId: st.id });
    const batch = await getOrCreateNextBatch(pool, st.id, OPTS);
    if (!batch) break;
    const answer = fake.send(batch.body);
    await applyResult(pool, st.id, batch.id, answer);
    for (const t of tanks) {
      const last = fake.last(t.code);
      const held = (await pool.query(`SELECT chain_held FROM tanks WHERE id = $1`, [t.id])).rows[0].chain_held;
      if (held && last) {
        await setAnchor(pool, t.id, parseMilli(String(last.remaining_quantity)), 'truth', 'model', { requireNoUnsent: true }).catch(() => undefined);
      }
    }
  }
  for (const t of tanks) {
    const stored = (fake.stored.get(t.code) ?? []).map((r) => r.reading_at);
    const { rows } = await pool.query<{ at: Date }>(
      `SELECT e.effective_at AS at FROM emitted_readings e WHERE e.tank_id = $1 AND e.batch_id IS NULL`,
      [t.id],
    );
    if (rows.length > 0 && stored.length > 0) {
      return `seed ${seed}: ${rows.length} unsent rows left after draining ${t.code}\n${trail.join('\n')}`;
    }
  }
  return null;
}

describe('random flows against a fake MoEnergy', () => {
  it('holds the invariants', async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 40; seed += 1) {
      const f = await run(seed);
      if (f) failures.push(f);
    }
    expect(failures.length, `${failures.length} of 40 seeds failed; first:\n${failures[0] ?? ''}`).toBe(0);
  }, 300000);
});
