# MoEnergy Preproduction: the six probes

The guide leaves a few things open that change how the gateway behaves. Nobody on the client side knows the answers,
so we find them by sending small batches to the Preproduction environment (`https://wshubapit.moenergy.gov.sa`,
guide section 1.3.1) with the credentials MoEnergy issued to the operator. Whoever holds those credentials runs
the probes with `curl` or any HTTP tool and sends back, for each probe, the HTTP status and the **full response
body** (it contains the `Global-Transaction-ID` MoEnergy support asks for).

## Rules for running them

- Use a station and tanks created only for this (guide 2.1 and 2.3). **Three tanks**: `A` (main chain), `C`
  (insertion test) and `F` (time test). Every accepted probe is stored for good and cannot be undone; a rejected
  batch stores nothing.
- Run them in this order. Send one batch per probe, and **do not fix a payload and resend it unless a probe says so**.
- `T0` is a whole hour in UTC, a few hours in the past (never in the future). Example when it is 07:00 UTC:
  `T0 = 2026-11-03T04:00:00Z`. Every time below is `T0` plus the offset shown, written with `Z`.
- Quantities are litres; `fuel_height` and `water_height` follow the guide's examples. Replace the codes
  `ST-000000`, `ST-000000-A`, `-C`, `-F` with the real ones.

## Probe 1: seed, and the first reading of a new tank (irreversible)

```json
{ "readings": [
  { "station_code": "ST-000000", "tank_code": "ST-000000-A", "fuel_quantity": 10000.00, "consumed_quantity": 100.00,
    "fuel_height": 1.85, "water_quantity": 5.00, "water_height": 0.02, "temperature": 28.5,
    "remaining_quantity": 9900.00, "reading_at": "T0" },
  { "station_code": "ST-000000", "tank_code": "ST-000000-A", "fuel_quantity": 9900.00, "consumed_quantity": 50.00,
    "fuel_height": 1.84, "water_quantity": 5.00, "water_height": 0.02, "temperature": 28.5,
    "remaining_quantity": 9850.00, "reading_at": "T0+10m" },
  { "station_code": "ST-000000", "tank_code": "ST-000000-C", "fuel_quantity": 8000.00, "consumed_quantity": 0.00,
    "fuel_height": 1.50, "water_quantity": 5.00, "water_height": 0.02, "temperature": 28.5,
    "remaining_quantity": 8000.00, "reading_at": "T0" },
  { "station_code": "ST-000000", "tank_code": "ST-000000-C", "fuel_quantity": 8000.00, "consumed_quantity": 100.00,
    "fuel_height": 1.49, "water_quantity": 5.00, "water_height": 0.02, "temperature": 28.5,
    "remaining_quantity": 7900.00, "reading_at": "T0+10m" },
  { "station_code": "ST-000000", "tank_code": "ST-000000-C", "fuel_quantity": 7900.00, "consumed_quantity": 100.00,
    "fuel_height": 1.48, "water_quantity": 5.00, "water_height": 0.02, "temperature": 28.5,
    "remaining_quantity": 7800.00, "reading_at": "T0+20m" }
] }
```

Expected: `200`, `accepted_count` 5. This shows that a brand-new tank can start from any `fuel_quantity`, and
that two tanks in one batch work. **If it is a 422, stop**: the message names the field; send it to us.

## Probe 2: duplicate or broken chain, which is reported first? (free)

Send tank `A` at `T0` again (the same instant as the first reading above) with a chain that is also wrong:

```json
{ "readings": [ { "station_code": "ST-000000", "tank_code": "ST-000000-A", "fuel_quantity": 7777.00,
  "consumed_quantity": 0.00, "fuel_height": 1.85, "water_quantity": 5.00, "water_height": 0.02,
  "remaining_quantity": 7777.00, "reading_at": "T0" } ] }
```

Then send an exact copy of the first reading of probe 1.

| Answer to the first | Meaning | What changes |
| --- | --- | --- |
| `DUPLICATE_READING_STORED` | duplicates are checked before the chain | nothing: the gateway assumes this |
| `REMAINING_QUANTITY_INCONSISTENT` | the chain is checked first | a lost reply on a multi-item batch will come back as a broken chain at item 0, and the gateway would hold the tank. We change `result.ts` to treat a chain break at item 0 of a batch that was already sent as "maybe stored" before holding |

The exact copy must answer `DUPLICATE_READING_STORED`.

## Probe 3: negative `consumed_quantity` (a refill) (irreversible on `A`)

Tank `A` now ends at 9850.00. A refill of 500 L:

```json
{ "readings": [ { "station_code": "ST-000000", "tank_code": "ST-000000-A", "fuel_quantity": 9850.00,
  "consumed_quantity": -500.00, "fuel_height": 1.90, "water_quantity": 5.00, "water_height": 0.02,
  "remaining_quantity": 10350.00, "reading_at": "T0+20m" } ] }
```

| Answer | What changes |
| --- | --- |
| `200` | `NEGATIVE_CONSUMED_POLICY=allow` (the default). `A` now ends at 10350.00 |
| `422` | keep `hold`, and send us the whole error (`sourceErrorCode` and the field in `message`). Deliveries then need another way and MoEnergy has to say which. `A` still ends at 9850.00 |

## Probe 4: more than two decimals (irreversible on `A`)

Use `A`'s current end (10350.00 if probe 3 was accepted, else 9850.00); call it `E`. This item has three
decimals in every quantity and in both heights:

```json
{ "readings": [ { "station_code": "ST-000000", "tank_code": "ST-000000-A", "fuel_quantity": E,
  "consumed_quantity": 10.125, "fuel_height": 1.853, "water_quantity": 5.125, "water_height": 0.021,
  "remaining_quantity": E - 10.125, "reading_at": "T0+30m" } ] }
```

| Answer | What changes |
| --- | --- |
| `200` | three decimals are fine; `QUANTITY_DECIMALS=3` becomes possible (two stays the safe default) |
| `422` naming a field | decimals are limited. Keep `QUANTITY_DECIMALS=2`. If the field is a height, tell us: heights are sent with three decimals today |

## Probe 5: an older reading between stored ones (tank `C`, irreversible)

`C` holds readings at `T0`, `T0+10m`, `T0+20m` (ending at 7800.00).

- **5a**, consistent with both neighbours: `T0+15m`, `fuel_quantity` 7900.00, `consumed_quantity` 0.00,
  `remaining_quantity` 7900.00.
- **5b**, only if 5a was accepted, breaks the later neighbour: `T0+16m`, `fuel_quantity` 7900.00,
  `consumed_quantity` 50.00, `remaining_quantity` 7850.00.
- **5c**, only if 5b was accepted: a reading at `T0+30m` with `fuel_quantity` 7800.00, `consumed_quantity` 0.00,
  `remaining_quantity` 7800.00. If it is refused, send `fuel_quantity` 7850.00 instead.

| Answer | What it tells us |
| --- | --- |
| 5a refused | anything older than the newest stored reading is refused: the gateway's current handling (set aside as late) is right |
| 5a accepted, 5b refused | insertion works when the neighbours stay consistent |
| 5b accepted | only the predecessor is checked. 5c says whether "most recent" means latest time (7800) or latest arrival (7850) |

## Probe 6: time on tank `F` (the first two are irreversible, the third is free)

Let `N` be the current time.

1. A reading at `N - 1 h` written with an offset: `"reading_at": "2026-11-03T08:00:00+03:00"` (adjust so it is
   one hour ago). Expect `200`.
2. The same instant written with `Z` (`2026-11-03T05:00:00Z` for the example). Expect `DUPLICATE_READING_STORED`;
   that confirms offsets are normalised.
3. A reading at `N + 6 min`. Expect `422` naming `reading_at`. If it is accepted the future limit is larger
   than the guide says.

## Not probed on purpose

- **The rate limit.** Do not provoke a `429`: the guide mentions suspended keys. Ask
  `applications_integration@moenergy.gov.sa` for the limit instead.
- A body over 1 MB, a reading with `water_quantity` equal to `fuel_quantity`, a chain starting at zero, and
  unknown properties: the guide already says what happens, and a chain started at zero can never continue.

## What to send back

For each probe: the probe number, the status, the whole body. Then the gateway's settings follow from the tables
above (`NEGATIVE_CONSUMED_POLICY`, `QUANTITY_DECIMALS`), and the two code changes that depend on probes 2 and 5 are
decided from the answers.
