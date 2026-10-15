import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyMetaWebhookSignature } from '../webhook-signature.js';

const secret = 'example-app-secret-for-unit-tests-only';
const payload = Buffer.from('{"object":"page","entry":[{"messaging":[]}]}');
const signature = (body, key = secret) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

test('accepts valid Meta signature over original bytes', () => {
  assert.equal(verifyMetaWebhookSignature(payload, signature(payload), secret), true);
});

test('rejects tampered payload', () => {
  assert.equal(verifyMetaWebhookSignature(Buffer.from('{"object":"user"}'), signature(payload), secret), false);
});

test('rejects untrusted and malformed signature headers', () => {
  for (const candidate of [undefined, '', 'sha1=' + '0'.repeat(40), 'sha256=' + 'f'.repeat(20), 'sha256=' + 'z'.repeat(64)]) {
    assert.equal(verifyMetaWebhookSignature(payload, candidate, secret), false);
  }
});

test('rejects the wrong app secret or missing secret', () => {
  assert.equal(verifyMetaWebhookSignature(payload, signature(payload), 'another-secret'), false);
  assert.equal(verifyMetaWebhookSignature(payload, signature(payload), ''), false);
});

test('rejects JSON object instead of raw bytes', () => {
  assert.equal(verifyMetaWebhookSignature({ object: 'page' }, signature(payload), secret), false);
});

test('accepts unicode raw bytes with matching signature', () => {
  const unicodePayload = Buffer.from('{"message":"Salama é 🍃"}');
  assert.equal(verifyMetaWebhookSignature(unicodePayload, signature(unicodePayload), secret), true);
});
