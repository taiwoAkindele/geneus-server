import { randomUUID } from 'node:crypto';
import {
  Device,
  Facility,
  SCHEMA_VERSION,
  Staff,
  staffPassword,
  type FacilityDetails,
  type FacilityRegistration,
  type FacilityRegistrationResponse,
  type FacilityRegistrationResult,
} from '#shared';
import { isPostgresError, UNIQUE_VIOLATION, type Sql, type Tx } from '../db/client.ts';
import { insertRecord } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import {
  checkPassword,
  hashNewPassword,
  hasPassword,
  issuePinGrant,
  savePassword,
  type PasswordHash,
} from '../auth/staffPasswords.ts';
import { openSession } from '../auth/staffSessions.ts';
import { issueCredential } from '../devices/credentials.ts';
import { saveStaffEmail } from '../email/verifications.ts';
import { claimInvite, findInvite, rejectionFor, type InviteRejection } from './invites.ts';
import { approvedRequestForInvite, type ApprovedSignup } from './signupRequests.ts';

/**
 * Facility registration is the one thing a device cannot do for itself: no
 * facility exists yet and it holds no credential. Everything afterwards —
 * staff, rosters, patients — is an ordinary record written on the device and
 * carried up by sync.
 *
 * It starts from a registration link: the invite minted when Geneus approved
 * a sign-up request. The facility details and the admin's proven email are
 * the approved request's, never the device's.
 *
 * One transaction: claim the invite, create the facility, its first admin and
 * the registering device, mint that device's credential, keep the admin's
 * email, save their first password, and sign them in on this device. Any
 * failure rolls the whole thing back, invite included.
 *
 * The password is hashed or checked before the transaction: both are slow,
 * and a wrong guess must count against the email even when registering fails.
 */
export type RegistrationOutcome =
  | { ok: true; result: FacilityRegistrationResponse }
  | { ok: false; error: 'invalid_invite'; rejection: InviteRejection }
  | { ok: false; error: 'invalid_password'; message: string }
  | { ok: false; error: 'wrong_password' }
  | { ok: false; error: 'locked'; retryAt: string }
  | { ok: false; error: 'facility_code_taken' }
  | { ok: false; error: 'device_already_enrolled' };

type PasswordSettlement =
  | { ok: true; newPassword?: PasswordHash }
  | Extract<RegistrationOutcome, { error: 'invalid_password' | 'wrong_password' | 'locked' }>;

/**
 * Registration never replaces a password the email already has (the person
 * works at another facility): they prove it is them with it instead. An email
 * with no password chooses its first one here.
 */
const settlePassword = async (
  sql: Sql,
  email: string,
  password: string,
): Promise<PasswordSettlement> => {
  if (await hasPassword(sql, email)) {
    const check = await checkPassword(sql, email, password);

    if (check.ok) {
      return { ok: true };
    }

    if (check.reason === 'locked') {
      return { ok: false, error: 'locked', retryAt: check.retryAt };
    }

    return { ok: false, error: 'wrong_password' };
  }

  const chosen = staffPassword.safeParse(password);

  if (!chosen.success) {
    return {
      ok: false,
      error: 'invalid_password',
      message: chosen.error.issues[0]?.message ?? 'Choose a longer password',
    };
  }

  return { ok: true, newPassword: await hashNewPassword(chosen.data) };
};

type UniqueViolation = { constraint_name?: string };

export const facilityRegistrationConflict = (
  cause: unknown,
): 'facility_code_taken' | 'device_already_enrolled' | undefined => {
  if (!isPostgresError(cause, UNIQUE_VIOLATION)) {
    return undefined;
  }

  const constraint = (cause as UniqueViolation).constraint_name;

  if (constraint === 'facilities_pkey') {
    return 'facility_code_taken';
  }

  if (constraint === 'devices_pkey') {
    return 'device_already_enrolled';
  }

  return undefined;
};

/** The facility, its admin and this device, then the admin's session and PIN permission here. */
const createRegisteredFacility = async (
  tx: Tx,
  signup: ApprovedSignup,
  registration: FacilityRegistration,
  newPassword: PasswordHash | undefined,
  syncEndpoint: string,
): Promise<FacilityRegistrationResponse> => {
  const created = await createFacilityRecords(
    tx,
    {
      ...signup.facility,
      adminFullName: signup.adminFullName,
      adminEmail: signup.email,
      deviceId: registration.deviceId,
      deviceLabel: registration.deviceLabel,
    },
    syncEndpoint,
  );

  if (newPassword) {
    await savePassword(tx, signup.email, newPassword, 'registration');
  }

  const identity = { facilityId: created.facility.id, deviceId: created.device.deviceId };
  const session = await openSession(tx, identity, created.admin.id);
  const grant = await issuePinGrant(tx, identity, created.admin.id);

  return { ...created, session: { ...session, ...grant } };
};

export const registerFacility = async (
  sql: Sql,
  registration: FacilityRegistration,
  syncEndpoint: string,
): Promise<RegistrationOutcome> => {
  const inviteRejection = rejectionFor(await findInvite(sql, registration.token));

  if (inviteRejection) {
    return { ok: false, error: 'invalid_invite', rejection: inviteRejection };
  }

  const signup = await approvedRequestForInvite(sql, registration.token);

  if (!signup) {
    return { ok: false, error: 'invalid_invite', rejection: 'unknown' };
  }

  const password = await settlePassword(sql, signup.email, registration.password);

  if (!password.ok) {
    return password;
  }

  try {
    return await sql.begin(async (tx): Promise<RegistrationOutcome> => {
      const invite = await findInvite(tx, registration.token);
      const rejection = rejectionFor(invite);

      if (rejection) {
        return { ok: false, error: 'invalid_invite', rejection };
      }

      if (!(await claimInvite(tx, registration.token, signup.facility.code))) {
        return { ok: false, error: 'invalid_invite', rejection: 'already_used' };
      }

      const result = await createRegisteredFacility(
        tx,
        signup,
        registration,
        password.newPassword,
        syncEndpoint,
      );

      return { ok: true, result };
    });
  } catch (cause) {
    const taken = facilityRegistrationConflict(cause);

    if (taken) {
      return { ok: false, error: taken };
    }

    throw cause;
  }
};

export const facilityExists = async (sql: Sql, code: string): Promise<boolean> =>
  (await sql`SELECT 1 FROM facilities WHERE id = ${code}`).length === 1;

/** What creating a facility's first records needs, whichever way it is registered. */
export type FacilityCreation = FacilityDetails & {
  deviceId: string;
  deviceLabel?: string;
  adminFullName: string;
  adminEmail: string;
};

/** Shared bootstrap for sign-up registration and an authorized organization administrator. */
export const createFacilityRecords = async (
  tx: Sql | Tx,
  registration: FacilityCreation,
  syncEndpoint: string,
  personId?: string,
  deviceSecret?: string,
): Promise<FacilityRegistrationResult> => {
  const now = new Date().toISOString();

  const envelope = {
    facilityId: registration.code,
    schemaVersion: SCHEMA_VERSION,
    createdBy: 'system',
    createdOn: now,
    deviceId: registration.deviceId,
  };

  const facility = Facility.parse({
    ...envelope,
    id: registration.code,
    type: 'facility',
    code: registration.code,
    name: registration.name,
    state: registration.state,
    lga: registration.lga,
    level: registration.level,
  });

  const staffId = `staff:${randomUUID()}`;

  const admin = Staff.parse({
    ...envelope,
    id: staffId,
    type: 'staff',
    staffId,
    fullName: registration.adminFullName,
    ...(personId ? { personId } : {}),
    role: 'facility_admin',
    permission: 'read_write',
    active: true,
  });

  // The first device enrols itself, vouched for by the invite rather than
  // by an already-enrolled device (there is none yet).
  const device = Device.parse({
    ...envelope,
    id: registration.deviceId,
    type: 'device',
    label: registration.deviceLabel,
    enrolledBy: staffId,
    status: 'active',
    wipeRequested: false,
    enrolledOn: now,
  });

  await insertRecord(tx, 'facility', facility);
  await insertRecord(tx, 'staff', admin);
  await insertRecord(tx, 'device', device);
  await saveStaffEmail(tx, facility.id, staffId, registration.adminEmail);
  const credential = await issueCredential(tx, device.id, deviceSecret);

  await recordAuditEvent(tx, {
    facilityId: facility.id,
    deviceId: device.id,
    actorStaffId: staffId,
    action: 'create',
    entityType: 'facility',
    entityId: facility.id,
  });

  await recordAuditEvent(tx, {
    facilityId: facility.id,
    deviceId: device.id,
    actorStaffId: staffId,
    action: 'enroll',
    entityType: 'device',
    entityId: device.id,
  });

  return {
    facility,
    admin,
    device: { deviceId: device.id, facilityId: facility.id, credential, syncEndpoint },
  };
};
