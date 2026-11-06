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
    // Premier compte de l'interface, créé au démarrage s'il n'existe encore aucun compte (migration douce).
    // Sans ADMIN_PASSWORD, le premier compte se crée depuis l'interface.
    adminUsername: (env.ADMIN_USERNAME || 'admin').trim(),
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

    // Test de débit : client Speedtest by Ookla (installé dans l'image) et serveur imposé (id Speedtest, sinon le plus proche)
    speedtestBin: (env.SPEEDTEST_BIN || 'speedtest').trim(),
    speedtestServerId: (env.SPEEDTEST_SERVER_ID || '').trim() || null,

    // Notifications Web Push : contact donné aux services de push des navigateurs (mailto: ou https:)
    pushSubject: (env.PUSH_SUBJECT || 'https://github.com/jhenninot/freebox-monitor-docker').trim(),
  };
}

/** Liste des problèmes bloquants, vide si la configuration est utilisable. */
export function checkConfig(config) {
  const problems = [];
  if (config.appSecret.length < 16) problems.push('APP_SECRET doit faire au moins 16 caractères (par exemple : openssl rand -hex 32)');
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(config.adminUsername)) problems.push('ADMIN_USERNAME : 3 à 32 caractères parmi lettres, chiffres, point, tiret et souligné');
  return problems;
}
