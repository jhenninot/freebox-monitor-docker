// Réglages lus dans les variables d'environnement (voir .env.example et docker-compose.yml)
import path from 'node:path';

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR || '/data';
  return {
    port: int(env.PORT, 8080),
    dataDir,
    dbFile: env.DB_FILE || path.join(dataDir, 'freebox-monitor.db'),
    // Dossier de l'interface Vue construite (web/dist), servie par Express
    webDir: path.resolve(env.WEB_DIR || path.join(import.meta.dirname, '../public')),

    // Chiffre le jeton Freebox et signe les cookies de session
    appSecret: (env.APP_SECRET || '').trim(),
    // Mot de passe du compte unique de l'interface
    adminPassword: env.ADMIN_PASSWORD || '',
    // Derrière Nginx Proxy Manager : on fait confiance à X-Forwarded-For / X-Forwarded-Proto
    trustProxy: env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal',

    // Adresse de ce serveur vue par la Freebox (notifications de la box), ex. http://192.168.1.20:8086
    publicUrl: (env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),

    freeboxUrl: (env.FREEBOX_URL || 'http://mafreebox.freebox.fr').replace(/\/+$/, ''),

    // Périodes de collecte, en secondes
    intervals: {
      connection: int(env.POLL_CONNECTION_SECONDS, 10),
      devices: int(env.POLL_DEVICES_SECONDS, 30),
      system: int(env.POLL_SYSTEM_SECONDS, 60),
      traffic: int(env.POLL_TRAFFIC_SECONDS, 30),
      rollup: 60,
    },
    // Durée de conservation, en jours (les moyennes horaires sont gardées sans limite)
    retention: {
      rawDays: int(env.RETENTION_RAW_DAYS, 7),
      minuteDays: int(env.RETENTION_MINUTE_DAYS, 90),
      eventDays: int(env.RETENTION_EVENT_DAYS, 365),
    },

    // Seuil de l'alerte « température élevée » (capteur le plus chaud de la box)
    tempAlertCelsius: int(env.TEMP_ALERT_CELSIUS, 85),

    // Alertes envoyées par ntfy (https://ntfy.sh ou une instance auto-hébergée)
    ntfy: {
      url: (env.NTFY_URL || '').replace(/\/+$/, ''),
      topic: (env.NTFY_TOPIC || '').trim(),
      token: (env.NTFY_TOKEN || '').trim(),
    },
  };
}

/** Liste des problèmes bloquants, vide si la configuration est utilisable. */
export function checkConfig(config) {
  const problems = [];
  if (config.appSecret.length < 16) problems.push('APP_SECRET doit faire au moins 16 caractères (par exemple : openssl rand -hex 32)');
  if (config.adminPassword.length < 8) problems.push('ADMIN_PASSWORD doit faire au moins 8 caractères');
  return problems;
}
