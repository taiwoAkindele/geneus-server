import { findExemption, patientAge, isLegacyFeeCategory, usesBillingCatalogue, type Charge, type FeeItem, type Patient, type UploadRequest, type StockItem } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';

export class BillingCompatibilityError extends Error { statusCode = 409; code = 'upgrade_required'; }
export const catalogueEnabled = async (sql: Sql | Tx, facilityId: string) => Boolean((await sql`SELECT billing_catalogue_version FROM facilities WHERE id=${facilityId}`)[0]?.billing_catalogue_version);
export const catalogueReadiness = async (sql: Sql | Tx, facilityId: string, now = Date.now()) => {
  const devices = await sql`SELECT d.id,d.label,v.billing_catalogue_version,v.pending_mutation_count,v.recorded_on,v.legacy_billing_token_expires_on
    FROM devices d LEFT JOIN workforce_client_versions v ON v.device_id=d.id WHERE d.facility_id=${facilityId} AND d.status='active' ORDER BY d.id`;
  const [migration] = await sql`SELECT applied_on FROM schema_migrations WHERE version=41`;
  // Revocation prevents new tokens; already issued JWTs still live until expiry.
  const [tokens]=await sql`SELECT MAX(legacy_billing_token_expires_on) AS expires_on FROM workforce_client_versions WHERE facility_id=${facilityId}`;
  const legacyUntil = new Date(Math.max(new Date(migration?.applied_on ?? now).getTime()+86400000,tokens.expires_on?new Date(tokens.expires_on).getTime():0)).toISOString();
  return { enabled: await catalogueEnabled(sql,facilityId), legacyTokensUntil: legacyUntil,
    devices: devices.map((d) => ({ id: String(d.id), label: d.label as string | null, blockers: [
      ...(d.billing_catalogue_version !== 1 ? ['Upgrade this device to the current Billing catalogue reader'] : []),
      ...(d.pending_mutation_count !== 0 ? ['Upload and review pending work'] : []),
      ...(!d.recorded_on || new Date(d.recorded_on).getTime() < now-86400000 ? ['Connect this device for a fresh status report'] : []),
      ...(d.legacy_billing_token_expires_on && new Date(d.legacy_billing_token_expires_on).getTime()>now ? ['An older sync token is still valid'] : []),
    ] })) };
};
/** Called under the existing facility lock; no per-item activation or automatic device retirement. */
export const negotiateCatalogue = async (tx: Tx, identity: {facilityId:string;deviceId:string}, version: number | undefined, tokenTtlSeconds: number, now = Date.now()) => {
  if (version !== 1) {
    if (await catalogueEnabled(tx,identity.facilityId)) throw new BillingCompatibilityError('Update this device before opening financial records. Its pending work is retained.');
    await tx`UPDATE workforce_client_versions SET legacy_billing_token_expires_on=GREATEST(legacy_billing_token_expires_on,${new Date(now+tokenTtlSeconds*1000).toISOString()}::timestamptz) WHERE device_id=${identity.deviceId}`;
    return false;
  }
  if (await catalogueEnabled(tx,identity.facilityId)) return true;
  const readiness = await catalogueReadiness(tx,identity.facilityId,now);
  if (readiness.devices.length && readiness.devices.every((d)=>!d.blockers.length) && Date.parse(readiness.legacyTokensUntil)<=now) {
    await tx`UPDATE facilities SET billing_catalogue_version=1 WHERE id=${identity.facilityId}`;
    await recordAuditEvent(tx,{facilityId:identity.facilityId,deviceId:identity.deviceId,action:'update',metadata:{context:'billing_catalogue_compatible_readers'}});
    return true;
  }
  return false;
};
export const assertCatalogueUpload = async (tx: Tx, facilityId: string, request: UploadRequest) => {
  const enabled = await catalogueEnabled(tx,facilityId);
  if (enabled && (request.billingCatalogueVersion !== 1 || (request.schemaVersion??0)<6)) throw new BillingCompatibilityError('Update this device before uploading. Pending records have not been acknowledged.');
  if (request.mutations.some(usesBillingCatalogue) && (!enabled || request.billingCatalogueVersion !== 1 || (request.schemaVersion ?? 0)<6)) throw new BillingCompatibilityError('The new Billing catalogue is waiting for compatible active devices and sync tokens. Existing cash and catalogue records remain available.');
};
export const stockPriceIssue = async (tx: Tx, record: StockItem, current?: StockItem) => {
  if (!record.feeItemId || record.feeItemId===current?.feeItemId) return undefined;
  const fee=await findRecord<FeeItem>(tx,'fee_item',record.feeItemId);
  return !fee || fee.facilityId!==record.facilityId || !fee.active || fee.category!=='pharmacy' ? 'New stock links must select an active central Pharmacy item in this facility' : undefined;
};

/** New evidence is checked against its immutable version, never today's price. Legacy rows keep their path. */
export const chargePriceIssues = async (tx: Tx, charge: Charge): Promise<string[]> => {
  if (charge.servicePointId && !(await tx`SELECT 1 FROM locations WHERE facility_id=${charge.facilityId} AND id=${charge.servicePointId}`).length) return ['Choose a recorded service point in this facility'];
  if (!charge.feePriceVersion) return !isLegacyFeeCategory(charge.category) || (charge.schemaVersion>=6 && !charge.dispenseEntryId && !charge.orderItemId && await catalogueEnabled(tx,charge.facilityId)) ? ['New catalogue charges require immutable price and quantity evidence'] : [];
  const [version] = await tx`SELECT * FROM fee_price_versions WHERE facility_id=${charge.facilityId} AND fee_item_id=${charge.feeItemId} AND id=${charge.feePriceVersion}`;
  if (!version || Number(version.amount_minor)!==charge.unitPriceMinor || version.currency!==charge.currency || version.category!==charge.category || !Array.isArray(version.exemptions)) return ['The charge must retain its selected facility price version'];
  const patient = await findRecord<Patient>(tx,'patient',charge.patientId);
  if (!patient) return ['The charge patient is unavailable'];
  const [visit] = charge.encounterId ? await tx`SELECT visit_type FROM encounters WHERE facility_id=${charge.facilityId} AND id=${charge.encounterId}` : [];
  const [booking] = charge.appointmentId ? await tx`SELECT visit_type FROM appointments WHERE facility_id=${charge.facilityId} AND id=${charge.appointmentId}` : [];
  const exemption = findExemption(version.exemptions as FeeItem['exemptions'],{ageYears:patientAge(patient,charge.createdOn.slice(0,10)),sex:patient.sex,visitType:visit?.visit_type ?? booking?.visit_type});
  return charge.amountMinor !== (exemption ? 0 : charge.listPriceMinor) || charge.exemptionReason !== exemption?.reason ? ['The charge must preserve its selected exemption policy and patient facts'] : [];
};
export const newCategoryTerms = (value: unknown): boolean => {
  if (!value || typeof value!=='object') return false;
  if (Array.isArray(value)) return value.some(newCategoryTerms);
  return Object.entries(value).some(([key,v])=> key==='categories' && v && typeof v==='object'
    ? (Array.isArray(v) ? v.some((c)=>!isLegacyFeeCategory(c)) : Object.keys(v).some((c)=>!isLegacyFeeCategory(c))) : newCategoryTerms(v));
};
