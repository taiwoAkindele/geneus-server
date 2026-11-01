import { randomUUID } from 'node:crypto';
import { Location, SCHEMA_VERSION, ServiceDefinition, ServiceOffering, Unit, unitIsRoutable } from '#shared';
import type { DeviceIdentity } from '../devices/credentials.ts';
import type { Tx } from '../db/client.ts';
import { insertRecord } from '../db/records.ts';
import { recordsInFacility } from '../workforce/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';

export type LabTestDraft = { name: string; specimen: string; classification: string; aliases: string[]; concept?: ServiceDefinition['concept'] };

const LABORATORY = 'Laboratory';
const isLaboratory = (name: string) => name.trim().toLowerCase() === LABORATORY.toLowerCase();

/** Names compare without case or repeated spaces, so "FBC" and "fbc " are the same test. */
export const testKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Every name and other name an active lab test in this facility already answers to. */
export const takenTestKeys = (definitions: readonly ServiceDefinition[]) =>
  new Set(definitions.filter((d) => d.active && d.investigation).flatMap((d) => [d.name, ...(d.investigation?.aliases ?? [])].map(testKey)));

export class CatalogueRefusal extends Error {}

/**
 * Every catalogue test is filed under the facility's Laboratory unit and location.
 * They are required by the offering record but decide nothing about who performs a
 * test: ordered tests reach the laboratory queue for any permitted lab staff. An
 * existing active "Laboratory" is reused; otherwise one is created once.
 */
const laboratoryPlacement = async (tx: Tx, envelope: Record<string, unknown>, facilityId: string) => {
  const [units, locations] = await Promise.all([recordsInFacility(tx, facilityId, 'unit'), recordsInFacility(tx, facilityId, 'location')]);
  let unit = units.find((u) => isLaboratory(u.name) && unitIsRoutable(u));
  if (!unit) {
    const id = `unit:${randomUUID()}`;
    unit = Unit.parse({ ...envelope, id, type: 'unit', unitId: id, name: LABORATORY, active: true, kind: 'unit', revision: 1 });
    await insertRecord(tx, 'unit', unit);
  }
  let location = locations.find((l) => isLaboratory(l.name) && l.active);
  if (!location) {
    location = Location.parse({ ...envelope, id: `location:${randomUUID()}`, type: 'location', name: LABORATORY, kind: 'room', active: true, revision: 1, unitId: unit.id });
    await insertRecord(tx, 'location', location);
  }
  return { unitId: unit.id, locationId: location.id };
};

/**
 * Adds lab tests to a facility's catalogue in one transaction. The facility row is
 * locked first, so two devices adding at the same moment cannot both add a test;
 * a test whose name or other name is already taken, here or earlier in the batch,
 * is skipped and nothing existing is changed.
 */
export const addLabTests = async (tx: Tx, identity: DeviceIdentity, staffId: string, drafts: readonly LabTestDraft[], source: 'standard' | 'own') => {
  const [facility] = await tx`SELECT time_zone FROM facilities WHERE id = ${identity.facilityId} FOR UPDATE`;
  if (!facility) throw new CatalogueRefusal('This facility was not found');
  const definitions = await recordsInFacility(tx, identity.facilityId, 'service_definition');
  const taken = takenTestKeys(definitions), now = new Date().toISOString(), added: string[] = [], skipped: string[] = [];
  const envelope = { facilityId: identity.facilityId, deviceId: identity.deviceId, createdBy: staffId, createdOn: now, schemaVersion: SCHEMA_VERSION };
  let placement: Awaited<ReturnType<typeof laboratoryPlacement>> | undefined;
  for (const draft of drafts) {
    const name = draft.name.trim().replace(/\s+/g, ' ');
    const aliases = [...new Set(draft.aliases.map((alias) => alias.trim()).filter((alias) => alias && testKey(alias) !== testKey(name)))];
    const keys = [name, ...aliases].map(testKey);
    if (!name || keys.some((key) => taken.has(key))) { skipped.push(draft.name.trim()); continue; }
    keys.forEach((key) => taken.add(key));
    placement ??= await laboratoryPlacement(tx, envelope, identity.facilityId);
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
