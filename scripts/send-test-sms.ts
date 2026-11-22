/**
 * Sends one test SMS through Geneus's Sendar account, to confirm the key, the sender name and Sendar's API
 * address before patients rely on them (docs/PATIENT-BILL-DELIVERY-PLAN-2026-11-21.md, step 4).
 *
 *   node --env-file=.env scripts/send-test-sms.ts 08031234567
 *
 * Needs SENDAR_API_KEY and SENDAR_SENDER_ID (and SENDAR_BASE_URL if Sendar gave another address).
 * Prints only the outcome: never the key.
 */
import { loadConfig } from '../src/lib/config.ts';
import { smsSenderFrom } from '../src/messaging/sendar.ts';
import { smsNumber } from '../src/messaging/patientMessages.ts';

const config = loadConfig();
const sender = smsSenderFrom(config);
const to = smsNumber(process.argv[2] ?? '');

if (!sender) {
  console.error('SENDAR_API_KEY and SENDAR_SENDER_ID are not set.');
  process.exit(1);
}

if (!to) {
  console.error('Give a phone number to send to, e.g. 08031234567.');
  process.exit(1);
}

try {
  const receipt = await sender.send(
    to,
    `Geneus test message from ${config.sendarSenderId}. If you received this, SMS is working.`,
  );

  console.log(
    `Sent to ${to.slice(0, 6)}***${to.slice(-3)} through ${config.sendarBaseUrl}.`,
    receipt.providerMessageId ? `Sendar message id: ${receipt.providerMessageId}` : '',
  );
} catch (cause) {
  const detail = cause as { providerStatus?: number; providerReason?: string };
  console.error(
    `Not sent. Sendar answered ${detail.providerStatus ?? 'nothing'}${detail.providerReason ? `: ${detail.providerReason}` : ''}`,
  );

  process.exit(1);
}
