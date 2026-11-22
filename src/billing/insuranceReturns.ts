import { randomUUID } from 'node:crypto';
import {
  CALCULATION_VERSION,
  CoverageAllocation,
  PayerContractTerms,
  computeAllocation,
  creditedQuantity,
  type Charge,
  type ServiceChargeAllocation,
} from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord, fromRow, insertRecord } from '../db/records.ts';
import { chargePositions } from '../insurance/coverage.ts';
import { prepareServiceAllocation } from './serviceAllocations.ts';

const refuse = (message: string) =>
  Object.assign(new Error(message), { statusCode: 409, code: 'insurance_return_review_required' });

/** Verified online approval only. Recalculate remaining units with the confirmed historical terms. */
export const confirmInsuranceReturn = async (
  tx: Tx,
  request: ServiceChargeAllocation,
  now: number,
) => {
  if (
    request.action !== 'release' ||
    !request.creditReturnedUnits ||
    !request.returnEntryId ||
    request.sourceKind !== 'pharmacy'
  ) {
    throw refuse('Select an actual Pharmacy return and its exact accepted allocation');
  }

  const prepared = await prepareServiceAllocation(tx, request, now, false, true);

  if (prepared.issue) {
    throw refuse(prepared.issue);
  }

  const charge = (await findRecord<Charge>(tx, 'charge', request.chargeId))!;

  const [previous] =
    await tx`SELECT a.*,d.inputs,d.patient_share_minor AS original_patient_minor,d.payer_share_minor,d.capitation_covered_minor
  FROM coverage_allocations a JOIN coverage_allocation_details d ON d.facility_id=a.facility_id AND d.allocation_id=a.id
  WHERE a.facility_id=${request.facilityId} AND a.charge_id=${charge.id} AND a.state='finalised'
  AND NOT EXISTS(SELECT 1 FROM coverage_allocations later WHERE later.facility_id=a.facility_id AND later.supersedes=a.id)`;

  if (!previous) {
    throw refuse(
      'Confirm the existing insurance responsibility before approving an insured return',
    );
  }

  const inputs = previous.inputs as Record<string, unknown>;
  const terms = PayerContractTerms.safeParse(inputs.termsSlice);

  if (
    !terms.success ||
    typeof inputs.planCode !== 'string' ||
    !charge.quantity ||
    terms.data.payerId !== previous.payer_id ||
    terms.data.currency !== charge.currency
  ) {
    throw refuse(
      'The confirmed snapshot lacks the exact historical terms, plan or purchased quantity required for a safe return',
    );
  }

  const records = (
    await tx`SELECT * FROM service_charge_allocations WHERE facility_id=${request.facilityId} AND charge_id=${charge.id}`
  ).map((r) => fromRow<ServiceChargeAllocation>('service_charge_allocation', r));

  const totalReturned = creditedQuantity(records, charge.id) + request.quantity;
  const remaining = Math.round((charge.quantity - totalReturned) * 1e6) / 1e6;

  if (remaining < 0) {
    throw refuse('The returned purchased quantity exceeds this charge');
  }

  const returnAdjustmentMinor = Math.round(
    (charge.listPriceMinor * totalReturned) / charge.quantity,
  );

  const netList = charge.listPriceMinor - returnAdjustmentMinor;

  const computed =
    remaining > 0
      ? computeAllocation({
          terms: terms.data,
          planCode: inputs.planCode,
          charge: { ...charge, listPriceMinor: netList },
          units: remaining,
        })
      : undefined;

  if (computed && !computed.ok) {
    throw refuse(
      'The original insurance rules cannot calculate the remaining quantity; keep the return in financial review',
    );
  }

  const split = computed?.ok
    ? computed.split
    : {
        arrangement: previous.arrangement as 'per_service' | 'capitation',
        patientShareMinor: 0,
        payerShareMinor: 0,
        contractAdjustmentMinor: 0,
        capitationCoveredMinor: 0,
      };

  if (
    split.patientShareMinor > Number(previous.original_patient_minor) ||
    split.payerShareMinor > Number(previous.payer_share_minor) ||
    split.capitationCoveredMinor > Number(previous.capitation_covered_minor)
  ) {
    throw refuse('A return cannot silently increase a previously confirmed responsibility');
  }

  const position = (await chargePositions(tx, request.facilityId, [charge])).get(charge.id)!;

  if (position.money.reducedMinor + position.money.waivedByPaymentMinor > split.patientShareMinor) {
    throw refuse(
      'Earlier patient reductions exceed the remaining responsibility. Resolve that concession through financial review before this insurance return',
    );
  }

  const createdOn = new Date(now).toISOString();

  const allocation = CoverageAllocation.parse({
    id: 'coverage_allocation:' + randomUUID(),
    type: 'coverage_allocation',
    facilityId: request.facilityId,
    deviceId: request.deviceId,
    schemaVersion: 7,
    createdBy: request.createdBy,
    createdOn,
    patientId: charge.patientId,
    chargeId: charge.id,
    state: 'finalised',
    payerId: previous.payer_id,
    arrangement: previous.arrangement,
    patientShareMinor: split.patientShareMinor,
    currency: charge.currency,
    basis: 'exception',
    supersedes: previous.id,
  });

  await insertRecord(tx, 'coverage_allocation', allocation);
  await tx`INSERT INTO coverage_allocation_details(allocation_id,facility_id,calculation_version,inputs,list_price_minor,patient_share_minor,payer_share_minor,contract_adjustment_minor,capitation_covered_minor,return_adjustment_minor,reason,request_key)
 VALUES(${allocation.id},${request.facilityId},${CALCULATION_VERSION},${tx.json({ ...inputs, units: remaining, originalUnits: charge.quantity, listPriceMinor: netList, originalListPriceMinor: charge.listPriceMinor, returnDecisionVersion: 1, returnAllocationIds: [...records.filter((a) => a.creditReturnedUnits).map((a) => a.id), request.id] } as never)},${charge.listPriceMinor},${split.patientShareMinor},${split.payerShareMinor},${split.contractAdjustmentMinor},${split.capitationCoveredMinor},${returnAdjustmentMinor},${request.reason},${'return:' + request.id})`;

  const record = {
    ...prepared.record,
    creditMinor: Number(previous.original_patient_minor) - split.patientShareMinor,
  };

  await insertRecord(tx, 'service_charge_allocation', record);

  const claims =
    await tx`SELECT claim_id FROM insurance_claim_lines WHERE facility_id=${request.facilityId} AND charge_id=${charge.id} AND current`;

  return {
    record,
    allocationId: allocation.id,
    claimIds: claims.map((c) => String(c.claim_id)),
    claimReviewRequired: claims.length > 0,
  };
};
