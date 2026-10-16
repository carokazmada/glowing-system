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

## Dépôt et services externes

La PR ne change pas les permissions GitHub, Render, Meta ou OpenAI.
Pour fermer le dépôt : GitHub → Settings → General → Danger Zone →
Change repository visibility → Make private. Désactiver GitHub Pages s'il est
activé et vérifier séparément les déploiements et liens de partage existants.
Conserver la protection de `main` et l'approbation par un autre réviseur.

Révoquer et remplacer dans Meta/OpenAI tout identifiant réel qui aurait été
publié. Un dépôt privé et `.gitignore` ne révoquent pas les secrets et ne
suppriment pas les copies ou l'historique Git déjà accessibles.
