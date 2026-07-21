import express from 'express';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

dotenv.config();

export const app = express();

// Conserver le corps brut permet de vérifier que les événements viennent bien de Meta.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buffer) => {
    req.rawBody = buffer;
  },
}));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const GRAPH_API_VERSION = 'v19.0';
let openaiClient;

function getOpenAI() {
  openaiClient ??= new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });
  return openaiClient;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`La variable d'environnement ${name} est requise`);
  return value;
}

function hasValidMetaSignature(req) {
  if (!APP_SECRET) return process.env.NODE_ENV !== 'production';
  const signature = req.get('x-hub-signature-256');
  if (!signature?.startsWith('sha256=') || !req.rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex')}`;
  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return received.length === expectedBuffer.length && crypto.timingSafeEqual(received, expectedBuffer);
}

// Mémoire de conversation simple en RAM (par utilisateur).
// ⚠️ Se réinitialise si le serveur redémarre. Pour la production à long terme,
// on pourra remplacer ceci par une base de données (ex: Redis, SQLite, etc.)
const conversations = new Map();

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

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook vérifié avec succès par Meta');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Échec de vérification du webhook');
    res.sendStatus(403);
  }
});

// ============================================================
// 2. Réception des messages Messenger (requête POST)
// ============================================================
app.post('/webhook', (req, res) => {
  if (!hasValidMetaSignature(req)) {
    console.warn('Signature Meta absente ou invalide');
    return res.sendStatus(401);
  }
  // On répond tout de suite à Meta pour éviter un timeout,
  // le traitement réel se fait juste après, en arrière-plan.
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      handleMessagingEvent(event).catch((err) => {
        console.error('Erreur traitement message:', err);
      });
    }
  }
});

async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  if (!senderId || !event.message) return;
  if (event.message.is_echo) return; // ignore les messages envoyés par la page elle-même

  let userText = null;

  // Cas 1 : message vocal (note audio)
  const audioAttachment = event.message.attachments?.find((a) => a.type === 'audio');
  if (audioAttachment?.payload?.url) {
    try {
      userText = await transcribeAudio(audioAttachment.payload.url);
      console.log(`🎤 Transcription: "${userText}"`);
    } catch (err) {
      console.error('Erreur transcription audio:', err);
      await sendTextMessage(
        senderId,
        "Désolé, je n'ai pas réussi à comprendre votre note vocale. Pouvez-vous réessayer ou m'écrire en texte ?"
      );
      return;
    }
  }
  // Cas 2 : message texte classique
  else if (event.message.text) {
    userText = event.message.text;
  }

  if (!userText) {
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
  const response = await fetch(audioUrl);
  if (!response.ok) throw new Error(`Téléchargement audio impossible (${response.status})`);
  const arrayBuffer = await response.arrayBuffer();
  const audioFile = new File([arrayBuffer], 'audio.mp4', { type: 'audio/mp4' });

  const transcription = await getOpenAI().audio.transcriptions.create({
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
  if (!conversations.has(senderId)) {
    conversations.set(senderId, [{ role: 'system', content: SYSTEM_PROMPT }]);
  }
  const history = conversations.get(senderId);
  history.push({ role: 'user', content: userText });

  // On garde seulement les derniers échanges pour limiter les coûts/tokens
  const trimmedHistory = [history[0], ...history.slice(-10)];

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: trimmedHistory,
  });

  const reply = completion.choices[0]?.message?.content?.trim();
  if (!reply) throw new Error("OpenAI n'a renvoyé aucune réponse");
  history.push({ role: 'assistant', content: reply });

  return reply;
}

// ============================================================
// Envoi de la réponse en note vocale (Text-to-Speech + Send API)
// ============================================================
async function sendVoiceReply(senderId, text) {
  try {
    const speech = await getOpenAI().audio.speech.create({
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
      `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${requireEnv('PAGE_ACCESS_TOKEN')}`,
      { method: 'POST', body: formData }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error('Erreur envoi audio Messenger:', errText);
      await sendTextMessage(senderId, text); // repli en texte
    }
  } catch (err) {
    console.error('Erreur génération/envoi audio:', err);
    await sendTextMessage(senderId, text); // repli en texte
  }
}

// ============================================================
// Envoi d'un message texte simple (repli / secours)
// ============================================================
async function sendTextMessage(senderId, text) {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${requireEnv('PAGE_ACCESS_TOKEN')}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text },
      }),
    }
  );
  if (!response.ok) throw new Error(`Envoi Messenger impossible (${response.status}): ${await response.text()}`);
}

// Page de test pour vérifier que le serveur tourne
app.get('/', (_req, res) => res.send('✅ Carokaz Mada Messenger Voicebot est en ligne'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`🚀 Serveur démarré sur le port ${PORT}`));
}
