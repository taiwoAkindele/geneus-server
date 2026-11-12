import {
  CALCULATION_VERSION, CoverageAllocation, SCHEMA_VERSION, chargeUnits, computeAllocation, currentAllocation, estimateCoverage,
  isRoutine, scheduleOn, serviceDateOf, splitBalances, type Charge, type CoverageEstimate, type CoverSchedule, type EncounterEntry,
} from '#shared';
import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/client.ts';
import { fromRow, insertRecord } from '../db/records.ts';
import { chargePositions, chargesById, facilityTimeZone, loadCoverageRecords } from './coverage.ts';
import { findContractVersion } from './contracts.ts';

export type ConfirmRequest = {
  facilityId: string; deviceId: string; staffId: string; requestKey: string;
  chargeIds: string[]; basis: 'visit' | 'routine_bulk' | 'exception'; decision: 'apply_cover' | 'self_pay'; reason?: string;
};
export type ConfirmOutcome = { chargeId: string; outcome: 'confirmed'; allocationId: string; state: CoverageAllocation['state']; patientShareMinor: number }
  | { chargeId: string; outcome: 'skipped'; reason: string };

/**
 * Confirms charges, each under its row lock, recalculating on the server from
 * the confidential contract. Routine charges (`visit`, `routine_bulk`) need no
 * reason; anything else is an `exception` that must give one. A charge whose
 * state differs from what the request expects is skipped and reported, never
 * forced. A charge already confirmed is corrected only as an exception, which
 * writes a new snapshot superseding the old one.
 */
export const confirmAllocations = async (tx: Tx, request: ConfirmRequest): Promise<ConfirmOutcome[]> => {
  const charges = await chargesById(tx, request.facilityId, request.chargeIds, true);
  const found = new Set(charges.map((c) => c.id));
  const outcomes: ConfirmOutcome[] = request.chargeIds.filter((id) => !found.has(id)).map((chargeId) => ({ chargeId, outcome: 'skipped', reason: 'not_found' }));
  if (!charges.length) return outcomes;
  const [records, timeZone, positions] = await Promise.all([
    loadCoverageRecords(tx, request.facilityId, charges.map((c) => c.patientId)),
    facilityTimeZone(tx, request.facilityId),
    chargePositions(tx, request.facilityId, charges),
  ]);
  const dispenseIds = charges.map((c) => c.dispenseEntryId).filter((id): id is string => Boolean(id));
  const entries = new Map((dispenseIds.length ? await tx`SELECT * FROM encounter_entries WHERE facility_id = ${request.facilityId} AND id = ANY(${dispenseIds})` : [])
    .map((row) => { const e = fromRow<EncounterEntry>('encounter_entry', row); return [e.id, e] as const; }));
  const now = new Date().toISOString();

  for (const charge of charges) {
    const skip = (reason: string) => outcomes.push({ chargeId: charge.id, outcome: 'skipped', reason });
    const current = currentAllocation(charge.id, records.allocations);
    if (current && request.basis !== 'exception') { skip('already_confirmed'); continue; }
    const serviceDate = serviceDateOf(charge.createdOn, timeZone);
    const units = chargeUnits(charge, charge.dispenseEntryId ? entries.get(charge.dispenseEntryId) : undefined);
    // A correction re-derives the estimate as if the old snapshot did not exist.
    // An exception that applies cover also sets aside the patient's earlier self-pay choice for this charge:
    // the choice stays on record, and any payment it led to becomes a credit to refund.
    const overrideChoice = request.basis === 'exception' && request.decision === 'apply_cover';
    const elections = overrideChoice ? records.elections.filter((e) => !(e.kind === 'self_pay' && e.chargeIds.includes(charge.id))) : records.elections;
    const estimate: CoverageEstimate = estimateCoverage({ charge, serviceDate, units, records: { ...records, elections, allocations: records.allocations.filter((a) => a.chargeId !== charge.id) } });
    const money = positions.get(charge.id)!.money;
    const paid = money.receivedMinor + money.waivedByPaymentMinor - money.refundedMinor;
    const base = { id: `coverage_allocation:${randomUUID()}`, type: 'coverage_allocation' as const, facilityId: request.facilityId, schemaVersion: SCHEMA_VERSION,
      createdBy: request.staffId, createdOn: now, deviceId: request.deviceId, patientId: charge.patientId, chargeId: charge.id,
      currency: charge.currency, basis: request.basis, ...(current ? { supersedes: current.id } : {}) };

    if (request.decision === 'self_pay') {
      const outcome = await confirmSelfPay(tx, request, charge, estimate, records.schedules, serviceDate, base);
      if ('reason' in outcome) skip(outcome.reason); else outcomes.push(outcome);
      continue;
    }
    if (estimate.state !== 'estimated') { skip(estimate.state === 'undetermined' ? `undetermined:${estimate.reason}` : `nothing_to_confirm:${estimate.state}`); continue; }
    if (request.basis !== 'exception' && !isRoutine(estimate, paid)) { skip('not_routine'); continue; }
    const version = await findContractVersion(tx, request.facilityId, estimate.schedule.contractVersionId);
    if (!version || version.status !== 'active') { skip('contract_unavailable'); continue; }
    const computed = computeAllocation({ terms: version.terms, planCode: estimate.cover.planCode, charge, units });
    if (!computed.ok) { skip(`undetermined:${computed.reason}`); continue; }
    // The device estimated from the schedule; the confirmation uses the terms. They must agree exactly.
    if (computed.split.patientShareMinor !== estimate.patientShareMinor || !splitBalances(computed.split, charge.listPriceMinor)) { skip('schedule_mismatch'); continue; }
    const allocation = CoverageAllocation.parse({ ...base, state: 'finalised', payerId: estimate.cover.payerId, arrangement: computed.split.arrangement, patientShareMinor: computed.split.patientShareMinor });
    await insertRecord(tx, 'coverage_allocation', allocation);
    await insertDetails(tx, request, allocation.id, charge.listPriceMinor, computed.split, {
      calculationVersion: CALCULATION_VERSION, listPriceMinor: charge.listPriceMinor, currency: charge.currency, serviceDate, units,
      feeItemId: charge.feeItemId, category: charge.category,
      cover: { id: estimate.cover.id, payerId: estimate.cover.payerId, planCode: estimate.cover.planCode, enrolleeNumber: estimate.cover.enrolleeNumber },
      check: { id: estimate.check.id, result: estimate.check.result, coversFrom: estimate.check.coversFrom, coversTo: estimate.check.coversTo, method: estimate.check.method, reference: estimate.check.reference ?? null },
      election: estimate.election?.id ?? null,
      overriddenSelfPayChoices: overrideChoice ? records.elections.filter((e) => e.kind === 'self_pay' && e.chargeIds.includes(charge.id)).map((e) => e.id) : [],
      contractVersionId: version.id, scheduleId: estimate.schedule.id, planCode: estimate.cover.planCode,
      rule: computed.rule, tariffUnitMinor: computed.tariffUnitMinor ?? null,
      // The exact terms the arithmetic used, so the snapshot recomputes without the contract.
      termsSlice: sliceTerms(version.terms, estimate.cover.planCode, charge),
    });
    outcomes.push({ chargeId: charge.id, outcome: 'confirmed', allocationId: allocation.id, state: 'finalised', patientShareMinor: allocation.patientShareMinor });
  }
  return outcomes;
};

/** Only the parts of the terms that decided this charge — enough to recompute it exactly. */
const sliceTerms = (terms: import('#shared').PayerContractTerms, planCode: string, charge: Pick<Charge, 'feeItemId' | 'category'>) => {
  const plan = terms.plans.find((p) => p.planCode === planCode)!;
  const item = <T>(record: Record<string, T>) => (charge.feeItemId in record ? { [charge.feeItemId]: record[charge.feeItemId] } : {});
  return {
    payerId: terms.payerId, effectiveFrom: terms.effectiveFrom, ...(terms.effectiveTo ? { effectiveTo: terms.effectiveTo } : {}), currency: terms.currency,
    arrangements: { categories: { ...(terms.arrangements.categories[charge.category] ? { [charge.category]: terms.arrangements.categories[charge.category] } : {}) }, items: item(terms.arrangements.items) },
    tariff: item(terms.tariff),
    plans: [{ planCode: plan.planCode, name: plan.name, rules: { categories: { ...(plan.rules.categories[charge.category] ? { [charge.category]: plan.rules.categories[charge.category] } : {}) }, items: item(plan.rules.items) } }],
  };
};

const insertDetails = async (tx: Tx, request: ConfirmRequest, allocationId: string, listPriceMinor: number,
  split: { patientShareMinor: number; payerShareMinor: number; contractAdjustmentMinor: number; capitationCoveredMinor: number }, inputs: Record<string, unknown>) => {
  await tx`INSERT INTO coverage_allocation_details (allocation_id, facility_id, calculation_version, inputs, list_price_minor, patient_share_minor, payer_share_minor, contract_adjustment_minor, capitation_covered_minor, reason, request_key)
    VALUES (${allocationId}, ${request.facilityId}, ${CALCULATION_VERSION}, ${tx.json(inputs as never)}, ${listPriceMinor}, ${split.patientShareMinor}, ${split.payerShareMinor}, ${split.contractAdjustmentMinor}, ${split.capitationCoveredMinor}, ${request.reason ?? null}, ${request.requestKey})`;
};

/**
 * An officer recording that the patient pays without insurance. A contractual
 * prohibition is final: no reason overrides `not_allowed`. Exclusions bill the
 * patient only where the contract says `patient_pays`, so an excluded service
 * marked not billable — or with no liability recorded — is refused here too.
 */
const confirmSelfPay = async (tx: Tx, request: ConfirmRequest, charge: Charge, estimate: CoverageEstimate, schedules: readonly CoverSchedule[], serviceDate: string | undefined, base: Record<string, unknown>): Promise<ConfirmOutcome | { reason: string }> => {
  if (request.basis !== 'exception' || !request.reason) return { reason: 'reason_required' };
  if (estimate.state === 'undetermined' && (estimate.reason === 'not_billable_to_patient' || estimate.reason === 'exclusion_liability_not_configured')) return { reason: 'patient_liability_not_permitted' };
  if (estimate.state === 'undetermined' && estimate.reason === 'choose_cover') return { reason: 'choose_cover_first' };
  const cover = 'cover' in estimate ? estimate.cover : undefined;
  if (!cover) return { reason: `nothing_to_confirm:${estimate.state}` };
  if (!serviceDate) return { reason: 'timezone_required' };
  // The rule is the contract version in force on the date of service, not today's.
  const schedule = scheduleOn(cover.payerId, cover.planCode, serviceDate, schedules);
  if (schedule?.selfPayElection === 'not_allowed') return { reason: 'self_pay_prohibited_by_payer' };
  const allocation = CoverageAllocation.parse({ ...base, state: 'self_pay_confirmed', payerId: cover.payerId, patientShareMinor: charge.amountMinor });
  await insertRecord(tx, 'coverage_allocation', allocation);
  await insertDetails(tx, request, allocation.id, charge.listPriceMinor, { patientShareMinor: charge.listPriceMinor, payerShareMinor: 0, contractAdjustmentMinor: 0, capitationCoveredMinor: 0 }, {
    calculationVersion: CALCULATION_VERSION, decision: 'self_pay', listPriceMinor: charge.listPriceMinor, currency: charge.currency,
    cover: { id: cover.id, payerId: cover.payerId, planCode: cover.planCode }, priorState: estimate.state,
    ...(estimate.state === 'undetermined' ? { priorReason: estimate.reason } : {}), serviceDate, scheduleId: schedule?.id ?? null, selfPayRule: schedule?.selfPayElection ?? 'not_recorded',
  });
  return { chargeId: charge.id, outcome: 'confirmed', allocationId: allocation.id, state: 'self_pay_confirmed', patientShareMinor: allocation.patientShareMinor };
};
