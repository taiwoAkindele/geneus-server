import { randomUUID } from 'node:crypto';
import { AuditEvent, SCHEMA_VERSION } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { insertRecord } from '../db/records.ts';

/**
 * Server-originated audit events: things the server itself did or decided
 * (registered a facility, enrolled a device, refused a mutation). Device-
 * originated events arrive through the upload path and are inserted like any
 * other record. Either way the table is append-only — PostgreSQL refuses an
 * UPDATE or DELETE (migration 0001).
 */
export type ServerAuditEvent = {
  facilityId: string;
  deviceId: string;
  actorStaffId?: string;
  action: AuditEvent['action'];
  entityType?: AuditEvent['entityType'];
  entityId?: string;
  result?: AuditEvent['result'];
  metadata?: AuditEvent['metadata'];
};

export const recordAuditEvent = async (sql: Sql | Tx, event: ServerAuditEvent): Promise<AuditEvent> => {
  const now = new Date().toISOString();
  const record = AuditEvent.parse({
    id: `audit_event:${randomUUID()}`,
    type: 'audit_event',
    facilityId: event.facilityId,
    schemaVersion: SCHEMA_VERSION,
    createdBy: 'system',
    createdOn: now,
    deviceId: event.deviceId,
    actorStaffId: event.actorStaffId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    result: event.result ?? 'ok',
    occurredOn: now,
    receivedOn: now,
    metadata: event.metadata,
  });
  await insertRecord(sql, 'audit_event', record);
  return record;
};
