# Conformance: the MoEnergy ATG guide (v1.1.0) against this gateway

What the guide asks of the **tank readings** endpoint (`POST /moenergy/v1.0/en/public/atg/readings`, guide 2.7), where this gateway
keeps each rule, and which test shows it. Validation here is against the written guide, not the live service: Preproduction answers
decide the points marked *assumption* (`docs/PREPRODUCTION_PROBES.md`). Last checked against the guide text on 2026-11-03.

## What the guide covers, and what this project covers

The guide has 14 endpoints in four classes of data. This project delivers the first row only (agreed scope); the others are listed so
that what is out of scope is a decision and not an oversight.

| Guide | Class | In this project |
| --- | --- | --- |
| 2.7 readings | tank readings (ATG snapshots) | **yes**: the whole gateway |
| 2.6 transactions | sales: one record per dispenser sale | **no**, see "Sales" below |
| 2.1 to 2.5, 2.14 | station and tank master data (create, update, get) | no: the client registers them. We store the codes MoEnergy generated (`stations:load`) |
| 2.8 to 2.13 | reference data (regions, cities, products, payment methods, statuses) | no; products 1, 91, 95, 98 are loaded as reference |
| 1.3.2, 1.4 | authentication headers, error codes | the client's side; our `action` answers map the HTTP codes (below) |

## Readings: field by field (guide 2.7.1)

| Guide requirement | Where it is kept | Test |
| --- | --- | --- |
| `station_code`, `tank_code`: an active station and tank | a tank is batched only when both MoEnergy codes are set and the tank is active (`src/batches/builder.ts`) | `tests/batches.test.ts` |
| `fuel_quantity` not above the tank's `capacity_litres` | rule `volume_above_capacity` (`src/domain/rules.ts`) | `tests/rules.test.ts` |
| `fuel_quantity` equals the previous `remaining_quantity` (+/-0.001 L) | by construction: fuel is always the previous remaining, never the measurement (`src/domain/ledger.ts`); the database holds exact thousandths | `tests/ledger.test.ts`, `tests/ledger.property.test.ts`, chain checks of `npm run sim` |
| `consumed_quantity` not above `fuel_quantity` | rule `consumed_above_fuel` | `tests/rules.test.ts` |
| `fuel_height` (metres) not above the tank's `total_height` | rule `fuel_height_above_total`; millimetres are converted once | `tests/rules.test.ts`, `tests/serialize.test.ts` |
| `water_quantity` below `fuel_quantity` | rule `water_not_below_fuel`, and `remaining_not_above_water` (a reading whose remaining is not above its water is set aside so it cannot break the next one) | `tests/rules.test.ts`, `tests/ledger.test.ts` |
| `water_height` below 10,000,000 | rule `water_height_too_large` | `tests/rules.test.ts` |
| `temperature` optional, -50 to 100 | left out when absent or out of range | `tests/rules.test.ts` |
| `remaining_quantity` equals fuel - consumed (+/-1 L) and is the next expected fuel | by construction (remaining is the measurement, consumed the difference) | as for the chain |
| `reading_at` with an explicit UTC offset, not more than 5 minutes ahead | written in UTC with `Z`, whole seconds; rule `timestamp_in_future` | `tests/serialize.test.ts`, `tests/rules.test.ts` |
| duplicate (station, tank, time) refused | one emitted reading per tank and second (unique index); a duplicate answer is handled (below) | `tests/schema.test.ts`, `tests/result.test.ts` |
| no unknown properties (422) | the body is written by one typed serializer with exactly the guide's fields, in the guide's order | `tests/serialize.test.ts` |
| the legacy `reading_date` and `reading_time` | not used (`reading_at` is preferred) | |

## Batches (guide 1.2, 1.4.3)

| Guide statement | Where it is kept |
| --- | --- |
| all-or-nothing, only the first bad item reported as `item_index: N - field: x` | `src/batches/result.ts` reads the index and field, sets the item aside (or holds the tank when the chain is broken) and rebuilds the batch without it; every answer is stored as received |
| body of 1 MB at most (413) | batches stop at 900 KB, and the database refuses 1 MB or more; `tests/batches.test.ts` |
| readings of a tank in time order | `ORDER BY effective_at` per tank; `tests/batches.test.ts`, strict MoEnergy of `npm run sim` |
| 401 (key invalid, suspended, revoked), 403, 413 | action `fix_client_side`: the client fixes its key or size and sends again |
| 409, 429, 5xx | action `resend_same_body`: same body and correlation id, with backoff |
| 422 with a duplicate at item 0 | the reading is confirmed as stored (`accepted_assumed_resend`); *assumption*: duplicates are reported before a broken chain (probe 2) |
| 422 on one item | that reading is quarantined (`moenergy:<code>`) and the batch rebuilt; five refusals at one station in an hour stop and ask for a person |

## What the guide does not say (open, with the setting that decides it)

| Question | Setting | Probe |
| --- | --- | --- |
| Is a negative `consumed_quantity` (a refill) accepted? | `NEGATIVE_CONSUMED_POLICY` | 3 |
| Are more than two decimals accepted? | `QUANTITY_DECIMALS` | 4 |
| What is the first reading of a tank that MoEnergy holds nothing for? | anchor, `tanks.send_from` | 1 |
| May a reading older than the newest stored one be inserted? | late arrivals are set aside | 5 |
| Rate limit and most records per batch | none set; batches are bounded by size only | |
| How often must a tank be read? | none: every stored controller record is sent | |

## Sales (guide 2.6): not covered, and what it would take

The controller stores the sales of every pump (`PUMPTRS.CSV`; 34,108 rows on the first station). The guide's `transactions`
endpoint asks for: `sale_id` (unique per station), `pump_id`, `hose_id`, `payment_method` (1 cash, 2 debit card, 3 credit card),
`volume`, `money` (= volume x `ppu` to 2 decimals), `ppu`, `initial_volume` and `final_volume` (pump totalizers; the difference equals
the volume within 0.01), `start_at`, `end_at` and the `tank_code` the fuel came from. It needs a mapping from pump and nozzle to
tank, and a sample of the controller's pump records to see which of these fields it gives. It has no chain, so it is simpler than
readings. **Decision for the client: are sales in scope?** If yes, the next input is a `PUMPTRS.CSV` sample (the last 500 rows).
