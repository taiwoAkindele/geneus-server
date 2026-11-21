import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { monnifyAccountReference, monnifyCheckAccess, monnifyCreateAccount, monnifyDescriptor, monnifyGetAccount, monnifyMode, monnifyVerifyTransfer, monnifyWebhookReference, resetMonnifyTokens, MonnifyAccountDetails } from '../src/billing/providers/monnify.ts';
import { ProviderRefused, ProviderUnavailable, ProviderUnexpectedReply, toMinor } from '../src/billing/providers/types.ts';

// Fictional sandbox credentials and replies shaped like Monnify's documentation. Confirmed against the real sandbox in plan step 0.
const keys = { apiKey: 'MK_TEST_FICTIONAL1', secretKey: 'FictionalSecretKey0001', contractCode: '1234567890' };
type Call = { url: string; method: string; auth: string; body?: Record<string, unknown> };
const fake = (routes: Record<string, (call: Call) => { status?: number; body: unknown }>) => {
  const calls: Call[] = [];
  const http: typeof fetch = async (url, init) => {
    const call = { url: String(url), method: init?.method ?? 'GET', auth: String((init?.headers as Record<string, string>)?.authorization ?? ''), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const path = new URL(call.url).pathname;
    const route = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    const reply = route ? route[1](call) : { status: 404, body: { requestSuccessful: false, responseMessage: 'Not found' } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  return { http, calls };
};
const login = () => ({ body: { requestSuccessful: true, responseMessage: 'success', responseBody: { accessToken: 'token-1', expiresIn: 3600 } } });
const reserved = (accounts = [{ bankCode: '035', bankName: 'Wema Bank', accountNumber: '5000000001' }, { bankCode: '232', bankName: 'Sterling Bank', accountNumber: '6000000001', accountName: 'Fictional Hospital' }]) =>
  ({ body: { requestSuccessful: true, responseBody: { accountReference: 'geneus-TEST', accountName: 'Fictional Hospital', currencyCode: 'NGN', status: 'ACTIVE', accounts } } });

beforeEach(() => resetMonnifyTokens());

test('test keys use the sandbox; sign-in is cached and sent as a bearer token', async () => {
  assert.equal(monnifyMode(keys), 'test'); assert.equal(monnifyMode({ apiKey: 'MK_PROD_X' }), 'live');
  const { http, calls } = fake({ '/api/v1/auth/login': login, '/api/v2/bank-transfer/reserved-accounts/': () => reserved() });
  await monnifyGetAccount(keys, 'geneus-TEST', http); await monnifyGetAccount(keys, 'geneus-TEST', http);
  assert.equal(calls.filter((c) => c.url.endsWith('/auth/login')).length, 1);
  assert(calls.every((c) => c.url.startsWith('https://sandbox.monnify.com/')));
  assert.equal(calls[0].auth, `Basic ${Buffer.from(`${keys.apiKey}:${keys.secretKey}`).toString('base64')}`);
  assert.equal(calls[1].auth, 'Bearer token-1');
});
test('the hospital gets one account number, at the bank it chose, and its BVN goes only to Monnify', async () => {
  const { http, calls } = fake({ '/api/v1/auth/login': login, '/api/v2/bank-transfer/reserved-accounts': () => reserved() });
  const account = await monnifyCreateAccount(keys, { id: 'TEST', name: 'Fictional Hospital' }, { bank: '232', email: 'accounts@hospital.test', bvn: '22222222222' }, http);
  assert.deepEqual(account, { providerAccountId: 'geneus-TEST', accountNumber: '6000000001', accountName: 'Fictional Hospital', bankName: 'Sterling Bank', active: true, currency: 'NGN' });
  const body = calls.find((c) => c.method === 'POST' && c.url.includes('reserved-accounts'))!.body!;
  assert.equal(body.accountReference, monnifyAccountReference('TEST')); assert.equal(body.contractCode, keys.contractCode);
  assert.equal(body.getAllAvailableBanks, false); assert.deepEqual(body.preferredBanks, ['232']);
  assert.equal(body.bvn, '22222222222');
});
test('only the listed banks can be chosen, and a bank Monnify can’t serve gets a clear message', async () => {
  const field = monnifyDescriptor.accountFields.find((f) => f.key === 'bank')!;
  assert.equal(field.type, 'select'); assert.deepEqual(field.options?.map((o) => o.value), ['035', '232']);
  assert.equal(MonnifyAccountDetails.safeParse({ bank: '058', email: 'a@hospital.test', bvn: '22222222222' }).success, false);
  const { http } = fake({ '/api/v1/auth/login': login, '/api/v2/bank-transfer/reserved-accounts': () => ({ status: 503, body: { requestSuccessful: false, responseMessage: 'Service is currently unavailable, Please try again later...' } }) });
  await assert.rejects(monnifyCreateAccount(keys, { id: 'TEST', name: 'Fictional Hospital' }, { bank: '035', email: 'a@hospital.test', bvn: '22222222222' }, http), (e: unknown) =>
    e instanceof ProviderUnavailable && e.code === 'provider_unavailable' && e.providerStatus === 503 && e.providerCall === '/api/v2/bank-transfer/reserved-accounts'
    && e.message === 'The provider couldn\'t open an account at that bank right now. Choose another bank, or try again later.');
});
test('a provider outage elsewhere reads as unavailable, not refused', async () => {
  const { http } = fake({ '/api/v1/auth/login': () => ({ status: 503, body: { requestSuccessful: false, responseMessage: 'Service is currently unavailable, Please try again later...' } }) });
  await assert.rejects(monnifyCheckAccess(keys, http), (e: unknown) => e instanceof ProviderUnavailable
    && e.message === 'The provider is unavailable right now: Service is currently unavailable, Please try again later.');
});
test('a refusal carries Monnify’s reason without naming the provider', async () => {
  const { http } = fake({ '/api/v1/auth/login': () => ({ status: 401, body: { requestSuccessful: false, responseMessage: 'Invalid client credentials', responseCode: '99' } }) });
  await assert.rejects(monnifyCheckAccess(keys, http), (e: unknown) => e instanceof ProviderRefused && e.message === 'The provider refused this operation: Invalid client credentials.');
});
test('only a PAID reserved-account payment is accepted, with the amount converted exactly', async () => {
  const transaction = (over: Record<string, unknown> = {}) => () => ({ body: { requestSuccessful: true, responseBody: {
    transactionReference: 'MNFY|20261121|000001', paymentStatus: 'PAID', amountPaid: '20500.50', currencyCode: 'NGN', paidOn: '2026-11-21 09:41:00.000+0100',
    product: { type: 'RESERVED_ACCOUNT', reference: 'geneus-TEST' }, paymentSourceInformation: [{ accountName: 'Fictional Payer' }], ...over } } });
  let routes = fake({ '/api/v1/auth/login': login, '/api/v2/transactions/': transaction() });
  const verified = await monnifyVerifyTransfer(keys, 'MNFY|20261121|000001', routes.http);
  assert.deepEqual(verified, { reference: 'MNFY|20261121|000001', mode: 'test', amountMinor: 2050050, currency: 'NGN', paidAt: '2026-11-21T08:41:00.000Z', receivingAccountNumber: undefined, receivingAccountRef: 'geneus-TEST', payerName: 'Fictional Payer' });
  assert(routes.calls.some((c) => c.url.endsWith('/api/v2/transactions/MNFY%7C20261121%7C000001')));
  routes = fake({ '/api/v1/auth/login': login, '/api/v2/transactions/': transaction({ paymentStatus: 'PENDING' }) });
  assert.equal(await monnifyVerifyTransfer(keys, 'MNFY|20261121|000001', routes.http), undefined);
  resetMonnifyTokens(); routes = fake({ '/api/v1/auth/login': login, '/api/v2/transactions/': transaction({ product: { type: 'WEB_SDK' } }) });
  assert.equal(await monnifyVerifyTransfer(keys, 'MNFY|20261121|000001', routes.http), undefined);
  resetMonnifyTokens(); routes = fake({ '/api/v1/auth/login': login, '/api/v2/transactions/': transaction({ amountPaid: '12.345' }) });
  await assert.rejects(monnifyVerifyTransfer(keys, 'MNFY|20261121|000001', routes.http), ProviderUnexpectedReply);
});
test('webhooks are authenticated against the exact body, and only prompt a check', () => {
  const raw = JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION', eventData: { transactionReference: 'MNFY|1', amountPaid: 1, product: { type: 'RESERVED_ACCOUNT' } } });
  const sign = (body: string, secret = keys.secretKey) => createHmac('sha512', secret).update(body).digest('hex');
  assert.deepEqual(monnifyWebhookReference(raw, sign(raw), keys), { ok: true, reference: 'MNFY|1' });
  assert.deepEqual(monnifyWebhookReference(`${raw} `, sign(raw), keys), { ok: false });
  assert.deepEqual(monnifyWebhookReference(raw, sign(raw, 'wrong-secret-0000000'), keys), { ok: false });
  assert.deepEqual(monnifyWebhookReference(raw, undefined, keys), { ok: false });
  const other = JSON.stringify({ eventType: 'SETTLEMENT', eventData: { transactionReference: 'x' } });
  assert.deepEqual(monnifyWebhookReference(other, sign(other), keys), { ok: true });
});
test('amounts convert to kobo exactly or not at all', () => {
  assert.equal(toMinor('20500'), 2050000); assert.equal(toMinor('0.29'), 29); assert.equal(toMinor(20500.5), 2050050);
  for (const bad of ['-1', '1e3', '12.345', '', 'abc', 0, Number.NaN]) assert.equal(toMinor(bad), undefined);
});
