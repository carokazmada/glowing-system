import express from 'express';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { accessConfig, accessGate, verifyWebhookBody } from './security.js';
import { File } from 'node:buffer';
import { connectorFetch, metaAudioUrl, boundedBytes, metaMessageRequest } from './connectors.js';
import { TransientStore } from './transient-store.js';
import { WorkQueue } from './work-queue.js';

dotenv.config();

const app = express();
const access = accessConfig(process.env);
app.disable('x-powered-by');
app.use(accessGate(access.enabled));
app.use(express.json({ limit: '256kb', inflate: false, verify: verifyWebhookBody(access.appSecret) }));

const openai = access.enabled ? new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 0,
}) : null;

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_API_VERSION = 'v19.0';

// Mémoire bornée et temporaire ; aucune conversation persistée sur disque.
const conversations = new TransientStore();
const processedMessages = new TransientStore({ maxEntries: 5000 });
const workQueue = new WorkQueue();
setInterval(() => {
  conversations.prune();
  processedMessages.prune();
}, 60_000).unref();

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Tu es l'assistant vocal officiel de Carokaz Mada sur Messenger.
Tu réponds aux clients de manière chaleureuse, claire et professionnelle, en français (ou en malgache si le client t'écrit en malgache).
Tu aides les clients à connaître nos produits, nos prix, nos horaires, et comment commander.
Si tu ne connais pas une information précise (stock, prix exact, délai), dis-le honnêtement et propose qu'un membre de l'équipe les recontacte.
Garde tes réponses assez courtes et naturelles, car elles seront lues à voix haute au client.`;

// ============================================================
// 1. Vérification du webhook par Meta (requête GET)
// ============================================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && typeof token === 'string' && token === VERIFY_TOKEN && typeof challenge === 'string') {
    console.log('✅ Webhook vérifié avec succès par Meta');
    res.status(200).type('text/plain').send(challenge);
  } else {
    console.log('❌ Échec de vérification du webhook');
    res.sendStatus(403);
  }
});

// ============================================================
// 2. Réception des messages Messenger (requête POST)
// ============================================================
app.post('/webhook', (req, res) => {
  if (!req.is('application/json') || req.body?.object !== 'page' || !Array.isArray(req.body.entry) ||
      !req.body.entry.every(entry => entry && Array.isArray(entry.messaging))) {
    return res.sendStatus(400);
  }
  const events = [];
  const batchIds = new Set();
  for (const entry of req.body.entry) {
    for (const event of entry.messaging) {
      const senderId = event?.sender?.id;
      const messageId = event?.message?.mid;
      if (typeof senderId !== 'string' || typeof messageId !== 'string' || event.message.is_echo) continue;
      if (processedMessages.get(messageId) || batchIds.has(messageId)) continue;
      batchIds.add(messageId);
      events.push(event);
    }
  }
  // Refuser tout le lot avant l'accusé de réception permet à Meta de réessayer.
  if (!workQueue.canAccept(events.length)) {
    res.setHeader('Retry-After', '2');
    return res.sendStatus(503);
  }
  for (const event of events) {
    processedMessages.set(event.message.mid, true);
    workQueue.add(event.sender.id, () => handleMessagingEvent(event));
  }
  res.status(200).send('EVENT_RECEIVED');
});

async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  if (!senderId || !event.message) return;
  if (event.message.is_echo) return; // ignore les messages envoyés par la page elle-même

  let userText = null;

  // Cas 1 : message vocal (note audio)
  const audioAttachment = Array.isArray(event.message.attachments)
    ? event.message.attachments.find(a => a?.type === 'audio') : undefined;
  if (audioAttachment?.payload?.url) {
    try {
      userText = await transcribeAudio(audioAttachment.payload.url);
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
  else if (typeof event.message.text === 'string') {
    userText = event.message.text;
  }

  if (typeof userText !== 'string' || !userText.trim() || userText.length > 4000) {
    await sendTextMessage(
      senderId,
      "Désolé, je n'ai pas compris votre message. Pouvez-vous réessayer en texte ou en note vocale ?"
    );
    return;
  }

  // Générer la réponse avec GPT
  const replyText = await generateReply(senderId, userText);

  // Répondre en note vocale (avec repli en texte si l'audio échoue)
  await sendVoiceReply(senderId, replyText);
}

// ============================================================
// Transcription audio (Speech-to-Text via OpenAI Whisper)
// ============================================================
async function transcribeAudio(audioUrl) {
  const response = await connectorFetch(metaAudioUrl(audioUrl));
  const audioBytes = await boundedBytes(response, 20 * 1024 * 1024);
  const audioFile = new File([audioBytes], 'audio.mp4', { type: 'audio/mp4' });

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
  const history = conversations.get(senderId) || [];
  const messages = [{ role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-8), { role: 'user', content: userText }];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    max_tokens: 512,
    store: false,
  });

  const reply = completion.choices[0]?.message?.content;
  if (typeof reply !== 'string' || !reply.trim()) throw new Error('Réponse OpenAI vide');
  conversations.set(senderId, [...messages.slice(1), { role: 'assistant', content: reply }]);

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

    const audioBuffer = await boundedBytes(speech, 10 * 1024 * 1024);
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

    const request = metaMessageRequest(GRAPH_API_VERSION, PAGE_ACCESS_TOKEN, formData);
    const response = await connectorFetch(request.url, request.options);
    await response.body?.cancel();
  } catch {
    console.error('Échec de génération/envoi audio');
    await sendTextMessage(senderId, text); // repli en texte
  }
}

// ============================================================
// Envoi d'un message texte simple (repli / secours)
// ============================================================
async function sendTextMessage(senderId, text) {
  const request = metaMessageRequest(GRAPH_API_VERSION, PAGE_ACCESS_TOKEN, {
    recipient: { id: senderId }, message: { text },
  }, true);
  const response = await connectorFetch(request.url, request.options);
  await response.body?.cancel();
}

// Réponses génériques : aucune trace interne ni secret dans les erreurs HTTP.
app.use((err, req, res, next) => {
  const status = [400, 403, 413, 415].includes(err.status) ? err.status : 500;
  res.sendStatus(status);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, access.host, () => console.log(`Serveur démarré ; accès ${access.enabled ? 'Meta uniquement' : 'désactivés'}`));
