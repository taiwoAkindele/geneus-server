import {
  allocatedQuantity,
  creditedQuantity,
  dispensingDetails,
  serviceQuantityUnits,
  ENCOUNTER_STEP_VALUES,
  type ServiceChargeAllocation,
  type Charge,
  type EncounterEntry,
  type StockItem,
  type BillingAdjustment,
} from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord, fromRow } from '../db/records.ts';
import { chargePositions } from '../insurance/coverage.ts';

const exceeds = (used: number, capacity: number) =>
  serviceQuantityUnits(used) > serviceQuantityUnits(capacity);
/** Called under the facility lock. Clinical sources and original money are never edited. */
export const prepareServiceAllocation = async (
  tx: Tx,
  a: ServiceChargeAllocation,
  now: number,
  mayCredit: boolean,
  verifiedInsuranceReturn = false,
): Promise<{ issue?: string; record: ServiceChargeAllocation; credit?: BillingAdjustment }> => {
  const fail = (issue: string) => ({ record: a, issue });
  const [row] =
    await tx`SELECT * FROM charges WHERE facility_id=${a.facilityId} AND id=${a.chargeId} FOR UPDATE`;
  if (!row) {
    return fail('Select a synced charge in this hospital');
  }
  const c = fromRow<Charge>('charge', row);
  if (c.patientId !== a.patientId) {
    return fail('The charge belongs to another patient');
  }
  const e = await findRecord<EncounterEntry>(tx, 'encounter_entry', a.sourceEntryId);
  if (!e || e.facilityId !== a.facilityId || e.patientId !== a.patientId) {
    return fail('Select this patient’s exact signed clinical source');
  }
  if (c.encounterId && c.encounterId !== e.encounterId) {
    return fail('A visit-specific charge cannot be consumed by another visit');
  }
  let quantity = 0;
  let unit = '';
  let feeId: string | undefined;
  if (a.sourceKind === 'laboratory') {
    if (e.step !== 'lab_order' || c.category !== 'laboratory') {
      return fail('Select a Laboratory charge and a signed investigation order');
    }
    const item = ENCOUNTER_STEP_VALUES.lab_order
      .parse(e.values)
      .items?.find((i) => i.id === a.sourceItemId);
    if (!item) {
      return fail('Select the exact investigation item on this signed order');
    }
    quantity = 1;
    unit = 'item';
    feeId = item.feeItemId;
    if (c.orderItemId && (c.orderItemId !== item.id || c.orderEntryId !== e.id)) {
      return fail('This charge already names another investigation');
    }
  } else {
    const d = dispensingDetails(e);
    if (
      d?.action !== 'supply' ||
      d.billing === 'outside' ||
      a.sourceItemId !== e.id ||
      (c.category !== 'pharmacy' && !c.dispenseEntryId)
    ) {
      return fail('Select an exact hospital medicine supply and Pharmacy charge');
    }
    quantity = d.quantity!;
    unit = d.unit!;
    feeId = d.feeItemId;
    if (!feeId && d.stockItemId) {
      feeId =
        (await findRecord<StockItem>(tx, 'stock_item', d.stockItemId))?.feeItemId ?? undefined;
    }
    const [priced] =
      await tx`SELECT id FROM encounter_entries WHERE facility_id=${a.facilityId} AND pharmacy_version=1 AND values->'supply'->>'priceFor'=${e.id}`;
    const [generated] =
      await tx`SELECT id FROM charges WHERE facility_id=${a.facilityId} AND (dispense_entry_id=${e.id} OR dispense_entry_id=${priced?.id ?? null})`;
    if (generated && generated.id !== c.id) {
      return fail('This supply already has a generated charge');
    }
    if (c.dispenseEntryId && c.dispenseEntryId !== e.id && c.dispenseEntryId !== priced?.id) {
      return fail('This generated charge belongs to another supply');
    }
  }
  if (feeId && feeId !== c.feeItemId) {
    return fail('The clinical source and charge name different central items');
  }
  if (a.unit !== unit || (c.unitOfMeasure && c.unitOfMeasure !== unit)) {
    return fail(
      'Use the exact charge and clinical quantity unit; pack conversions cannot be inferred',
    );
  }
  if (!c.quantity) {
    return fail(
      'This historical charge has no authoritative purchased quantity; retain it for review instead of guessing capacity',
    );
  }
  if ([c.quantity, quantity].some((q) => Math.abs(q - serviceQuantityUnits(q) / 1e6) >= 1e-10)) {
    return fail(
      'This source requires a quantity precision beyond six decimal places; review its quantity unit before associating it',
    );
  }
  const records = (
    await tx`SELECT * FROM service_charge_allocations WHERE facility_id=${a.facilityId} AND (charge_id=${c.id} OR (source_entry_id=${e.id} AND source_item_id=${a.sourceItemId})) ORDER BY accepted_on,id`
  ).map((r) => fromRow<ServiceChargeAllocation>('service_charge_allocation', r));
  if (records.some((r) => r.chargeId === c.id && r.unit !== a.unit)) {
    return fail(
      'Use the same audited quantity unit as the first accepted association for this charge',
    );
  }
  const charged = (
    await tx`SELECT id FROM charges WHERE facility_id=${a.facilityId} AND order_item_id=${a.sourceItemId} AND order_entry_id=${e.id}`
  ).some((r) => r.id !== c.id);
  if (charged) {
    return fail('This investigation already has a separate charge');
  }
  let credit: BillingAdjustment | undefined;
  let creditMinor = 0;
  if (a.action === 'allocate') {
    const sourceUsed = allocatedQuantity(
      records,
      (r) => r.sourceEntryId === e.id && r.sourceItemId === a.sourceItemId,
    );
    const resolvedReturns = records
      .filter(
        (r) =>
          r.sourceEntryId === e.id &&
          r.sourceItemId === a.sourceItemId &&
          r.action === 'release' &&
          r.returnEntryId,
      )
      .reduce((n, r) => n + r.quantity, 0);
    // Associate the historical supply fact, even when it was later returned.
    // Claim evidence separately checks net delivery; a return is resolved by an exact release.
    if (exceeds(sourceUsed + resolvedReturns + a.quantity, quantity)) {
      return fail(
        'This source quantity is already associated, returned, or reserved by another device',
      );
    }
    const used = allocatedQuantity(records, (r) => r.chargeId === c.id);
    const credited = creditedQuantity(records, c.id);
    if (exceeds(used + credited + a.quantity, c.quantity)) {
      return fail(
        'The purchased quantity is already consumed or credited. Review the accepted associations',
      );
    }
  } else {
    const previous = records.find((r) => r.id === a.reversesId);
    if (
      !previous ||
      previous.action !== 'allocate' ||
      previous.chargeId !== c.id ||
      previous.sourceEntryId !== e.id ||
      previous.sourceItemId !== a.sourceItemId ||
      previous.unit !== a.unit
    ) {
      return fail('Release the exact accepted allocation for this source');
    }
    const released = records
      .filter((r) => r.reversesId === previous.id)
      .reduce((n, r) => n + r.quantity, 0);
    if (exceeds(released + a.quantity, previous.quantity)) {
      return fail('This allocation quantity was already released');
    }
    if (a.returnEntryId) {
      const returned = await findRecord<EncounterEntry>(tx, 'encounter_entry', a.returnEntryId);
      const d = returned && dispensingDetails(returned);
      if (
        !returned ||
        returned.facilityId !== a.facilityId ||
        returned.patientId !== a.patientId ||
        d?.action !== 'return' ||
        d.returnOf !== e.id ||
        d.unit !== a.unit
      ) {
        return fail('Choose the exact recorded return of this supply');
      }
      const [used] =
        await tx`SELECT COALESCE(SUM(quantity),0) AS quantity FROM service_charge_allocations WHERE facility_id=${a.facilityId} AND return_entry_id=${a.returnEntryId}`;
      if (exceeds(Number(used.quantity) + a.quantity, d.quantity!)) {
        return fail('This returned quantity has already been financially resolved');
      }
      if (d.creditMinor) {
        return fail('This return already generated a credit through its original charge');
      }
    }
    if (a.creditReturnedUnits) {
      const position = (await chargePositions(tx, a.facilityId, [c])).get(c.id)!;
      if (verifiedInsuranceReturn && position.estimate.state === 'finalised') {
        return { record: { ...a, acceptedOn: new Date(now).toISOString(), creditMinor: 0 } };
      }
      if (!mayCredit) {
        return fail('Crediting a returned purchase requires payment reduction authority');
      }
      // Offline association uploads cannot revise a confirmed insurance decision.
      if (
        !position.final ||
        !['self_pay', 'self_pay_confirmed', 'exempt'].includes(position.estimate.state)
      ) {
        return fail(
          'Insurance responsibility must be reviewed through the existing insurance confirmation and settlement workflow before a patient credit can be issued',
        );
      }
      const before = creditedQuantity(records, c.id);
      const after = before + a.quantity;
      creditMinor =
        Math.round((c.amountMinor * after) / c.quantity) -
        Math.round((c.amountMinor * before) / c.quantity);
      if (
        creditMinor >
        Math.max(
          0,
          position.baseMinor - position.money.reducedMinor - position.money.waivedByPaymentMinor,
        )
      ) {
        return fail(
          'The return credit would exceed the remaining patient responsibility after earlier reductions',
        );
      }
      if (creditMinor > 0) {
        credit = {
          id: `credit:allocation:${a.id}`,
          type: 'billing_adjustment',
          facilityId: a.facilityId,
          deviceId: a.deviceId,
          schemaVersion: 7,
          createdBy: a.createdBy,
          createdOn: new Date(now).toISOString(),
          patientId: a.patientId,
          chargeId: c.id,
          kind: 'discount',
          amountMinor: creditMinor,
          reason: `Returned purchase: ${a.reason}`,
        };
      }
    }
  }
  return { record: { ...a, acceptedOn: new Date(now).toISOString(), creditMinor }, credit };
};
