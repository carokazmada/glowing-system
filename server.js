import dotenv from 'dotenv';
import { createApp } from './app.js';

dotenv.config();

const app = createApp(process.env);
const access = app.locals.access;

// Nettoyage périodique des mémoires bornées (conversations et déduplication).
setInterval(() => app.locals.prune(), 60_000).unref();

const PORT = process.env.PORT || 3000;
app.listen(PORT, access.host, () => console.log(
  `Serveur démarré ; accès ${access.enabled ? 'Meta uniquement' : 'désactivés'}`
));
