// API HTTP de l'interface web (Express 5) et fichiers de l'interface Vue
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { cleanAlertSettings, DEFAULT_ALERT_SETTINGS } from './alerts.js';
import { normalizeMac } from './freebox/rules.js';
import { rankTraffic } from './freebox/traffic.js';
import { boxRouter } from './routes/box.js';
import { passwordMatches } from './security.js';

const COOKIE = 'fbm_session';
const SESSION_DAYS = 30;
const RANGES = { '1h': 3600, '6h': 6 * 3600, '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, '1y': 365 * 86400 };
const now = () => Math.floor(Date.now() / 1000);

/** Champ « info » de la box ({ upnp: {...}, mdns: {...} }) → sections lisibles, sans valeur vide. */
function infoSections(info) {
  if (!info || typeof info !== 'object') return [];
  return Object.entries(info).map(([source, content]) => ({
    source,
    entries: Object.entries(content && typeof content === 'object' ? content : {})
      .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')])
      .filter(([, v]) => v.trim()),
  })).filter((s) => s.entries.length);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Limite les essais de mot de passe : 10 par quart d'heure et par adresse IP. */
function loginLimiter() {
  const attempts = new Map();
  return (ip) => {
    const t = Date.now();
    const list = (attempts.get(ip) || []).filter((x) => t - x < 15 * 60 * 1000);
    list.push(t);
    attempts.set(ip, list);
    return list.length <= 10;
  };
}

export function createApp({ config, store, secrets, freebox, collector, notify, log = console }) {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  const allowLogin = loginLimiter();

  // --- Connexion à l'interface ---

  const sessionOf = (req) => {
    const payload = secrets.verify(readCookie(req, COOKIE));
    return payload && payload.exp > now() ? payload : null;
  };

  api.post('/auth/login', (req, res) => {
    if (!allowLogin(req.ip)) return res.status(429).json({ error: 'Trop d\'essais, réessaie dans quelques minutes' });
    if (!passwordMatches(req.body?.password, config.adminPassword)) {
      log.warn(`Mot de passe refusé depuis ${req.ip}`);
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    }
    const token = secrets.sign({ sub: 'admin', exp: now() + SESSION_DAYS * 86400 });
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSION_DAYS * 86400 * 1000,
      path: '/',
    });
    res.json({ ok: true });
  });

  api.post('/auth/logout', (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  api.get('/auth/me', (req, res) => res.json({ authenticated: Boolean(sessionOf(req)) }));

  // Tout ce qui suit demande d'être connecté
  api.use((req, res, next) => {
    if (!sessionOf(req)) return res.status(401).json({ error: 'Connexion requise' });
    // Protection CSRF : les requêtes qui modifient viennent forcément de notre interface (JSON)
    // (un formulaire d'un autre site ne peut envoyer ni JSON ni DELETE sans autorisation CORS)
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'JSON attendu' });
    }
    next();
  });

  // --- Association avec la Freebox ---

  api.get('/freebox', (_req, res) => {
    const creds = freebox.credentials.load();
    res.json({
      url: config.freeboxUrl,
      paired: Boolean(creds?.appToken),
      boxName: creds?.boxName ?? null,
      apiMajor: creds?.apiMajor ?? null,
      permissions: freebox.permissions,
      collector: collector.status(),
    });
  });

  api.post('/freebox/pair', async (req, res) => {
    const result = await freebox.startPairing(String(req.body?.deviceName || 'Serveur Docker').slice(0, 64));
    res.json(result);
  });

  api.get('/freebox/pair', async (_req, res) => {
    const result = await freebox.pairingStatus();
    if (result.status === 'granted') {
      log.info('Association avec la Freebox validée');
      // Première collecte tout de suite, sans attendre le prochain passage
      collector.guard('connection', () => collector.pollConnection());
      collector.guard('devices', () => collector.pollDevices());
      collector.guard('system', () => collector.pollSystem());
    }
    res.json(result);
  });

  api.delete('/freebox/pair', (_req, res) => {
    freebox.unpair();
    log.info('Association avec la Freebox supprimée');
    res.json({ ok: true });
  });

  // --- Accueil ---

  api.get('/overview', (_req, res) => {
    const labels = store.getSetting('system.labels', {});
    const devices = store.listDevices();
    res.json({
      connection: collector.connection,
      system: collector.system,
      labels,
      devices: { total: devices.length, online: devices.filter((d) => d.online).length },
      events: store.listEvents({ limit: 10 }),
      collector: collector.status(),
      tempAlertCelsius: config.tempAlertCelsius,
    });
  });

  // Trafic par appareil, du plus gros consommateur au plus petit (sort = rate ou volume)
  api.get('/traffic', (req, res) => {
    const sort = req.query.sort === 'volume' ? 'volume' : 'rate';
    const t = collector.traffic;
    res.json({ ts: t?.ts ?? null, sort, items: t ? rankTraffic(t.items, sort) : [] });
  });

  api.get('/metrics', (req, res) => {
    const keys = String(req.query.keys || 'wan.down,wan.up').split(',').map((k) => k.trim()).filter(Boolean).slice(0, 20);
    const range = RANGES[req.query.range] ?? RANGES['24h'];
    const to = now();
    res.json(store.series(keys, to - range, to));
  });

  // --- Appareils ---

  // IP fixe de l'appareil (bail statique), d'après la dernière lecture de la box
  const leaseOf = (device) => (device.mac
    ? collector.staticLeases.find((l) => normalizeMac(l.mac) === normalizeMac(device.mac)) ?? null
    : null);

  api.get('/devices', (_req, res) => res.json(store.listDevices().map((d) => ({ ...d, fixedIp: Boolean(leaseOf(d)) }))));

  api.get('/devices/:key', (req, res) => {
    const device = store.getDevice(req.params.key);
    if (!device) return res.status(404).json({ error: 'Appareil inconnu' });
    const days = Math.min(Number.parseInt(req.query.days, 10) || 7, 365);
    const raw = store.getDeviceRaw(device.key) ?? {};
    const lease = leaseOf(device);
    res.json({
      ...device,
      sessions: store.deviceSessions(device.key, now() - days * 86400),
      events: store.listEvents({ deviceKey: device.key, limit: 50 }),
      box: {
        persistent: Boolean(raw.persistent),
        // Nom DNS local (API 16) : null si la box ne le gère pas
        localDomain: raw.local_domain || null,
        domainName: raw.local_domain ? (raw.domain_name ?? '') : null,
        ipv6: (raw.l3connectivities ?? []).filter((c) => c.af === 'ipv6').map((c) => c.addr),
        otherNames: (raw.names ?? []).filter((n) => n.name && n.name !== device.name).map((n) => ({ name: n.name, source: n.source ?? '' })),
        info: infoSections(raw.info),
      },
      lease: lease ? { id: lease.id, ip: lease.ip, comment: lease.comment ?? '' } : null,
      // Débit et volume actuels si l'appareil est une station Wi-Fi ou seul sur sa prise
      traffic: collector.traffic?.items.find((t) => t.deviceKey === device.key) ?? null,
    });
  });

  api.patch('/devices/:key', (req, res) => {
    if (!store.getDevice(req.params.key)) return res.status(404).json({ error: 'Appareil inconnu' });
    const { watched, hidden } = req.body || {};
    const update = {};
    if (typeof watched === 'boolean') update.watched = watched;
    if (typeof hidden === 'boolean') update.hidden = hidden;
    res.json(store.updateDeviceFlags(req.params.key, update));
  });

  // Renommer l'appareil dans la Freebox (droit « Modification des réglages » nécessaire)
  api.put('/devices/:key/name', async (req, res) => {
    const device = store.getDevice(req.params.key);
    if (!device) return res.status(404).json({ error: 'Appareil inconnu' });
    const name = String(req.body?.name || '').trim().slice(0, 64);
    if (!name) return res.status(400).json({ error: 'Nom vide' });
    await freebox.put(`lan/browser/pub/${encodeURIComponent(device.id)}/`, { id: device.id, primary_name: name });
    await collector.guard('devices', () => collector.pollDevices());
    res.json(store.getDevice(device.key));
  });

  // --- Journal et alertes ---

  api.get('/events', (req, res) => {
    res.json(store.listEvents({
      limit: Number.parseInt(req.query.limit, 10) || 100,
      before: Number.parseInt(req.query.before, 10) || null,
    }));
  });

  api.get('/alerts/settings', (_req, res) => {
    res.json({
      ...store.getSetting('alerts.settings', DEFAULT_ALERT_SETTINGS),
      ntfy: notify ? { configured: true, url: config.ntfy.url, topic: config.ntfy.topic } : { configured: false },
    });
  });

  api.put('/alerts/settings', (req, res) => {
    const current = store.getSetting('alerts.settings', DEFAULT_ALERT_SETTINGS);
    const next = cleanAlertSettings(req.body, current);
    store.setSetting('alerts.settings', next);
    res.json(next);
  });

  api.post('/alerts/test', async (_req, res) => {
    if (!notify) return res.status(400).json({ error: 'ntfy n\'est pas réglé (variables NTFY_URL et NTFY_TOPIC)' });
    await notify({ title: 'Freebox Monitor', message: 'Notification de test : les alertes arrivent bien.', tags: ['test_tube'] });
    res.json({ ok: true });
  });

  // --- Temps réel (Server-Sent Events) ---

  api.get('/live', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    if (collector.connection) send('connection', collector.connection);
    const handlers = {
      connection: (d) => send('connection', d),
      system: (d) => send('system', d),
      event: (d) => send('event', d),
      devices: (d) => send('devices', d),
      status: (d) => send('status', d),
      traffic: (d) => send('traffic', d),
    };
    Object.entries(handlers).forEach(([k, h]) => collector.on(k, h));
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      Object.entries(handlers).forEach(([k, h]) => collector.off(k, h));
    });
  });

  api.use(boxRouter({ freebox, store, collector }));

  api.use((_req, res) => res.status(404).json({ error: 'Route inconnue' }));
  app.use('/api', api);

  // --- Interface Vue (application monopage) ---
  const index = path.join(config.webDir, 'index.html');
  if (fs.existsSync(index)) {
    app.use(express.static(config.webDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(index) : next()));
  } else {
    log.warn(`Interface absente (${config.webDir}) : seule l'API est servie`);
  }

  // Erreurs : message lisible pour l'interface, détails dans les logs
  app.use((err, _req, res, _next) => {
    let status = 500;
    if (err.status && err.name !== 'FreeboxError') status = err.status; // HttpError, JSON invalide...
    else if (err.code === 'not_paired') status = 409;
    else if (err.name === 'FreeboxError') {
      // Refus de la box (paramètre invalide...) : erreur de la demande, pas du serveur
      status = err.code === 'insufficient_rights' ? 403 : err.code === 'unreachable' || !err.status || err.status >= 500 ? 502 : 400;
    }
    if (status === 500) log.error(err);
    const hint = err.code === 'insufficient_rights'
      ? ' : dans Freebox OS, Paramètres > Gestion des accès > Applications, coche « Modification des réglages » pour Freebox Monitor (serveur)'
      : '';
    res.status(status).json({ error: status === 500 ? 'Erreur interne' : `${err.message}${hint}`, code: err.code ?? null });
  });

  return app;
}
