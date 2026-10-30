import { careEntryIssues, effectiveEncounterEntries, ENCOUNTER_STEP_VALUES, type Encounter, type EncounterEntry, type FeeItem, type InvestigationItem, type Referral, type ServiceDefinition, type ServiceOffering } from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord, fromRow } from '../db/records.ts';

export const careWorkflowIssues = async (tx: Tx, entry: EncounterEntry): Promise<string[]> => {
  const encounter = await findRecord<Encounter>(tx, 'encounter', entry.encounterId);
  if (encounter?.workflowVersion === 1 && entry.workflowVersion !== 1) return ['This consultation requires the current clinical workflow'];
  const rows = await tx`SELECT * FROM encounter_entries WHERE facility_id=${entry.facilityId} AND encounter_id=${entry.encounterId} ORDER BY created_on,id`;
  const prior = effectiveEncounterEntries(rows.map((row) => fromRow<EncounterEntry>('encounter_entry', row)));
  const issues = careEntryIssues(entry, prior);
  if (issues.length) return issues;
  if (entry.step === 'lab_order' && entry.values.items) {
    const { items } = ENCOUNTER_STEP_VALUES.lab_order.parse(entry.values);
    for (const item of items!) {
      if (item.custom) {
        const [facility] = await tx`SELECT allow_custom_investigations FROM facilities WHERE id=${entry.facilityId}`;
        if (!facility?.allow_custom_investigations) return ['Custom investigations are not enabled by this facility'];
        if (item.feeItemId || item.priceMinor !== undefined) return ['Unlisted requests cannot invent a catalogue price'];
        continue;
      }
      const offering = await findRecord<ServiceOffering>(tx, 'service_offering', item.offeringId!);
      const definition = await findRecord<ServiceDefinition>(tx, 'service_definition', item.serviceDefinitionId!);
      if (!offering || !definition || offering.facilityId !== entry.facilityId || definition.facilityId !== entry.facilityId) return ['The investigation must reference this facility’s catalogue'];
      const [offeringVersion] = await tx`SELECT snapshot FROM service_offering_versions WHERE facility_id=${entry.facilityId} AND source_id=${item.offeringId!} AND revision=${item.catalogueRevision ?? 0}`;
      const [definitionVersion] = await tx`SELECT snapshot FROM service_definition_versions WHERE facility_id=${entry.facilityId} AND source_id=${item.serviceDefinitionId!} AND revision=${item.definitionRevision ?? 0}`;
      if (!offeringVersion || offeringVersion.snapshot.service_definition_id !== item.serviceDefinitionId || !definitionVersion || offeringVersion.snapshot.configuration !== 'active' || offeringVersion.snapshot.resource_readiness !== 'available' || !definitionVersion.snapshot.active || !definitionVersion.snapshot.orderable || !definitionVersion.snapshot.investigation) return ['The requested investigation version was not available for ordering'];
      if (item.name !== offeringVersion.snapshot.name || item.feeItemId !== (offeringVersion.snapshot.fee_item_id ?? undefined)) return ['The investigation must preserve its selected catalogue version'];
      if (item.feeItemId) {
        const fee = await findRecord<FeeItem>(tx, 'fee_item', item.feeItemId);
        if (!fee || fee.facilityId !== entry.facilityId || item.priceMinor === undefined) return ['The investigation pricing reference is invalid'];
        if (item.feePriceVersion) {
          const [price] = await tx`SELECT amount_minor,currency FROM fee_price_versions WHERE id=${item.feePriceVersion} AND facility_id=${entry.facilityId} AND fee_item_id=${item.feeItemId}`;
          if (!price || Number(price.amount_minor) !== item.priceMinor || price.currency !== item.currency) return ['The signed price snapshot does not match its facility fee version'];
        } else if (fee.amountMinor !== item.priceMinor || fee.currency !== item.currency) return ['Refresh the investigation fee before ordering'];
      }
      // The snapshot is preserved even if a catalogue changes while this device is offline.
    }
  }
  if (entry.step === 'disposition' && entry.values.kind === 'referral') {
    const referral = await findRecord<Referral>(tx, 'referral', String(entry.values.referralId));
    if (!referral || referral.facilityId !== entry.facilityId || referral.patientId !== entry.patientId || referral.toFacilityId !== entry.values.toFacilityId) return ['The referral must belong to this patient and destination'];
  }
  if (entry.step === 'injection') {
    const order = [...prior].reverse().find((p) => p.step === 'injection_order');
    if (order && (!order.values.required || order.values.drug !== entry.values.drug || order.values.dose !== entry.values.dose || order.values.route !== entry.values.route)) return ['Administration must match the signed injection order'];
  }
  return [];
};

export const chargeOrderIssues = async (tx: Tx, charge: { facilityId: string; encounterId?: string; patientId: string; feeItemId: string; orderItemId?: string; orderEntryId?: string; listPriceMinor: number; currency: string }): Promise<string[]> => {
  if (!charge.orderItemId && !charge.orderEntryId) return [];
  if (!charge.orderEntryId || !charge.orderItemId) return ['Order charges require both order and item identities'];
  const order = await findRecord<EncounterEntry>(tx, 'encounter_entry', charge.orderEntryId);
  if (!order || order.step !== 'lab_order' || order.facilityId !== charge.facilityId || order.encounterId !== charge.encounterId || order.patientId !== charge.patientId) return ['This charge must reference its own patient and encounter order'];
  const item = (order.values.items as InvestigationItem[] | undefined)?.find((i) => i.id === charge.orderItemId);
  return !item || item.feeItemId !== charge.feeItemId || item.priceMinor !== charge.listPriceMinor || item.currency !== charge.currency ? ['The charge must preserve the signed order item price'] : [];
};

/** A handover copy in the destination stream never creates a destination patient. */
export const routeReferral = async (tx: Tx, referral: Referral) => {
  const id = `inbound:${referral.id}`;
  await tx`INSERT INTO inbound_referrals(id,facility_id,schema_version,created_by,created_on,device_id,source_referral_id,from_facility_id,sender_patient_id,tier1,sent_on,status)
    SELECT ${id},f.id,4,'system',now(),f.device_id,${referral.id},${referral.facilityId},${referral.patientId},${tx.json(referral.tier1)},${referral.sentOn},'received' FROM facilities f WHERE f.id=${referral.toFacilityId} ON CONFLICT(facility_id,source_referral_id) DO NOTHING`;
  await tx`UPDATE referrals SET delivery_status='alert_sent' WHERE id=${referral.id} AND facility_id=${referral.facilityId}`;
};
