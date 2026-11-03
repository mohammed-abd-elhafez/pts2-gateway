# Tank Readings API: Integration Guide

Version 0.3 (draft). Audience: the client's system, which fetches ready batches from us, forwards them to the
Ministry of Energy (MoEnergy) ATG readings endpoint, and reports MoEnergy's answer back to us.

We never contact MoEnergy. The batch body we return is exactly what MoEnergy's readings endpoint accepts
(ATG APIs 1.1.0, section 2.7), so you forward it without editing it.

## 1. Overview

| | |
| --- | --- |
| Format | JSON, UTF-8 |
| Authentication | `Authorization: Bearer <key>` |
| Links | one set per station: `/v1/stations/{station_code}/...` |
| Operations | 5: next batch, post result, release a batch, anchor a tank, station status |
| Production URL | `https://<our-domain>` (given at hand-over) |

`{station_code}` is your own `operator_station_code` for the station (for example `RYD-01`), not the MoEnergy
`ST-...` code. It is matched ignoring case.

Each station has its own link and its own batch. A station that is waiting for you to report a result never holds
up another station.

## 2. Flow for one station

1. `GET .../readings/batches/next`. `204`: nothing is ready, try again later.
2. Send the body, unchanged, to MoEnergy's readings endpoint. Use the `X-Correlation-Id` we returned as your
   `X-Correlation-Id`, so a support ticket and our logs share one key.
3. Post MoEnergy's HTTP status and response body to `POST .../batches/{id}/result`.
4. Do what the `action` in our answer says (section 6.2), then go back to step 1.

Rules: one batch at a time per station; never edit, reorder or drop items; always report the result. MoEnergy
checks each reading against the last one it stored for the tank, so a lost or reordered batch breaks the chain.

## 3. Authentication

| Key | Opens |
| --- | --- |
| a key bound to one station | that station's links only; any other station answers `404` |
| an all-stations key | every station's links |

Keys are created by us and shown once. A wrong, revoked or missing key answers `401`, before anything else is
read.

## 4. Errors

Every error is `{"error": "<code>", "field": "<name>"}` (`message` may be added).

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | Missing, wrong or revoked key |
| 404 | `not_found` | `field` is `station_code`, `id` (batch) or `tank_code`. A station your key may not use looks the same as one that does not exist |
| 409 | `batch_closed` | A different result was already recorded for this batch |
| 409 | `correlation_mismatch` | The result names another send than this batch (`field: correlation_id`) |
| 409 | `tank_has_unsent_readings` | The tank still has readings MoEnergy has not accepted (anchor) |
| 415 | | Content type other than JSON |
| 422 | `invalid_request` | Malformed body: wrong type, unknown property, bad value. `field` names it |
| 500 | `internal` | Unexpected. Retry with backoff |
| 503 | `busy` | A bounded wait ran out (the station's batch was being worked on, or the database was slow). Retry after the `Retry-After` seconds |

## 5. Service URLs

`https://<our-domain>/v1/stations/{station_code}/...`

## 6. Operations

### 6.1 Next batch

| | |
| --- | --- |
| Operation Name | Next batch |
| Description | Returns the station's open batch, or builds the next one |
| Method | GET |
| Service Endpoint | `/v1/stations/{station_code}/readings/batches/next` |

The same open batch (same body, `X-Batch-Id`, `X-Correlation-Id`) is returned until its result is accepted or
rejected.

**Output, `200`**

Headers:

| Header | Description |
| --- | --- |
| `X-Batch-Id` | Our batch id; use it in the result URL |
| `X-Correlation-Id` | Send it to MoEnergy as `X-Correlation-Id` |

Body: MoEnergy's readings request body, 1 MB at most (we stay under 900 KB).

| # | Element | Type | Mandatory | Description |
| --- | --- | --- | --- | --- |
| 1 | `readings` | array | Yes | The batch, oldest first, each tank in time order |
| 2 | `readings[].station_code` | string | Yes | MoEnergy station code, `ST-000027` |
| 3 | `readings[].tank_code` | string | Yes | MoEnergy tank code, `ST-000027-1` |
| 4 | `readings[].fuel_quantity` | number | Yes | Equals the previous reading's `remaining_quantity` |
| 5 | `readings[].consumed_quantity` | number | Yes | Litres consumed since the previous reading; negative after a refill |
| 6 | `readings[].fuel_height` | number | Yes | Metres |
| 7 | `readings[].water_quantity` | number | Yes | Litres |
| 8 | `readings[].water_height` | number | Yes | Metres |
| 9 | `readings[].temperature` | number | No | Celsius; left out when absent or out of range |
| 10 | `readings[].remaining_quantity` | number | Yes | `fuel_quantity - consumed_quantity` |
| 11 | `readings[].reading_at` | string | Yes | UTC, whole seconds, `2026-07-29T12:00:00Z` |

**Sample response `200`**

```
X-Batch-Id: 12
X-Correlation-Id: 667466fb-b12e-46bf-a6f8-3593d0b1a824
```
```json
{
  "readings": [
    {
      "station_code": "ST-000027",
      "tank_code": "ST-000027-1",
      "fuel_quantity": 14500.5,
      "consumed_quantity": 250,
      "fuel_height": 1.85,
      "water_quantity": 0.5,
      "water_height": 0.02,
      "temperature": 28.5,
      "remaining_quantity": 14250.5,
      "reading_at": "2026-07-29T12:00:00Z"
    }
  ]
}
```

**`204`**: nothing is ready. No body.

A reading is held back until it has been stored for 2 minutes, and until the station and tank have their
MoEnergy codes.

### 6.2 Post result

| | |
| --- | --- |
| Operation Name | Post result |
| Description | Reports MoEnergy's answer for a batch |
| Method | POST |
| Service Endpoint | `/v1/stations/{station_code}/readings/batches/{id}/result` |

**Input (body)**

| # | Element | Type | Mandatory | Constraints |
| --- | --- | --- | --- | --- |
| 1 | `status_code` | integer | Yes | MoEnergy's HTTP status, 100 to 599 |
| 2 | `body` | any JSON | No | MoEnergy's response body, exactly as received |
| 3 | `correlation_id` | string | No | The `X-Correlation-Id` you sent to MoEnergy with this batch. When given, a result that names another send is refused with `409 correlation_mismatch` |

Unknown properties are rejected with `422`.

**Output, `200`**

| # | Element | Type | Description |
| --- | --- | --- | --- |
| 1 | `batch_id` | integer | The batch |
| 2 | `batch_status` | string | `accepted`, `rejected` or `open` |
| 3 | `action` | string | What you do next, see below |
| 4 | `detail` | string | Optional explanation |
| 5 | `held_tank` | string | Optional: the tank we stopped, `ST-...-n` |
| 6 | `quarantined_reading` | integer | Optional: the reading we set aside |
| 7 | `replayed` | boolean | `true` when this exact result had been recorded before |

**What each `action` means**

| `action` | `batch_status` | What you do |
| --- | --- | --- |
| `accepted` | accepted | Nothing. Fetch the next batch |
| `accepted_assumed_resend` | accepted | Nothing. MoEnergy said a stored duplicate at item 0, which confirms that one item. The batch is closed with that item only (its `item_count` shrinks to 1) and the other items go into the next batch, whose first item answers the same question again. So a lost reply costs one extra round trip per stored item, and nothing is ever marked stored without MoEnergy saying so. A stored duplicate at any later item is different: that reading is never sent again and the tank is put on hold (`tank_held_rebuilt`), because MoEnergy holds something we did not send |
| `item_quarantined_rebuilt` | rejected | Fetch the next batch; it is rebuilt without the item MoEnergy refused |
| `tank_held_rebuilt` | rejected | Fetch the next batch (without that tank). The tank in `held_tank` is on hold; tell us what MoEnergy holds for it (section 6.4) |
| `resend_same_body` | open | MoEnergy answered 409, 429 or 5xx. Send the same body again, same `X-Correlation-Id`, with backoff, then post the new answer |
| `fix_client_side` | open | MoEnergy answered 401, 403 or 413: your key, permission or size. Fix it and resend |
| `needs_attention` | open | We could not interpret the answer, or will not act on it (a 200 whose `accepted_count` differs from the item count; MoEnergy refusing several readings of this station within the hour). Nothing changed. Send the same body again once; if the answer is the same, release the batch (section 6.3) and fetch the next one |
| `released` | rejected | Answer to a release: every item is unsent again and goes into the next batch |

Every result you post is kept as received. Posting the same result twice is safe and returns the same answer with `replayed: true`. A different result for a
batch that is already closed answers `409 batch_closed`. A batch id that is not this station's answers `404`.

**Samples**

```json
{ "status_code": 200, "body": { "status": "accepted", "message": "Batch accepted.", "accepted_count": 2 } }
```
```json
{ "batch_id": 12, "batch_status": "accepted", "action": "accepted", "replayed": false }
```

MoEnergy refused one item:

```json
{
  "status_code": 422,
  "body": { "errors": [ { "code": "39f9b6326a7d9a709229b621", "message": "item_index: 1 - field: fuel_quantity",
                          "sourceErrorCode": "TANK_FUEL_QUANTITY_EXCEEDS_CAPACITY", "sourceMessage": "..." } ] }
}
```
```json
{ "batch_id": 12, "batch_status": "rejected", "action": "item_quarantined_rebuilt", "quarantined_reading": 3481, "replayed": false }
```

MoEnergy reported a broken chain:

```json
{
  "status_code": 422,
  "body": { "errors": [ { "code": "39f9b6326a7d9a709229b621", "message": "item_index: 0 - field: fuel_quantity",
                          "sourceErrorCode": "REMAINING_QUANTITY_INCONSISTENT", "sourceMessage": "Continuity break" } ] }
}
```
```json
{ "batch_id": 12, "batch_status": "rejected", "action": "tank_held_rebuilt", "held_tank": "ST-000027-1", "detail": "Continuity break", "replayed": false }
```

### 6.3 Release a batch

| | |
| --- | --- |
| Operation Name | Release a batch |
| Description | Gives up an open batch you cannot resolve; its items go into the next batch |
| Method | POST |
| Service Endpoint | `/v1/stations/{station_code}/readings/batches/{id}/release` |

Use it when a batch stays open after you have sent it again and reported the same answer (`needs_attention`).
It is always safe: we assume nothing about what MoEnergy stored. If it stored some items, the next batch's first
item comes back as a stored duplicate and is confirmed on its own (section 6.2). Body (optional): `{ "reason": "..." }`.
Answers `200` with `action: "released"`; asking again returns the same answer with `replayed: true`; a batch that is
already closed otherwise answers `409 batch_closed`, another station's batch `404`.

### 6.4 Anchor a tank

| | |
| --- | --- |
| Operation Name | Anchor a tank |
| Description | Tells us the remaining quantity MoEnergy holds for a tank, so its next readings chain from it |
| Method | POST |
| Service Endpoint | `/v1/stations/{station_code}/tanks/{tank_code}/anchor` |

`{tank_code}` is the MoEnergy tank code (`ST-000027-1`). Use it when a tank is on hold after a broken chain, when
a tank already has readings at MoEnergy from an earlier system, or when MoEnergy has reset a tank's chain.

**A tank that already has readings at MoEnergy:** give `as_of`, the time of that last stored value. Readings at or
before it are treated as already there and are not sent. Without `as_of` an overlapping backlog is sent and confirmed
one stored item at a time (section 6.2), which is slow for a long backlog.

**Input (body)**

| # | Element | Type | Mandatory | Constraints |
| --- | --- | --- | --- | --- |
| 1 | `remaining_quantity` | number or string | Yes | Litres, plain decimal, above 0 and not above the tank capacity, at most 3 decimals (more is refused, not rounded) |
| 2 | `reason` | string | Yes | 1 to 500 characters; kept as the audit trail |
| 3 | `as_of` | string (date-time) | No | When MoEnergy held this value; not more than 5 minutes in the future |
| 4 | `accept_negative` | boolean | No | Let the next reading pass as a refill (consumed below 0) under the hold policy. Default: yes when the tank was held for a refill by that policy, no after MoEnergy itself refused a negative value; `true` also clears that refusal |

**Output, `200`**

| Element | Type | Description |
| --- | --- | --- |
| `tank_code` | string | The tank |
| `remaining_quantity` | number | The value now used |
| `chain_held` | boolean | `false`: the hold is lifted |

Refused with `409 tank_has_unsent_readings` while the tank still has readings MoEnergy has not accepted: finish
and report the open batch first.

**Sample**

```json
{ "remaining_quantity": "505.000", "reason": "MoEnergy support confirmed 505 L as the last stored remaining quantity" }
```
```json
{ "tank_code": "ST-000027-1", "remaining_quantity": 505, "chain_held": false }
```

### 6.5 Station status

| | |
| --- | --- |
| Operation Name | Station status |
| Description | Read-only picture of one station: what waits, what was sent, what is held. Changes nothing |
| Method | GET |
| Service Endpoint | `/v1/stations/{station_code}/status` |

Same key and station rules as the other operations. It does not run the ledger and never creates a batch, so it is
safe to poll. Answer fields:

| Field | Meaning |
| --- | --- |
| `station_code`, `moenergy_station_code` | our code and the MoEnergy code (null until supplied) |
| `last_upload_at` | when the controller last uploaded |
| `open_batch` | `{ id, items, created_at }` or null |
| `tanks[]` | per tank: `state` (`ok`, `held`, `waiting_for_codes`, `inactive`), `held_reason`, `go_live_at`, `pending`, `ready`, `in_open_batch`, `sent`, `last_reading_at`, `last_ready_remaining_quantity`, `last_sent_at`, `last_sent_remaining_quantity`, `set_aside` (count per rule, for example `clock_invalid`, `before_start`) |

## 7. Integration best practices

- Fetch, forward, report: in that order, for every batch, one batch at a time per station.
- Keep the body byte for byte. Do not add fields, do not sort, do not drop an item.
- After a network error you cannot tell whether MoEnergy stored the batch. Fetch again: you get the same batch.
  Send it again. If MoEnergy stored it the first time, it answers a duplicate at item 0; reporting that confirms
  that item, and the rest comes in the next batch.
- If the same batch stays unresolved (`needs_attention`), release it (section 6.3).
- Do not retry a `422` without reporting it. Report it; we remove the refused item and rebuild.
- Use `X-Correlation-Id` from the batch response on every send and every retry.
- Keep the generated station and tank codes you send to us; we use them to build the batches.

## 8. Refills

A refill makes `consumed_quantity` negative. MoEnergy's guide does not say whether it accepts that. By default we
send it, flagged internally. If MoEnergy refuses it, the refused reading is set aside and the tank is put on hold
so the refusal does not repeat for every reading after it. From then on that tank holds every negative reading itself
instead of sending it to be refused, and you tell us what MoEnergy holds (section 6.4); the hold returns until you
send `accept_negative: true`, which says MoEnergy now accepts them.
A deployment can instead hold a tank at the first negative value (`NEGATIVE_CONSUMED_POLICY=hold`); anchoring the tank
then lets that one reading pass. Please tell us how your system handles refills.

## 8.1 Readings that are not sent

A reading is set aside, and the chain does not move, in these cases: its volume is missing or breaks one of
MoEnergy's rules (`quarantined`, with the rule code kept); it is older than what MoEnergy may already hold
(`late_arrival`); MoEnergy refused it (`moenergy:<code>`); or its remaining quantity would not stay above the water
volume, which would make every later reading fail the "water below fuel" rule (`skipped`, rule
`remaining_not_above_water`, for example a probe glitch to 0 L). The next good reading then chains from the last
value MoEnergy really holds.
A reading stamped before the tank's go-live time (`tanks.send_from`, set when the station is loaded) is never sent either
(`skipped`, rule `before_start`): a controller that starts uploading sends everything it has stored, months of readings, and only
what is stamped from the go-live time on goes to MoEnergy.

## 9. Open points to confirm

MoEnergy's rate limit and maximum records per batch; whether negative consumed quantities are accepted; whether
you want one key per station or one key for all.
