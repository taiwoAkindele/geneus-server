import { careWorkflowIssues, chargeOrderIssues, routeReferral } from '../clinical/careWorkflow.ts';
import { isDeepStrictEqual } from 'node:util';
import type { ZodType } from 'zod';
import {
  CLOSING_STEPS, closesEncounter, POST_CONSULTATION_STEPS,
  ENCOUNTER_STEP_VALUES,
  REPEATABLE_STEPS,
  HIGH_RISK_PERMISSIONS,
  IMMUTABLE_ENVELOPE_FIELDS,
  OFFLINE_AUTHORIZATION_POLICY,
  parseDocument,
  sameAppointmentTime,
  validateRegisterEntry,
  registerDefinitionIssues,
  paymentPermission,
  rolesFor,
  staffPermissions,
  PIN_SETUP_CODE_CLAIM_FIELDS,
  ROSTER_SIGNED_FIELDS,
  FACILITY_DOCUMENT_POLICY, RESTRICTED_FACILITY_DOCUMENT_TYPES,
  SCHEMA_BY_TYPE, type FacilityDependency,
  type AnyDocument,
  type Appointment,
  type ConflictingColumn,
  type DocType,
  type EncounterEntry,
  type Encounter,
  type Payment,
  type Permission,
  type RegisterDefinition,
  type PinSetupCode,
  type RejectionCategory,
  type Staff,
  type UploadMutation,
  type UploadRejection,
  type UploadRequest,
  type UploadResponse,
} from '#shared';
import {
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  isPostgresError,
  UNIQUE_VIOLATION,
  type Sql,
  type Tx,
} from '../db/client.ts';
import { findRecord, insertRecord, TABLE_FOR, toRow } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';
import { describeDenial, findStaffInFacility, staffDenial } from '../auth/staffAuthorization.ts';
import { keepsAdministrator } from '../staff/access.ts';
import { availableOnCharge } from '../billing/ledger.ts';
import { claimMutation, recordRejection } from './ledger.ts';
import { stockMovementIssue } from '../inventory/validation.ts';
import { validateWorkforceRecord, workforceType } from '../workforce/validation.ts';
import { refreshFacilityAuthority } from '../workforce/authority.ts';
import { clinicalAuthorityRefusal, historicalReviewValid, completeHistoricalReview, clinicalAttestationRefusal } from '../workforce/clinical.ts';
import { allocationRefusal, recordReservation } from '../workforce/allocations.ts';
import { assertWorkforceCompatibility, orderWorkforceMutations } from '../workforce/compatibility.ts';
import type { Signer } from '../lib/signing.ts';
import { validatePinCodeClaim } from '../workforce/pin.ts';
import { recordClientVersion } from '../workforce/readiness.ts';

/**
 * The server's side of every offline write (root §18). PowerSync delivers the
 * device's queued mutations; nothing in them is trusted. Per mutation, in one
 * PostgreSQL transaction:
 *
 *   ledger claim (retry ⇒ acknowledged, not re-applied)
 *   → table allowed, no deletes
 *   → facilityId / deviceId match the authenticated device
 *   → attributed staff is an active member of that facility
 *   → server-known role grants the permission; high-risk actions are fresh
 *   → contract validation; immutable and server-owned fields untouched
 *   → conflict policy for the table (SCHEMA.md §7)
 *   → write
 *
 * A refusal is not an HTTP error: it becomes a `sync_rejection` (synced back to
 * the facility for reconciliation) and an audit event, and the mutation is
 * acknowledged so the queue behind it keeps moving. A 4xx would wedge every
 * later mutation behind one bad one.
 */

/** Written by the server; a device may never insert them. */
const SERVER_WRITTEN: readonly DocType[] = ['facility', 'device', 'sync_rejection', 'pin_setup_code', 'incoming_transfer', 'inbound_referral'];
/** Server-written, but a device may patch the few columns that record what it did with them. */
const DEVICE_MARKABLE: readonly DocType[] = ['sync_rejection', 'pin_setup_code', 'inbound_referral'];
/**
 * Never patched: the record is the event. An encounter is closed by a step, not
 * an edit (SCHEMA.md §13); a payment is cancelled by a reversal (SCHEMA.md §14).
 */
const APPEND_ONLY: readonly DocType[] = [
  'register_entry',
  'stock_movement',
  'audit_event',
  'encounter',
  'encounter_entry',
  'clinical_event',
  'charge',
  'payment',
  'billing_adjustment',
  'patient_identity_event',
];
/** Never patched: a change is a new version (SCHEMA.md §11.2). */
const IMMUTABLE_PER_VERSION: readonly DocType[] = ['register_definition'];
/** Administrative: a same-column race applies the later upload, audited (SCHEMA.md §7). */
const ADMIN_LAST_WRITE_WINS: readonly DocType[] = ['staff', 'roster_shift', 'unit', 'sync_rejection'];

/** Columns only the server may set. */
const SERVER_OWNED_COLUMNS: Partial<Record<DocType, readonly string[]>> = {
  roster_shift: ['signature'],
  staff: ['personId'],
  fee_item: ['priceVersion'],
  payment: ['incomingTransferId'],
  patient_identity_event: ['revision'],
};

/** The only columns a device may patch on a rejection: marking it resolved. */
const RESOLUTION_COLUMNS = new Set(['resolvedOn', 'resolvedBy', 'resolution']);

/** Envelope bookkeeping a patch carries alongside its real changes. */
const PATCH_METADATA = new Set(['id', 'updatedBy', 'updatedOn']);

const PUT_PERMISSION: Partial<Record<DocType, Permission>> = {
  patient: 'patient:create',
  patient_identity_event: 'patient_identity:review',
  visit: 'visit:create',
  encounter: 'encounter:record',
  encounter_entry: 'encounter:record',
  clinical_event: 'encounter:record',
  handoff: 'handoff:create',
  appointment: 'appointment:create',
  register_definition: 'register_definition:publish',
  register_entry: 'register_entry:create',
  referral: 'referral:create',
  stock_item: 'stock_item:manage',
  stock_movement: 'stock_movement:create',
  unit: 'unit:manage',
  staff: 'staff:manage',
  roster_shift: 'roster:assign',
  fee_item: 'fee_item:manage',
  charge: 'charge:create',
  billing_adjustment: 'payment:waive',
  billing_department: 'fee_item:manage',
  // A payment's permission depends on what it does — see paymentPermission.
};

/**
 * What a patch needs, decided from the columns it changes. Tables without an
 * update permission in the contract (visits) cannot be patched
 * yet: nothing in the app updates them, and a permission is added when
 * something does — never inferred.
 */
const patchPermissions = (table: DocType, changes: Record<string, unknown>): Permission[] | undefined => {
  const columns = Object.keys(changes).filter((column) => !PATCH_METADATA.has(column));
  switch (table) {
    case 'patient':
      return ['patient:update'];
    case 'appointment':
      return columns.every((column) => ['status', 'scheduledFor', 'attendance', 'activity', 'allocation', 'schemaVersion'].includes(column)) ? ['appointment:update'] : undefined;
    case 'handoff':
      return columns.every((column) => column === 'status') ? ['handoff:update'] : undefined;
    case 'referral':
      return columns.every((column) => ['status','seenOn','arrivedOn','closedOn','notYetArrivedFlagged'].includes(column)) ? ['referral:update'] : undefined;
    case 'inbound_referral':
      return columns.every((column) => ['status','localPatientId','localEncounterId','arrivedOn','closedOn'].includes(column)) ? ['referral:update'] : undefined;
    case 'stock_item':
      return ['stock_item:manage'];
    case 'fee_item':
    case 'billing_department':
      return ['fee_item:manage'];
    case 'unit':
      return ['unit:manage'];
    case 'staff':
      return [
        ...new Set(
          columns.map((column): Permission => {
            if (['permission', 'role', 'additionalRoles', 'additionalPermissions', 'loginAccess'].includes(column)) return 'staff:permission';
            if (column === 'active' && changes.active === false) return 'staff:deactivate';
            return 'staff:manage';
          }),
        ),
      ];
    case 'roster_shift':
      return columns.every((column) => column === 'extendedUntil') ? ['roster:extend'] : ['roster:assign'];
    case 'sync_rejection':
      return columns.every((column) => RESOLUTION_COLUMNS.has(column)) ? ['sync_rejection:resolve'] : undefined;
    case 'pin_setup_code':
      return columns.every((column) => (PIN_SETUP_CODE_CLAIM_FIELDS as readonly string[]).includes(column))
        ? ['pin_setup_code:claim']
        : undefined;
    default:
      return undefined;
  }
};

type Refusal = { category: RejectionCategory; reason: string; conflicts?: ConflictingColumn[]; dependencies?: FacilityDependency[] };
const refuse = (category: RejectionCategory, reason: string): Refusal => ({ category, reason });

type Outcome = 'applied' | 'duplicate' | 'rejected' | 'applied_with_conflicts';

type MutationResult = { outcome: Outcome; refusal?: Refusal };

const isPostgresRefusal = (cause: unknown): Refusal | undefined => {
  if (isPostgresError(cause, UNIQUE_VIOLATION)) {
    return refuse('conflict', 'a record with this identity already exists — created on another device first');
  }
  if (isPostgresError(cause, FOREIGN_KEY_VIOLATION) || isPostgresError(cause, CHECK_VIOLATION)) {
    return refuse('validation', `PostgreSQL refused the write: ${(cause as { constraint_name?: string }).constraint_name ?? 'constraint'}`);
  }
  return undefined;
};

/** Attempts a write; a constraint failure becomes a refusal instead of an aborted transaction. */
const attempt = async (tx: Tx, write: (sp: Tx) => Promise<void>): Promise<Refusal | undefined> => {
  try {
    await tx.savepoint(write);
    return undefined;
  } catch (cause) {
    const refusal = isPostgresRefusal(cause);
    if (refusal) return refusal;
    throw cause;
  }
};

/**
 * A high-risk action must reach the server soon after it was performed. The
 * device already refuses one made more than 24 hours after its last contact;
 * the server cannot reconstruct that history, so it enforces the other edge:
 * the action must arrive within the same window of being made. Together they
 * bound how stale the authority behind a staff or device change can be.
 */
const isStale = (permissions: Permission[], performedOn: string | undefined, uploadedAt: number): boolean => {
  if (!permissions.some((permission) => HIGH_RISK_PERMISSIONS.includes(permission))) return false;
  const performed = performedOn ? Date.parse(performedOn) : Number.NaN;
  return Number.isNaN(performed) || performed > uploadedAt + 300_000 || uploadedAt - performed > OFFLINE_AUTHORIZATION_POLICY.highRiskMs;
};

type Context = { tx: Tx; identity: DeviceIdentity; uploadedAt: number };

/**
 * Claiming a PIN setup code is granted by no role (SCHEMA.md §10): it belongs
 * to the one person the code was issued for, who has no PIN yet to sign in
 * with. By the time this arrives the PIN is already set on that device, so a
 * refusal here is a record for the facility to look at, not a way to undo it.
 */
const claimRefusal = (code: PinSetupCode, updatedBy: string, changes: Record<string, unknown>): Refusal | undefined => {
  if (updatedBy !== code.staffId) return refuse('authorization', 'a PIN setup code can only be used by the person it was issued for');
  if (code.usedOn) return refuse('conflict', 'this PIN setup code was already used on another device');
  const usedOn = typeof changes.usedOn === 'string' ? Date.parse(changes.usedOn) : Number.NaN;
  if (Number.isNaN(usedOn)) return refuse('validation', 'a used PIN setup code must say when it was used');
  if (code.revokedOn && usedOn > Date.parse(code.revokedOn)) return refuse('validation', 'this PIN setup code had been replaced by a newer one');
  if (usedOn > Date.parse(code.expiresOn)) return refuse('validation', 'this PIN setup code had expired');
  return undefined;
};

/**
 * Whether this device's own registration of `patientId` was refused and is
 * still unresolved — most likely an offline-minted Patient ID another device
 * took first (PRD §10.1). The id on the server then names someone else, so
 * anything this device recorded against it is held in the reconcile queue
 * with the patient rather than attached to the wrong person (SCHEMA.md §7).
 */
const heldForPatient = async (tx: Tx, identity: DeviceIdentity, patientId: string): Promise<Refusal | undefined> => {
  const [held] = await tx`
    SELECT 1 FROM sync_rejections
    WHERE facility_id = ${identity.facilityId} AND device_id = ${identity.deviceId}
      AND entity_type = 'patient' AND entity_id = ${patientId} AND operation = 'put'
      AND resolved_on IS NULL
    LIMIT 1`;
  return held
    ? refuse('conflict', `held: this device's registration of patient ${patientId} was refused and is waiting in the reconcile queue`)
    : undefined;
};

/** Consultation closure preserves fulfillment/review and amendments, while refusing new assessments. */
const closedEncounterRefusal = async (tx: Tx, entry: EncounterEntry): Promise<Refusal | undefined> => {
  if ((POST_CONSULTATION_STEPS as readonly string[]).includes(entry.step)) return undefined;
  const closings = await tx<{ step: string; values: Record<string, unknown> }[]>`
    SELECT step, "values" FROM encounter_entries
    WHERE facility_id = ${entry.facilityId} AND encounter_id = ${entry.encounterId}
      AND step = ANY(${[...CLOSING_STEPS]})
    `;
  const closing = closings.find(closesEncounter);
  return closing
    ? refuse('conflict', `encounter ${entry.encounterId} was already closed (${closing.step}); clinical changes require an amendment`)
    : undefined;
};

const allocationsByCharge = (payment: Payment): Record<string, number> =>
  Object.fromEntries(payment.allocations.map((allocation) => [allocation.chargeId, allocation.amountMinor]));

/**
 * What a payment's shape cannot say about other records (SCHEMA.md §14): each
 * allocation names a charge of this patient, in this currency, and a reversal
 * cancels a payment — once — by repeating it exactly. Paying a charge more than
 * it owes is deliberately *not* refused: two cashiers offline can both take
 * money for the same fee, and money that changed hands must be on record. The
 * overpayment shows in the balances for a supervisor to settle (PRD §9.13.7).
 */
const paymentRefusal = async (tx: Tx, payment: Payment): Promise<Refusal | undefined> => {
  const chargeIds = payment.allocations.map((allocation) => allocation.chargeId);
  const charges = await tx<{ id: string; patient_id: string; currency: string }[]>`
    SELECT id, patient_id, currency FROM charges
    WHERE facility_id = ${payment.facilityId} AND id = ANY(${chargeIds}) ORDER BY id FOR UPDATE`;
  for (const chargeId of chargeIds) {
    const charge = charges.find((candidate) => candidate.id === chargeId);
    if (!charge) return refuse('validation', `charge ${chargeId} does not exist in this facility`);
    if (charge.patient_id !== payment.patientId) return refuse('validation', `charge ${chargeId} belongs to another patient`);
    if (charge.currency !== payment.currency) {
      return refuse('validation', `charge ${chargeId} is in ${charge.currency}, not ${payment.currency}`);
    }
  }

  if (!payment.reverses) return undefined;
  const original = await findRecord<Payment>(tx, 'payment', payment.reverses);
  if (!original || original.facilityId !== payment.facilityId) {
    return refuse('validation', `no payment ${payment.reverses} exists to reverse`);
  }
  if (original.reverses) return refuse('validation', `payment ${original.id} is itself a reversal and cannot be reversed`);
  const [reversed] = await tx`
    SELECT 1 FROM payments WHERE facility_id = ${payment.facilityId} AND reverses = ${original.id} LIMIT 1`;
  if (reversed) return refuse('conflict', `payment ${original.id} was already reversed`);
  const repeatsOriginal =
    original.patientId === payment.patientId &&
    original.amountMinor === payment.amountMinor &&
    original.currency === payment.currency &&
    isDeepStrictEqual(allocationsByCharge(original), allocationsByCharge(payment));
  return repeatsOriginal
    ? undefined
    : refuse('validation', `a reversal must repeat payment ${original.id}'s patient, amount and allocations exactly`);
};

const evaluatePut = async ({ tx, identity, uploadedAt }: Context, mutation: UploadMutation): Promise<Refusal | undefined> => {
  const table = mutation.table;
  if (SERVER_WRITTEN.includes(table)) return refuse('authorization', `${table} records are written by the server`);

  const owned = SERVER_OWNED_COLUMNS[table] ?? [];
  const offending = owned.find((column) => mutation.data[column] !== undefined);
  if (offending) return refuse('validation', `${table}.${offending} is set by the server`);

  const parsed = parseDocument({ ...mutation.data, id: mutation.id, type: table });
  if (!parsed.success) return refuse('validation', `does not match the contract: ${parsed.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; ')}`);
  const record = parsed.data;

  if (record.type === 'patient_identity_event' && ['linked', 'distinct', 'unlinked'].includes(record.outcome)) return refuse('authorization', 'Final patient identity decisions require an online server preview and confirmation');
  if (record.type === 'patient_identity_event' && record.otherPatientId) {
    const held = await heldForPatient(tx, identity, record.otherPatientId);
    if (held) return held;
  }
  if (record.type === 'patient' && record.nin && !/^\d{11}$/.test(record.nin)) return refuse('validation', 'NIN must contain 11 digits');

  if (record.facilityId !== identity.facilityId) return refuse('identity', `facilityId ${record.facilityId} is not this device's facility`);
  if (record.deviceId !== identity.deviceId) return refuse('identity', `deviceId ${record.deviceId} is not this device`);
  if (!record.createdBy) return refuse('identity', 'A record must identify its author');

  if ('patientId' in record && typeof record.patientId === 'string' && table !== 'patient') {
    const held = await heldForPatient(tx, identity, record.patientId);
    if (held) return held;
  }

  if (table === 'staff') await tx`SELECT id FROM facilities WHERE id = ${identity.facilityId} FOR UPDATE`;
  if (record.type === 'register_definition') {
    await tx`SELECT id FROM facilities WHERE id = ${identity.facilityId} FOR UPDATE`;
    const rows = await tx`SELECT id FROM register_definitions WHERE facility_id = ${identity.facilityId} AND register_id = ${record.registerId}`;
    const versions = await Promise.all(rows.map((row) => findRecord<RegisterDefinition>(tx, 'register_definition', row.id as string)));
    const history = versions.filter((version): version is RegisterDefinition => Boolean(version));
    const nextVersion = history.reduce((highest, version) => Math.max(highest, version.version), 0) + 1;
    if (record.version !== nextVersion) return refuse('conflict', 'This register has a newer or missing configuration version. Review the current register before saving again');
    const issues = registerDefinitionIssues(record, history);
    if (issues.length) return refuse('validation', issues.join(' '));
  }
  const staff = await findStaffInFacility(tx, identity.facilityId, record.createdBy);
  const historical = (record.type === 'encounter_entry' || record.type === 'clinical_event') && await historicalReviewValid(tx, record, identity.deviceId, uploadedAt);
  const permission = record.type === 'payment' ? paymentPermission(record) : PUT_PERMISSION[table];
  if (!staff) return refuse('identity', describeDenial({ kind: 'not_member', staffId: record.createdBy }));
  if (!staff.active && !historical) return refuse('authorization', describeDenial({ kind: 'deactivated', staffId: record.createdBy }));
  if (permission && !historical) {
    const denial = staffDenial(staff, record.createdBy, permission);
    if (denial) return refuse('authorization', describeDenial(denial));
    if (isStale([permission], record.createdOn, uploadedAt)) {
      return refuse('authorization', `${permission} was performed more than 24 hours before reaching the server`);
    }
  }

  if (record.type === 'staff') {
    const denial = staffDenial(staff, record.createdBy, 'staff:permission');
    if (denial) return refuse('authorization', describeDenial(denial));
  }

  if (record.type === 'appointment' && ((record.activity?.length ?? 0) > 0 || (record.attendance && record.attendance !== 'booked'))) return refuse('validation', 'Create a booking before recording attendance changes');
  if (record.type === 'encounter' && record.appointmentId) {
    // Use the same lock as attendance changes so cancellation cannot race a visit.
    await tx`SELECT id FROM appointments WHERE facility_id = ${identity.facilityId} AND id = ${record.appointmentId} FOR UPDATE`;
    const booking = await findRecord<Appointment>(tx, 'appointment', record.appointmentId);
    if (!booking || booking.facilityId !== record.facilityId || booking.patientId !== record.patientId) return refuse('validation', 'The booking must belong to this visit patient and facility');
    if (booking.attendance === 'cancelled' || booking.attendance === 'no_show') return refuse('conflict', 'Reopen this inactive booking before starting its visit');
    const [visit] = await tx`SELECT id FROM encounters WHERE facility_id = ${identity.facilityId} AND appointment_id = ${record.appointmentId} LIMIT 1`;
    if (visit) return refuse('conflict', 'This booking already has a visit. Continue or review that visit');
  }

  if (record.type === 'referral') {
    if (record.fromFacilityId !== identity.facilityId || record.toFacilityId === identity.facilityId || record.status !== 'sent' || record.deliveryStatus !== 'alert_pending') return refuse('validation', 'A new referral must originate here and await delivery');
    const [destination] = await tx`SELECT id FROM facilities WHERE id=${record.toFacilityId}`;
    if (!destination) return refuse('validation', 'The receiving facility does not exist');
  }
  if (record.type === 'charge') { const issues = await chargeOrderIssues(tx, record); if (issues.length) return refuse('validation', issues.join('. ')); }
  if (record.type === 'encounter_entry') {
    // Serialise repeat saves, closure and corrections for the same encounter.
    await tx`SELECT id FROM encounters WHERE facility_id = ${identity.facilityId} AND id = ${record.encounterId} FOR UPDATE`;
    // The stamp names the role the server knows, never one the device asserts (PRD §9.8.5).
    if (!historical && !rolesFor(staff).includes(record.actorRole)) {
      return refuse('authorization', `saved as ${record.actorRole}, but ${record.createdBy} is ${staff.role}`);
    }
    const careIssues = await careWorkflowIssues(tx, record);
    if (careIssues.length) return refuse('validation', careIssues.join('. '));
    const closed = await closedEncounterRefusal(tx, record);
    if (closed) return closed;
    if (record.step !== 'amendment' && !(REPEATABLE_STEPS as readonly string[]).includes(record.step)) {
      const [saved] = await tx`SELECT id FROM encounter_entries WHERE facility_id = ${record.facilityId} AND encounter_id = ${record.encounterId} AND step = ${record.step} LIMIT 1`;
      if (saved) return refuse('conflict', 'This section is already saved. Add an amendment instead');
    }
    if (record.step === 'amendment') {
      const target = await findRecord<EncounterEntry>(tx, 'encounter_entry', record.amends!);
      if (!target || target.facilityId !== record.facilityId || target.encounterId !== record.encounterId || target.patientId !== record.patientId || target.step === 'amendment') return refuse('validation', 'An amendment must name an original entry of this encounter and patient');
      if (record.values.correctedValues) {
        if (!['vitals', 'complaint', 'lab_results', 'diagnosis', 'prescription', 'injection_order', 'injection'].includes(target.step)) return refuse('validation', 'This step supports explanatory amendments only');
        const corrected = ENCOUNTER_STEP_VALUES[target.step].safeParse(record.values.correctedValues);
        if (!corrected.success) return refuse('validation', `Corrected values do not match ${target.step}`);
        const [latest] = await tx<{ id: string; values: Record<string, unknown> }[]>`SELECT e.id, e."values" FROM encounter_entries e WHERE e.facility_id = ${record.facilityId} AND e.amends = ${target.id} AND e."values" ? 'correctedValues' AND NOT EXISTS (SELECT 1 FROM encounter_entries n WHERE n.amends = e.amends AND n."values"->>'previousAmendmentId' = e.id) LIMIT 1`;
        if ((latest?.id ?? undefined) !== record.values.previousAmendmentId) return refuse('conflict', 'This entry has a newer correction. Review it before correcting again');
        if (target.step === 'prescription' || target.step === 'injection_order') {
          const fulfilledStep = target.step === 'prescription' ? 'dispense' : 'injection';
          const [fulfilled] = await tx`SELECT id FROM encounter_entries WHERE facility_id=${record.facilityId} AND encounter_id=${record.encounterId} AND step=${fulfilledStep} LIMIT 1`;
          if (fulfilled) return refuse('validation', 'A fulfilled treatment order cannot be replaced by a correction');
        }
        if (target.step === 'lab_results' && target.workflowVersion === 1) {
          const before = ENCOUNTER_STEP_VALUES.lab_results.parse(target.values).results.map((r) => r.orderItemId ?? r.test).sort();
          const after = ENCOUNTER_STEP_VALUES.lab_results.parse(corrected.data).results.map((r) => r.orderItemId ?? r.test).sort();
          if (!isDeepStrictEqual(before, after)) return refuse('validation', 'A result correction cannot change its ordered investigation identity');
        }
        if (target.step === 'diagnosis') {
          const values = corrected.data as Record<string, unknown>;
          if (Boolean(values.admit) !== Boolean(target.values.admit) || Boolean(values.giveInjection) !== Boolean(target.values.giveInjection)) return refuse('validation', 'Correcting a diagnosis cannot change the saved disposition');
          const [dispensed] = await tx`SELECT id FROM encounter_entries WHERE facility_id = ${record.facilityId} AND encounter_id = ${record.encounterId} AND step = 'dispense' LIMIT 1`;
          const current = ENCOUNTER_STEP_VALUES.diagnosis.parse(latest?.values.correctedValues ?? target.values);
          if (dispensed && !isDeepStrictEqual(values.prescription, current.prescription)) return refuse('validation', 'Medication has been dispensed. Record the medication change in the longitudinal medication list');
        }
      }
    }
  }

  if (record.type === 'clinical_event') {
    if (!historical && !rolesFor(staff).includes(record.actorRole)) return refuse('authorization', 'The recorded clinical role is not held by this staff member');
    await tx`SELECT id FROM patients WHERE facility_id = ${identity.facilityId} AND id = ${record.patientId} FOR UPDATE`;
    const versions = await tx<{ id: string; patient_id: string; kind: string }[]>`SELECT id, patient_id, kind FROM clinical_events WHERE facility_id = ${record.facilityId} AND record_id = ${record.recordId}`;
    if (!record.previousId && versions.length) return refuse('conflict', 'This clinical record already exists. Review its current version');
    if (record.previousId) {
      const previous = versions.find((version) => version.id === record.previousId);
      if (!previous || previous.patient_id !== record.patientId || previous.kind !== record.kind) return refuse('validation', 'A clinical revision must continue the same patient, kind and record');
      const [successor] = await tx`SELECT id FROM clinical_events WHERE previous_id = ${record.previousId} LIMIT 1`;
      if (successor) return refuse('conflict', 'This clinical record has a newer version. Review it before saving again');
    }
    const problemId = record.values.problemId;
    if (problemId) {
      const [problem] = await tx`SELECT id FROM clinical_events WHERE facility_id = ${record.facilityId} AND patient_id = ${record.patientId} AND record_id = ${String(problemId)} AND kind = 'problem' LIMIT 1`;
      if (!problem) return refuse('validation', 'The linked problem must belong to this patient');
    }
  }

  if (record.type === 'register_entry') {
    const definition = await findRecord<RegisterDefinition>(tx, 'register_definition', `${record.registerId}:v${record.registerVersion}`);
    if (!definition || definition.facilityId !== record.facilityId || definition.status !== 'published') return refuse('validation', 'A register entry must name a published version in this facility');
    const issues = validateRegisterEntry(definition.fields, record.values);
    const known = new Set(definition.fields.filter((field) => field.type !== 'section').map((field) => field.id));
    if (Object.keys(record.values).some((field) => !known.has(field))) issues.push('The entry includes a field outside its saved register version');
    if (issues.length) return refuse('validation', issues.join('; '));
  }

  if (record.type === 'handoff' && record.encounterId) {
    const encounter = await findRecord<Encounter>(tx, 'encounter', record.encounterId);
    if (!encounter || encounter.facilityId !== record.facilityId || encounter.patientId !== record.patientId) return refuse('validation', 'A handoff must name a visit belonging to the same patient and facility');
  }

  if (record.type === 'stock_movement') {
    const issue = stockMovementIssue(record);
    if (issue) return refuse('validation', issue);
    const [item] = await tx`SELECT id FROM stock_items WHERE facility_id = ${record.facilityId} AND id = ${record.itemId} FOR UPDATE`;
    if (!item) return refuse('validation', 'The stock item must belong to this facility');
    // Preserve real movements reported by offline devices even if their combined
    // balance is negative. The inventory flags that discrepancy for a physical count.
  }

  if (record.type === 'payment') {
    const refusal = await paymentRefusal(tx, record);
    if (refusal) return refusal;
  }

  if (record.type === 'billing_adjustment') {
    const [charge] = await tx<{ patient_id: string }[]>`SELECT patient_id FROM charges
      WHERE facility_id = ${record.facilityId} AND id = ${record.chargeId} FOR UPDATE`;
    if (!charge || charge.patient_id !== record.patientId) return refuse('validation', 'The adjustment must name this patient\'s charge');
    if (record.amountMinor > await availableOnCharge(tx, record.facilityId, record.chargeId)) {
      return refuse('conflict', 'The reduction exceeds the unpaid balance; refresh this patient\'s account');
    }
  }

  if (record.type === 'encounter_entry' || record.type === 'clinical_event') {
    const denial = await clinicalAuthorityRefusal(tx, identity, record, uploadedAt);
    if (denial) return denial;
  }
  if (record.type === 'appointment') {
    const denial = await allocationRefusal(tx, record, uploadedAt);
    if (denial) return denial;
  }
  if (record.type === 'audit_event') {
    const denial = await clinicalAttestationRefusal(tx, identity, record, uploadedAt);
    if (denial) return denial;
  }

  // Server clock on audit events the device recorded offline.
  const toWrite = table === 'audit_event' ? { ...record, receivedOn: new Date(uploadedAt).toISOString() } : record;
  const failure = await attempt(tx, (sp) => insertRecord(sp, table, toWrite));
  if (!failure && record.type === 'referral') await routeReferral(tx, record);
  if (!failure && record.type === 'appointment') await recordReservation(tx, record, uploadedAt);
  if (!failure && historical && (record.type === 'encounter_entry' || record.type === 'clinical_event')) await completeHistoricalReview(tx, record, identity.deviceId, uploadedAt);
  if (!failure && table === 'staff') await recordAuditEvent(tx, {
    facilityId: identity.facilityId, deviceId: identity.deviceId, actorStaffId: record.createdBy,
    action: 'create', entityType: 'staff', entityId: record.id,
    metadata: { columns: 'fullName,role,additionalRoles,additionalPermissions,permission' },
  });
  return failure;
};

const evaluatePatch = async ({ tx, identity, uploadedAt }: Context, mutation: UploadMutation): Promise<Refusal | undefined> => {
  const table = mutation.table;
  if (APPEND_ONLY.includes(table)) return refuse('validation', `${table} records are append-only`);
  if (IMMUTABLE_PER_VERSION.includes(table)) return refuse('validation', `${table} records are immutable; publish a new version`);
  if (SERVER_WRITTEN.includes(table) && !DEVICE_MARKABLE.includes(table)) return refuse('authorization', `${table} records are written by the server`);

  const changes: Record<string, unknown> = { ...mutation.data, id: mutation.id };
  const owned = SERVER_OWNED_COLUMNS[table] ?? [];
  const offending = owned.find((column) => changes[column] !== undefined);
  if (offending) return refuse('validation', `${table}.${offending} is set by the server`);

  const updatedBy = changes.updatedBy;
  if (typeof updatedBy !== 'string' || !updatedBy) return refuse('validation', 'a change must say who made it (updatedBy)');

  if (table === 'staff') await tx`SELECT id FROM facilities WHERE id = ${identity.facilityId} FOR UPDATE`;
  if (table === 'stock_item') await tx`SELECT id FROM stock_items WHERE facility_id = ${identity.facilityId} AND id = ${mutation.id} FOR UPDATE`;
  if (table === 'handoff') await tx`SELECT id FROM handoffs WHERE facility_id = ${identity.facilityId} AND id = ${mutation.id} FOR UPDATE`;
  if (table === 'appointment') await tx`SELECT id FROM appointments WHERE facility_id = ${identity.facilityId} AND id = ${mutation.id} FOR UPDATE`;
  const current = await findRecord<AnyDocument>(tx, table, mutation.id);
  if (!current) return refuse('validation', `no ${table} ${mutation.id} exists to change`);
  if (current.facilityId !== identity.facilityId) return refuse('identity', `${table} ${mutation.id} belongs to another facility`);
  if (table === 'patient') {
    const held = await heldForPatient(tx, identity, mutation.id);
    if (held) return held;
  }

  const moved = IMMUTABLE_ENVELOPE_FIELDS.find(
    (field) => changes[field] !== undefined && !isDeepStrictEqual(changes[field], current[field]),
  );
  if (moved) return refuse('validation', `${moved} cannot change`);

  const permissions = patchPermissions(table, changes);
  if (!permissions) return refuse('authorization', `${table} records cannot be changed this way`);

  const staff = await findStaffInFacility(tx, identity.facilityId, updatedBy);
  if (!staff) return refuse('identity', describeDenial({ kind: 'not_member', staffId: updatedBy }));
  if (!staff.active) return refuse('authorization', describeDenial({ kind: 'deactivated', staffId: updatedBy }));
  if (table === 'pin_setup_code') {
    const reset = await validatePinCodeClaim(tx, current as PinSetupCode, identity, uploadedAt);
    if (reset) return refuse('authorization', reset);
    const refusal = claimRefusal(current as PinSetupCode, updatedBy, changes);
    if (refusal) return refusal;
  } else {
    for (const permission of permissions) {
      const denial = staffDenial(staff, updatedBy, permission);
      if (denial) return refuse('authorization', describeDenial(denial));
    }
  }
  if (current.type === 'sync_rejection' && current.visibility === 'restricted' && !current.visibleToStaffIds?.includes(updatedBy) && !staffPermissions(staff).includes('credential:read')) return refuse('authorization', 'Restricted evidence reconciliation needs its owner or an authorized workforce reader');
  const performedOn = typeof changes.updatedOn === 'string' ? changes.updatedOn : undefined;
  if (isStale(permissions, performedOn, uploadedAt)) {
    return refuse('authorization', `${permissions.join(', ')} was performed more than 24 hours before reaching the server`);
  }

  const merged = parseDocument({ ...current, ...changes, type: table });
  if (table === 'stock_item') {
    if ('quantityOnHand' in changes) return refuse('validation', 'The opening stock balance cannot be edited. Record an attributed stock movement');
    if ('unitOfMeasure' in changes && current.type === 'stock_item' && changes.unitOfMeasure !== current.unitOfMeasure) {
      const [movement] = await tx`SELECT id FROM stock_movements WHERE facility_id = ${identity.facilityId} AND item_id = ${mutation.id} LIMIT 1`;
      if (movement) return refuse('validation', 'The unit of measure cannot change after stock movements have been recorded');
    }
  }
  if (table === 'handoff' && current.type === 'handoff' && typeof changes.status === 'string') {
    const order = ['pending', 'received', 'done'];
    if (order.includes(changes.status) && order.indexOf(changes.status) < order.indexOf(current.status)) return refuse('conflict', 'This handoff has already progressed. Review its current state rather than reopening it');
  }
  if (!merged.success) return refuse('validation', `does not match the contract: ${merged.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; ')}`);
  if (merged.data.type === 'appointment') {
    const denial = await allocationRefusal(tx, merged.data, uploadedAt);
    if (denial) return denial;
  }
  if (current.type === 'appointment' && merged.data.type === 'appointment') {
    const allocationOnly = Object.keys(changes).filter((key) => !PATCH_METADATA.has(key)).every((key) => ['allocation', 'schemaVersion'].includes(key));
    if (!allocationOnly) {
    const before = current.activity ?? [], after = merged.data.activity ?? [];
    if (after.length !== before.length + 1 || !isDeepStrictEqual(after.slice(0, -1), before)) return refuse('conflict', 'Booking history has changed. Review the current booking before trying again');
    const action = after[after.length - 1];
    if (action.fromAttendance !== (current.attendance ?? 'booked') || !sameAppointmentTime(action.fromScheduledFor, current.scheduledFor)) return refuse('conflict', 'This booking has changed on another device. Review it before trying again');
    if (action.recordedBy !== updatedBy || !sameAppointmentTime(action.recordedOn, performedOn)) return refuse('validation', 'A booking action must be attributed to the staff member and time of this change');
    if (Date.parse(action.recordedOn) > uploadedAt + 5 * 60_000) return refuse('validation', 'The booking action is dated in the future. Check the device clock');
    if (action.action === 'rescheduled' && merged.data.status !== 'scheduled') return refuse('validation', 'A rescheduled booking must be scheduled');
    if (action.action !== 'rescheduled' && merged.data.status !== current.status) return refuse('validation', 'Only rescheduling changes the booking mode');
    const [visit] = await tx`SELECT id FROM encounters WHERE facility_id = ${identity.facilityId} AND appointment_id = ${mutation.id} LIMIT 1`;
    if (visit) return refuse('conflict', 'Care has already started. Continue or review the linked visit instead of changing attendance');
    const held = await heldForPatient(tx, identity, current.patientId);
    if (held) return held;
    }
  }
  if (table === 'patient' && typeof changes.nin === 'string' && changes.nin && !/^\d{11}$/.test(changes.nin)) return refuse('validation', 'NIN must contain 11 digits');

  if (current.type === 'staff' && merged.data.type === 'staff'
      && !(await keepsAdministrator(tx, current, merged.data as Staff))) {
    return refuse('authorization', 'Keep at least one active facility administrator with write access');
  }

  // Conflict policy: which of the changed columns has the server moved since
  // the device's base? With `previous` the answer is exact per column; without
  // it, a server row edited after this change was made is treated as wholly
  // in conflict — the conservative reading.
  if (current.type === 'inbound_referral') {
    const next = { ...current, ...mutation.data };
    const progress = ['received', 'arrived', 'closed'];
    if (current.status === 'received' && next.status === 'closed') return refuse('validation', 'Record arrival before completing the referral handover');
    if ((current.arrivedOn && next.arrivedOn !== current.arrivedOn) || (current.closedOn && next.closedOn !== current.closedOn)) return refuse('validation', 'Recorded arrival and handover times cannot be rewritten');
    if (progress.indexOf(String(next.status)) < progress.indexOf(current.status)) return refuse('validation', 'Referral progress cannot move backwards');
    if (current.localPatientId && next.localPatientId !== current.localPatientId) return refuse('validation', 'The receiving patient link is already recorded');
  }
  const changedColumns = Object.keys(changes).filter((column) => !PATCH_METADATA.has(column));
  const serverMovedSince =
    !mutation.previous && current.updatedOn !== undefined && performedOn !== undefined && current.updatedOn > performedOn;
  const conflicts: ConflictingColumn[] = changedColumns
    .filter((column) => {
      // Handoff state is monotonic: an accepted arrival must not block a later
      // completion from an offline device. Backwards moves were refused above.
      if (table === 'handoff' && column === 'status') return false;
      if (table === 'appointment' && column === 'scheduledFor' && mutation.previous && column in mutation.previous) return !sameAppointmentTime(current.type === 'appointment' ? current.scheduledFor : undefined, typeof mutation.previous[column] === 'string' ? mutation.previous[column] : undefined);
      const record = current as Record<string, unknown>;
      if (mutation.previous && column in mutation.previous) return !isDeepStrictEqual(record[column] ?? null, mutation.previous[column] ?? null);
      return serverMovedSince;
    })
    .map((column) => ({ column, deviceValue: changes[column], serverValue: (current as Record<string, unknown>)[column] }));

  // A booking's time, attendance and attributed history form one fact. A partial
  // application would leave the displayed state disagreeing with its history.
  if (table === 'appointment' && conflicts.length) return refuse('conflict', 'This booking changed on another device. Review it before trying again');

  // Age and its observation date describe one fact. A partial merge of those
  // columns could make a patient's age jump even when both edits were valid.
  if (table === 'patient') {
    const grouped = ['ageYears', 'ageObservedOn', 'dateOfBirth', 'dobEstimated'];
    if (conflicts.some((conflict) => grouped.includes(conflict.column))) {
      for (const column of changedColumns.filter((field) => grouped.includes(field))) {
        if (!conflicts.some((conflict) => conflict.column === column)) conflicts.push({ column, deviceValue: changes[column], serverValue: (current as Record<string, unknown>)[column] });
      }
    }
  }

  const lastWriteWins = ADMIN_LAST_WRITE_WINS.includes(table);
  const applied = Object.fromEntries(
    Object.entries(changes).filter(
      ([column]) => column !== 'id' && (lastWriteWins || !conflicts.some((conflict) => conflict.column === column)),
    ),
  );
  // A signature covers the values it was made over; once one of them changes it
  // is cleared, and the signing sweep signs the shift again (SCHEMA.md §10).
  if (table === 'roster_shift' && (ROSTER_SIGNED_FIELDS as readonly string[]).some((field) => field in applied)) {
    applied.signature = null;
  }
  const nothingLeft = Object.keys(applied).every((column) => PATCH_METADATA.has(column));

  if (!nothingLeft) {
    const failure = await attempt(tx, async (sp) => {
      await sp`UPDATE ${sp(TABLE_FOR[table])} SET ${sp(toRow(sp, table, applied))} WHERE id = ${mutation.id} AND facility_id = ${identity.facilityId}`;
    });
    if (failure) return failure;
  }

  if ((table === 'staff' || table === 'patient' || table === 'appointment') && !nothingLeft && conflicts.length === 0) await recordAuditEvent(tx, {
    facilityId: identity.facilityId, deviceId: identity.deviceId, actorStaffId: updatedBy,
    action: 'update', entityType: table, entityId: mutation.id,
    metadata: { columns: changedColumns.join(',') },
  });

  if (conflicts.length === 0) {
    if (!nothingLeft && merged.data.type === 'inbound_referral') {
      const incoming = merged.data;
      await tx`UPDATE referrals SET status=${incoming.status === 'received' ? 'sent' : incoming.status}, arrived_on=${incoming.arrivedOn ?? null}, closed_on=${incoming.closedOn ?? null} WHERE id=${incoming.sourceReferralId} AND to_facility_id=${identity.facilityId}`;
    }
    if (!nothingLeft && merged.data.type === 'appointment') await recordReservation(tx, merged.data, uploadedAt);
    return undefined;
  }
  if (lastWriteWins) {
    await recordAuditEvent(tx, {
      facilityId: identity.facilityId,
      deviceId: identity.deviceId,
      actorStaffId: updatedBy,
      action: 'update',
      entityType: table,
      entityId: mutation.id,
      metadata: { lastWriteWins: true, columns: conflicts.map((conflict) => conflict.column).join(',') },
    });
    return undefined;
  }
  return {
    category: 'conflict',
    reason: `${conflicts.map((conflict) => conflict.column).join(', ')} changed on another device first`,
    conflicts,
  };
};

/** The fields a patch set, without the bookkeeping every patch carries. */
const refusedChangesOf = (mutation: UploadMutation): Record<string, unknown> | undefined => {
  const changes = Object.fromEntries(Object.entries(mutation.data).filter(([column]) => !PATCH_METADATA.has(column)));
  return Object.keys(changes).length > 0 ? changes : undefined;
};

const attributionOf = (mutation: UploadMutation): string | undefined => {
  const value = mutation.op === 'put' ? mutation.data.createdBy : mutation.data.updatedBy;
  return typeof value === 'string' ? value : undefined;
};

const occurredOnOf = (mutation: UploadMutation): string | undefined => {
  const value = mutation.op === 'put' ? mutation.data.createdOn : mutation.data.updatedOn;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
};

/** New workflow configuration/events share the existing upload, ledger, audit and reconciliation boundary. */
const evaluateWorkforce = async ({ tx, identity, uploadedAt }: Context, mutation: UploadMutation, signer?: Signer): Promise<Refusal | undefined> => {
  const policy = workforceType(mutation.table) ? FACILITY_DOCUMENT_POLICY[mutation.table as keyof typeof FACILITY_DOCUMENT_POLICY] : undefined;
  if (policy?.writer === 'server') return refuse('authorization', 'This record is written only by the server');
  if (mutation.op === 'delete') return refuse('authorization', 'Retire configuration or end work explicitly; history is not deleted');
  const current = await findRecord(tx, mutation.table, mutation.id);
  if (current && current.facilityId !== identity.facilityId) return refuse('identity', 'This record belongs to another facility');
  if (mutation.op === 'patch' && !current) return refuse('validation', 'No accepted record exists to change');
  if (current && (IMMUTABLE_ENVELOPE_FIELDS as readonly string[]).some((key) => key in mutation.data && !isDeepStrictEqual(mutation.data[key], (current as Record<string, unknown>)[key]))) return refuse('validation', 'Original identity and creation provenance cannot change');
  const shape = SCHEMA_BY_TYPE[mutation.table].shape as Record<string,ZodType>;
  const normalized = Object.fromEntries(Object.entries(mutation.data).map(([key,value]) => [key,value === null && shape[key]?.def.type === 'optional' ? undefined : value]));
  const parsed = parseDocument({ ...current, ...normalized, id: mutation.id, type: mutation.table });
  if (!parsed.success) return refuse('validation', 'Configuration does not match the shared contract');
  const record = parsed.data;
  if (record.facilityId !== identity.facilityId || (!current && record.deviceId !== identity.deviceId)) return refuse('identity', 'Configuration must belong to this device and facility');
  const result = await validateWorkforceRecord(tx, identity, record, mutation, uploadedAt, current);
  if (result.refusal) return result.refusal;
  return attempt(tx, async (sp) => {
    if (!current) await insertRecord(sp, mutation.table, result.record);
    else {
      const changes = Object.fromEntries(Object.keys(SCHEMA_BY_TYPE[mutation.table].shape).filter((key) => key !== 'type' && !IMMUTABLE_ENVELOPE_FIELDS.includes(key as typeof IMMUTABLE_ENVELOPE_FIELDS[number]))
        .map((key) => [key, (result.record as Record<string, unknown>)[key] ?? null]));
      await sp`UPDATE ${sp(TABLE_FOR[mutation.table])} SET ${sp(toRow(sp, mutation.table, changes))} WHERE facility_id=${identity.facilityId} AND id=${mutation.id}`;
    }
    await recordAuditEvent(sp, { facilityId: identity.facilityId, deviceId: identity.deviceId, actorStaffId: attributionOf(mutation), action: current ? 'update' : 'create', entityType: mutation.table, entityId: mutation.id, metadata: { workflow: 'facility_workforce' } });
    if (signer && ['credential','capability_decision','reviewer_delegation'].includes(mutation.table)) await refreshFacilityAuthority(sp, identity.facilityId, signer, uploadedAt);
  });
};

const processMutation = async (
  sql: Sql,
  identity: DeviceIdentity,
  transactionId: number | null,
  mutation: UploadMutation,
  uploadedAt: number,
  request: UploadRequest,
  signer?: Signer,
): Promise<MutationResult> =>
  sql.begin(async (tx): Promise<MutationResult> => {
    // One order everywhere, including operator changes: facility, then record/calendar locks.
    await tx`SELECT id FROM facilities WHERE id=${identity.facilityId} FOR UPDATE`;
    await assertWorkforceCompatibility(tx, identity.facilityId, request, uploadedAt);
    const ledger = { deviceId: identity.deviceId, clientId: mutation.clientId, transactionId };
    if (!(await claimMutation(tx, ledger, mutation.table, mutation.id, 'applied'))) return { outcome: 'duplicate' };

    const context: Context = { tx, identity, uploadedAt };
    const handled = workforceType(mutation.table) || ['unit','billing_department'].includes(mutation.table);
    const refusal = handled ? await evaluateWorkforce(context, mutation, signer) :
      mutation.op === 'delete'
        ? refuse('authorization', 'records are never deleted; retire them instead')
        : mutation.op === 'put'
          ? await evaluatePut(context, mutation)
          : await evaluatePatch(context, mutation);

    if (!refusal) {
      if (signer && mutation.table === 'staff') await refreshFacilityAuthority(tx, identity.facilityId, signer, uploadedAt);
      return { outcome: 'applied' };
    }

    // A column conflict on a merge table applied the other columns; everything else applied nothing.
    const partial = refusal.conflicts !== undefined && mutation.op === 'patch';
    if (!partial) {
      await tx`UPDATE applied_mutations SET outcome = 'rejected' WHERE device_id = ${identity.deviceId} AND client_id = ${mutation.clientId}`;
    }
    await recordRejection(tx, {
      facilityId: identity.facilityId,
      deviceId: identity.deviceId,
      entityType: mutation.table,
      entityId: mutation.id,
      operation: mutation.op,
      category: refusal.category,
      reason: refusal.reason,
      attributedTo: attributionOf(mutation),
      occurredOn: occurredOnOf(mutation),
      conflicts: refusal.conflicts,
      dependencies: refusal.dependencies,
      visibility: RESTRICTED_FACILITY_DOCUMENT_TYPES.some((type) => type === mutation.table) ? 'restricted' : undefined,
      visibleToStaffIds: RESTRICTED_FACILITY_DOCUMENT_TYPES.some((type) => type === mutation.table) ? [attributionOf(mutation)?.trim().slice(0,200) || 'system'] : undefined,
      refusedRecord: mutation.op === 'put' ? { ...mutation.data, id: mutation.id, type: mutation.table } : undefined,
      // A patch that applied nothing keeps what it tried to set; a partly applied one keeps its clash in `conflicts`.
      refusedChanges: mutation.op === 'patch' && !partial ? refusedChangesOf(mutation) : undefined,
    });
    await recordAuditEvent(tx, {
      facilityId: identity.facilityId,
      deviceId: identity.deviceId,
      actorStaffId: attributionOf(mutation),
      action: 'reject',
      entityType: mutation.table,
      entityId: mutation.id,
      result: 'rejected',
      metadata: { category: refusal.category, operation: mutation.op },
    });
    return { outcome: partial ? 'applied_with_conflicts' : 'rejected', refusal };
  });

export const processUpload = async (
  sql: Sql,
  identity: DeviceIdentity,
  request: UploadRequest,
  now: number = Date.now(),
  signer?: Signer,
): Promise<UploadResponse> => {
  let applied = 0;
  let duplicates = 0;
  const rejected: UploadRejection[] = [];

  await sql.begin(async (tx) => {
    await tx`SELECT id FROM facilities WHERE id=${identity.facilityId} FOR UPDATE`;
    await assertWorkforceCompatibility(tx, identity.facilityId, request, now);
    // Readiness must see an in-progress upload before any accepted mutation,
    // including a legacy upload following an earlier modern-client handshake.
    await recordClientVersion(tx, identity, { ...request, pendingMutationCount: 1 }, now);
  });
  for (const mutation of orderWorkforceMutations(request.mutations)) {
    const result = await processMutation(sql, identity, request.transactionId, mutation, now, request, signer);
    if (result.outcome === 'duplicate') duplicates += 1;
    if (result.outcome === 'applied' || result.outcome === 'applied_with_conflicts') applied += 1;
    if (result.refusal) {
      rejected.push({
        clientId: mutation.clientId,
        table: mutation.table,
        id: mutation.id,
        category: result.refusal.category,
        reason: result.refusal.reason,
        ...(result.refusal.dependencies ? { dependencies: result.refusal.dependencies } : {}),
      });
    }
  }

  return { applied, duplicates, rejected, serverTime: new Date(now).toISOString(), ...(request.facilityContractVersion ? { facilityContractVersion: request.facilityContractVersion } : {}) };
};
