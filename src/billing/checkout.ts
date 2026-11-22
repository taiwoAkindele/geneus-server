import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  billKey,
  IncomingTransfer,
  Payment,
  SCHEMA_VERSION,
  type Charge,
  type CheckoutStart,
  type CheckoutState,
} from '#shared';
import type { Sql } from '../db/client.ts';
import { fromRow, insertRecord } from '../db/records.ts';
import type { Config } from '../lib/config.ts';
import { patientContactNow } from '../messaging/patientChoice.ts';
import { loadBill } from '../patientDocuments/documentData.ts';
import { type DocumentLink } from '../patientDocuments/links.ts';
import { chargePositions } from '../insurance/coverage.ts';
import { providerConnection } from './connection.ts';
import { openPaystackSecret, type PaystackFetch } from './paystack.ts';
import { deserialiseCredentials, paymentProvider } from './providers/index.ts';
import { nextReceiptNumber } from './receipts.ts';
import { reserveSource } from './sourceCapacity.ts';

export const CHECKOUT_REFERENCE = /^geneus-co-[a-f0-9-]{36}$/;
const CHECKOUT_DURATION_MS = 30 * 60_000;
const MAX_AMOUNT_MINOR = 2_147_483_647;

type CheckoutSession = {
  reference: string;
  facility_id: string;
  bill_key: string;
  patient_id: string;
  amount_minor: number;
  currency: string;
  provider: string;
  mode: 'test' | 'live';
  encrypted_secret: string;
  charge_ids: string[];
  link_id: string;
  status: 'pending' | 'paid' | 'failed';
  expires_on: string;
  held_minor: number | null;
};

type CheckoutScope = { facilityId: string; provider: string } | { linkId: string };

const conflict = (message: string) => Object.assign(new Error(message), {
  statusCode: 409,
  code: 'checkout_unavailable',
});

const withinScope = (session: CheckoutSession, scope: CheckoutScope): boolean => {
  if ('linkId' in scope) {
    return session.link_id === scope.linkId;
  }

  return session.facility_id === scope.facilityId && session.provider === scope.provider;
};

const WebhookReferences = z.object({
  data: z.object({ reference: z.string().optional() }).optional(),
  eventData: z.object({
    paymentReference: z.string().optional(),
    product: z.object({ reference: z.string().optional() }).optional(),
  }).optional(),
});

/** Identify the encrypted connection, then authenticate the exact webhook bytes before using its reference. */
export const acceptCheckoutWebhook = async (
  sql: Sql,
  config: Config,
  scope: { facilityId: string; provider: string },
  raw: string,
  signature: unknown,
  http: PaystackFetch,
): Promise<boolean | undefined> => {
  let payload: unknown;

  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const parsed = WebhookReferences.safeParse(payload);

  if (!parsed.success) {
    return undefined;
  }

  const reference = parsed.data.data?.reference
    ?? parsed.data.eventData?.paymentReference
    ?? parsed.data.eventData?.product?.reference;

  if (!reference || !CHECKOUT_REFERENCE.test(reference)) {
    return undefined;
  }

  const [session] = await sql<CheckoutSession[]>`SELECT * FROM checkout_sessions WHERE reference = ${reference}`;

  if (!session || !withinScope(session, scope) || !config.billingEncryptionKey) {
    return false;
  }

  const provider = paymentProvider(session.provider);

  if (!provider) {
    return false;
  }

  const credentials = deserialiseCredentials(provider, openPaystackSecret(
    session.encrypted_secret,
    config.billingEncryptionKey,
    session.facility_id,
  ));
  const authenticated = provider.webhookReference(raw, signature, credentials);

  if (!authenticated.ok || authenticated.checkoutReference !== reference) {
    return false;
  }

  await confirmCheckout(sql, config, reference, http, scope);

  return true;
};

const publicState = (session: CheckoutSession): CheckoutState => {
  let status: CheckoutState['status'] = session.status;

  // A sandbox payment counts as paid only when it settled the bill (the hospital was in test mode and something
  // was applied); otherwise the patient is never told their bill was paid.
  const testNotApplied = session.mode === 'test' && session.held_minor !== null && session.held_minor >= session.amount_minor;
  if (session.status === 'paid' && testNotApplied) {
    status = 'failed';
  } else if (session.status === 'pending' && Date.parse(session.expires_on) <= Date.now()) {
    status = 'expired';
  }

  return {
    status,
    amountMinor: session.amount_minor,
    currency: session.currency,
    ...(!testNotApplied && session.held_minor !== null ? { heldMinor: session.held_minor } : {}),
  };
};

/** Freeze the server-calculated balance and the charges this checkout is allowed to settle. */
export const startCheckout = async (
  sql: Sql,
  config: Config,
  link: DocumentLink,
  returnUrl: string,
  http: PaystackFetch = fetch,
): Promise<CheckoutStart> => {
  const connection = await providerConnection(sql, config, link.facilityId);
  const checkout = connection.provider.checkout;

  if (link.kind !== 'bill' || !checkout) {
    throw conflict('This hospital does not offer online payments yet. Contact the hospital to pay.');
  }

  const bill = await loadBill(sql, link.facilityId, link.subject);

  if (!bill || bill.totals.dueMinor <= 0) {
    throw conflict('There is nothing to pay on this bill. Refresh the page.');
  }

  if (!connection.provider.descriptor.currencies.includes(bill.currency)) {
    throw conflict('The hospital cannot accept online payments in this currency.');
  }

  if (!Number.isSafeInteger(bill.totals.dueMinor) || bill.totals.dueMinor > MAX_AMOUNT_MINOR) {
    throw conflict('Contact the hospital to pay this bill.');
  }

  const contact = await patientContactNow(sql, link.facilityId, link.patientId);
  const email = contact?.email ?? bill.hospital.email;

  if (!email) {
    throw conflict('The hospital needs to record a contact email before online payment can start.');
  }

  const charges = await sql<{ id: string; bill_id: string | null; encounter_id: string | null; appointment_id: string | null }[]>`
    SELECT id, bill_id, encounter_id, appointment_id FROM charges
    WHERE facility_id = ${link.facilityId} AND patient_id = ${link.patientId} AND currency = ${bill.currency}`;
  const chargeIds = charges.filter((charge) => billKey({
    id: charge.id,
    patientId: link.patientId,
    currency: bill.currency,
    billId: charge.bill_id ?? undefined,
    encounterId: charge.encounter_id ?? undefined,
    appointmentId: charge.appointment_id ?? undefined,
  }) === link.subject).map((charge) => charge.id);
  const reference = `geneus-co-${randomUUID()}`;
  const expiresOn = new Date(Date.now() + CHECKOUT_DURATION_MS).toISOString();

  // Save before contacting the provider: a fast webhook or a lost HTTP response can still be recovered.
  await sql`INSERT INTO checkout_sessions (
    reference, facility_id, bill_key, patient_id, amount_minor, currency,
    provider, mode, encrypted_secret, charge_ids, link_id, expires_on
  ) VALUES (
    ${reference}, ${link.facilityId}, ${link.subject}, ${link.patientId}, ${bill.totals.dueMinor}, ${bill.currency},
    ${connection.providerId}, ${connection.mode}, ${connection.encryptedSecret}, ${chargeIds}, ${link.id}, ${expiresOn}
  )`;

  const callback = new URL(returnUrl);
  callback.searchParams.set('checkout', reference);
  const started = await checkout.start(connection.credentials, {
    reference,
    amountMinor: bill.totals.dueMinor,
    currency: bill.currency,
    email,
    name: bill.patient.name,
    description: `Bill ${bill.reference}`,
    returnUrl: callback.toString(),
  }, http);

  if (new URL(started.checkoutUrl).protocol !== 'https:') {
    throw conflict('The payment provider did not return a secure checkout. Try again later.');
  }

  return { ...started, reference, amountMinor: bill.totals.dueMinor, currency: bill.currency };
};

/** Verify outside the transaction; lock and apply exactly once, sharing the normal charge and source locks. */
export const confirmCheckout = async (
  sql: Sql,
  config: Config,
  reference: string,
  http: PaystackFetch = fetch,
  scope?: CheckoutScope,
): Promise<CheckoutState | undefined> => {
  if (!CHECKOUT_REFERENCE.test(reference)) {
    return undefined;
  }

  const [session] = await sql<CheckoutSession[]>`SELECT * FROM checkout_sessions WHERE reference = ${reference}`;

  if (!session || (scope && !withinScope(session, scope))) {
    return undefined;
  }

  if (session.status === 'paid') {
    return publicState(session);
  }

  if (!config.billingEncryptionKey) {
    throw conflict('Online payment confirmation is temporarily unavailable. Try again later.');
  }

  const provider = paymentProvider(session.provider);

  if (!provider?.checkout) {
    throw conflict('This payment provider is no longer available. Contact the hospital.');
  }

  const credentials = deserialiseCredentials(provider, openPaystackSecret(
    session.encrypted_secret,
    config.billingEncryptionKey,
    session.facility_id,
  ));
  const outcome = await provider.checkout.verify(credentials, reference, http);

  // A different amount is still money received (a bank transfer through the checkout can be more or less than
  // asked): it is recorded, applied up to what the bill owes and the rest held for staff. Only a payment that
  // isn't this checkout's (another reference, currency or mode) is refused.
  if (outcome.status === 'paid' && (
    outcome.reference !== reference
    || outcome.currency !== session.currency
    || outcome.mode !== session.mode
  )) {
    throw conflict('The provider payment does not match this checkout. Contact the hospital.');
  }

  return sql.begin(async (tx) => {
    await tx`SELECT id FROM facilities WHERE id = ${session.facility_id} FOR UPDATE`;
    const [current] = await tx<CheckoutSession[]>`SELECT * FROM checkout_sessions WHERE reference = ${reference} FOR UPDATE`;

    if (current.status === 'paid') {
      return publicState(current);
    }

    if (outcome.status !== 'paid') {
      // An earlier failed attempt can later succeed; only a verified payment is final.
      await tx`UPDATE checkout_sessions SET status = ${outcome.status}, checked_on = now() WHERE reference = ${reference}`;
      return publicState({ ...current, status: outcome.status });
    }

    const [device] = await tx<{ id: string }[]>`
      SELECT id FROM devices WHERE facility_id = ${current.facility_id} ORDER BY id LIMIT 1`;

    if (!device) {
      throw conflict('The hospital has no enrolled device. Contact the hospital.');
    }

    const now = new Date().toISOString();
    const envelope = {
      facilityId: current.facility_id,
      deviceId: device.id,
      schemaVersion: SCHEMA_VERSION,
      createdBy: 'system',
      createdOn: now,
    };
    const source = IncomingTransfer.parse({
      ...envelope,
      id: `incoming_transfer:${reference}`,
      type: 'incoming_transfer',
      provider: current.provider,
      mode: current.mode,
      providerReference: reference,
      amountMinor: outcome.amountMinor,
      currency: outcome.currency,
      receivedOn: outcome.paidAt,
      payerName: outcome.payerName,
      channel: 'checkout',
      billKey: current.bill_key,
    });

    await insertRecord(tx, 'incoming_transfer', source);

    let heldMinor = outcome.amountMinor;
    // Test money settles a bill only while the hospital is still connected in test mode, so the whole flow can be
    // tried before going live. Once it is live, a late sandbox payment never marks a real bill paid.
    const [connected] = await tx<{ mode: 'test' | 'live' }[]>`SELECT mode FROM billing_connections WHERE facility_id = ${current.facility_id}`;
    const settles = current.mode === 'live' || connected?.mode === 'test';

    if (settles) {
      // Lock in the same ID order as device uploads, then allocate in issue order.
      const rows = await tx<Record<string, unknown>[]>`
        SELECT * FROM charges WHERE facility_id = ${current.facility_id}
          AND patient_id = ${current.patient_id} AND currency = ${current.currency}
          AND id = ANY(${current.charge_ids}) ORDER BY id FOR UPDATE`;
      const charges = rows.map((row) => fromRow<Charge>('charge', row))
        .filter((charge) => billKey(charge) === current.bill_key)
        .sort((left, right) => left.createdOn.localeCompare(right.createdOn) || left.id.localeCompare(right.id));
      const positions = await chargePositions(tx, current.facility_id, charges);
      const allocations: { chargeId: string; amountMinor: number }[] = [];

      for (const charge of charges) {
        const position = positions.get(charge.id);
        const amountMinor = Math.min(heldMinor, Math.max(0, position?.balanceMinor ?? 0));

        if (amountMinor > 0) {
          allocations.push({ chargeId: charge.id, amountMinor });
          heldMinor -= amountMinor;
        }
      }

      const appliedMinor = outcome.amountMinor - heldMinor;

      if (appliedMinor > 0) {
        await reserveSource(tx, current.facility_id, source.id, appliedMinor, current.currency, { allowTest: current.mode === 'test' });
        const receiptNumber = await nextReceiptNumber(tx, current.facility_id);
        const payment = Payment.parse({
          ...envelope,
          id: `payment:${reference}`,
          type: 'payment',
          patientId: current.patient_id,
          method: 'online',
          amountMinor: appliedMinor,
          currency: current.currency,
          incomingTransferId: source.id,
          reference,
          receiptNumber,
          allocations,
        });

        // The existing payment trigger queues the automatic patient receipt in this transaction.
        await insertRecord(tx, 'payment', payment);
      }
    }

    await tx`UPDATE checkout_sessions SET status = 'paid', paid_on = ${outcome.paidAt}, checked_on = now(),
      incoming_transfer_id = ${source.id}, held_minor = ${heldMinor} WHERE reference = ${reference}`;

    return publicState({ ...current, status: 'paid', held_minor: heldMinor });
  });
};

type CheckoutLog = { warn: (details: object, message: string) => void };

/** Recover missed callbacks in the existing server process, without holding locks during provider calls. */
export const reconcileCheckouts = async (
  sql: Sql,
  config: Config,
  log: CheckoutLog,
  http: PaystackFetch = fetch,
): Promise<void> => {
  // Most unpaid checkouts were simply abandoned, so they are asked about often at first, then rarely, then not at
  // all: every minute for the first hour, hourly up to 48 hours. A payment after that still arrives by webhook.
  const sessions = await sql<{ reference: string }[]>`
    SELECT reference FROM checkout_sessions WHERE status <> 'paid'
      AND created_on > now() - interval '48 hours'
      AND (checked_on IS NULL OR checked_on < now() - CASE WHEN created_on > now() - interval '1 hour' THEN interval '1 minute' ELSE interval '1 hour' END)
    ORDER BY checked_on NULLS FIRST, created_on LIMIT 20`;

  for (const session of sessions) {
    // Advance even on a provider failure so one bad checkout cannot starve the others.
    await sql`UPDATE checkout_sessions SET checked_on = now() WHERE reference = ${session.reference}`;

    try {
      await confirmCheckout(sql, config, session.reference, http);
    } catch (cause) {
      log.warn({
        reference: session.reference,
        reason: cause instanceof Error ? cause.message : 'Payment confirmation failed',
      }, 'checkout reconciliation deferred');
    }
  }
};

export const startCheckoutReconciliation = (sql: Sql, config: Config, log: CheckoutLog) => {
  let running: Promise<void> | undefined;

  const timer = setInterval(() => {
    if (running) {
      return;
    }

    running = reconcileCheckouts(sql, config, log)
      .catch(() => log.warn({}, 'checkout reconciliation pass failed'))
      .finally(() => {
        running = undefined;
      });
  }, 60_000);

  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
};
