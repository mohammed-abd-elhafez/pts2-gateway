#!/usr/bin/env bash
# Installs the systemd timers (backup, health check, restore test, pruning of old raw uploads) on a server that was
# set up by hand. They run as the user `deploy` from /opt/pts2-gateway. Run with sudo:
#   sudo bash /opt/pts2-gateway/deploy/install-timers.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 2; }
src=/opt/pts2-gateway/deploy/systemd
[ -d "$src" ] || { echo "$src does not exist: the project must be in /opt/pts2-gateway" >&2; exit 2; }
id deploy > /dev/null
install -d -m 700 -o deploy -g deploy /var/backups/pts2 /var/lib/pts2-ops
for u in pts2-backup pts2-health pts2-restore-test pts2-prune; do
  for ext in service timer; do
    sed 's#^\[Service\]#[Service]\nUser=deploy#' "$src/$u.$ext" > "/etc/systemd/system/$u.$ext"
  done
done
systemctl daemon-reload
systemctl enable --now pts2-backup.timer pts2-health.timer pts2-restore-test.timer pts2-prune.timer
systemctl list-timers 'pts2-*' --no-pager
