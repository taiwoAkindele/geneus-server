import { randomUUID } from 'node:crypto';
import { SyncRejection, SCHEMA_VERSION, type DocType, type RejectionCategory, type SyncOperation } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { insertRecord } from '../db/records.ts';

/**
 * The two tables that make the upload path safe to retry and safe to refuse:
 * the idempotency ledger (root §12) and the reconcile queue (root §4.1). The
 * upload handler (Phase C) drives them; they are defined here so the rules —
 * "one row per mutation, written in the same transaction as the mutation" and
 * "a refused clinical write becomes a record, never a log line" — have a home.
 */

export type MutationIdentity = {
  deviceId: string;
  /** PowerSync's per-device sequence number for the queued write. */
  clientId: number;
  transactionId: number | null;
};

export type LedgerOutcome = 'applied' | 'rejected';

/**
 * Claims a mutation identity. Returns false when this device already uploaded
 * this clientId — the retry case — so the caller acknowledges without acting.
 * Must run in the same transaction as the write it guards; if that transaction
 * rolls back, so does the claim, and the next retry is a first attempt again.
 *
 * `ON CONFLICT DO NOTHING` rather than catching the unique violation: an error
 * inside a PostgreSQL transaction aborts the whole transaction, caught or not,
 * so the duplicate has to be detected without one.
 */
export const claimMutation = async (
  tx: Tx,
  identity: MutationIdentity,
  entityType: DocType,
  entityId: string,
  outcome: LedgerOutcome,
): Promise<boolean> => {
  const claimed = await tx`
    INSERT INTO applied_mutations (device_id, client_id, transaction_id, entity_type, entity_id, outcome)
    VALUES (${identity.deviceId}, ${identity.clientId}, ${identity.transactionId}, ${entityType}, ${entityId}, ${outcome})
    ON CONFLICT (device_id, client_id) DO NOTHING`;
  return claimed.count === 1;
};

export const wasApplied = async (sql: Sql | Tx, identity: Pick<MutationIdentity, 'deviceId' | 'clientId'>): Promise<boolean> => {
  const rows = await sql`
    SELECT 1 FROM applied_mutations WHERE device_id = ${identity.deviceId} AND client_id = ${identity.clientId}`;
  return rows.length === 1;
};

export type Rejection = {
  facilityId: string;
  deviceId: string;
  entityType: DocType;
  entityId: string;
  operation: SyncOperation;
  category: RejectionCategory;
  reason: string;
  attributedTo?: string;
  /** The device's clock for the mutation, when the payload carried one. */
  occurredOn?: string;
  conflicts?: SyncRejection['conflicts'];
};

/** Files a rejection in the reconcile queue. The record syncs back to the facility. */
export const recordRejection = async (sql: Sql | Tx, rejection: Rejection): Promise<SyncRejection> => {
  const now = new Date().toISOString();
  const record = SyncRejection.parse({
    id: `sync_rejection:${randomUUID()}`,
    type: 'sync_rejection',
    facilityId: rejection.facilityId,
    schemaVersion: SCHEMA_VERSION,
    createdBy: 'system',
    createdOn: now,
    deviceId: rejection.deviceId,
    entityType: rejection.entityType,
    entityId: rejection.entityId,
    operation: rejection.operation,
    category: rejection.category,
    reason: rejection.reason,
    attributedTo: rejection.attributedTo,
    occurredOn: rejection.occurredOn,
    conflicts: rejection.conflicts,
  });
  await insertRecord(sql, 'sync_rejection', record);
  return record;
};
