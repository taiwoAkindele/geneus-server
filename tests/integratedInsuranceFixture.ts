import {
  PayerContractTerms,
  computeAllocation,
  CoverageAllocation,
  CALCULATION_VERSION,
  type FacilityRegistrationResult,
  type Charge,
  type FeeItem,
} from '#shared';
import type { Sql } from '../src/db/client.ts';
import { insertRecord, findRecord } from '../src/db/records.ts';
import { recordRemittance } from '../src/insurance/settlement.ts';
import { RemittanceInput } from '#shared';

/** Synthetic historical financial records for projection tests, not a substitute clinical workflow. */
export const seedInsuredStatement = async (
  sql: Sql,
  f: FacilityRegistrationResult,
  patientId: string,
  staffId = f.admin.id,
  options: { pharmacy?: boolean } = {},
) => {
  const category = options.pharmacy ? 'pharmacy' : 'laboratory';
  const quantity = options.pharmacy ? 3 : 1;
  const unit = options.pharmacy ? 'tablets' : 'item';
  const unitPrice = options.pharmacy ? 450000 : 1000000;
  const tariffPrice = options.pharmacy ? 400000 : 900000;
  const base = {
    facilityId: f.facility.id,
    deviceId: f.device.deviceId,
    createdBy: staffId,
    createdOn: new Date().toISOString(),
    schemaVersion: 7,
  };
  const existing = await findRecord(sql, 'charge', 'charge:integrated-insured');
  if (existing) {
    return { patientId, chargeId: existing.id };
  }
  await insertRecord(sql, 'patient', {
    ...base,
    id: patientId,
    type: 'patient',
    patientId,
    fullName: 'Chioma Insured Synthetic',
    ageYears: 30,
    sex: 'female',
    address: 'Synthetic address',
  });
  await insertRecord(sql, 'payer', {
    ...base,
    id: 'payer:integrated',
    type: 'payer',
    name: 'Synthetic statement HMO',
    code: 'STMT',
    kind: 'hmo',
    active: true,
  });
  await insertRecord(sql, 'fee_item', {
    ...base,
    id: 'fee:integrated-insured',
    type: 'fee_item',
    name: options.pharmacy ? 'Insured medication fixture' : 'Insured investigation fixture',
    category,
    amountMinor: unitPrice,
    currency: 'NGN',
    chargeWhen: 'when_ordered',
  });
  const fee = (await findRecord<FeeItem>(sql, 'fee_item', 'fee:integrated-insured'))!;
  await insertRecord(sql, 'charge', {
    ...base,
    id: 'charge:integrated-insured',
    type: 'charge',
    patientId,
    feeItemId: fee.id,
    category: fee.category,
    description: fee.name,
    listPriceMinor: unitPrice * quantity,
    amountMinor: unitPrice * quantity,
    currency: 'NGN',
    quantity,
    unitOfMeasure: unit,
    unitPriceMinor: unitPrice,
    feePriceVersion: fee.priceVersion,
  });
  const charge = (await findRecord<Charge>(sql, 'charge', 'charge:integrated-insured'))!;
  const terms = PayerContractTerms.parse({
    payerId: 'payer:integrated',
    effectiveFrom: '2020-01-01',
    currency: 'NGN',
    arrangements: { categories: { [category]: 'per_service' }, items: {} },
    tariff: { [fee.id]: { unitMinor: tariffPrice, payerCode: 'SYN-LAB' } },
    plans: [
      {
        planCode: 'GOLD',
        name: 'Synthetic gold',
        rules: {
          categories: {
            [category]: { coverage: 'covered', copay: { kind: 'percent', basisPoints: 1000 } },
          },
          items: {},
        },
      },
    ],
  });
  const computed = computeAllocation({ terms, planCode: 'GOLD', charge, units: quantity });
  if (!computed.ok) {
    throw new Error('Synthetic contract must be calculable');
  }
  const split = computed.split;
  const allocation = CoverageAllocation.parse({
    ...base,
    id: 'allocation:integrated-insured',
    type: 'coverage_allocation',
    patientId,
    chargeId: charge.id,
    state: 'finalised',
    payerId: terms.payerId,
    arrangement: 'per_service',
    patientShareMinor: split.patientShareMinor,
    currency: 'NGN',
    basis: 'exception',
  });
  await sql.begin(async (tx) => {
    await insertRecord(tx, 'coverage_allocation', allocation);
    await tx`INSERT INTO coverage_allocation_details(allocation_id,facility_id,calculation_version,inputs,list_price_minor,patient_share_minor,payer_share_minor,contract_adjustment_minor,capitation_covered_minor,reason,request_key)
   VALUES(${allocation.id},${f.facility.id},${CALCULATION_VERSION},${tx.json({ serviceDate: base.createdOn.slice(0, 10), units: quantity, planCode: 'GOLD', feeItemId: fee.id, category, currency: 'NGN', contractVersionId: 'historical:synthetic', termsSlice: terms } as never)},${charge.listPriceMinor},${split.patientShareMinor},${split.payerShareMinor},${split.contractAdjustmentMinor},${split.capitationCoveredMinor},'Synthetic historical confirmed split','fixture:statement')`;
    await tx`INSERT INTO insurance_claims(id,facility_id,claim_number,revision,payer_id,patient_id,cover_id,episode_kind,episode_key,currency,state,ready_snapshot,created_by)
   VALUES('claim:integrated',${f.facility.id},'CLM-INTEGRATED-001',1,${terms.payerId},${patientId},'cover:historical-synthetic','day',${base.createdOn.slice(0, 10)},'NGN','submitted','{}',${staffId})`;
    await tx`INSERT INTO insurance_claim_lines(id,facility_id,claim_id,charge_id,allocation_id,contract_version_id) VALUES('line:integrated',${f.facility.id},'claim:integrated',${charge.id},${allocation.id},'historical:synthetic')`;
    await tx`INSERT INTO insurance_claim_events(id,facility_id,claim_id,state,staff_id) VALUES('event:integrated',${f.facility.id},'claim:integrated','submitted',${staffId})`;
    const remittance = await recordRemittance(
      tx,
      f.facility.id,
      staffId,
      RemittanceInput.parse({
        payerId: terms.payerId,
        receivedOn: base.createdOn.slice(0, 10),
        reference: 'SYNTHETIC-INSURER-CASH',
        amountMinor: 400000,
        currency: 'NGN',
        method: 'cash',
        allocations: [],
        requestKey: 'fixture:statement-remittance',
      }),
    );
    // Imported historical claim-level settlement. No charge-level insurer allocation is invented.
    await tx`INSERT INTO insurance_remittance_allocations(id,facility_id,remittance_id,claim_id,amount_minor,recorded_by) VALUES('settlement:integrated',${f.facility.id},${remittance.remittanceId},'claim:integrated',400000,${staffId})`;
  });
  await insertRecord(sql, 'payment', {
    ...base,
    id: 'payment:insured-patient',
    type: 'payment',
    patientId,
    receiptNumber: f.facility.id + '-R-000501-Q2',
    method: 'cash',
    currency: 'NGN',
    amountMinor: options.pharmacy ? split.patientShareMinor : 50000,
    allocations: [
      { chargeId: charge.id, amountMinor: options.pharmacy ? split.patientShareMinor : 50000 },
    ],
  });
  return { patientId, chargeId: charge.id };
};
