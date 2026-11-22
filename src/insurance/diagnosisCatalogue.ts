import { createHash, randomUUID } from 'node:crypto';
import {
  diagnosisSystemKey,
  normaliseDiagnosisCode,
  type DiagnosisCatalogueImport,
  type DiagnosisCatalogueSummary,
} from '#shared';
import type { Sql, Tx } from '../db/client.ts';

/**
 * A hospital's licensed diagnosis code list (audit H1). Geneus ships none;
 * each import names the licence it rests on and is kept on record. Claims
 * whose payer requires verified codes check them here.
 */
export const importDiagnosisCatalogue = async (
  tx: Tx,
  facilityId: string,
  staffId: string,
  input: DiagnosisCatalogueImport,
) => {
  const system = diagnosisSystemKey(input.codeSystem);
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`${facilityId}:diagnosis_catalogue:${system}`}))`;

  const existing = new Map(
    (
      await tx<
        { code: string; description: string }[]
      >`SELECT code, description FROM diagnosis_catalogue_entries WHERE facility_id = ${facilityId} AND code_system = ${system}`
    ).map((e) => [e.code, e.description]),
  );

  const incoming = new Map(
    input.lines.map((l) => [normaliseDiagnosisCode(l.code), l.description.trim()]),
  );

  const added = [...incoming.keys()].filter((c) => !existing.has(c)).length;
  const changed = [...incoming].filter(([c, d]) => existing.has(c) && existing.get(c) !== d).length;

  const removedCodes =
    input.mode === 'replace' ? [...existing.keys()].filter((c) => !incoming.has(c)) : [];

  const id = `diagnosis_catalogue_import:${randomUUID()}`;
  await tx`INSERT INTO diagnosis_catalogue_imports (id, facility_id, code_system, edition, licence_reference, mode, file_name, file_sha256, rows, added, changed, removed, imported_by)
    VALUES (${id}, ${facilityId}, ${system}, ${input.edition}, ${input.licenceReference}, ${input.mode}, ${input.source.fileName}, ${input.source.sha256}, ${input.source.rows}, ${added}, ${changed}, ${removedCodes.length}, ${staffId})`;

  if (removedCodes.length) {
    await tx`DELETE FROM diagnosis_catalogue_entries WHERE facility_id = ${facilityId} AND code_system = ${system} AND code = ANY(${removedCodes})`;
  }

  const entries = [...incoming].map(([code, description]) => ({
    facility_id: facilityId,
    code_system: system,
    code,
    description,
    import_id: id,
  }));

  for (let i = 0; i < entries.length; i += 1000) {
    await tx`INSERT INTO diagnosis_catalogue_entries ${tx(entries.slice(i, i + 1000))}
      ON CONFLICT (facility_id, code_system, code) DO UPDATE SET description = EXCLUDED.description, import_id = EXCLUDED.import_id`;
  }

  const payloadSha256 = createHash('sha256')
    .update(JSON.stringify([...incoming].sort()))
    .digest('hex');

  return {
    importId: id,
    codeSystem: system,
    added,
    changed,
    removed: removedCodes.length,
    codes:
      incoming.size +
      (input.mode === 'merge' ? [...existing.keys()].filter((c) => !incoming.has(c)).length : 0),
    payloadSha256,
  };
};

export const diagnosisCatalogues = async (
  sql: Sql | Tx,
  facilityId: string,
): Promise<DiagnosisCatalogueSummary[]> => {
  const [counts, imports] = await Promise.all([
    sql<
      { code_system: string; codes: number }[]
    >`SELECT code_system, COUNT(*)::int AS codes FROM diagnosis_catalogue_entries WHERE facility_id = ${facilityId} GROUP BY code_system`,
    sql<
      {
        code_system: string;
        edition: string;
        licence_reference: string;
        imported_by: string;
        imported_on: Date;
      }[]
    >`SELECT DISTINCT ON (code_system) code_system, edition, licence_reference, imported_by, imported_on
      FROM diagnosis_catalogue_imports WHERE facility_id = ${facilityId} ORDER BY code_system, imported_on DESC`,
  ]);

  return counts.flatMap((count) => {
    const latest = imports.find((i) => i.code_system === count.code_system);

    return latest
      ? [
          {
            codeSystem: count.code_system,
            edition: latest.edition,
            licenceReference: latest.licence_reference,
            codes: count.codes,
            importedBy: latest.imported_by,
            importedOn: new Date(latest.imported_on).toISOString(),
          },
        ]
      : [];
  });
};
