# Facility services and workforce: server delivery

Implemented 29 October 2026 against shared commit
`7194024f32efb67efac46f547987b38f02f9641c`: facility contract **1**, schema **4**,
policy **10**. Canonical shapes and rules remain in
[shared/FACILITY-CONTRACT.md](shared/FACILITY-CONTRACT.md).

This delivers the server foundation for PHC and hospital organization, services,
professional authority, staffing, coverage, booking allocation and work ownership.
The web interfaces still need to consume it. Existing facilities are not
automatically switched to clinical scope enforcement.

## Delivered behavior

| Area | Server behavior |
| --- | --- |
| Organization | Reviewed departments/units, hierarchy, stable legacy aliases, active ancestor checks and revision conflicts. |
| Places | Physical location trees, resource capacity and scoped references. Places do not imply clinical services. |
| Services | Service definitions and facility offerings, delivery method, required activities, intake policy and timezone. |
| Finance | Organization links on existing billing departments; billing IDs and monetary records remain intact. |
| Professional authority | Profiles, independently verified credentials, bounded capability decisions, delegation and real external verification. Administrative access alone grants no professional authority. |
| Proofs | Minimal signed snapshots, immutable history, current projections and refresh on the existing server timer. |
| Staffing | Versioned duties, temporary cover, effective intervals, locations, roster checks and collective clinical coverage. Planned coverage does not claim attendance. |
| Sessions | Actual dated occurrences, overnight intervals, participant/resource conflicts, capacity and causal intake events. |
| Appointments | Accepted allocations, practitioner/session/place checks, serialized capacity and atomic rescheduling. Refused proposals preserve the previous accepted booking. |
| Ownership | Exclusive claims and named offers/acceptance. Ownership stays with the outgoing worker until acceptance. |
| Clinical receipt | After explicit cutover, encounter entries, longitudinal events and amendments require accepted authority for their reported clinical actions. |
| Reconciliation | Durable source payloads, missing-dependency links, privacy classification and independent historical review. |

Bed occupancy, laboratory specimen/result release and pharmacy stock/dispensing are
downstream workflows. These workforce tables do not claim to implement them.

## Persistence and write boundary

Migrations `0015_facility_workforce.sql` and `0016_workforce_invariants.sql` run at
startup. They add typed tables for all 15 new document types, facility-scoped foreign
keys, immutable histories, configuration revision guards, causal-head uniqueness
and nested-reference checks. Legacy records retain their identities and values;
the migration invents no locations, services, qualifications or approved scopes.

Device mutations still enter through `POST /sync/upload`. A facility lock precedes
ledger claims, permission checks and business changes. This deliberately serializes
writes within a facility and introduces no second queue, ORM, worker or process.
Split this lock only if measured contention warrants it.

Configuration changes supply `expectedRevision`; immutable revisions supply the
exact `expectedPreviousId` (`null` for the root). In-batch dependency ordering
supports child-before-parent input and distinct `Unit.id` / `Unit.unitId` aliases.
Missing parents cannot activate children. Optional configuration can be cleared
without rewriting creation provenance.

Signing keys, private sessions, client versions, operator commands, migration
inventories and historical review authorizations stay outside the sync publication.
Inventories are immutable per policy revision. Exact governance/policy retries do
not duplicate approvals.

## Client negotiation

New clients include this metadata on token and upload requests:

```json
{ "facilityContractVersion": 1, "schemaVersion": 4, "policyVersion": 10 }
```

After draining their outbox, clients request `POST /sync/token` with
`pendingMutationCount: 0` as well. Uploads conservatively mark the device undrained
until this handshake. Every active device needs a recent compatible zero-pending
handshake before enforcement.

Responses advertise `facilityFeature`. Negotiated tokens carry the signed
`facility_contract: 1` claim. Generated Sync Streams expose new operational tables
and columns only to these tokens. Legacy tokens receive previous projections;
unknown types, role values and permission values are filtered out. Deploy the
generated `powersync/sync-config.yaml` with this server.

Incompatible protected configuration or post-enforcement writes receive HTTP
**409 `upgrade_required` before ledger claims**. Preserve the queue, upgrade and
resubmit. Business refusals remain HTTP 200 with `rejected` items and durable
reconciliation; malformed requests remain HTTP 400 and must not be acknowledged as
successful writes. Existing legacy tokens keep their restricted legacy projection
until expiry; clinical enforcement still applies at upload receipt.

## Restricted evidence API

`credential`, `capability_decision`, `reviewer_delegation`,
`clinical_authority_bootstrap` and `external_clinical_reviewer` never enter general
PowerSync downloads. Their refused payloads are also excluded. Owners and
authorized workforce readers instead use private online reads with independently
verified staff contacts, audited access and `Cache-Control: no-store`.

| Endpoint | Input/purpose |
| --- | --- |
| `POST /workforce/access/code` | `{ "staffId": "..." }`; send a one-use code to the established verified contact. Requires configured email delivery. |
| `POST /workforce/access/verify` | `{ "staffId": "...", "code": "123456" }`; return a device-bound opaque token and expiry. |
| `POST /workforce/access/end` | Revoke that private session. |
| `GET /workforce/evidence?type=credential&staffId=...` | Read an authorized restricted type; staff filter is optional. |
| `GET /workforce/rejections` | Read restricted refusals authorized for that staff member. |
| `GET /workforce/readiness?requestedBy=...` | Management readiness, blockers and inventory. |
| `POST /workforce/clinical-preview` | A complete canonical encounter entry or clinical event; return its digest without writing care. |
| `POST /workforce/rejections/:id/review` | `{ "reason": "..." }`; authorize exact historical source resubmission following independent review. |

All routes require the existing device credential. Private routes additionally use
`x-workforce-access: <token>`; readiness uses the existing staff-management check.
Private sessions last 15 minutes. Expiry, logout, contact replacement, inactive
staff, changed permissions and a different device are checked at read time.

Keep tokens in staff-session memory. The web implementation must isolate and
protect sensitive drafts, pending payloads and caches on shared devices, clear
access on staff switches, and keep these out of general local storage.

Offline clinical authorship retains the existing enrolled-device/attributed-staff
model. A signed scope proves accepted authority; it does not prove which human
typed an offline PIN. Restricted online reads add staff-contact verification.

## Clinical proofs and independent review

After cutover, clinical `actorContext` names the offering and accepted authority
snapshot, optionally an assignment revision. The server checks signature/trusted
key, subject/facility, performance time and receipt-time authority. Restrictions or
revocation can hold reported care for review; scheduling conflicts do not erase it.

Co-signatures use existing append-only `audit_event` uploads with metadata:

```json
{
  "kind": "workforce_attestation",
  "recordId": "<clinical source ID>",
  "payloadHash": "<64-character SHA-256 digest>",
  "offeringId": "<same offering as the source>",
  "action": "assess",
  "attestationKind": "supervisor",
  "authoritySnapshotId": "<witness's accepted snapshot ID>"
}
```

The independent witness is both audit author and actor and needs accepted personal
scope at acknowledgement and receipt. A `checker` for laboratory performance or
result recording needs `verify_result`. Another service's acknowledgement cannot
satisfy this source. The digest binds the full source and its original author.

The private preview route returns the digest online. Offline clients can reproduce
it: recursively sort object keys by JavaScript string comparison; omit undefined
object values; retain array order and literal strings; normalize only top-level
`createdOn`, `updatedOn`, `issuedOn`, `expiresOn`, `startsAt`, `endsAt`, `checkedOn`,
`occurredOn`, `effectiveOn` valid instant strings through `Date.toISOString()`;
serialize compact JSON and SHA-256 its UTF-8 bytes. Do not normalize date-looking
clinical note contents. The server implementation is `src/workforce/digests.ts`.

Historical review requires a verified, independent reviewer with accepted review
scope for every reported action. It cannot invent an original grant, conceal
source-history revocation at performance or backdate proof. Authorization binds
the exact source digest for 24 hours. Resubmit through `/sync/upload`; the review
endpoint never creates care or replaces authorship. Acceptance resolves the selected
refusal and records the review alongside the original worker.

## Operator setup and activation

Use the existing deployment environment, persistent production signing key and
configured email transport. `/.well-known/jwks.json` retains trusted historical
public keys as well as the active key. Routine signing-key rotation retains old
verification keys; compromise revocation is an explicit governance operation.
Proof refresh runs on the existing server timer.

The CLI accepts reviewed JSON files and prints no raw credential evidence or
private contacts. It exposes no public bootstrap/policy mutation endpoint:

```text
node scripts/workforce-setup.ts record approved-record.json
node scripts/workforce-setup.ts contact approved-contact.json
node scripts/workforce-setup.ts readiness facility.json
node scripts/workforce-setup.ts policy approved-policy.json
```

Supply deployment environment variables before execution; these commands do not
implicitly load `.env`.

| Command | JSON input |
| --- | --- |
| `record` | `{ "record": <canonical document>, "operator": "...", "expectedRevision": <optional current revision> }` |
| `contact` | `{ "facilityId": "...", "staffId": "...", "deviceId": "...", "email": "...", "operator": "...", "governanceReference": "..." }` |
| `readiness` | `{ "facilityId": "..." }`; output reports blocker counts. |
| `policy` | `{ "facilityId": "...", "deviceId": "...", "operator": "...", "timeZone": "Africa/Lagos", "policy": <canonical FacilityWorkforcePolicy> }` |

`record` permits only audited system-provenanced bootstrap/external-reviewer records
and external credential/capability decisions. Ordinary independent facility review
uses sync upload. Real identities, professional profiles where needed, accepted
heads and independent reviewer scope are required. There is no fabricated second
staff account, automatic administrator qualification or self-approval fallback.

1. Deploy the shared pointer, server, migrations and sync configuration together.
   Confirm persistent keys, email delivery and the existing backup process.
2. Review legacy IDs/classifications; configure real places/services and link
   financial departments. Preserve historical identities and monetary records.
3. Establish authorized clinical governance, profiles, evidence and independent
   approvals. Establish private contacts using the verified-contact flow or audited
   operator command.
4. Upgrade all active devices, drain outboxes and record zero-pending handshakes.
   Resolve held clinical/authority writes and publish valid coverage.
5. Inspect readiness. Absent policy or `preparation` retains legacy clinical
   behavior. Activate the next exact policy revision with `mode: enforced`,
   versions 1/4/10, explicit current/future `effectiveOn`, timezone and governance
   reference. Incomplete readiness is refused.
6. Monitor proofs, refusals, bookings and capacity. An explicit next `preparation`
   policy revision is an audited fallback; it does not delete clinical history or
   reverse database migrations. Inventory history remains append-only.

## Verification

Checks use disposable PostgreSQL 17 databases and pinned PowerSync 1.26.0 with
synthetic facilities and separate test storage:

Verified outcome: **401 standard tests and 7 real replication tests passed**, with
no failures or skips. TypeScript checking and Git whitespace checks passed. The
isolated test containers were removed after verification; no live facility policy
was activated.

- `tsc --noEmit`.
- `node --test --test-concurrency=4` with an explicit disposable `POSTGRES_URL`.
- `node --test tests/powersync.integration.ts` with explicit disposable database,
  `GENEUS_URL` and PowerSync public/internal/stream URLs.

Coverage includes legacy upgrades, migration reruns, SQL constraints, scoped
references, aliases, dependency ordering, competing revisions/bookings, pooled
capacity, rescheduling, overnight sessions, handover, evidence privacy/expiry,
external verification, PIN protection, co-signatures, historical review and actual
modern/legacy replication isolation. Browser/device checks and real pilot activation
remain part of the web rollout.
