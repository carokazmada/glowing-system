# Carokaz Mada — Chatbot vocal Messenger 🎙️

**Accès fermés par défaut :** le bot reste en pause et le serveur écoute uniquement
en local. Lire [SECURITY.md](SECURITY.md) avant de déployer ou de réactiver
volontairement le webhook. Les étapes ci-dessous décrivent le fonctionnement
après cette réactivation.

Ce projet fait fonctionner un assistant qui reçoit les **notes vocales** des clients sur ta page Facebook Messenger, comprend ce qu'ils disent, et répond aussi **en note vocale** (avec un repli automatique en texte si jamais la voix échoue).

---

## 1. Déployer le serveur sur Render.com (gratuit pour tester)

1. Va sur https://render.com et crée un compte (tu peux te connecter avec GitHub).
2. Mets ce dossier (`carokaz-messenger-bot`) dans un dépôt GitHub :
   - Crée un nouveau dépôt sur https://github.com/new
   - Upload tous les fichiers de ce dossier dedans (via l'interface web GitHub, "Add file" → "Upload files")
3. Sur Render : **New +** → **Web Service** → connecte ton dépôt GitHub.
4. Configure :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Plan** : Free pour tester (passe en payant ~7$/mois quand tu mets en production, pour que le bot ne "s'endorme" jamais)
5. Dans l'onglet **Environment**, ajoute ces variables (les mêmes que dans `.env.example`) :
   - `PUBLIC_ACCESS_ENABLED` — mettre **`true`** pour activer le service. Sans cette
     valeur, le serveur démarre en pause et répond `403` à tout.
   - `META_APP_SECRET` — le **App Secret** de ton App Meta (Meta for Developers →
     ton App → Paramètres → Général). Obligatoire : sans lui, le webhook refuse
     toutes les requêtes (`503`), car il ne peut pas vérifier les signatures.
   - `PAGE_ACCESS_TOKEN`
   - `VERIFY_TOKEN`
   - `OPENAI_API_KEY`
   - `SYSTEM_PROMPT` (optionnel)

   ⚠️ `META_APP_SECRET` n'est **pas** `VERIFY_TOKEN` ni `PAGE_ACCESS_TOKEN` : ce sont
   trois valeurs différentes. Ne mets jamais un secret dans un fichier du dépôt.
6. Clique **Create Web Service**. Render te donne une URL du type :
   `https://carokaz-messenger-bot.onrender.com`

Garde cette URL, tu en as besoin à l'étape suivante.

---

## 2. Récupérer le Token d'accès à la Page (PAGE_ACCESS_TOKEN)

1. Va sur https://developers.facebook.com/apps et ouvre ton App existante.
2. Dans le menu de gauche : **Messenger** → **Paramètres** (Settings).
3. Section **Access Tokens** : sélectionne ta page **Carokaz Mada** → génère le token.
4. Copie ce token et colle-le dans Render (variable `PAGE_ACCESS_TOKEN`), et garde-le aussi en lieu sûr.

---

## 3. Configurer le webhook sur Meta

1. Toujours dans **Messenger → Paramètres**, section **Webhooks** → **Add Callback URL** (ou "Modifier").
2. Renseigne :
   - **Callback URL** : `https://carokaz-messenger-bot.onrender.com/webhook`
   - **Verify Token** : exactement la même valeur que tu as mise dans `VERIFY_TOKEN` sur Render
3. Clique **Verify and Save**. Si tout est bon, Meta affichera une coche verte ✅.
4. Dans la liste des **champs d'abonnement (webhook fields)**, active au minimum :
   - `messages`
   - `messaging_postbacks`
5. Abonne ta Page au webhook (bouton "Subscribe" en face de ta page Carokaz Mada).

---

## 4. Tester

1. Va sur ta page Facebook **Carokaz Mada** → clique sur **Messenger / Envoyer un message**.
2. Envoie une **note vocale** du type : *"Bonjour, est-ce que vous livrez à Antananarivo ?"*
3. En quelques secondes, tu devrais recevoir une **réponse vocale** automatique.
4. Si l'audio ne fonctionne pas pour une raison quelconque, le bot enverra automatiquement une réponse en **texte** à la place — rien ne se perd.

---

## 5. Personnaliser les réponses du bot

Modifie la variable `SYSTEM_PROMPT` (sur Render, dans Environment) pour donner plus de détails sur ton activité : produits, prix, horaires, zone de livraison, ton de la marque, etc. Plus tu donnes de contexte, plus les réponses seront précises.

Exemple plus détaillé :
```
Tu es l'assistant vocal de Carokaz Mada, une boutique de [ton secteur] basée à Madagascar.
Nos horaires : Lundi-Samedi 8h-18h.
Nous livrons à : Antananarivo et environs.
Nos produits phares sont : ...
Si un client veut commander, demande-lui son nom, son numéro, et son adresse de livraison.
```

---

## 6. Coûts à prévoir

- **Render** : gratuit pour tester, ~7$/mois pour un service toujours actif (recommandé en production)
- **OpenAI** : facturé à l'usage (transcription Whisper + GPT + synthèse vocale TTS). Pour un petit volume de messages clients par jour, le coût reste généralement de quelques dollars par mois. Tu peux suivre ta consommation sur https://platform.openai.com/usage
- **Meta / Messenger** : gratuit pour ce type d'usage (pas d'API WhatsApp payante ici)

---

## 7. Limites actuelles (à connaître)

- L'historique de conversation est gardé en mémoire (RAM) : si le serveur redémarre, l'historique des conversations en cours est perdu (mais les clients peuvent recommencer à écrire normalement).
- Pas encore de base de données pour stocker les commandes/clients — si tu veux ça plus tard, on pourra l'ajouter.
- Le bot répond en français par défaut pour la transcription ; il peut comprendre le malgache aussi en général, mais la précision peut varier.

---

Si tu bloques sur une étape (vérification du webhook qui échoue, token invalide, etc.), montre-moi le message d'erreur exact et je t'aiderai à le résoudre.
