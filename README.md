# geneus-server

The one Node process (Fastify) beside PostgreSQL and the PowerSync service. It owns
what synchronisation must never decide for itself: facility registration, device
enrollment and credentials, the server clock, and authorising every mutation a device
uploads before it reaches PostgreSQL. Clinical reads and writes happen on the device
against SQLite; PowerSync moves them. Read [PLAN.md](PLAN.md) and
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) before changing anything.

## Local development

```
npm install
npm run db:up        # PostgreSQL 17 in Docker on :5433 (wal_level=logical)
npm run dev          # the server on :8080, watching sources; migrates at boot
npm run sync:up      # the PowerSync service on :8090 (needs the server up for its JWKS)
```

`docker-compose.yml` supplies PostgreSQL and PowerSync; `.env.example` lists every
variable with its local default. There is no manual database setup: the first start of
the PostgreSQL volume runs `docker/postgres/01-powersync.sh` (the `powersync` replication
role and its bucket-storage database), and the server applies pending migrations from
`src/db/migrations/` at every boot (`npm run db:migrate` does the same without starting
the process). Migration `0003` creates the `powersync` publication over the synced
tables only.

> **Existing database (created before Phase D)?** Run the statements in
> `docker/postgres/01-powersync.sh` once by hand, then `npm run db:migrate`.

## PowerSync

The PowerSync service (`journeyapps/powersync-service`, pinned in `docker-compose.yml`)
replicates the tables in the `powersync` publication into its own bucket storage
(`powersync_storage`, same PostgreSQL server, separate database) and streams them to
devices.

- **`powersync/service.yaml`** — the service configuration; secrets and addresses come
  from `PS_*` environment variables set by compose.
- **`powersync/sync-config.yaml`** — the Sync Streams: one `auto_subscribe` stream per
  synced table, every contract column aliased to its contract name, filtered by
  `facility_id = auth.parameter('facility_id')` — the claim geneus-server puts in the
  device's token. **Generated from the shared contract** by `npm run sync:config`; the
  test suite fails if the committed file is stale.
- Devices authenticate with the token from `POST /sync/token`, verified against this
  server's `/.well-known/jwks.json`.

What arrives on a device (PowerSync's wire types, for the client's mapping): booleans as
`1`/`0`, `numeric` as strings, `text[]` and `jsonb` as JSON text, timestamps as
`2026-09-12T15:45:33.570000Z`, absent columns as `null`.

## Tests

```
npm test             # against the PostgreSQL from db:up
npm run test:sync    # the stack: server + PowerSync + PostgreSQL over real HTTP
```

`test:sync` needs `npm run sync:up`; it starts the server itself if :8080 is not
already answering (or targets `GENEUS_URL`), registers two scratch facilities in the
development database, and proves through PowerSync's own stream that facility A's device
receives only facility A's rows, that an upload reaches the stream, that a forged facility
is refused and the refusal syncs back down, and that a token signed by another key is
refused. CI runs it against the compose services.

Suites that touch persistence run against real PostgreSQL, never a mock: each test file
creates its own database, migrates it, and drops it afterwards, so files run in
parallel. The contract's own suites (`shared/tests`) run as part of the same command.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | PostgreSQL reachability, signing-key source and fingerprint, schema version |
| `GET /time` | Ed25519-signed server clock — the anchor of the 7-day offline window |
| `GET /invites/:token` | Check a facility invite before the admin fills anything in |
| `POST /facilities` | Register a facility, its first admin, and enrol the registering device (returns the device credential, once) |
| `POST /devices/codes` | *(device credential)* An enrolled device asks for a 15-minute, single-use enrollment code; `issuedBy` must hold `device:enroll` |
| `POST /devices` | The joining device spends the code and receives its own credential; the code decides the facility |
| `POST /devices/:id/revoke` | *(device credential)* De-enrol a device of the caller's facility; `revokedBy` must hold `device:revoke`; optional wipe |
| `GET /.well-known/jwks.json` | The Ed25519 public key as a JWK — PowerSync's `jwks_uri` |
| `POST /sync/token` | *(device credential)* A ≤1-hour EdDSA JWT: `sub` = device, `facility_id` claim drives the Sync Streams |
| `POST /sync/upload` | *(device credential)* The PowerSync connector's write-back; every mutation authorised server-side (below) |

Every shape is in the shared contract (`shared/src/api.ts`). Device-facing routes take
`Authorization: Bearer <deviceId>.<secret>`; a refused credential is a bare 401 and the
reason (wrong secret, revoked, wipe requested) goes to the log.

### What `/sync/upload` enforces

Per mutation, in one PostgreSQL transaction (`src/sync/upload.ts`):

1. **Ledger** — `(device, clientId)` claimed first; a retry is acknowledged as a duplicate and applies nothing.
2. **Table and operation** — only contract types; `facility`, `device` and `sync_rejection` are server-written; deletes are never accepted.
3. **Identity** — `facilityId` and `deviceId` in the payload must equal the *authenticated* device's; the client never chooses them.
4. **Attribution** — `createdBy` (put) / `updatedBy` (patch) must be an **active** member of staff of that facility.
5. **Permission** — from the server's `staff` row and the shared matrix; high-risk actions (`staff:*`, `device:*`) must arrive within 24 h of being performed.
6. **Contract** — Zod validation of the record (put) or the merged record (patch); `id, facilityId, createdBy, createdOn, deviceId` cannot move; `roster_shift.signature` is server-owned.
7. **Conflict policy** — append-only tables refuse patches; register definitions are immutable per version; patients and other clinical tables merge changed columns and queue a same-column race as a `conflict` with both values; `staff`/`roster_shift`/`unit` let the later change win and audit it.

A refusal becomes a `sync_rejection` row (synced back to the facility) and a `reject`
audit event; the mutation is acknowledged so the queue behind it keeps moving. Only an
unenrolled device (401) or a request our own client could never produce (400) is an HTTP
error.

What the server verifies, honestly: the **device**, its **facility**, that the attributed
staff member is an **active member** with a **role** that grants the action. It cannot
verify which human typed the offline PIN — attribution rests on the device's shift session
(root PLAN §4.3a).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` · `npm start` | The server, watching sources · plain |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | The suite, against the PostgreSQL from `db:up` |
| `npm run db:up` · `db:down` | Local PostgreSQL in Docker |
| `npm run db:migrate` | Apply pending migrations and exit |
| `npm run sync:up` · `sync:down` | The PowerSync service in Docker (with PostgreSQL) |
| `npm run sync:config` | Regenerate `powersync/sync-config.yaml` from the contract |
| `npm run test:sync` | The stack integration suite (needs the compose services) |
| `npm run invite -- "<label>" [days]` | Mint a single-use facility registration code |
| `node scripts/generate-signing-key.ts` | Mint the Ed25519 signing keypair (once per environment) |
| `scripts/backup.sh [dir]` | `pg_dump` of the source of truth (custom format), prunes by `RETENTION_DAYS` |
| `scripts/restore.sh <dump> [db] [--replace]` | Restore into a new database (default) or replace the live one |
| `scripts/restore-drill.sh` | Backup → restore into a scratch database → compare every table's row count → drop |

## Configuration

| Variable | Meaning |
| --- | --- |
| `POSTGRES_URL` | The source of truth. Local default points at `db:up`. |
| `POWERSYNC_PUBLIC_URL` | Where **devices** connect PowerSync to; handed out at enrollment, so never an internal address. |
| `POWERSYNC_DB_PASSWORD` | Password of the `powersync` PostgreSQL role (compose only). |
| `POWERSYNC_JWKS_URI` | Where the PowerSync *container* fetches this server's JWKS (compose only). |
| `POWERSYNC_INTERNAL_URL` | Where this process reaches PowerSync for `/health`'s probe; defaults to the public URL. |
| `POWERSYNC_JWT_AUDIENCE` | The `aud` claim of sync tokens (default `powersync`); the PowerSync service is configured to expect it. |
| `SYNC_TOKEN_TTL_SECONDS` | Sync token lifetime (default 3600; PowerSync caps at 86400). |
| `APP_ORIGINS` | Comma-separated origins allowed to call this server. |
| `PORT` | Listening port. |
| `SIGNING_PRIVATE_KEY` | Ed25519 private key (PKCS#8, base64). Optional in development (an ephemeral key is minted at boot); **required in production** — the server refuses to start without it, because an ephemeral key invalidates every signature at the next restart. |
| `NODE_ENV` | `production` switches to JSON logs and enforces the above. |

## Deployment

`docker-compose.yml` is the reference deployment: PostgreSQL 17, the PowerSync service,
and this server's image. Production is provider-agnostic — anything that runs two
containers beside a PostgreSQL with logical replication; verified options and provider
caveats are in [ARCHITECTURE.md §11](../docs/ARCHITECTURE.md).

```
# full stack, as a production host runs it
cp .env.example .env    # then set SIGNING_PRIVATE_KEY (generate-signing-key.ts),
                        # POWERSYNC_JWKS_URI=http://server:8080/.well-known/jwks.json,
                        # the public URLs devices will use, and real passwords
docker compose --profile stack up -d
curl -s http://127.0.0.1:8081/health
```

Ordering on a fresh host: PostgreSQL → the schema (the server migrates at boot; or
`npm run db:migrate`) → PowerSync, which needs the `powersync` publication from migration
0003 before it can replicate. Put TLS in front of the server and PowerSync; PostgreSQL is
never public. The server refuses to start in production without `SIGNING_PRIVATE_KEY`.

## Backup and restore

PostgreSQL is the only store to back up; PowerSync's bucket storage is rebuilt by
re-replication and devices are replicas. `scripts/backup.sh` dumps it; run it from cron
and copy dumps off the host. `scripts/restore-drill.sh` proves a dump restores with the
same row counts — schedule it, and treat a backup as verified only once it has passed.
Both scripts take `POSTGRES_URL` and, to use the compose container's tools,
`PG_TOOLS="docker compose exec -T postgres"` (with the URL as seen from inside the
container, e.g. `postgres://geneus:devpassword@localhost:5432/geneus`). Recovery:
`scripts/restore.sh <dump> geneus --replace`, start the server, restart PowerSync.
