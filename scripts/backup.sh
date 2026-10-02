#!/usr/bin/env bash
# Dumps the PostgreSQL source of truth (custom format, compressed) and prunes
# old dumps. Point it at any PostgreSQL — the compose container or a managed
# instance — through POSTGRES_URL. Run it from cron; check it from the drill
# (restore-drill.sh), because a backup that has never been restored is not one.
#
#   POSTGRES_URL=postgres://... scripts/backup.sh [backup-dir]
#
# PG_TOOLS chooses where pg_dump runs: empty for local binaries, or e.g.
# "docker compose exec -T postgres" to use the compose container's.
set -euo pipefail

BACKUP_DIR="${1:-${BACKUP_DIR:-./backups}}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
POSTGRES_URL="${POSTGRES_URL:-postgres://geneus:devpassword@127.0.0.1:5433/geneus}"
PG_TOOLS="${PG_TOOLS:-}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/geneus-$stamp.dump"

# shellcheck disable=SC2086
$PG_TOOLS pg_dump --format=custom --compress=6 --no-owner --no-privileges --dbname="$POSTGRES_URL" > "$target"

size=$(wc -c < "$target" | tr -d ' ')
if [ "$size" -lt 1000 ]; then
  echo "backup looks empty ($size bytes): $target" >&2
  exit 1
fi

find "$BACKUP_DIR" -name 'geneus-*.dump' -type f -mtime "+$RETENTION_DAYS" -delete
echo "$target"
