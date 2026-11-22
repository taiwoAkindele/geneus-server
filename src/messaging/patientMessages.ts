import { randomUUID } from 'node:crypto';
import {
  SCHEMA_VERSION,
  availableChannels,
  type DocumentKind,
  type MessageChannel,
  type Patient,
  type PatientMessage,
  type SendToPatientResponse,
} from '#shared';
import type { Sql } from '../db/client.ts';
import { findRecord, insertRecord } from '../db/records.ts';
import { EmailNotSent, type Mailer } from '../lib/email.ts';
import { loadBill, loadReceipt } from '../patientDocuments/documentData.ts';
import { invoicePdf, receiptPdf } from '../patientDocuments/documentPdf.ts';
import { createDocumentLink, patientPagePath } from '../patientDocuments/links.ts';
import { billMessage, receiptMessage } from './documentMessages.ts';
import { maskEmail, maskPhone } from './mask.ts';
import { patientContactNow } from './patientChoice.ts';

/**
 * The outbox for bills and receipts sent to patients. Each send on each channel is a `patient_message` record
 * (synced, so it shows in Activity). It is tried at once; a failure is retried with back-off up to
 * MAX_ATTEMPTS, then marked failed with a reason safe to show staff. Text and PDFs are rebuilt for every
 * attempt from the current records and never stored. Each attempt makes a fresh patient link, because only a
 * link's hash is kept.
 */
export const MAX_ATTEMPTS = 3;

/** Minutes to wait after attempt n before the next one. */
const BACKOFF_MINUTES = [0, 2, 10];

/** Sends one SMS. `to` is the international number without "+", e.g. 2348031234567. */
export type SmsSender = {
  configured: boolean;
  send: (to: string, text: string) => Promise<{ providerMessageId?: string }>;
};

export type MessagingDeps = {
  sql: Sql;
  mailer: Mailer;
  sms?: SmsSender;
  appUrl: string;
  log: { warn: (details: object, message: string) => void };
};

/** 08031234567, +234 803 123 4567 or 2348031234567 → 2348031234567. Undefined when it can't be a phone number. */
export const smsNumber = (input: string): string | undefined => {
  const digits = input.trim().replace(/[\s\-().]/g, '');

  const internationalFor = () => {
    if (/^\+\d+$/.test(digits)) {
      return digits.slice(1);
    }

    // A local Nigerian number (0803…) gets the country code.
    if (/^0\d{10}$/.test(digits)) {
      return `234${digits.slice(1)}`;
    }

    if (/^234\d{10}$/.test(digits)) {
      return digits;
    }

    return undefined;
  };

  const candidate = internationalFor();

  return candidate && /^[1-9]\d{7,14}$/.test(candidate) ? candidate : undefined;
};

/** A safe reason a channel can't be used for this patient now, or undefined when it can. */
const unavailableReason = (
  channel: MessageChannel,
  patient: Patient,
  contact: Awaited<ReturnType<typeof patientContactNow>>,
  sms?: SmsSender,
) => {
  if (channel === 'sms' && !patient.phone) {
    return 'No phone number on file';
  }

  if (channel === 'sms' && !smsNumber(patient.phone!)) {
    return "The phone number on file can't receive SMS";
  }

  if (channel === 'email' && !contact?.email) {
    return 'No email address on file';
  }

  if (!availableChannels(contact, patient.phone).includes(channel)) {
    return `The patient stopped ${channel === 'sms' ? 'SMS' : 'email'}`;
  }

  if (channel === 'sms' && !sms?.configured) {
    return "SMS sending isn't set up yet";
  }

  return undefined;
};

const documentOf = async (sql: Sql, facilityId: string, kind: DocumentKind, subject: string) =>
  kind === 'bill'
    ? await loadBill(sql, facilityId, subject)
    : await loadReceipt(sql, facilityId, subject);

/**
 * Sends a bill or receipt on each requested channel the patient can receive. Returns, per channel, whether it
 * was queued (and tried at once) or refused, and why. Throws when the document isn't on the server.
 */
export const sendDocumentToPatient = async (
  deps: MessagingDeps,
  input: {
    facilityId: string;
    deviceId: string;
    createdBy: string;
    automatic: boolean;
    kind: DocumentKind;
    subject: string;
    channels: readonly MessageChannel[];
  },
): Promise<SendToPatientResponse> => {
  const doc = await documentOf(deps.sql, input.facilityId, input.kind, input.subject);

  if (!doc) {
    throw Object.assign(
      new Error(
        input.kind === 'bill'
          ? 'This bill has no charges on the server yet. Let this device sync, then try again'
          : 'This receipt is not on the server yet, or it is a waiver, which has no receipt',
      ),
      { statusCode: 409 },
    );
  }

  const patient = (await findRecord<Patient>(deps.sql, 'patient', doc.patient.patientId))!;
  const contact = await patientContactNow(deps.sql, input.facilityId, patient.patientId);
  const reference = 'lines' in doc ? doc.reference : doc.number;
  const messages: SendToPatientResponse['messages'] = [];

  for (const channel of input.channels) {
    const reason = unavailableReason(channel, patient, contact, deps.sms);

    if (reason) {
      messages.push({ channel, status: 'refused', reason });
      continue;
    }

    const to = channel === 'sms' ? maskPhone(patient.phone!) : maskEmail(contact!.email!);

    const record: PatientMessage = {
      id: `patient_message:${randomUUID()}`,
      type: 'patient_message',
      facilityId: input.facilityId,
      schemaVersion: SCHEMA_VERSION,
      createdBy: input.createdBy,
      createdOn: new Date().toISOString(),
      deviceId: input.deviceId,
      patientId: patient.patientId,
      kind: input.kind,
      subject: input.subject,
      reference,
      channel,
      to,
      status: 'queued',
      automatic: input.automatic,
      attempts: 0,
    };

    await insertRecord(deps.sql, 'patient_message', record);
    await attemptPatientMessage(deps, record.id);
    messages.push({ channel, to, status: 'queued', messageId: record.id });
  }

  return { messages };
};

/**
 * One attempt at a queued message. Claims it first (attempts + 1) so two passes never send it twice, then
 * sends, then records the outcome. Never throws: a failure is recorded on the message.
 */
export const attemptPatientMessage = async (deps: MessagingDeps, id: string): Promise<void> => {
  const [claimed] = await deps.sql<
    {
      facility_id: string;
      kind: DocumentKind;
      subject: string;
      channel: MessageChannel;
      patient_id: string;
      created_by: string;
      attempts: number;
    }[]
  >`
    UPDATE patient_messages SET attempts = attempts + 1, updated_on = now(), updated_by = 'system'
    WHERE id = ${id} AND status = 'queued' AND attempts < ${MAX_ATTEMPTS}
    RETURNING facility_id, kind, subject, channel, patient_id, created_by, attempts`;

  if (!claimed) {
    return;
  }

  const finish = async (status: 'sent' | 'queued' | 'failed', reason?: string) => {
    await deps.sql`UPDATE patient_messages SET status = ${status}, reason = ${reason ?? null}, updated_on = now(), updated_by = 'system',
      sent_on = ${status === 'sent' ? new Date().toISOString() : null} WHERE id = ${id}`;
  };

  const giveUp = (reason: string) =>
    finish(
      claimed.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
      claimed.attempts >= MAX_ATTEMPTS ? reason : `${reason}. Trying again shortly`,
    );

  try {
    const doc = await documentOf(deps.sql, claimed.facility_id, claimed.kind, claimed.subject);
    const patient = await findRecord<Patient>(deps.sql, 'patient', claimed.patient_id);

    if (!doc || !patient) {
      return finish('failed', 'The bill or receipt is no longer available');
    }

    const contact = await patientContactNow(deps.sql, claimed.facility_id, claimed.patient_id);
    // The patient may have stopped this channel, or changed their details, since the message was queued.
    const reason = unavailableReason(claimed.channel, patient, contact, deps.sms);

    if (reason) {
      return finish('failed', reason);
    }

    const { token } = await createDocumentLink(deps.sql, {
      facilityId: claimed.facility_id,
      kind: claimed.kind,
      subject: claimed.subject,
      patientId: claimed.patient_id,
      createdBy: claimed.created_by,
    });

    const url = `${deps.appUrl.replace(/\/+$/, '')}${patientPagePath(claimed.kind, token)}`;
    const message = 'lines' in doc ? billMessage(doc, url) : receiptMessage(doc, url);

    if (claimed.channel === 'email') {
      const pdf = 'lines' in doc ? await invoicePdf(doc, url) : await receiptPdf(doc);

      const filename =
        'lines' in doc ? `Invoice-${doc.reference}.pdf` : `Receipt-${doc.number}.pdf`;

      await deps.mailer.send({
        to: contact!.email!,
        subject: message.subject,
        text: message.text,
        html: message.html,
        fromName: `${doc.hospital.name} via Geneus`,
        ...(doc.hospital.email ? { replyTo: doc.hospital.email } : {}),
        attachments: [
          {
            filename: filename.replace(/[^A-Za-z0-9._-]/g, '-'),
            content: pdf,
            contentType: 'application/pdf',
          },
        ],
      });
    } else {
      await deps.sms!.send(smsNumber(patient.phone!)!, message.sms);
    }

    await finish('sent');
  } catch (cause) {
    const provider = cause as { providerStatus?: number; providerReason?: string };
    deps.log.warn(
      {
        messageId: id,
        channel: claimed.channel,
        attempt: claimed.attempts,
        cause: cause instanceof Error ? cause.message : String(cause),
        providerStatus: provider.providerStatus,
        providerReason: provider.providerReason,
      },
      'patient message not sent',
    );

    // Best effort inside the failure path: recording that we gave up must not mask the original error.
    const giveUpReason = () => {
      if (cause instanceof EmailNotSent) {
        return "The email service didn't accept the message";
      }

      if (claimed.channel === 'sms') {
        return "The SMS service didn't accept the message";
      }

      return "The message couldn't be sent";
    };

    await giveUp(giveUpReason()).catch(() => undefined);
  }
};

/** Retries messages whose back-off has passed, and any left queued by a restart. Returns how many it tried. */
export const retryPatientMessages = async (deps: MessagingDeps, limit = 20): Promise<number> => {
  const due = await deps.sql<
    { id: string }[]
  >`SELECT id FROM patient_messages WHERE status = 'queued' AND attempts < ${MAX_ATTEMPTS}
    AND coalesce(updated_on, created_on) < now() - make_interval(mins => (${BACKOFF_MINUTES}::int[])[least(attempts + 1, ${BACKOFF_MINUTES.length})] + 1)
    ORDER BY created_on LIMIT ${limit}`;

  for (const { id } of due) {
    await attemptPatientMessage(deps, id);
  }

  return due.length;
};

export type PatientMessaging = { stop: () => Promise<void> };

/** Every minute in the server process: sends queued receipts, then retries messages. A pass never overlaps the previous one. */
export const startPatientMessaging = (
  deps: MessagingDeps & {
    log: MessagingDeps['log'] & { error: (details: object, message: string) => void };
  },
  intervalMs = 60_000,
): PatientMessaging => {
  let running: Promise<void> | undefined;

  const pass = () => {
    if (running) {
      return;
    }

    running = sendQueuedReceipts(deps)
      .then(() => retryPatientMessages(deps))
      .then(
        () => undefined,
        (cause: unknown) => deps.log.error({ cause }, 'patient message retry pass failed'),
      )
      .finally(() => {
        running = undefined;
      });
  };

  const timer = setInterval(pass, intervalMs);

  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
};

/**
 * Sends the receipts queued when the server accepted payments (the `payments_queue_receipt` trigger), on every
 * channel the patient can receive, as automatic messages in the name of whoever recorded the payment. A
 * patient with no reachable channel simply gets none. Returns how many receipts it handled.
 */
export const sendQueuedReceipts = async (deps: MessagingDeps, limit = 20): Promise<number> => {
  const due = await deps.sql.begin(
    async (tx) => tx<
      { payment_id: string; facility_id: string; created_by: string; device_id: string }[]
    >`
    DELETE FROM patient_receipt_queue q USING payments p
    WHERE q.payment_id IN (SELECT payment_id FROM patient_receipt_queue ORDER BY queued_on LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      AND p.id = q.payment_id AND p.facility_id = q.facility_id
    RETURNING q.payment_id, q.facility_id, p.created_by, p.device_id`,
  );

  for (const r of due) {
    await sendDocumentToPatient(deps, {
      facilityId: r.facility_id,
      deviceId: r.device_id,
      createdBy: r.created_by,
      automatic: true,
      kind: 'receipt',
      subject: r.payment_id,
      channels: ['sms', 'email'],
    }).catch((cause: unknown) =>
      deps.log.warn(
        { paymentId: r.payment_id, cause: cause instanceof Error ? cause.message : String(cause) },
        'automatic receipt not sent',
      ),
    );
  }

  return due.length;
};
