#!/bin/sh
# Snapshot the SQLite database before pending migrations run. Called from the
# entrypoint while the app is stopped, so a file copy is consistent. Skipped
# when no migrations are pending, so routine restarts do not fill the disk.
set -e

PRISMA_BIN="${PRISMA_BIN:-node_modules/prisma/build/index.js}"
BACKUP_KEEP="${DB_BACKUP_KEEP:-5}"

sqlite_url=${DATABASE_URL%%\?*}
case "$sqlite_url" in
  file:/*|file:[A-Za-z]:/*) sqlite_path=${sqlite_url#file:} ;;
  *) exit 0 ;;
esac
[ -f "$sqlite_path" ] || exit 0
if node "$PRISMA_BIN" migrate status >/dev/null 2>&1; then
  exit 0
fi

backup_dir="$(dirname "$sqlite_path")/backups"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_path="$backup_dir/$(basename "$sqlite_path").$stamp.bak"
mkdir -p "$backup_dir"
cp "$sqlite_path" "$backup_path"
[ -f "$sqlite_path-wal" ] && cp "$sqlite_path-wal" "$backup_path-wal"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [INFO] Backed up database to $backup_path before migrating"

ls -1t "$backup_dir"/*.bak 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
  rm -f "$old" "$old-wal"
done
