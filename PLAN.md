# Geneus Health — Backend Plan (`geneus-server`)

> The server side: the one Node process beside PostgreSQL and the PowerSync service. It
> owns what a sync engine must never decide — identity, authorization, validation,
> conflict policy, audit — and every write that reaches PostgreSQL passes through it.
> Derived from and subordinate to the root [../PLAN.md](../PLAN.md), the architecture
> in [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md), the frontend
> [../geneus-web/PLAN.md](../geneus-web/PLAN.md), and the source of truth
> [../PRODUCT.md](../PRODUCT.md). If anything conflicts, they win.

**Version:** 2.0 · **Owner:** Solo founder-builder · **Supersedes:** 1.1 (CouchDB)

> **Governing principle:** start with the **simplest architecture that preserves the core
> requirements**, and evolve it only when a **real, observed bottleneck** appears. A solo
> engineer must never have to *search* for where a bug lives — every symptom must have one
> obvious place to look (§5, the debug map). Anything that adds a moving part must pay for
> itself against that rule.

---

## 0. What this repo is (and is not)

- **Is:** the single service + infrastructure config that sits beside PostgreSQL:
  - PostgreSQL schema and migrations (numbered SQL, applied at boot)
  - Facility registration and device enrollment/revocation (the credential a device holds)
  - Sync tokens and the JWKS PowerSync verifies them with; server-time authority (`/time`)
  - **The upload path** — `POST /sync/upload`, where every device write is authorised,
    validated, conflict-checked and applied, or refused into the reconcile queue
  - The PowerSync service configuration and the Sync Streams (generated from the contract)
  - Backup and restore tooling
  - *Later, when their phase arrives:* roster signing sweep, referral routing + watchdog
    (Phase 2), government dashboards + DHIS2 export (Phase 3).
- **Is not:** where clinical records are *created*. Registration, visits, registers, search,
  handoff happen on the device against SQLite; PowerSync carries them here. **If you find
  yourself building a route that creates a clinical record on the client's word, stop** —
  clinical writes arrive through the one door and are re-authorised there.

## 1. Non-negotiable constraints (inherited)

1. **Hosting region is a deployment choice, not an architectural constraint** — host where
   it is cheapest and closest, and meet the operating country's data-protection duties (in
   Nigeria, NDPC registration). Nothing here may assume a region (PRD §14.2).
2. **PostgreSQL is the single source of truth.** A device's SQLite and PowerSync's bucket
   storage are replicas/derivations, rebuildable from it (root §2.2).
3. **Solo builder** — few, boring dependencies; one deploy; write decisions down.
4. **Honest, offline-tolerant behaviour** — anything cross-facility must degrade by
   queuing, never by blocking an offline facility.
5. **The client is never the final authority** — every upload is re-authorised from the
   server's own tables (ARCHITECTURE.md §1).

## 2. The architecture: production is three things

```
   PWA (SQLite) ──stream (JWT: facility_id)──▶ ┌───────────────────┐   logical    ┌──────────────┐
                                               │ PowerSync service  │◀─replication─│  PostgreSQL  │
                                               └───────────────────┘              │ source of    │
   PWA ──device credential──▶ ┌────────────────────────────────────┐  authorised  │ truth        │
                              │ ONE Node process (Fastify)          │───writes────▶│              │
                              │ /facilities /devices /sync/token    │              └──────────────┘
                              │ /sync/upload /.well-known/jwks.json │
                              └────────────────────────────────────┘
```

1. **PostgreSQL 17** — `wal_level=logical`; the `powersync` publication over the synced
   tables only; a `powersync` replication role; PowerSync's bucket storage in a second
   database on the same server.
2. **PowerSync service** (`journeyapps/powersync-service`, pinned in compose) — replicates
   the publication, partitions it by `facility_id`, streams each facility to its devices.
3. **One Node process** — Fastify, in-process sweeps when their phase comes. One codebase,
   one container, one log stream, one place to debug.

### 2.1 Deploy target — Docker Compose as the reference; production provider-agnostic

`docker-compose.yml` is the whole deployment and is what `npm run test:sync` proves.
Development runs the server on the host and PostgreSQL + PowerSync in compose; the full
stack (`--profile stack`) runs all three in containers, as a production host would.
Provider requirements and verified options (VM, Supabase/Neon/RDS/Cloud SQL/Azure/Fly,
Render behind a support request) are in ARCHITECTURE.md §11. Ordering on a fresh host:
PostgreSQL → migrations → PowerSync. TLS terminates in front of the two public services;
PostgreSQL is never public.

## 3. Stack (decided — keep it small)

| Concern | Choice | Why |
| --- | --- | --- |
| Language | **TypeScript (Node.js 24)** | Shares the Zod contract with `geneus-web`; Node runs the sources directly |
| HTTP framework | **Fastify** | Light, schema-first, pairs with Zod |
| Database | **PostgreSQL** | Relational, constrained, replicable; the source of truth |
| Database client | **`postgres`** (postgres.js) | One dependency, no dependencies; tagged-template parameters; transactions and savepoints; the schema stays SQL |
| Migrations | **numbered SQL files** applied at boot (`src/db/migrate.ts`) | Readable as SQL; the only state is `schema_migrations` |
| Sync engine | **PowerSync** (Sync Streams, edition 3) | Download, queue, retries, reconnects — bought, not built |
| Device credentials | **rows** (`devices` + hashed `device_credentials`) | Inspectable state; revocation is an UPDATE |
| Sync tokens | **EdDSA JWT via `node:crypto`**, JWKS endpoint | The project's existing Ed25519 key; no JWT library |
| Validation | **Zod** (from `geneus-shared`) | Same schema validates on the device and on upload |
| Authorization | the **shared permission matrix** over server-known staff | Device and server cannot disagree; the server's answer counts |
| Scheduling | **node-cron, in-process** (when sweeps arrive) | No separate worker |
| Deploy | **Docker Compose**; provider-agnostic production | Three containers, one file |

> Deliberately **no ORM, no message broker, no Redis, no second process in v1.** The
> idempotency ledger is a table; the reconcile queue is a table; the audit trail is a table
> with a trigger.

## 4. What the one process does

### 4.1 Facility registration and device enrollment
- `POST /facilities` (invite-gated, `facility_invites`, atomic claim) creates the facility,
  its first admin and the registering device in one transaction and returns the device's
  credential — shown once, hashed at rest, never a database credential.
- `POST /devices/codes` → `POST /devices`: an enrolled device with a `device:enroll` holder
  issues a 15-minute single-use code; the joining device spends it. The code decides the
  facility. `POST /devices/:id/revoke` de-enrols (optionally with a wipe request); the
  credential stops verifying at the device's next contact.

### 4.2 Sync tokens and JWKS
- `POST /sync/token` (device credential) mints a ≤ 1 h EdDSA JWT — `sub` = deviceId,
  `facility_id` claim — and records the contact on the device row. PowerSync verifies it
  via `GET /.well-known/jwks.json`. The facility a device syncs is decided here, never by
  the device.

### 4.3 The upload path (`POST /sync/upload`)
Per mutation, one transaction: ledger claim → table/op allowlist (no deletes;
`facility`/`device`/`sync_rejection` server-written) → payload facility/device ≡ credential
→ attributed staff active in that facility → server-known role/permission (+24 h freshness
for high-risk) → contract validation, immutable and server-owned fields → per-table conflict
policy → write under a savepoint. Refusals become `sync_rejections` + `reject` audit
events and are acknowledged. Full rules: ARCHITECTURE.md §7–§8; code: `src/sync/upload.ts`.

### 4.4 Sync Streams
`powersync/sync-config.yaml` is **generated** from the contract (`npm run sync:config`,
`src/sync/syncConfig.ts`): one facility-filtered `auto_subscribe` stream per synced table,
columns aliased to contract names. A test fails when the committed file is stale. Adding a
synced table = a migration (table + `ALTER PUBLICATION powersync ADD TABLE`) + a contract
type + regenerate.

### 4.5 Roster signing — *BE-M1, shape pre-decided*
A checkpointed sweep signs every `roster_shifts` row still missing a signature (Ed25519
over `staffId, facilityId, startsAt, endsAt`) and writes it back; the row syncs down and
devices verify offline. The device honours an unsigned shift (tamper-evidence, not an
access gate — a facility with no signal must still roster staff). `signature` is
server-owned: an upload that sets it is refused.

### 4.6 Referral routing + watchdog — *Phase 2, shape pre-decided*
Referrals are written on the device into the sender's facility and sync up. A polling
sweep copies the scoped inbound record into the receiving facility (a server-written row
in that facility's stream) and reconciles lifecycle; the not-yet-arrived watchdog flags
overdue ones back. Poll, don't stream; a stuck referral is diagnosed by one checkpoint row.

### 4.7 Reporting and government layer — *Phase 3*
SQL over the same PostgreSQL (views; a read replica when volume demands it). No second
store, no change-feed consumer: the source of truth is already relational.

## 5. The debug map (a closed list)

| Symptom | Where to look |
| --- | --- |
| Data wrong/missing on a device | The device's Sync Center (pending, last sync, errors) and reconcile queue; then PostgreSQL: is the row there? → sync gap vs refused write, immediately distinguishable (`sync_rejections`) |
| A device can't sync | `/health` (`postgres`, `powerSync`); the device row (`status`, `wipe_requested`, `last_seen_on`); the server log's `device credential refused` line; PowerSync's log |
| Registration, enrollment, tokens, uploads, refusals | The one server process's log — there is only one |
| Replication lag / PowerSync state | The PowerSync service log, `/probes/liveness`, `pg_replication_slots` |

Supporting rules that keep the map true:
- **One log stream**, structured (pino), request-scoped ids; refusals logged with
  `clientId/table/category`, never with clinical payloads or secrets.
- **`GET /health`** reports each dependency and `openRejections` so "is it working?" is
  one URL.
- Every deferred component must preserve the map when added.

## 6. Evolution ladder (pre-decided, trigger-gated)

| Real trigger | Evolution |
| --- | --- |
| BE-M1 | Roster signing sweep inside the same process (§4.5) |
| Phase 2 (referrals) starts | Referral sweep + watchdog inside the same process (§4.6) |
| Phase 3 (government reporting) starts | SQL views; a read replica if reporting load shows on the primary |
| Sweeps measurably degrade API latency | Split into a second process **from the same image** (`CMD api` / `CMD worker`) |
| A real facility's replica outgrows the cheap phone | Bound streams to active/recent records (a stream-definition change) |
| Managed PostgreSQL becomes the better trade | Move `POSTGRES_URL`; PowerSync and the server are unchanged (ARCHITECTURE.md §11) |
| **The first real patient record exists** | Schedule `scripts/backup.sh` and `scripts/restore-drill.sh` with off-host copies — the tooling exists and the drill has passed; the schedule is the trigger |

## 7. Repository structure

```
geneus-server/
  src/
    server.ts          # the ONE entrypoint — boots, migrates, listens
    app.ts             # the Fastify app (buildable without a port, for tests)
    routes/            # facilities, devices, sync (token, upload, jwks)
    auth/              # device credential auth, staff authorization, sync tokens
    devices/           # credentials (issue/verify), enrollment/revocation
    facilities/        # invites, registration
    sync/              # upload pipeline, ledger + rejections, sync-config generator
    audit/             # server-originated audit events
    db/                # postgres client, migration runner, records mapping, migrations/*.sql
    lib/               # signing, config (Zod-validated env)
  powersync/           # service.yaml (PS_* env), sync-config.yaml (generated)
  docker/postgres/     # first-start init: powersync role + storage database
  scripts/             # migrate, create-invite, generate-signing-key, generate-sync-config,
                       # backup.sh, restore.sh, restore-drill.sh
  tests/               # node:test against real PostgreSQL (scratch DB per file);
                       # powersync.integration.ts against the compose stack (test:sync)
  Dockerfile           # the one image; no build step, Node runs the sources
  docker-compose.yml   # the reference deployment (postgres, powersync, server)
```

## 8. Build order

### BE-M0 — Foundations ✅ (September 2026)
PostgreSQL schema and migrations; invites and facility registration; device credentials,
enrollment and revocation; sync tokens and JWKS; the upload path with the full
authorization pipeline and conflict policy; PowerSync service and generated Sync Streams;
the stack suite; backup/restore tooling with a passing drill; `/health`.

### BE-M1 — Trust anchor (supports the single-facility core)
- Roster signing sweep (§4.5) + the public key baked into the PWA build.
- Schedule backups + drill once the first real record exists (§6).
- *(Everything else root M1 needs from the server exists.)*

### BE-M3 — Referral layer (Phase 2)
- Referral sweep + lifecycle reconciliation + Not-Yet-Arrived watchdog (§4.6).

### BE-M4 — Government layer (Phase 3)
- Reporting SQL views; anonymised dashboards API; DHIS2 export adapter; export-on-exit.

### Cross-cutting (every milestone)
- TLS everywhere; compliance with the operating country's data-protection law (NDPA +
  NDPC registration in Nigeria); backups verified by drill; monitoring = `/health` + a
  simple uptime ping.

## 9. Key risks (backend-specific)

| Risk | Mitigation |
| --- | --- |
| Losing PostgreSQL = losing everything | `scripts/backup.sh` on a schedule, off-host copies, `restore-drill.sh` actually run; PowerSync storage is rebuildable |
| A deployment's country demands in-country hosting | The region is never baked in: PostgreSQL and the two containers move together; `POSTGRES_URL` and two public URLs change |
| A device reads or writes another facility's data | Facility-filtered streams on a server-minted claim; the upload path refuses foreign facility ids; composite foreign keys; the stack suite proves all three |
| A compromised client forges identity or role | Nothing in an upload is trusted; identity from the credential, role from the `staff` table; refusals queued and audited |
| Wrong roster/time signing breaks offline login safety | One keypair, mandatory in production, signing round-trip covered by tests |
| A bad mutation wedges a device's queue | Business refusals are acknowledged (200 + `sync_rejection`); only 401/400 stop the queue, and both mean the device should stop |
| Solo builder can't babysit the system | One process, one log, closed debug map (§5); `/health` names each dependency |

## 10. Immediate next steps

1. **Run the stack on the real target phone**: register a facility, sync, work offline for a
   day, reconnect — the first field proof of the new path.
2. **Roster signing sweep (BE-M1)** — the only server work the M1 pilot still depends on.
3. **Schedule backups and the drill** the day the first real record exists.
4. **Start whatever data-protection registration the launch country requires** — long lead time.
