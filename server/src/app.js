// API HTTP de l'interface web (Express 5) et fichiers de l'interface Vue
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { cleanAlertSettings, DEFAULT_ALERT_SETTINGS } from './alerts.js';
import { boxNotifReceiver } from './boxnotif.js';
import { normalizeMac } from './freebox/rules.js';
import { rankTraffic } from './freebox/traffic.js';
import { boxRouter } from './routes/box.js';
import { boxNotifRouter } from './routes/boxnotif.js';
import { dnsRouter } from './routes/dns.js';
import { equipmentRouter } from './routes/equipment.js';
import { networkRouter } from './routes/network.js';
import { pushRouter } from './routes/push.js';
import { scanRouter } from './routes/scan.js';
import { speedtestRouter } from './routes/speedtest.js';
import { vpnRouter } from './routes/vpn.js';
import { Accounts, ipLimiter, PASSWORD_POLICY, passwordError, usernameError } from './auth.js';

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

export function createApp({ config, store, secrets, freebox, collector, speedtest = null, push = null, accounts = new Accounts(store), dnsTest = undefined, log = console }) {
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
  const ipFailures = ipLimiter();

  // --- Connexion à l'interface ---

  /** Compte de la session (cookie signé), ou null si absente, expirée ou fermée par un changement de mot de passe. */
  const sessionOf = (req) => {
    const payload = secrets.verify(readCookie(req, COOKIE));
    if (!payload || !(payload.exp > now()) || !Number.isInteger(payload.sub)) return null;
    const user = accounts.get(payload.sub);
    return user && user.sessionVersion === payload.v ? user : null;
  };

  const openSession = (req, res, user) => {
    const token = secrets.sign({ sub: user.id, v: user.sessionVersion, exp: now() + SESSION_DAYS * 86400 });
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSION_DAYS * 86400 * 1000,
      path: '/',
    });
  };

  const me = (user) => ({
    authenticated: Boolean(user),
    username: user?.username ?? null,
    mustChange: user?.mustChange ?? false,
    setupRequired: !user && accounts.count() === 0,
    policy: PASSWORD_POLICY,
  });

  const tooMany = (res, seconds) => {
    if (seconds) res.set('Retry-After', String(seconds));
    const minutes = Math.max(1, Math.ceil((seconds || 900) / 60));
    return res.status(429).json({ error: `Trop d'essais, réessaie dans ${minutes} min`, code: 'too_many_attempts' });
  };

  const text = (v) => (typeof v === 'string' ? v : '');

  api.get('/auth/me', (req, res) => res.json(me(sessionOf(req))));

  // Création du premier compte, possible seulement tant qu'il n'en existe aucun
  api.post('/auth/setup', async (req, res) => {
    if (ipFailures.blocked(req.ip)) return tooMany(res);
    if (accounts.count() > 0) return res.status(409).json({ error: 'Un compte existe déjà' });
    const username = text(req.body?.username).trim();
    const password = text(req.body?.password);
    const error = usernameError(username) || passwordError(password, username);
    if (error) return res.status(400).json({ error });
    let user;
    try {
      user = await accounts.create(username, password);
    } catch {
      return res.status(409).json({ error: 'Un compte existe déjà' });
    }
    log.info?.(`Compte « ${username} » créé depuis ${req.ip}`);
    openSession(req, res, user);
    res.json(me(user));
  });

  api.post('/auth/login', async (req, res) => {
    if (ipFailures.blocked(req.ip)) return tooMany(res);
    const result = await accounts.authenticate(text(req.body?.username).trim(), text(req.body?.password));
    if (result.error === 'locked') return tooMany(res, result.retryAfter);
    if (!result.user) {
      ipFailures.fail(req.ip);
      log.warn(`Connexion refusée depuis ${req.ip}`);
      if (result.retryAfter) return tooMany(res, result.retryAfter);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    }
    openSession(req, res, result.user);
    res.json(me(result.user));
  });

  api.post('/auth/logout', (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // Changement de mot de passe : demande l'actuel, ferme les autres sessions et garde celle-ci ouverte
  api.post('/auth/password', async (req, res) => {
    const user = sessionOf(req);
    if (!user) return res.status(401).json({ error: 'Connexion requise' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON attendu' });
    if (ipFailures.blocked(req.ip)) return tooMany(res);
    const current = text(req.body?.currentPassword);
    const next = text(req.body?.newPassword);
    const check = await accounts.authenticate(user.username, current);
    if (check.error === 'locked' || check.retryAfter) return tooMany(res, check.retryAfter);
    if (!check.user) ipFailures.fail(req.ip);
    if (!check.user) return res.status(400).json({ error: 'Mot de passe actuel incorrect', code: 'bad_current_password' });
    const error = passwordError(next, user.username);
    if (error) return res.status(400).json({ error });
    if (next === current) return res.status(400).json({ error: 'Le nouveau mot de passe doit être différent de l\'actuel' });
    const updated = await accounts.setPassword(user.id, next);
    log.info?.(`Mot de passe du compte « ${user.username} » changé`);
    openSession(req, res, updated);
    res.json(me(updated));
  });

  // Changement d'identifiant : demande le mot de passe actuel
  api.post('/auth/username', async (req, res) => {
    const user = sessionOf(req);
    if (!user) return res.status(401).json({ error: 'Connexion requise' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON attendu' });
    if (user.mustChange) return res.status(403).json({ error: 'Change d\'abord ton mot de passe', code: 'password_change_required' });
    if (ipFailures.blocked(req.ip)) return tooMany(res);
    const current = text(req.body?.currentPassword);
    const username = text(req.body?.newUsername).trim();
    const check = await accounts.authenticate(user.username, current);
    if (check.error === 'locked' || check.retryAfter) return tooMany(res, check.retryAfter);
    if (!check.user) ipFailures.fail(req.ip);
    if (!check.user) return res.status(400).json({ error: 'Mot de passe actuel incorrect', code: 'bad_current_password' });
    const error = usernameError(username);
    if (error) return res.status(400).json({ error });
    if (current.toLowerCase().includes(username.toLowerCase())) {
      return res.status(400).json({ error: 'Ton mot de passe contient ce nouvel identifiant : change d\'abord de mot de passe' });
    }
    const updated = accounts.rename(user.id, username);
    if (!updated) return res.status(409).json({ error: 'Cet identifiant est déjà pris' });
    log.info?.(`Compte « ${user.username} » renommé en « ${username} »`);
    res.json(me(updated));
  });

  // Tout ce qui suit demande d'être connecté
  api.use((req, res, next) => {
    const user = sessionOf(req);
    if (!user) return res.status(401).json({ error: 'Connexion requise' });
    if (user.mustChange) {
      return res.status(403).json({ error: 'Change ton mot de passe pour continuer', code: 'password_change_required' });
    }
    // Protection CSRF : les requêtes qui modifient viennent forcément de notre interface (JSON)
    // (un formulaire d'un autre site ne peut envoyer ni JSON ni DELETE sans autorisation CORS)
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'JSON attendu' });
    }
    req.user = user;
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
      repeaters: collector.repeaters
        ? { total: collector.repeaters.items.length, online: collector.repeaters.items.filter((r) => r.online !== false).length }
        : null,
      events: store.listEvents({ limit: 10 }),
      collector: collector.status(),
      tempAlertCelsius: config.tempAlertCelsius,
      speedtest: store.listSpeedtests(1)[0] ?? null,
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
        // Répéteur Wi-Fi Freebox par lequel passe l'appareil
        repeater: raw._repeater ?? null,
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
      ...DEFAULT_ALERT_SETTINGS,
      ...store.getSetting('alerts.settings', DEFAULT_ALERT_SETTINGS),
      push: { subscriptions: push ? push.count : 0 },
    });
  });

  api.put('/alerts/settings', (req, res) => {
    const current = { ...DEFAULT_ALERT_SETTINGS, ...store.getSetting('alerts.settings', {}) };
    const next = cleanAlertSettings(req.body, current);
    store.setSetting('alerts.settings', next);
    res.json(next);
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
      scan: (d) => send('scan', d),
      repeaters: (d) => send('repeaters', d),
    };
    Object.entries(handlers).forEach(([k, h]) => collector.on(k, h));
    const onSpeedtest = (d) => send('speedtest', d);
    speedtest?.on('progress', onSpeedtest);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      speedtest?.off('progress', onSpeedtest);
      Object.entries(handlers).forEach(([k, h]) => collector.off(k, h));
    });
  });

  api.use(boxRouter({ freebox, store, collector }));
  api.use(equipmentRouter({ freebox, store, collector }));
  api.use(scanRouter({ store, scans: collector.scans }));
  api.use(networkRouter({ freebox, store, collector }));
  api.use(vpnRouter({ freebox }));
  api.use(dnsRouter({ freebox, testServer: dnsTest }));
  api.use(boxNotifRouter({ freebox, store, config }));
  if (push) api.use(pushRouter({ push, store }));
  if (speedtest) api.use(speedtestRouter({ speedtest, store }));

  api.use((_req, res) => res.status(404).json({ error: 'Route inconnue' }));
  app.use('/api', api);

  // Appels de la Freebox pour ses notifications (protégés par le secret de l'adresse, sans session)
  app.use('/box-notif', boxNotifReceiver({ store, collector, log }));

  // --- Interface Vue (application monopage) ---
  const index = path.join(config.webDir, 'index.html');
  if (fs.existsSync(index)) {
    // Service worker et manifeste toujours revalidés : une nouvelle version est prise en compte tout de suite
    app.use(express.static(config.webDir, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, file) => {
        if (/(sw\.js|manifest\.webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache');
      },
    }));
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
