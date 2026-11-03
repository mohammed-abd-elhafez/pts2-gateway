# Simulation and replay

Two ways to run the whole pipeline (import, ledger, batches, a strict MoEnergy) before any controller uploads to us.

## Simulated stations

`scripts/sim/` generates stations that look like the first real one (AL HMAIDAN): 5 tanks with their real calibration charts
(`scripts/sim/data/`), about 125 records a day per station, the real sales rhythm, a refill about every 3.5 days, the
controller writing nothing during a delivery, and, on request, the faults the real file showed.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/pts2_test \
  npx tsx scripts/sim.ts --stations 38 --days 30 --seed 1 --faults        # exit code 1 when a check fails
  # --refuse-negative   MoEnergy answers 422 to a negative consumed quantity
  # --outage 10:5       controllers away for 5 days from day 10
  # --csv-dir out       also write each station's TANKMSR.CSV
```

The generator output is written as a real-format `TANKMSR.CSV` and read back by the importer (`src/import/tankmsr.ts`), so
the importer is part of what is tested. `scripts/sim/fake-moenergy.ts` is a stand-in for MoEnergy written from the guide's rules,
not from our own validator.

Faults that can be injected (per station, counted so the result can be compared): rows stamped `00:00:00`, two rows with the same
tank and second, small rises of 1 to 5 L on an idle tank, probe glitches that read 0 L, an outage, and a start without calibration
charts. What is checked at the end: the chain at MoEnergy is whole for every tank; litres are conserved (first fuel minus last
remaining equals the sum consumed); what MoEnergy holds is what our database says was accepted and at the times the data had;
no `00:00:00` or `clock_invalid` row was chained; every injected fault is found, no more and no less; refills in the chain equal
refills in the data; everything is drained (or, when MoEnergy refuses negatives, a tank is held); no batch is over 1 MB; a second
pass (same file, same client loop) changes nothing.

Result, 38 stations for 30 days with faults (seed 1): 141,701 records, 139,536 chained and all accepted, 281 refills, 76 probe
glitches skipped, 1,931 clock rows set aside, 60 batches (largest 899,992 bytes), 41 s, every check passed.

The checks were tried against deliberate breakage of the real code (wrong time zone, `00:00:00` taken as a time, a batch built
newest first, the skip rule for a probe at 0 L removed): each one is caught. Rounding to two decimals is not: the simulated
volumes are whole litres, as the real ones are; rounding is covered by `tests/quantity.test.ts`.

## The real file

```bash
npx tsx scripts/replay-tankmsr.ts TANKMSR.CSV --since 2026-10-04T00:00:00+03:00 [--refuse-negative]
```

reads a real `TANKMSR.CSV` into a scratch database and plays the client against the same strict MoEnergy. To load a real file into a
real station: `npm run import:tankmsr -- --station CODE --file TANKMSR.CSV --since ...`.

Result, the first real station's file from 2026-06-15 to 2026-11-03, rows from 2026-10-04 on:

| | MoEnergy accepts a negative consumed | MoEnergy refuses it |
| --- | --- | --- |
| File | 15,147 lines, none unreadable; 6,810 without litres and 2,418 before the start date left out | same |
| Stored | 4,803 rows, of which 1,173 stamped `00:00:00` set aside; 1,116 identical `00:00:00` lines dropped | same |
| Chained and accepted | **3,630 of 3,630**, one batch, every chain whole | **569**, then every tank is held |
| Refills (consumed below -3,000 L) | 15 (largest 32,046 L) | 0 sent: the first refill of each tank is refused |
| Pending when it stops | 0 | 3,056 (84 %) |
| Time of the last accepted reading | 2026-11-03 | tank 1: 2026-10-10; tanks 2 to 5: 2026-10-05 to 10-06 |

So the answer to "can the real data go through" is yes, if MoEnergy accepts a negative consumed quantity; if it does not, the flow of
this station stops within two to six days. That is why probe 3 of `PREPRODUCTION_PROBES.md` comes first.

## Limits

One station is one sample. The strict MoEnergy is our reading of the guide: the order in which it reports two problems of one item,
whether it requires time order across a batch, and what it does with a reading older than the newest stored one are assumptions
(probes 2 and 5). Times of the generated data are whole seconds and volumes whole litres.
