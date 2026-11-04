# PTS-2 gateway

Receives data from Technotrade PTS-2 forecourt controllers and prepares tank readings in the shape the
Ministry of Energy ATG API (guide v1.1.0) accepts. The client's own system forwards the prepared batches.

**What exists now:** a capture-mode upload endpoint, the database schema, the MoEnergy rule validator, the
stock-chain ledger, the client API (batches, results, anchors), an importer for a controller's `TANKMSR.CSV`, and a simulator and replay tool
(`docs/SIMULATION.md`). **Not built yet:** the jsonPTS parser and the
reply the controller expects (both wait for real captured payloads), registration of stations and tanks with
MoEnergy, the reference-data endpoint, the background worker, alerts and the health report.

Design: https://claude.ai/artifact/PMuLZG17iHyCLZXGLcaFov · Plans: `docs/plans/` · Review brief: `HANDOFF.md`

## Run it

```bash
cp .env.example .env            # set POSTGRES_PASSWORD
docker compose up -d --build    # database, migrations, gateway on 127.0.0.1:8080
```

Put a TLS reverse proxy in front of port 8080. Controllers must reach it over HTTPS.

### Capture one controller (the first real step)

1. Add the station and note the secret it prints (shown once):
   `docker compose exec app node dist/scripts/add-station.js --code RYD-01 --name "Riyadh North" --offset 180`
2. On the controller's **Server** tab, set the domain, port, and the URI to `/pts/<secret>`
   (or use HTTP Basic credentials with the secret as the password).
3. Leave it 24 to 48 hours. Every upload is stored untouched in `raw_uploads`
   (`body_raw` is the exact bytes, `body_json` the parsed JSON when valid).
4. Send the stored uploads and the controller's Server-tab screenshot back for the parser work:
   ```sql
   SELECT id, arrived_at, path, content_type, body_bytes, convert_from(body_raw, 'UTF8') AS body
     FROM raw_uploads ORDER BY id LIMIT 50;
   ```

The endpoint answers every authenticated request with `CAPTURE_REPLY_BODY`. If the controller keeps
re-sending the same data, the reply is not what it expects; the real jsonPTS reply replaces it in plan 2.

## Client API

Every station has its own link set under `/v1/stations/{operator_station_code}/...` (the operator's own code,
for example `RYD-01`, matched ignoring case) and its own open batch, so a station waiting for a result never holds
up another. Full reference in the MoEnergy-guide style: **`docs/API.md`**.

Keys: `Authorization: Bearer <key>`, shown once when created.

```bash
# one key for every station
docker compose exec app node dist/scripts/add-client.js --name "client system"
# a key that opens one station only
docker compose exec app node dist/scripts/add-client.js --name "RYD-01 system" --station RYD-01
```

| Call | What it does |
| --- | --- |
| `GET  /v1/stations/{code}/readings/batches/next` | `200` with the batch body, exactly what MoEnergy's readings endpoint accepts, plus `X-Batch-Id` and `X-Correlation-Id`; `204` when nothing is ready. The same open batch is returned until its result is posted. |
| `POST /v1/stations/{code}/readings/batches/{id}/result` | `{"status_code": <MoEnergy's HTTP status>, "body": <MoEnergy's response body>}`. The answer says what happened (`accepted`, `tank_held_rebuilt`, `item_quarantined_rebuilt`, `resend_same_body`, ...). Posting the same result twice is safe. |
| `POST /v1/stations/{code}/readings/batches/{id}/release` | Gives up an open batch the client cannot resolve; its items go into the next batch. Always safe. |
| `POST /v1/stations/{code}/tanks/{tank_code}/anchor` | `{"remaining_quantity": 505, "reason": "...", "as_of": "<time MoEnergy held it>"}`: tells us what MoEnergy holds for a tank, so its next readings chain from that value (above 0, within capacity, at most 3 decimals). Readings at or before `as_of` are not sent. Refused with `409` while the tank still has readings MoEnergy has not accepted. |

Rules the client must follow: post a result for every batch (with the `correlation_id` you sent to MoEnergy, so a result can never be applied to the wrong send), one batch at a time per station, and never edit,
reorder or drop items before forwarding. MoEnergy checks each reading against the last one it stored for that
tank, so a lost or reordered batch breaks the chain. Errors always come as `{"error": "...", "field": "..."}`.

A station's controller uploads to its own link too: `/pts/<secret>` (printed by `add-station`).

## Ledger behaviour worth knowing

- `fuel_quantity` is always the previous `remaining_quantity`; `remaining` is the measurement; `consumed` is the
  difference. MoEnergy's two chain rules therefore hold by construction, and the database now demands exactness.
- Times are whole seconds (MoEnergy's resolution); a second reading in the same second is set aside.
- A reading is chained only after it has been stored for 2 minutes (the settle window), so a controller that
  replays a backlog can fill in behind newer readings. A reading that is still older than something already
  emitted is put back in order when everything after it is unsent; if later readings may already be at MoEnergy it
  is set aside as `late_arrival`.
- A reading that can never be sent (over capacity, no litre volume, water not below fuel, a time more than 5
  minutes ahead) goes to `quarantine` with a rule code and does not move the chain. A valid reading whose remaining
  quantity would not stay above its water volume (a probe glitch to 0 L) is `skipped` for the same reason: it
  would make every later reading fail MoEnergy's "water below fuel" rule.
- A stored duplicate at item 0 of a batch confirms that item only; the rest is sent in the next batch.
- A refill makes `consumed` negative. `NEGATIVE_CONSUMED_POLICY=allow` sends it flagged; `hold` stops that tank
  and keeps its later readings pending. A tank held by the `hold` policy is released by switching the policy to
  `allow` (it goes on at the next batch request). Every other hold (a chain break reported by MoEnergy, a refused
  refill) waits for an anchor, because only a person can say what MoEnergy holds. Why and since when is on the tank
  (`held_reason`, `held_at`).
- MoEnergy refusing one reading at a time is handled by setting that reading aside. If it keeps happening (5
  readings at one station within an hour) we stop and ask for a person instead of quarantining good readings.
- Every answer the client posts is kept as received in `batch_results` (append-only), including retries, replays
  and refused attempts.
- One tank that cannot be processed does not stop its station's other tanks or its open batch; it is logged.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL connection string (the example password `change-me` is refused) |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | |
| `LOG_LEVEL` | `info` | |
| `BODY_LIMIT_BYTES` | 20 MB | Largest controller upload; every other route takes 1 MB at most |
| `CAPTURE_REPLY_BODY`, `CAPTURE_REPLY_STATUS` | `{"ok":true}`, 200 | What the capture endpoint answers |
| `NEGATIVE_CONSUMED_POLICY` | `allow` | `allow` or `hold` |
| `APP_DB_PASSWORD` | unset | production: the password of the restricted database role `pts2_app` the server runs as (set by the `migrate` step) |
| `RAW_UPLOADS_RETENTION_DAYS` | 90 | how long raw controller uploads are kept (at least 7); read by the weekly prune job |
| `BATCH_MAX_ITEMS` | unset | most readings in one batch (unset = limited by size only); lower it if Preproduction refuses large batches |
| `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS` | 5 s, 60 s, 10 s | Every database wait is bounded; a request that waits too long gets `503 {"error":"busy"}` |

## Operating notes

- **Reverse proxy:** the station secret is part of the upload URL (`/pts/<secret>`). Switch off access logging
  for `/pts/` at the proxy, or redact it, and do rate limiting per IP there; the app sees only the proxy's address.
- **Disk:** every upload is kept whole (`body_raw`, plus `body_json`). There is no pruning yet; old uploads can be
  deleted safely (`DELETE FROM raw_uploads WHERE arrived_at < ...`), readings keep working. Plan a retention job
  and a nightly `pg_dump` copied off the server before real traffic. Docker log rotation is set in `docker-compose.yml`.
- **Migrations:** run `001` to `006` before real data exists. `003` refuses to run while one open batch holds
  readings of several stations (post its result first) and deploy it with the old app stopped.
- **Not yet built:** operator scripts (requeue quarantined readings, release a held tank without a client call),
  a health report with alerts, backups, and a database role with fewer rights than the superuser the compose file uses.

## The controller side

How the data leaves a PTS-2 and the plan to receive it: `docs/PTS2_DATA_ACQUISITION.md`.

## Settings that depend on MoEnergy

`NEGATIVE_CONSUMED_POLICY` (refills) and `QUANTITY_DECIMALS` (2 or 3) are decided by what Preproduction answers:
see `docs/PREPRODUCTION_PROBES.md`.

## Adding stations and tanks

Stations and tanks come in with the codes MoEnergy generated for them, from a CSV file (template `docs/stations.example.csv`):

```bash
npm run stations:load -- --file stations.csv --dry-run          # what it would do
npm run stations:load -- --file stations.csv --send-from 2026-11-01T00:00:00+03:00
```

All or nothing, safe to run again, and it prints each new station's upload secret once. `--send-from` is the go-live time: readings
stamped before it are never sent. Per-station checklist: `docs/ONBOARDING_STATION.md`. What the guide asks and where it is kept:
`docs/CONFORMANCE.md`.

## Simulation and replay

Whole pipeline on simulated stations or on a real controller file, against a strict stand-in for MoEnergy: `docs/SIMULATION.md`.

```bash
npm run sim -- --stations 38 --days 30 --seed 1 --faults        # exit code 1 when a check fails
npm run replay:tankmsr -- TANKMSR.CSV --since 2026-10-04T00:00:00+03:00 [--refuse-negative]
npm run import:tankmsr -- --station RYD-01 --file TANKMSR.CSV --since 2026-10-04T00:00:00+03:00
```

What the first real station's data showed is in `docs/REAL_DATA_FINDINGS.md`; the order of work is `docs/plans/2026-11-03-roadmap-v2.md`.

## Deploying to a server

One Ubuntu server with Docker, Caddy for TLS, a restricted database role, scheduled backups, health checks and
Telegram alerts: `docs/DEPLOY.md`. Not yet run on a real server.

## Trying it on Render

A blueprint (`render.yaml`) puts the gateway, a database and a few simulated stations on Render, with one API key, so the client API can be
tried by hand: `docs/DEPLOY_RENDER.md`. Test only; the free plans sleep and expire.

## Scaling

Measured, with the model for 38 stations growing by 4 a month: `docs/SCALING.md`. The real load (about 100 to 120 records a day per
station) is about 40 times below the minute-by-minute model; a 24-hour replay from all 38 stations drains in about 30 s.

## Develop

```bash
npm ci
npm run test:db:start   # throwaway PostgreSQL 16 on port 54329 (needs the postgres server binaries)
npm test                # or set TEST_DATABASE_URL to any database whose name contains "test"
npm run typecheck && npm run build
```

Tests use a real PostgreSQL; the database named by `TEST_DATABASE_URL` is dropped and rebuilt on every run.
