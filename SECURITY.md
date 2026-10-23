# Accès désactivés par défaut

Le serveur écoute sur `127.0.0.1` et refuse toutes les requêtes HTTP avec un
statut 403 tant que `PUBLIC_ACCESS_ENABLED` ne vaut pas exactement `true`.
Les appels Meta et OpenAI ne sont pas exécutés dans cet état.
Ce réglage met aussi le bot Messenger en pause. Sur Render, un contrôle de santé
public peut échouer et le déploiement peut être refusé : suspendre le service
dans Render pour fermer immédiatement un déploiement existant.

Ces changements prennent effet seulement après fusion et déploiement. Modifier
le code ne ferme pas un serveur déjà en cours d'exécution. Une variable déjà
définie dans l'hébergement prime sur `.env` ; `.env.example` est un modèle.

## Réactivation volontaire de Messenger

Conserver le verrouillage pour maintenir tous les accès fermés. Pour remettre
le bot en service, configurer explicitement dans l'hébergeur :

- `PUBLIC_ACCESS_ENABLED=true` et `HOST=0.0.0.0` si une écoute réseau est nécessaire ;
- `META_APP_SECRET` : secret de l'application Meta ;
- `VERIFY_TOKEN` : secret aléatoire d'au moins 32 caractères, aussi configuré dans Meta ;
- `PAGE_ACCESS_TOKEN` et `OPENAI_API_KEY` : identifiants réels, conservés dans le gestionnaire de secrets.

Le démarrage est refusé si un identifiant requis manque, est trop court ou contient
un exemple. Seuls `GET /webhook` (vérification par secret) et `POST /webhook`
(signature HMAC SHA-256 Meta obligatoire sur le corps brut) sont autorisés.
Les autres routes restent fermées. Utiliser HTTPS via l'hébergeur. Ne pas publier
de fichier `.env`. Exécuter `npm test` avant chaque modification de ces contrôles.

## Appels Meta et OpenAI

Les jetons Meta sont transmis dans l'en-tête `Authorization`, sans apparaître
dans les URL. Les erreurs distantes et les transcriptions ne sont plus écrites
dans les journaux. Les appels ont un délai de 30 secondes ; les nouvelles
tentatives automatiques OpenAI sont désactivées pour limiter les doublons et
les coûts. Les réponses audio sont lues avec une limite et un délai distincts.

Les téléchargements audio exigent HTTPS sur `fbcdn.net`, `fbsbx.com` ou leurs
sous-domaines, sans identifiants dans l'URL, port non standard ni redirection.
Une nouvelle origine Meta devra être ajoutée explicitement si nécessaire.
La limite est de 20 Mio pour une pièce jointe et 10 Mio pour la synthèse vocale.
Le texte entrant est limité à 4 000 caractères et la réponse à 512 tokens.
`store: false` est transmis pour les réponses de chat ; cela ne constitue pas
une garantie de rétention nulle chez OpenAI ou Meta.

Au maximum quatre traitements sont actifs, avec une capacité totale de
36 messages en mémoire. Les messages d'un même expéditeur sont traités dans
l'ordre. Un lot excédant la capacité reçoit un statut 503 avant son accusé de
réception pour permettre une nouvelle tentative de Meta. La file n'est pas
persistante : un redémarrage peut perdre les messages déjà acceptés.
Les identifiants de messages acceptés sont mémorisés pendant au plus 30 minutes
pour éviter de retraiter les doublons tant qu'ils restent dans le cache borné
à 5 000 entrées. La mémoire des conversations est bornée à 1 000 utilisateurs,
10 messages par utilisateur, et expire après 30 minutes d'inactivité ; un
nettoyage passe chaque minute. Ces limites sont locales à chaque processus
et ne remplacent pas les budgets et quotas des fournisseurs.

La version Graph existante (`v19.0`) est conservée ; sa disponibilité n'a pas
été vérifiée en production. La connexion réelle Meta/OpenAI doit être validée
avant toute réactivation. Les réglages ChatGPT des connecteurs sont indépendants
de ces protections du code et des autorisations OAuth chez les fournisseurs.

## Dépôt et services externes

La PR ne change pas les permissions GitHub, Render, Meta ou OpenAI.
Pour fermer le dépôt : GitHub → Settings → General → Danger Zone →
Change repository visibility → Make private. Désactiver GitHub Pages s'il est
activé et vérifier séparément les déploiements et liens de partage existants.
Conserver la protection de `main` et l'approbation par un autre réviseur.
Le workflow `Security checks` exécute les tests sans secrets avec un jeton
GitHub en lecture seule et des actions référencées par leur commit. Il ne
modifie pas à lui seul les vérifications exigées par la protection de `main`.

Révoquer et remplacer dans Meta/OpenAI tout identifiant réel qui aurait été
publié. Un dépôt privé et `.gitignore` ne révoquent pas les secrets et ne
suppriment pas les copies ou l'historique Git déjà accessibles.
