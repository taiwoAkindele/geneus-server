import { parseDocument, type AnyDocument, type DocType } from '#shared';
import type { Sql, Tx } from './client.ts';

/**
 * The boundary between the contract's camelCase records and the database's
 * snake_case rows. Every synced type maps to one table; the conversion is
 * mechanical so it lives in exactly one place, and nothing above this file
 * knows a column name.
 */
export const TABLE_FOR: Record<DocType, string> = {
  patient: 'patients',
  patient_identity_event: 'patient_identity_events',
  visit: 'visits',
  encounter: 'encounters',
  encounter_entry: 'encounter_entries',
  clinical_event: 'clinical_events',
  inpatient_event: 'inpatient_events', bed_ready_event: 'bed_ready_events',
  handoff: 'handoffs',
  appointment: 'appointments',
  register_definition: 'register_definitions',
  register_entry: 'register_entries',
  referral: 'referrals',
  inbound_referral: 'inbound_referrals',
  stock_item: 'stock_items',
  stock_movement: 'stock_movements',
  facility: 'facilities',
  unit: 'units',
  staff: 'staff',
  roster_shift: 'roster_shifts',
  device: 'devices',
  audit_event: 'audit_events',
  sync_rejection: 'sync_rejections',
  pin_setup_code: 'pin_setup_codes',
  fee_item: 'fee_items',
  charge: 'charges',
  payment: 'payments',
  billing_adjustment: 'billing_adjustments',
  incoming_transfer: 'incoming_transfers',
  billing_department: 'billing_departments',
  location: 'locations', service_definition: 'service_definitions', service_offering: 'service_offerings',
  practitioner_profile: 'practitioner_profiles', credential: 'credentials', capability_decision: 'capability_decisions',
  reviewer_delegation: 'reviewer_delegations', clinical_authority_bootstrap: 'clinical_authority_bootstraps',
  external_clinical_reviewer: 'external_clinical_reviewers', authority_snapshot: 'authority_snapshots',
  staff_assignment: 'staff_assignments', service_session: 'service_sessions', session_event: 'session_events',
  work_ownership_event: 'work_ownership_events', appointment_reservation: 'appointment_reservations',
};

/**
 * Columns stored as JSONB. postgres.js infers PostgreSQL arrays from JS arrays
 * and text from strings, but an object or a JSON array has to be declared as
 * JSON explicitly — and these are the only places JSONB is used (SCHEMA.md §11).
 */
const JSONB_COLUMNS: Partial<Record<DocType, readonly string[]>> = {
  patient: ['identification_base'],
  facility: ['workforce_policy'],
  appointment: ['charge_ids', 'activity', 'allocation'],
  staff: ['additional_roles', 'additional_permissions'],
  register_definition: ['fields'],
  register_entry: ['values'],
  encounter_entry: ['values', 'actor_context'],
  clinical_event: ['values', 'actor_context'],
  referral: ['tier1'],
  inbound_referral: ['tier1'],
  audit_event: ['metadata'],
  sync_rejection: ['conflicts', 'refused_record', 'refused_changes', 'dependencies', 'visible_to_staff_ids'],
  fee_item: ['exemptions'],
  payment: ['allocations'],
  service_definition: ['concept', 'investigation'], service_offering: ['location_ids', 'required_actions'],
  practitioner_profile: ['profession', 'specialties'], capability_decision: ['scope', 'credential_revision_ids'],
  reviewer_delegation: ['scopes'], clinical_authority_bootstrap: ['scopes'], external_clinical_reviewer: ['scopes'],
  authority_snapshot: ['grants', 'review_scopes', 'source_decision_ids'], staff_assignment: ['location_ids', 'required_actions'],
  service_session: ['participants', 'resources', 'roster_shift_ids'],
};

export const snakeCase = (key: string): string => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
export const camelCase = (key: string): string => key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

type Row = Record<string, unknown>;

/**
 * A record as a row: keys renamed, `type` dropped (it is the table), JSONB
 * columns wrapped, and `undefined` left out so PostgreSQL applies its defaults.
 */
export const toRow = (sql: Sql | Tx, type: DocType, record: Record<string, unknown>): Row => {
  const jsonb = JSONB_COLUMNS[type] ?? [];
  const row: Row = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'type' || value === undefined) continue;
    const column = snakeCase(key);
    row[column] = jsonb.includes(column) ? sql.json(value as never) : value;
  }
  return row;
};

/**
 * A row as a record: keys renamed, `type` restored, NULLs dropped (the contract
 * uses absence, not null), then run through the contract so defaults apply and
 * a row the schema no longer recognises fails here rather than downstream.
 */
export const fromRow = <T extends AnyDocument>(type: DocType, row: Row): T => {
  const record: Row = { type };
  for (const [column, value] of Object.entries(row)) {
    if (type === 'authority_snapshot' && column === 'is_current') continue;
    if (value === null) continue;
    record[camelCase(column)] = value;
  }
  const parsed = parseDocument(record);
  if (!parsed.success) {
    throw new Error(`row ${String(row.id)} in ${TABLE_FOR[type]} does not match the contract: ${parsed.error.message}`);
  }
  return parsed.data as T;
};

/**
 * Inserts one record, running it through the contract first so defaults apply
 * and nothing that fails the schema can reach a table — whatever the caller
 * already checked. Validation is cheap; a malformed clinical row is not.
 */
export const insertRecord = async (sql: Sql | Tx, type: DocType, record: Record<string, unknown>): Promise<void> => {
  const parsed = parseDocument({ ...record, type });
  if (!parsed.success) {
    throw new Error(`refusing to insert ${type} ${String(record.id)}: ${parsed.error.message}`);
  }
  await sql`INSERT INTO ${sql(TABLE_FOR[type])} ${sql(toRow(sql, type, parsed.data))}`;
};

export const findRecord = async <T extends AnyDocument>(
  sql: Sql | Tx,
  type: DocType,
  id: string,
): Promise<T | undefined> => {
  const [row] = await sql<Row[]>`SELECT * FROM ${sql(TABLE_FOR[type])} WHERE id = ${id}`;
  return row ? fromRow<T>(type, row) : undefined;
};
