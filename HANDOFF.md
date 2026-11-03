# Handoff, round 2: verify the fixes and attack them (Windows, PowerShell)

This is the second round. Round 1 (your own `review/FINDINGS.md`, 21 findings) has been worked through: every
finding is fixed and its test is now part of the suite (`tests/findings.test.ts`, `tests/review-helpers.ts`,
`tests/model.test.ts`). See "Second review" at the end of `docs/REVIEW.md` for the finding-by-finding table.
Your job now is to check the fixes and to try to break what changed. Round 1's lesson: the dangerous bugs were in
the interaction between features, not in one function.

You are a fresh reviewer. The code was written and tested in a cloud sandbox (Linux, no Docker, no access to
MoEnergy). Do not trust it because it says it passes: run it, then try to break it.

## New since round 2 (2026-11-03, after the first real controller data)

Review these too, they are new code: `src/import/tankmsr.ts` (TANKMSR.CSV importer: local time to UTC, rows without litres left out, rows
stamped `00:00:00` set aside as `clock_invalid`, same-second duplicates, idempotent), `scripts/sim/` (seeded generator calibrated on the
real station, a TANKMSR writer, a strict MoEnergy written from the guide, a scenario runner with end-of-run checks), `scripts/sim.ts`,
`scripts/replay-tankmsr.ts`, `scripts/import-tankmsr.ts`, and the tests `tests/sim.*.test.ts`, `tests/import.tankmsr.test.ts`. Docs:
`docs/SIMULATION.md`, `docs/REAL_DATA_FINDINGS.md`, `docs/plans/2026-11-03-roadmap-v2.md`; `docs/SCALING.md` and
`docs/PTS2_DATA_ACQUISITION.md` were corrected. Also new: `render.yaml`, `scripts/seed-demo.ts` and `scripts/sim/demo.ts`, `scripts/sim/seed.ts`, `PGSSL` in `src/db/pool.ts`, an optional fixed `key` in `createClient`, `tests/demo.test.ts` (the client API walked over HTTP) and `docs/DEPLOY_RENDER.md`; the calibration charts moved to `scripts/sim/data/` (the Docker image copies them). The demo seeding must stay inert unless `DEMO_SEED=true`: try to make it run, or leave a demo key valid, in a production setup. Things worth attacking: is the strict MoEnergy's order of checks plausible, can the
importer's `ON CONFLICT` targets lose a good row, can a real `00:00:00` reading be wrongly discarded, are the end-of-run checks blind to
a bug you can think of (try a mutation and run `npm run sim`).

## The picture in one minute

One application on one server (one process, one codebase, one PostgreSQL). It has two doors:

| Door | Who uses it | URL | Per station? |
| --- | --- | --- | --- |
| Upload | the PTS-2 controller of a station | `/pts/<secret>` | yes: every station has its own secret, so its own URL |
| Client API | the client's system | `/v1/stations/{operator_station_code}/...` | yes: every station has its own links, its own open batch, and keys that can be bound to one station |

Plus `/healthz` and `/readyz`. A "link per station" is a path and a key on the same application, not a separate
service: one place to patch and monitor, one ledger, and stations are kept apart by data scoping (station id on
batches, keys, tanks), per-station locks and per-station batches.

Flow: controller -> upload door -> raw store -> (parser, not built yet) -> readings -> ledger (validates and chains)
-> per-station batch -> client fetches it, forwards it to MoEnergy unchanged, and posts MoEnergy's answer back.
We never contact MoEnergy.

Read, in this order: `README.md`, `docs/API.md` (what the client sees), `docs/REVIEW.md` (what three earlier
read-only reviewers found and what was done), `docs/plans/`, then the code. The design document is at
https://claude.ai/artifact/PMuLZG17iHyCLZXGLcaFov .

## 1. Verify (about 20 minutes)

Needs Node 22 or newer, Docker Desktop and Python 3. The folder name `PTS  API` has two spaces: quote paths, or copy
the project to a path without spaces (for example `C:\dev\pts2-gateway`).

```powershell
cd "C:\Users\star\Downloads\PTS  API\pts2-gateway"
npm ci

# a PostgreSQL 16 for the tests
docker run -d --name pts2-test -p 54329:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=pts2_test postgres:16
$env:TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:54329/pts2_test"

npm run typecheck
npm test
npm run build
python scripts\mutation-check.py      # or: py -3 scripts\mutation-check.py ; every line must say KILLED
```

The test database is dropped and rebuilt on every run, so point `TEST_DATABASE_URL` only at a database whose name
contains `test`. `npm run test:db:start` is Linux only.

Expected: 300 tests pass (17 files), typecheck and build exit 0, no SURVIVED mutation (about 65 of them; each runs
the suite with `--bail 1`, so a mutant the tests notice costs seconds; the script restores every file it touches).
Report any difference.

Then Docker. This has been run once by hand on the Windows machine (see the last section of `docs/REVIEW.md`: build, healthcheck, non-root, read-only, 1 s shutdown, data kept), so repeat it and look for what that run could not show:

```powershell
Copy-Item .env.example .env          # set POSTGRES_PASSWORD (the example value is refused)
docker compose up -d --build
curl.exe -s localhost:8080/healthz ; curl.exe -s localhost:8080/readyz
docker compose exec app node dist/scripts/add-station.js --code RYD-01 --name "Riyadh North"
docker compose exec app node dist/scripts/add-client.js --name "client system" --all
docker compose exec app node dist/scripts/add-client.js --name "RYD-01 system" --station RYD-01
docker compose exec db psql -U postgres pts2 -c "\dt"
docker compose down
```

Check: the image builds, the six migrations run once and are recorded, the app starts as a non-root user with a
read-only filesystem, `docker compose down` stops it cleanly (the app should exit 0 within a second or two, not
after the 10 s kill timeout: that is what `exec` in the compose command is for), and `\dt` shows 14 tables (13
application tables plus `schema_migrations`).

Then the API by hand (use the secret and the key the two commands above printed):

```powershell
curl.exe -i -X POST -H "content-type: application/json" -d "{}" "localhost:8080/pts/<secret>"                # 200
curl.exe -i -H "Authorization: Bearer <key>" "localhost:8080/v1/stations/RYD-01/readings/batches/next"       # 204
curl.exe -i -H "Authorization: Bearer <station-bound key>" "localhost:8080/v1/stations/OTHER/readings/batches/next"   # 404
```

## 2. Review: attack the fixes

Everything below is new since round 1. For each, try to make it fail and keep a test or a reproduction:

1. **Duplicate at item 0 now confirms that item only** (`src/batches/result.ts`, the `DUPLICATE_READING_STORED`
   branch). The batch shrinks to `item_count = 1` and the other items are released. Look for: a batch whose stored
   `size_bytes` / `body_sha256` stop matching its rows, an accepted batch that still owns released rows, a loop that
   never ends (a duplicate that keeps coming back at item 0 of every next batch), and the cost on a long backlog.
2. **Anchor `as_of` and `accept_negative`** (`src/ledger/service.ts` `loadState`/`setAnchor`, `src/domain/ledger.ts`).
   An anchor counts only until the next emit. Can `acceptNegativeOnce` leak to a second reading, survive a re-chain,
   or let a refill through on a tank that MoEnergy refused (`tanks.negative_refused_at`)? Can `as_of` swallow a
   reading that was never at MoEnergy?
3. **A duplicate in the middle** marks that reading `skipped` and holds the tank once. Is skipping the right call
   when the stored value differs from ours? Can the tank end up held with nothing for an anchor to fix?
4. **The `skipped` status** (`remaining_not_above_water`, migration 005). It breaks the "chain never moves"
   argument if a skipped reading is ever counted as emitted. Check the batch builder, the hold release and the
   counters. Also: a tank that is really empty for hours: what do we send, and what does MoEnergy see?
5. **Re-chain cut** (`processTank`): the cut is now the newest SENT row. Try rows inside an open batch, rows after
   an anchor, equal timestamps, and the builder racing the ledger (the build retries when a claim comes up short).
6. **Station gate** (`enterStation` in `src/batches/builder.ts`): requests for one station queue in the process,
   32 at most. Look for a way to leak a turn (an exception between `enterStation` and `leave`), a deadlock with the
   advisory lock, and what happens with two app instances.
7. **Release endpoint** (`POST .../batches/{id}/release`) and the anchor validation (`src/api/routes.ts`): is
   releasing really always safe? Can a key for station A release or anchor anything of station B?
8. **Logging and errors** (`loggablePath`, `frameworkErrors`, `canonicalJson` in `src/batches/result.ts`): any route
   or error that still prints a secret or a path; a canonical form that makes two different answers equal.
9. **Migration 005 and the edited 004** on a populated database (held tanks, readings in the new status).
10. **Unchanged but worth a second look:** per-station isolation, numbers and rounding, and everything in round 1's
    list that you did not test deeply.

Please also rerun your random-flow model against the new code, adding the new moves: release, anchor with
`as_of`, anchor with `accept_negative`, MoEnergy refusing negatives.

## 3. Known gaps (not bugs, not built yet)

No jsonPTS parser and no real reply to the controller (waiting for captured data); no time rules (device clock to UTC,
`clock_invalid`); no link from `raw_uploads` to `readings`; no registration endpoints for stations and tanks and no
reference-data endpoint; no background worker (the ledger runs when the client asks for the next batch); no alerts,
no health report, no retention pruning, no backups; TLS is expected from a reverse proxy. Nothing has been checked
against the live MoEnergy service. `docs/REVIEW.md` lists what was deliberately deferred.

## 4. What to send back

A short list: what you ran and what passed; each finding with file and line, severity (breaks the chain, loses data,
security, or minor), and a failing test or steps to reproduce; what you could not verify.
