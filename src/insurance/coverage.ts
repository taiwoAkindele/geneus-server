import {
  chargeUnits, estimateCoverage, patientResponsibility, serviceDateOf,
  type Charge, type CoverageEstimate, type CoverageRecords, type CoverSchedule, type CoverageAllocation,
  type CoverageElection, type CoverCheck, type EncounterEntry, type Facility, type Payer, type PatientCover, type Payment, type Refund, inBillingPeriod, timeZoneAt,
} from '#shared';
import { billingPeriods } from './billingPeriods.ts';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord, fromRow } from '../db/records.ts';

type Row = Record<string, unknown>;

/**
 * Everything the shared estimate needs for some patients, read from the same
 * records a device holds. The server never estimates from anything a device
 * could not also see, so their answers can only differ by staleness.
 */
export const loadCoverageRecords = async (sql: Sql | Tx, facilityId: string, patientIds: readonly string[]): Promise<CoverageRecords & { payers: Payer[] }> => {
  const ids = [...new Set(patientIds)];
  const [covers, checks, elections, allocations, schedules, payers] = await Promise.all([
    sql<Row[]>`SELECT * FROM patient_covers WHERE facility_id = ${facilityId} AND patient_id = ANY(${ids})`,
    sql<Row[]>`SELECT * FROM cover_checks WHERE facility_id = ${facilityId} AND patient_id = ANY(${ids})`,
    sql<Row[]>`SELECT * FROM coverage_elections WHERE facility_id = ${facilityId} AND patient_id = ANY(${ids})`,
    sql<Row[]>`SELECT * FROM coverage_allocations WHERE facility_id = ${facilityId} AND patient_id = ANY(${ids})`,
    sql<Row[]>`SELECT * FROM cover_schedules WHERE facility_id = ${facilityId}`,
    sql<Row[]>`SELECT * FROM payers WHERE facility_id = ${facilityId}`,
  ]);
  return {
    covers: covers.map((r) => fromRow<PatientCover>('patient_cover', r)),
    checks: checks.map((r) => fromRow<CoverCheck>('cover_check', r)),
    elections: elections.map((r) => fromRow<CoverageElection>('coverage_election', r)),
    allocations: allocations.map((r) => fromRow<CoverageAllocation>('coverage_allocation', r)),
    schedules: schedules.map((r) => fromRow<CoverSchedule>('cover_schedule', r)),
    payers: payers.map((r) => fromRow<Payer>('payer', r)),
  };
};

export const facilityTimeZone = async (sql: Sql | Tx, facilityId: string): Promise<string | undefined> =>
  (await findRecord<Facility>(sql, 'facility', facilityId))?.timeZone;
/** The zone in force when a moment happened: a correction never re-dates what was raised before it. */
export const facilityZoneAt = async (sql: Sql | Tx, facilityId: string) => { const facility = await findRecord<Facility>(sql, 'facility', facilityId); return (at: string) => timeZoneAt(facility, at); };

/** The money already recorded against one charge. Reversals subtract; nothing is removed. */
export type ChargeMoney = { receivedMinor: number; waivedByPaymentMinor: number; reducedMinor: number; refundedMinor: number };

const moneyFor = async (sql: Sql | Tx, facilityId: string, chargeIds: readonly string[]): Promise<Map<string, ChargeMoney>> => {
  const money = new Map(chargeIds.map((id) => [id, { receivedMinor: 0, waivedByPaymentMinor: 0, reducedMinor: 0, refundedMinor: 0 }]));
  if (!chargeIds.length) return money;
  const [payments, adjustments, refunds] = await Promise.all([
    sql<Row[]>`SELECT * FROM payments WHERE facility_id = ${facilityId} AND EXISTS (SELECT 1 FROM jsonb_array_elements(allocations) a WHERE a->>'chargeId' = ANY(${chargeIds as string[]}))`,
    sql<{ charge_id: string; amount_minor: number }[]>`SELECT charge_id, amount_minor FROM billing_adjustments WHERE facility_id = ${facilityId} AND charge_id = ANY(${chargeIds as string[]})`,
    sql<Row[]>`SELECT * FROM refunds WHERE facility_id = ${facilityId} AND EXISTS (SELECT 1 FROM jsonb_array_elements(allocations) a WHERE a->>'chargeId' = ANY(${chargeIds as string[]}))`,
  ]);
  for (const payment of payments.map((r) => fromRow<Payment>('payment', r))) {
    for (const allocation of payment.allocations) {
      const entry = money.get(allocation.chargeId);
      if (!entry) continue;
      const amount = allocation.amountMinor * (payment.reverses ? -1 : 1);
      if (payment.method === 'waiver') entry.waivedByPaymentMinor += amount; else entry.receivedMinor += amount;
    }
  }
  for (const adjustment of adjustments) money.get(adjustment.charge_id)!.reducedMinor += adjustment.amount_minor;
  for (const refund of refunds.map((r) => fromRow<Refund>('refund', r))) {
    for (const allocation of refund.allocations) {
      const entry = money.get(allocation.chargeId);
      if (entry) entry.refundedMinor += allocation.amountMinor;
    }
  }
  return money;
};

export type ChargePosition = {
  charge: Charge;
  estimate: CoverageEstimate;
  money: ChargeMoney;
  /** What the patient is responsible for, before reductions and money. */
  baseMinor: number;
  undeterminedMinor: number;
  /** base − reductions − payments (incl. waivers) + refunds. Negative is a credit. */
  balanceMinor: number;
  /** Responsibility can no longer change: the condition for refunding a credit. */
  final: boolean;
};

/**
 * The patient's position on each charge, using the shared estimate. Callers
 * that decide on money must already hold the charge rows `FOR UPDATE`.
 */
export const chargePositions = async (sql: Sql | Tx, facilityId: string, charges: readonly Charge[]): Promise<Map<string, ChargePosition>> => {
  const positions = new Map<string, ChargePosition>();
  if (!charges.length) return positions;
  const [records, timeZone, money, state] = await Promise.all([
    loadCoverageRecords(sql, facilityId, charges.map((c) => c.patientId)),
    facilityZoneAt(sql, facilityId),
    moneyFor(sql, facilityId, charges.map((c) => c.id)),
    billingPeriods(sql, facilityId),
  ]);
  // Cover changes a balance only for charges raised while billing was active; confirmed splits always stand.
  const periods = state;
  const dispenseIds = charges.map((c) => c.dispenseEntryId).filter((id): id is string => Boolean(id));
  const entries = new Map<string, EncounterEntry>();
  if (dispenseIds.length) {
    for (const row of await sql<Row[]>`SELECT * FROM encounter_entries WHERE facility_id = ${facilityId} AND id = ANY(${dispenseIds})`) {
      const entry = fromRow<EncounterEntry>('encounter_entry', row);
      entries.set(entry.id, entry);
    }
  }
  for (const charge of charges) {
    const estimate = estimateCoverage({
      charge, records, billingActive: inBillingPeriod(charge.createdOn, periods), serviceDate: serviceDateOf(charge.createdOn, timeZone(charge.createdOn)),
      units: chargeUnits(charge, charge.dispenseEntryId ? entries.get(charge.dispenseEntryId) : undefined),
    });
    const responsibility = patientResponsibility(charge, estimate);
    const m = money.get(charge.id)!;
    positions.set(charge.id, {
      charge, estimate, money: m, baseMinor: responsibility.baseMinor, undeterminedMinor: responsibility.undeterminedMinor, final: responsibility.final,
      balanceMinor: responsibility.baseMinor - m.reducedMinor - m.receivedMinor - m.waivedByPaymentMinor + m.refundedMinor,
    });
  }
  return positions;
};

export const chargesById = async (sql: Sql | Tx, facilityId: string, ids: readonly string[], lock = false): Promise<Charge[]> => {
  const sorted = [...new Set(ids)].sort();
  const rows = lock
    ? await sql<Row[]>`SELECT * FROM charges WHERE facility_id = ${facilityId} AND id = ANY(${sorted}) ORDER BY id FOR UPDATE`
    : await sql<Row[]>`SELECT * FROM charges WHERE facility_id = ${facilityId} AND id = ANY(${sorted}) ORDER BY id`;
  return rows.map((r) => fromRow<Charge>('charge', r));
};
