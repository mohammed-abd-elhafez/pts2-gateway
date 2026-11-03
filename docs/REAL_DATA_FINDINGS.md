# What the real controller data says

Source: one real station (AL HMAIDAN, 5 tanks, PTS-2 firmware 2026.08.18), files downloaded from the controller's own
web page on 2026-11-03: `TANKMSR.CSV` (15,147 rows, 2026-06-15 to 2026-11-03), `TANKDLV.CSV` (6 rows), `ALERTS.CSV`
(15,013 rows), five calibration charts (`01CALIB.CSV` to `05CALIB.CSV`) and two truncated copies of `SERVER.LOG`;
plus two live `ProbeMeasurements` replies taken a minute apart from the station's local dashboard.

One station is one sample. Numbers marked "estimate" should be re-checked when a second station is seen.

## 1. How much data there really is

| | Measured |
| --- | --- |
| Stored records per station per day (5 tanks), 2026-10-20 on, without `00:00:00` rows | about 100 (per tank: 38, 10, 13, 28, 12) |
| Same, 2026-10-04 on (estimate) | about 100 to 120; about 190 if the `00:00:00` rows are counted |
| Typical gap between two records of a moving tank | median 5 to 7 minutes; an idle tank can stay silent for hours |
| Records where the height did not change | about 20 % (the controller also stores on a time tick) |
| Height change between two consecutive records | median 4 mm |
| Fuel sold per station per day (since 2026-10-20) | about 4,800 L (tank 1: 2,072; 2: 542; 3: 913; 4: 856; 5: 397) |
| Busy hours | 14:00 to 18:00 local; quietest 02:00 to 05:00 |
| Refills (volume rise above 100 L) | 33 since 2026-09-08, 8 of them stamped `00:00:00`; about one every 3 to 4 days per station; 114 L to 32,401 L |
| Probe noise (a rise of 1 to 5 L with no refill) | 10 of about 5,650 steps (0.18 %), never above 5 L |

Consequence: about 0.05 to 0.08 readings per second for 38 stations. See `SCALING.md`.

## 2. Things that break naive assumptions

- **No litre volume before 2026-09-05.** `PVPresent` is 0 until the calibration charts were loaded (first volumes: probe 1
  on 09-05, probes 2, 4 and 5 on 09-06, probe 3 on 09-11). 8,337 of the 15,147 rows have a volume.
- **Charts of tanks 1 to 3 changed after September.** Volumes before 2026-10-04 do not match today's charts for those
  tanks (mean difference up to thousands of litres); from 2026-10-04 they match. Tanks 4 and 5 match throughout.
  Trust litre values from **2026-10-04**.
- **Rows stamped exactly `00:00:00`: 2,327 (15 %).** They come in bursts after the controller restarts (2026-10-15: 626,
  10-19: 572, 11-01: 484, 10-30: 309, 10-26: 200 ...) and carry real-looking values that often jump (for example +15,549 L
  at 2026-11-01 00:00:00 on tank 4). 40 pairs share the same tank and second with different values, so
  `(tank, device_time)` is not a safe key for them. Reading: the clock was not set for those rows. Treat `00:00:00` as
  `clock_invalid`: keep the row, never send it to MoEnergy.
- **The controller goes away for days.** All probes stop from 2026-09-18 about 21:00 to 2026-10-04 about 15:00 (16 days;
  probe 2 from 09-15), and from 2026-06-24 to 2026-07-04 (10 days). The first reading after a gap carries the whole
  difference (consumption or a refill).
- **In-tank deliveries are not recorded.** `TANKDLV.CSV` has 6 rows, all between 2026-08-30 and 2026-09-05, with zero
  volumes. After the charts were loaded the controller wrote none, although refills kept happening. Refills have to be
  inferred from volume rises. With the ledger's rule that is a **negative `consumed_quantity` about every 3 to 4 days
  per station** (about 10 a day at 38 stations). Whether MoEnergy accepts it is the first thing to probe
  (`PREPRODUCTION_PROBES.md`, probe 3).
- **Tank heights.** The charts end at 2470 mm (tanks 2 and 3), 2340 mm (tanks 4 and 5) and 2750 mm (tank 1); the controller
  is configured with 2750 mm and 3000 mm. MoEnergy's `total_height` must come from the official tank specification.

## 3. How the numbers relate (checked)

- `ProductVolume` is in litres (integer). The `*Float` fields in the jsonPTS reply are the same value divided by 100:
  never use them.
- `ProductVolume` = chart volume at `ProductHeight` minus `WaterVolume` (since 2026-10-20 the difference is -16 to -26 L,
  standard deviation 2 to 5 L, which is the water volume of 18 to 33 L).
- `ProductVolume + Ullage + WaterVolume` = the chart's last volume, exactly (example: 22,400 + 20,414 + 33 = 42,847 L).
  So the tank capacity is the chart maximum: **42,847 / 20,596 / 20,596 / 18,614 / 18,614 L** for tanks 1 to 5. Tanks 2 and
  3 share one chart, and so do 4 and 5, so the charts are nominal tables, not measured per tank.
- Water height is 15 to 18 mm and water volume 18 to 33 L on every tank, always: the probe's baseline, not water in the tank.
- Time is local (Saudi Arabia, UTC+3) without a zone; the clock was correct on 2026-11-03.
- Alerts (`ALERTS.CSV`) are mostly pump communication alerts; their codes are not decoded yet.

## 4. The channel to us (what is still unknown)

- `SERVER.LOG` (current file started 2026-09-17 20:53) shows only failed status uploads every 15 s to
  `https://pts.ranzstation.com:443`, each ending `HTTP_REMOTE_SERVER_GET_HOST_BY_NAME_ERROR`: the name did not resolve from
  the controller. The two copies we have are the first 60 KB of a 19 MB file, cut in the middle of a line. No jsonPTS
  upload and no reply is in them. `_SERVER.LOG` (the older file) has not been seen.
- Today `pts.ranzstation.com` resolves to `45.93.138.224`; the owner is unknown. We have not contacted it.
- Every upload switch on the controller is off and every "uploaded" counter is 0.
- The message the controller will send and the reply it expects are therefore still unverified; see
  `PTS2_DATA_ACQUISITION.md`.

## 5. The pull format (verified, but not the channel we use)

The station's local dashboard (a small Flask app on a PC in the station) reads the controller with
`POST https://<controller>/jsonPTS`, HTTP Digest, certificate not verified:

```json
{"Protocol":"jsonPTS","Packets":[{"Id":1,"Type":"ProbeGetMeasurements","Data":{"Probe":1}}, ... ,
                                 {"Id":6,"Type":"GetConfigurationIdentifier","Data":{}}]}
```

and gets one `ProbeMeasurements` packet per probe (`DateTime` without zone, `Probe`, `ProductHeight` mm, `ProductVolume` L,
`ProductUllage`, `WaterHeight`, `WaterVolume`, `Temperature`, `TankFillingPercentage`, `Status`, `InTankDeliveryDetected`,
`FuelGradeId`, `FuelGradeName`) and a `ConfigurationIdentifier`. It answers only the current value, never history,
and works only inside the station's network. The same app does not send anything to MoEnergy.

Findings to pass to the client about that PC: the app listens on `0.0.0.0:9001` with no access token, the controller's
`admin` account still has its default password (stored in clear in the app's `config.json` and README), and a script
starts a temporary public Cloudflare tunnel to the dashboard.

## 6. The file through the pipeline

`scripts/replay-tankmsr.ts` on the full `TANKMSR.CSV`, rows from 2026-10-04 (details and table in `SIMULATION.md`): 3,630 readings
chained and all accepted by a strict MoEnergy when negative consumed quantities are accepted, 15 refills among them; 1,173 rows stamped
`00:00:00` set aside. If MoEnergy refuses a negative consumed quantity, the first refill of each tank is refused and each tank is held:
569 readings go out, 3,056 stay pending, and the flow of this station stops within two to six days of the start date.
