import { randomUUID } from 'node:crypto';
import { contractIdFor, ImportTemplate, PayerContractTerms, type ImportTemplateSave, type TariffImport, type TariffImportResult } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { ContractRefusal, fromContractRow, saveDraft } from './contracts.ts';

type Row = Record<string, unknown>;

/**
 * Applies confirmed tariff lines from a spreadsheet to the payer's draft
 * contract. Each line is checked again here, whatever the browser checked:
 * the fee item must belong to this hospital, be active, and be priced in the
 * contract's currency. The draft starts from the current active version when
 * there is no draft, so plans and rules carry over; activation is a separate,
 * reviewed step. The original spreadsheet is never received or kept.
 */
export const applyTariffImport = async (tx: Tx, facilityId: string, staffId: string, input: TariffImport): Promise<TariffImportResult> => {
  const contractId = contractIdFor(input.payerId);
  await tx`SELECT id FROM facilities WHERE id = ${facilityId} FOR UPDATE`;
  const [draft] = await tx<Row[]>`SELECT * FROM payer_contract_versions WHERE facility_id = ${facilityId} AND contract_id = ${contractId} AND status = 'draft' FOR UPDATE`;
  const [active] = draft ? [] : await tx<Row[]>`SELECT * FROM payer_contract_versions WHERE facility_id = ${facilityId} AND contract_id = ${contractId} AND status = 'active' ORDER BY version DESC LIMIT 1`;
  const base = draft ?? active;
  if (!base) throw new ContractRefusal('no_contract_terms', 'Start a contract for this payer first: the import fills in prices, not plans or rules');
  if (draft && input.expectedRevision !== draft.revision) throw new ContractRefusal('stale_draft', 'This draft changed since you opened it. Review the current draft before importing');
  if (!draft && input.expectedRevision !== undefined) throw new ContractRefusal('stale_draft', 'This draft was activated or replaced. Start from the current version');
  const terms = fromContractRow(base).terms;

  const ids = input.lines.map((l) => l.feeItemId);
  const fees = await tx<{ id: string; currency: string; active: boolean }[]>`SELECT id, currency, active FROM fee_items WHERE facility_id = ${facilityId} AND id = ANY(${ids})`;
  const byId = new Map(fees.map((f) => [f.id, f]));
  const problems = input.lines.flatMap((l) => {
    const fee = byId.get(l.feeItemId);
    if (!fee) return [{ sourceRow: l.sourceRow, problem: 'unknown_fee_item' }];
    if (!fee.active) return [{ sourceRow: l.sourceRow, problem: 'retired_fee_item' }];
    if (fee.currency !== terms.currency) return [{ sourceRow: l.sourceRow, problem: 'currency_mismatch' }];
    return [];
  });
  if (problems.length) throw new ContractRefusal('invalid_lines', `${problems.length} row(s) cannot be imported`, { rows: problems.slice(0, 200) });

  const before = terms.tariff;
  const tariff: PayerContractTerms['tariff'] = input.mode === 'replace' ? {} : { ...before };
  let added = 0, changed = 0, unchanged = 0;
  for (const line of input.lines) {
    const previous = before[line.feeItemId];
    // A row without a payer code keeps the code already recorded for that service.
    const payerCode = line.payerCode ?? previous?.payerCode;
    const next = { unitMinor: line.unitMinor, ...(payerCode ? { payerCode } : {}) };
    if (!previous) added += 1; else if (previous.unitMinor === next.unitMinor && previous.payerCode === next.payerCode) unchanged += 1; else changed += 1;
    tariff[line.feeItemId] = next;
  }
  const removed = input.mode === 'replace' ? Object.keys(before).filter((id) => !(id in tariff)).length : 0;
  const saved = await saveDraft(tx, facilityId, staffId, { terms: { ...terms, tariff }, ...(draft ? { expectedRevision: draft.revision as number } : {}) });
  return { contractVersionId: saved.version.id, version: saved.version.version, revision: saved.version.revision, added, changed, unchanged, removed };
};

const templateRow = (r: Row) => ImportTemplate.parse({
  id: r.id, kind: r.kind, ...(r.payer_id ? { payerId: r.payer_id } : {}), name: r.name, headers: r.headers, headerRow: r.header_row, mapping: r.mapping,
  revision: r.revision, updatedBy: r.updated_by, updatedOn: new Date(r.updated_on as string).toISOString(),
});

export const listImportTemplates = async (sql: Sql | Tx, facilityId: string, kind: string) =>
  (await sql<Row[]>`SELECT * FROM import_mapping_templates WHERE facility_id = ${facilityId} AND kind = ${kind} ORDER BY updated_on DESC`).map(templateRow);

/** Saves a mapping by name: the same name for the same payer and kind is a new revision of it. */
export const saveImportTemplate = async (tx: Tx, facilityId: string, staffId: string, input: ImportTemplateSave) => {
  if (input.payerId) {
    const [payer] = await tx`SELECT id FROM payers WHERE facility_id = ${facilityId} AND id = ${input.payerId}`;
    if (!payer) throw new ContractRefusal('unknown_payer', 'Choose a payer of this hospital');
  }
  const [current] = await tx<Row[]>`SELECT * FROM import_mapping_templates WHERE facility_id = ${facilityId} AND kind = ${input.kind} AND COALESCE(payer_id, '') = ${input.payerId ?? ''} AND lower(name) = lower(${input.name}) FOR UPDATE`;
  if ((current?.revision as number | undefined) !== input.expectedRevision) throw new ContractRefusal('stale_template', current ? 'A mapping with this name exists. Review it before replacing it' : 'This mapping was removed or renamed');
  if (current) {
    await tx`UPDATE import_mapping_templates SET headers = ${tx.json(input.headers)}, header_row = ${input.headerRow}, mapping = ${tx.json(input.mapping)}, revision = revision + 1, updated_by = ${staffId}, updated_on = now() WHERE id = ${current.id as string}`;
  } else {
    await tx`INSERT INTO import_mapping_templates (id, facility_id, kind, payer_id, name, headers, header_row, mapping, revision, updated_by)
      VALUES (${`import_template:${randomUUID()}`}, ${facilityId}, ${input.kind}, ${input.payerId ?? null}, ${input.name}, ${tx.json(input.headers)}, ${input.headerRow}, ${tx.json(input.mapping)}, 1, ${staffId})`;
  }
  const [row] = await tx<Row[]>`SELECT * FROM import_mapping_templates WHERE facility_id = ${facilityId} AND kind = ${input.kind} AND COALESCE(payer_id, '') = ${input.payerId ?? ''} AND lower(name) = lower(${input.name})`;
  return templateRow(row);
};
