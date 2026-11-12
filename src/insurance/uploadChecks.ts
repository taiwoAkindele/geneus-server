import { selfPayPermitted, serviceDateOf, type CoverCheck, type CoverageElection, type Payer, type PatientCover, type Payment } from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { chargePositions, chargesById, facilityTimeZone, loadCoverageRecords } from './coverage.ts';
import { insuranceEnabled } from './contracts.ts';

/**
 * What a cover, check or desk election's shape cannot say about other records.
 * Called inside the upload transaction, with the patient's records locked by
 * the caller's usual patient checks.
 */
export const insuranceUploadIssues = async (tx: Tx, record: PatientCover | CoverCheck | CoverageElection): Promise<string[]> => {
  if (!(await insuranceEnabled(tx, record.facilityId))) return ['Insurance is not enabled for this hospital yet'];
  if (record.type === 'patient_cover') {
    const payer = await findRecord<Payer>(tx, 'payer', record.payerId);
    if (!payer || payer.facilityId !== record.facilityId) return ['Choose a payer of this hospital'];
    if (!payer.active && !record.replaces) return ['This payer is no longer active'];
    if (record.replaces) {
      const previous = await findRecord<PatientCover>(tx, 'patient_cover', record.replaces);
      if (!previous || previous.facilityId !== record.facilityId || previous.patientId !== record.patientId) return ['A cover change must replace this patient\'s own cover'];
      const [later] = await tx`SELECT id FROM patient_covers WHERE facility_id = ${record.facilityId} AND replaces = ${record.replaces} LIMIT 1`;
      if (later) return ['This cover was already changed on another device. Review the current cover'];
    }
    return [];
  }
  if (record.type === 'cover_check') {
    const cover = await findRecord<PatientCover>(tx, 'patient_cover', record.coverId);
    if (!cover || cover.facilityId !== record.facilityId || cover.patientId !== record.patientId) return ['A check must name this patient\'s cover'];
    return [];
  }
  const cover = await findRecord<PatientCover>(tx, 'patient_cover', record.coverId);
  if (!cover || cover.facilityId !== record.facilityId || cover.patientId !== record.patientId) return ['An election must name this patient\'s cover'];
  const charges = await chargesById(tx, record.facilityId, record.chargeIds, true);
  if (charges.length !== record.chargeIds.length || charges.some((c) => c.patientId !== record.patientId)) return ['An election must name this patient\'s charges'];
  const [confirmed] = await tx`SELECT charge_id FROM coverage_allocations WHERE facility_id = ${record.facilityId} AND charge_id = ANY(${record.chargeIds}) LIMIT 1`;
  if (confirmed) return ['Insurance for a charge was already confirmed. Ask the insurance officer to review it'];
  if (record.kind === 'use_cover') return [];
  if (record.reason === 'not_eligible') {
    const check = await findRecord<CoverCheck>(tx, 'cover_check', record.coverCheckId!);
    if (!check || check.facilityId !== record.facilityId || check.coverId !== record.coverId || check.result !== 'not_eligible') return ['Name the check that found this cover not eligible'];
  }
  // Each charge is judged by the rule in force on its own date of service: a "not eligible"
  // check must cover that date, and a member's own choice needs that contract version to allow it.
  const timeZone = await facilityTimeZone(tx, record.facilityId);
  const records = await loadCoverageRecords(tx, record.facilityId, [record.patientId]);
  for (const charge of charges) {
    const serviceDate = serviceDateOf(charge.createdOn, timeZone);
    if (!serviceDate) return ["Record the hospital's time zone before recording insurance choices"];
    if (!selfPayPermitted(record, cover, serviceDate, records)) {
      return [record.reason === 'not_eligible'
        ? 'The check that found this cover not eligible does not cover the date of every charge'
        : 'This contract does not allow members to pay without their insurance on the date of service, or its rule is not recorded. Ask the insurance officer'];
    }
  }
  return [];
};

/**
 * Money that changed hands is always kept (see paymentRefusal). When it goes
 * beyond the patient's part of an insured charge — an older device, stale
 * cover data, or a payment while cover was undetermined — the server records
 * a review event naming the device and cashier so the credit is followed up.
 */
export const flagInsuredOverpayment = async (tx: Tx, payment: Payment): Promise<void> => {
  if (payment.reverses || payment.method === 'waiver') return;
  const charges = await chargesById(tx, payment.facilityId, payment.allocations.map((a) => a.chargeId));
  const positions = await chargePositions(tx, payment.facilityId, charges);
  const flagged = [...positions.values()].filter((p) => p.estimate.state !== 'self_pay' && p.estimate.state !== 'exempt' && p.balanceMinor < 0);
  if (!flagged.length) return;
  await recordAuditEvent(tx, {
    facilityId: payment.facilityId, deviceId: payment.deviceId, actorStaffId: payment.createdBy, action: 'create', entityType: 'payment', entityId: payment.id,
    metadata: { context: 'insurance_payment_review', charges: flagged.length, states: [...new Set(flagged.map((p) => p.estimate.state))].join(',') },
  });
};
