const REQUEST_TIMEOUT_MS = 30_000;

export async function connectorFetch(url, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    // Do not include URLs, credentials, response bodies, or remote error details.
    throw new Error(`Échec du connecteur HTTP (${response.status})`);
  }
  return response;
}

export function metaAudioUrl(value) {
  const url = new URL(value);
  const allowed = ['fbcdn.net', 'fbsbx.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !allowed.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new Error('Source audio non autorisée');
  }
  return url;
}

export async function boundedBytes(response, maxBytes, timeoutMs = REQUEST_TIMEOUT_MS) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel();
    throw new Error('Réponse du connecteur trop volumineuse');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error('Délai de lecture du connecteur dépassé');
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Réponse du connecteur trop volumineuse');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export function metaMessageRequest(version, token, body, json = false) {
  return {
    url: `https://graph.facebook.com/${version}/me/messages`,
    options: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(body) : body,
    },
  };
}
