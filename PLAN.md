# Geneus Health — Backend Plan (`geneus-server`)

> The server side. Deliberately **thin**: in a PouchDB↔CouchDB architecture the PWA
> replicates *directly* with CouchDB, so this repo is **not** where clinical CRUD lives.
> It exists only for what CouchDB can't do alone. Derived from and subordinate to the root
> [../PLAN.md](../PLAN.md), the frontend [../geneus-web/PLAN.md](../geneus-web/PLAN.md),
> and the source of truth [../PRODUCT.md](../PRODUCT.md). If anything conflicts, they win.

**Version:** 1.1 (Draft) · **Owner:** Solo founder-builder

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

1. **Data residency = Nigeria** — everything hosts in Nigeria; registered with the NDPC
   (PRD §14.2).
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

1. **CouchDB** — one instance on a Nigerian VM (Docker), per-facility databases,
   automated snapshots + in-country off-site backup. *(Honest note: there is no true
   managed-CouchDB offering in Nigeria; this is a thin self-hosted VM, so backup and a
   **tested restore drill** are first-class BE-M0 deliverables, not ops later.)*
2. **One Node process** — Fastify API with node-cron sweeps in the same process. One
   codebase, one container, one log stream, one place to debug. No workers, no queue,
   no second datastore in v1.

Everything else in earlier drafts (change-feed consumer, Postgres, referral router,
separate watchdog worker) is **deferred to the evolution ladder (§6)** — each has a named
trigger and a pre-decided shape, so deferring is not forgetting.

## 3. Stack (decided — keep it small)

| Concern | Choice | Why |
| --- | --- | --- |
| Language | **TypeScript (Node.js)** | Shares the Zod contract with `geneus-web`; one language across the stack |
| HTTP framework | **Fastify** | Light, schema-first, pairs with Zod |
| Operational store | **CouchDB** (Nigerian VM, Docker) | The sync target and source of truth |
| CouchDB client | **`nano`** (or direct HTTP) | Boring, official-style |
| Device credentials | **CouchDB `_users` + per-DB `_security`** | Built-in, and the auth state is *inspectable in Fauxton* — a sync failure is debugged by looking at two documents, not decoding tokens. Revocation = delete the user doc. |
| Validation | **Zod** (from `geneus-shared`) | Same schema validates API payloads and documents |
| Signing | **Ed25519** (node `crypto`) | One keypair signs rosters + the `/time` response; public key ships in the PWA build so devices verify fully offline |
| Scheduling | **node-cron, in-process** | Sweeps run inside the API process; no separate worker |
| Analytics store | **— deferred —** | Postgres enters at Phase 3 (§6); the facility's own dashboard is client-side by design (root plan), so nothing needs it before then |
| Deploy | **One container + CouchDB, on a Nigerian VM** | The whole production system is two things |

> Deliberately **no message broker, no Redis, no Kafka, no Postgres, no second process in
> v1.** CouchDB's `_changes` is the queue when a queue is eventually needed; a cron sweep
> is the scheduler; replication is the offline outbox.

## 4. What the one process does

### 4.1 Auth & roster signing
- Facility admin uploads the roster → server validates (Zod) → **signs it (Ed25519,
  detached signature over canonicalized payload)** → writes the signed roster doc into the
  facility's CouchDB DB, from where devices replicate it down and verify **offline**.
- Issues/rotates staff credentials the same way (signed, replicated, verified locally).
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
(root §4.3a).

### 4.2 Device enrollment & remote wipe
- Enroll → create a per-device CouchDB `_users` doc + add it to the facility DB's
  `_security` members. The device is now a durable, syncing replica (root §4.3c).
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
| CouchDB VM becomes a real ops burden | Revisit managed options / a second replica — with pilot-scale facts in hand |

## 7. Repository structure

```
geneus-server/
  src/
    server.ts          # the ONE entrypoint — Fastify + in-process cron
    routes/            # auth (roster upload/signing), time, enrollment; referral (M3)
    sweeps/            # poll-based jobs (M3: referral router, watchdog)
    couch/             # nano client, provisioning, generated design docs
    lib/               # signing, config (Zod-validated env), logging
  scripts/             # provision-facility, backup + restore drill
  tests/               # signing/verify round-trip; provisioning; (M3) referral lifecycle
```

Local dev: docker-compose with CouchDB; tests that touch sync semantics run against
**real CouchDB in Docker**, never a mock of `_changes`.

## 8. Build order

### BE-M0 — Foundations
- Nigerian VM: CouchDB in Docker, TLS, **automated backup + a scripted, tested restore
  drill** (the source of truth must survive the VM).
- `provision-facility` script + generated `validate_doc_update` from the Zod contract.
- The one process deployed with `/health` and `/time` (signed) live.

### BE-M1 — Trust anchor (supports the single-facility core)
- Roster upload → validate → sign → replicated roster doc; credential issuance.
- Device enrollment / de-enrollment / wipe-flag via `_users` + `_security`.
- *(This is everything root M1 needs from the server. M2 needs nothing new — the
  facility dashboard and monthly totals are client-side by design.)*

### BE-M3 — Referral layer (Phase 2)
- Referral sweep + lifecycle reconciliation + Not-Yet-Arrived watchdog, per §4.4.

### BE-M4 — Government layer (Phase 3)
- Postgres + mirror consumer + backfill by replay, per §4.5; anonymised dashboards API;
  DHIS2 export adapter; export-on-exit tooling (sourced from CouchDB, the truth).

### Cross-cutting (every milestone)
- TLS everywhere; NDPA compliance + NDPC registration; backups verified by drill;
  monitoring = `/health` + a simple uptime ping.

## 9. Key risks (backend-specific)

| Risk | Mitigation |
| --- | --- |
| Losing CouchDB = losing everything | Automated snapshots + off-site (in-country) copy + **restore drill actually run** on a schedule |
| A device reads another facility's data | Per-facility DBs, `_security` scoping, generated `validate_doc_update`; de-enroll deletes the user doc |
| Wrong roster/time signing breaks offline login safety | One keypair, small surface, signing round-trip covered by standing tests; key in a secret store |
| Referral lost when a facility is offline | Referral rides replication (device-local write + sync) + printed note always travels + watchdog flag-back |
| Deferred pieces get rebuilt from scratch under pressure | The evolution ladder (§6) pre-decides each shape and trigger |
| Solo builder can't babysit the system | One process, one log, closed debug map (§5); sweeps are checkpointed and restart-safe |

## 10. Immediate next steps

1. **Provision the Nigerian VM**: CouchDB in Docker + backups + restore drill. Start NDPC
   registration in parallel (long lead time).
2. **Scaffold the one process**: Fastify + `geneus-shared` submodule + `/health` + signed
   `/time`; docker-compose for local CouchDB; CI.
3. **`provision-facility` + generated `validate_doc_update`** so bad/cross-facility writes
   are rejected at the DB level from day one.
4. **Roster signing + enrollment (BE-M1)** — the only server work the M1 pilot actually
   depends on.
