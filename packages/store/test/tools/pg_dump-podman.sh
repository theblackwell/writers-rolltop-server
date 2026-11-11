#!/bin/sh
# Test shim: runs pg_dump inside the rolltop-test-pg Podman container so the host needs no PostgreSQL client.
# Translates the runner's `--file X` into stdout redirection and the host port into the container's.
# Set ROLLTOP_TEST_PG_DUMP to this file's path.
out=""; args=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) out="$2"; shift 2 ;;
    --dbname) args="$args --dbname $(printf '%s' "$2" | sed 's/:55432/:5432/')"; shift 2 ;;
    *) args="$args $1"; shift ;;
  esac
done
PODMAN="${PODMAN:-/opt/podman/bin/podman}"
# shellcheck disable=SC2086
if [ -n "$out" ]; then
  "$PODMAN" exec -i -e PGPASSWORD rolltop-test-pg pg_dump $args > "$out"
else
  "$PODMAN" exec -i -e PGPASSWORD rolltop-test-pg pg_dump $args
fi
