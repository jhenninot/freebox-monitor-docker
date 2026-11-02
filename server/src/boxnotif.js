// Notifications envoyées par la Freebox (API 11 et plus). Le serveur s'inscrit lui-même comme « cible » auprès
// de la box et joue le rôle du relais : la box l'appelle (contrat « Notification server specification » de
// Freebox OS), et chaque notification est inscrite au journal puis envoyée par ntfy.
// Règles et textes repris de domain/BoxNotifications.kt et du relais server/src/messages.js de l'appli Android.
import crypto from 'node:crypto';
import express from 'express';

export const NOTIF_API_MAJOR = 11;

export const BOX_SUBSCRIPTIONS = [
  ['lan_host', 'Nouvel appareil sur le réseau'],
  ['box_state', 'Connexion, redémarrage, mise en veille de la box'],
  ['password_change', 'Changement du mot de passe administrateur'],
  ['phone', 'Appel manqué sur la ligne fixe'],
  ['download', 'Téléchargement terminé'],
  ['security', 'Alarme Freebox Delta'],
];
export const DEFAULT_BOX_SUBSCRIPTIONS = ['lan_host', 'box_state', 'password_change'];

export const normalizeBaseUrl = (input) => String(input ?? '').trim().replace(/\/+$/, '');

/** Vrai pour une IPv4 privée (192.168.x.x, 10.x.x.x, 172.16 à 172.31.x.x). */
export function isPrivateIpv4(host) {
  const parts = String(host).split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** Message d'erreur si l'adresse de ce serveur n'est pas utilisable par la box, sinon null. */
export function baseUrlError(input) {
  const url = normalizeBaseUrl(input);
  if (!url) return 'Indique l\'adresse de ce serveur';
  if (url.startsWith('http://')) {
    // http seulement vers le réseau local : la box ne sait pas toujours se rappeler elle-même par son IP publique
    const host = url.slice(7).split('/')[0].split(':')[0];
    return isPrivateIpv4(host) ? null : 'En http, seule une adresse IP locale est acceptée (ex. http://192.168.1.20:8086)';
  }
  if (!url.startsWith('https://')) return 'L\'adresse doit commencer par https:// (ou http:// suivi d\'une IP locale)';
  const host = url.slice(8).split('/')[0];
  if (!host || host.includes(' ') || !host.includes('.')) return 'Adresse invalide';
  return null;
}

const BOX_STATE = {
  pub_up: 'La connexion Internet est rétablie',
  enter_sleep: 'La Freebox passe en veille',
  shut_down: 'La Freebox va s\'éteindre',
  reboot: 'La Freebox redémarre',
};
const DOWNLOAD = { task_done: 'Téléchargement terminé', task_error: 'Téléchargement en échec', task_seeding_done: 'Partage du téléchargement terminé' };
const macFromHostId = (hostId = '') => (/([0-9a-f]{2}(:[0-9a-f]{2}){5})/i.exec(hostId)?.[1].toUpperCase() ?? hostId);

/** Ce que la box envoie à /send → { title, body, priority } en français. */
export function describe({ title, body, payload = {} } = {}) {
  let fallback;
  switch (payload?.type) {
    case 'lan':
    case 'lan_host':
      fallback = { title: 'Nouvel appareil sur le réseau', body: `Un appareil s'est connecté pour la première fois (${macFromHostId(payload.host_id)}).`, priority: 4 };
      break;
    case 'box_state':
      fallback = { title: 'Freebox', body: BOX_STATE[payload.event] || `Changement d'état : ${payload.event}`, priority: payload.event === 'pub_up' ? 3 : 4 };
      break;
    case 'password_change':
      fallback = { title: 'Mot de passe Freebox OS modifié', body: `Le mot de passe administrateur a été changé depuis ${payload.ip || 'une adresse inconnue'}.`, priority: 5 };
      break;
    case 'phone': {
      const call = payload.data || {};
      fallback = { title: 'Appel manqué', body: `Appel manqué de ${call.name || call.number || 'un numéro masqué'}.`, priority: 3 };
      break;
    }
    case 'downloader':
      fallback = { title: DOWNLOAD[payload.event] || 'Téléchargement', body: `Tâche n°${payload.data}`, priority: 2 };
      break;
    default:
      fallback = { title: 'Freebox', body: 'Nouvelle notification de la Freebox.', priority: 3 };
  }
  return { ...fallback, title: title || fallback.title, body: body || fallback.body };
}

/** Identité de ce serveur auprès de la box : id de cible, jeton et secret de l'adresse, créés une fois. */
export function notifIdentity(store) {
  let identity = store.getSetting('boxnotif.identity');
  if (!identity) {
    identity = {
      targetId: `fbm-server-${crypto.randomBytes(4).toString('hex')}`,
      token: crypto.randomBytes(24).toString('hex'),
      secret: crypto.randomBytes(16).toString('hex'),
    };
    store.setSetting('boxnotif.identity', identity);
  }
  return identity;
}

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Routes appelées par la Freebox : /box-notif/<secret>/register, /register/:box/:device, /send. Sans session. */
export function boxNotifReceiver({ store, collector, log = console }) {
  const router = express.Router({ mergeParams: true });
  const record = (kind) => store.setSetting('boxnotif.lastCall', { ts: Math.floor(Date.now() / 1000), kind });

  router.use('/:secret', (req, res, next) => {
    if (!same(req.params.secret, notifIdentity(store).secret)) return res.status(404).json({ error: 'Route inconnue' });
    next();
  });

  router.post('/:secret/register', (req, res) => {
    const { box_id: boxId, device_id: deviceId, token } = req.body ?? {};
    if (!boxId || !deviceId || !token) return res.status(400).json({ error: 'box_id, device_id et token sont obligatoires' });
    // Seul notre propre jeton est accepté : ce relais ne sert qu'à ce serveur
    if (!same(token, notifIdentity(store).token)) return res.status(403).json({ error: 'Jeton inconnu' });
    store.setSetting('boxnotif.registration', { boxId, deviceId, ts: Math.floor(Date.now() / 1000) });
    record('register');
    log.info(`Notifications de la box : inscription confirmée par la Freebox ${boxId}`);
    res.json({ success: true });
  });

  router.delete('/:secret/register/:boxId/:deviceId', (_req, res) => {
    store.setSetting('boxnotif.registration', null);
    record('unregister');
    res.json({ success: true });
  });

  router.post('/:secret/send', async (req, res) => {
    const { devices = [], title, body, payload } = req.body ?? {};
    const m = describe({ title, body, payload });
    record('send');
    await collector.alert({
      type: 'box_notif',
      message: `${m.title} : ${m.body}`,
      tags: ['bell'],
      priority: m.priority,
      data: payload ?? null,
    });
    res.json({ successIds: Array.isArray(devices) ? devices : [], failureIds: [] });
  });

  return router;
}
