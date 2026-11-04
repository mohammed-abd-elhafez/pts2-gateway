# Shared by the deploy scripts. Source it after `cd` to the project root.
# .env is read with grep, not sourced: values such as CAPTURE_REPLY_BODY={"ok":true} are not shell syntax.

env_get() { # env_get NAME [DEFAULT]
  local v
  v=$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true)
  if [ -n "${v:-}" ]; then printf '%s' "$v"; else printf '%s' "${2:-}"; fi
}

# COMPOSE_FILE in .env lists the files, separated by colons (a smaller machine adds deploy/compose.small.yaml).
compose() {
  local args=() f
  while IFS= read -r f || [ -n "$f" ]; do args+=(-f "$f"); done < <(env_get COMPOSE_FILE "docker-compose.yml:deploy/compose.prod.yaml" | tr ':' '\n')
  docker compose "${args[@]}" "$@"
}

BACKUP_DIR=$(env_get BACKUP_DIR /var/backups/pts2)
STATE_DIR=$(env_get STATE_DIR /var/lib/pts2-ops)
mkdir -p "$BACKUP_DIR" "$STATE_DIR"

# A URL to call when a job succeeds / fails (a heartbeat monitor such as Watchgoose, healthchecks.io, ...). Optional.
ping_url() { # ping_url URL
  [ -n "${1:-}" ] && curl -fsS -m 15 --retry 2 -o /dev/null "$1" || true
}

# Alerts go to every channel that is configured: Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) and/or a webhook that
# takes {"text": "..."} (ALERT_WEBHOOK_URL: Slack, Mattermost, ...). With neither, the message is only printed.
alert() { # alert MESSAGE
  local url token chat text
  text="pts2-gateway ($(hostname)): $1"
  echo "ALERT: $1" >&2
  token=$(env_get TELEGRAM_BOT_TOKEN); chat=$(env_get TELEGRAM_CHAT_ID)
  if [ -n "$token" ] && [ -n "$chat" ]; then
    # the token goes in through a config on stdin, so it never shows in the process list
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" \
      | curl -fsS -m 15 --retry 2 -o /dev/null -K - --data-urlencode "chat_id=$chat" --data-urlencode "text=$text" || true
  fi
  url=$(env_get ALERT_WEBHOOK_URL)
  [ -n "$url" ] || return 0
  curl -fsS -m 15 --retry 2 -o /dev/null -H 'content-type: application/json' \
    -d "$(printf '{"text":"%s"}' "$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')")" "$url" || true
}

# Problems with the copy of the backups that must live somewhere other than this server. Prints "LEVEL|message" lines.
offsite_check() {
  local remote last now age_h
  remote=$(env_get RCLONE_REMOTE)
  if [ -z "$remote" ]; then
    echo "WARN|backups exist only on this server: set RCLONE_REMOTE so they are copied somewhere else (a lost disk loses them too)"
    return 0
  fi
  last=$(cat "$STATE_DIR/last-offsite" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ "$last" -le 0 ]; then
    echo "CRIT|the off-site backup copy has never succeeded"
  else
    age_h=$(( (now - last) / 3600 ))
    [ "$age_h" -lt 26 ] || echo "CRIT|the off-site backup copy is ${age_h}h old"
  fi
}

# Alerts that would go nowhere. Prints "LEVEL|message" lines.
alerts_check() {
  local token chat hook
  token=$(env_get TELEGRAM_BOT_TOKEN); chat=$(env_get TELEGRAM_CHAT_ID); hook=$(env_get ALERT_WEBHOOK_URL)
  if [ -n "$token" ] && [ -z "$chat" ]; then
    echo "WARN|TELEGRAM_BOT_TOKEN is set but TELEGRAM_CHAT_ID is not: Telegram alerts are not sent"
  elif [ -z "$token" ] && [ -n "$chat" ]; then
    echo "WARN|TELEGRAM_CHAT_ID is set but TELEGRAM_BOT_TOKEN is not: Telegram alerts are not sent"
  elif [ -z "$token" ] && [ -z "$hook" ]; then
    echo "WARN|no alert channel is configured (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or ALERT_WEBHOOK_URL): problems are only written to the log"
  fi
}
