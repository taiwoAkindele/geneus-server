import type { Config } from '../lib/config.ts';
import type { SmsSender } from './patientMessages.ts';

/**
 * Geneus's SMS provider, Sendar (sendar.io): one Geneus account for every hospital, configured in the server
 * environment. From Sendar's technical specification:
 *
 *   POST {base}/api/sms/send   header API-KEY
 *   { contact: [{ number: "2348031234567", body, sms_type: "plain" }], sender_id, wallet_type: "transactional" }
 *   → { status, total, queued, batch_id, key_type, total_cost, data: [{ number, message_id, status }] }
 *   401 a bad key · 400 a malformed request
 *
 * The transactional wallet reaches numbers on Do-Not-Disturb. Sendar's marketing pages show other addresses, so
 * scripts/send-test-sms.ts confirms this one with Geneus's real key before patients rely on it.
 */
export class SmsNotSent extends Error {
  /** Sendar's HTTP status and its own words, for the log only (never shown to staff or patients). */
  readonly providerStatus?: number; readonly providerReason?: string;
  constructor(providerStatus?: number, providerReason?: string) {
    super('sms not sent');
    this.name = 'SmsNotSent'; this.providerStatus = providerStatus; this.providerReason = providerReason;
  }
}

type SendarReply = { status?: unknown; message?: unknown; detail?: unknown; data?: { number?: string; message_id?: unknown; status?: unknown }[] };

export const createSendarSender = (options: { apiKey: string; senderId: string; baseUrl: string }, fetcher: typeof fetch = fetch): SmsSender => ({
  configured: true,
  send: async (to, text) => {
    const response = await fetcher(`${options.baseUrl.replace(/\/+$/, '')}/api/sms/send`, {
      method: 'POST',
      headers: { 'API-KEY': options.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ contact: [{ number: to, body: text, sms_type: 'plain' }], sender_id: options.senderId, wallet_type: 'transactional' }),
      signal: AbortSignal.timeout(15_000),
    }).catch((cause: unknown) => { throw new SmsNotSent(undefined, cause instanceof Error ? cause.message : 'network error'); });
    // Sendar's own words, whatever field it puts them in (or the raw body), for the log. Its replies carry no key.
    const raw = await response.text().catch(() => '');
    const reply = ((): SendarReply | undefined => { try { return JSON.parse(raw) as SendarReply; } catch { return undefined; } })();
    const said = [reply?.message, reply?.detail].find((v): v is string => typeof v === 'string');
    const why = (said ?? raw).replace(/\s+/g, ' ').slice(0, 300) || undefined;
    if (!response.ok) throw new SmsNotSent(response.status, why);
    const entry = reply?.data?.[0];
    const refused = reply?.status === false || reply?.status === 'error' || (typeof entry?.status === 'string' && /fail|reject|invalid/i.test(entry.status));
    if (refused) throw new SmsNotSent(response.status, why ?? String(entry?.status ?? 'refused'));
    return entry?.message_id !== undefined ? { providerMessageId: String(entry.message_id) } : {};
  },
});

/** The server's SMS sender, or undefined when Sendar isn't configured (SMS is then refused as "not set up yet"). */
export const smsSenderFrom = (config: Pick<Config, 'sendarApiKey' | 'sendarSenderId' | 'sendarBaseUrl'>, fetcher?: typeof fetch): SmsSender | undefined =>
  config.sendarApiKey && config.sendarSenderId ? createSendarSender({ apiKey: config.sendarApiKey, senderId: config.sendarSenderId, baseUrl: config.sendarBaseUrl }, fetcher) : undefined;
