#!/bin/sh
set -e

# A named volume created by an older image may be owned by root. Repair only
# the selected SQLite directory, database, and sidecars, then drop privileges.
if [ "$(id -u)" = "0" ]; then
  database_url=${DATABASE_URL%%\?*}
  case "$database_url" in
    file:/data/*)
      sqlite_name=${database_url#file:/data/}
      case "$sqlite_name" in
        ""|.|..|*/*)
          echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [ERROR] SQLite database must be a direct child of /data" >&2
          exit 1
          ;;
      esac
      sqlite_path="/data/$sqlite_name"
      chown nextjs:nodejs /data
      for sqlite_file in \
        "$sqlite_path" \
        "$sqlite_path-journal" \
        "$sqlite_path-wal" \
        "$sqlite_path-shm"
      do
        if [ -L "$sqlite_file" ]; then
          echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [ERROR] Refusing symbolic link at $sqlite_file" >&2
          exit 1
        fi
        if [ -e "$sqlite_file" ]; then
          chown -h nextjs:nodejs "$sqlite_file"
        fi
      done
      ;;
  esac
  exec su-exec nextjs:nodejs "$0" "$@"
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [INFO] Ollama Admin starting..."

# Detect database type from DATABASE_URL and set Prisma provider accordingly
PRISMA_BIN="node_modules/prisma/build/index.js"

case "${DATABASE_URL:-}" in
  postgresql://*|postgres://*)
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [INFO] Detected PostgreSQL database"
    sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
    node "$PRISMA_BIN" generate
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [INFO] Synchronizing PostgreSQL schema..."
    # The checked-in migrations are SQLite SQL, so PostgreSQL uses db push, which
    # refuses changes that would drop data. Take a pg_dump before upgrading.
    if ! node "$PRISMA_BIN" db push --skip-generate; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [ERROR] PostgreSQL schema sync failed. If Prisma reported possible data loss, back up the database, then review the change before running 'prisma db push --accept-data-loss' manually." >&2
      exit 1
    fi
    ;;
  *)
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [INFO] Using SQLite database"
    ./backup-sqlite.sh
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [INFO] Running database migrations..."
    if migration_output=$(node "$PRISMA_BIN" migrate deploy 2>&1); then
      printf '%s\n' "$migration_output"
    else
      migration_status=$?
      printf '%s\n' "$migration_output" >&2
      if printf '%s\n' "$migration_output" | grep -q "P3005"; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [WARN] Existing schema has no migration history; synchronizing schema..."
        node "$PRISMA_BIN" db push --skip-generate
      else
        exit "$migration_status"
      fi
    fi
    ;;
esac

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [INFO] Database ready"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [INFO] Starting Next.js server on port ${PORT:-3000}"
exec "$@"
