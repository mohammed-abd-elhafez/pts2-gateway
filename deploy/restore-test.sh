#!/usr/bin/env bash
# Monthly proof that the backups can be restored: restores the newest dump into a scratch database, checks it, drops
# the scratch database (only that one). A backup nobody has restored is a hope, not a backup.
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/lib.sh

OK_URL=$(env_get RESTORE_TEST_OK_URL)
FAIL_URL=$(env_get RESTORE_TEST_FAIL_URL)
scratch=pts2_restoretest
fail() { alert "restore test FAILED: $1"; ping_url "$FAIL_URL"; exit 1; }
trap 'fail "line $LINENO"' ERR

dump=$(ls -1t "$BACKUP_DIR"/pts2-*.dump 2>/dev/null | head -1 || true)
[ -n "$dump" ] || fail "there is no dump to test"
age_h=$(( ( $(date +%s) - $(stat -c %Y "$dump") ) / 3600 ))
[ "$age_h" -lt 48 ] || fail "the newest dump is $age_h hours old"

compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" > /dev/null
compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $scratch" > /dev/null
compose exec -T db pg_restore -U postgres -d "$scratch" --no-owner --exit-on-error < "$dump"

q() { compose exec -T db psql -U postgres -d "$scratch" -Atc "$1"; }
migrations=$(q "SELECT count(*) FROM schema_migrations")
tables=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
stations=$(q "SELECT count(*) FROM stations")
live_stations=$(compose exec -T db psql -U postgres -d pts2 -Atc "SELECT count(*) FROM stations")
compose exec -T db psql -U postgres -d postgres -c "DROP DATABASE $scratch WITH (FORCE)" > /dev/null

[ "$migrations" -ge 1 ] || fail "the restored database has no migrations"
[ "$tables" -ge 14 ] || fail "the restored database has only $tables tables"
[ "$stations" -ge "$(( live_stations - 5 ))" ] || fail "the restored database has $stations stations, live has $live_stations"

date -u +%s > "$STATE_DIR/last-restore-test"
echo "restore test ok: $(basename "$dump"), $tables tables, $migrations migrations, $stations stations"
ping_url "$OK_URL"
