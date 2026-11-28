import { randomUUID } from 'node:crypto';
import {
  FeeItem,
  SCHEMA_VERSION,
  labTestKey,
  type LaboratoryPriceInput,
  type ServiceDefinition,
} from '#shared';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import type { Tx } from '../db/client.ts';
import { findRecord, fromRow, insertRecord } from '../db/records.ts';

export class LaboratoryPriceConflict extends Error {
  readonly statusCode = 409;
  readonly code = 'laboratory_price_conflict';
}

type PricingActor = { facilityId: string; deviceId: string; actorStaffId: string };

const activatePrice = async (tx: Tx, actor: PricingActor, price: LaboratoryPriceInput) => {
  const { facilityId, deviceId, actorStaffId } = actor;
  const [row] = await tx`SELECT * FROM service_definitions
    WHERE facility_id=${facilityId} AND id=${price.definitionId} FOR UPDATE`;

  if (!row) {
    throw new LaboratoryPriceConflict('A selected investigation was not found in this facility');
  }

  const definition = fromRow<ServiceDefinition>('service_definition', row);

  if (
    definition.active &&
    definition.orderable &&
    definition.feeItemId &&
    definition.revision === price.revision + 1
  ) {
    const fee = await findRecord<FeeItem>(tx, 'fee_item', definition.feeItemId);

    if (fee?.active && fee.amountMinor === price.amountMinor && fee.currency === price.currency) {
      return false;
    }
  }

  if (
    !definition.active ||
    definition.orderable ||
    definition.feeItemId ||
    definition.revision !== price.revision ||
    definition.laboratoryCatalogue?.pricingCategory !== 'billable'
  ) {
    throw new LaboratoryPriceConflict(`${definition.name} is no longer an unpriced billable draft`);
  }

  const [offering] = await tx`SELECT id FROM service_offerings
    WHERE facility_id=${facilityId} AND service_definition_id=${definition.id}
      AND configuration='active' AND resource_readiness='available' AND fee_item_id IS NULL
    ORDER BY id LIMIT 1 FOR UPDATE`;

  if (!offering) {
    throw new LaboratoryPriceConflict(`${definition.name} needs an available Laboratory service`);
  }

  const [matchingFee] = await tx`SELECT id FROM fee_items
    WHERE facility_id=${facilityId} AND category='laboratory'
      AND lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))=${labTestKey(definition.name)} LIMIT 1`;

  if (matchingFee) {
    throw new LaboratoryPriceConflict(
      `${definition.name} already has a central fee with this name. Review the existing fee before pricing the draft`,
    );
  }

  const now = new Date().toISOString();
  const feeId = `fee_item:${randomUUID()}`;
  await insertRecord(tx, 'fee_item', {
    id: feeId,
    facilityId,
    deviceId,
    createdBy: actorStaffId,
    createdOn: now,
    schemaVersion: SCHEMA_VERSION,
    name: definition.name,
    category: 'laboratory',
    amountMinor: price.amountMinor,
    currency: price.currency,
    chargeWhen: 'when_ordered',
    exemptions: [],
    active: true,
  });
  await tx`UPDATE service_definitions SET fee_item_id=${feeId}, orderable=true, revision=revision+1,
    updated_on=${now}, updated_by=${actorStaffId} WHERE facility_id=${facilityId} AND id=${definition.id}`;
  await tx`UPDATE service_offerings SET fee_item_id=${feeId}, revision=revision+1,
    updated_on=${now}, updated_by=${actorStaffId} WHERE facility_id=${facilityId} AND id=${offering.id}`;
  await recordAuditEvent(tx, {
    facilityId,
    deviceId,
    actorStaffId,
    action: 'update',
    entityType: 'service_definition',
    entityId: definition.id,
    metadata: { workflow: 'laboratory_price_activation', feeItemId: feeId },
  });

  return true;
};

export const activateLaboratoryPrices = async (
  tx: Tx,
  actor: PricingActor,
  prices: readonly LaboratoryPriceInput[],
) => {
  const [facility] =
    await tx`SELECT currency FROM facilities WHERE id=${actor.facilityId} FOR UPDATE`;

  if (!facility || prices.some((price) => price.currency !== (facility.currency ?? 'NGN'))) {
    throw new LaboratoryPriceConflict('Use the facility currency for all prices');
  }

  let activated = 0;

  for (const price of prices) {
    if (await activatePrice(tx, actor, price)) {
      activated += 1;
    }
  }

  return { activated, alreadyActivated: prices.length - activated };
};
