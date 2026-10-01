import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Sql, Tx } from '../db/client.ts';

/**
 * A 6-digit code emailed to prove someone can read an address. Creating a code
 * and sending it are separate steps, so a caller (or a test) can hold the code
 * without mail.
 *
 * Six digits is a million values, so what protects a code is how few guesses
 * it allows: five, within fifteen minutes, then it is dead. Requesting a new
 * code retires the old one. Only a hash is stored.
 */
export type VerificationPurpose = 'registration' | 'staff_email' | 'staff_email_current';
export type VerificationKey = { purpose: VerificationPurpose; subject: string; email: string };

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const hashOf = (id: string, code: string): string => createHash('sha256').update(`${id}:${code}`).digest('hex');

/** What a registration code is tied to: the invite, as it is stored. */
export const registrationSubject = (inviteToken: string): string => inviteToken.trim().toUpperCase();
/** What a staff email code is tied to: that admin, at that facility. */
export const staffEmailSubject = (facilityId: string, staffId: string): string => `${facilityId}:${staffId}`;

export const createVerificationCode = async (
  sql: Sql,
  key: VerificationKey,
): Promise<{ code: string; expiresOn: string }> => {
  const id = `email_verification:${randomUUID()}`;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresOn = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await sql.begin(async (tx) => {
    await tx`
      UPDATE email_verifications SET consumed_on = now()
      WHERE purpose = ${key.purpose} AND subject = ${key.subject} AND consumed_on IS NULL`;
    await tx`
      INSERT INTO email_verifications (id, purpose, subject, email, code_hash, expires_on)
      VALUES (${id}, ${key.purpose}, ${key.subject}, ${key.email}, ${hashOf(id, code)}, ${expiresOn})`;
  });
  return { code, expiresOn };
};

type OpenVerification = { id: string; email: string; code_hash: string };

/**
 * Checks a code without spending it, and returns the verification's id when it
 * is right for that address. A wrong code counts against the five attempts at
 * once, outside any transaction the caller has open — a later rollback must
 * not hand the guess back. Spend the id with `consumeVerification` in the same
 * transaction as whatever the code unlocks.
 */
export const checkVerificationCode = async (
  sql: Sql,
  key: VerificationKey & { code: string },
): Promise<string | undefined> => {
  const [open] = await sql<OpenVerification[]>`
    SELECT id, email, code_hash FROM email_verifications
    WHERE purpose = ${key.purpose} AND subject = ${key.subject}
      AND consumed_on IS NULL AND expires_on > now() AND attempts < ${MAX_ATTEMPTS}
    ORDER BY created_on DESC
    LIMIT 1`;
  if (!open) return undefined;

  const expected = Buffer.from(open.code_hash, 'hex');
  const given = Buffer.from(hashOf(open.id, key.code.trim()), 'hex');
  if (open.email === key.email && timingSafeEqual(expected, given)) return open.id;

  await sql`UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ${open.id}`;
  return undefined;
};

/** Spends a checked code. False when it was spent or expired in the meantime — then nothing it guards may happen. */
export const consumeVerification = async (tx: Sql | Tx, id: string): Promise<boolean> =>
  (await tx`UPDATE email_verifications SET consumed_on = now() WHERE id = ${id} AND consumed_on IS NULL AND expires_on > now()`)
    .count === 1;

/** Records a proven address for a member of staff, replacing any earlier one. */
export const saveStaffEmail = async (tx: Sql | Tx, facilityId: string, staffId: string, email: string): Promise<void> => {
  await tx`
    INSERT INTO staff_contacts (facility_id, staff_id, email, verified_on)
    VALUES (${facilityId}, ${staffId}, ${email}, now())
    ON CONFLICT (facility_id, staff_id) DO UPDATE SET email = EXCLUDED.email, verified_on = now(), updated_on = now()`;
};

export const findStaffEmail = async (sql: Sql | Tx, facilityId: string, staffId: string): Promise<string | undefined> =>
  (await sql<{ email: string }[]>`SELECT email FROM staff_contacts WHERE facility_id = ${facilityId} AND staff_id = ${staffId}`)[0]?.email;

export const verificationEmail = (code: string, purpose: VerificationPurpose) => ({
  subject: `Your Geneus verification code: ${code}`,
  text: [
    `Your Geneus verification code is ${code}.`,
    '',
    purpose === 'registration'
      ? 'Enter it on the facility registration screen to confirm this is your email.'
      : purpose === 'staff_email'
        ? 'Enter it in Geneus to confirm this as your recovery email.'
        : 'Someone asked to replace this recovery email on your Geneus admin account. Enter this code in Geneus only if that was you.',
    'It works once, for 15 minutes. If you did not ask for it, you can ignore this email.',
    '',
    'If you ever forget your PIN, Geneus can email a PIN code to this address.',
  ].join('\n'),
});
