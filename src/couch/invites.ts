import { randomInt } from 'node:crypto';
import type nano from 'nano';

/**
 * Provisioning a facility creates a database and hands out a credential, so it
 * cannot be open to anyone who can reach the server. An invite is issued out of
 * band (scripts/create-invite.ts) and spent exactly once.
 *
 * Invites live in their own database rather than in a facility's, because they
 * exist before any facility does — and they are plain server state, not part of
 * the replicated contract (SCHEMA.md §8).
 */
export const INVITES_DB = 'geneus-invites';

const ALREADY_EXISTS = 412;
const CONFLICT = 409;

/** No I/O/0/1: these are read off a screen and typed in by hand. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_LENGTH = 10;

export type Invite = {
  _id: string;
  _rev?: string;
  type: 'facility_invite';
  token: string;
  label: string;
  createdOn: string;
  expiresOn: string;
  claimedOn?: string;
  facilityCode?: string;
};

export type InviteRejection = 'unknown' | 'expired' | 'already_used';

const inviteId = (token: string) => `invite:${token.toUpperCase()}`;

export const ensureInvitesDatabase = async (couch: nano.ServerScope): Promise<void> => {
  await couch.db.create(INVITES_DB).catch((cause: { statusCode?: number }) => {
    if (cause.statusCode !== ALREADY_EXISTS) throw cause;
  });
};

export const createInvite = async (
  couch: nano.ServerScope,
  label: string,
  validForDays: number,
): Promise<Invite> => {
  const token = Array.from({ length: TOKEN_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const invite: Invite = {
    _id: inviteId(token),
    type: 'facility_invite',
    token,
    label,
    createdOn: new Date().toISOString(),
    expiresOn: new Date(Date.now() + validForDays * 24 * 60 * 60 * 1000).toISOString(),
  };
  await couch.use<Invite>(INVITES_DB).insert(invite);
  return invite;
};

export const findInvite = async (couch: nano.ServerScope, token: string): Promise<Invite | undefined> =>
  couch
    .use<Invite>(INVITES_DB)
    .get(inviteId(token))
    .catch(() => undefined);

export const rejectionFor = (invite: Invite | undefined): InviteRejection | undefined => {
  if (!invite) return 'unknown';
  if (invite.claimedOn) return 'already_used';
  if (new Date(invite.expiresOn).getTime() < Date.now()) return 'expired';
  return undefined;
};

/**
 * Claims the invite before the facility is provisioned, so two requests racing
 * on the same token cannot both succeed — CouchDB's revision check decides.
 */
export const claimInvite = async (
  couch: nano.ServerScope,
  invite: Invite,
  facilityCode: string,
): Promise<boolean> => {
  try {
    await couch
      .use<Invite>(INVITES_DB)
      .insert({ ...invite, claimedOn: new Date().toISOString(), facilityCode });
    return true;
  } catch (cause) {
    if ((cause as { statusCode?: number }).statusCode === CONFLICT) return false;
    throw cause;
  }
};

/** Puts an invite back when provisioning failed after the claim. */
export const releaseInvite = async (couch: nano.ServerScope, token: string): Promise<void> => {
  const invite = await findInvite(couch, token);
  if (!invite) return;
  const { claimedOn: _claimedOn, facilityCode: _facilityCode, ...released } = invite;
  await couch.use<Invite>(INVITES_DB).insert(released as Invite);
};
