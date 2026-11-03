# PTS-2 Gateway Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (this session implements it natively). Steps use checkbox syntax.

**Goal:** A deployable capture-mode ingest endpoint plus a tested ledger core that builds MoEnergy-valid stock chains.

**Architecture:** One Fastify 5 process and PostgreSQL 16. Ingest stores every upload raw. The ledger is a pure function (`step`) wrapped by one transactional DB service that locks the tank row. No parser and no batch API yet: both wait on real captures (plan 2).

**Tech Stack:** TypeScript ESM, Node 22, Fastify 5, pg, vitest, fast-check. Plain SQL migrations.

**Spec:** Claude Doc "PTS-2 to MoEnergy-format Tank Readings API: System Design" (rev 41), https://claude.ai/artifact/PMuLZG17iHyCLZXGLcaFov. MoEnergy rules come from "ATG APIs 1.1.0 Integration Guide", section 2.7.

## Global Constraints

- Quantities are integer thousandths (`Milli`), never floats; rounding is half away from zero at 3 decimal places.
- Fuel chain: `fuel_quantity` = previous `remaining_quantity` (tolerance 0.001 L); `remaining = fuel - consumed` (tolerance 1 L).
- Readings are emitted in time order per tank; a reading at or before the last emitted time is `late_arrival`.
- `water_quantity` must be strictly below the chained `fuel_quantity`; temperature outside -50..100 is dropped and flagged; water height < 10,000,000.
- Timestamps at most 5 minutes in the future.
- Heights arrive in millimetres, leave in metres (1 mm = 1 milli-metre).
- Raw payloads are never edited after insert; secrets are stored only as SHA-256 hashes and never logged.
- Tests run against a real PostgreSQL (no mocks for DB guarantees).

## Review Focus

- A 100,000-record backlog in one upload: body limit must allow it (20 MB) and the raw row must keep it intact.
- A body that is not JSON (or empty): captured, never rejected.
- `"12.3456"`, `"1e3"`, `"NaN"`, `""`, negative and huge numeric strings: parsed or rejected deterministically.
- Refill under `hold` policy: tank stops, later readings stay pending, anchor resumes from the anchor value.
- Two ledger runs on one tank at once: exactly one chain, no gaps in `seq`.

## Tasks

### Task 1: Scaffold, config, migration runner
**Files:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/config.ts`, `src/db/pool.ts`, `src/db/migrate.ts`, `scripts/pg-test.sh`, `tests/setup/global.ts`, `tests/helpers/db.ts`, `tests/migrate.test.ts`
**Interfaces:** Produces `loadConfig(env): Config`, `createPool(url): Pool`, `migrate(pool, dir): Promise<string[]>` (applied file names, idempotent), `resetDb(pool): Promise<void>` (truncates all app tables).
- [ ] Test: `migrate` twice applies a file once and returns `[]` the second time.
- [ ] Implement runner with a `schema_migrations(name primary key)` table, one transaction per file.
- [ ] `scripts/pg-test.sh start|stop` runs a throwaway cluster as user `postgres` on port 54329; global setup migrates `pts2_test`.

### Task 2: Schema migration
**Files:** `migrations/001_init.sql`, `tests/schema.test.ts`
**Produces:** the 11 tables from the design, plus `readings.ledger_status in ('pending','emitted','quarantined')`, `tanks.chain_held boolean`, `chain_anchors.after_seq`, trigger blocking edits to raw payload columns.
- [ ] Tests (each asserts a Postgres error code): duplicate operator station code ignoring case → 23505; latitude 40 → 23514; city outside its region → 23503; tank capacity 0 → 23514; second `open` batch → 23505; duplicate `(tank, device_time)` → 23505; `UPDATE raw_uploads SET body_raw` → error; `emitted_readings` with remaining ≠ fuel − consumed beyond 1 L → 23514.

### Task 3: Capture-mode ingest
**Files:** `src/stations/create.ts`, `src/ingest/auth.ts`, `src/ingest/store.ts`, `src/ingest/routes.ts`, `src/app.ts`, `src/server.ts`, `scripts/add-station.ts`, `tests/ingest.test.ts`
**Interfaces:** `createStation(pool, {operatorStationCode, name, utcOffsetMinutes}): Promise<{id:number; secret:string}>`; `extractSecret(req): string|null` (Basic password, else first path segment after `/pts/`); `buildApp(deps: {pool; config}): FastifyInstance`.
- [ ] Tests via `app.inject`: unknown secret → 401 and no row; valid secret by path and by Basic → configured reply and one `raw_uploads` row with exact bytes; non-JSON body stored in `body_text`, `body_json` null; 15 MB body accepted; authorization header and secret never appear in stored headers or logs; `GET /healthz` 200; `GET /readyz` 503 when the pool is closed.
- [ ] Implement catch-all buffer content-type parser, `pino` redaction, `onClose` pool shutdown.

### Task 4: Quantity type and reading rules
**Files:** `src/domain/quantity.ts`, `src/domain/rules.ts`, `tests/quantity.test.ts`, `tests/rules.test.ts`
**Interfaces:** `parseMilli(input: string|number): Milli` (throws `QuantityError`), `milliToDecimalString(m): string`, `milliToJsonNumber(m): number`; `validateReading(r: MeasuredReading, tank: TankLimits, chain: ChainValues, now: Date): {violations: Violation[]; temperature: number|null; flags: string[]}` with rule codes `volume_missing | volume_above_capacity | consumed_above_fuel | water_not_below_fuel | fuel_height_above_total | water_height_too_large | timestamp_in_future`.
- [ ] Quantity tests: `"12.3456"→12346`, `"-0.0005"→-1`, `"1e3"`, `"NaN"`, `""`, `"1,5"` throw; round-trip string form.
- [ ] One rules test per code, plus an empty tank (water 0, fuel 0) violating `water_not_below_fuel`, and temperature 101 dropped with flag `temperature_dropped`.

### Task 5: Pure ledger
**Files:** `src/domain/ledger.ts`, `tests/ledger.test.ts`, `tests/ledger.property.test.ts`
**Interfaces:** `step(state, input: {measured; delivery: boolean}, tank, policy: 'allow'|'hold', now): LedgerResult` (`emit | quarantine | hold`); `anchor(state, remaining): TankState`.
- [ ] Example tests: first reading → fuel = remaining = measured, consumed 0; normal consumption; refill under `allow` emits negative consumed; refill under `hold` holds; held tank returns `hold` until `anchor`; equal timestamp → `late_arrival`; a quarantined reading leaves state unchanged.
- [ ] Property test (fast-check): for any sequence with random bad readings and drops, every emitted pair satisfies both chain rules and times strictly increase.

### Task 6: Ledger DB service
**Files:** `src/ledger/service.ts`, `tests/ledger.service.test.ts`
**Interfaces:** `processTank(pool, tankId, opts: {policy; now: () => Date}): Promise<{emitted; quarantined; held}>`; `setAnchor(pool, tankId, remaining: Milli, reason: string, by: string): Promise<void>`.
- [ ] Tests: pending readings are emitted with gapless `seq`; quarantine rows carry the rule code; two concurrent `processTank` calls produce one chain; `setAnchor` clears the hold and the next reading chains from the anchor.

### Task 7: Verify and hand over
**Files:** `README.md`, `Dockerfile`, `docker-compose.yml`
- [ ] `npm run typecheck`, `npm test`, `npm run build` all pass; README covers capture-mode steps for one controller.
