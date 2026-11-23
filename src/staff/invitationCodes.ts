import { pbkdf2Sync, randomInt } from 'node:crypto';
import {
  mayApproveWorkforcePin,
  workforceEnforcementActive,
  type Facility,
  type Staff,
} from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import { findStaffInFacility } from '../auth/staffAuthorization.ts';
import { deriveAuthority, serverContext } from '../workforce/authority.ts';

/**
 * Invitation codes (SCHEMA.md §10): the one-time code in a staff invitation
 * email, which proves the person when they choose their password and PIN.
 * Only a slow hash is stored. Eight characters from a 32-letter alphabet is 40
 * bits; with five wrong guesses allowed per invitation, that is far more than enough.
 */

/** No I/O/0/1, so a code copied from an email is not misread. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const HASH_BYTES = 32;

/** An invitation lives this long. */
export const INVITATION_CODE_TTL_MS = 24 * 60 * 60 * 1000;

export const INVITATION_CODE_ITERATIONS = 100_000;

export const newInvitationCode = (): string =>
  Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/** Case and stray spaces don't matter: the code may be typed by hand from the email. */
const normalize = (code: string): string => code.replace(/\s+/g, '').toUpperCase();

export const hashInvitationCode = (code: string, saltBase64: string, iterations: number): string =>
  pbkdf2Sync(
    normalize(code),
    Buffer.from(saltBase64, 'base64'),
    iterations,
    HASH_BYTES,
    'sha256',
  ).toString('base64');

/**
 * Why `issuedBy` may not invite `staffId`, or undefined when they may. Inviting
 * hands over the power to choose that person's PIN, so where the facility
 * enforces workforce review, the inviter needs the clinical authority to
 * approve this person.
 */
export const invitationAuthorityRefusal = async (
  tx: Tx,
  input: { facilityId: string; staffId: string; issuedBy: string; issuedFrom: string },
): Promise<'unknown_staff' | 'clinical_review_required' | undefined> => {
  const staff = await findStaffInFacility(tx, input.facilityId, input.staffId);

  if (!staff || !staff.active) {
    return 'unknown_staff';
  }

  const facility = await findRecord<Facility>(tx, 'facility', input.facilityId);

  if (!workforceEnforcementActive(facility?.workforcePolicy, Date.now())) {
    return undefined;
  }

  const actor = await findRecord<Staff>(tx, 'staff', input.issuedBy);
  const target = await findRecord<Staff>(tx, 'staff', input.staffId);
  const now = Date.now();

  if (
    !actor ||
    !target ||
    !mayApproveWorkforcePin(
      actor,
      serverContext(actor, input.issuedFrom, now),
      await deriveAuthority(tx, actor, input.issuedFrom, now),
      target,
      (await deriveAuthority(tx, target, input.issuedFrom, now)).snapshot,
      now,
    )
  ) {
    return 'clinical_review_required';
  }

  return undefined;
};
