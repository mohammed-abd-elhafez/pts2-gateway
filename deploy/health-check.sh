#!/usr/bin/env bash
# Every 5 minutes: is everything running, are backups fresh, is the disk filling, does any station or tank need a person?
# Prints problems, tells ALERT_WEBHOOK_URL when the set of problems changes (and again every 6 hours while it lasts),
# and calls HEALTH_OK_URL after each completed run so an outside heartbeat monitor notices if this job itself stops.
set -uo pipefail
cd "$(dirname "$0")/.."
. deploy/lib.sh

problems=""
add() { problems+="$1: $2"$'\n'; }

# containers
for svc in db app caddy; do
  id=$(compose ps -q "$svc" 2>/dev/null | head -1)
  if [ -z "$id" ]; then add CRIT "container $svc is not running"; continue; fi
  state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")
  case "$state" in
    "running healthy"|"running ") ;;
    *) add CRIT "container $svc: $state" ;;
  esac
done

# database checks
silent=$(env_get SILENT_MINUTES 30)
if rows=$(compose exec -T db psql -U postgres -d pts2 -At -F '|' -v ON_ERROR_STOP=1 -v silent_min="$silent" -f - < deploy/health.sql 2>&1); then
  while IFS='|' read -r level msg; do [ -n "${level:-}" ] && add "$level" "$msg"; done <<< "$rows"
else
  add CRIT "health query failed: $(printf '%s' "$rows" | head -1)"
fi

# backups
now=$(date +%s)
last=$(cat "$STATE_DIR/last-backup" 2>/dev/null || echo 0)
age_h=$(( (now - last) / 3600 ))
[ "$last" -gt 0 ] && [ "$age_h" -lt 26 ] || add CRIT "no successful backup in the last 26 hours (last: $([ "$last" -gt 0 ] && echo "${age_h}h ago" || echo never))"
lt=$(cat "$STATE_DIR/last-restore-test" 2>/dev/null || echo 0)
[ "$lt" -gt 0 ] && [ $(( (now - lt) / 86400 )) -lt 40 ] || add WARN "no successful restore test in the last 40 days"

# the copy that lives off this server, and whether anyone would hear an alarm
while IFS='|' read -r level msg; do [ -n "${level:-}" ] && add "$level" "$msg"; done < <(offsite_check; alerts_check)

# disks
for path in / "$BACKUP_DIR" "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"; do
  use=$(df --output=pcent "$path" 2>/dev/null | tail -1 | tr -dc '0-9')
  [ -n "$use" ] || continue
  if [ "$use" -ge 90 ]; then add CRIT "disk $path is ${use}% full"; elif [ "$use" -ge 80 ]; then add WARN "disk $path is ${use}% full"; fi
done

# report
sig=$(printf '%s' "$problems" | sha256sum | cut -c1-16)
prev=$(cat "$STATE_DIR/health-sig" 2>/dev/null || echo "")
prev_t=$(cat "$STATE_DIR/health-alert-time" 2>/dev/null || echo 0)
if [ -z "$problems" ]; then
  echo "health ok"
  [ -n "$prev" ] && [ "$prev" != "ok" ] && alert "all clear"
  echo ok > "$STATE_DIR/health-sig"
else
  printf '%s' "$problems"
  if [ "$sig" != "$prev" ] || [ $(( now - prev_t )) -ge 21600 ]; then
    alert "$(printf '%s' "$problems" | head -20)"
    echo "$now" > "$STATE_DIR/health-alert-time"
  fi
  echo "$sig" > "$STATE_DIR/health-sig"
fi
ping_url "$(env_get HEALTH_OK_URL)"
