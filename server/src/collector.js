// Collecte périodique : interroge la Freebox, enregistre l'historique et déclenche les alertes.
import { EventEmitter } from 'node:events';
import { DEFAULT_ALERT_SETTINGS, evaluateAlerts } from './alerts.js';
import { toConnection, toDevice, toSystem } from './freebox/mappers.js';

const now = () => Math.floor(Date.now() / 1000);

export class Collector extends EventEmitter {
  constructor({ freebox, store, config, notify = null, log = console }) {
    super();
    this.freebox = freebox;
    this.store = store;
    this.config = config;
    this.notify = notify;
    this.log = log;
    this.timers = [];
    this.running = new Set();
    // Dernières valeurs lues, servies directement à l'interface
    this.connection = null;
    this.system = null;
    this.lastError = null;
    this.lastSuccess = null;
  }

  start() {
    const { intervals } = this.config;
    const every = (name, seconds, fn) => {
      const run = () => this.guard(name, fn);
      run();
      this.timers.push(setInterval(run, seconds * 1000));
    };
    every('connection', intervals.connection, () => this.pollConnection());
    every('devices', intervals.devices, () => this.pollDevices());
    every('system', intervals.system, () => this.pollSystem());
    this.timers.push(setInterval(() => this.guard('rollup', () => this.store.rollup(this.config.retention)), intervals.rollup * 1000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** Une seule exécution à la fois par tâche ; rien tant que le serveur n'est pas associé. */
  async guard(name, fn) {
    if (this.running.has(name)) return;
    if (name !== 'rollup' && !this.freebox.paired) return;
    this.running.add(name);
    try {
      await fn();
      if (name !== 'rollup') {
        this.lastSuccess = now();
        if (this.lastError) {
          this.log.info('Freebox de nouveau joignable');
          this.lastError = null;
          this.emit('status', this.status());
        }
      }
    } catch (e) {
      // On ne répète pas la même erreur toutes les 10 secondes dans les logs
      if (this.lastError?.message !== e.message) this.log.warn(`Collecte ${name} : ${e.message}`);
      this.lastError = { message: e.message, code: e.code ?? null, ts: now() };
      this.emit('status', this.status());
    } finally {
      this.running.delete(name);
    }
  }

  status() {
    return { lastSuccess: this.lastSuccess, lastError: this.lastError };
  }

  async pollConnection() {
    const ts = now();
    const c = toConnection(await this.freebox.get('connection/'));
    const before = this.connection;
    this.connection = { ...c, ts };
    this.store.addMetrics({ 'wan.down': c.rateDown, 'wan.up': c.rateUp }, ts);

    if (before) {
      if (before.state === 'up' && c.state !== 'up') {
        await this.alert({ type: 'wan_down', message: `Connexion Internet perdue (état : ${c.state})`, tags: ['warning'], priority: 4 });
      } else if (before.state !== 'up' && c.state === 'up') {
        await this.alert({ type: 'wan_up', message: `Connexion Internet rétablie (${c.media ?? 'inconnu'})`, tags: ['white_check_mark'] });
      }
      if (before.ipv4 && c.ipv4 && before.ipv4 !== c.ipv4) {
        await this.alert({ type: 'ip_change', message: `Nouvelle IPv4 publique : ${c.ipv4} (avant : ${before.ipv4})`, tags: ['globe_with_meridians'], data: { before: before.ipv4, after: c.ipv4 } });
      }
    }
    this.emit('connection', this.connection);
  }

  async pollSystem() {
    const ts = now();
    const s = toSystem(await this.freebox.get('system/'));
    const before = this.system;
    this.system = { ...s, ts };
    const values = {};
    s.sensors.forEach((v) => { values[`temp.${v.id}`] = v.value; });
    s.fans.forEach((v) => { values[`fan.${v.id}`] = v.value; });
    this.store.addMetrics(values, ts);
    this.store.setSetting('system.labels', Object.fromEntries([...s.sensors, ...s.fans].map((v) => [v.id, v.name])));

    if (before && s.uptime < before.uptime) {
      await this.alert({ type: 'box_reboot', message: `La Freebox a redémarré${s.firmware ? ` (firmware ${s.firmware})` : ''}`, tags: ['arrows_counterclockwise'] });
    }
    this.emit('system', this.system);
  }

  async pollDevices() {
    const ts = now();
    const hosts = await this.freebox.get('lan/browser/pub/');
    const devices = (Array.isArray(hosts) ? hosts : []).map(toDevice);
    const { cameOnline, wentOffline } = this.store.saveDevices(devices, ts);
    this.store.addMetrics({ 'devices.online': devices.filter((d) => d.online).length }, ts);

    const settings = this.store.getSetting('alerts.settings', DEFAULT_ALERT_SETTINGS);
    const memory = this.store.getSetting('alerts.memory', null);
    const watched = this.store.watchedKeys();
    const outcome = evaluateAlerts(devices, settings, watched, memory, ts);
    this.store.setSetting('alerts.memory', outcome.memory);

    for (const d of outcome.newDevices) {
      const where = [d.ipv4[0], d.vendor, d.mac].filter(Boolean).join(' · ');
      await this.alert({ type: 'new_device', deviceKey: d.key, message: `Nouvel appareil : ${d.name}${where ? ` (${where})` : ''}`, tags: ['new'], priority: 4 });
    }
    for (const d of outcome.wentDown) {
      await this.alert({ type: 'device_down', deviceKey: d.key, message: `${d.name} est hors ligne depuis ${settings.offlineMinutes} min`, tags: ['red_circle'], priority: 4 });
    }
    for (const d of outcome.cameBack) {
      await this.alert({ type: 'device_back', deviceKey: d.key, message: `${d.name} est de retour en ligne`, tags: ['green_circle'] });
    }
    if (cameOnline.length || wentOffline.length || outcome.newDevices.length) {
      this.emit('devices', { cameOnline, wentOffline });
    }
  }

  /** Inscrit l'événement au journal, prévient l'interface et envoie la notification si ntfy est réglé. */
  async alert({ type, message, deviceKey = null, data = null, tags = [], priority = 3 }) {
    const event = this.store.addEvent({ type, message, deviceKey, data });
    this.log.info(`[${type}] ${message}`);
    this.emit('event', event);
    if (!this.notify) return;
    try {
      await this.notify({ title: 'Freebox Monitor', message, tags, priority });
    } catch (e) {
      this.log.warn(`Notification non envoyée : ${e.message}`);
    }
  }
}
