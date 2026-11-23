import type { DevicePasswordChallenge, DevicePasswordSignInResult } from '#shared';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { isPostgresError, UNIQUE_VIOLATION, type Sql } from '../db/client.ts';
import { enrollOwnDevice } from '../devices/enrollment.ts';
import {
  checkVerificationCode,
  consumeVerification,
  createVerificationCode,
  verificationEmail,
} from '../email/verifications.ts';
import { maskEmail, type Mailer } from '../lib/email.ts';
import { checkPassword, issuePinGrant, primaryMembership } from './staffPasswords.ts';
import { openSession, StaffSessionRefusal } from './staffSessions.ts';

/**
 * Signing in on a device enrolled at no facility (SCHEMA.md §10, "New
 * devices"): the right password emails a 6-digit code, and the code enrols
 * this device at the person's primary facility and signs them in. Two factors,
 * because this is the one sign-in that creates a new replica of patient data.
 */

/** The code is tied to the email and the device that asked for it. */
const subjectFor = (email: string, deviceId: string) => JSON.stringify([email, deviceId]);

const NOT_SET_UP = 'You are not set up at any facility yet. Ask your administrator to add you';

export const beginDeviceSignIn = async (
  sql: Sql,
  mailer: Mailer,
  input: { email: string; password: string; deviceId: string },
): Promise<DevicePasswordChallenge> => {
  const check = await checkPassword(sql, input.email, input.password);

  if (!check.ok && check.reason === 'locked') {
    throw new StaffSessionRefusal('locked', 'Too many wrong passwords. Try again later', {
      retryAt: check.retryAt,
    });
  }

  if (!check.ok) {
    throw new StaffSessionRefusal('wrong_password', 'That email or password is not right');
  }

  if (!(await primaryMembership(sql, input.email))) {
    throw new StaffSessionRefusal('not_at_facility', NOT_SET_UP);
  }

  const [enrolled] = await sql`SELECT 1 FROM devices WHERE id = ${input.deviceId}`;

  if (enrolled) {
    throw new StaffSessionRefusal(
      'device_already_enrolled',
      'This device is already set up. Sign in from its facility screen',
    );
  }

  const fresh = await createVerificationCode(sql, {
    purpose: 'device_sign_in',
    subject: subjectFor(input.email, input.deviceId),
    email: input.email,
  });

  await mailer.send({ to: input.email, ...verificationEmail(fresh.code, 'device_sign_in') });

  return { sentTo: maskEmail(input.email), expiresOn: fresh.expiresOn };
};

export const confirmDeviceSignIn = async (
  sql: Sql,
  syncEndpoint: string,
  input: { email: string; deviceId: string; code: string; deviceLabel?: string },
): Promise<DevicePasswordSignInResult> => {
  const verificationId = await checkVerificationCode(sql, {
    purpose: 'device_sign_in',
    subject: subjectFor(input.email, input.deviceId),
    email: input.email,
    code: input.code,
  });

  if (!verificationId) {
    throw new StaffSessionRefusal('invalid_code', 'The code is not right, or has expired');
  }

  try {
    return await sql.begin(async (tx) => {
      if (!(await consumeVerification(tx, verificationId))) {
        throw new StaffSessionRefusal('invalid_code', 'The code is not right, or has expired');
      }

      // Read again: the person may have been deactivated since the code was sent.
      const membership = await primaryMembership(tx, input.email);

      if (!membership) {
        throw new StaffSessionRefusal('not_at_facility', NOT_SET_UP);
      }

      const device = await enrollOwnDevice(
        tx,
        { ...membership, deviceId: input.deviceId, deviceLabel: input.deviceLabel },
        syncEndpoint,
      );

      const identity = { facilityId: membership.facilityId, deviceId: device.deviceId };
      const session = await openSession(tx, identity, membership.staffId);
      const grant = await issuePinGrant(tx, identity, membership.staffId);

      await recordAuditEvent(tx, {
        facilityId: membership.facilityId,
        deviceId: device.deviceId,
        actorStaffId: membership.staffId,
        action: 'login',
        metadata: { context: 'staff_password_new_device' },
      });

      return { device, session: { ...session, ...grant } };
    });
  } catch (cause) {
    if (isPostgresError(cause, UNIQUE_VIOLATION)) {
      throw new StaffSessionRefusal(
        'device_already_enrolled',
        'This device is already set up. Sign in from its facility screen',
      );
    }

    throw cause;
  }
};
