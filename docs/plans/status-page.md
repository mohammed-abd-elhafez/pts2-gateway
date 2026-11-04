# Internal data viewer (web page): specification (not built, not part of the delivery)

Status: **proposal, 2026-11-04, reduced scope.** Build after the pilot station (HAI-19) has uploaded real data and the parser exists.

## 1. Purpose and scope

One purpose: **read what the gateway holds, in an orderly and clear way.** For us, the developers, on a laptop or a phone. It is
not a monitor (Telegram alerts and `deploy/health-check.sh` do that) and it controls nothing.

The agreement with the client is the API, its documentation and support; **no dashboard.** This page is an internal tool, not
delivered and not part of the monthly support. If the client ever wants a page, that is a new scope and a new price.

Not in this version: charts, export, audit log, editing of any kind, key management, sales, a gateway/server screen. Each can be
added later; none is needed to read the data.

## 2. Screens (two, read-only)

**1. Stations.** One row per station, worst first (silent, then held, then the rest).

| Column | Source |
| --- | --- |
| Station code, MoEnergy code (or "waiting for codes") | `stations` |
| Last upload (relative; red after `OPS_STALE_UPLOAD_MINUTES`, default 120) | `stations.last_seen_at` |
| Tanks by state: ok / held / waiting for codes / inactive | same logic as `GET /v1/stations/{code}/status` |
| Pending / ready / in open batch / sent (sums) | same |
| Open batch age (red after `OPS_STALE_BATCH_HOURS`, default 6) | `batches` |
| Set aside (sum; by rule on hover) | same |

**2. Station detail** (click a row). Three blocks:

- *Tanks:* number, operator tank code, MoEnergy tank code, product, state and `held_reason`, `go_live_at`, last reading time,
  last sent time and remaining quantity, set-aside counts.
- *Latest readings* of the chosen tank (default 50, newest first): time (`effective_at`, shown in the station's UTC offset and
  in UTC), fuel litres, fuel height, water litres and height, temperature, ledger status, quality flags (`clock_invalid`,
  `volume_missing`), delivery mark. A filter for "only flagged" and a date range.
- *Latest batches* of the station (default 20): id, status (open / accepted / rejected), item count, size, created and closed times,
  MoEnergy result code and item index, and what we did next.

Units are written next to the numbers (L, mm, C). Heights from the database are millimetres; the API sends metres, so the page
shows both once, labelled, to avoid confusion when comparing with a batch body.

## 3. What the API gives today, and the gaps

| Need | Today | Gap |
| --- | --- | --- |
| Per-station picture | `GET /v1/stations/{code}/status` | none |
| **List of stations** | none | needs a read-only list |
| **Read-only credential** | keys are "one station" or "all stations"; both can also call `.../batches/next` (opens a batch, runs the ledger) and post results | a leaked key used here could change data; needs a credential that opens **only** `/ops/*` |
| Readings and batches lists | tables exist, no endpoint | read-only queries |

The page does not call our HTTP API. It runs the same database functions in the same process, so the gaps are one query module and
one credential type. **Never give the page the client's all-stations key.**

## 4. Design

Server-rendered HTML under `/ops/*` in the existing app: no second service, no JavaScript build, **no key in the browser.**

- **Auth.** New credential type `ops`: random, stored hashed like API keys, created by a script (`npm run ops:add`), shown once. Sent as
  HTTP Basic (the browser remembers it) or as a bearer token. It opens only `/ops/*` and is refused by `/v1/*`; client keys are
  refused by `/ops/*`. Missing or wrong: `401` before any query. Revocable. Caddy rate-limits `/ops/*` like the other routes.
- **Exposure.** Same domain, HTTPS only. If our addresses are stable, Caddy also allow-lists them for `/ops/*`.
- **Read only.** Every handler is `GET`; the database role needs nothing new. Fixing a held tank stays a command or an API action
  (`docs/API.md` 6.4).
- **No secrets shown.** Never an upload secret, key, hash or the `.env`. Raw upload bodies are not part of this version.
- **Logging.** Caddy's access log hides the `/ops` credential as it hides `/pts/<secret>`.
- **Looks.** A plain table, system fonts, readable on a phone; state is shown in words as well as colour. Refresh every 60 s with
  `<meta refresh>` on the stations screen only (not on the readings table while someone is reading it).
- **Cost.** None cached; queries use the existing indexes (readings by tank and `effective_at`, batches by station).

Alternatives considered: a single-page app with a key in the browser (key exposed, needs the list endpoint anyway, a build to maintain);
Grafana or Uptime Kuma (good for server metrics, cannot show per-tank ledger state without a SQL data source, one more service to patch);
a terminal command (`show.js`) is a valid cheaper first step but does not give phone access.

## 5. Phases

1. `ops` credential type and `ops:add` script, the route guard, the station list query. Tests first.
2. Stations screen.
3. Station detail: tanks, readings, batches.

Each is shippable alone. Stop after 2 if that is enough.

## 6. Acceptance tests

- No credential, a client key, a revoked `ops` credential: `401` on `/ops/*`.
- The `ops` credential on `/v1/stations/X/readings/batches/next`: refused, and no batch is created (counted in the database).
- A station silent beyond the threshold is red and first; a held tank shows its `held_reason`.
- A reading with `clock_invalid` shows its flag; the readings table matches the database rows for a seeded tank.
- The response bodies contain no upload secret, key or hash (seeded values searched for).
- No route other than `GET`; the app role (`pts2_app`) is enough.
- With 182 simulated stations the stations screen renders in under 500 ms on the build machine.

## 7. Open questions

1. Is the viewer wanted once the first month of real alerts is in, or is `status` plus alerts enough? (It is cheap to defer.)
2. Are our addresses stable enough to allow-list?
3. Who besides the developer sees it? If anyone outside, section 1 applies and the client conversation comes first.
4. Time zones: show station local time first, or UTC first? (Default: local, with UTC beside it.)
