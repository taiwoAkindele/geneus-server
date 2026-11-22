import { billKey, billKeyParts, billReference, type BillStatus, type BillView, type Charge, type DocumentHospital, type DocumentPatient, type Facility, type FeeCategory, type Patient, type Payment, type ReceiptView, type Staff } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord, fromRow } from '../db/records.ts';
import { chargePositions, type ChargePosition } from '../insurance/coverage.ts';

/**
 * What a patient's bill or receipt shows, built on the server from accepted records with the same balance
 * rules as the app (undecided insurance is never part of the amount due; currencies are never mixed).
 * Only this patient's records are read.
 */
type Row = Record<string, unknown>;
export type { BillView, ReceiptView };

const CATEGORY: Record<FeeCategory, string> = {
  registration: 'Registration', card: 'Patient card', consultation: 'Consultation', laboratory: 'Laboratory', procedure: 'Procedures',
  other: 'Other', pharmacy: 'Pharmacy', maternity: 'Maternity', admission: 'Admission', imaging: 'Imaging',
};
const METHOD: Record<Payment['method'], string> = { cash: 'Cash', transfer: 'Bank transfer', pos: 'Card (POS)', waiver: 'Waiver', online: 'Paid online' };

const header = async (sql: Sql | Tx, facilityId: string): Promise<DocumentHospital | undefined> => {
  const facility = await findRecord<Facility>(sql, 'facility', facilityId);
  return facility ? { name: facility.name, address: facility.address, phone: facility.phone, email: facility.email, timeZone: facility.timeZone ?? 'Africa/Lagos' } : undefined;
};
const patientOf = async (sql: Sql | Tx, facilityId: string, patientId: string): Promise<DocumentPatient | undefined> => {
  const patient = await findRecord<Patient>(sql, 'patient', patientId);
  return patient && patient.facilityId === facilityId ? { name: patient.fullName, patientId: patient.patientId, phone: patient.phone } : undefined;
};
const chargesOf = async (sql: Sql | Tx, facilityId: string, patientId: string, currency: string): Promise<Charge[]> =>
  (await sql<Row[]>`SELECT * FROM charges WHERE facility_id = ${facilityId} AND patient_id = ${patientId} AND currency = ${currency}`).map((r) => fromRow<Charge>('charge', r));

const totalsOf = (positions: readonly ChargePosition[]) => {
  const sum = (f: (p: ChargePosition) => number) => positions.reduce((n, p) => n + f(p), 0);
  const subtotalMinor = sum((p) => p.charge.listPriceMinor);
  const exemptMinor = sum((p) => (p.charge.exemptionReason ? p.charge.listPriceMinor : 0));
  const reducedMinor = sum((p) => p.money.reducedMinor + p.money.waivedByPaymentMinor);
  const undecidedMinor = sum((p) => p.undeterminedMinor);
  // What insurance has been decided to pay: everything the patient isn't responsible for, apart from the undecided part.
  const insuranceMinor = sum((p) => p.charge.amountMinor - p.baseMinor - p.undeterminedMinor);
  const paidMinor = sum((p) => p.money.receivedMinor - p.money.refundedMinor);
  const dueMinor = sum((p) => Math.max(0, p.balanceMinor));
  const creditMinor = sum((p) => Math.max(0, -p.balanceMinor));
  return { subtotalMinor, exemptMinor, reducedMinor, insuranceMinor, undecidedMinor, totalMinor: subtotalMinor - exemptMinor - reducedMinor - insuranceMinor - undecidedMinor, paidMinor, dueMinor, creditMinor };
};
const statusOf = (t: BillView['totals']): BillStatus => t.undecidedMinor ? 'Awaiting insurance' : t.dueMinor ? (t.paidMinor > 0 ? 'Part paid' : 'Unpaid') : 'Paid';

/** The bill a key names, or undefined when it has no charges (or isn't this hospital's). */
export const loadBill = async (sql: Sql | Tx, facilityId: string, key: string): Promise<BillView | undefined> => {
  const parts = billKeyParts(key);
  if (!parts) return undefined;
  const charges = (await chargesOf(sql, facilityId, parts.patientId, parts.currency)).filter((c) => billKey(c) === key)
    .sort((a, b) => a.createdOn.localeCompare(b.createdOn) || a.id.localeCompare(b.id));
  const [hospital, patient] = await Promise.all([header(sql, facilityId), patientOf(sql, facilityId, parts.patientId)]);
  if (!charges.length || !hospital || !patient) return undefined;
  const positions = await chargePositions(sql, facilityId, charges);
  const totals = totalsOf(charges.map((c) => positions.get(c.id)!));
  return {
    key, reference: billReference(key), currency: parts.currency, issuedOn: charges[0].createdOn, status: statusOf(totals), hospital, patient, totals,
    // Paying online arrives with the checkout (plan step 6).
    payable: false,
    lines: charges.map((c) => {
      const quantity = c.quantity ?? 1;
      return { description: c.description, category: CATEGORY[c.category] ?? 'Other', quantity, unitMinor: c.unitPriceMinor ?? Math.round(c.listPriceMinor / quantity), amountMinor: c.listPriceMinor, exempt: Boolean(c.exemptionReason) };
    }),
  };
};

/** A payment's receipt, or undefined for a waiver (it isn't money received) or another hospital's payment. */
export const loadReceipt = async (sql: Sql | Tx, facilityId: string, paymentId: string): Promise<ReceiptView | undefined> => {
  const payment = await findRecord<Payment>(sql, 'payment', paymentId);
  if (!payment || payment.facilityId !== facilityId || payment.method === 'waiver') return undefined;
  const [hospital, patient] = await Promise.all([header(sql, facilityId), patientOf(sql, facilityId, payment.patientId)]);
  if (!hospital || !patient) return undefined;
  const all = await chargesOf(sql, facilityId, payment.patientId, payment.currency);
  const byId = new Map(all.map((c) => [c.id, c]));
  const touched = payment.allocations.map((a) => byId.get(a.chargeId)).filter((c): c is Charge => Boolean(c));
  const keys = [...new Set(touched.map(billKey))];
  const billCharges = all.filter((c) => keys.includes(billKey(c)));
  const positions = await chargePositions(sql, facilityId, billCharges);
  const staff = payment.createdBy === 'system' ? undefined : await findRecord<Staff>(sql, 'staff', payment.createdBy);
  return {
    paymentId: payment.id, number: payment.receiptNumber, currency: payment.currency, receivedOn: payment.createdOn,
    method: METHOD[payment.method] ?? payment.method, reference: payment.reference, reversal: Boolean(payment.reverses),
    receivedBy: payment.method === 'online'
      ? 'Online payment'
      : staff?.facilityId === facilityId
        ? staff.fullName
        : payment.incomingTransferId ? 'Bank transfer (confirmed automatically)' : 'Hospital staff',
    hospital, patient, amountMinor: payment.amountMinor,
    applied: payment.allocations.flatMap((a) => { const c = byId.get(a.chargeId); return c ? [{ bill: billReference(billKey(c)), item: c.description, amountMinor: a.amountMinor }] : []; }),
    stillDue: keys.map((key) => ({ bill: billReference(key), dueMinor: billCharges.filter((c) => billKey(c) === key).reduce((n, c) => n + Math.max(0, positions.get(c.id)!.balanceMinor), 0) }))
      .filter((b) => b.dueMinor > 0),
  };
};

/** "NGN 20,500.00": amounts are minor units with two decimals; currencies are never converted. */
export const money = (minor: number, currency: string) =>
  `${currency} ${(minor / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const when = (iso: string, timeZone: string, withTime = false) =>
  new Date(iso).toLocaleString('en-GB', { timeZone, day: '2-digit', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
