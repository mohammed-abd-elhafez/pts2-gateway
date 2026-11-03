# Trying the gateway on Render (a test deployment, not production)

What you get: the gateway and a PostgreSQL database on Render, three simulated stations (`SIM-001`, `SIM-002`, `SIM-003`, five tanks each,
a week of readings) and one API key, so the client API can be tried by hand with curl or Postman. The readings are simulated: the codes
(`ST-000001`...) are made up and nothing is sent to MoEnergy; you play the client and post an answer yourself.

Limits of the free plans (Render's own terms, check them when you deploy): the web service goes to sleep after 15 minutes without a
request and the first request afterwards takes up to a minute; the free database expires 30 days after it is created; the
service has a monthly allowance of free hours. Good for a trial. Do not point real controllers at it, and do not use it for production:
Render has no region in Saudi Arabia (the blueprint uses Frankfurt), and a sleeping service cannot receive uploads.

## 1. Put the code on GitHub (a private repository)

The folder is not a Git repository yet; Render builds from one. Create an empty **private** repository on GitHub (no README), then in
PowerShell, in the project folder (`pts2-gateway`):

```powershell
git init
git add .
git status          # check: no .env, no node_modules, no dist in the list
git commit -m "PTS-2 gateway"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

Keep the repository private: `tests/fixtures/hmaidan/` holds a few rows of the client's real tank data and `docs/` names the client.

## 2. Create the services

On render.com: **New > Blueprint**, connect GitHub, choose the repository, **Apply**. Render reads `render.yaml`, creates the database
`pts2-db` and the web service `pts2-gateway`, builds the Docker image (a few minutes) and starts it. The start command applies the
migrations, loads the demo data (only because `DEMO_SEED` is `true`) and starts the server. The first deploy loads the demo data once;
a restart does not load it again.

## 3. Get the API key and the address

Open the service `pts2-gateway`: the address is at the top (`https://pts2-gateway-xxxx.onrender.com`), and **Environment** shows
`DEMO_API_KEY` (Render generated it; click the eye icon). That is the key of the client system.

## 4. Walk through the API

In PowerShell use `curl.exe` (plain `curl` is something else). Replace `$URL` and `$KEY`:

```powershell
$URL = "https://pts2-gateway-xxxx.onrender.com"
$KEY = "<DEMO_API_KEY>"

# 1. next batch: 200 with {"readings":[...]} and headers X-Batch-Id and X-Correlation-Id; 204 when nothing is ready
curl.exe -i -H "Authorization: Bearer $KEY" "$URL/v1/stations/SIM-001/readings/batches/next"

# 2. report MoEnergy's answer (here: pretend it accepted all N items); use the batch id and correlation id from step 1
curl.exe -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -X POST `
  "$URL/v1/stations/SIM-001/readings/batches/<X-Batch-Id>/result" `
  -d '{"status_code":200,"body":{"status":"accepted","accepted_count":<N>},"correlation_id":"<X-Correlation-Id>"}'

# 3. next batch again: 204 when the station is drained
```

Other stations: `SIM-002`, `SIM-003`. A wrong key answers `401`. A station that does not exist answers `404`. Every call is described in
`docs/API.md`. To try a refused item, post `{"status_code":422,"body":{"errors":[{"code":"x","message":"item_index: 1 - field: fuel_quantity","sourceErrorCode":"X","sourceMessage":"x"}]}}`
for a batch and see the action in the answer.

## 5. Afterwards

- Delete the services on Render when you are done (the database too), or let the free database expire.
- To run something else against the database from your computer, use the **External Database URL** from the database page, with
  `PGSSL=no-verify` set in your shell (Render's external connections need TLS).
- Before any real use: remove `DEMO_SEED`, `DEMO_API_KEY`, `DEMO_STATIONS` and `DEMO_DAYS` from the environment, and revoke the demo key:
  `UPDATE api_clients SET revoked_at = now() WHERE name = 'demo client';`. Real stations are added with `add-station`, real keys with
  `add-client` (see `README.md`); run them from your computer with the external URL, since a free service has no shell.
