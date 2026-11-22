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
/**
 * `fromName` replaces the sender's display name (the address stays Geneus's verified one), e.g. "Sunrise Hospital
 * via Geneus". `replyTo` sends replies elsewhere, e.g. to the hospital. Attachments are small files sent inline.
 */
export type EmailMessage = {
  to: string; subject: string; text: string; html?: string; fromName?: string; replyTo?: string;
  attachments?: { filename: string; content: Uint8Array; contentType: string }[];
};

/** `Geneus <no-reply@example.org>` with a new display name: quotes and angle brackets are removed from the name. */
export const withDisplayName = (from: string, name: string) => {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from.trim();
  return `"${name.replace(/["<>\\\r\n]/g, '').slice(0, 100)}" <${address}>`;
};

/**
 * What the provider said when it took a message. Acceptance only: whether the
 * message then reached the inbox is a separate fact this server does not see.
 */
export type EmailReceipt = { providerMessageId?: string };

export type Mailer = {
  /** Whether messages actually leave the server. */
  configured: boolean;
  send: (message: EmailMessage) => Promise<EmailReceipt | void>;
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
      send: async ({ to, subject, text, html, fromName, replyTo, attachments }) => {
        const response = await fetch(RESEND_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${resendApiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: fromName ? withDisplayName(emailFrom, fromName) : emailFrom, to: [to], subject, text,
            ...(html ? { html } : {}), ...(replyTo ? { reply_to: replyTo } : {}),
            ...(attachments?.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64'), content_type: a.contentType })) } : {}),
          }),
          signal: AbortSignal.timeout(20_000),
        }).catch((cause: unknown) => {
          throw new EmailNotSent(cause instanceof Error ? cause.message : 'network error');
        });
        // Resend's error body names the problem (a bad key, an unverified domain); it carries no message content.
        if (!response.ok) throw new EmailNotSent(`Resend answered ${response.status}: ${await response.text()}`);
        const accepted = (await response.json().catch(() => undefined)) as { id?: unknown } | undefined;
        return typeof accepted?.id === 'string' ? { providerMessageId: accepted.id } : {};
      },
    };
  }

  return {
    configured: false,
    send: async (message) => {
      if (config.isProduction) throw new EmailNotSent('RESEND_API_KEY and EMAIL_FROM are not set');
      log.warn({ to: message.to, subject: message.subject, text: message.text, attachments: message.attachments?.map((a) => a.filename) }, 'email not configured — message written to the log instead (development only)');
    },
  };
};

/** `amaka@example.org` → `a•••@example.org`: enough to recognise, not enough to harvest. */
export const maskEmail = (email: string): string => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};
