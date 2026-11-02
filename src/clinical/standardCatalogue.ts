import { StandardTemplate, StandardTest, canonicalParts } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { insertRecord, TABLE_FOR, toRow } from '../db/records.ts';
import { recordsInFacility } from '../workforce/records.ts';
import { STANDARD_TEMPLATES } from './standardTemplates.ts';
import { STANDARD_TESTS, standardConcept } from './standardTests.ts';

/**
 * Copies the server's standard tests and result templates into one facility, so
 * devices can add them offline. Rows are created or brought up to date with the
 * server's lists; nothing a facility added is touched. Runs inside the caller's
 * transaction; a facility with no device yet is left for later.
 */
export const ensureStandardCatalogue = async (tx: Sql | Tx, facilityId: string): Promise<void> => {
  const [device] = await tx<{ id: string }[]>`SELECT id FROM devices WHERE facility_id = ${facilityId} ORDER BY enrolled_on, id LIMIT 1`;
  if (!device) return;
  const now = new Date().toISOString();
  const envelope = { facilityId, deviceId: device.id, createdBy: 'system', createdOn: now, schemaVersion: 5 };
  // Only what comes from the server's lists decides whether a row is out of date.
  const content = (r: StandardTest | StandardTemplate) => JSON.stringify(r.type === 'standard_test' ? [r.name, r.specimen, r.classification, r.aliases, r.concept] : [r.name, r.tests, canonicalParts(r.parts)]);
  const sync = async <T extends StandardTest | StandardTemplate>(type: T['type'], wanted: T[], existing: T[]) => {
    for (const record of wanted) {
      const current = existing.find((row) => row.id === record.id);
      if (!current) { await insertRecord(tx, type, record); continue; }
      if (content(current) === content(record)) continue;
      const changes = toRow(tx, type, { ...record, createdOn: current.createdOn, deviceId: current.deviceId, updatedBy: 'system', updatedOn: now });
      const table: string = TABLE_FOR[type];
      await tx`UPDATE ${tx(table)} SET ${tx(changes)} WHERE id = ${record.id} AND facility_id = ${facilityId}`;
    }
  };
  await sync('standard_test', STANDARD_TESTS.map((test) => StandardTest.parse({
    ...envelope, id: `standard_test:${facilityId}:${test.key}`, type: 'standard_test', key: test.key, name: test.name,
    specimen: test.specimen, classification: test.classification, aliases: test.aliases, concept: standardConcept(test),
  })), await recordsInFacility(tx, facilityId, 'standard_test'));
  await sync('standard_template', STANDARD_TEMPLATES.map((template) => StandardTemplate.parse({
    ...envelope, id: `standard_template:${facilityId}:${template.key}`, type: 'standard_template', key: template.key, name: template.name,
    tests: [...template.tests], parts: template.parts,
  })), await recordsInFacility(tx, facilityId, 'standard_template'));
};

const refresh = (sql: Sql, facilityId: string) => sql.begin(async (tx) => {
  await tx`SELECT id FROM facilities WHERE id = ${facilityId} FOR UPDATE`;
  await ensureStandardCatalogue(tx, facilityId);
});

/** At start-up, every facility receives the current standard lists. Each facility is its own transaction. */
export const ensureAllStandardCatalogues = async (sql: Sql): Promise<number> => {
  const facilities = await sql<{ id: string }[]>`SELECT id FROM facilities ORDER BY id`;
  for (const { id } of facilities) await refresh(sql, id);
  return facilities.length;
};

/**
 * A facility created since start-up gets its lists when one of its devices first
 * asks to sync result templates. A cheap count decides; start-up refreshes content.
 */
export const ensureStandardCatalogueOnce = async (sql: Sql, facilityId: string): Promise<void> => {
  const [counts] = await sql<{ tests: number; templates: number }[]>`SELECT (SELECT count(*)::int FROM standard_tests WHERE facility_id = ${facilityId}) AS tests, (SELECT count(*)::int FROM standard_templates WHERE facility_id = ${facilityId}) AS templates`;
  if (counts.tests < STANDARD_TESTS.length || counts.templates < STANDARD_TEMPLATES.length) await refresh(sql, facilityId);
};
