/**
 * Sending email, for the two things the server emails: a code proving an
 * address, and a PIN setup code for an admin who forgot their PIN. Resend's
 * HTTP API through `fetch` — one POST, so no client library.
 *
 * Without RESEND_API_KEY, development writes each message to the log instead,
 * so registration works locally with no account. Production does not: a
 * message that cannot be sent is an error the caller reports, and /health says
 * email is not configured.
 */
export type EmailMessage = { to: string; subject: string; text: string };

export type Mailer = {
  /** Whether messages actually leave the server. */
  configured: boolean;
  send: (message: EmailMessage) => Promise<void>;
};

export class EmailNotSent extends Error {
  constructor(reason: string) {
    super(`email not sent: ${reason}`);
    this.name = 'EmailNotSent';
  }
}

type Log = { warn: (details: object, message: string) => void };

const RESEND_URL = 'https://api.resend.com/emails';

export const createMailer = (
  config: { resendApiKey?: string; emailFrom?: string; isProduction: boolean },
  log: Log,
): Mailer => {
  const { resendApiKey, emailFrom } = config;
  if (resendApiKey && emailFrom) {
    return {
      configured: true,
      send: async ({ to, subject, text }) => {
        const response = await fetch(RESEND_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${resendApiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: emailFrom, to: [to], subject, text }),
          signal: AbortSignal.timeout(10_000),
        }).catch((cause: unknown) => {
          throw new EmailNotSent(cause instanceof Error ? cause.message : 'network error');
        });
        // Resend's error body names the problem (a bad key, an unverified domain); it carries no message content.
        if (!response.ok) throw new EmailNotSent(`Resend answered ${response.status}: ${await response.text()}`);
      },
    };
  }

  return {
    configured: false,
    send: async (message) => {
      if (config.isProduction) throw new EmailNotSent('RESEND_API_KEY and EMAIL_FROM are not set');
      log.warn({ to: message.to, subject: message.subject, text: message.text }, 'email not configured — message written to the log instead (development only)');
    },
  };
};

/** `amaka@example.org` → `a•••@example.org`: enough to recognise, not enough to harvest. */
export const maskEmail = (email: string): string => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};
