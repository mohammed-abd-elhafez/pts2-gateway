# Independent review: findings and what was done

Three reviewers with a fresh context (schema, security, incident scenarios) read the code. **They could only read
files: none of them ran anything**, so every claim was treated as a hypothesis. Each one below was checked by
reading or by running it before acting, and the fixes are covered by tests and by mutation checks
(`python3 scripts/mutation-check.py`: every guard must be KILLED).

## Confirmed by running it, then fixed

| Finding | Evidence | Fix |
| --- | --- | --- |
| Ingest authenticated after the body was buffered (20 MB per unauthenticated request) | lifecycle order; 30 MB body with a wrong secret now answers 401 | secret checked in `onRequest`; non-ingest routes take 1 MB |
| Secret leaked through `/pts//<secret>`, through the default 404 body and log line, and through the query string in the request log | reproduced: stored path and logs contained it | empty path segments carry no secret; own 404 handler; the secret is removed from stored header values and query; the request log never prints a query string |
| JSON that PostgreSQL refuses but `JSON.parse` accepts (lone surrogate, 20,000-deep nesting) made the upload fail with 500 and nothing stored | reproduced | the upload is kept without `body_json` |
| NUL byte in a station code made the API answer 500 | reproduced | invalid codes answer the uniform 404 without touching the database |
| `pg.Pool` crashed the process when the database dropped an idle connection | reproduced | error handler; every wait bounded (connect, statement, lock); bounded waits answer `503 busy` |
| Batch candidate query scaled with other stations' backlog (145 ms with 200,000 unsent rows elsewhere) | EXPLAIN ANALYZE | per-tank lateral read with a limit of 2,000 (38 ms, independent of other stations). A first version with a large limit was **slower** (3 s): the planner abandoned the index when the limit was large |
| README claimed a policy switch releases a held tank; the code did not | read | now true for holds made by the `hold` policy; other holds need an anchor; reason and time are recorded |
| `batch result needs a look` warned on every accepted batch | read | levels by outcome: info, warn (ledger changed), error (needs a person) |
| `docker compose` ran `sh -c "a && b"`, so SIGTERM never reached node | known behaviour | `exec` |

## Accepted from the reviews and fixed (design, not bugs)

- A reading is chained only after the settle window, and an older reading that arrives late is put back in order
  when everything after it is still unsent (before: it was set aside permanently).
- A stored duplicate in the middle of a batch holds the tank instead of quarantining a reading MoEnergy already has.
- A short `accepted_count` marks the batch, so a following "stored duplicate" is not read as a confirmation.
- MoEnergy refusing readings one by one stops after 5 per station per hour (breaker).
- Every posted result is kept (`batch_results`); the result can carry the correlation id.
- Database invariants: accepted-batch rows are immutable, a closed batch never changes, exact chain arithmetic,
  non-negative stock, hold and reason kept together, `ON DELETE SET NULL` for pruning raw uploads, indexes.
- An open batch is checked against a hash of what was built, so renaming a MoEnergy code cannot change its bytes silently.
- One tank that cannot be processed no longer stops its station.
- Migration 003 refuses to run with an open batch that spans stations and backfills accepted batches.

## Deliberately not done yet (recorded, not forgotten)

- Database role with fewer rights than the superuser (compose); `COPY ... PROGRAM` is the reason it matters.
- Operator tools to requeue quarantined readings by rule and to release a held tank without a client call (a stuck
  batch can be released through the API since the second review), a health
  report with alerts (open batch age, held tanks, quarantines per rule, silent stations, disk), backups, retention
  jobs, partitioning of `readings` and `raw_uploads`, per-IP rate limiting (belongs at the proxy).
- A trigger that checks `fuel_quantity` equals the previous `remaining_quantity` on insert (needs an anchor carve-out).
- Write amplification of `readings.ledger_status` (not HOT), one INSERT and UPDATE per reading, the payload
  guard reading large bodies on a parse-status update. All fine at about one write per second; revisit with real load.
- Not verifiable here: TLS, the live MoEnergy service, real controller payloads. (Docker: see the next section.)

## Second review (independent, on Windows): findings and what was done

Source: `review/FINDINGS.md` of the reviewer. Every finding has a test in `tests/findings.test.ts`
(`tests/review-helpers.ts` holds its fake MoEnergy); all 21 failed before the fixes and pass now. All were
reproduced on the build machine as well, so none was a Windows effect.

| # | Finding | What was done |
| --- | --- | --- |
| F1 | One low reading (a probe glitch to 0 L) made every later reading fail "water below fuel", for good | A reading whose remaining quantity is not above its water volume is `skipped` (own status and rule); the chain does not move |
| F2 | A stored value the column accepts but `parseMilli` refuses stopped the tank forever | Parsed per reading; the reading is quarantined as `value_out_of_range` |
| F3 | A good late reading was quarantined behind a hopeless late one | The cut for re-chaining is the newest sent row, not the first late reading |
| F4 | First start of an existing tank lost new readings (duplicate at item 0 marked the whole batch stored) | A duplicate at item 0 confirms that item only; the rest goes in the next batch. Anchors take `as_of` so an overlapping backlog is not sent at all |
| F5 | A stored reading in the middle of a backlog held the tank forever | That reading is marked `skipped` (never sent again) when MoEnergy reports it; the tank is held once and an anchor now gets past it |
| F6 | A batch could stay open with no way out | `POST .../batches/{id}/release` (always safe because of F4's rule) |
| F7 | Under the hold policy an anchor could not pass a refill | An anchor taken on a tank held for a refill lets that one reading pass (`accept_negative`) |
| F8 | If MoEnergy refuses negative consumed, each anchor round lost one good reading | The refusal is remembered per tank (`negative_refused_at`); the tank then holds negatives itself. Still needs MoEnergy's real answer |
| F9, F10 | Anchor above capacity, at 0, or with more than 3 decimals was accepted | Refused with 422 (above 0, within capacity, at most 3 decimals) |
| F11 | A re-chain between the candidate read and the update gave a batch that differed from its rows | The update must claim every row, otherwise the build is thrown away and redone (3 tries) |
| F12 | Requests waiting for one station's lock used up the pool and stopped other stations' uploads | Requests for one station queue in the process before taking a connection (32 at most, then 503) |
| F13-F15 | Mistyped upload URLs logged the secret; a repeated secret was stored; a malformed escape echoed the path | Only known paths are logged, everything else is `[unrouted]`; the stored path is redacted twice; `frameworkErrors` answers without the path |
| F16, F17 | NUL bytes answered 500 | 422 in the anchor reason, 404 for a tank code |
| F18 | The same answer with keys in another order was refused as a different answer | The replay digest uses canonical JSON |
| F19 | Migration 004 failed on a database with a held tank | Backfills `held_reason` before adding the check |
| M1, M2 | The mutation script could not run on Windows | Temp files via `tempfile`, UTF-8 with replacement, `--bail 1`, longer timeout |

Also from the reviewer's reading: `docker-compose.yml` now passes every setting the README names; the database
password note says letters and digits only. Not changed yet: `is_active` and `registration_state` are not consulted
when building batches; non-negative checks on water and heights; migrations run inside one transaction (no
`CREATE INDEX CONCURRENTLY`); the lack of an index on `quarantine.created_at`; `add-station --offset abc` prints a stack trace.

Still depends on MoEnergy or the client: whether negative consumed is accepted (F7/F8), and the real order in which
MoEnergy checks duplicates and continuity (the fake in the tests assumes duplicates first).

## Third review (four independent read-only reviewers: operations, security, schema, direction)

Several reviewers could not list directories and read only part of the code, so each claim was checked against the
source before anything was changed. A claim that was already handled (indexes the schema reviewer thought missing,
which exist in migrations 002 to 004) was dropped.

Fixed (migration `006` and code; tests in `tests/findings.test.ts`, "third review"):

| Finding | Fix |
| --- | --- |
| `GET next` ran the ledger before the station queue, so waiting requests still held connections | The ledger run and the build are one turn of the queue; the tank lock is `FOR NO KEY UPDATE`, so the future parser's inserts do not wait behind the ledger |
| A dead connection after a failover could hang and keep a pool slot | `keepAlive` and a client-side `query_timeout` just above the statement timeout |
| An API key could grow `batch_results` without limit | Replays store no body, bodies over 64 KB are not kept, a batch keeps at most 20 repeat attempts |
| `quarantine` breaker query had no index; `readings` bloat from the status update; the payload guard compared up to 20 MB on every update | Partial index, autovacuum settings, trigger limited to the payload columns |
| Tank capacity unbounded while the code parses up to 1e9 | CHECK at 10 million litres |
| `add-client` without `--station` silently made an all-stations key | Must say `--station` or `--all` |
| No app healthcheck; slow requests could hold sockets | Compose healthcheck on `/readyz`; request timeout of 5 minutes |
| Unauthenticated floods use the database pool | Not solvable in the app (the proxy sees the address): `docs/PROXY.md` has the rate limits and the log format |

Valid but not done yet (the build order the reviewers agree on): the parser, time rules (a controller clock more than
5 minutes ahead quarantines every reading with no alert), a station and tank registration script, operator scripts
(requeue quarantined readings by rule, release a held tank), a health query with alerts (silent station, open batch
age, held tanks, quarantine per rule, disk), a background ledger worker (a 100,000-record replay makes one `GET next`
take tens of seconds, and `unemitFrom` on a large unsent tail), nightly backups with a tested restore, raw upload
retention, a non-superuser database role.
Accepted risk: readings that arrive older than what MoEnergy may already hold are set aside as `late_arrival` and
cannot be sent later; that is the chain rule, not a defect. Not taken from the direction review: folding `skipped` into
quarantine (cosmetic), and dropping the "confirm item 0 only" rule (it prevents the data loss of F4).
Biggest risk, outside the code: whether MoEnergy accepts negative consumed quantities (every delivery is one).

## Docker run on Windows (2026-11-03, Docker Desktop 4.97, engine 29.9.2, 2 CPUs and 3 GB for the VM)

`docker compose up -d --build` from this folder: image built, database healthy, all six migrations applied once,
the app reported healthy (the compose healthcheck on `/readyz`). Checked by hand:

- the app runs as `uid=1000(node)`, the root filesystem is read-only (`touch /x` fails), `/tmp` is writable;
- 14 tables (13 application tables plus `schema_migrations`);
- `add-station` and `add-client` work in the container; an upload answers 200 and is stored with its path redacted,
  a wrong secret 401, no key 401, an unbound key 204 on its station, a bound key 404 on another station;
- the station secret does not appear in the application log;
- `docker compose stop app` took 1.0 s and the container exited with code 0 (SIGTERM reaches node);
- after stopping and starting the app again the stored data was still there; the database volume was about 49 MB.

Not covered: TLS and the reverse proxy, a long run, restore from a backup, two instances, memory under a large upload.

## Load test and the first performance changes (2026-11-03)

`scripts/load-test.ts` replays 24 hours of readings from every station at once (results in `docs/SCALING.md`).
It showed that the first `GET next` of a station took 13 s because the ledger wrote every reading with two
round trips. Changes: a tank's readings are written in bulk (one insert, one status update); each tank emits at most
2000 readings ahead of what has been sent (`EMISSION_WINDOW`), so putting a tank's unsent tail back stays small.
Result: 38 stations drain in 31 s instead of 123 s, worst `GET next` 3.3 s, and 182 stations drain 1.3 million
readings in 154 s. Tests: 292, including the window and the rollback of the bulk write.

## Small changes after the plan review (2026-11-03)

- A refused refill now needs MoEnergy to name `consumed_quantity` or `remaining_quantity` (or no field at all) before
  the tank is held and remembered as refusing negatives; a refill reading refused for a height or a temperature is
  an ordinary bad item. The deployment-wide version of the refusal was rejected in review: one misread refusal would
  have stopped every delivery everywhere.
- `QUANTITY_DECIMALS` (default 2, as in the guide's examples): the measured litre volumes are rounded once when they
  enter the ledger, so `fuel_quantity` still equals the previous `remaining_quantity` exactly; anchors are rounded the same way.
- Tanks with `is_active = false` are left out of batches (stations have no such flag; a missing MoEnergy code already excludes them).
- `docs/PREPRODUCTION_PROBES.md`: six probes to run against MoEnergy's Preproduction to settle refills, the order in
  which duplicates and chain breaks are reported, decimals, insertion of older readings, and offsets. Tests: 300.
