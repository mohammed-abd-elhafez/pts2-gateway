/**
 * End to end on simulated stations: generate records, write them as a TANKMSR.CSV, import them, run the ledger, then play the
 * client's part (fetch a batch, send it to a strict MoEnergy, report the answer) until nothing is left, and check what came out.
 * The checks are the point: they compare what MoEnergy holds, what our database says and what the generator injected.
 */
import { join } from 'node:path';
import { getOrCreateNextBatch } from '../../src/batches/builder.js';
import { applyResult, releaseBatch } from '../../src/batches/result.js';
import type { Pool } from '../../src/db/pool.js';
import { importTankMsr } from '../../src/import/tankmsr.js';
import { runLedgerOnce } from '../../src/ledger/worker.js';
import { StrictMoEnergy } from './fake-moenergy.js';
import type { Faults } from './model.js';
import { seedStations, type StationCtx } from './seed.js';

export interface ScenarioOptions {
  stations?: number;
  days?: number;
  seed?: number;
  /** local date of the first simulated day (default 2026-09-01) */
  startDate?: string;
  policy?: 'allow' | 'hold';
  /** MoEnergy answers 422 to a negative consumed quantity */
  refuseNegative?: boolean;
  faults?: Faults;
  outages?: { startDay: number; days: number }[];
  noVolumeDays?: number;
  /** import only rows from this instant on */
  since?: Date;
  chartDir?: string;
  refillEveryDays?: number;
}

export interface ScenarioStats {
  stations: number;
  days: number;
  recordsGenerated: number;
  imported: number;
  clockInvalidStored: number;
  duplicateTime: number;
  emitted: number;
  storedAtMoEnergy: number;
  batches: number;
  refillsSeen: number;
  smallNegatives: number;
  heldTanks: number;
  refusedByMoEnergy: number;
  skippedGlitches: number;
  quarantinedOther: number;
  maxBatchBytes: number;
  actions: Record<string, number>;
  ms: number;
}

/** What the client's loop needs: the ledger policy, a clock, the MoEnergy to send to, and counters it fills in. */
export interface ClientEnv {
  policy: 'allow' | 'hold';
  now: () => Date;
  fake: StrictMoEnergy;
  refused: number;
  actions: Record<string, number>;
  batches: number;
}

export interface ScenarioContext extends ClientEnv {
  opts: ScenarioOptions;
  stations: StationCtx[];
  tankCodes: string[];
}

export interface ScenarioResult {
  violations: string[];
  stats: ScenarioStats;
  ctx: ScenarioContext;
}

const DAY_MS = 86_400_000;

/** The client's loop for one station: ledger, fetch, send to MoEnergy, report, until nothing is ready. */
export async function driveStation(pool: Pool, ctx: ClientEnv, st: { id: number; code: string }, violations: string[]): Promise<number> {
  let sent = 0;
  let lastId = -1;
  let repeats = 0;
  for (let i = 0; i < 20_000; i++) {
    for (;;) {
      const r = await runLedgerOnce(pool, { policy: ctx.policy, now: ctx.now }, { stationId: st.id });
      if (r.emitted + r.quarantined + r.skipped === 0) break;
    }
    const batch = await getOrCreateNextBatch(pool, st.id, { now: ctx.now });
    if (!batch) break;
    sent++;
    ctx.batches++;
    if (batch.id === lastId) {
      if (++repeats > 3) {
        violations.push(`station ${st.code}: batch ${batch.id} stays open after ${repeats} answers`);
        break;
      }
    } else {
      lastId = batch.id;
      repeats = 0;
    }
    const answer = ctx.fake.send(batch.body);
    if (answer.status !== 200) ctx.refused++;
    const { outcome } = await applyResult(pool, st.id, batch.id, answer);
    ctx.actions[outcome.action] = (ctx.actions[outcome.action] ?? 0) + 1;
    if (outcome.action === 'needs_attention') await releaseBatch(pool, st.id, batch.id, 'simulated client gave up on the batch');
  }
  return sent;
}

const one = async (pool: Pool, sql: string, params: unknown[] = []): Promise<number> => Number((await pool.query(sql, params)).rows[0].n);

export async function checkInvariants(pool: Pool, ctx: ScenarioContext): Promise<string[]> {
  const v: string[] = [];
  const { fake } = ctx;
  const allow = ctx.policy === 'allow' && !ctx.opts.refuseNegative;
  const truth = ctx.stations.reduce(
    (a, s) => ({
      refills: a.refills + s.truth.refills,
      clock: a.clock + s.truth.clockInvalidRows,
      pairs: a.pairs + s.truth.sameSecondPairs,
      noise: a.noise + s.truth.noiseRises,
      glitches: a.glitches + s.truth.glitches,
    }),
    { refills: 0, clock: 0, pairs: 0, noise: 0, glitches: 0 },
  );

  // what MoEnergy holds
  let stored = 0;
  for (const code of ctx.tankCodes) {
    const list = fake.stored.get(code) ?? [];
    stored += list.length;
    if (!fake.chainIsWhole(code)) v.push(`tank ${code}: the chain at MoEnergy is broken`);
    if (list.length > 0) {
      const consumed = list.reduce((s, r) => s + r.consumed_quantity, 0);
      const gap = list[0]!.fuel_quantity - list.at(-1)!.remaining_quantity - consumed;
      if (Math.abs(gap) > 0.01) v.push(`tank ${code}: litres are not conserved (first fuel - last remaining - sum consumed = ${gap.toFixed(3)})`);
    }
  }

  // the times MoEnergy holds are the times the data had (a wrong time zone shifts them all)
  for (const s of ctx.stations) {
    let wrong = 0;
    for (const code of s.tankCodes) for (const item of fake.stored.get(code) ?? []) if (!s.instants.has(item.reading_at)) wrong++;
    if (wrong > 0) v.push(`station ${s.code}: ${wrong} reading(s) stored at a time the data never had (time zone?)`);
  }

  // what our database says it sent
  const accepted = await one(pool, `SELECT count(*) AS n FROM emitted_readings e JOIN batches b ON b.id = e.batch_id WHERE b.status = 'accepted'`);
  if (accepted !== stored) v.push(`database says ${accepted} readings were accepted, MoEnergy holds ${stored}`);

  const flagged = await one(
    pool,
    `SELECT count(*) AS n FROM emitted_readings e JOIN readings r ON r.id = e.reading_id WHERE 'clock_invalid' = ANY(r.quality_flags)`,
  );
  if (flagged > 0) v.push(`${flagged} reading(s) flagged clock_invalid reached the ledger`);
  const midnight = await one(
    pool,
    `SELECT count(*) AS n FROM emitted_readings e JOIN readings r ON r.id = e.reading_id JOIN tanks t ON t.id = r.tank_id JOIN stations s ON s.id = t.station_id
      WHERE ((extract(epoch FROM r.effective_at)::bigint + s.utc_offset_minutes * 60) % 86400) = 0`,
  );
  if (midnight > 0) v.push(`${midnight} reading(s) stamped 00:00:00 were put in the chain`);
  const biggest = await one(pool, `SELECT coalesce(max(size_bytes), 0) AS n FROM batches`);
  if (biggest >= 1_000_000) v.push(`a batch is ${biggest} bytes`);

  // what the generator injected
  const plain = !ctx.opts.noVolumeDays && !ctx.opts.since;
  for (const s of ctx.stations) {
    if (s.report.errors.length > 0) v.push(`station ${s.code}: ${s.report.errors.length} unreadable line(s) in the generated file`);
    if (s.report.lines !== s.csvDataLines) v.push(`station ${s.code}: the importer saw ${s.report.lines} lines of ${s.csvDataLines}`);
    if (s.report.duplicateTime !== s.truth.sameSecondPairs) v.push(`station ${s.code}: ${s.report.duplicateTime} same-second duplicates found, ${s.truth.sameSecondPairs} injected`);
    if (plain && s.report.clockInvalid + s.report.duplicateClock !== s.truth.clockInvalidRows) {
      v.push(`station ${s.code}: ${s.report.clockInvalid + s.report.duplicateClock} clock rows found, ${s.truth.clockInvalidRows} injected`);
    }
  }
  if (allow) {
    const refills = await one(pool, `SELECT count(*) AS n FROM emitted_readings WHERE consumed_quantity < -3000`);
    if (!ctx.opts.since && refills !== truth.refills) v.push(`${refills} refills in the chain, ${truth.refills} in the data`);
    const small = await one(pool, `SELECT count(*) AS n FROM emitted_readings WHERE consumed_quantity < 0 AND consumed_quantity >= -5`);
    if (small < truth.noise) v.push(`${small} small rises in the chain, ${truth.noise} injected`);
    const skipped = await one(pool, `SELECT count(*) AS n FROM readings WHERE ledger_status = 'skipped'`);
    if (skipped !== truth.glitches) v.push(`${skipped} readings skipped, ${truth.glitches} probe glitches injected`);
    // a skipped reading also leaves a quarantine row, with the rule that skipped it
    const other = await one(pool, `SELECT count(*) AS n FROM quarantine WHERE rule_code <> 'clock_invalid'`);
    if (other !== truth.glitches) v.push(`${other} reading(s) set aside for a reason other than clock_invalid, ${truth.glitches} probe glitches injected`);
    // everything is drained
    const pending = await one(pool, `SELECT count(*) AS n FROM readings WHERE ledger_status = 'pending'`);
    const unsent = await one(pool, `SELECT count(*) AS n FROM emitted_readings WHERE batch_id IS NULL`);
    const held = await one(pool, `SELECT count(*) AS n FROM tanks WHERE chain_held`);
    if (pending + unsent + held > 0) v.push(`not drained: ${pending} pending, ${unsent} unsent, ${held} tank(s) held`);
  } else if (ctx.opts.refuseNegative && truth.refills > 0) {
    if ((await one(pool, `SELECT count(*) AS n FROM tanks WHERE chain_held`)) === 0) v.push('MoEnergy refused refills but no tank is held');
  }
  const open = await one(pool, `SELECT count(*) AS n FROM batches WHERE status = 'open'`);
  if (open > 0) v.push(`${open} batch(es) still open`);

  // a second pass changes nothing
  const before = await one(pool, `SELECT (SELECT count(*) FROM emitted_readings) + (SELECT count(*) FROM batches) + (SELECT count(*) FROM readings) AS n`);
  const again = { violations: [] as string[] };
  for (const s of ctx.stations) {
    const r = await importTankMsr(pool, s.id, s.csv, { since: ctx.opts.since });
    if (r.inserted > 0) v.push(`station ${s.code}: reading the same file again stored ${r.inserted} new row(s)`);
    if ((await driveStation(pool, ctx, s, again.violations)) > 0) v.push(`station ${s.code}: a second client pass found something to send`);
  }
  v.push(...again.violations);
  const after = await one(pool, `SELECT (SELECT count(*) FROM emitted_readings) + (SELECT count(*) FROM batches) + (SELECT count(*) FROM readings) AS n`);
  if (after !== before) v.push(`a second pass changed the database (${before} to ${after} rows)`);
  return v;
}

export async function runScenario(pool: Pool, o: ScenarioOptions = {}): Promise<ScenarioResult> {
  const t0 = Date.now();
  const stationsN = o.stations ?? 1;
  const days = o.days ?? 14;
  const seed = o.seed ?? 1;
  const startDate = o.startDate ?? '2026-09-01';
  const chartDir = o.chartDir ?? join(process.cwd(), 'scripts/sim/data');
  const endMs = Date.parse(`${startDate}T00:00:00Z`) + days * DAY_MS;
  const now = () => new Date(Math.max(endMs + DAY_MS, Date.now() + 3_600_000));

  const { stations, fakeTanks, generated } = await seedStations(pool, {
    stations: stationsN,
    days,
    seed,
    startDate,
    chartDir,
    faults: o.faults,
    outages: o.outages,
    noVolumeDays: o.noVolumeDays,
    refillEveryDays: o.refillEveryDays,
    since: o.since,
  });

  const policy = o.policy ?? 'allow';
  const ctx: ScenarioContext = {
    opts: o,
    policy,
    now,
    fake: new StrictMoEnergy(fakeTanks, { now, refuseNegative: o.refuseNegative }),
    stations,
    tankCodes: fakeTanks.map((t) => t.tankCode),
    refused: 0,
    actions: {},
    batches: 0,
  };
  const violations: string[] = [];
  for (const s of stations) await driveStation(pool, ctx, s, violations);
  violations.push(...(await checkInvariants(pool, ctx)));

  const n = (sql: string) => one(pool, sql);
  const stats: ScenarioStats = {
    stations: stationsN,
    days,
    recordsGenerated: generated,
    imported: stations.reduce((s, x) => s + x.report.inserted, 0),
    clockInvalidStored: stations.reduce((s, x) => s + x.report.clockInvalid, 0),
    duplicateTime: stations.reduce((s, x) => s + x.report.duplicateTime, 0),
    emitted: await n(`SELECT count(*) AS n FROM emitted_readings`),
    storedAtMoEnergy: [...ctx.fake.stored.values()].reduce((s, l) => s + l.length, 0),
    batches: ctx.batches,
    refillsSeen: await n(`SELECT count(*) AS n FROM emitted_readings WHERE consumed_quantity < -3000`),
    smallNegatives: await n(`SELECT count(*) AS n FROM emitted_readings WHERE consumed_quantity < 0 AND consumed_quantity >= -5`),
    heldTanks: await n(`SELECT count(*) AS n FROM tanks WHERE chain_held`),
    refusedByMoEnergy: ctx.refused,
    skippedGlitches: await n(`SELECT count(*) AS n FROM readings WHERE ledger_status = 'skipped'`),
    quarantinedOther: await n(`SELECT count(*) AS n FROM quarantine WHERE rule_code <> 'clock_invalid'`),
    maxBatchBytes: await n(`SELECT coalesce(max(size_bytes), 0) AS n FROM batches`),
    actions: ctx.actions,
    ms: Date.now() - t0,
  };
  return { violations, stats, ctx };
}
