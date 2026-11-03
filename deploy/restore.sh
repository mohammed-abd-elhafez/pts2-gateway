#!/usr/bin/env bash
# Restores a dump into a NEW database so you can look at it first:
#   deploy/restore.sh /var/backups/pts2/pts2-20261103T013000Z.dump            -> database pts2_restored
#   deploy/restore.sh DUMP --name pts2_check                                  -> a name of your choice
# Replacing the live database is deliberately a separate, typed step:
#   deploy/restore.sh DUMP --replace-live    (stops the app, drops the live database, restores, starts the app)
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/lib.sh

dump=${1:?usage: restore.sh DUMPFILE [--name DB | --replace-live]}
shift || true
name=pts2_restored
live=no
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name=${2:?}; shift 2 ;;
    --replace-live) live=yes; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -s "$dump" ] || { echo "no such dump: $dump" >&2; exit 2; }
if [ -f "$dump.sha256" ]; then ( cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256" ); fi
[[ "$name" =~ ^[a-z_][a-z0-9_]{0,40}$ ]] || { echo "bad database name" >&2; exit 2; }

if [ "$live" = yes ]; then
  echo "This STOPS the application, DELETES the live database 'pts2' and replaces it with:"
  echo "  $dump"
  echo "Everything stored after that dump is lost. Type the word REPLACE to go on:"
  read -r answer
  [ "$answer" = REPLACE ] || { echo "cancelled"; exit 1; }
  compose stop app
  compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS pts2 WITH (FORCE)"
  name=pts2
fi

compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$name\""
compose exec -T db pg_restore -U postgres -d "$name" --no-owner --exit-on-error < "$dump"
echo "restored into database '$name'"
if [ "$live" = yes ]; then
  compose up -d app
  echo "application started"
fi
