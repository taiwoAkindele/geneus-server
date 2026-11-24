import type { FacilityDetails } from '#shared';
import { EmailNotSent, type EmailMessage, type Mailer } from '../lib/email.ts';

/**
 * The emails of facility sign-up: to each Geneus operator when someone asks
 * for a facility, and to that person once an operator decides. Links carry
 * their token in the fragment, which browsers never send to a server, so it
 * stays out of every access log on the way.
 */

const withoutTrailingSlash = (appUrl: string) => appUrl.replace(/\/+$/, '');

export const reviewLink = (appUrl: string, token: string) =>
  `${withoutTrailingSlash(appUrl)}/operator/facility-request#token=${token}`;

export const registrationLink = (appUrl: string, token: string) =>
  `${withoutTrailingSlash(appUrl)}/onboarding/register#token=${token}`;

/** As the registration form names them (FacilityDetailsFields in geneus-web). */
const LEVEL_LABELS: Record<FacilityDetails['level'], string> = {
  phc: 'Primary',
  general_hospital: 'Secondary',
  teaching_hospital: 'Tertiary',
  chc: 'Community health centre',
  specialist: 'Specialist',
};

const describeFacility = (facility: FacilityDetails): string[] => [
  `Facility: ${facility.name} (${facility.code})`,
  `Level of care: ${LEVEL_LABELS[facility.level]}`,
  `Location: ${facility.lga}, ${facility.state}`,
];

export type SignupSummary = {
  facility: FacilityDetails;
  adminFullName: string;
  email: string;
};

export const operatorReviewEmail = (
  summary: SignupSummary,
  link: string,
  expiresOn: string,
): Omit<EmailMessage, 'to'> => ({
  subject: `New facility request: ${summary.facility.name}`,
  text: [
    'Someone has asked Geneus to set up a facility.',
    '',
    ...describeFacility(summary.facility),
    `Requested by: ${summary.adminFullName} <${summary.email}> (email confirmed with a code)`,
    '',
    'Review the request, then approve or reject it:',
    link,
    '',
    `This link is yours alone: the decision is recorded under your name. It works until ${new Date(expiresOn).toUTCString()}, while the request is open. Do not forward it.`,
  ].join('\n'),
});

export const approvalEmail = (
  summary: SignupSummary,
  link: string,
  expiresOn: string,
): Omit<EmailMessage, 'to'> => ({
  subject: `${summary.facility.name} is approved on Geneus`,
  text: [
    `${summary.adminFullName}, your request to set up ${summary.facility.name} on Geneus is approved.`,
    '',
    'Register your facility:',
    link,
    '',
    'Open the link on the phone or computer you will use at the facility. You will confirm the details, choose your password, then a PIN for that device. The device needs an internet connection for this step.',
    '',
    `The link works once, until ${new Date(expiresOn).toUTCString()}. Never share it — nobody from Geneus will ask for it.`,
  ].join('\n'),
});

export const rejectionEmail = (summary: SignupSummary, note: string): Omit<EmailMessage, 'to'> => ({
  subject: `Your Geneus request for ${summary.facility.name}`,
  text: [
    `${summary.adminFullName}, your request to set up ${summary.facility.name} on Geneus was not approved.`,
    '',
    `Reason: ${note}`,
    '',
    'You can send a new request from the Create an account screen in Geneus.',
  ].join('\n'),
});

export type DeliveryResult = 'sent' | 'failed' | 'not_configured';

/**
 * Sends one email and says what happened, without throwing for a refusal: the
 * caller records it so an operator can see the email did not go and send it
 * again. `not_configured` is a development server writing to its own log.
 */
export const deliver = async (mailer: Mailer, message: EmailMessage): Promise<DeliveryResult> => {
  try {
    await mailer.send(message);
  } catch (cause) {
    if (!(cause instanceof EmailNotSent)) {
      throw cause;
    }

    return 'failed';
  }

  return mailer.configured ? 'sent' : 'not_configured';
};
