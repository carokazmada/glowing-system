// Pure webhook payload handling, kept separate from the HTTP layer so it can be tested directly.

export function isValidWebhookBody(body) {
  return Boolean(body) && body.object === 'page' && Array.isArray(body.entry) &&
    body.entry.every((entry) => entry && Array.isArray(entry.messaging));
}

/**
 * Return only the events that carry a sender and a message id and were not seen before.
 * Meta retries deliveries, so the same message.mid can arrive more than once, both across
 * requests (isProcessed) and inside a single batch (batchIds).
 */
export function selectNewEvents(body, isProcessed = () => false) {
  const events = [];
  const batchIds = new Set();
  for (const entry of body.entry) {
    for (const event of entry.messaging) {
      const senderId = event?.sender?.id;
      const messageId = event?.message?.mid;
      if (typeof senderId !== 'string' || typeof messageId !== 'string' || event.message.is_echo) continue;
      if (batchIds.has(messageId) || isProcessed(messageId)) continue;
      batchIds.add(messageId);
      events.push(event);
    }
  }
  return events;
}

export const MAX_TEXT_LENGTH = 4000;

export function extractUserText(event) {
  if (typeof event.message?.text === 'string') return event.message.text;
  return null;
}

export function isUsableText(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH;
}
