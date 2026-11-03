# How the data leaves a PTS-2 controller

Source: Technotrade "PTS-2 forecourt controller technical guide", revision R12, 17 April 2026 (233 pages), public download:
https://www.technotrade.ua/View/DownloadFile?fileName=PTS-2-forecourt-controller-technical-guide.pdf
Seen on a real controller of the client on 2026-11-03: firmware 2026.08.18, remote server `pts.ranzstation.com:443`,
HTTPS (TLS 1.2), request URI `jsonPTS`, server user from the Users tab, no secret key, all uploads off.

## Two ways the controller talks to a remote server (guide pp. 110-118)

1. **HTTP upload (the one we use).** The controller is the client: it sends HTTP(S) requests to our server, so it needs
   no static address, VPN or open port. Each data type is switched on separately and has its own request URI
   (the screen shows `jsonPTS` for all of them): pump transactions, **tank measurements**, **in-tank deliveries**,
   alerts, GPS, configuration, status. Settings: server address or domain, port, protocol (HTTP/HTTPS TLS 1.2),
   server user (credentials stored on the controller's Users tab), response timeout, and an optional **secret key**
   used to sign every message (integrity and origin).
2. **WebSocket.** A permanent connection (RFC 6455) over which the server can send any request (read or write
   configuration, read records, control pumps). The controller reconnects after a period it is given. Not needed for
   readings; it would let us fetch history on demand. Later, if ever.

The message format and the reply the server must give are in a separate Technotrade document, **"jsonPTS communication
protocol specification for PTS-2 controller"**, which is not on the public site. It comes with Technotrade's free
support plan (documentation is part of it): mail@technotrade.ua. Until we have it, the real exchange is in the
controller's `SERVER.LOG` (guide p. 116; the controller screen showed "Log the communication exchange" on and a
19 MB log).

## What gets uploaded and when

- **Tank measurements: one record each time the controller sees the product height change**, not every minute.
  A quiet tank sends nothing for hours, so "no tank record" does not mean "station silent". Silence is judged from the
  status upload (set its period to 60 s, not the 1 s used in Technotrade's test example).
- Record fields (guide p. 111): date and time, tank number, probe error, alarms, product height, water height,
  temperature, product volume, water volume, ullage, temperature-compensated volume, density, mass.
  Each value has a "present" flag in the CSV: a tank without a calibration chart has no volume.
- In-tank deliveries: one record per delivery (start and end time, heights, volumes, pumps dispensed volume). They need
  the delivery option enabled on each probe. The controller on site holds 6, none after 2026-09-05 and all without volumes, so they are not usable test data.
- The controller keeps a counter of records stored and of records uploaded, and the screen lets a person reset the
  uploaded counter so that everything is sent again. Records must be saved to the SD card ("Device as Controller" in
  Parameters) or nothing is uploaded.
- Time: records carry the controller's local date and time without a zone; the Settings tab has a UTC offset and
  time sync (NTP, needs a gateway), and a battery on the board for a correct clock (guide p. 40).

## The same data as files (for development and for backfill)

`TANKMSR.CSV`, `TANKDLV.CSV`, `ALERTS.CSV`, `PUMPTRN.CSV` and the calibration charts `NNCALIB.CSV` can be downloaded from the
controller's web page (the Database records section and the Logging section). Formats (guide pp. 67-68):

```
TANKMSR.CSV  DateTime,Probe,Status,Alarms,PHPresent,ProductHeight,WHPresent,WaterHeight,TPresent,Temperature,
             PVPresent,ProductVolume,WVPresent,WaterVolume,UPresent,Ullage,PTCVPresent,ProductTCVolume,
             DPresent,Density,MPresent,Mass,FPPresent,FillingPercentage
             23.01.27 20:00:00,01,0,00,1,00002500.0,1,00000010.0,1,+00000020.0,1,0000020000,1,0000000100,1,0000005000,1,0000019891,1,00000759.0,1,00015180.0,1,057
TANKDLV.CSV  DateTimeStart,DateTimeEnd,Tank,ValuesPresent,ProductHeightStart,ProductHeightEnd,WaterHeightStart,
             WaterHeightEnd,TemperatureStart,TemperatureEnd,ProductVolumeStart,ProductVolumeEnd,ProductTCVolumeStart,
             ProductTCVolumeEnd,DensityStart,DensityEnd,MassStart,MassEnd,PumpsDispensedVolume
```

(Dates are `YY.MM.DD HH:MM:SS`; heights in mm, volumes in litres; values are zero padded.) A CSV importer is the quickest way
to run the whole pipeline on real data before the jsonPTS reply is known.

## What the first real data showed (2026-11-03)

Details and numbers: `REAL_DATA_FINDINGS.md`.

- `SERVER.LOG` holds no jsonPTS exchange. The part we have (the first 60 KB of 19 MB; the file starts 2026-09-17) is only
  failed status uploads to `pts.ranzstation.com:443` with `HTTP_REMOTE_SERVER_GET_HOST_BY_NAME_ERROR`: the controller could
  not resolve the name. The download from the controller's page was cut short; `_SERVER.LOG`, the older file, is unseen.
- Today the name resolves to `45.93.138.224`, a server we do not know. We have not contacted it.
- The pull format is known (a station PC reads the controller with `ProbeGetMeasurements` over HTTP Digest), the push format is not.
- The controller stores about 100 tank records a day, wrongly stamps some `00:00:00` after a restart, and has not recorded
  in-tank deliveries since 2026-09-05.

## Plan

1. Inputs we still need: the end of `SERVER.LOG` and `_SERVER.LOG` (read with the browser console, tail only; the plain
   download stops early), the jsonPTS specification from Technotrade, the owner of `pts.ranzstation.com`, the controller's
   DNS and gateway settings, and a name we control for the capture.
2. Build now, without the push format: the simulator and the CSV importer (`docs/plans/2026-11-03-roadmap-v2.md`, phase 1).
3. Capture on one controller: on its Server tab set a name we control, port 443, HTTPS, a server user created for us and a
   URI of `pts/<secret>`; switch on first only **status**, then **tank measurements** and **in-tank deliveries**. The stored
   backlog (about 15,000 tank records) uploads by itself: decide before switching it on whether old readings may be sent on
   (the anchor's `as_of` keeps them back) and whether to set the controller's "uploaded" counter instead.
4. Write the jsonPTS parser and the reply from what the capture shows.
5. Only after that, the other stations (the client's own DNS name can be pointed at our server if it is theirs).

## Fallback if the controller cannot push to us

An agent on the station's PC, using the verified pull request. It sees only the current value (no history), so a gap in the
agent is a gap in the data, and it needs a PC that stays on at every station. Use it only if pushing fails.

## Open points

- The cadence MoEnergy expects for readings (the controller sends on change plus a time tick, about every 5 to 7 minutes
  while a tank moves).
- How the server user and password are sent (Basic, Digest) and how the secret key signs a message: from the specification or the log.
- Whether the controller trusts a Let's Encrypt certificate (TLS 1.2 only, small device): test on one controller.
- Whether the controller's DNS and gateway are set (they were not, in September).
