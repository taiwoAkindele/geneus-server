import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AuthoritySnapshot, POLICY_VERSION, FACILITY_MIN_POLICY_VERSION, authoritySignaturePayload, projectClinicalAuthority, staffPermissions, type AuthorityProof, type AuthorizationContext, type Staff, } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { fromRow, insertRecord } from '../db/records.ts';
import type { Signer } from '../lib/signing.ts';
import { recordsInFacility } from './records.ts';
export const authoritySources = async (tx: Sql | Tx, facilityId: string) => {
  const [decisions, credentials, delegations, bootstraps] = await Promise.all([
    recordsInFacility(tx, facilityId, 'capability_decision'), recordsInFacility(tx, facilityId, 'credential'),
    recordsInFacility(tx, facilityId, 'reviewer_delegation'), recordsInFacility(tx, facilityId, 'clinical_authority_bootstrap'),
  ]);
  return { decisions, credentials, delegations, bootstraps };
};
export const serverContext = (staff: Staff, deviceId: string, now: number): AuthorizationContext => ({
  userId: staff.staffId, facilityId: staff.facilityId, deviceId, role: staff.role, permissions: staffPermissions(staff),
  policyVersion: POLICY_VERSION, lastServerContactOn: new Date(now).toISOString(),
});
/** Server derives facts, rather than verifying a client's claimed proof/role. No unsigned object is delivered. */
export const deriveAuthority = async (tx: Sql | Tx, staff: Staff, deviceId: string, now: number, eligibilityAt = now): Promise<AuthorityProof> => {
  const projection = projectClinicalAuthority(staff, await authoritySources(tx, staff.facilityId), eligibilityAt);
  projection.expiresOn = new Date(Math.min(Date.parse(projection.expiresOn), now + 7 * 86400000)).toISOString();
  const snapshot = AuthoritySnapshot.parse({
    id: 'server-derived', type: 'authority_snapshot', facilityId: staff.facilityId,
    createdBy: 'system', createdOn: new Date(now).toISOString(), deviceId, staffId: staff.staffId, revision: 1, policyVersion: FACILITY_MIN_POLICY_VERSION,
    issuedOn: new Date(now).toISOString(), ...projection, keyId: 'server-derived', signature: 'internal-authoritative-derivation'
  });
  return { snapshot, signatureVerified: true, currentRevision: 1 };
};
/** Caller holds the facility lock; history remains immutable while the operational stream carries only current rows. */
export const refreshFacilityAuthority = async (tx: Tx, facilityId: string, signer: Signer, now: number): Promise<number> => {
  const sources = await authoritySources(tx, facilityId);
  const staff = await recordsInFacility(tx, facilityId, 'staff');
  const currentRows = await tx`SELECT * FROM authority_snapshots WHERE facility_id=${facilityId} AND is_current`;
  const revisions = await tx<{
    staff_id: string;
    revision: number;
  }[]> `SELECT staff_id,MAX(revision)::integer AS revision FROM authority_snapshots WHERE facility_id=${facilityId} GROUP BY staff_id`;
  await tx`INSERT INTO workforce_signing_keys(id,public_jwk) VALUES(${signer.publicKeyFingerprint},${tx.json(signer.publicJwk())}) ON CONFLICT(id) DO NOTHING`;
  let refreshed = 0;
  for (const worker of staff) {
    const projection = projectClinicalAuthority(worker, sources, now);
    const row = currentRows.find((r) => r.staff_id === worker.staffId);
    const old = row ? fromRow<AuthoritySnapshot>('authority_snapshot', row) : undefined;
    if (old && old.keyId === signer.publicKeyFingerprint && isDeepStrictEqual(old.grants, projection.grants)
      && isDeepStrictEqual(old.reviewScopes, projection.reviewScopes) && isDeepStrictEqual(old.sourceDecisionIds, projection.sourceDecisionIds)
      && (Date.parse(old.expiresOn) > now + 86400000 || Date.parse(projection.expiresOn) <= Date.parse(old.expiresOn) && Date.parse(old.expiresOn) > now))
      continue;
    if (old)
      await tx`UPDATE authority_snapshots SET is_current=false WHERE id=${old.id}`;
    const record = AuthoritySnapshot.parse({
      id: `authority_snapshot:${randomUUID()}`, type: 'authority_snapshot', facilityId,
      createdBy: 'system', createdOn: new Date(now).toISOString(), deviceId: worker.deviceId, staffId: worker.staffId,
      revision: (revisions.find((r) => r.staff_id === worker.staffId)?.revision ?? 0) + 1, policyVersion: FACILITY_MIN_POLICY_VERSION, issuedOn: new Date(now).toISOString(), ...projection,
      keyId: signer.publicKeyFingerprint, signature: 'pending'
    });
    record.signature = signer.signBytes(Buffer.from(authoritySignaturePayload(record))).toString('base64');
    await insertRecord(tx, 'authority_snapshot', record);
    refreshed++;
  }
  return refreshed;
};
/** Reuses the single process timer; refreshes proofs before expiry and at known effective changes. */
export const refreshDueAuthority = async (sql: Sql, signer: Signer, now = Date.now()): Promise<number> => {
  const facilities = await sql`SELECT facility_id FROM authority_snapshots WHERE is_current AND
    (expires_on <= ${new Date(now).toISOString()} OR key_id<>${signer.publicKeyFingerprint}
      OR (expires_on <= ${new Date(now + 86400000).toISOString()} AND issued_on <= ${new Date(now - 6 * 86400000).toISOString()}))
    GROUP BY facility_id ORDER BY MIN(expires_on) LIMIT 50`;
  let total = 0;
  for (const facility of facilities)
    total += await sql.begin(async (tx) => {
      await tx`SELECT id FROM facilities WHERE id=${facility.facility_id} FOR UPDATE`;
      return refreshFacilityAuthority(tx, facility.facility_id as string, signer, now);
    });
  return total;
};
