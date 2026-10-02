#!/usr/bin/env bash
# Restores a dump into a database. By default into a NEW database beside the
# live one (safe: nothing is overwritten) so it can be inspected or compared;
# --replace drops and recreates the named database — the real recovery path,
# to be run only when the live database is the thing being replaced.
#
#   scripts/restore.sh <dump> [target-database]            # into a fresh database
#   scripts/restore.sh <dump> geneus --replace             # recovery
#
# POSTGRES_URL must point at a database on the target server whose user can
# CREATE DATABASE (the compose superuser does; a managed instance's admin user
# does). PG_TOOLS as in backup.sh.
set -euo pipefail

dump="${1:?usage: restore.sh <dump> [target-database] [--replace]}"
target="${2:-geneus_restore_$(date -u +%Y%m%dT%H%M%SZ)}"
replace="${3:-}"
POSTGRES_URL="${POSTGRES_URL:-postgres://geneus:devpassword@127.0.0.1:5433/geneus}"
PG_TOOLS="${PG_TOOLS:-}"

admin_url="$POSTGRES_URL"
target_url="$(printf '%s' "$POSTGRES_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/$target\1#")"

# shellcheck disable=SC2086
psql_admin() { $PG_TOOLS psql --quiet --no-psqlrc -v ON_ERROR_STOP=1 --dbname="$admin_url" "$@"; }

exists=$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$target'")
if [ "$exists" = "1" ]; then
  if [ "$replace" != "--replace" ]; then
    echo "database $target already exists; pass --replace to drop and recreate it" >&2
    exit 1
  fi
  psql_admin -c "DROP DATABASE \"$target\" WITH (FORCE)"
fi
psql_admin -c "CREATE DATABASE \"$target\""

# The dump was taken with --no-owner/--no-privileges, so it restores under
# whichever user runs this. Publications restore with it; PowerSync creates its
# own replication slot when it connects.
# shellcheck disable=SC2086
$PG_TOOLS pg_restore --no-owner --no-privileges --exit-on-error --dbname="$target_url" < "$dump"

# --no-privileges also dropped the PowerSync role's read access, and default
# privileges belong to the old database, so they are granted again here —
# without this, PowerSync cannot replicate the restored tables. Skipped where
# the role does not exist (a restore onto a server with no PowerSync).
# shellcheck disable=SC2086
$PG_TOOLS psql --quiet --no-psqlrc -v ON_ERROR_STOP=1 --dbname="$target_url" -c "
  DO \$\$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO powersync;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO powersync;
      -- ...except admin emails and their codes, which PowerSync never needs (migration 0005).
      IF to_regclass('public.staff_contacts') IS NOT NULL THEN
        REVOKE ALL ON staff_contacts, email_verifications FROM powersync;
      END IF;
    END IF;
  END \$\$;"

echo "$target"
