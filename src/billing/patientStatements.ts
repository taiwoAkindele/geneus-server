import {
  patientStatement,
  claimSettlement,
  chargeUnits,
  estimateCoverage,
  inBillingPeriod,
  serviceDateOf,
  type PatientStatement,
  type StatementClaim,
  type CoverageFinancialSummary,
  type Charge,
  type Payment,
  type BillingAdjustment,
  type Refund,
  type Patient,
  type EncounterEntry,
  type Facility,
  type PayerDecisionKind,
} from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord, fromRow } from '../db/records.ts';
import { loadCoverageRecords, facilityZoneAt } from '../insurance/coverage.ts';
import { billingPeriods } from '../insurance/billingPeriods.ts';

/** Repeatable snapshot, scoped to the whole patient account and one currency. */
export const buildPatientStatement = async (
  tx: Tx,
  facilityId: string,
  patientId: string,
  currency: string,
  cutoff: string,
): Promise<PatientStatement> => {
  const patient = await findRecord<Patient>(tx, 'patient', patientId);
  const facility = await findRecord<Facility>(tx, 'facility', facilityId);

  if (!patient || patient.facilityId !== facilityId || !facility) {
    throw Object.assign(new Error('Patient account not found in this hospital'), {
      statusCode: 404,
    });
  }

  const [migration] = await tx`SELECT applied_on FROM schema_migrations WHERE version=42`;

  const beforeMigration =
    migration && Date.parse(cutoff) < new Date(migration.applied_on).getTime();

  const records = await loadCoverageRecords(tx, facilityId, [patientId]);

  for (const key of ['covers', 'checks', 'elections', 'allocations', 'schedules'] as const) {
    records[key] = records[key].filter(
      (r) => Date.parse(r.createdOn) <= Date.parse(cutoff),
    ) as never;
  }

  const [
    chargeRows,
    paymentRows,
    adjustmentRows,
    refundRows,
    summaryRows,
    periods,
    zoneAt,
    entryRows,
    claimRows,
  ] = await Promise.all([
    tx`SELECT * FROM charges WHERE facility_id=${facilityId} AND patient_id=${patientId} AND currency=${currency} AND created_on<=${cutoff}`,
    tx`SELECT * FROM payments WHERE facility_id=${facilityId} AND patient_id=${patientId} AND currency=${currency} AND created_on<=${cutoff}`,
    tx`SELECT * FROM billing_adjustments WHERE facility_id=${facilityId} AND patient_id=${patientId} AND created_on<=${cutoff}`,
    tx`SELECT * FROM refunds WHERE facility_id=${facilityId} AND patient_id=${patientId} AND currency=${currency} AND created_on<=${cutoff}`,
    tx`SELECT * FROM coverage_financial_summaries WHERE facility_id=${facilityId} AND patient_id=${patientId}`,
    billingPeriods(tx, facilityId),
    facilityZoneAt(tx, facilityId),
    tx`SELECT * FROM encounter_entries WHERE facility_id=${facilityId} AND patient_id=${patientId} AND step='dispense'`,
    tx`SELECT * FROM insurance_claims WHERE facility_id=${facilityId} AND patient_id=${patientId} AND currency=${currency} AND created_on<=${cutoff} ORDER BY revision DESC`,
  ]);

  if (beforeMigration && claimRows.length) {
    throw Object.assign(
      new Error(
        'Historical claim-line membership was not recorded before the integrated Billing migration. Choose a later statement cutoff.',
      ),
      { statusCode: 409 },
    );
  }

  const charges = chargeRows.map((r) => fromRow<Charge>('charge', r));
  const entries = entryRows.map((r) => fromRow<EncounterEntry>('encounter_entry', r));

  const estimates = new Map(
    charges.map((charge) => [
      charge.id,
      estimateCoverage({
        charge,
        records,
        billingActive: inBillingPeriod(charge.createdOn, periods),
        serviceDate: serviceDateOf(charge.createdOn, zoneAt(charge.createdOn)),
        units: chargeUnits(
          charge,
          entries.find((e) => e.id === charge.dispenseEntryId),
        ),
      }),
    ]),
  );

  const latest = [
    ...new Map([...claimRows].reverse().map((c) => [String(c.claim_number), c])).values(),
  ];

  const claims: StatementClaim[] = [];

  for (const c of latest) {
    const revisions = claimRows
      .filter((r) => r.claim_number === c.claim_number)
      .map((r) => r.id as string);

    const [lines, paidRows, writeRows, decisions, events] = await Promise.all([
      tx`SELECT l.charge_id,d.payer_share_minor FROM insurance_claim_lines l JOIN coverage_allocation_details d ON d.facility_id=l.facility_id AND d.allocation_id=l.allocation_id WHERE l.facility_id=${facilityId} AND l.claim_id=${c.id} AND l.statement_recorded_on<=${cutoff}`,
      tx`SELECT COALESCE(SUM(a.amount_minor),0) AS n FROM insurance_remittance_allocations a JOIN insurance_remittances r ON r.id=a.remittance_id WHERE a.facility_id=${facilityId} AND a.claim_id=ANY(${revisions}) AND a.recorded_on<=${cutoff} AND r.recorded_on<=${cutoff} AND NOT EXISTS(SELECT 1 FROM insurance_remittance_reversals v WHERE v.remittance_id=r.id AND v.reversed_on<=${cutoff})`,
      tx`SELECT COALESCE(SUM(amount_minor),0) AS n FROM insurance_write_offs WHERE facility_id=${facilityId} AND claim_id=ANY(${revisions}) AND written_off_on<=${cutoff}`,
      tx`SELECT * FROM insurance_claim_decisions WHERE facility_id=${facilityId} AND claim_id=${c.id} AND recorded_on<=${cutoff} ORDER BY recorded_on DESC,id DESC`,
      tx`SELECT state FROM insurance_claim_events WHERE facility_id=${facilityId} AND claim_id=${c.id} AND at<=${cutoff} ORDER BY at DESC,id DESC LIMIT 1`,
    ]);

    const decision = decisions[0];
    const expected = lines.reduce((n, l) => n + Number(l.payer_share_minor), 0);
    const state = events[0]?.state ?? 'draft';
    claims.push({
      id: String(c.id),
      claimNumber: String(c.claim_number),
      payerName: records.payers.find((p) => p.id === c.payer_id)?.name ?? 'Insurer',
      chargeIds: lines.map((l) => String(l.charge_id)),
      settlement: claimSettlement({
        submitted: ['submitted', 'acknowledged'].includes(state),
        expectedMinor: expected,
        ...(decision
          ? {
              decision: {
                decision: decision.decision as PayerDecisionKind,
                approvedMinor: Number(decision.approved_minor),
              },
            }
          : {}),
        paidMinor: Number(paidRows[0].n),
        writtenOffMinor: Number(writeRows[0].n),
        openDisputeMinor: 0,
        today: cutoff.slice(0, 10),
      }),
    });
  }

  return patientStatement({
    patientId,
    patientName: patient.fullName,
    facilityName: facility.name,
    currency,
    cutoff,
    generatedOn: new Date().toISOString(),
    charges,
    payments: paymentRows.map((r) => fromRow<Payment>('payment', r)),
    adjustments: adjustmentRows.map((r) => fromRow<BillingAdjustment>('billing_adjustment', r)),
    refunds: refundRows.map((r) => fromRow<Refund>('refund', r)),
    allocations: records.allocations,
    summaries: summaryRows.map((r) =>
      fromRow<CoverageFinancialSummary>('coverage_financial_summary', r),
    ),
    estimates,
    claims,
    limitations: [
      'Insurer payments are recorded at claim level and are not allocated to individual charge rows.',
      'Statement cutoff uses the recorded financial event times. Later synchronized offline records can change a subsequent statement for the same period.',
    ],
  });
};
