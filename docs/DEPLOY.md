# Deploying to a server

For a single Ubuntu server (written for 26.04 LTS, the machine this project was first put on). Everything runs in
Docker: PostgreSQL, a one-shot `migrate` step, the application, and Caddy (TLS and rate limits) in front.
Read it once before you start; every command can be pasted one line at a time.

**Status:** the pieces below are covered by tests (the restricted database role, pruning, the alert and health
helpers) or were checked with `docker compose config`. The full stack has **not** yet been brought up on a real server;
the first run is a test run, without real station data.

## 0. What you need first

| | |
| --- | --- |
| A server | Ubuntu 24.04 or newer, 2 CPU, 8 GB RAM, 50 GB disk is plenty |
| A name | a DNS record (type A) for the server's address. For a test without one, `<ip-with-dashes>.sslip.io` gets a real certificate, for example `195-35-24-163.sslip.io`. Use a real name for production |
| An e-mail | for the certificate authority (expiry notices) |
| A place for off-site backups | an rclone remote (section 7). Not optional once real data arrives |
| A way to be told | a Telegram bot or a webhook (section 8) |

## 1. The server (once)

Log in as a normal user with `sudo`, not as root, with an SSH key; turn password logins off; open only ports 22, 80
and 443 (`ufw`). Then:

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker "$USER"      # log out and in again afterwards
docker --version && docker compose version
```

`deploy/server-setup.sh` does the same for a fresh machine, but it is written for Ubuntu 24.04 and has not been run
on a real server; prefer the steps above.

## 2. The code

The repository is private, so the server gets a key that can **read** it and nothing else.

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/gh_deploy -C "pts2-server"
cat ~/.ssh/gh_deploy.pub
```

In GitHub: the repository, Settings, Deploy keys, Add deploy key; paste the line; leave "Allow write access" off.

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/gh_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
sudo install -d -o "$USER" -g "$USER" /opt/pts2-gateway
git clone git@github.com:mohammed-abd-elhafez/pts2-gateway.git /opt/pts2-gateway
cd /opt/pts2-gateway
```

## 3. The settings (`.env`)

```bash
cp .env.example .env && chmod 600 .env
openssl rand -hex 24      # run twice: one for POSTGRES_PASSWORD, one for APP_DB_PASSWORD
nano .env
```

Set at least:

```
POSTGRES_PASSWORD=<first value>
APP_DB_PASSWORD=<second value>          # letters and digits only
DOMAIN=gateway.example.com              # or 195-35-24-163.sslip.io for a test
ACME_EMAIL=you@example.com
COMPOSE_FILE=docker-compose.yml:deploy/compose.prod.yaml:deploy/compose.small.yaml
```

`compose.small.yaml` lowers the database memory for an 8 GB machine; leave it out on 16 GB.
Never put `.env` in git; the passwords exist only here.

## 4. Start

```bash
docker compose up -d --build
docker compose ps
docker compose logs migrate        # "application role pts2_app is ready"
curl -fsS https://$DOMAIN/v1/stations/NOPE/status    # 401: the door is up and asks for a key
```

The order is fixed by the compose file: the database, then `migrate` (migrations, then the restricted role), then the
application, then Caddy. The application connects as `pts2_app`, which can read and write the tables and nothing else.
The first start builds Caddy with its rate-limit module, which needs internet access and a few minutes.

A certificate is issued on the first request to the name; if it fails, `docker compose logs caddy` says why (usually
DNS not yet pointing at the server, or port 80 closed).

## 5. Stations and keys

```bash
# the key the client system uses to call our API (shown once): one for every station, or --station CODE for one
docker compose exec app node dist/scripts/add-client.js --name "client system" --all

# the stations and tanks, with the codes MoEnergy gave the client (template: docs/stations.example.csv)
cp docs/stations.example.csv stations.csv && nano stations.csv
docker compose exec -T app node dist/scripts/load-stations.js --file /dev/stdin --dry-run < stations.csv     # checks, writes nothing
docker compose exec -T app node dist/scripts/load-stations.js --file /dev/stdin < stations.csv              # prints each upload secret once
```

Each station's controller is given its own upload address and secret (`docs/ONBOARDING_STATION.md`). The keys and
secrets are shown once and only their hashes are stored: put them in the password manager at once.

## 6. The scheduled jobs

```bash
sudo bash /opt/pts2-gateway/deploy/install-timers.sh
```

| Job | When | What |
| --- | --- | --- |
| backup | every night 01:30 UTC | dump, check it can be read, copy it off the server |
| health | every 5 minutes | containers, stations that stopped uploading, held tanks, disk, backup age |
| restore test | monthly | restores the newest dump into a scratch database and checks it |
| prune | Sundays | removes raw uploads older than `RAW_UPLOADS_RETENTION_DAYS` (90); readings stay |

Run each once by hand the first time: `deploy/backup.sh`, `deploy/health-check.sh`, `deploy/prune.sh`.

## 7. Backups that survive the server

A dump kept on the machine it protects is lost with the machine. Copy it elsewhere, **encrypted**:

```bash
rclone config           # create the storage remote (S3, Backblaze B2, another server over SFTP ...), then a "crypt" remote over it
rclone lsd crypt-b2:    # proves the remote works
```

Put the crypt remote's name in `.env`: `RCLONE_REMOTE=crypt-b2:pts2`. The health check warns (WARN) until this is set
and turns critical (CRIT) if the last copy is older than 26 hours. Keep the rclone password somewhere other than the
server: without it the copies cannot be read.

## 8. Being told when something is wrong

Telegram: create a bot with @BotFather, send the bot any message, then open
`https://api.telegram.org/bot<TOKEN>/getUpdates` and read `chat.id`. Put both in `.env`:

```
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<id>
```

Test: `deploy/health-check.sh` prints what is wrong, and sends it when the set of problems changes (and again every six
hours while it lasts). A webhook that takes `{"text": "..."}` works too (`ALERT_WEBHOOK_URL`). Because a dead server
cannot send its own alarm, also set `HEALTH_OK_URL` to a heartbeat monitor (healthchecks.io or similar) that alerts when
the pings stop.

## 9. Updating

```bash
cd /opt/pts2-gateway
git fetch && git log --oneline HEAD..origin/main      # read what is coming
deploy/backup.sh                                      # a fresh dump first
git pull --ff-only
docker compose up -d --build
docker compose ps && docker compose logs --tail 30 app
```

**Going back:** `git checkout <previous commit>` and `docker compose up -d --build`. Migrations only add; they are not
undone. If a migration was the problem, restore the dump taken just before (section 10).

## 10. Restoring

Look at a dump first, in a separate database (nothing live is touched):

```bash
deploy/restore.sh /var/backups/pts2/pts2-<stamp>.dump --name pts2_check
docker compose exec db psql -U postgres -d pts2_check -c "select count(*) from emitted_readings"
docker compose exec db psql -U postgres -c "drop database pts2_check"
```

Replace the live database (stops the application, asks you to type `REPLACE`, restores, gives the application role its
rights again, starts it):

```bash
deploy/restore.sh /var/backups/pts2/pts2-<stamp>.dump --replace-live
```

After a restore, readings that were sent after the dump was taken are unknown to the ledger. Check each station with
`GET /v1/stations/{code}/status` and anchor any tank that needs it (`docs/API.md`, section 6.4).

On a brand-new server: do sections 1 to 4 first (that creates the empty database and the role), then restore.

## 11. Known gaps

- The whole stack has not run on a real server yet; expect to fix small things on the first run.
- One server: if it is down, nothing is received. The controllers store records and send them later, so a short outage
  loses nothing; a long one needs a second machine (`docs/SCALING.md`).
- The Caddy log filter hides the secret in `/pts/<secret>/...`. A mistyped address with extra slashes might not match
  it; look at the access log (`docker compose exec caddy sh -c 'tail -3 /var/log/caddy/access.log'`) after the first real upload.
- Docker images are pinned to versions (node, PostgreSQL, Caddy and its module); raise them on purpose, one at a time.
