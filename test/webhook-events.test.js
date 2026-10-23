import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidWebhookBody, selectNewEvents, extractUserText, isUsableText, MAX_TEXT_LENGTH,
} from '../webhook-events.js';

const message = (id, text = 'bonjour') => ({
  sender: { id: 'user-1' }, message: { mid: id, text },
});

test('payload validation accepts only well-formed page events', () => {
  assert.equal(isValidWebhookBody({ object: 'page', entry: [] }), true);
  assert.equal(isValidWebhookBody({ object: 'page', entry: [{ messaging: [] }] }), true);
  for (const invalid of [undefined, null, {}, { object: 'user', entry: [] },
    { object: 'page' }, { object: 'page', entry: {} }, { object: 'page', entry: [{}] },
    { object: 'page', entry: [{ messaging: 'no' }] }, { object: 'page', entry: [null] }]) {
    assert.equal(isValidWebhookBody(invalid), false, `expected rejection: ${JSON.stringify(invalid)}`);
  }
});

test('duplicate message ids are dropped within a batch and across requests', () => {
  const body = { object: 'page', entry: [{ messaging: [message('m1'), message('m1'), message('m2')] }] };
  assert.deepEqual(selectNewEvents(body).map((e) => e.message.mid), ['m1', 'm2']);

  const seen = new Set(['m1']);
  assert.deepEqual(
    selectNewEvents(body, (id) => seen.has(id)).map((e) => e.message.mid), ['m2']);
});

test('events without a usable sender or message id are ignored', () => {
  const body = {
    object: 'page',
    entry: [{ messaging: [
      { sender: {}, message: { mid: 'a', text: 'x' } },
      { sender: { id: 'u' }, message: { text: 'x' } },
      { sender: { id: 'u' }, message: { mid: 'b', text: 'x', is_echo: true } },
      { sender: { id: 'u' } },
      null,
      message('ok'),
    ] }],
  };
  assert.deepEqual(selectNewEvents(body).map((e) => e.message.mid), ['ok']);
});

test('echo messages are never treated as inbound customer input', () => {
  const body = { object: 'page', entry: [{ messaging: [
    { sender: { id: 'u' }, message: { mid: 'echo-1', text: 'réponse de la page', is_echo: true } }] }] };
  assert.deepEqual(selectNewEvents(body), []);
});

test('user text extraction and validation enforce type and length bounds', () => {
  assert.equal(extractUserText(message('m', 'salama')), 'salama');
  assert.equal(extractUserText({ message: { mid: 'm' } }), null);
  assert.equal(extractUserText({ message: { mid: 'm', text: 42 } }), null);
  assert.equal(extractUserText({}), null);

  assert.equal(isUsableText('bonjour'), true);
  for (const invalid of [null, undefined, '', '   ', '\n\t ', 42, {}, 'x'.repeat(MAX_TEXT_LENGTH + 1)]) {
    assert.equal(isUsableText(invalid), false, `expected rejection: ${String(invalid).slice(0, 12)}`);
  }
  assert.equal(isUsableText('x'.repeat(MAX_TEXT_LENGTH)), true);
});
