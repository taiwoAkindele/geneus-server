import { randomUUID } from 'node:crypto';
import {
  Location,
  ResultTemplate,
  ServiceDefinition,
  ServiceOffering,
  Unit,
  unitIsRoutable,
  type LaboratoryCatalogueDetails,
} from '#shared';
import type { DeviceIdentity } from '../devices/credentials.ts';
import type { Tx } from '../db/client.ts';
import { fromRow, insertRecord } from '../db/records.ts';
import { recordsInFacility } from '../workforce/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';

export type LabTestDraft = {
  name: string;
  specimen: string;
  classification: string;
  aliases: string[];
  concept?: ServiceDefinition['concept'];
  catalogue?: LaboratoryCatalogueDetails;
  resultTemplateId?: string;
};

const LABORATORY = 'Laboratory';
const isLaboratory = (name: string) => name.trim().toLowerCase() === LABORATORY.toLowerCase();

/** Names compare without case or repeated spaces, so "FBC" and "fbc " are the same test. */
export const testKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Every name and other name an active lab test in this facility already answers to. */
export const takenTestKeys = (definitions: readonly ServiceDefinition[]) =>
  new Set(
    definitions
      .filter((d) => d.investigation && (d.active || d.laboratoryCatalogue))
      .flatMap((d) => [d.name, ...(d.investigation?.aliases ?? [])].map(testKey)),
  );

export class CatalogueRefusal extends Error {}

export const retireLaboratoryTest = async (
  tx: Tx,
  identity: DeviceIdentity,
  staffId: string,
  definitionId: string,
  revision: number,
) => {
  await tx`SELECT id FROM facilities WHERE id=${identity.facilityId} FOR UPDATE`;
  const [row] = await tx`SELECT active, fee_item_id, revision FROM service_definitions
    WHERE facility_id=${identity.facilityId} AND id=${definitionId} AND laboratory_catalogue IS NOT NULL FOR UPDATE`;

  if (!row || row.revision !== revision) {
    throw new CatalogueRefusal('The test changed. Sync your catalogue and try again');
  }

  if (!row.active) {
    return;
  }

  const now = new Date().toISOString();
  await tx`UPDATE service_offerings SET configuration='retired', revision=revision+1, updated_on=${now}, updated_by=${staffId}
    WHERE facility_id=${identity.facilityId} AND service_definition_id=${definitionId} AND configuration<>'retired'`;
  await tx`UPDATE service_definitions SET active=false, orderable=false, revision=revision+1, updated_on=${now}, updated_by=${staffId}
    WHERE facility_id=${identity.facilityId} AND id=${definitionId}`;

  if (row.fee_item_id) {
    await tx`UPDATE fee_items SET active=false, updated_on=${now}, updated_by=${staffId}
      WHERE facility_id=${identity.facilityId} AND id=${row.fee_item_id}`;
  }

  await recordAuditEvent(tx, {
    facilityId: identity.facilityId,
    deviceId: identity.deviceId,
    actorStaffId: staffId,
    action: 'update',
    entityType: 'service_definition',
    entityId: definitionId,
    metadata: { workflow: 'laboratory_test_retirement' },
  });
};

const lockTemplate = async (tx: Tx, facilityId: string, templateId: string) => {
  const [row] = await tx`SELECT * FROM result_templates
    WHERE facility_id=${facilityId} AND id=${templateId} FOR UPDATE`;

  if (!row) {
    throw new CatalogueRefusal('Choose an active result template in this facility');
  }

  const template = fromRow<ResultTemplate>('result_template', row);

  if (template.status !== 'active' || template.serviceDefinitionIds.length >= 500) {
    throw new CatalogueRefusal(`${template.name} is unavailable for another test`);
  }

  return template;
};

/**
 * Every catalogue test is filed under the facility's Laboratory unit and location.
 * They are required by the offering record but decide nothing about who performs a
 * test: ordered tests reach the laboratory queue for any permitted lab staff. An
 * existing active "Laboratory" is reused; otherwise one is created once.
 */
const laboratoryPlacement = async (
  tx: Tx,
  envelope: Record<string, unknown>,
  facilityId: string,
) => {
  const [units, locations] = await Promise.all([
    recordsInFacility(tx, facilityId, 'unit'),
    recordsInFacility(tx, facilityId, 'location'),
  ]);

  let unit = units.find((u) => isLaboratory(u.name) && unitIsRoutable(u));

  if (!unit) {
    const id = `unit:${randomUUID()}`;
    unit = Unit.parse({
      ...envelope,
      id,
      type: 'unit',
      unitId: id,
      name: LABORATORY,
      active: true,
      kind: 'unit',
      revision: 1,
    });

    await insertRecord(tx, 'unit', unit);
  }

  let location = locations.find((l) => isLaboratory(l.name) && l.active);

  if (!location) {
    location = Location.parse({
      ...envelope,
      id: `location:${randomUUID()}`,
      type: 'location',
      name: LABORATORY,
      kind: 'room',
      active: true,
      revision: 1,
      unitId: unit.id,
    });

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
export const addLabTests = async (
  tx: Tx,
  identity: DeviceIdentity,
  staffId: string,
  drafts: readonly LabTestDraft[],
  source: 'standard' | 'own' | 'classified',
) => {
  const [facility] =
    await tx`SELECT time_zone FROM facilities WHERE id = ${identity.facilityId} FOR UPDATE`;

  if (!facility) {
    throw new CatalogueRefusal('This facility was not found');
  }

  const definitions = await recordsInFacility(tx, identity.facilityId, 'service_definition');
  const taken = takenTestKeys(definitions);
  const now = new Date().toISOString();
  const added: string[] = [];
  const skipped: string[] = [];

  // This legacy operational shape must remain readable before catalogue cutover.
  const envelope = {
    facilityId: identity.facilityId,
    deviceId: identity.deviceId,
    createdBy: staffId,
    createdOn: now,
    schemaVersion: 5,
  };

  let placement: Awaited<ReturnType<typeof laboratoryPlacement>> | undefined;

  for (const draft of drafts) {
    const name = draft.name.trim().replace(/\s+/g, ' ');

    const aliases = [
      ...new Set(
        draft.aliases
          .map((alias) => alias.trim())
          .filter((alias) => alias && testKey(alias) !== testKey(name)),
      ),
    ];

    const keys = [name, ...aliases].map(testKey);

    if (!name || keys.some((key) => taken.has(key))) {
      skipped.push(draft.name.trim());
      continue;
    }

    keys.forEach((key) => taken.add(key));
    placement ??= await laboratoryPlacement(tx, envelope, identity.facilityId);
    const definitionId = `service_definition:${randomUUID()}`;
    const template = draft.resultTemplateId
      ? await lockTemplate(tx, identity.facilityId, draft.resultTemplateId)
      : undefined;

    const definition = ServiceDefinition.parse({
      ...envelope,
      id: definitionId,
      type: 'service_definition',
      name,
      category: 'laboratory',
      concept: draft.concept ?? { system: 'local', code: definitionId, label: name },
      laboratoryCatalogue: draft.catalogue,
      orderable: draft.catalogue?.pricingCategory !== 'billable',
      active: true,
      revision: 1,
      investigation: {
        specimen: draft.specimen.trim(),
        department: draft.classification.trim(),
        aliases,
      },
    });

    const offering = ServiceOffering.parse({
      ...envelope,
      id: `service_offering:${randomUUID()}`,
      type: 'service_offering',
      serviceDefinitionId: definitionId,
      unitId: placement.unitId,
      name,
      locationIds: [placement.locationId],
      delivery: 'physical',
      requiredActions: ['perform_test', 'record_result'],
      intakePolicy: 'both',
      timeZone: facility.time_zone ?? 'Africa/Lagos',
      configuration: 'active',
      resourceReadiness: 'available',
      revision: 1,
    });

    await insertRecord(tx, 'service_definition', definition);
    await insertRecord(tx, 'service_offering', offering);

    if (template) {
      await tx`UPDATE result_templates SET service_definition_ids=${tx.json([...template.serviceDefinitionIds, definitionId])},
        revision=revision+1, updated_by=${staffId}, updated_on=${now}
        WHERE facility_id=${identity.facilityId} AND id=${template.id}`;
    }

    added.push(name);
  }

  if (added.length) {
    await recordAuditEvent(tx, {
      facilityId: identity.facilityId,
      deviceId: identity.deviceId,
      actorStaffId: staffId,
      action: 'create',
      entityType: 'service_definition',
      metadata: { workflow: 'lab_catalogue', source, added: added.length, skipped: skipped.length },
    });
  }

  return { added, skipped };
};
