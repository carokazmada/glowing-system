import express from 'express';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createHmac, timingSafeEqual } from 'node:crypto';

dotenv.config();

const required = ['OPENAI_API_KEY', 'PAGE_ACCESS_TOKEN', 'VERIFY_TOKEN'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Configuration obligatoire absente: ${missing.join(', ')}`);
}

const app = express();
app.disable('x-powered-by');

const BODY_LIMIT = process.env.WEBHOOK_BODY_LIMIT || '256kb';
const MAX_EVENTS_PER_REQUEST = Number(process.env.MAX_EVENTS_PER_REQUEST || 25);
const MAX_USER_TEXT_CHARS = Number(process.env.MAX_USER_TEXT_CHARS || 4000);
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 12 * 1024 * 1024);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MS || 10 * 60 * 1000);
const MAX_CONVERSATIONS = Number(process.env.MAX_CONVERSATIONS || 5000);
const ALLOW_UNSIGNED_WEBHOOKS = process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const PORT = Number(process.env.PORT || 3000);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const conversations = new Map();
const processedMessageIds = new Map();

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Tu es l'assistant vocal officiel de Carokaz Mada sur Messenger.
Tu réponds aux clients de manière chaleureuse, claire et professionnelle, en français (ou en malgache si le client t'écrit en malgache).
Tu aides les clients à connaître nos produits, nos prix, nos horaires et comment commander.
Si tu ne connais pas une information précise (stock, prix exact, délai), dis-le honnêtement et propose qu'un membre de l'équipe les recontacte.
Ne demande ni mot de passe, ni code secret, ni donnée bancaire. Garde tes réponses assez courtes et naturelles, car elles seront lues à voix haute au client.`;

function cleanExpiredEntries() {
  const now = Date.now();
  for (const [key, expiresAt] of processedMessageIds) {
    if (expiresAt <= now) processedMessageIds.delete(key);
  }
}

function rememberMessage(messageId) {
  if (!messageId) return false;
  cleanExpiredEntries();
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, Date.now() + DEDUPE_TTL_MS);
  return false;
}

function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return ALLOW_UNSIGNED_WEBHOOKS;
  const received = req.get('x-hub-signature-256') || '';
  const prefix = 'sha256=';
  if (!received.startsWith(prefix) || !req.rawBody) return false;
  const expected = createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  const a = Buffer.from(received.slice(prefix.length), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isAllowedFacebookUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === 'facebook.com' || host.endsWith('.facebook.com') ||
      host === 'fbcdn.net' || host.endsWith('.fbcdn.net') ||
      host === 'fbsbx.com' || host.endsWith('.fbsbx.com') ||
      host === 'facebook.net' || host.endsWith('.facebook.net');
  } catch {
    return false;
  }
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('Réponse audio trop volumineuse');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Réponse audio trop volumineuse');
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

app.use(express.json({
  limit: BODY_LIMIT,
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); },
}));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && typeof token === 'string' && token === VERIFY_TOKEN && typeof challenge === 'string') {
    return res.status(200).type('text/plain').send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(403);
  const body = req.body;
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return res.sendStatus(400);

  const events = body.entry.flatMap((entry) => Array.isArray(entry?.messaging) ? entry.messaging : []);
  if (events.length > MAX_EVENTS_PER_REQUEST) return res.sendStatus(413);
  res.status(200).send('EVENT_RECEIVED');

  for (const event of events) {
    void handleMessagingEvent(event).catch(() => {
      console.error('Échec du traitement d’un événement Messenger');
    });
  }
});

async function handleMessagingEvent(event) {
  const senderId = typeof event?.sender?.id === 'string' ? event.sender.id : '';
  if (!senderId || !event.message || event.message.is_echo) return;
  const messageId = typeof event.message.mid === 'string' ? event.message.mid : '';
  if (rememberMessage(messageId)) return;

  let userText = '';
  const audioAttachment = Array.isArray(event.message.attachments)
    ? event.message.attachments.find((attachment) => attachment?.type === 'audio')
    : null;
  if (audioAttachment?.payload?.url) {
    try {
      userText = await transcribeAudio(audioAttachment.payload.url);
    } catch {
      await sendTextMessage(senderId, "Désolé, je n'ai pas réussi à comprendre votre note vocale. Pouvez-vous réessayer ou m'écrire en texte ?");
      return;
    }
  } else if (typeof event.message.text === 'string') {
    userText = event.message.text;
  }

  userText = userText.trim().slice(0, MAX_USER_TEXT_CHARS);
  if (!userText) {
    await sendTextMessage(senderId, "Désolé, je n'ai pas compris votre message. Pouvez-vous réessayer en texte ou en note vocale ?");
    return;
  }

  const replyText = await generateReply(senderId, userText);
  await sendVoiceReply(senderId, replyText);
}

async function transcribeAudio(audioUrl) {
  if (!isAllowedFacebookUrl(audioUrl)) throw new Error('URL audio externe refusée');
  const response = await fetchWithTimeout(audioUrl);
  if (!response.ok) throw new Error(`Téléchargement audio HTTP ${response.status}`);
  const arrayBuffer = await readLimitedBody(response, MAX_AUDIO_BYTES);
  const audioFile = new File([arrayBuffer], 'audio.mp4', { type: response.headers.get('content-type') || 'audio/mp4' });
  const transcription = await openai.audio.transcriptions.create({ file: audioFile, model: 'whisper-1', language: 'fr' });
  return transcription.text || '';
}

async function generateReply(senderId, userText) {
  if (!conversations.has(senderId)) {
    if (conversations.size >= MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value);
    conversations.set(senderId, [{ role: 'system', content: SYSTEM_PROMPT }]);
  }
  const history = conversations.get(senderId);
  history.push({ role: 'user', content: userText });
  const trimmedHistory = [history[0], ...history.slice(-10)];
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
    messages: trimmedHistory,
    max_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 350),
  });
  const reply = String(completion.choices?.[0]?.message?.content || '').trim().slice(0, MAX_USER_TEXT_CHARS);
  history.push({ role: 'assistant', content: reply });
  return reply || "Je vais demander à un membre de l'équipe de vous recontacter.";
}

function graphMessagesUrl() {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages`;
}

async function sendVoiceReply(senderId, text) {
  try {
    const speech = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || 'tts-1',
      voice: process.env.OPENAI_TTS_VOICE || 'alloy',
      input: text.slice(0, MAX_USER_TEXT_CHARS),
      response_format: 'mp3',
    });
    const audioBuffer = Buffer.from(await speech.arrayBuffer());
    const formData = new FormData();
    formData.append('recipient', JSON.stringify({ id: senderId }));
    formData.append('message', JSON.stringify({ attachment: { type: 'audio', payload: { is_reusable: false } } }));
    formData.append('filedata', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'reply.mp3');
    const response = await fetchWithTimeout(graphMessagesUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` },
      body: formData,
    });
    if (!response.ok) await sendTextMessage(senderId, text);
  } catch {
    await sendTextMessage(senderId, text);
  }
}

async function sendTextMessage(senderId, text) {
  const response = await fetchWithTimeout(graphMessagesUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: senderId }, message: { text: text.slice(0, MAX_USER_TEXT_CHARS) } }),
  });
  if (!response.ok) throw new Error(`Messenger HTTP ${response.status}`);
}

app.get('/', (_req, res) => res.type('text/plain').send('Carokaz Mada Messenger Voicebot'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Serveur Carokaz Mada démarré sur le port ${PORT}`));
