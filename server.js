import express from 'express';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';
import { createHmac, timingSafeEqual } from 'node:crypto';

dotenv.config();

const requiredVariables = [
  'OPENAI_API_KEY',
  'PAGE_ACCESS_TOKEN',
  'VERIFY_TOKEN',
  'META_APP_SECRET',
];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);
if (missingVariables.length) {
  throw new Error(`Variables d’environnement requises absentes : ${missingVariables.join(', ')}`);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({
  limit: '100kb',
  verify: (req, _res, buffer) => {
    req.rawBody = buffer;
  },
}));
app.use('/webhook', rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
}));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
const GRAPH_API_VERSION = 'v19.0';

const MAX_USER_TEXT_LENGTH = 2_000;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_CONVERSATIONS = 10_000;
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const SENDER_WINDOW_MS = 15 * 60 * 1000;
const SENDER_MESSAGE_LIMIT = 20;

// La mémoire est volontairement limitée et expirée pour éviter une conservation
// indéfinie de données de conversation en RAM.
const conversations = new Map();
const conversationLastSeen = new Map();
const senderWindows = new Map();

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Tu es l'assistant vocal officiel de Carokaz Mada sur Messenger.
Tu réponds aux clients de manière chaleureuse, claire et professionnelle, en français (ou en malgache si le client t'écrit en malgache).
Tu aides les clients à connaître nos produits, nos prix, nos horaires, et comment commander.
Si tu ne connais pas une information précise (stock, prix exact, délai), dis-le honnêtement et propose qu'un membre de l'équipe les recontacte.
Garde tes réponses assez courtes et naturelles, car elles seront lues à voix haute au client.`;

function verifyMetaSignature(req) {
  const signature = req.get('X-Hub-Signature-256');
  if (!signature?.startsWith('sha256=') || !req.rawBody?.length) return false;

  const expected = `sha256=${createHmac('sha256', META_APP_SECRET)
    .update(req.rawBody)
    .digest('hex')}`;

  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer);
}

function checkSenderQuota(senderId) {
  const now = Date.now();
  const entry = senderWindows.get(senderId);
  if (!entry || now - entry.startedAt >= SENDER_WINDOW_MS) {
    senderWindows.set(senderId, { startedAt: now, count: 1 });
    return true;
  }

  if (entry.count >= SENDER_MESSAGE_LIMIT) return false;
  entry.count += 1;
  return true;
}

function getConversation(senderId) {
  let history = conversations.get(senderId);
  if (!history) {
    if (conversations.size >= MAX_CONVERSATIONS) {
      throw new Error('Capacité de conversation temporairement atteinte');
    }
    history = [{ role: 'system', content: SYSTEM_PROMPT }];
    conversations.set(senderId, history);
  }
  conversationLastSeen.set(senderId, Date.now());
  return history;
}

function isAllowedMetaMediaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' &&
    (host.endsWith('.fbsbx.com') || host.endsWith('.fbcdn.net'));
}

function cleanupConversationMemory() {
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  for (const [senderId, lastSeen] of conversationLastSeen) {
    if (lastSeen < cutoff) {
      conversations.delete(senderId);
      conversationLastSeen.delete(senderId);
      senderWindows.delete(senderId);
    }
  }
}

const cleanupTimer = setInterval(cleanupConversationMemory, 60 * 60 * 1000);
cleanupTimer.unref();

// ============================================================
// 1. Vérification du webhook par Meta (requête GET)
// ============================================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook vérifié avec succès par Meta');
    res.status(200).send(challenge);
  } else {
    console.warn('Échec de vérification du webhook');
    res.sendStatus(403);
  }
});

// ============================================================
// 2. Réception des messages Messenger (requête POST)
// ============================================================
app.post('/webhook', (req, res) => {
  if (!verifyMetaSignature(req)) {
    console.warn('Webhook rejeté : signature Meta invalide');
    return res.sendStatus(403);
  }

  // Meta doit obtenir la réponse rapidement ; le traitement reste asynchrone.
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      handleMessagingEvent(event).catch(() => {
        console.error('Erreur pendant le traitement d’un message');
      });
    }
  }
});

async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  if (!senderId || !event.message || event.message.is_echo) return;

  if (!checkSenderQuota(senderId)) {
    await sendTextMessage(senderId, 'Vous avez envoyé beaucoup de messages. Merci de réessayer dans quelques minutes.');
    return;
  }

  let userText = null;

  // Cas 1 : message vocal (note audio)
  const audioAttachment = event.message.attachments?.find((attachment) => attachment.type === 'audio');
  if (audioAttachment?.payload?.url) {
    try {
      userText = await transcribeAudio(audioAttachment.payload.url);
      console.info('Message vocal transcrit');
    } catch {
      console.error('Échec de transcription audio');
      await sendTextMessage(
        senderId,
        "Désolé, je n'ai pas réussi à comprendre votre note vocale. Pouvez-vous réessayer ou m'écrire en texte ?"
      );
      return;
    }
  }
  // Cas 2 : message texte classique
  else if (event.message.text) {
    userText = String(event.message.text);
  }

  if (!userText) {
    await sendTextMessage(
      senderId,
      "Désolé, je n'ai pas compris votre message. Pouvez-vous réessayer en texte ou en note vocale ?"
    );
    return;
  }

  const replyText = await generateReply(senderId, userText.slice(0, MAX_USER_TEXT_LENGTH));
  await sendVoiceReply(senderId, replyText);
}

// ============================================================
// Transcription audio (Speech-to-Text via OpenAI Whisper)
// ============================================================
async function transcribeAudio(audioUrl) {
  if (!isAllowedMetaMediaUrl(audioUrl)) {
    throw new Error('Origine audio non autorisée');
  }

  const response = await fetch(audioUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/')) {
    throw new Error('Réponse audio invalide');
  }

  const contentLength = Number(response.headers.get('content-length') || '0');
  if (contentLength > MAX_AUDIO_BYTES) {
    throw new Error('Fichier audio trop volumineux');
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('Fichier audio trop volumineux');
  }

  const audioFile = new File([arrayBuffer], 'audio.mp4', { type: 'audio/mp4' });
  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    language: 'fr',
  });

  return transcription.text;
}

// ============================================================
// Génération de la réponse (GPT)
// ============================================================
async function generateReply(senderId, userText) {
  const history = getConversation(senderId);
  history.push({ role: 'user', content: userText });

  // Le contexte transmis et conservé demeure borné.
  const trimmedHistory = [history[0], ...history.slice(-10)];
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: trimmedHistory,
  });

  const reply = completion.choices[0].message.content ||
    "Désolé, je n'ai pas pu préparer une réponse. Pouvez-vous réessayer ?";
  history.push({ role: 'assistant', content: reply });
  conversations.set(senderId, [history[0], ...history.slice(-12)]);

  return reply;
}

// ============================================================
// Envoi de la réponse en note vocale (Text-to-Speech + Send API)
// ============================================================
async function sendVoiceReply(senderId, text) {
  try {
    const speech = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
      response_format: 'mp3',
    });

    const audioBuffer = Buffer.from(await speech.arrayBuffer());
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });

    const formData = new FormData();
    formData.append('recipient', JSON.stringify({ id: senderId }));
    formData.append(
      'message',
      JSON.stringify({
        attachment: {
          type: 'audio',
          payload: { is_reusable: false },
        },
      })
    );
    formData.append('filedata', audioBlob, 'reply.mp3');

    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { method: 'POST', body: formData, signal: AbortSignal.timeout(15_000) }
    );

    if (!res.ok) {
      console.error('Échec de l’envoi audio Messenger');
      await sendTextMessage(senderId, text);
    }
  } catch {
    console.error('Échec de génération ou d’envoi audio');
    await sendTextMessage(senderId, text);
  }
}

// ============================================================
// Envoi d'un message texte simple (repli / secours)
// ============================================================
async function sendTextMessage(senderId, text) {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text: String(text).slice(0, MAX_USER_TEXT_LENGTH) },
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!response.ok) {
    console.error('Échec de l’envoi texte Messenger');
  }
}

app.get('/', (_req, res) => res.type('text').send('Carokaz Mada Messenger Voicebot est en ligne'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
