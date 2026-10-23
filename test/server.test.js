import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../app.js';

const secret = 'a'.repeat(32);
const enabledEnv = {
  PUBLIC_ACCESS_ENABLED: 'true',
  META_APP_SECRET: secret,
  VERIFY_TOKEN: secret,
  PAGE_ACCESS_TOKEN: secret,
  OPENAI_API_KEY: secret,
};

// Boot the real Express app on an ephemeral port, exactly as server.js does.
async function withServer(env, run) {
  const app = createApp(env);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, app);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const sign = (body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('the server boots and starts listening on the configured host', async () => {
  await withServer(enabledEnv, async (base, app) => {
    assert.equal(app.locals.access.host, '127.0.0.1');
    assert.equal(app.locals.access.enabled, true);
  });
});

test('with access disabled every route is locked down with security headers', async () => {
  await withServer({}, async (base) => {
    for (const path of ['/', '/webhook', '/.env']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-powered-by'), null);
    }
  });
});

test('only the two Meta webhook methods are reachable when enabled', async () => {
  await withServer(enabledEnv, async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/webhook`, { method: 'PUT' })).status, 404);
    assert.equal((await fetch(`${base}/webhook`, { method: 'DELETE' })).status, 404);
  });
});

test('GET /webhook answers the Meta challenge only for the configured token', async () => {
  await withServer(enabledEnv, async (base) => {
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${secret}&hub.challenge=CHAL123`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'CHAL123');

    for (const url of [
      `${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHAL123`,
      `${base}/webhook?hub.mode=unsubscribe&hub.verify_token=${secret}&hub.challenge=CHAL123`,
      `${base}/webhook?hub.mode=subscribe&hub.verify_token=${secret}`,
    ]) {
      assert.equal((await fetch(url)).status, 403, url);
    }
  });
});

test('POST /webhook rejects unsigned, tampered and malformed requests', async () => {
  await withServer(enabledEnv, async (base) => {
    const body = JSON.stringify({ object: 'page', entry: [] });
    const post = (payload, headers = {}) => fetch(`${base}/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload,
    });

    assert.equal((await post(body)).status, 403, 'missing signature');
    assert.equal((await post(body, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).status, 403, 'wrong signature');
    assert.equal((await post(body + ' ', { 'x-hub-signature-256': sign(body) })).status, 403, 'tampered body');
    assert.equal((await post(body, { 'x-hub-signature-256': sign(body) })).status, 200, 'valid signature');
    assert.equal((await post(JSON.stringify({ object: 'user', entry: [] }),
      { 'x-hub-signature-256': sign(JSON.stringify({ object: 'user', entry: [] })) })).status, 400, 'wrong object');
    assert.equal((await post('not json', { 'x-hub-signature-256': sign('not json') })).status, 400, 'malformed json');
  });
});

test('POST /webhook acknowledges valid events without leaking internals', async () => {
  await withServer(enabledEnv, async (base) => {
    const body = JSON.stringify({
      object: 'page',
      entry: [{ messaging: [{ sender: { id: 'u1' }, message: { mid: 'm1', is_echo: true } }] }],
    });
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'EVENT_RECEIVED');
  });
});

test('a missing app secret fails safe by refusing to start in enabled mode', () => {
  // Fail-fast beats booting into a state that could accept unsigned events.
  assert.throws(() => createApp({ ...enabledEnv, META_APP_SECRET: undefined }),
    /META_APP_SECRET/);
  for (const key of ['VERIFY_TOKEN', 'PAGE_ACCESS_TOKEN', 'OPENAI_API_KEY']) {
    assert.throws(() => createApp({ ...enabledEnv, [key]: undefined }), new RegExp(key));
  }
});

test('when access is not enabled the app never accepts an unsigned event', async () => {
  await withServer({}, async (base) => {
    const body = JSON.stringify({ object: 'page', entry: [] });
    const res = await fetch(`${base}/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(res.status, 403);
  });
});
