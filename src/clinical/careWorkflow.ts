import {
  careEntryIssues,
  effectiveEncounterEntries,
  ENCOUNTER_STEP_VALUES,
  type Encounter,
  type EncounterEntry,
  type FeeItem,
  type InvestigationItem,
  type Referral,
  type ServiceDefinition,
  type ServiceOffering,
} from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord, fromRow } from '../db/records.ts';
import { labReportUploadIssues } from './labReports.ts';
import { isDeepStrictEqual } from 'node:util';

const classifiedLaboratoryOrderIssue = async (
  tx: Tx,
  facilityId: string,
  item: InvestigationItem,
) => {
  const [row] = await tx`SELECT id, active, orderable, fee_item_id FROM service_definitions
    WHERE facility_id=${facilityId} AND laboratory_catalogue IS NOT NULL
    AND (id=${item.serviceDefinitionId ?? ''} OR fee_item_id=${item.feeItemId ?? ''}) LIMIT 1`;

  if (
    row &&
    (!row.active ||
      !row.orderable ||
      row.id !== item.serviceDefinitionId ||
      !item.offeringId ||
      (row.fee_item_id ?? undefined) !== item.feeItemId)
  ) {
    return 'This Laboratory investigation is unavailable for ordering';
  }

  if (row?.fee_item_id) {
    const fee = await findRecord<FeeItem>(tx, 'fee_item', row.fee_item_id);

    if (!fee?.active || !item.feePriceVersion || item.priceMinor === undefined) {
      return 'This billable Laboratory investigation needs an active price';
    }
  }

  if (row) {
    const [offering] = await tx`SELECT id FROM service_offerings WHERE facility_id=${facilityId}
      AND service_definition_id=${row.id} AND id=${item.offeringId ?? ''}
      AND configuration='active' AND resource_readiness='available'`;

    if (!offering) {
      return 'This Laboratory investigation does not have an available service';
    }
  }
};

export const careWorkflowIssues = async (tx: Tx, entry: EncounterEntry): Promise<string[]> => {
  const encounter = await findRecord<Encounter>(tx, 'encounter', entry.encounterId);

  if (encounter?.workflowVersion === 1 && entry.workflowVersion !== 1) {
    return ['This consultation requires the current clinical workflow'];
  }

  const rows =
    await tx`SELECT * FROM encounter_entries WHERE facility_id=${entry.facilityId} AND encounter_id=${entry.encounterId} ORDER BY created_on,id`;

  const prior = effectiveEncounterEntries(
    rows.map((row) => fromRow<EncounterEntry>('encounter_entry', row)),
  );

  const issues = careEntryIssues(entry, prior, Boolean(encounter?.inpatientContext));

  if (issues.length) {
    return issues;
  }

  if (entry.step === 'lab_results' && entry.labReport) {
    const reportIssues = await labReportUploadIssues(
      tx,
      entry,
      entry.labReport,
      ENCOUNTER_STEP_VALUES.lab_results.parse(entry.values).results,
    );

    if (reportIssues.length) {
      return reportIssues;
    }
  }

  if (entry.step === 'lab_order' && entry.values.items) {
    const { items } = ENCOUNTER_STEP_VALUES.lab_order.parse(entry.values);

    for (const item of items!) {
      // A clinician may always request a test that is not in the catalogue; it carries no catalogue price.
      if (item.custom) {
        if (item.feeItemId || item.priceMinor !== undefined) {
          return ['Unlisted requests cannot invent a catalogue price'];
        }

        const [draft] = await tx`SELECT id FROM service_definitions d
          WHERE d.facility_id=${entry.facilityId} AND d.laboratory_catalogue IS NOT NULL AND (NOT d.active OR NOT d.orderable)
            AND (lower(regexp_replace(btrim(d.name), '\\s+', ' ', 'g'))=lower(regexp_replace(btrim(${item.name}), '\\s+', ' ', 'g'))
              OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(d.investigation->'aliases') AS alias(value)
                         WHERE lower(regexp_replace(btrim(alias.value), '\\s+', ' ', 'g'))=lower(regexp_replace(btrim(${item.name}), '\\s+', ' ', 'g')))) LIMIT 1`;

        if (draft) {
          return ['This Laboratory investigation is unavailable for ordering'];
        }

        continue;
      }

      const catalogueIssue = await classifiedLaboratoryOrderIssue(tx, entry.facilityId, item);

      if (catalogueIssue) {
        return [catalogueIssue];
      }

      if (item.catalogueSource === 'billing') {
        const fee = await findRecord<FeeItem>(tx, 'fee_item', item.feeItemId!);

        const [price] =
          await tx`SELECT * FROM fee_price_versions WHERE facility_id=${entry.facilityId} AND id=${item.feePriceVersion!} AND fee_item_id=${item.feeItemId!}`;

        if (
          !fee ||
          fee.facilityId !== entry.facilityId ||
          !price ||
          price.category !== 'laboratory' ||
          Number(price.amount_minor) !== item.priceMinor ||
          price.currency !== item.currency
        ) {
          return ['The investigation must preserve its central Laboratory price evidence'];
        }

        if (!isDeepStrictEqual(item.exemptions, price.exemptions)) {
          return ['The investigation must retain its selected exemption policy'];
        }

        if (item.serviceDefinitionId) {
          const [profile] =
            await tx`SELECT snapshot FROM service_definition_versions WHERE facility_id=${entry.facilityId} AND source_id=${item.serviceDefinitionId} AND revision=${item.definitionRevision ?? 0}`;

          const [legacy] = item.offeringId
            ? await tx`SELECT snapshot FROM service_offering_versions WHERE facility_id=${entry.facilityId} AND source_id=${item.offeringId} AND revision=${item.catalogueRevision ?? 0}`
            : [];

          const explicitlyLinked =
            legacy?.snapshot.fee_item_id === item.feeItemId &&
            legacy?.snapshot.service_definition_id === item.serviceDefinitionId &&
            legacy?.snapshot.configuration === 'active' &&
            legacy?.snapshot.resource_readiness === 'available';

          if (
            !profile ||
            (profile.snapshot.laboratory_catalogue &&
              (!profile.snapshot.active || !profile.snapshot.orderable)) ||
            (profile.snapshot.fee_item_id !== item.feeItemId && !explicitlyLinked)
          ) {
            return ['The clinical profile must belong to this selected central Laboratory item'];
          }
        }

        const manual =
          await tx`SELECT id FROM charges WHERE facility_id=${entry.facilityId} AND patient_id=${entry.patientId} AND fee_item_id=${item.feeItemId!} AND order_item_id IS NULL AND dispense_entry_id IS NULL AND (encounter_id IS NULL OR encounter_id=${entry.encounterId}) LIMIT 1`;

        if (manual.length && !item.billingReviewReason && !item.additionalChargeReason) {
          return [
            'An existing manual bill may cover this investigation. Review billing before adding another charge',
          ];
        }

        continue;
      }

      const offering = await findRecord<ServiceOffering>(tx, 'service_offering', item.offeringId!);

      const definition = await findRecord<ServiceDefinition>(
        tx,
        'service_definition',
        item.serviceDefinitionId!,
      );

      if (
        !offering ||
        !definition ||
        offering.facilityId !== entry.facilityId ||
        definition.facilityId !== entry.facilityId
      ) {
        return ['The investigation must reference this facility’s catalogue'];
      }

      const [offeringVersion] =
        await tx`SELECT snapshot FROM service_offering_versions WHERE facility_id=${entry.facilityId} AND source_id=${item.offeringId!} AND revision=${item.catalogueRevision ?? 0}`;

      const [definitionVersion] =
        await tx`SELECT snapshot FROM service_definition_versions WHERE facility_id=${entry.facilityId} AND source_id=${item.serviceDefinitionId!} AND revision=${item.definitionRevision ?? 0}`;

      if (
        !offeringVersion ||
        offeringVersion.snapshot.service_definition_id !== item.serviceDefinitionId ||
        !definitionVersion ||
        offeringVersion.snapshot.configuration !== 'active' ||
        offeringVersion.snapshot.resource_readiness !== 'available' ||
        !definitionVersion.snapshot.active ||
        !definitionVersion.snapshot.orderable ||
        !definitionVersion.snapshot.investigation
      ) {
        return ['The requested investigation version was not available for ordering'];
      }

      if (
        item.name !== offeringVersion.snapshot.name ||
        item.feeItemId !== (offeringVersion.snapshot.fee_item_id ?? undefined)
      ) {
        return ['The investigation must preserve its selected catalogue version'];
      }

      if (item.feeItemId) {
        const fee = await findRecord<FeeItem>(tx, 'fee_item', item.feeItemId);

        if (!fee || fee.facilityId !== entry.facilityId || item.priceMinor === undefined) {
          return ['The investigation pricing reference is invalid'];
        }

        if (item.feePriceVersion) {
          const [price] =
            await tx`SELECT amount_minor,currency FROM fee_price_versions WHERE id=${item.feePriceVersion} AND facility_id=${entry.facilityId} AND fee_item_id=${item.feeItemId}`;

          if (
            !price ||
            Number(price.amount_minor) !== item.priceMinor ||
            price.currency !== item.currency
          ) {
            return ['The signed price snapshot does not match its facility fee version'];
          }
        } else if (fee.amountMinor !== item.priceMinor || fee.currency !== item.currency) {
          return ['Refresh the investigation fee before ordering'];
        }
      }
      // The snapshot is preserved even if a catalogue changes while this device is offline.
    }
  }

  if (entry.step === 'disposition' && entry.values.kind === 'referral') {
    const referral = await findRecord<Referral>(tx, 'referral', String(entry.values.referralId));

    if (
      !referral ||
      referral.facilityId !== entry.facilityId ||
      referral.patientId !== entry.patientId ||
      referral.toFacilityId !== entry.values.toFacilityId
    ) {
      return ['The referral must belong to this patient and destination'];
    }
  }

  if (entry.step === 'injection') {
    const order = [...prior].reverse().find((p) => p.step === 'injection_order');

    if (
      order &&
      (!order.values.required ||
        order.values.drug !== entry.values.drug ||
        order.values.dose !== entry.values.dose ||
        order.values.route !== entry.values.route)
    ) {
      return ['Administration must match the signed injection order'];
    }
  }

  return [];
};

export const chargeOrderIssues = async (
  tx: Tx,
  charge: {
    facilityId: string;
    encounterId?: string;
    patientId: string;
    feeItemId: string;
    orderItemId?: string;
    orderEntryId?: string;
    listPriceMinor: number;
    currency: string;
    feePriceVersion?: string;
    quantity?: number;
  },
): Promise<string[]> => {
  if (!charge.orderItemId && !charge.orderEntryId) {
    return [];
  }

  if (!charge.orderEntryId || !charge.orderItemId) {
    return ['Order charges require both order and item identities'];
  }

  const order = await findRecord<EncounterEntry>(tx, 'encounter_entry', charge.orderEntryId);

  if (
    !order ||
    order.step !== 'lab_order' ||
    order.facilityId !== charge.facilityId ||
    order.encounterId !== charge.encounterId ||
    order.patientId !== charge.patientId
  ) {
    return ['This charge must reference its own patient and encounter order'];
  }

  const item = (order.values.items as InvestigationItem[] | undefined)?.find(
    (i) => i.id === charge.orderItemId,
  );

  if (item?.billingReviewReason) {
    return [
      'This investigation is awaiting billing review; it cannot create another automatic charge',
    ];
  }

  if (
    item?.catalogueSource === 'billing' &&
    (charge.feePriceVersion !== item.feePriceVersion || charge.quantity !== 1)
  ) {
    return ['Preserve the central order price version and its single investigation quantity'];
  }

  return !item ||
    item.feeItemId !== charge.feeItemId ||
    item.priceMinor !== charge.listPriceMinor ||
    item.currency !== charge.currency
    ? ['The charge must preserve the signed order item price']
    : [];
};

/** A handover copy in the destination stream never creates a destination patient. */
export const routeReferral = async (tx: Tx, referral: Referral) => {
  const id = `inbound:${referral.id}`;
  await tx`INSERT INTO inbound_referrals(id,facility_id,schema_version,created_by,created_on,device_id,source_referral_id,from_facility_id,sender_patient_id,tier1,sent_on,status)
    SELECT ${id},f.id,4,'system',now(),f.device_id,${referral.id},${referral.facilityId},${referral.patientId},${tx.json(referral.tier1)},${referral.sentOn},'received' FROM facilities f WHERE f.id=${referral.toFacilityId} ON CONFLICT(facility_id,source_referral_id) DO NOTHING`;

  await tx`UPDATE referrals SET delivery_status='alert_sent' WHERE id=${referral.id} AND facility_id=${referral.facilityId}`;
};
