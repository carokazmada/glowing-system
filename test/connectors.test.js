import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorFetch, metaAudioUrl, boundedBytes, metaMessageRequest } from '../connectors.js';
import { TransientStore } from '../transient-store.js';
import { WorkQueue } from '../work-queue.js';

test('audio downloads allow only HTTPS Meta CDN hosts', () => {
  for (const value of ['https://scontent.xx.fbcdn.net/audio', 'https://cdn.fbsbx.com/audio']) {
    assert.equal(metaAudioUrl(value).protocol, 'https:');
  }
  for (const value of ['http://cdn.fbsbx.com/a', 'https://127.0.0.1/a', 'https://169.254.169.254/a',
    'https://fbcdn.net.attacker.example/a', 'https://evilfbcdn.net/a',
    'https://user:password@cdn.fbsbx.com/a', 'https://cdn.fbsbx.com:8443/a', 'file:///etc/passwd']) {
    assert.throws(() => metaAudioUrl(value));
  }
});

test('Meta tokens are confined to the Authorization header, never the URL', () => {
  const secret = 'test-secret-must-not-be-in-url';
  const request = metaMessageRequest('v19.0', secret, { message: { text: 'test' } }, true);
  assert.equal(new URL(request.url).search, '');
  assert.equal(request.url.includes(secret), false);
  assert.equal(request.options.headers.Authorization, `Bearer ${secret}`);
  assert.deepEqual(JSON.parse(request.options.body), { message: { text: 'test' } });
});

test('HTTP connectors enforce deadlines and refuse redirects even if caller overrides them', async () => {
  let options;
  const result = await connectorFetch('https://graph.facebook.com/test', { redirect: 'follow' }, async (url, received) => {
    options = received;
    return new Response('ok');
  });
  assert.equal(result.ok, true);
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
});

test('HTTP errors discard remote bodies and keep credentials out of error messages', async () => {
  let cancelled = false;
  await assert.rejects(connectorFetch('https://example.com/secret-token', {}, async () => ({
    ok: false, status: 401, body: { cancel: async () => { cancelled = true; } },
  })), { message: 'Échec du connecteur HTTP (401)' });
  assert.equal(cancelled, true);
});

test('downloads reject oversized declared lengths and oversized streams without a length', async () => {
  await assert.rejects(boundedBytes(new Response('abc', { headers: { 'content-length': '100' } }), 3));
  await assert.rejects(boundedBytes(new Response('abcd'), 3));
  assert.equal((await boundedBytes(new Response('abc'), 3)).toString(), 'abc');
});

test('a stalled response body is cancelled when its read deadline expires', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(boundedBytes(response, 100, 5), /Délai de lecture/);
  assert.equal(cancelled, true);
});

test('conversation storage expires old data and evicts the oldest entry at capacity', () => {
  let now = 0;
  const store = new TransientStore({ maxEntries: 2, ttlMs: 10, now: () => now });
  store.set('a', 'first'); store.set('b', 'second'); store.set('c', 'third');
  assert.equal(store.get('a'), undefined);
  assert.equal(store.get('b'), 'second');
  now = 10;
  store.prune();
  assert.equal(store.get('c'), undefined);
  assert.equal(store.entries.size, 0);
  assert.throws(() => new TransientStore({ maxEntries: 0 }));
});

const tick = () => new Promise(resolve => setImmediate(resolve));
test('work queue bounds concurrency and serializes messages for the same sender', async () => {
  const queue = new WorkQueue({ concurrency: 2, capacity: 3 });
  const releases = {};
  const started = [];
  const job = name => () => new Promise(resolve => { started.push(name); releases[name] = resolve; });
  queue.add('sender-a', job('a1'));
  queue.add('sender-a', job('a2'));
  queue.add('sender-b', job('b1'));
  assert.equal(queue.canAccept(1), false);
  assert.throws(() => queue.add('sender-c', job('c1')), /saturée/);
  await tick();
  assert.deepEqual(started, ['a1', 'b1']);
  releases.a1();
  await tick();
  assert.deepEqual(started, ['a1', 'b1', 'a2']);
  releases.a2(); releases.b1();
  await tick();
  assert.equal(queue.active.size, 0);
  assert.equal(queue.pending.length, 0);
  assert.equal(queue.canAccept(3), true);
});
