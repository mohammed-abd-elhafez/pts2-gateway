#!/usr/bin/env bash
# Weekly: removes raw controller uploads older than RAW_UPLOADS_RETENTION_DAYS (default 90, at least 7).
# The readings made from them stay; only the raw bytes kept for diagnosis go.
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/lib.sh

fail() { alert "pruning raw uploads FAILED: $1"; exit 1; }
trap 'fail "line $LINENO"' ERR

days=$(env_get RAW_UPLOADS_RETENTION_DAYS 90)
compose exec -T -e RAW_UPLOADS_RETENTION_DAYS="$days" app node dist/scripts/prune-raw-uploads.js
