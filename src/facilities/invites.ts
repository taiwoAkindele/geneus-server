import { randomInt } from 'node:crypto';
import type { Sql, Tx } from '../db/client.ts';

/**
 * Registering a facility creates an organisation and enrols a device, so it
 * cannot be open to anyone who can reach the server. An invite is issued out
 * of band (scripts/create-invite.ts) and spent exactly once.
 *
 * Invites are plain server state — they exist before any facility does and are
 * never synced — so they have their own table and no contract shape.
 */

/** No I/O/0/1: these are read off a screen and typed in by hand. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_LENGTH = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Invite = {
  token: string;
  label: string;
  createdOn: string;
  expiresOn: string;
  claimedOn?: string;
  claimedFor?: string;
};

export type InviteRejection = 'unknown' | 'expired' | 'already_used';

type InviteRow = {
  token: string;
  label: string;
  created_on: string;
  expires_on: string;
  claimed_on: string | null;
  claimed_for: string | null;
};

const fromRow = (row: InviteRow): Invite => ({
  token: row.token,
  label: row.label,
  createdOn: row.created_on,
  expiresOn: row.expires_on,
  ...(row.claimed_on ? { claimedOn: row.claimed_on, claimedFor: row.claimed_for ?? undefined } : {}),
});

const normalise = (token: string) => token.trim().toUpperCase();

export const createInvite = async (sql: Sql, label: string, validForDays: number): Promise<Invite> => {
  const token = Array.from({ length: TOKEN_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const expiresOn = new Date(Date.now() + validForDays * DAY_MS).toISOString();
  const [row] = await sql<InviteRow[]>`
    INSERT INTO facility_invites (token, label, expires_on)
    VALUES (${token}, ${label}, ${expiresOn})
    RETURNING *`;
  return fromRow(row);
};

export const findInvite = async (sql: Sql | Tx, token: string): Promise<Invite | undefined> => {
  const [row] = await sql<InviteRow[]>`SELECT * FROM facility_invites WHERE token = ${normalise(token)}`;
  return row ? fromRow(row) : undefined;
};

export const rejectionFor = (invite: Invite | undefined): InviteRejection | undefined => {
  if (!invite) return 'unknown';
  if (invite.claimedOn) return 'already_used';
  if (new Date(invite.expiresOn).getTime() < Date.now()) return 'expired';
  return undefined;
};

/**
 * Claims the invite in one statement: two requests racing on the same token
 * both run the UPDATE, and PostgreSQL's row lock lets exactly one of them see
 * `claimed_on IS NULL`. Run inside the registration transaction, so a failure
 * later in that transaction releases the invite by rollback — there is no
 * separate "release" step to forget.
 */
export const claimInvite = async (sql: Sql | Tx, token: string, facilityCode: string): Promise<boolean> => {
  const claimed = await sql`
    UPDATE facility_invites
    SET claimed_on = now(), claimed_for = ${facilityCode}
    WHERE token = ${normalise(token)}
      AND claimed_on IS NULL
      AND expires_on >= now()`;
  return claimed.count === 1;
};
