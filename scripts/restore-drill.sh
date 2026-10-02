#!/usr/bin/env bash
# The drill: back up the live database, restore the dump into a scratch
# database, prove the scratch holds the same rows, drop it. Exits non-zero on
# any difference. Run it on a schedule; a backup is verified only by this.
#
#   scripts/restore-drill.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
POSTGRES_URL="${POSTGRES_URL:-postgres://geneus:devpassword@127.0.0.1:5433/geneus}"
PG_TOOLS="${PG_TOOLS:-}"
export POSTGRES_URL PG_TOOLS

TABLES="facilities staff devices device_credentials patients appointments register_definitions register_entries roster_shifts audit_events sync_rejections applied_mutations facility_invites enrollment_codes"

# shellcheck disable=SC2086
counts() {
  local url="$1" out=""
  for table in $TABLES; do
    out+="$table=$($PG_TOOLS psql --quiet --no-psqlrc -tAc "SELECT count(*) FROM $table" --dbname="$url") "
  done
  printf '%s' "$out"
}

dump="$("$here/backup.sh" "${BACKUP_DIR:-./backups}")"
scratch="$("$here/restore.sh" "$dump")"
scratch_url="$(printf '%s' "$POSTGRES_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/$scratch\1#")"

live_counts="$(counts "$POSTGRES_URL")"
restored_counts="$(counts "$scratch_url")"

# shellcheck disable=SC2086
$PG_TOOLS psql --quiet --no-psqlrc --dbname="$POSTGRES_URL" -c "DROP DATABASE \"$scratch\" WITH (FORCE)"

echo "dump:     $dump"
echo "live:     $live_counts"
echo "restored: $restored_counts"
if [ "$live_counts" != "$restored_counts" ]; then
  echo "RESTORE DRILL FAILED: restored row counts differ from live" >&2
  exit 1
fi
echo "restore drill passed"
