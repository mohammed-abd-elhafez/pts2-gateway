# Client API Implementation Plan (plan 2, protocol-independent part)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** The API the client's system calls: fetch a ready MoEnergy-shaped batch, report MoEnergy's answer, and anchor a tank.

**Architecture:** Emitted ledger rows are grouped into one open batch at a time. The batch body is serialised by a typed serialiser and is byte-for-byte what MoEnergy accepts. The client posts MoEnergy's HTTP status and body back; a result handler maps each answer to a fixed action. Everything runs on the schema from plan 1 plus migration 002.

**Spec:** Design doc (rev 42) sections "API design" and "Validation and the stock-chain ledger"; MoEnergy guide section 2.7 and 1.4.

## Global Constraints

- Only one batch is `open` at any time (partial unique index); the next is built only after the open one is closed.
- A batch body is `{"readings":[...]}` under 900,000 bytes; fields and JSON types exactly as in the guide's sample (quantities and heights are numbers; codes and `reading_at` are strings; `temperature` is omitted when absent).
- Items of one tank stay in time order, across batches too; a tank's readings are taken as a gapless prefix.
- A reading is eligible only after the settle window (default 2 minutes since it was stored) and only if its station and tank have MoEnergy codes.
- Asking for the open batch again returns the same body, id and correlation id.
- Result handling per the design table: `200` with `accepted_count` equal to the item count closes as accepted; `DUPLICATE_READING_STORED` at item 0 counts as accepted (a resend of a stored batch); `REMAINING_QUANTITY_INCONSISTENT` holds the tank and returns its unsent readings to pending; any other 422 with an `item_index` quarantines that item (`moenergy:<sourceErrorCode>`), returns later readings of the tank to pending, and also holds the tank if that item's consumed quantity was negative; `409`, `429`, `5xx` and `401`/`403`/`413` change nothing.
- The same result posted twice gives the same response without a second effect; a different result for a closed batch is `409`.
- Client keys are stored as SHA-256 hashes; authentication runs before the body is parsed.
- An anchor is refused (`409`) while the tank still has unsent emitted readings.

## Review Focus

- Result body that is not MoEnergy-shaped (a string, `null`, no `errors`): batch stays open, nothing quarantined.
- `item_index` outside the batch, or negative: batch stays open.
- Two clients polling `next` at once: still one batch.
- Chain break reported for a tank whose earlier items were fine: only that tank's readings are removed from the rebuilt batch.
- A reading that arrived inside the settle window blocks later readings of its tank but not other tanks.

## Tasks

### Task 1: Migration 002 and serializer
**Files:** `migrations/002_batches_api.sql`, `src/moenergy/serialize.ts`, `tests/serialize.test.ts`
**Produces:** `toMoEnergyReading(r: ReadingForBatch): MoEnergyReading`, `serializeBatch(items): string`, `readingJsonBytes(item): number`, `formatReadingAt(d: Date): string`; `mmToMetersMilli(mm: string): Milli` in `src/domain/quantity.ts`.
- [ ] Tests: the guide's two-reading sample body is reproduced exactly; every field's `typeof` matches the sample; `temperature` omitted when null; `reading_at` has no milliseconds when zero.

### Task 2: Batch builder
**Files:** `src/batches/builder.ts`, `src/ledger/worker.ts`, `tests/batches.test.ts`
**Produces:** `getOrCreateNextBatch(pool, opts: {now: () => Date; settleMs?: number; maxBytes?: number}): Promise<BuiltBatch | null>`; `runLedgerOnce(pool, opts: ProcessOptions): Promise<{emitted; quarantined}>`.
- [ ] Tests: empty → null; items ordered by time with positions and exact size; second call returns the same batch; tanks without codes skipped; settle window blocks only the affected tank; size cap splits with per-tank order kept; concurrent calls build one batch.

### Task 3: Result handling
**Files:** `src/batches/result.ts`, `tests/result.test.ts`
**Produces:** `applyResult(pool, batchId, result: {status: number; body: unknown}): Promise<{outcome: ResultOutcome; replayed: boolean}>`; errors `BatchNotFoundError`, `BatchClosedError`.
- [ ] One test per row of the design's result table, plus: chain break leaves other tanks' items in the rebuilt batch; negative-consumed item rejection holds the tank; malformed bodies keep the batch open; replay is idempotent.

### Task 4: Client API
**Files:** `src/api/clients.ts`, `src/api/routes.ts`, `scripts/add-client.ts`, `src/app.ts`, `src/ledger/service.ts`, `tests/api.test.ts`
**Produces:** `createClient(pool, name): Promise<{id; key}>`; routes `GET /v1/readings/batches/next`, `POST /v1/readings/batches/:id/result`, `POST /v1/tanks/:tank_code/anchor`; `setAnchor(..., opts?: {requireNoUnsent?: boolean})` throwing `UnsentReadingsError`.
- [ ] Tests via `inject`: missing, wrong and revoked key → 401 on every route; `next` 204/200 with `X-Batch-Id` and `X-Correlation-Id`; result 200 closes, repeat replays, different → 409; malformed result (missing field, extra field, wrong type) → 422 naming the field; unknown batch → 404; anchor 404/422/409/200; an end-to-end chain break → hold → anchor → next batch continues.

### Task 5: Verify and hand over
**Files:** `README.md`, `HANDOFF.md`
- [ ] Typecheck, build, full test run, one mutation check per critical guard; write `HANDOFF.md` for a fresh reviewer.
