import { createHmac, timingSafeEqual } from 'node:crypto';

export function accessConfig(env) {
  const enabled = env.PUBLIC_ACCESS_ENABLED === 'true';
  if (enabled) {
    for (const name of ['META_APP_SECRET', 'VERIFY_TOKEN', 'PAGE_ACCESS_TOKEN', 'OPENAI_API_KEY']) {
      const value = env[name];
      if (!value || value.length < 32 || /YOUR_|colle_ici|choisis_un/i.test(value)) {
        throw new Error(`Configuration requise ou invalide : ${name}`);
      }
    }
  }
  return { enabled, host: env.HOST || '127.0.0.1', appSecret: env.META_APP_SECRET };
}

export function accessGate(enabled) {
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (!enabled) return res.sendStatus(403);
    if (req.path !== '/webhook' || !['GET', 'POST'].includes(req.method)) {
      return res.sendStatus(404);
    }
    next();
  };
}

export function verifyMetaSignature(secret, signature, body) {
  if (!secret || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

export function verifyWebhookBody(secret) {
  return (req, res, body) => {
    if (req.method === 'POST' && !verifyMetaSignature(secret, req.headers['x-hub-signature-256'], body)) {
      const error = new Error('Signature invalide');
      error.status = 403;
      throw error;
    }
  };
}
