import { dispensingDetails, pharmacyIssues, pharmacyEffects, type AnyDocument, type Encounter, type Appointment, type EncounterEntry, type StockItem, type StockMovement, type FeeItem, type Charge, type BillingAdjustment, type Patient, type WardCareEvent, type PharmacyRecords } from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord, fromRow } from '../db/records.ts';

export const pharmacyRecords = async (tx: Tx, entry: EncounterEntry): Promise<PharmacyRecords> => {
  const encounter = await findRecord<Encounter>(tx, 'encounter', entry.encounterId);
  const appointment = encounter?.appointmentId ? await findRecord<Appointment>(tx, 'appointment', encounter.appointmentId) : undefined;
  const [entries, items, movements, fees, charges, adjustments, wardEvents, patient] = await Promise.all([
    tx`SELECT * FROM encounter_entries WHERE facility_id=${entry.facilityId} AND encounter_id=${entry.encounterId} ORDER BY created_on,id`,
    tx`SELECT * FROM stock_items WHERE facility_id=${entry.facilityId}`,
    tx`SELECT * FROM stock_movements WHERE facility_id=${entry.facilityId}`,
    tx`SELECT * FROM fee_items WHERE facility_id=${entry.facilityId}`,
    tx`SELECT * FROM charges WHERE facility_id=${entry.facilityId} AND patient_id=${entry.patientId}`,
    tx`SELECT * FROM billing_adjustments WHERE facility_id=${entry.facilityId} AND patient_id=${entry.patientId}`,
    tx`SELECT * FROM ward_care_events WHERE facility_id=${entry.facilityId} AND patient_id=${entry.patientId}`,
    findRecord<Patient>(tx, 'patient', entry.patientId),
  ]);
  return { visitType: encounter?.visitType ?? appointment?.visitType, entries: entries.map((r) => fromRow<EncounterEntry>('encounter_entry', r)), items: items.map((r) => fromRow<StockItem>('stock_item', r)), movements: movements.map((r) => fromRow<StockMovement>('stock_movement', r)), fees: fees.map((r) => fromRow<FeeItem>('fee_item', r)), charges: charges.map((r) => fromRow<Charge>('charge', r)), adjustments: adjustments.map((r) => fromRow<BillingAdjustment>('billing_adjustment', r)), wardEvents: wardEvents.map((r) => fromRow<WardCareEvent>('ward_care_event', r)), patient };
};
export const pharmacyUpload = async (tx: Tx, entry: EncounterEntry): Promise<{ issues: string[]; effects: AnyDocument[] }> => {
  const data = await pharmacyRecords(tx, entry), d = dispensingDetails(entry);
  if ((d?.action === 'supply' || d?.action === 'price') && d.billing === 'charge' && d.feePriceVersion) {
    const [version] = await tx`SELECT amount_minor,currency FROM fee_price_versions WHERE facility_id=${entry.facilityId} AND id=${d.feePriceVersion} AND fee_item_id=${d.feeItemId!}`;
    if (!version || Number(version.amount_minor) !== d.unitPriceMinor || version.currency !== d.currency) return { issues: ['The medicine price does not match its signed facility price version'], effects: [] };
    data.fees = data.fees.map((fee) => fee.id === d.feeItemId ? { ...fee, amountMinor: d.unitPriceMinor!, currency: d.currency! } : fee);
  }
  const issues = pharmacyIssues(entry, data);
  return { issues, effects: issues.length ? [] : pharmacyEffects(entry, data) };
};
/** A client may upload its locally derived companions only after the parent accepted them atomically. */
export const pharmacyCompanionMatches = async (tx: Tx, record: AnyDocument): Promise<boolean> => {
  if (!('dispenseEntryId' in record) || !record.dispenseEntryId) return false;
  const existing = await findRecord(tx, record.type, record.id);
  const parent = await findRecord<EncounterEntry>(tx, 'encounter_entry', record.dispenseEntryId);
  return Boolean(existing && parent?.pharmacyVersion === 1 && existing.facilityId === parent.facilityId && existing.createdBy === parent.createdBy && JSON.stringify(normalize(existing)) === JSON.stringify(normalize(record)));
};
const normalize = (value: unknown): unknown => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(normalize) : Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)])) : value;
