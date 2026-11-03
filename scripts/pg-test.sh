#!/usr/bin/env bash
# Throwaway PostgreSQL for tests. Usage: scripts/pg-test.sh start|stop
set -euo pipefail

DIR="${PTS2_PG_DIR:-/tmp/pts2-pg}"
PORT="${PTS2_PG_PORT:-54329}"
BIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"

as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }

case "${1:-}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"
      [ "$(id -u)" = 0 ] && chown postgres "$DIR"
      as_pg "$BIN/initdb" -D "$DIR/data" -A trust -U postgres >/dev/null
    fi
    if ! as_pg "$BIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
      as_pg "$BIN/pg_ctl" -D "$DIR/data" -l "$DIR/log" -w \
        -o "-p $PORT -c listen_addresses=127.0.0.1 -c fsync=off -c unix_socket_directories=$DIR" start >/dev/null
    fi
    if ! psql -h 127.0.0.1 -p "$PORT" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='pts2_test'" | grep -q 1; then
      psql -h 127.0.0.1 -p "$PORT" -U postgres -qc "CREATE DATABASE pts2_test" >/dev/null
    fi
    echo "postgres://postgres@127.0.0.1:$PORT/pts2_test"
    ;;
  stop)
    as_pg "$BIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
