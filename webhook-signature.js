import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authenticate a Meta webhook using the exact request-body bytes.
 * The app secret is distinct from the webhook verification token.
 */
export function verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) ||
      typeof appSecret !== 'string' || appSecret.length === 0 ||
      typeof signatureHeader !== 'string') {
    return false;
  }

  const match = /^sha256=([a-f\d]{64})$/i.exec(signatureHeader);
  if (!match) return false;

  const actual = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
