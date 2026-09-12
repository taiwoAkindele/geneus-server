import { isDeepStrictEqual } from 'node:util';
import {
  HIGH_RISK_PERMISSIONS,
  IMMUTABLE_ENVELOPE_FIELDS,
  OFFLINE_AUTHORIZATION_POLICY,
  parseDocument,
  type AnyDocument,
  type ConflictingColumn,
  type DocType,
  type Permission,
  type RejectionCategory,
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
import { claimMutation, recordRejection } from './ledger.ts';

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
const SERVER_WRITTEN: readonly DocType[] = ['facility', 'device', 'sync_rejection'];
/** Never patched: the record is the event. */
const APPEND_ONLY: readonly DocType[] = ['register_entry', 'stock_movement', 'audit_event'];
/** Never patched: a change is a new version (SCHEMA.md §11.2). */
const IMMUTABLE_PER_VERSION: readonly DocType[] = ['register_definition'];
/** Administrative: a same-column race applies the later upload, audited (SCHEMA.md §7). */
const ADMIN_LAST_WRITE_WINS: readonly DocType[] = ['staff', 'roster_shift', 'unit', 'sync_rejection'];

/** Columns only the server may set. */
const SERVER_OWNED_COLUMNS: Partial<Record<DocType, readonly string[]>> = {
  roster_shift: ['signature'],
};

/** The only columns a device may patch on a rejection: marking it resolved. */
const RESOLUTION_COLUMNS = new Set(['resolvedOn', 'resolvedBy', 'resolution']);

/** Envelope bookkeeping a patch carries alongside its real changes. */
const PATCH_METADATA = new Set(['id', 'updatedBy', 'updatedOn']);

const PUT_PERMISSION: Partial<Record<DocType, Permission>> = {
  patient: 'patient:create',
  visit: 'visit:create',
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
};

/**
 * What a patch needs, decided from the columns it changes. Tables without an
 * update permission in the contract (appointments, visits) cannot be patched
 * yet: nothing in the app updates them, and a permission is added when
 * something does — never inferred.
 */
const patchPermissions = (table: DocType, changes: Record<string, unknown>): Permission[] | undefined => {
  const columns = Object.keys(changes).filter((column) => !PATCH_METADATA.has(column));
  switch (table) {
    case 'patient':
      return ['patient:update'];
    case 'handoff':
      return ['handoff:update'];
    case 'referral':
      return ['referral:update'];
    case 'stock_item':
      return ['stock_item:manage'];
    case 'unit':
      return ['unit:manage'];
    case 'staff':
      return [
        ...new Set(
          columns.map((column): Permission => {
            if (column === 'permission') return 'staff:permission';
            if (column === 'active' && changes.active === false) return 'staff:deactivate';
            return 'staff:manage';
          }),
        ),
      ];
    case 'roster_shift':
      return columns.every((column) => column === 'extendedUntil') ? ['roster:extend'] : ['roster:assign'];
    case 'sync_rejection':
      return columns.every((column) => RESOLUTION_COLUMNS.has(column)) ? ['sync_rejection:resolve'] : undefined;
    default:
      return undefined;
  }
};

type Refusal = { category: RejectionCategory; reason: string; conflicts?: ConflictingColumn[] };
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
  return Number.isNaN(performed) || uploadedAt - performed > OFFLINE_AUTHORIZATION_POLICY.highRiskMs;
};

type Context = { tx: Tx; identity: DeviceIdentity; uploadedAt: number };

const evaluatePut = async ({ tx, identity, uploadedAt }: Context, mutation: UploadMutation): Promise<Refusal | undefined> => {
  const table = mutation.table;
  if (SERVER_WRITTEN.includes(table)) return refuse('authorization', `${table} records are written by the server`);

  const owned = SERVER_OWNED_COLUMNS[table] ?? [];
  const offending = owned.find((column) => mutation.data[column] !== undefined);
  if (offending) return refuse('validation', `${table}.${offending} is set by the server`);

  const parsed = parseDocument({ ...mutation.data, id: mutation.id, type: table });
  if (!parsed.success) return refuse('validation', `does not match the contract: ${parsed.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; ')}`);
  const record = parsed.data;

  if (record.facilityId !== identity.facilityId) return refuse('identity', `facilityId ${record.facilityId} is not this device's facility`);
  if (record.deviceId !== identity.deviceId) return refuse('identity', `deviceId ${record.deviceId} is not this device`);

  const staff = await findStaffInFacility(tx, identity.facilityId, record.createdBy);
  const permission = PUT_PERMISSION[table];
  if (!staff) return refuse('identity', describeDenial({ kind: 'not_member', staffId: record.createdBy }));
  if (!staff.active) return refuse('authorization', describeDenial({ kind: 'deactivated', staffId: record.createdBy }));
  if (permission) {
    const denial = staffDenial(staff, record.createdBy, permission);
    if (denial) return refuse('authorization', describeDenial(denial));
    if (isStale([permission], record.createdOn, uploadedAt)) {
      return refuse('authorization', `${permission} was performed more than 24 hours before reaching the server`);
    }
  }

  // Server clock on audit events the device recorded offline.
  const toWrite = table === 'audit_event' ? { ...record, receivedOn: new Date(uploadedAt).toISOString() } : record;
  return attempt(tx, (sp) => insertRecord(sp, table, toWrite));
};

const evaluatePatch = async ({ tx, identity, uploadedAt }: Context, mutation: UploadMutation): Promise<Refusal | undefined> => {
  const table = mutation.table;
  if (APPEND_ONLY.includes(table)) return refuse('validation', `${table} records are append-only`);
  if (IMMUTABLE_PER_VERSION.includes(table)) return refuse('validation', `${table} records are immutable; publish a new version`);
  if (SERVER_WRITTEN.includes(table) && table !== 'sync_rejection') return refuse('authorization', `${table} records are written by the server`);

  const changes: Record<string, unknown> = { ...mutation.data, id: mutation.id };
  const owned = SERVER_OWNED_COLUMNS[table] ?? [];
  const offending = owned.find((column) => changes[column] !== undefined);
  if (offending) return refuse('validation', `${table}.${offending} is set by the server`);

  const updatedBy = changes.updatedBy;
  if (typeof updatedBy !== 'string' || !updatedBy) return refuse('validation', 'a change must say who made it (updatedBy)');

  const current = await findRecord<AnyDocument>(tx, table, mutation.id);
  if (!current) return refuse('validation', `no ${table} ${mutation.id} exists to change`);
  if (current.facilityId !== identity.facilityId) return refuse('identity', `${table} ${mutation.id} belongs to another facility`);

  const moved = IMMUTABLE_ENVELOPE_FIELDS.find(
    (field) => changes[field] !== undefined && !isDeepStrictEqual(changes[field], current[field]),
  );
  if (moved) return refuse('validation', `${moved} cannot change`);

  const permissions = patchPermissions(table, changes);
  if (!permissions) return refuse('authorization', `${table} records cannot be changed this way`);

  const staff = await findStaffInFacility(tx, identity.facilityId, updatedBy);
  if (!staff) return refuse('identity', describeDenial({ kind: 'not_member', staffId: updatedBy }));
  if (!staff.active) return refuse('authorization', describeDenial({ kind: 'deactivated', staffId: updatedBy }));
  for (const permission of permissions) {
    const denial = staffDenial(staff, updatedBy, permission);
    if (denial) return refuse('authorization', describeDenial(denial));
  }
  const performedOn = typeof changes.updatedOn === 'string' ? changes.updatedOn : undefined;
  if (isStale(permissions, performedOn, uploadedAt)) {
    return refuse('authorization', `${permissions.join(', ')} was performed more than 24 hours before reaching the server`);
  }

  const merged = parseDocument({ ...current, ...changes, type: table });
  if (!merged.success) return refuse('validation', `does not match the contract: ${merged.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; ')}`);

  // Conflict policy: which of the changed columns has the server moved since
  // the device's base? With `previous` the answer is exact per column; without
  // it, a server row edited after this change was made is treated as wholly
  // in conflict — the conservative reading.
  const changedColumns = Object.keys(changes).filter((column) => !PATCH_METADATA.has(column));
  const serverMovedSince =
    !mutation.previous && current.updatedOn !== undefined && performedOn !== undefined && current.updatedOn > performedOn;
  const conflicts: ConflictingColumn[] = changedColumns
    .filter((column) => {
      const record = current as Record<string, unknown>;
      if (mutation.previous && column in mutation.previous) return !isDeepStrictEqual(record[column], mutation.previous[column]);
      return serverMovedSince;
    })
    .map((column) => ({ column, deviceValue: changes[column], serverValue: (current as Record<string, unknown>)[column] }));

  const lastWriteWins = ADMIN_LAST_WRITE_WINS.includes(table);
  const applied = Object.fromEntries(
    Object.entries(changes).filter(
      ([column]) => column !== 'id' && (lastWriteWins || !conflicts.some((conflict) => conflict.column === column)),
    ),
  );
  const nothingLeft = Object.keys(applied).every((column) => PATCH_METADATA.has(column));

  if (!nothingLeft) {
    const failure = await attempt(tx, async (sp) => {
      await sp`UPDATE ${sp(TABLE_FOR[table])} SET ${sp(toRow(sp, table, applied))} WHERE id = ${mutation.id} AND facility_id = ${identity.facilityId}`;
    });
    if (failure) return failure;
  }

  if (conflicts.length === 0) return undefined;
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

const attributionOf = (mutation: UploadMutation): string | undefined => {
  const value = mutation.op === 'put' ? mutation.data.createdBy : mutation.data.updatedBy;
  return typeof value === 'string' ? value : undefined;
};

const occurredOnOf = (mutation: UploadMutation): string | undefined => {
  const value = mutation.op === 'put' ? mutation.data.createdOn : mutation.data.updatedOn;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
};

const processMutation = async (
  sql: Sql,
  identity: DeviceIdentity,
  transactionId: number | null,
  mutation: UploadMutation,
  uploadedAt: number,
): Promise<MutationResult> =>
  sql.begin(async (tx): Promise<MutationResult> => {
    const ledger = { deviceId: identity.deviceId, clientId: mutation.clientId, transactionId };
    if (!(await claimMutation(tx, ledger, mutation.table, mutation.id, 'applied'))) return { outcome: 'duplicate' };

    const context: Context = { tx, identity, uploadedAt };
    const refusal =
      mutation.op === 'delete'
        ? refuse('authorization', 'records are never deleted; retire them instead')
        : mutation.op === 'put'
          ? await evaluatePut(context, mutation)
          : await evaluatePatch(context, mutation);

    if (!refusal) return { outcome: 'applied' };

    // A conflict on a merge table applied the other columns; everything else applied nothing.
    const partial = refusal.category === 'conflict' && mutation.op === 'patch';
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
): Promise<UploadResponse> => {
  let applied = 0;
  let duplicates = 0;
  const rejected: UploadRejection[] = [];

  for (const mutation of request.mutations) {
    const result = await processMutation(sql, identity, request.transactionId, mutation, now);
    if (result.outcome === 'duplicate') duplicates += 1;
    if (result.outcome === 'applied' || result.outcome === 'applied_with_conflicts') applied += 1;
    if (result.refusal) {
      rejected.push({
        clientId: mutation.clientId,
        table: mutation.table,
        id: mutation.id,
        category: result.refusal.category,
        reason: result.refusal.reason,
      });
    }
  }

  return { applied, duplicates, rejected, serverTime: new Date(now).toISOString() };
};
