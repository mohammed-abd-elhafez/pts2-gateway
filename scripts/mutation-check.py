#!/usr/bin/env python3
"""Mutation check: break one critical guard at a time and confirm the test suite notices.

Run from the project root with the test database up:  python3 scripts/mutation-check.py
Every line must say KILLED. A SURVIVED line means a guard no test protects.
Each source file is restored afterwards; run `git diff` (or the tests) to confirm.
"""
import os, re, shutil, subprocess, sys, tempfile

MUTATIONS = [
  ("one open batch (builder returns existing)", "src/batches/builder.ts", "if (open) {", "if (false as boolean && open) {"),
  ("per-tank prefix when a reading is not settled", "src/batches/builder.ts", "blocked.add(row.tank_id);", "/* mutated */"),
  ("chain break removes the tank's unsent readings", "src/batches/result.ts", "await unemitFrom(c, Number(item.tank_id), 1);", "/* mutated */"),
  ("duplicate counts as resend only at item 0", "src/batches/result.ts", "err.sourceErrorCode === 'DUPLICATE_READING_STORED' && err.itemIndex === 0", "err.sourceErrorCode === 'DUPLICATE_READING_STORED'"),
  ("negative-consumed rejection holds the tank", "src/batches/result.ts", "await holdTank(c, item.tank_id, 'moenergy_negative_rejection');", "/* mutated */"),
  ("idempotent replay of an identical result", "src/batches/result.ts", "if (batch.result_digest === digest && batch.result_response) {", "if (false as boolean) {"),
  ("API key check", "src/api/routes.ts", "if (!client) {", "if (false as boolean) {"),
  ("anchor refused while readings are unsent", "src/ledger/service.ts", "if (opts.requireNoUnsent) {", "if (false as boolean) {"),
  ("tank lock in the ledger", "src/ledger/service.ts", " WHERE id = $1 FOR UPDATE`", " WHERE id = $1`"),
  ("unknown properties are errors", "src/app.ts", "removeAdditional: false", "removeAdditional: true"),
  ("ingest parsers stay out of the JSON API", "src/app.ts", "app.register(async (ingest) => registerIngestRoutes(ingest, { pool, config }));", "registerIngestRoutes(app, { pool, config });"),
  ("candidates limited to the station", "src/batches/builder.ts", "WHERE t.station_id = $1", "WHERE $1::bigint IS NOT NULL"),
  ("open batch looked up per station", "src/batches/builder.ts", "WHERE status = 'open' AND station_id = $1", "WHERE status = 'open' AND $1::bigint IS NOT NULL"),
  ("result limited to the station's own batch (all uses)", "src/batches/result.ts", "WHERE id = $1 AND station_id = $2 FOR UPDATE", "WHERE id = $1 AND $2::bigint IS NOT NULL FOR UPDATE"),
  ("station-bound key cannot reach other stations", "src/api/routes.ts", "(client.stationId !== null && client.stationId !== station.id)", "false"),
  ("anchor limited to the station's own tanks", "src/api/routes.ts", "moenergy_tank_code = $1 AND station_id = $2", "moenergy_tank_code = $1 AND $2::bigint IS NOT NULL"),
  ("ledger run limited to the asking station", "src/ledger/worker.ts", "($1::bigint IS NULL OR t.station_id = $1)", "($1::bigint IS NULL OR true)"),
  ("a reading must settle before it is chained", "src/ledger/service.ts", "if (row.created_at.getTime() > cutoff.getTime()) break;", "/* mutated */"),
  ("an older reading is re-chained into place", "src/ledger/service.ts", "if (tail.first_seq !== null) {", "if (false as boolean) {"),
  ("re-chaining never reaches a sent row", "src/ledger/service.ts", "(sentUntil === null || t > sentUntil.getTime())", "true"),
  ("hold policy release", "src/ledger/service.ts", "policy === 'allow' && tankRow.held_reason === 'negative_consumed'", "false"),
  ("only a negative_consumed hold is released by policy", "src/ledger/service.ts", "policy === 'allow' && tankRow.held_reason === 'negative_consumed'", "policy === 'allow'"),
  ("duplicate in the middle holds the tank", "src/batches/result.ts", "code === 'REMAINING_QUANTITY_INCONSISTENT' || code === 'DUPLICATE_READING_STORED'", "code === 'REMAINING_QUANTITY_INCONSISTENT'"),
  ("quarantine breaker limit", "src/batches/result.ts", "opts.breakerWindowMs ?? DEFAULT_BREAKER_WINDOW_MS)) >= limit) {", "opts.breakerWindowMs ?? DEFAULT_BREAKER_WINDOW_MS)) >= limit + 1000) {"),
  ("breaker counts only this station", "src/batches/result.ts", "WHERE t.station_id = $1 AND q.rule_code LIKE 'moenergy:%'", "WHERE $1::bigint IS NOT NULL AND q.rule_code LIKE 'moenergy:%'"),
  ("breaker counts only recent refusals", "src/batches/result.ts", "AND q.created_at > now() - ($2::double precision * interval '1 millisecond')", "AND $2::double precision > 0"),
  ("attention is recorded on a short count", "src/batches/result.ts", "await c.query(`UPDATE batches SET attention = true WHERE id = $1`, [batchId]);", "/* mutated */"),
  ("correlation id check", "src/batches/result.ts", "opts.correlationId !== undefined && opts.correlationId !== batch.correlation_id", "false"),
  ("every result is recorded", "src/batches/result.ts", "await recordResult(c, batchId, result, decision.outcome.action, false);", "/* mutated */"),
  ("a refused result is recorded", "src/batches/result.ts", "await recordResult(c, batchId, result, 'refused_batch_closed', false);", "/* mutated */"),
  ("path with an empty segment carries no secret", "src/ingest/auth.ts", "if (path.includes('//')) return null;", "/* mutated */"),
  ("secret removed from header values", "src/ingest/store.ts", "if (typeof v === 'string') out[k] = redactSecret(v, secret);", "if (typeof v === 'string') out[k] = v;"),
  ("secret removed from the stored query", "src/ingest/store.ts", "u.query === null ? null : redactSecret(u.query, u.secret),", "u.query,"),
  ("404 does not echo the URL", "src/app.ts", "app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));", "/* mutated */"),
  ("jsonb refusal keeps the raw upload", "src/ingest/store.ts", "if (json === null || !isJsonbRefusal(err)) throw err;", "throw err;"),
  ("station code length limit", "src/stations/lookup.ts", "code.length > 64", "code.length > 6400"),
  ("station code control characters", "src/stations/lookup.ts", r"/[\u0000-\u001f\u007f]/.test(code)", "false"),
  ("1 MB limit outside ingest", "src/app.ts", "bodyLimit: DEFAULT_BODY_LIMIT_BYTES,", "bodyLimit: 50 * 1024 * 1024,"),
  ("bounded waits answer 503", "src/app.ts", "if (err.code === 'STATION_BUSY' || err.code === '55P03' || err.code === '57014' ||", "if (false as boolean ||"),
  ("one failing tank does not stop the rest", "src/ledger/worker.ts", "filter.onError?.(Number(row.tank_id), err);", "throw err;"),
  ("an open batch must not drift", "src/batches/builder.ts", "(open.body_sha256 !== null && sha256(body) !== open.body_sha256)", "false"),
  ("ingest authenticates before the body", "src/ingest/routes.ts", "      onRequest: authenticate,\n", ""),
  ("pool error handler", "src/db/pool.ts", "pool.on('error', opts.onError ?? ((err) => console.error('database pool error:', err.message)));", "/* mutated */"),
  ("pool connection timeout", "src/db/pool.ts", "connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,", ""),
  ("the query string stays out of the logs", "src/app.ts", "url: loggablePath(req.url),", "url: req.url,"),
  ("secret removed from stored path", "src/ingest/routes.ts", "path: redactSecret(redactUrl(qIndex === -1 ? req.url : req.url.slice(0, qIndex)), secret),", "path: redactUrl(qIndex === -1 ? req.url : req.url.slice(0, qIndex)),"),
  ("a remaining quantity not above water is skipped", "src/domain/ledger.ts", "if (!(chain.remaining > measured.waterVolume)) {", "if (false as boolean) {"),
  ("the anchor's as_of reaches the chain", "src/ledger/service.ts", "lastEffectiveAt: asOf && (!lastAt || asOf.getTime() > lastAt.getTime()) ? asOf : lastAt,", "lastEffectiveAt: lastAt,"),
  ("an anchor lets one refill pass", "src/domain/ledger.ts", "if (policy === 'hold' && !state.acceptNegativeOnce) {", "if (policy === 'hold') {"),
  ("a tank whose negatives were refused holds them", "src/ledger/service.ts", "const policy: NegativePolicy = tankRow.negative_refused_at ? 'hold' : opts.policy;", "const policy: NegativePolicy = opts.policy;"),
  ("a refused negative is remembered", "src/batches/result.ts", "await c.query(`UPDATE tanks SET negative_refused_at = now() WHERE id = $1`, [item.tank_id]);", "/* mutated */"),
  ("a stored duplicate confirms item 0 only", "src/batches/result.ts", "WHERE batch_id = $1 AND batch_position > 0`", "WHERE batch_id = $1 AND batch_position < 0`"),
  ("a duplicate in the middle is never sent again", "src/batches/result.ts", "await c.query(`UPDATE readings SET ledger_status = 'skipped' WHERE id = $1`, [item.reading_id]);", "/* mutated */"),
  ("a released batch frees its items", "src/batches/result.ts", "await releaseItems(c, batchId);\n    const outcome", "const outcome"),
  ("requests for one station take turns before taking a connection", "src/batches/builder.ts", "await previous;", "/* mutated */"),
  ("a build that lost its rows is thrown away", "src/batches/builder.ts", "if (claimed.rowCount !== picked.length) {", "if (false as boolean) {"),
  ("an unparsable stored value is set aside", "src/ledger/service.ts", "if (!(err instanceof QuantityError)) throw err;", "throw err;"),
  ("an anchor must be above 0 and within capacity", "src/api/routes.ts", "if (remaining <= 0 || remaining > parseMilli(tank.capacity_litres)) throw new QuantityError('out of range');", "/* mutated */"),
  ("an anchor with more than 3 decimals is refused", "src/api/routes.ts", "parseMilli(req.body.remaining_quantity, { strict: true })", "parseMilli(req.body.remaining_quantity)"),
  ("a NUL byte in the anchor reason is a 422", "src/api/routes.ts", "const NO_NUL = '^[^\\\\u0000]*$';", "const NO_NUL = '^.*$';"),
  ("a NUL byte in the tank code is a 404", "src/api/routes.ts", "if (req.params.tank_code.includes('\\u0000'))", "if (false as boolean)"),
  ("the same answer in another key order is a replay", "src/batches/result.ts", "update(canonicalJson({ status: result.status, body: result.body ?? null }))", "update(JSON.stringify({ status: result.status, body: result.body ?? null }))"),
  ("an unrouted path is not logged", "src/ingest/auth.ts", "return '[unrouted]';", "return path;"),
  ("a bad URL does not echo the path", "src/app.ts", "frameworkErrors: (_err, _req, reply) => {", "frameworkErrorsOff: (_err: unknown, _req: unknown, reply: unknown) => {"),
  ("the ledger run is inside the station's turn", "src/api/routes.ts", "const leave = await enterStation(stationId);", "const leave = () => undefined;"),
  ("replays store no body", "src/batches/result.ts", "const text = replayed ? null : JSON.stringify(result.body ?? null);", "const text = JSON.stringify(result.body ?? null);"),
  ("repeat attempts per batch are bounded", "src/batches/result.ts", "if (first >= MAX_ATTEMPTS_KEPT && (replayed || action === 'refused_batch_closed')) return;", "/* mutated */"),
  ("a dead connection fails instead of hanging", "src/db/pool.ts", "keepAlive: true,", ""),
  ("a tank emits no further than its window", "src/ledger/service.ts", "if (out.emitted >= room) break;", "/* mutated */"),
  ("emitted readings leave pending after the bulk insert", "src/ledger/service.ts", "await c.query(`UPDATE readings SET ledger_status = 'emitted' WHERE id = ANY($1::bigint[])`, [emits.map((e) => e.readingId)]);", "/* mutated */"),
  ("only a quantity field counts as a refused refill", "src/batches/result.ts", "const quantityField = err.field === null || err.field === 'consumed_quantity' || err.field === 'remaining_quantity';", "const quantityField = true;"),
  ("the measurement is rounded to the configured decimals", "src/ledger/service.ts", "roundMilli(parseMilli(row.fuel_volume_l), decimals)", "parseMilli(row.fuel_volume_l)"),
  ("an anchor is rounded to the configured decimals", "src/api/routes.ts", "remaining = roundMilli(parseMilli(req.body.remaining_quantity, { strict: true }), config.quantityDecimals);", "remaining = parseMilli(req.body.remaining_quantity, { strict: true });"),
  ("an inactive tank is left out of the batch", "src/batches/builder.ts", "WHERE t.station_id = $1 AND t.is_active", "WHERE t.station_id = $1"),
]

only = sys.argv[1:]
NPX = shutil.which("npx") or "npx"  # on Windows this resolves npx.cmd
survived = []
with tempfile.TemporaryDirectory() as tmp:
    for name, path, old, new in MUTATIONS:
        if only and not any(f.lower() in name.lower() for f in only):
            continue
        with open(path, encoding="utf-8", newline="") as fh:
            src = fh.read()
        if src.count(old) != 1 and not (name.endswith('(all uses)') and src.count(old) >= 1):
            print(f"!! {name}: pattern found {src.count(old)} times in {path}"); survived.append(name + " (pattern)"); continue
        backup = os.path.join(tmp, "backup")
        shutil.copy(path, backup)
        try:
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(src.replace(old, new))
            try:
                # --bail stops at the first failing test, so a mutant the tests notice costs seconds, not a full run
                r = subprocess.run([NPX, "vitest", "run", "--bail", "1"], capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", timeout=900)
                out = (r.stdout or "") + (r.stderr or "")
                m = re.search(r"Tests\s+(.*)", out)
                killed = r.returncode != 0
                note = m.group(1).strip() if m else "?"
            except subprocess.TimeoutExpired:
                killed, note = True, "timed out (a hang counts as noticed)"
            print(("KILLED  " if killed else "SURVIVED") + f"  {name}   [{note}]", flush=True)
            if not killed: survived.append(name)
        finally:
            shutil.copy(backup, path)
print("\nsurvivors:", survived or "none")
