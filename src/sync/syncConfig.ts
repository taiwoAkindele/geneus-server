import { SCHEMA_BY_TYPE, FACILITY_DOCUMENT_TYPES, RESTRICTED_FACILITY_DOCUMENT_TYPES, Permission, type DocType } from '#shared';
import { snakeCase, TABLE_FOR } from '../db/records.ts';

/**
 * The PowerSync Sync Streams definition, generated from the contract so the
 * two can never drift: one stream per synced record type, every column the
 * contract names, filtered to the facility in the device's token. This is the
 * download half of facility isolation (the upload half is src/sync/upload.ts).
 *
 * Generated rather than hand-written for the same reason the CouchDB guard
 * was: a column added to the contract that a stream forgot would surface as
 * "missing on the device" days later. `scripts/generate-sync-config.ts`
 * writes it; a test asserts the committed file matches.
 */

/** The JWT claim geneus-server puts in every sync token (src/auth/syncToken.ts). */
export const FACILITY_CLAIM = 'facility_id';

/** Sync Streams (config.edition 3) — Sync Rules are deprecated. */
const EDITION = 3;

/**
 * Columns come back to the device under their contract names: PostgreSQL is
 * snake_case, SQLite and the repositories are camelCase, and the alias is the
 * one place that mapping happens on the way down. `id` and `type` need no
 * alias: `id` is `id`, and `type` is the table, not a column.
 */
const LEGACY_OMISSIONS: Partial<Record<DocType, readonly string[]>> = {
  facility:['timeZone','workforcePolicy','allowCustomInvestigations'],unit:['kind','parentId','routingEnabled','revision'],billing_department:['organizationUnitId','revision'],
  fee_item:['priceVersion'], encounter:['workflowVersion'], staff:['personId'], charge:['orderItemId','orderEntryId'],
  appointment:['allocation'],encounter_entry:['actorContext','workflowVersion'],clinical_event:['actorContext'],sync_rejection:['dependencies','visibility','visibleToStaffIds'],
};
const CARE_FIELDS: Partial<Record<DocType, readonly string[]>> = { facility: ['allowCustomInvestigations'], staff: ['personId'], fee_item: ['priceVersion'], service_definition: ['investigation'], service_offering: ['feeItemId'], encounter: ['workflowVersion'], encounter_entry: ['workflowVersion'], charge: ['orderItemId','orderEntryId'] };
const selectListFor = (type: DocType, legacy = false, care = true): string[] =>
  Object.keys(SCHEMA_BY_TYPE[type].shape)
    .filter((field) => field !== 'type' && (!legacy || !LEGACY_OMISSIONS[type]?.includes(field)) && (care || !CARE_FIELDS[type]?.includes(field)))
    .map((field) => {
      const column = snakeCase(field);
      return column === field ? column : `${column} AS "${field}"`;
    });

export const streamNameFor = (type: DocType): string => TABLE_FOR[type];
/** Device tokens identify a facility, not the human at a shared device. Evidence uses authenticated private reads. */
export const syncedTypes = (): DocType[] => (Object.keys(TABLE_FOR) as DocType[]).filter((type) => !RESTRICTED_FACILITY_DOCUMENT_TYPES.some((restricted) => restricted === type));

const queryFor = (type: DocType, legacy: boolean, care = true): string[] => {
  const lines=[`SELECT ${selectListFor(type,legacy,care).join(', ')}`,`FROM ${TABLE_FOR[type]}`,`WHERE facility_id = auth.parameter('${FACILITY_CLAIM}')`];
  lines.push(legacy ? "  AND (auth.parameter('facility_contract') IS NULL OR auth.parameter('facility_contract') <> 1)" : "  AND auth.parameter('facility_contract') = 1");
  lines.push(care ? "  AND auth.parameter('clinical_workflow') = 1" : "  AND (auth.parameter('clinical_workflow') IS NULL OR auth.parameter('clinical_workflow') <> 1)");
  // Legacy screens assume complete demographics; they receive this record
  // only after identification, while upgraded clients can provide care now.
  if (type === 'patient') lines.push("  AND (auth.parameter('patient_registration') = 1 OR identity_status = 'identified')");
  if (['inpatient_event', 'bed_ready_event'].includes(type)) lines.push("  AND auth.parameter('inpatient_workflow') = 1");
  if (['library_document','visit_document'].includes(type)) lines.push("  AND auth.parameter('document_workflow') = 1");
  if(type==='audit_event'||type==='sync_rejection')lines.push("  AND (auth.parameter('document_workflow') = 1 OR entity_type IS NULL OR (entity_type <> 'library_document' AND entity_type <> 'visit_document'))");
  if (type === 'audit_event' || type === 'sync_rejection') lines.push("  AND (auth.parameter('inpatient_workflow') = 1 OR entity_type IS NULL OR (entity_type <> 'inpatient_event' AND entity_type <> 'bed_ready_event'))");
  if (type === 'staff') lines.push("  AND (auth.parameter('inpatient_workflow') = 1 OR instr(additional_permissions, '\"admission:manage\"') = 0)");
  if (type === 'referral' || type === 'inbound_referral') lines.push("  AND (auth.parameter('patient_registration') = 1 OR json_extract(tier1, '$.sex') IS NOT NULL)");
  if (type === 'encounter' || type === 'encounter_entry') lines.push("  AND (auth.parameter('clinical_workflow') = 1 OR workflow_version IS NULL)");
  if(type === 'inbound_referral') lines.push("  AND auth.parameter('clinical_workflow') = 1");
  if(type === 'encounter_entry') lines.push("  AND (auth.parameter('clinical_workflow') = 1 OR (step <> 'investigation_review' AND step <> 'result_review' AND step <> 'prescription' AND step <> 'injection_order' AND step <> 'disposition'))");
  if(type==='authority_snapshot') lines.push('  AND is_current = true');
  if(type==='sync_rejection') {
    lines.push("  AND (visibility IS NULL OR visibility = 'facility')");
    if(legacy) lines.push("  AND category <> 'dependency'",...FACILITY_DOCUMENT_TYPES.map((t)=>`  AND entity_type <> '${t}'`));
  }
  if(legacy && type==='audit_event') lines.push(`  AND (entity_type IS NULL OR (${FACILITY_DOCUMENT_TYPES.map((t)=>`entity_type <> '${t}'`).join(' AND ')}))`);
  if(legacy && ['staff','encounter_entry','clinical_event'].includes(type)) {
    for(const role of ['laboratory_staff','pharmacy_staff']) lines.push(`  AND ${type==='staff'?'role':'actor_role'} <> '${role}'`);
    if(type==='staff') {
      lines.push("  AND instr(additional_roles, 'laboratory_staff') = 0","  AND instr(additional_roles, 'pharmacy_staff') = 0");
      for(const permission of Permission.options.filter((p)=>/^(location|service|practitioner|credential|clinical_capability|staff_assignment|service_session|work_ownership|clinical):/.test(p))) lines.push(`  AND instr(additional_permissions, '"${permission}"') = 0`);
    }
  }
  return lines;
};

export const buildSyncConfig = (): string => {
  const lines: string[] = [
    '# GENERATED from the shared contract by `npm run sync:config` — do not edit by hand.',
    '# One stream per synced record type, every contract column aliased to its',
    '# contract name, filtered to the facility in the device\'s sync token. See',
    '# src/sync/syncConfig.ts for why it is generated and SCHEMA.md §6 for the rule.',
    'config:',
    `  edition: ${EDITION}`,
    '',
    'streams:',
  ];

  for (const type of syncedTypes()) {
    lines.push(`  ${streamNameFor(type)}:`);
    lines.push('    auto_subscribe: true');
    if(FACILITY_DOCUMENT_TYPES.some((t)=>t===type)) {
      lines.push('    queries:', '      - |', ...queryFor(type,false,true).map((line)=>`        ${line}`), '      - |', ...queryFor(type,false,false).map((line)=>`        ${line}`));
    } else {
      lines.push('    queries:');
      for (const care of [true,false]) for (const legacy of [false,true]) lines.push('      - |', ...queryFor(type,legacy,care).map((line)=>`        ${line}`));
    }
  }

  return `${lines.join('\n')}\n`;
};
