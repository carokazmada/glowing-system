import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { accessConfig, accessGate, verifyMetaSignature, verifyWebhookBody } from '../security.js';

const secret = 'a'.repeat(32);
const body = Buffer.from('{"object":"page","entry":[]}');
const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('access is disabled unless explicitly enabled, even when credentials are absent', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    assert.equal(accessConfig({ PUBLIC_ACCESS_ENABLED: value }).enabled, false);
  }
  assert.equal(accessConfig({}).host, '127.0.0.1');
});

test('explicit enablement requires every credential and rejects example values', () => {
  const env = { PUBLIC_ACCESS_ENABLED: 'true', META_APP_SECRET: secret,
    VERIFY_TOKEN: secret, PAGE_ACCESS_TOKEN: secret, OPENAI_API_KEY: secret };
  assert.equal(accessConfig(env).enabled, true);
  for (const key of ['META_APP_SECRET', 'VERIFY_TOKEN', 'PAGE_ACCESS_TOKEN', 'OPENAI_API_KEY']) {
    for (const invalid of [undefined, '', 'short', 'YOUR_' + 'X'.repeat(40)]) {
      assert.throws(() => accessConfig({ ...env, [key]: invalid }), new RegExp(key));
    }
  }
});

function request(enabled, path, method) {
  const result = { status: undefined, next: false, headers: {} };
  const res = { setHeader: (key, value) => { result.headers[key] = value; },
    sendStatus: status => { result.status = status; } };
  accessGate(enabled)({ path, method }, res, () => { result.next = true; });
  return result;
}

test('lockdown rejects every route and method before body processing', () => {
  for (const path of ['/', '/webhook', '/.env', '/admin']) {
    for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']) {
      const result = request(false, path, method);
      assert.equal(result.status, 403);
      assert.equal(result.next, false);
      assert.equal(result.headers['Cache-Control'], 'no-store');
    }
  }
});

test('enabled mode exposes only the two Meta webhook methods', () => {
  for (const method of ['GET', 'POST']) assert.equal(request(true, '/webhook', method).next, true);
  for (const [path, method] of [['/', 'GET'], ['/.env', 'GET'], ['/webhook', 'OPTIONS'],
    ['/webhook', 'HEAD'], ['/webhook/', 'POST'], ['/admin', 'POST']]) {
    assert.equal(request(true, path, method).status, 404);
  }
});

test('correct HMAC authenticates the exact raw body', () => {
  assert.equal(verifyMetaSignature(secret, signature, body), true);
  assert.equal(verifyMetaSignature(secret, signature, Buffer.concat([body, Buffer.from(' ')])), false);
  assert.equal(verifyMetaSignature('b'.repeat(32), signature, body), false);
});

test('missing, malformed and repeated signature headers are rejected', () => {
  for (const invalid of [undefined, '', 'sha256=abc', 'sha1=' + '0'.repeat(64),
    'sha256=' + 'z'.repeat(64), [signature, signature]]) {
    assert.equal(verifyMetaSignature(secret, invalid, body), false);
  }
  assert.equal(verifyMetaSignature(undefined, signature, body), false);
});

test('JSON verifier rejects unsigned POSTs with 403 before handlers run', () => {
  const verify = verifyWebhookBody(secret);
  assert.throws(() => verify({ method: 'POST', headers: {} }, {}, body), { status: 403 });
  assert.doesNotThrow(() => verify({ method: 'POST', headers: { 'x-hub-signature-256': signature } }, {}, body));
});
