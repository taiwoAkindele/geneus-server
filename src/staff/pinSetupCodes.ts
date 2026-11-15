import { pbkdf2Sync, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { normalizePinSetupCode, PinSetupCode, SCHEMA_VERSION } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { insertRecord } from '../db/records.ts';
import { findRecord } from '../db/records.ts';
import { mayApproveWorkforcePin, workforceEnforcementActive, type Facility, type Staff } from '#shared';
import { deriveAuthority, serverContext } from '../workforce/authority.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { findStaffInFacility } from '../auth/staffAuthorization.ts';

/**
 * PIN setup codes (SCHEMA.md §10): how a member of staff gets permission to set
 * their PIN on a facility device when no admin is standing beside them. The
 * admin's own PIN never leaves their phone; this code is the approval instead.
 *
 * The record syncs down to every device of the facility so a code can be
 * checked offline, which is why only a slow hash of it is stored. Eight
 * characters from a 32-letter alphabet is 40 bits; at this iteration count,
 * guessing one from a copied replica takes far longer than the 24 hours a
 * code lives.
 */

/** Same alphabet as enrollment codes: no I/O/0/1, because it is read out over the phone. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
/** Read aloud or sent as an invitation, a code lives this long. */
export const PIN_SETUP_CODE_TTL_MS = 24 * 60 * 60 * 1000;

export const newPinSetupCode = (): string => Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
/** Kept low enough that a sub-$100 phone checks a code in well under a second. */
export const PIN_SETUP_CODE_ITERATIONS = 100_000;
const HASH_BYTES = 32;

export const hashPinSetupCode = (code: string, saltBase64: string, iterations: number): string =>
  pbkdf2Sync(normalizePinSetupCode(code), Buffer.from(saltBase64, 'base64'), iterations, HASH_BYTES, 'sha256').toString('base64');

/**
 * Who asked for a code: an admin for someone else (from the Staff screen), a
 * facility admin for themselves by email, or the operator from the command
 * line as the last resort. Recorded on the audit event.
 */
export type PinSetupCodeChannel = 'admin' | 'email' | 'operator';

export type PinSetupCodeOutcome =
  | { ok: true; code: string; record: PinSetupCode }
  | { ok: false; error: 'unknown_staff' | 'clinical_review_required' };

/**
 * Why `issuedBy` may not give `staffId` a PIN code, or undefined when they may.
 * A code read aloud and a code sent as an invitation hand over the same power,
 * so both pass this one check. `clinicalReview` is false only when the code
 * goes to the person's own proven inbox (an admin who forgot their PIN).
 */
export const pinAuthorityRefusal = async (
  tx: Tx,
  input: { facilityId: string; staffId: string; issuedBy: string; issuedFrom: string },
  clinicalReview: boolean,
): Promise<'unknown_staff' | 'clinical_review_required' | undefined> => {
  const staff = await findStaffInFacility(tx, input.facilityId, input.staffId);
  if (!staff || !staff.active) return 'unknown_staff';
  const facility = await findRecord<Facility>(tx, 'facility', input.facilityId);
  if (clinicalReview && workforceEnforcementActive(facility?.workforcePolicy, Date.now())) {
    const actor = await findRecord<Staff>(tx, 'staff', input.issuedBy), target = await findRecord<Staff>(tx, 'staff', input.staffId);
    const now = Date.now();
    if (!actor || !target || !mayApproveWorkforcePin(actor, serverContext(actor, input.issuedFrom, now), await deriveAuthority(tx, actor, input.issuedFrom, now), target,
      (await deriveAuthority(tx, target, input.issuedFrom, now)).snapshot, now)) return 'clinical_review_required';
  }
  return undefined;
};

/**
 * Revokes every unused code read aloud for this person. The revocation syncs to
 * the facility's devices; a device that has not synced since can still accept
 * the old code offline until it does — the documented limit of offline checks.
 */
export const revokeOpenPinSetupCodes = async (tx: Tx, input: { facilityId: string; staffId: string; issuedBy: string }): Promise<void> => {
  const now = new Date().toISOString();
  await tx`
    UPDATE pin_setup_codes
    SET revoked_on = ${now}, updated_by = ${input.issuedBy}, updated_on = ${now}
    WHERE facility_id = ${input.facilityId} AND staff_id = ${input.staffId}
      AND used_on IS NULL AND revoked_on IS NULL`;
};

/**
 * Issues a code for `staffId` and revokes any earlier unused one for the same
 * person — and any invitation still waiting — in one transaction, so at most
 * one code per person is ever live.
 */
export const issuePinSetupCode = async (
  sql: Sql,
  input: { facilityId: string; staffId: string; issuedBy: string; issuedFrom: string; channel?: PinSetupCodeChannel },
): Promise<PinSetupCodeOutcome> =>
  sql.begin(async (tx): Promise<PinSetupCodeOutcome> => {
    await tx`SELECT id FROM facilities WHERE id=${input.facilityId} FOR UPDATE`;
    const refusal = await pinAuthorityRefusal(tx, input, (input.channel ?? 'admin') === 'admin');
    if (refusal) return { ok: false, error: refusal };

    const now = new Date();
    await revokeOpenPinSetupCodes(tx, input);
    await tx`
      UPDATE staff_invitations SET revoked_on = now(), revoked_by = ${input.issuedBy}, revoked_reason = 'pin_code_issued'
      WHERE facility_id = ${input.facilityId} AND staff_id = ${input.staffId} AND accepted_on IS NULL AND revoked_on IS NULL`;

    const code = newPinSetupCode();
    const codeSalt = randomBytes(16).toString('base64');
    const record = PinSetupCode.parse({
      id: `pin_setup_code:${randomUUID()}`,
      type: 'pin_setup_code',
      facilityId: input.facilityId,
      schemaVersion: SCHEMA_VERSION,
      createdBy: input.issuedBy,
      createdOn: now.toISOString(),
      deviceId: input.issuedFrom,
      staffId: input.staffId,
      codeHash: hashPinSetupCode(code, codeSalt, PIN_SETUP_CODE_ITERATIONS),
      codeSalt,
      codeIterations: PIN_SETUP_CODE_ITERATIONS,
      expiresOn: new Date(now.getTime() + PIN_SETUP_CODE_TTL_MS).toISOString(),
    });
    await insertRecord(tx, 'pin_setup_code', record);
    await recordAuditEvent(tx, {
      facilityId: input.facilityId,
      deviceId: input.issuedFrom,
      actorStaffId: input.issuedBy === 'system' ? undefined : input.issuedBy,
      action: 'create',
      entityType: 'pin_setup_code',
      entityId: record.id,
      metadata: { staffId: input.staffId, channel: input.channel ?? 'admin' },
    });
    return { ok: true, code, record };
  });
