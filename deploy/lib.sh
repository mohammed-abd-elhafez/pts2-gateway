# Shared by the deploy scripts. Source it after `cd` to the project root.
# .env is read with grep, not sourced: values such as CAPTURE_REPLY_BODY={"ok":true} are not shell syntax.

env_get() { # env_get NAME [DEFAULT]
  local v
  v=$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true)
  if [ -n "${v:-}" ]; then printf '%s' "$v"; else printf '%s' "${2:-}"; fi
}

compose() { docker compose -f docker-compose.yml -f deploy/compose.prod.yaml "$@"; }

BACKUP_DIR=$(env_get BACKUP_DIR /var/backups/pts2)
STATE_DIR=$(env_get STATE_DIR /var/lib/pts2-ops)
mkdir -p "$BACKUP_DIR" "$STATE_DIR"

# A URL to call when a job succeeds / fails (a heartbeat monitor such as Watchgoose, healthchecks.io, ...). Optional.
ping_url() { # ping_url URL
  [ -n "${1:-}" ] && curl -fsS -m 15 --retry 2 -o /dev/null "$1" || true
}

# A webhook that takes {"text": "..."} (Slack, Mattermost, Teams-compatible relays, ...). Optional.
alert() { # alert MESSAGE
  local url
  url=$(env_get ALERT_WEBHOOK_URL)
  echo "ALERT: $1" >&2
  [ -n "$url" ] || return 0
  curl -fsS -m 15 --retry 2 -o /dev/null -H 'content-type: application/json' \
    -d "$(printf '{"text":"pts2-gateway (%s): %s"}' "$(hostname)" "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')")" "$url" || true
}
