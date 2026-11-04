#!/usr/bin/env bash
# Nightly logical backup of the database, kept on this machine and copied off it.
# Result: $BACKUP_DIR/pts2-YYYYmmddTHHMMSSZ.dump (pg_dump custom format) and its .sha256.
# Off-site: set RCLONE_REMOTE (for example `crypt-s3:pts2`) in .env; use an rclone "crypt" remote so the copy is encrypted.
# A dump is a consistent snapshot of the moment it starts. For point-in-time recovery at larger sizes use WAL archiving
# (pgBackRest); see docs/DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/lib.sh

OK_URL=$(env_get BACKUP_OK_URL)
FAIL_URL=$(env_get BACKUP_FAIL_URL)
fail() { alert "backup FAILED: $1"; ping_url "$FAIL_URL"; exit 1; }
trap 'fail "line $LINENO"' ERR

stamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp="$BACKUP_DIR/.pts2-$stamp.dump.partial"
final="$BACKUP_DIR/pts2-$stamp.dump"

compose exec -T db pg_dump -U postgres -d pts2 -Fc --no-owner > "$tmp"
[ -s "$tmp" ] || fail "the dump is empty"
# the archive must be readable end to end, or it is not a backup
compose exec -T db pg_restore --list < "$tmp" > /dev/null || fail "the dump cannot be read back"
mv "$tmp" "$final"
chmod 600 "$final"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$final")" > "$(basename "$final").sha256" )

remote=$(env_get RCLONE_REMOTE)
if [ -n "$remote" ]; then
  command -v rclone > /dev/null || fail "RCLONE_REMOTE is set but rclone is not installed"
  rclone copy "$final" "$remote" --quiet
  rclone copy "$final.sha256" "$remote" --quiet
  date -u +%s > "$STATE_DIR/last-offsite"
fi

# Keep every dump for 14 days, Sunday dumps for 60 days, first-of-month dumps for 400 days.
now=$(date +%s)
for f in "$BACKUP_DIR"/pts2-*.dump; do
  [ -e "$f" ] || continue
  d=$(basename "$f" | sed -E 's/^pts2-([0-9]{8})T.*/\1/')
  age=$(( (now - $(date -u -d "$d" +%s)) / 86400 ))
  dow=$(date -u -d "$d" +%u)
  dom=${d:6:2}
  keep=14
  [ "$dow" = 7 ] && keep=60
  [ "$dom" = 01 ] && keep=400
  if [ "$age" -gt "$keep" ]; then rm -f -- "$f" "$f.sha256"; fi
done

date -u +%s > "$STATE_DIR/last-backup"
echo "backup ok: $final ($(du -h "$final" | cut -f1))"
ping_url "$OK_URL"
