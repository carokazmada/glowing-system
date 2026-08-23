import express from 'express';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_API_VERSION = 'v19.0';

// Mémoire de conversation simple en RAM (par utilisateur).
// ⚠️ Se réinitialise si le serveur redémarre. Pour la production à long terme,
// on pourra remplacer ceci par une base de données (ex: Redis, SQLite, etc.)
const conversations = new Map();

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Tu es l'assistant vocal officiel de Carokaz Mada sur Messenger.
Tu réponds aux clients de manière chaleureuse, claire et professionnelle, en français (ou en malgache si le client t'écrit en malgache).
Tu aides les clients à connaître nos produits, nos prix, nos horaires, et comment commander.
Si tu ne connais pas une information précise (stock, prix exact, délai), dis-le honnêtement et propose qu'un membre de l'équipe les recontacte. Pour une demande écrite détaillée ou un suivi, indique que l’équipe est joignable à contact@carokazmada.com.
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
  const arrayBuffer = await response.arrayBuffer();
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
  if (!conversations.has(senderId)) {
    conversations.set(senderId, [{ role: 'system', content: SYSTEM_PROMPT }]);
  }
  const history = conversations.get(senderId);
  history.push({ role: 'user', content: userText });

  // On garde seulement les derniers échanges pour limiter les coûts/tokens
  const trimmedHistory = [history[0], ...history.slice(-10)];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: trimmedHistory,
  });

  const reply = completion.choices[0].message.content;
  history.push({ role: 'assistant', content: reply });

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
  await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text },
      }),
    }
  );
}

// Page de test pour vérifier que le serveur tourne
app.get('/', (req, res) => res.send('✅ Carokaz Mada Messenger Voicebot est en ligne'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur démarré sur le port ${PORT}`));
