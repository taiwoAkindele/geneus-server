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
import type { Config } from '../lib/config.ts';
import type { PaystackFetch } from '../billing/paystack.ts';
import { checkoutAvailable } from '../billing/connection.ts';
import { CHECKOUT_REFERENCE, confirmCheckout, startCheckout } from '../billing/checkout.ts';

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
export const registerPatientDocumentRoutes = (
  app: FastifyInstance,
  sql: Sql,
  appUrl: string,
  options: { rateLimit?: boolean; config?: Config; http?: PaystackFetch } = {},
) => {
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
      if (bill && options.config) {
        bill.payable = bill.totals.dueMinor > 0
          && await checkoutAvailable(sql, options.config, link.facilityId, bill.currency);
      }
      return bill ? { kind: 'bill', bill } satisfies PublicDocument : reply.code(404).send(UNAVAILABLE);
    }
    const receipt = await loadReceipt(sql, link.facilityId, link.subject);
    return receipt ? { kind: 'receipt', receipt } satisfies PublicDocument : reply.code(404).send(UNAVAILABLE);
  });

  const paymentLimiter = createRateLimiter(5, 60_000);

  app.post<{ Params: Params }>('/public/documents/:kind/:token/pay', async (request, reply) => {
    const link = await open(request, reply);

    if (!link) {
      return;
    }

    if (link.kind !== 'bill' || !options.config) {
      return reply.code(404).send(UNAVAILABLE);
    }

    if (options.rateLimit !== false) {
      const wait = paymentLimiter.hit(`checkout ${request.ip}`);

      if (wait !== undefined) {
        return reply.code(429).header('retry-after', String(wait)).send({
          error: 'rate_limited',
          message: 'Too many payment attempts. Try again in a minute.',
        });
      }
    }

    const returnUrl = `${appUrl.replace(/\/+$/, '')}${patientPagePath('bill', request.params.token)}`;

    return startCheckout(sql, options.config, link, returnUrl, options.http);
  });

  app.get<{ Params: Params & { reference: string } }>(
    '/public/documents/:kind/:token/checkout/:reference',
    async (request, reply) => {
      const link = await open(request, reply);

      if (!link) {
        return;
      }

      if (link.kind !== 'bill' || !options.config) {
        return reply.code(404).send(UNAVAILABLE);
      }

      const state = await confirmCheckout(sql, options.config, request.params.reference, options.http, { linkId: link.id });

      return state ?? reply.code(404).send(UNAVAILABLE);
    },
  );

  app.get<{ Params: Params & { reference: string } }>(
    '/public/documents/:kind/:token/checkout/:reference/receipt',
    async (request, reply) => {
      const link = await open(request, reply);

      if (!link) {
        return;
      }

      if (link.kind !== 'bill' || !CHECKOUT_REFERENCE.test(request.params.reference)) {
        return reply.code(404).send(UNAVAILABLE);
      }

      const [session] = await sql<{ reference: string }[]>`
        SELECT reference FROM checkout_sessions WHERE reference = ${request.params.reference}
          AND link_id = ${link.id} AND status = 'paid'`;
      const receipt = session
        ? await loadReceipt(sql, link.facilityId, `payment:${session.reference}`)
        : undefined;

      if (!receipt) {
        return reply.code(404).send(UNAVAILABLE);
      }

      const filename = `Receipt-${receipt.number}.pdf`.replace(/[^A-Za-z0-9._-]/g, '-');

      return reply.header('content-disposition', `attachment; filename="${filename}"`)
        .type('application/pdf')
        .send(Buffer.from(await receiptPdf(receipt)));
    },
  );

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
