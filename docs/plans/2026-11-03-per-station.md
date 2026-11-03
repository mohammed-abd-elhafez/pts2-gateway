# Per-station links (plan 3)

**Goal:** every station has its own client link and its own open batch, so one station cannot hold up another.

**Changes:** migration 003 (`batches.station_id`, one open batch per station, `api_clients.station_id`);
`getOrCreateNextBatch(pool, stationId, opts)` and `applyResult(pool, stationId, batchId, result)` take the
station and lock per station; routes move under `/v1/stations/{operator_station_code}`; a key is bound to one
station or valid for all; a station the key may not use answers `404` like a missing one, before the body is read.

**Tests:** independence (two open batches at once, one stuck batch does not block another, rejection at one
station leaves the other alone), scope (bound key, foreign station looks like missing, case-insensitive code),
ledger run limited to the asking station. Six new mutation checks guard each scoping clause.
