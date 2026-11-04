# Internal status page: specification (not built, not part of the delivery)

Status: **proposal, 2026-11-04.** Build after the pilot station (HAI-19) has uploaded real data and the parser exists.

## 1. Decision gate: scope

The agreement with the client is: our API in the MoEnergy shape, its documentation, and support. **No dashboard.** This page is
therefore **an internal tool for us, the developers.** It is not delivered, not documented to the client, and not part of the
monthly support promise. If the client ever wants a page, that is a new scope and a new price. Nothing below may be offered to the
client as a feature without that talk.

## 2. Purpose and users

One user group: the two or three people who run the gateway. Questions it must answer in under ten seconds:

1. Is the gateway up, and is each station uploading? (`last_upload_at` older than expected)
2. Is any tank held, in quarantine, or waiting for codes?
3. Is data flowing out: how many readings are ready, in an open batch, sent?
4. Is the client's system fetching and answering batches, or is a batch stuck open?

It does not replace alerts. Telegram alerts from `deploy/health-check.sh` are how problems reach us; this page is where we look
after an alert, or during a station go-live.

## 3. Screens

**Stations (home).** One row per station, sorted worst first.

| Column | Source |
| --- | --- |
| Station code, MoEnergy code (or "waiting for codes") | `status.station_code`, `moenergy_station_code` |
| Last upload (relative time, red after a threshold, default 2 h) | `last_upload_at` |
| Tanks: ok / held / waiting for codes / inactive (counts) | `tanks[].state` |
| Pending / ready / in open batch / sent (sums) | `tanks[]` counters |
| Open batch age (red after a threshold, default 6 h) | `open_batch.created_at` |
| Set aside (sum, by rule on hover) | `tanks[].set_aside` |

**Station detail.** Per tank: state and `held_reason`, `go_live_at`, `last_reading_at`, last sent time and remaining quantity,
set-aside counts. Last raw uploads for the station (time, size, parse status), with the body shown only on an explicit click.

**Gateway.** Database reachable, migrations applied, last backup time, last off-site copy, pending timers (from the state files in
`$STATE_DIR` that `deploy/health-check.sh` already reads), disk free.

No charts of readings, no export, no editing. Read-only everywhere.

## 4. What the API gives today, and the gaps

| Need | Today | Gap |
| --- | --- | --- |
| Per-station picture | `GET /v1/stations/{code}/status` | none; documented in `docs/API.md` 6.5 |
| Liveness | `GET /healthz` returns `{status:"ok"}` only | no dependency checks (database, backup age) |
| **List of stations** | none | the page cannot discover stations; needs a read-only list |
| **Read-only credential** | keys are "one station" or "all stations"; both can also `GET .../batches/next` (opens a batch, runs the ledger) and post results | a leaked key used for this page could change data; needs a key scope that is **status only** |
| Raw uploads list | rows in `raw_uploads`, no endpoint | needs a read-only query |

These three gaps are the real work. The page itself is small. Do not "solve" them by giving the page the client's all-stations key.

## 5. Design

Server-rendered HTML routes inside the existing app under `/ops/*`, so there is no second service, no JavaScript build, and **no
API key in the browser.** The routes call the same database functions the status endpoint uses; they do not call our own HTTP API.

- **Auth.** A separate credential type `ops` (hashed like API keys, created with a script, shown once), sent as HTTP Basic by the
  browser or as a bearer token. It opens only `/ops/*`, and it is refused by `/v1/*`. A wrong or missing credential answers `401`
  before any query. Rate-limited by Caddy as the other routes are.
- **Transport and exposure.** Same domain, HTTPS only. Caddy adds an IP allow-list for `/ops/*` if our addresses are stable;
  otherwise the credential alone, with a long random value.
- **No secrets on the page.** Never show upload secrets, key hashes, the `.env`, or full raw bodies by default. Station paths in
  stored URLs are already redacted.
- **No writes.** Every handler is `GET`. Fixing a held tank stays a command-line or API action (`docs/API.md` 6.4).
- **Caching.** None for the first version; queries are cheap at 38 to 182 stations. Auto-refresh every 60 s by `<meta refresh>`.
- **Logging.** The access log hides `/ops` credentials as it hides `/pts/<secret>`.
- **Style.** Plain table, system fonts, readable in a phone browser; red/amber/green carry text as well as colour.

Alternatives considered:

| Option | Why not (now) |
| --- | --- |
| Single-page app calling `/v1/*` with a key in the browser | key exposed in JS; needs the list endpoint anyway; a build pipeline to maintain |
| Grafana or Uptime Kuma next to it | good for server metrics, but cannot show per-tank ledger state without a SQL data source; one more service to patch |
| Only Telegram alerts and `psql` | cheapest; may be enough. This is the baseline the page must beat |

## 6. Phases

1. **Prerequisite (needed anyway):** `ops` credential type and station list query, with tests (an `ops` credential is refused by
   `/v1/*`; a client key is refused by `/ops/*`; no write verbs exist).
2. **Stations screen** with thresholds from the environment (`OPS_STALE_UPLOAD_MINUTES`, `OPS_STALE_BATCH_HOURS`).
3. **Station detail** with the raw-uploads list.
4. **Gateway screen** (backup age, off-site age, disk).

Each phase is shippable alone. Stop after phase 2 if it is enough.

## 7. Acceptance tests

- With no credential, with a client key, with a revoked `ops` credential: `401`.
- With the `ops` credential on `/v1/stations/X/readings/batches/next`: refused; no batch is created.
- A station with no upload for longer than the threshold is red and listed first; a held tank shows its reason.
- The page and its HTML contain no secret, no key, and no raw payload unless the click was made.
- The app role (`pts2_app`) is enough; no new database privileges.
- Page renders with 182 stations (simulator) in under 500 ms on the build machine.

## 8. Open questions

1. Is a page needed once Telegram alerts work, or is `status` plus alerts enough? (Decide after one month of real alerts.)
2. Are our own IP addresses stable enough to allow-list?
3. Who besides the developer should see it (the client's support person)? If anyone outside, this is no longer internal and
   section 1 applies.
4. Keep raw upload retention at 90 days, or longer while the parser is new?
