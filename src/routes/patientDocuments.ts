import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DocumentKind, PublicMessageChoice, type ApiErrorBody, type Patient, type PublicDocument, type PublicMessageChoices } from '#shared';
import type { Sql } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import { createRateLimiter } from '../lib/rateLimit.ts';
import { openDocumentLink, patientPagePath, type DocumentLink } from '../patientDocuments/links.ts';
import { loadBill, loadReceipt } from '../patientDocuments/documentData.ts';
import { invoicePdf, receiptPdf } from '../patientDocuments/documentPdf.ts';
import { maskEmail, maskPhone } from '../messaging/mask.ts';
import { patientContactNow, recordPatientChoice } from '../messaging/patientChoice.ts';

/**
 * The data behind the patient's pages, which the web app shows at `/p/b/:token` and `/p/r/:token`, and the
 * PDFs. No sign-in: the token is the only credential (unguessable, hashed at rest, expiring and stoppable).
 * Responses are never indexed or cached.
 *
 *   GET  /public/documents/:kind/:token            the bill or receipt
 *   GET  /public/documents/:kind/:token/pdf        the standard PDF
 *   GET  /public/documents/:kind/:token/messages   the patient's message choices
 *   POST /public/documents/:kind/:token/messages   stop or restart a channel
 */
type Params = { kind: string; token: string };
const UNAVAILABLE: ApiErrorBody = { error: 'link_unavailable', message: "This link isn't available. It may have expired, or the hospital stopped it. Ask the hospital for a new one." };

/** `appUrl` is the web app's public origin: where patient links and the invoice's QR code point. */
export const registerPatientDocumentRoutes = (app: FastifyInstance, sql: Sql, appUrl: string, options: { rateLimit?: boolean } = {}) => {
  // Generous for a patient refreshing a page, far too few for guessing 256-bit tokens to matter.
  const limiter = createRateLimiter(60, 60_000);
  const open = async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply): Promise<DocumentLink | undefined> => {
    reply.header('x-robots-tag', 'noindex, nofollow');
    if (options.rateLimit !== false) {
      const wait = limiter.hit(`patient-documents ${request.ip}`);
      if (wait !== undefined) { reply.code(429).header('retry-after', String(wait)).send({ error: 'rate_limited', message: 'Too many requests. Try again in a minute.' } satisfies ApiErrorBody); return; }
    }
    const kind = DocumentKind.safeParse(request.params.kind);
    const link = kind.success ? await openDocumentLink(sql, kind.data, request.params.token) : undefined;
    if (!link) { reply.code(404).send(UNAVAILABLE); return; }
    return link;
  };

  app.get<{ Params: Params }>('/public/documents/:kind/:token', async (request, reply) => {
    const link = await open(request, reply); if (!link) return;
    if (link.kind === 'bill') {
      const bill = await loadBill(sql, link.facilityId, link.subject);
      return bill ? { kind: 'bill', bill } satisfies PublicDocument : reply.code(404).send(UNAVAILABLE);
    }
    const receipt = await loadReceipt(sql, link.facilityId, link.subject);
    return receipt ? { kind: 'receipt', receipt } satisfies PublicDocument : reply.code(404).send(UNAVAILABLE);
  });

  app.get<{ Params: Params }>('/public/documents/:kind/:token/pdf', async (request, reply) => {
    const link = await open(request, reply); if (!link) return;
    const send = (bytes: Uint8Array, name: string) => reply.header('content-disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '-')}"`).type('application/pdf').send(Buffer.from(bytes));
    if (link.kind === 'bill') {
      const bill = await loadBill(sql, link.facilityId, link.subject);
      return bill ? send(await invoicePdf(bill, `${appUrl.replace(/\/+$/, '')}${patientPagePath('bill', request.params.token)}`), `Invoice-${bill.reference}.pdf`) : reply.code(404).send(UNAVAILABLE);
    }
    const receipt = await loadReceipt(sql, link.facilityId, link.subject);
    return receipt ? send(await receiptPdf(receipt), `Receipt-${receipt.number}.pdf`) : reply.code(404).send(UNAVAILABLE);
  });

  const choices = async (link: DocumentLink, changed?: boolean): Promise<PublicMessageChoices> => {
    const [patient, contact, facility] = await Promise.all([
      findRecord<Patient>(sql, 'patient', link.patientId), patientContactNow(sql, link.facilityId, link.patientId),
      sql<{ name: string }[]>`SELECT name FROM facilities WHERE id = ${link.facilityId}`,
    ]);
    return {
      hospital: facility[0]?.name ?? 'The hospital', ...(changed === undefined ? {} : { changed }),
      ...(patient?.phone ? { sms: { to: maskPhone(patient.phone), stopped: Boolean(contact?.smsStopped) } } : {}),
      ...(contact?.email ? { email: { to: maskEmail(contact.email), stopped: contact.emailStopped } } : {}),
    };
  };
  app.get<{ Params: Params }>('/public/documents/:kind/:token/messages', async (request, reply) => {
    const link = await open(request, reply); if (!link) return;
    return choices(link);
  });
  app.post<{ Params: Params }>('/public/documents/:kind/:token/messages', async (request, reply) => {
    const link = await open(request, reply); if (!link) return;
    const body = PublicMessageChoice.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Choose SMS or email, and whether to stop or start it.' } satisfies ApiErrorBody);
    return choices(link, await recordPatientChoice(sql, link.facilityId, link.patientId, body.data.channel, body.data.choice));
  });
};
