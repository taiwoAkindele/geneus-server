import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION, ServiceDefinition, ServiceOffering, unitIsRoutable } from '#shared';
import type { DeviceIdentity } from '../devices/credentials.ts';
import type { Tx } from '../db/client.ts';
import { insertRecord } from '../db/records.ts';
import { recordsInFacility } from '../workforce/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';

export type LabTestDraft = { name: string; specimen: string; classification: string; aliases: string[]; concept?: ServiceDefinition['concept'] };
export type Placement = { unitId: string; locationId: string };

/** Names compare without case or repeated spaces, so "FBC" and "fbc " are the same test. */
export const testKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Every name and other name an active lab test in this facility already answers to. */
export const takenTestKeys = (definitions: readonly ServiceDefinition[]) =>
  new Set(definitions.filter((d) => d.active && d.investigation).flatMap((d) => [d.name, ...(d.investigation?.aliases ?? [])].map(testKey)));

export class CatalogueRefusal extends Error {}

/**
 * Adds lab tests to a facility's catalogue in one transaction. The facility row is
 * locked first, so two devices adding at the same moment cannot both add a test;
 * a test whose name or other name is already taken, here or earlier in the batch,
 * is skipped and nothing existing is changed.
 */
export const addLabTests = async (tx: Tx, identity: DeviceIdentity, staffId: string, drafts: readonly LabTestDraft[], placement: Placement, source: 'standard' | 'own') => {
  const [facility] = await tx`SELECT time_zone FROM facilities WHERE id = ${identity.facilityId} FOR UPDATE`;
  if (!facility) throw new CatalogueRefusal('This facility was not found');
  const [units, locations, definitions] = await Promise.all([
    recordsInFacility(tx, identity.facilityId, 'unit'), recordsInFacility(tx, identity.facilityId, 'location'), recordsInFacility(tx, identity.facilityId, 'service_definition'),
  ]);
  if (!units.some((u) => u.id === placement.unitId && unitIsRoutable(u))) throw new CatalogueRefusal('Choose an active unit in this facility');
  if (!locations.some((l) => l.id === placement.locationId && l.active)) throw new CatalogueRefusal('Choose an active location in this facility');
  const taken = takenTestKeys(definitions), now = new Date().toISOString(), added: string[] = [], skipped: string[] = [];
  const envelope = { facilityId: identity.facilityId, deviceId: identity.deviceId, createdBy: staffId, createdOn: now, schemaVersion: SCHEMA_VERSION };
  for (const draft of drafts) {
    const name = draft.name.trim().replace(/\s+/g, ' ');
    const aliases = [...new Set(draft.aliases.map((alias) => alias.trim()).filter((alias) => alias && testKey(alias) !== testKey(name)))];
    const keys = [name, ...aliases].map(testKey);
    if (!name || keys.some((key) => taken.has(key))) { skipped.push(draft.name.trim()); continue; }
    keys.forEach((key) => taken.add(key));
    const definitionId = `service_definition:${randomUUID()}`;
    const definition = ServiceDefinition.parse({ ...envelope, id: definitionId, type: 'service_definition', name, category: 'laboratory', concept: draft.concept ?? { system: 'local', code: definitionId, label: name }, orderable: true, active: true, revision: 1, investigation: { specimen: draft.specimen.trim(), department: draft.classification.trim(), aliases } });
    const offering = ServiceOffering.parse({ ...envelope, id: `service_offering:${randomUUID()}`, type: 'service_offering', serviceDefinitionId: definitionId, unitId: placement.unitId, name, locationIds: [placement.locationId], delivery: 'physical', requiredActions: ['perform_test', 'record_result'], intakePolicy: 'both', timeZone: facility.time_zone ?? 'Africa/Lagos', configuration: 'active', resourceReadiness: 'available', revision: 1 });
    await insertRecord(tx, 'service_definition', definition);
    await insertRecord(tx, 'service_offering', offering);
    added.push(name);
  }
  if (added.length) await recordAuditEvent(tx, { facilityId: identity.facilityId, deviceId: identity.deviceId, actorStaffId: staffId, action: 'create', entityType: 'service_definition', metadata: { workflow: 'lab_catalogue', source, added: added.length, skipped: skipped.length } });
  return { added, skipped };
};
