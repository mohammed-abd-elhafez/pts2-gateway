# Scaling: what was measured and what it means

Requirement from the client: 38 stations at the start, then 4 more every month (about 86 after a year, 134 after
two, 182 after three).

## Real load (measured on one real station, 2026-11-03; see `REAL_DATA_FINDINGS.md`)

A PTS-2 stores a tank record when the product height changes, plus a time tick. The station we have data from (5 tanks)
stored **about 100 to 120 records a day** (about 190 if the rows stamped `00:00:00` are counted; those are not sent).

| After | Stations | Records per second | Records per year | Readings storage per year (0.73 KB each) |
| --- | --- | --- | --- | --- |
| start | 38 | 0.04 to 0.08 | 1.4 to 2.6 million | 1 to 2 GB |
| 1 year | 86 | 0.10 to 0.19 | 3.1 to 5.9 million | 2 to 4 GB |
| 3 years | 182 | 0.21 to 0.40 | 6.6 to 12.6 million | 5 to 9 GB |

This is about 40 times below the model that follows, which stays as the worst case for a replay after an outage. One
station is one sample: re-check with a second one, and keep a margin of 3 times.

## Worst-case model (assumptions: 5 tanks per station, one reading per tank per minute)

| After | Stations | Tanks | Readings per second | Readings per year |
| --- | --- | --- | --- | --- |
| start | 38 | 190 | 3.2 | about 100 million |
| 1 year | 86 | 430 | 7.2 | about 226 million |
| 2 years | 134 | 670 | 11.2 | about 352 million |
| 3 years | 182 | 910 | 15.2 | about 478 million |

## Measurement (`scripts/load-test.ts`)

The worst case a real outage produces: every controller replays 24 hours of readings at once, and the client works
through its stations 4 at a time. Readings are inserted directly (the parser does not exist yet), then the real code
runs: ledger, batch build, result. One PostgreSQL 16 and one Node process on the build machine (a cloud container,
not the production server), pool of 10 connections.

| Scenario | Readings | Time to drain | Speed | GET next p50 / p95 / max |
| --- | --- | --- | --- | --- |
| 38 stations, before the change below | 273,600 | 123 s | 2,200 /s | 0.6 s / 13.0 s / 13.4 s |
| 38 stations | 273,600 | 31 s | 8,900 /s | 0.6 s / 2.8 s / 3.3 s |
| 182 stations | 1,310,400 | 154 s | 8,500 /s | 0.7 s / 2.9 s / 3.8 s |

The ledger used to write each reading with two statements; it now writes a tank's readings with two statements in
total, and each tank keeps at most `EMISSION_WINDOW` (2000) emitted-but-unsent readings, which bounds the work a
refusal from MoEnergy or a late reading can cause (before: the whole unsent tail, up to 100,000 rows).

Even the minute-by-minute model is 3 to 15 readings per second, far below what was measured, and the real load is 40 times
lower still. Speed is not a constraint for the next three years.

## Storage

Measured: about 0.73 KB per reading (readings, ledger and indexes), without `raw_uploads`. With the real load that is
1 to 2 GB a year at 38 stations and under 10 GB at 182 (table above). The older table (70 / 165 / 350 GB a year) assumed a
reading per minute and is only the upper bound.

- keep `raw_uploads` 90 days (a simple delete job; a controller upload carries a few records);
- no partitioning and no physical backups are needed at these sizes; a nightly `pg_dump` copied off the server is enough
  (the scripts in `deploy/` do it, with a restore test);
- revisit partitioning of `readings` by `effective_at` only if the real load turns out to be 10 times the measured one.

## Servers

- Start: 2 vCPU, 4 to 8 GB RAM, 100 GB SSD, one application process, PostgreSQL on the same machine (the 4 vCPU / 16 GB
  figure in `deploy/` was sized for the minute-by-minute model and leaves a large margin; the compose overlay's PostgreSQL
  settings can be lowered to match).
- Around 100 stations: nothing needs to change at the measured load. Move PostgreSQL to its own machine only for operational
  reasons (backups, upgrades) or if the load is found to be much higher.
- The application is stateless apart from the per-station queue inside a process; a second instance is safe because
  the database locks (advisory lock per station, row lock per tank) decide, and the queue only saves connections.

## What this does not tell

- The number of tanks per station elsewhere, and the upload size (the first captures will show it).
- How the parser will behave (it will run in a background worker, not in the upload request).
- MoEnergy's own limits and speed; every batch has to wait for the client to forward it.
- Behaviour on the production server, with TLS and the proxy in front.

Re-run with the real numbers: `npx tsx scripts/load-test.ts --stations 38 --tanks 5 --hours 24 --parallel 4`
(it creates and drops its own database named `pts2_load`).
