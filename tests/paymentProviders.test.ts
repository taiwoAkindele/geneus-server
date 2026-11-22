import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callPaystack } from '../src/billing/paystack.ts';
import {
  paystackCreateAccount,
  paystackGetAccount,
  paystackListAccounts,
  paystackMode,
} from '../src/billing/providers/paystack.ts';
import { PROVIDERS, providerDescriptor } from '../src/billing/providers/index.ts';
import {
  ProviderRefused,
  ProviderUnavailable,
  ProviderUnexpectedReply,
  safeProviderReason,
} from '../src/billing/providers/types.ts';

const reply = (status: number, body: unknown) => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const key = 'sk_test_FictionalProviderTest';
const dedicated = (id: number, active = true) => ({
  id,
  account_number: '9930000001',
  account_name: 'PAYSTACK-TEST/Fictional Hospital',
  active,
  currency: 'NGN',
  bank: { name: 'Test Bank' },
});

test('a provider refusal keeps the provider’s reason, without naming the provider', async () => {
  await assert.rejects(
    callPaystack(
      key,
      '/dedicated_account',
      reply(400, { status: false, message: 'Dedicated NUBAN not available for this business' }),
    ),
    (error: unknown) => {
      assert(error instanceof ProviderRefused);
      assert.equal(
        error.message,
        'The provider refused this operation: Dedicated NUBAN not available for this business.',
      );
      assert.equal(error.code, 'provider_refused');
      assert.equal(error.providerStatus, 400);
      assert(!/paystack/i.test(error.message));
      return true;
    },
  );
});
test('a refusal reason that looks like system detail is not shown', async () => {
  for (const reason of [
    `Invalid key ${key}`,
    'See https://example.test/errors',
    'Missing PAYSTACK_SECRET_KEY',
    '{"raw":true}',
    'x'.repeat(200),
  ]) {
    assert.equal(safeProviderReason(reason), undefined, reason);
  }
  await assert.rejects(
    callPaystack(key, '/customer', reply(401, { status: false, message: `Invalid key ${key}` })),
    (error: unknown) =>
      error instanceof ProviderRefused &&
      !error.message.includes(key) &&
      error.message.startsWith('The provider refused this operation.'),
  );
});
test('an unreachable provider and a garbled reply are reported as such, not as server faults', async () => {
  await assert.rejects(
    callPaystack(key, '/transaction', async () => {
      throw new TypeError('fetch failed');
    }),
    ProviderUnavailable,
  );
  await assert.rejects(
    callPaystack(key, '/transaction', reply(502, '<html>Bad gateway</html>')),
    ProviderUnexpectedReply,
  );
  await assert.rejects(
    paystackListAccounts(key, reply(200, { status: true, data: [{ id: 1 }] })),
    ProviderUnexpectedReply,
  );
});
test('the central account is a dedicated account for the hospital, on the test bank in test mode', async () => {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const http =
    (mode: 'test' | 'live'): typeof fetch =>
    async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const data = path === '/customer' ? { customer_code: `CUS_${mode}` } : dedicated(77);
      return new Response(JSON.stringify({ status: true, data }), { status: 200 });
    };
  const account = await paystackCreateAccount(
    key,
    { name: 'Fictional Hospital' },
    { email: 'accounts@hospital.test', phone: '+2348031234567' },
    http('test'),
  );
  assert.deepEqual(account, {
    providerAccountId: '77',
    accountNumber: '9930000001',
    accountName: 'PAYSTACK-TEST/Fictional Hospital',
    bankName: 'Test Bank',
    active: true,
    currency: 'NGN',
  });
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/customer', '/dedicated_account'],
  );
  assert.deepEqual(calls[0].body, {
    email: 'accounts@hospital.test',
    first_name: 'Fictional Hospital',
    last_name: 'Hospital',
    phone: '+2348031234567',
  });
  assert.deepEqual(calls[1].body, { customer: 'CUS_test', preferred_bank: 'test-bank' });
  calls.length = 0;
  await paystackCreateAccount(
    'sk_live_FictionalProviderTest',
    { name: 'Fictional Hospital' },
    { email: 'accounts@hospital.test', phone: '+2348031234567' },
    http('live'),
  );
  assert.deepEqual(calls[1].body, { customer: 'CUS_live' });
});
test('accounts linked earlier, including Virtual Terminals, are still read back', async () => {
  const terminal = {
    code: 'VT_OLD',
    active: true,
    currency: 'NGN',
    paymentMethods: [
      {
        type: 'dedicated_nuban',
        account_number: '9910000004',
        account_name: 'Old terminal',
        bank: 'Test bank',
      },
    ],
  };
  assert.equal(
    (await paystackGetAccount(key, 'VT_OLD', reply(200, { status: true, data: terminal })))
      .accountNumber,
    '9910000004',
  );
  assert.equal(
    (await paystackGetAccount(key, '77', reply(200, { status: true, data: dedicated(77) })))
      .providerAccountId,
    '77',
  );
});
test('the provider registry describes fields without secrets', () => {
  assert.equal(paystackMode(key), 'test');
  assert.equal(paystackMode('sk_live_x'), 'live');
  assert.ok(providerDescriptor('paystack'));
  assert.equal(providerDescriptor('unknown'), undefined);
  for (const provider of PROVIDERS) {
    assert(!JSON.stringify(provider).match(/sk_(test|live)_[A-Za-z0-9]{6,}/));
  }
});
