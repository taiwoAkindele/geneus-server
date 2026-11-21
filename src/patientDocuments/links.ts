import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DOCUMENT_LINK_DAYS, type DocumentKind } from '#shared';
import type { Sql, Tx } from '../db/client.ts';

/**
 * Patient document links. The secret is 32 random bytes in the URL; only its SHA-256 is stored, so a database
 * copy can't open anyone's bill. A link stops working when it expires or staff stop it.
 */
export type DocumentLink = { id: string; facilityId: string; kind: DocumentKind; subject: string; patientId: string; expiresOn: string };

const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest();
/** base64url of 32 bytes: 43 characters. Anything else is refused before touching the database. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The web app page a patient opens; the caller adds the web app's public origin. */
export const patientPagePath = (kind: DocumentKind, token: string) => `/p/${kind === 'bill' ? 'b' : 'r'}/${token}`;

export const createDocumentLink = async (sql: Sql | Tx, link: { facilityId: string; kind: DocumentKind; subject: string; patientId: string; createdBy: string }, now = new Date()) => {
  const token = randomBytes(32).toString('base64url');
  const expiresOn = new Date(now.getTime() + DOCUMENT_LINK_DAYS[link.kind] * 86_400_000).toISOString();
  await sql`INSERT INTO patient_document_links (id, facility_id, kind, subject, patient_id, token_hash, created_by, created_on, expires_on)
    VALUES (${`document_link:${randomUUID()}`}, ${link.facilityId}, ${link.kind}, ${link.subject}, ${link.patientId}, ${hashOf(token)}, ${link.createdBy}, ${now.toISOString()}, ${expiresOn})`;
  return { token, expiresOn };
};

/** The open link a token names, if it is of this kind, unexpired and not stopped. */
export const openDocumentLink = async (sql: Sql | Tx, kind: DocumentKind, token: string, now = new Date()): Promise<DocumentLink | undefined> => {
  if (!TOKEN.test(token)) return undefined;
  const [row] = await sql<{ id: string; facility_id: string; kind: DocumentKind; subject: string; patient_id: string; expires_on: Date | string }[]>`
    SELECT id, facility_id, kind, subject, patient_id, expires_on FROM patient_document_links
    WHERE token_hash = ${hashOf(token)} AND kind = ${kind} AND stopped_on IS NULL AND expires_on > ${now.toISOString()}`;
  return row ? { id: row.id, facilityId: row.facility_id, kind: row.kind, subject: row.subject, patientId: row.patient_id, expiresOn: new Date(row.expires_on).toISOString() } : undefined;
};

/** Stops every open link to one bill or receipt. */
export const stopDocumentLinks = async (sql: Sql | Tx, facilityId: string, kind: DocumentKind, subject: string, stoppedBy: string): Promise<number> => {
  const rows = await sql`UPDATE patient_document_links SET stopped_on = now(), stopped_by = ${stoppedBy}
    WHERE facility_id = ${facilityId} AND kind = ${kind} AND subject = ${subject} AND stopped_on IS NULL RETURNING id`;
  return rows.length;
};
