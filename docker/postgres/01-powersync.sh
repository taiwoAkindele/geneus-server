#!/bin/bash
# Runs once, when the PostgreSQL volume is first created (docker-entrypoint-initdb.d).
# Creates what the PowerSync service needs that a migration cannot: a replication
# role (cluster-level) and its own bucket-storage database. The publication is a
# database object and lives in the migrations (0003), where the tables exist.
#
# For an existing database, run the same statements by hand — see README.md.
set -euo pipefail

POWERSYNC_DB_PASSWORD="${POWERSYNC_DB_PASSWORD:-devpassword}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE ROLE powersync WITH REPLICATION BYPASSRLS LOGIN PASSWORD '${POWERSYNC_DB_PASSWORD}';

  -- Read access to every table the app owns, present and future. The
  -- publication (migrations/0003) decides which of them actually replicate.
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO powersync;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO powersync;

  -- PowerSync keeps its bucket state in its own database, never in ours.
  CREATE DATABASE powersync_storage OWNER powersync;
SQL
