// Point d'entrée : configuration, base, client Freebox, collecte et serveur HTTP
import fs from 'node:fs';
import path from 'node:path';
import { createNtfyNotifier } from './alerts.js';
import { createApp } from './app.js';
import { Collector } from './collector.js';
import { checkConfig, loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { FreeboxClient } from './freebox/client.js';
import { Secrets } from './security.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const config = loadConfig();
const problems = checkConfig(config);
if (problems.length) {
  problems.forEach((p) => console.error(p));
  process.exit(1);
}

const store = openDatabase(config.dbFile);
const secrets = new Secrets(config.appSecret);

// Le jeton d'application Freebox est gardé chiffré dans la base
const credentials = {
  load() {
    const value = store.getSetting('freebox.credentials');
    return value ? secrets.decrypt(value) : null;
  },
  save(value) {
    store.setSetting('freebox.credentials', secrets.encrypt(value));
  },
  clear() {
    store.setSetting('freebox.credentials', null);
  },
};
if (store.getSetting('freebox.credentials') && !credentials.load()) {
  console.warn('Jeton Freebox illisible (APP_SECRET a changé ?) : association à refaire depuis l\'interface');
  credentials.clear();
}

const freebox = new FreeboxClient({ baseUrl: config.freeboxUrl, credentials, appVersion: pkg.version });
const notify = createNtfyNotifier(config.ntfy);
const collector = new Collector({ freebox, store, config, notify });
const app = createApp({ config, store, secrets, freebox, collector, notify });

// Sauvegarde quotidienne de la base dans le volume (/data/backup/freebox-monitor-<jour>.db, 7 jours gardés)
function backup() {
  try {
    const dir = path.join(config.dataDir, 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    store.backup(path.join(dir, `freebox-monitor-${day}.db`));
    fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().slice(0, -7)
      .forEach((f) => fs.rmSync(path.join(dir, f)));
  } catch (e) {
    console.warn(`Sauvegarde impossible : ${e.message}`);
  }
}
const backupTimer = setInterval(backup, 24 * 3600 * 1000);

const server = app.listen(config.port, () => {
  console.log(`Freebox Monitor ${pkg.version} prêt sur le port ${config.port}`
    + ` (Freebox : ${config.freeboxUrl}, ${freebox.paired ? 'associé' : 'à associer depuis l\'interface'}`
    + `, alertes ntfy : ${notify ? 'oui' : 'non'})`);
  collector.start();
});

function shutdown(signal) {
  console.log(`${signal} reçu, arrêt`);
  collector.stop();
  clearInterval(backupTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Les connexions temps réel restent ouvertes : on n'attend pas plus de 3 s
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
