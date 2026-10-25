import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openPaystackSecret, sealPaystackSecret, validPaystackSignature } from '../src/billing/paystack.ts';

test('a hospital credential cannot be decrypted after copying it to another hospital', () => {
  const master = 'cd'.repeat(32); const secret = 'sk_test_FictionalSecurityTest';
  const encrypted = sealPaystackSecret(secret, master, 'HOSPITAL-A');
  assert.equal(openPaystackSecret(encrypted, master, 'HOSPITAL-A'), secret);
  assert.throws(() => openPaystackSecret(encrypted, master, 'HOSPITAL-B'));
  assert.throws(() => openPaystackSecret(encrypted, 'ef'.repeat(32), 'HOSPITAL-A'));
  assert(!encrypted.includes(secret));
});
test('Paystack signatures authenticate the exact body, including whitespace', () => {
  const body = '{"event":"charge.success","data":{"reference":"test"}}'; const secret = 'fictional';
  const signature = createHmac('sha512', secret).update(body).digest('hex');
  assert(validPaystackSignature(body, signature, secret));
  assert(!validPaystackSignature(`${body} `, signature, secret));
  assert(!validPaystackSignature(body, ['bad'], secret));
});
