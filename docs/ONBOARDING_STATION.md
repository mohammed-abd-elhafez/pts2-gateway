# Bringing a station on line (the checklist for each new station; 4 a month)

Each step has a check. Do them in order; do not switch the uploads on before step 5.

## Before going to the station (office)

1. **Codes and tank data.** From the client: the MoEnergy station code (`ST-000027`) and tank codes (`ST-000027-1`...), the product of
   each tank (1 diesel, 91, 95, 98), the official capacity in litres and total height in metres of each tank. Add rows to the stations
   file (`docs/stations.example.csv`): one row per tank. Probe number = the tank's number on the controller.
2. **Load them.** `npm run stations:load -- --file stations.csv --dry-run`, read what it would do, then run it without `--dry-run`.
   It prints the **upload secret** of each new station once: keep it (password manager), nobody can read it again.
   Set `--send-from` to the time the station goes live (default: now): readings before it are never sent, so the months of records
   the controller has stored are not pushed to MoEnergy.
3. **A key for the client system** if this station needs its own: `npm run client:add -- --name "..." --station CODE`
   (a key for all stations needs nothing new).

## On the controller (with the technician; read-only first)

4. **Look before changing.** Server tab: the domain and DNS must resolve from the station (in September the first controller could not
   resolve its server name: check the gateway and DNS on the Settings/Network tab). Settings tab: the **UTC offset** is the station's
   (+3 hours = 180) and the clock is right; "Device as Controller" is on so records are kept on the SD card (without it nothing uploads).
   Do not press Set or delete anything yet. Download `TANKMSR.CSV` (and `TANKDLV.CSV`) as the station's baseline.
5. **Point it at us.** Server tab: our domain, port 443, HTTPS, a server user created for us on the Users tab, the request URI
   `pts/<secret>` for the types we use. Switch on only **tank measurements, in-tank deliveries and status (60 s)**. Leave pump
   transactions, alerts and GPS off unless they are in scope. Press Set.
6. **Check it arrives.** Within minutes `raw_uploads` has rows for the station (`stations.last_seen_at` moves). The controller's
   "uploaded" counters rise. If not: `SERVER.LOG` on the controller (Server tab, Logging) says why (DNS, certificate, 401).
7. **Check the data.** After 5 minutes `GET /v1/stations/CODE/readings/batches/next` returns a batch (or 204 if nothing is
   after the go-live time yet). The first reading of each tank has `consumed_quantity` 0; later ones chain from it.

## After

8. **The client's first batch.** Ask the client to run one batch end to end and to send us MoEnergy's answer if it was not accepted.
9. **Watch the first day.** A silent station, a held tank (`held_reason`) or growing quarantine means something to look at
   (`deploy/health-check.sh`).
10. **Hand the controller back** with its admin password changed from the factory one (and recorded), and note the date and the
    firmware version.

## Things that go wrong

- The station's controller was off for days: when it comes back it uploads the gap; the first reading after it carries the whole
  difference (a refill shows as a negative consumed quantity).
- A stamp of exactly `00:00:00` is a controller that restarted without its clock: those rows are set aside (`clock_invalid`), the
  rest of the data is fine. Many of them mean the board's battery is flat.
- Litre values depend on the calibration chart in the controller; if a chart changes, readings before the change are not comparable.
