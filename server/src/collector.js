// Collecte périodique : interroge la Freebox, enregistre l'historique et déclenche les alertes.
import { EventEmitter } from 'node:events';
import { DEFAULT_ALERT_SETTINGS, evaluateAlerts } from './alerts.js';
import { repeaterLinks, toConnection, toDevice, toFtth, toSystem } from './freebox/mappers.js';
import { deviceTraffic } from './freebox/traffic.js';
import { PortScans } from './scan/scans.js';

const now = () => Math.floor(Date.now() / 1000);

export class Collector extends EventEmitter {
  constructor({ freebox, store, config, notify = null, log = console, scanner }) {
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
    // IP fixes (baux DHCP statiques), relues à chaque passage pour marquer les appareils concernés
    this.staticLeases = [];
    // Trafic par appareil (stations Wi-Fi + prises Ethernet) et état du module fibre
    this.traffic = null;
    this.ftth = null;
    // Scans de ports (à la demande et chaque nuit sur les appareils surveillés)
    this.scans = new PortScans({ store, alert: (a) => this.alert(a), log, ...(scanner ? { scanner } : {}) });
    this.scans.on('progress', (p) => this.emit('scan', p));
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
    every('traffic', intervals.traffic, () => this.pollTraffic());
    this.timers.push(setInterval(() => this.guard('rollup', () => this.store.rollup(this.config.retention)), intervals.rollup * 1000));
    this.timers.push(setInterval(() => this.nightlyScanDue(), 60 * 1000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.scans.stopAll();
  }

  /** Scan de ports de nuit : une fois par jour, à l'heure réglée (fuseau TZ du conteneur). */
  async nightlyScanDue(date = new Date()) {
    const settings = { ...DEFAULT_ALERT_SETTINGS, ...this.store.getSetting('alerts.settings', {}) };
    if (!settings.nightlyScan || date.getHours() !== settings.nightlyScanHour) return false;
    const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    if (this.store.getSetting('scan.nightlyDay') === day) return false;
    this.store.setSetting('scan.nightlyDay', day);
    const count = await this.scans.nightly();
    this.log.info(`Scan de ports de nuit : ${count} appareil(s) surveillé(s) en ligne`);
    return true;
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
        await this.alert({ type: 'wan_down', message: `Connexion Internet perdue (état : ${c.state})`, priority: 4 });
      } else if (before.state !== 'up' && c.state === 'up') {
        await this.alert({ type: 'wan_up', message: `Connexion Internet rétablie (${c.media ?? 'inconnu'})` });
      }
      if (before.ipv4 && c.ipv4 && before.ipv4 !== c.ipv4) {
        await this.alert({ type: 'ip_change', message: `Nouvelle IPv4 publique : ${c.ipv4} (avant : ${before.ipv4})`, data: { before: before.ipv4, after: c.ipv4 } });
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
      await this.alert({ type: 'box_reboot', message: `La Freebox a redémarré${s.firmware ? ` (firmware ${s.firmware})` : ''}` });
    }
    await this.checkTemperature(s.sensors);
    await this.pollFtth(ts);
    this.system.ftth = this.ftth;
    this.emit('system', this.system);
  }

  /** Alerte une fois au-delà du seuil, puis une fois revenu 5 °C en dessous (pas d'alerte en rafale). */
  async checkTemperature(sensors) {
    if (!sensors.length) return;
    const hottest = sensors.reduce((a, b) => (b.value > a.value ? b : a));
    const threshold = this.config.tempAlertCelsius;
    const hot = this.store.getSetting('alerts.hot', false);
    if (!hot && hottest.value >= threshold) {
      this.store.setSetting('alerts.hot', true);
      await this.alert({ type: 'box_hot', message: `Température élevée dans la Freebox : ${hottest.name} à ${hottest.value} °C. Vérifie l'aération de la box.`, priority: 4, data: { sensor: hottest.id, value: hottest.value } });
    } else if (hot && hottest.value < threshold - 5) {
      this.store.setSetting('alerts.hot', false);
      await this.alert({ type: 'box_cool', message: `Température de la Freebox revenue à la normale (${hottest.value} °C)` });
    }
  }

  /** Module fibre : seulement si la connexion passe par la fibre. */
  async pollFtth(ts) {
    if (this.connection?.media !== 'ftth') {
      this.ftth = null;
      return;
    }
    try {
      this.ftth = toFtth(await this.freebox.get('connection/ftth/'));
    } catch {
      this.ftth = null;
      return;
    }
    if (this.ftth.powerReport) this.store.addMetrics({ 'fiber.rx': this.ftth.rxPower, 'fiber.tx': this.ftth.txPower }, ts);
  }

  /** Débit et volume par appareil. Les prises sans lien sont ignorées. */
  async pollTraffic() {
    const ts = now();
    const stations = [];
    const aps = await this.freebox.get('wifi/ap/').catch(() => []);
    for (const ap of Array.isArray(aps) ? aps : []) {
      const list = await this.freebox.get(`wifi/ap/${ap.id}/stations/`).catch(() => []);
      if (Array.isArray(list)) stations.push(...list);
    }
    const ports = [];
    const status = await this.freebox.get('switch/status/').catch(() => []);
    for (const port of Array.isArray(status) ? status : []) {
      if (port.link !== 'up') continue;
      const stats = await this.freebox.get(`switch/port/${port.id}/stats`).catch(() => null);
      if (stats) ports.push({ port, stats });
    }
    const items = deviceTraffic(stations, ports, this.store.listDevices());
    this.traffic = { ts, items };
    const values = {};
    for (const t of items) {
      if (!t.deviceKey) continue;
      values[`dev.${t.deviceKey}.down`] = t.downRate;
      values[`dev.${t.deviceKey}.up`] = t.upRate;
    }
    this.store.addMetrics(values, ts);
    this.emit('traffic', this.traffic);
  }

  async pollDevices() {
    const ts = now();
    const hosts = await this.freebox.get('lan/browser/pub/');
    const devices = (Array.isArray(hosts) ? hosts : []).map(toDevice);
    await this.applyRepeaters(devices);
    const { cameOnline, wentOffline } = this.store.saveDevices(devices, ts);
    await this.refreshStaticLeases();
    this.store.addMetrics({ 'devices.online': devices.filter((d) => d.online).length }, ts);

    const settings = this.store.getSetting('alerts.settings', DEFAULT_ALERT_SETTINGS);
    const memory = this.store.getSetting('alerts.memory', null);
    const watched = this.store.watchedKeys();
    const outcome = evaluateAlerts(devices, settings, watched, memory, ts);
    this.store.setSetting('alerts.memory', outcome.memory);

    for (const d of outcome.newDevices) {
      const where = [d.ipv4[0], d.vendor, d.mac].filter(Boolean).join(' · ');
      await this.alert({ type: 'new_device', deviceKey: d.key, message: `Nouvel appareil : ${d.name}${where ? ` (${where})` : ''}`, priority: 4 });
    }
    for (const d of outcome.wentDown) {
      await this.alert({ type: 'device_down', deviceKey: d.key, message: `${d.name} est hors ligne depuis ${settings.offlineMinutes} min`, priority: 4 });
    }
    for (const d of outcome.cameBack) {
      await this.alert({ type: 'device_back', deviceKey: d.key, message: `${d.name} est de retour en ligne` });
    }
    if (cameOnline.length || wentOffline.length || outcome.newDevices.length) {
      this.emit('devices', { cameOnline, wentOffline });
    }
  }

  /**
   * Corrige la connexion des appareils passés par un répéteur Wi-Fi Freebox (voir repeaterLinks).
   * Les associations sont gardées en base : un appareil hors ligne garde sa dernière connexion connue.
   */
  async applyRepeaters(devices) {
    let current = null;
    if (this.repeatersSupported !== false) {
      try {
        const repeaters = await this.freebox.get('repeater/');
        const list = Array.isArray(repeaters) ? repeaters : [];
        const withHosts = [];
        for (const repeater of list) {
          withHosts.push({ repeater, hosts: await this.freebox.get(`repeater/${repeater.id}/host/`).catch(() => []) });
        }
        current = repeaterLinks(withHosts);
        this.repeatersSupported = true;
      } catch (e) {
        // Box sans gestion des répéteurs (ancienne API) : on n'insiste pas
        if (e.status === 404 || e.code === 'invalid_api_version' || e.code === 'nodev') this.repeatersSupported = false;
      }
    }
    const known = { ...this.store.getSetting('repeater.links', {}), ...(current ?? {}) };
    if (current) this.store.setSetting('repeater.links', known);
    for (const d of devices) {
      const mac = d.mac?.toUpperCase();
      // En ligne : seule la liste actuelle du répéteur compte ; hors ligne : la dernière connue
      const via = mac && (current ? (d.online ? current[mac] : known[mac]) : known[mac]);
      if (!via) continue;
      d.link = via.link;
      if (via.wifiBand) d.wifiBand = via.wifiBand;
      d.raw = { ...d.raw, _repeater: via.repeater };
    }
  }

  async refreshStaticLeases() {
    try {
      const leases = await this.freebox.get('dhcp/static_lease/');
      this.staticLeases = Array.isArray(leases) ? leases : [];
    } catch {
      // Lecture facultative : on garde la liste précédente
    }
  }

  /** Inscrit l'événement au journal, prévient l'interface et envoie la notification push aux navigateurs abonnés. */
  async alert({ type, message, deviceKey = null, data = null, priority = 3 }) {
    const event = this.store.addEvent({ type, message, deviceKey, data });
    this.log.info(`[${type}] ${message}`);
    this.emit('event', event);
    if (!this.notify) return;
    try {
      const click = deviceKey ? `/appareils/${encodeURIComponent(deviceKey)}` : '/journal';
      await this.notify({ title: 'Freebox Monitor', message, priority, click, tag: `event-${event.id}` });
    } catch (e) {
      this.log.warn(`Notification non envoyée : ${e.message}`);
    }
  }
}
