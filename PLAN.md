# Geneus Health — Backend Plan (`geneus-server`)

> The server side. Deliberately **thin**: in a PouchDB↔CouchDB architecture the PWA
> replicates *directly* with CouchDB, so this repo is **not** where clinical CRUD lives.
> It exists only for what CouchDB can't do alone. Derived from and subordinate to the root
> [../PLAN.md](../PLAN.md), the frontend [../geneus-web/PLAN.md](../geneus-web/PLAN.md),
> and the source of truth [../PRODUCT.md](../PRODUCT.md). If anything conflicts, they win.

**Version:** 1.1 (Draft) · **Owner:** Solo founder-builder

> **Status — migration to PostgreSQL + PowerSync in progress.** The decisions below that
> name CouchDB as the store, `_users`/`_security` as device credentials, or
> `validate_doc_update` as the guard describe the *previous* architecture and are being
> replaced phase by phase. What is already true: PostgreSQL is the source of truth
> (`src/db/migrations/`), device credentials are rows (`devices`, `device_credentials`),
> facility registration runs in one PostgreSQL transaction, and the server authorises
> uploaded mutations itself (Phase C). This plan is rewritten in full in Phase F; the
> contract's [SCHEMA.md](shared/SCHEMA.md) already describes the target model.

> **Governing principle:** start with the **simplest architecture that preserves the core
> requirements**, and evolve it only when a **real, observed bottleneck** appears. A solo
> engineer must never have to *search* for where a bug lives — every symptom must have one
> obvious place to look (§5, the debug map). Anything that adds a moving part must pay for
> itself against that rule.

---

## 0. What this repo is (and is not)

- **Is:** the single service + infrastructure config that sits beside CouchDB:
  - Auth & roster signing (feeds the device's offline shift login)
  - Server-time authority (the trust anchor for the 7-day window)
  - Device enrollment / de-enrollment / remote wipe
  - CouchDB per-facility provisioning + design docs (validation functions)
  - *Later, when their phase arrives:* referral routing + watchdog (Phase 2), the
    CouchDB→Postgres projection + government dashboards + DHIS2 export (Phase 3).
- **Is not:** the clinical write path. Registration, visits, registers, search, handoff —
  none of that calls `geneus-server`. The PWA does those against local PouchDB, which
  replicates with CouchDB. **If you find yourself building a CRUD endpoint for a clinical
  record, stop — that belongs in replication, not here.**

## 1. Non-negotiable constraints (inherited)

1. **Hosting region is a deployment choice, not an architectural constraint** — host where
   it is cheapest and closest, and meet the operating country's data-protection duties (in
   Nigeria, NDPC registration). Nothing here may assume a region (PRD §14.2).
2. **CouchDB is the single source of truth.** Anything derived (the future Postgres
   projection) is rebuildable by replay — losing it is never data loss (root §2.3).
   Corollary: derived stores can be **deferred** at zero cost until their phase is real.
3. **Solo builder** — few, boring dependencies; one deploy; write decisions down.
4. **Honest, offline-tolerant behaviour** — anything cross-facility must degrade by
   queuing, never by blocking an offline facility.

## 2. The MVP architecture: production is two things

```
                 ┌─────────────────────────────────────────────┐
   PWA replicas ─┤  CouchDB (per-facility DBs) — source of truth │
                 └──────────────────▲──────────────────────────┘
                                    │ provisioning, _users/_security,
                                    │ signed roster docs, (M3: referral sweeps)
                 ┌──────────────────┴──────────────────────────┐
   Admin/API ───▶│  ONE Node process (Fastify + in-process cron) │
                 │  roster signing · /time · enrollment          │
                 └─────────────────────────────────────────────┘
```

1. **CouchDB** — one instance (Docker) on a persistent disk, per-facility databases,
   automated snapshots + off-site backup. *(Honest note: there is no true managed-CouchDB
   offering in scope on any host; this is a self-hosted container either way, so backup
   and a **tested restore drill** are first-class BE-M0 deliverables, not ops later.)*
2. **One Node process** — Fastify API with node-cron sweeps in the same process. One
   codebase, one container, one log stream, one place to debug. No workers, no queue,
   no second datastore in v1.

Everything else in earlier drafts (change-feed consumer, Postgres, referral router,
separate watchdog worker) is **deferred to the evolution ladder (§6)** — each has a named
trigger and a pre-decided shape, so deferring is not forgetting.

### 2.1 Deploy target — Render

The MVP deploys to **Render** (`render.yaml`): CouchDB as a disk-backed web service, the
Node process as a Docker web service, both in **Frankfurt** — the closest region by network
path, since West African cables land in Europe. The platform supplies TLS, certificate
renewal and git-triggered deploys, which removes the reverse-proxy and VM-administration
work entirely. Both services sit on **starter** (512MB RAM, 0.5 CPU) — enough for a pilot,
and deliberately not oversized. CouchDB holds one database per facility, so that ceiling is
the likeliest thing to bite first; §6 names the trigger and the response.

**The region is not baked in, and that is deliberate.** If a deployment ever has to sit in
one country, keep the Node process on Render and move CouchDB to a VM there: the clinical
path is device → CouchDB, so that move alone relocates every patient record, and the server
is thin, sits off the clinical path, and reaches CouchDB only to provision. The change is
two environment variables — `COUCHDB_URL` and `COUCHDB_PUBLIC_URL` — not a redesign.

Three things Render does not solve, all still owned here. Its disk snapshots are explicitly
not a database backup (§8). A disk-backed service is stopped before its replacement starts,
so every CouchDB redeploy is downtime — tolerable only because devices queue offline by
design. And **CouchDB's configuration does not live on the disk**: only `/opt/couchdb/data`
is mounted, while `_node/_local/_config` writes land in `/opt/couchdb/etc`, so redeploying
CouchDB drops the CORS settings the PWA replicates through. `ensureCors` runs at every
server boot precisely so this self-heals, which makes the ordering a rule: **redeploy
CouchDB → restart `geneus-server`.** Skip it and the app stops syncing with a browser error
that nothing in the CouchDB log explains — the one symptom the debug map (§5) would
otherwise not place.

## 3. Stack (decided — keep it small)

| Concern | Choice | Why |
| --- | --- | --- |
| Language | **TypeScript (Node.js)** | Shares the Zod contract with `geneus-web`; one language across the stack |
| HTTP framework | **Fastify** | Light, schema-first, pairs with Zod |
| Operational store | **CouchDB** (Docker; region per deployment) | The sync target and source of truth |
| CouchDB client | **`nano`** (or direct HTTP) | Boring, official-style |
| Device credentials | **CouchDB `_users` + per-DB `_security`** | Built-in, and the auth state is *inspectable in Fauxton* — a sync failure is debugged by looking at two documents, not decoding tokens. Revocation = delete the user doc. |
| Validation | **Zod** (from `geneus-shared`) | Same schema validates API payloads and documents |
| Signing | **Ed25519** (node `crypto`) | One keypair signs rosters + the `/time` response; public key ships in the PWA build so devices verify fully offline |
| Scheduling | **node-cron, in-process** | Sweeps run inside the API process; no separate worker |
| Analytics store | **— deferred —** | Postgres enters at Phase 3 (§6); the facility's own dashboard is client-side by design (root plan), so nothing needs it before then |
| Deploy | **One container + CouchDB, on Render** | The whole production system is two things; the region, and how to move it, recorded in §2.1 |

> Deliberately **no message broker, no Redis, no Kafka, no Postgres, no second process in
> v1.** CouchDB's `_changes` is the queue when a queue is eventually needed; a cron sweep
> is the scheduler; replication is the offline outbox.

## 4. What the one process does

### 4.1 Auth & roster signing
- **Rosters are written on the device and signed by sweep.** An admin assigns shifts
  offline like any other document; replication carries them up; a checkpointed cron sweep
  signs every `roster_shift` still missing a valid signature (Ed25519, detached, over the
  canonicalized `staffId, facilityId, startsAt, endsAt`) and writes that signature back
  into the same document, from where devices replicate it down and verify **offline**.
  *There is no upload endpoint:* a facility with no signal must still be able to roster its
  staff, so roster assignment cannot depend on reaching the server.
- **A device honours a shift whether or not it is signed**; the admin screen shows unsigned
  ones as unverified. The signature is therefore **tamper-evidence, not an access gate** —
  anyone who can write to a device's own PouchDB can grant themselves a shift, and signing
  does not prevent that, it makes it visible at the next sync. Refusing unsigned shifts was
  rejected: it locks out any staff member added while a facility is dark, which is the
  7-day window the product exists to honour.
- Two consequences the implementation owns: the sweep writes a **new revision of a document
  the device also writes**, so signing must be conflict-safe and retried rather than
  one-shot; and re-assigning a shift replaces its signature, so the sweep re-signs instead
  of assuming a document is signed once and forever.
- **Staff PINs are owned by the device, not by this server.** A PIN is set and verified on
  the device that set it, never travels, and is never a document (SCHEMA.md §8). Offline
  login must work with no network while the contract keeps credentials out of the replica —
  a server-issued credential could satisfy at most one of those.
- **`GET /time`** returns a signed server timestamp. The PWA calls it opportunistically on
  any connectivity to reconcile clock skew and satisfy the **7-day sync-or-freeze** window
  (root §4.3). Login itself is **never** a server call.

### 4.1a Facility registration (the one bootstrap endpoint)

- A device cannot create its own facility: no database exists yet and it holds no
  credential. `POST /facilities` provisions the database, pushes the generated
  `validate_doc_update`, writes the facility + admin documents, and returns a sync
  credential scoped to that one database.
- **Gated by a single-use invite** (`geneus-invites` database, minted out of band with
  `npm run invite`). Provisioning creates infrastructure and hands out a credential, so
  it must never be open to whoever finds the URL. The invite is claimed by CouchDB
  revision check before provisioning, so two requests racing the same code cannot both win.
- Everything after registration — staff, rosters, patients, registers — is an ordinary
  document written on the device and carried up by replication. No endpoint.

**What a leaked device credential can and cannot do** (verified against CouchDB 3.4):

| | |
| --- | --- |
| Read/write every document in *its* facility | **yes** — this is what replication needs |
| Delete documents | **no** — the design doc rejects `_deleted`; records are retired by flag |
| Reach another facility's database | no (403) |
| Drop a database, create one, list all databases | no (401 — server-admin only) |
| Read `_users`, change its own roles, grant itself DB admin | no |

The residual risk is a full **read** of one facility's records from a stolen device, which
is inherent to offline-first replication: a device that must work for 7 days with no signal
has to hold a durable credential. Mitigations are de-enrollment (§4.2, not yet built),
TLS in transit, and a strict CSP so app-level XSS cannot read it. Note the credential
cannot be locked behind the staff PIN — background sync must run with nobody signed in
(root §4.3a). Roster signing does not narrow this path either: it is evidence, not
enforcement (§4.1), so de-enrollment and TLS carry the weight here.

### 4.2 Device enrollment & remote wipe
- **How a device asks:** an already-enrolled admin device issues a short-lived device
  code; the joining device posts it to **`POST /devices`**. Facility registration mints the
  admin's device credential through that same path — one credential **per device**, never
  one per facility, because revocation is only meaningful per device.
- Enroll → create a per-device CouchDB `_users` doc + add it to the facility DB's
  `_security` members, and write the `device_enrollment` document. The device is now a
  durable, syncing replica (root §4.3c).
- De-enroll → delete the `_users` doc (sync dies on next contact) + write a **wipe flag
  doc** the device acts on when it next connects.
- Un-enrolled devices get no durable credential: session-only, nothing persists.

### 4.3 CouchDB provisioning + design docs
- A `provision-facility` script: creates the per-facility DB, sets `_security`, pushes the
  design doc.
- **`validate_doc_update` generated from the Zod contract** (SCHEMA.md §6): known `type`,
  `facilityId` matches the DB, envelope fields present, stable keys immutable. Thin
  structural guard; rich validation stays in Zod on the write paths.

### 4.4 Referral routing + watchdog — *built at M3, shape pre-decided*
- **Referrals ride replication, not an API call.** The PWA writes the `referral` doc into
  its *own* facility DB; sync carries it up when there's signal — so "Alert Pending →
  Alert Sent" honesty and offline queuing come free from PouchDB, with no client outbox.
- Server-side, a **polling sweep** (in-process cron, ~30s) reads each facility DB's
  `_changes?since=<checkpoint>`, copies a scoped inbound referral doc into the receiving
  facility's DB, and reconciles lifecycle state (Sent → Seen → Arrived → Closed).
  **Poll, don't stream:** a sweep is restart-safe, has no connection management, and a
  stuck referral is diagnosed by reading one checkpoint doc. Continuous `_changes` feeds
  are an optimization with a named trigger (§6), not a starting point.
- The **Not-Yet-Arrived watchdog** is a second sweep over referral docs past their window,
  flagging them back to the sender (PRD §8's 100% target).

### 4.5 Analytics projection & government layer — *built at Phase 3, shape pre-decided*
- When government reporting becomes real: add Postgres + a change-feed consumer.
- Pre-decided shape (so future-you doesn't redesign): the consumer is a **dumb mirror** —
  one table `(doc_id, facility_id, type, winning_rev, deleted, in_conflict, body jsonb,
  seq)`, checkpoint committed **in the same transaction** as the upsert (idempotent,
  crash-safe), plus a dead-letter table so one poisoned doc never stalls a facility.
  All indicators (register totals, malaria positivity, rollups) are **SQL views over the
  mirror** — iterating an indicator is editing SQL, no replay. Rebuild-by-replay =
  truncate + reset checkpoints. JSONB fits the data-driven registers (SCHEMA.md §9.3).
- **Nothing is lost by deferring this:** CouchDB keeps every current document, so the
  mirror can be built and backfilled whenever Phase 3 starts.

## 5. The debug map (a closed list)

Any issue lives in exactly one of three places. If a symptom ever doesn't map cleanly,
that is an architecture smell to fix, not a debugging session to endure.

| Symptom | Where to look |
| --- | --- |
| Data wrong/missing on a device | The device's PouchDB vs CouchDB (Fauxton): is the doc in CouchDB? → sync gap vs bad write, immediately distinguishable |
| A device can't sync | CouchDB: its `_users` doc, the DB's `_security`, CouchDB's log |
| Roster, login trust, `/time`, enrollment, (M3) referral routing | The one server process's log — there is only one |

Supporting rules that keep the map true:
- **One log stream**, structured (pino), request-scoped ids; sweeps log start/end + checkpoint.
- **`GET /health`** reports each concern's last-known state (last roster signed, last sweep
  run + checkpoint per facility) so "is it working?" is one URL.
- Every deferred component must preserve the map when added (e.g. the Phase 3 consumer's
  dead-letter table makes "a doc didn't project" a *visible row*, not a silent skip).

## 6. Evolution ladder (pre-decided, trigger-gated)

Nothing on this ladder is built early. Each row names the **observed trigger** that
justifies it and the shape it takes — so evolving is executing a decision, not designing
under pressure.

| Real trigger | Evolution |
| --- | --- |
| Phase 2 (referrals) starts | Add the referral sweep + watchdog **inside the same process** (§4.4) |
| Phase 3 (government reporting) starts | Add Postgres + the mirror consumer (§4.5), initially still in the same process |
| Sweeps/consumer measurably degrade API latency | Split into a second process **from the same image** (`CMD api` / `CMD worker`) |
| Poll lag actually hurts a real workflow | Move that sweep from polling to a continuous `_changes` feed |
| Facility count makes per-DB sweeps slow | Switch discovery to the global `_db_updates` feed |
| CouchDB hosting becomes a real ops burden | Revisit managed options / a second replica — with pilot-scale facts in hand |
| Starter's 512MB is the *measured* bottleneck (memory pressure, slow view builds) | Move CouchDB to a small VM (§2.1) rather than up a Render tier — the next tier costs more than a whole VM, and the move is two environment variables |
| **The first real patient record exists** | Build the backup: a per-database document dump to object storage, plus a restore drill that is actually run. Dumps, not a hot standby — they are point-in-time, while a mirror replicates a bad write faithfully within seconds. A standby answers downtime, which is a separate and later question |

## 7. Repository structure

```
geneus-server/
  src/
    server.ts          # the ONE entrypoint — Fastify + in-process cron
    routes/            # auth (roster upload/signing), time, enrollment; referral (M3)
    sweeps/            # poll-based jobs (M3: referral router, watchdog)
    couch/             # nano client, provisioning, generated design docs
    lib/               # signing, config (Zod-validated env), logging
  scripts/             # create-invite, generate-signing-key, sync-design-docs; backup + restore drill when §6 triggers
  Dockerfile           # the one image; no build step, Node runs the sources
  render.yaml          # the deployment (§2.1)
  tests/               # signing/verify round-trip; provisioning; (M3) referral lifecycle
```

Local dev: docker-compose with CouchDB; tests that touch sync semantics run against
**real CouchDB in Docker**, never a mock of `_changes`.

## 8. Build order

### BE-M0 — Foundations
- Render blueprint: CouchDB on a persistent disk + the Node process; TLS from the platform.
- **Backup + restore drill — deferred; trigger: the first real patient record (§6).**
  Render takes automatic daily disk snapshots, and its own documentation warns against
  restoring a disk to recover a database — it can come back corrupt. That makes snapshots
  an acceptable safety net for synthetic data and *not* the backup. Deferring is a dated
  decision, not an oversight: while every record is synthetic, the cost of losing the
  database is an afternoon of reseeding.
- `provision-facility` script + generated `validate_doc_update` from the Zod contract.
- The one process deployed with `/health` and `/time` (signed) live.
- Ed25519 signing key minted (`scripts/generate-signing-key.ts`) into the platform secret
  store; the public half baked into the PWA build so devices verify offline.

### BE-M1 — Trust anchor (supports the single-facility core)
- Roster signing sweep (§4.1) + the signing public key baked into the PWA build, since a
  device that cannot verify offline gains nothing from a signature.
- `POST /devices` + admin-issued device codes; per-device enrollment / de-enrollment /
  wipe-flag via `_users` + `_security` (§4.2).
- *(This is everything root M1 needs from the server. M2 needs nothing new — the
  facility dashboard and monthly totals are client-side by design.)*

### BE-M3 — Referral layer (Phase 2)
- Referral sweep + lifecycle reconciliation + Not-Yet-Arrived watchdog, per §4.4.

### BE-M4 — Government layer (Phase 3)
- Postgres + mirror consumer + backfill by replay, per §4.5; anonymised dashboards API;
  DHIS2 export adapter; export-on-exit tooling (sourced from CouchDB, the truth).

### Cross-cutting (every milestone)
- TLS everywhere; compliance with the operating country's data-protection law (NDPA +
  NDPC registration in Nigeria); backups verified by drill; monitoring = `/health` + a
  simple uptime ping.

## 9. Key risks (backend-specific)

| Risk | Mitigation |
| --- | --- |
| Losing CouchDB = losing everything | Automated snapshots + off-site copy + **restore drill actually run** on a schedule; platform disk snapshots do not count as a database backup |
| A deployment's country demands in-country hosting | The region is never baked in: move CouchDB to a VM there and change `COUCHDB_URL` / `COUCHDB_PUBLIC_URL` (§2.1) |
| A device reads another facility's data | Per-facility DBs, `_security` scoping, generated `validate_doc_update`; de-enroll deletes the user doc |
| Wrong roster/time signing breaks offline login safety | One keypair, small surface, signing round-trip covered by standing tests; key in a secret store |
| Referral lost when a facility is offline | Referral rides replication (device-local write + sync) + printed note always travels + watchdog flag-back |
| Deferred pieces get rebuilt from scratch under pressure | The evolution ladder (§6) pre-decides each shape and trigger |
| Solo builder can't babysit the system | One process, one log, closed debug map (§5); sweeps are checkpointed and restart-safe |

## 10. Immediate next steps

1. **Deploy the Render blueprint** (`render.yaml`) — `/health` and signed `/time` live, then
   backups + restore drill. Start whatever data-protection registration the launch country
   requires in parallel — long lead time.
2. **Scaffold the one process**: Fastify + `geneus-shared` submodule + `/health` + signed
   `/time`; docker-compose for local CouchDB; CI.
3. **`provision-facility` + generated `validate_doc_update`** so bad/cross-facility writes
   are rejected at the DB level from day one.
4. **Roster signing + enrollment (BE-M1)** — the only server work the M1 pilot actually
   depends on.
