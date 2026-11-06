// Collecte périodique : interroge la Freebox, enregistre l'historique et déclenche les alertes.
import { EventEmitter } from 'node:events';
import { DEFAULT_ALERT_SETTINGS, evaluateAlerts } from './alerts.js';
import { repeaterLinks, toConnection, toDevice, toFtth, toRepeater, toSystem } from './freebox/mappers.js';
import { latestFor, newerRelease, parseRss } from './freebox/releases.js';
import { deviceTraffic, repeaterStations } from './freebox/traffic.js';
import { duration, evaluateRepeaters } from './repeaters.js';
import { PortScans } from './scan/scans.js';

const now = () => Math.floor(Date.now() / 1000);

export class Collector extends EventEmitter {
  constructor({ freebox, store, config, notify = null, log = console, scanner, fetchImpl = fetch }) {
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
    // Répéteurs Wi-Fi : { ts, items } (null tant qu'ils n'ont pas été lus ou si la box ne les gère pas)
    this.repeaters = null;
    // État de mise à jour de la box (GET update/, non documenté) : { state, ts } ; null si illisible
    this.update = null;
    // Versions annoncées par Free (flux RSS) : { ts, latest: { server, repeater }, error }
    this.fetchImpl = fetchImpl;
    this.releases = store.getSetting('releases.last', null);
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
    // Flux RSS de Free : premier passage 2 min après le démarrage (versions installées déjà lues), puis toutes les 6 h
    if (this.config.releasesFeedUrl) {
      // Hors de guard() : ce flux ne dit rien de la joignabilité de la box
      const releases = () => this.checkReleases().catch((e) => this.log.warn(`Flux RSS de Free : ${e.message}`));
      this.timers.push(setTimeout(releases, 120 * 1000), setInterval(releases, 6 * 3600 * 1000));
    }
  }

  stop() {
    this.timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
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

    const rebooted = await this.checkBoxReboot(s, ts);
    await this.checkUpdateState(ts, rebooted);
    const update = this.store.recordFirmware('box', s.model || 'Freebox', s.firmware, ts);
    if (update?.previous) await this.firmwareAlert(update, 'Firmware de la Freebox');
    await this.checkTemperature(s.sensors);
    await this.pollFtth(ts);
    this.system.ftth = this.ftth;
    this.emit('system', this.system);
  }

  /**
   * Redémarrage de la box : l'heure de démarrage (maintenant - uptime) est gardée en base, pour le voir aussi quand
   * ce serveur a été arrêté en même temps (VM de la Freebox). Si il avait été demandé depuis l'interface, on le dit.
   */
  async checkBoxReboot(s, ts) {
    if (!s.uptime) return false;
    const boot = ts - s.uptime;
    const before = this.store.getSetting('system.bootTs', null);
    this.store.setSetting('system.bootTs', boot);
    if (!before || boot <= before + 120) return false;
    const request = this.store.getSetting('box.rebootRequest', null);
    this.store.setSetting('box.rebootRequest', null);
    const firmware = s.firmware ? ` (firmware ${s.firmware})` : '';
    if (request && request.ts >= before && ts - request.ts < 3600) {
      await this.alert({ type: 'box_reboot', message: `La Freebox a redémarré à la demande de ${request.by}, de retour après ${duration(ts - request.ts)}${firmware}` });
    } else {
      await this.alert({ type: 'box_reboot', message: `La Freebox a redémarré${firmware}` });
    }
    return true;
  }

  /**
   * GET update/ : la box dit si son firmware est à jour (« up_to_date »). Free indique que cet état n'est calculé qu'au
   * démarrage de la box : on le relit toutes les heures et après chaque redémarrage. Alerte une fois quand il n'est
   * plus à jour (push si le réglage « firmware » est coché).
   */
  async checkUpdateState(ts, force = false) {
    if (this.updateSupported === false) return;
    if (!force && this.update && ts - this.update.ts < 3600) return;
    let result;
    try {
      result = await this.freebox.get('update/');
    } catch (e) {
      if (e.status === 404 || e.code === 'invalid_request' || e.code === 'nodev') this.updateSupported = false;
      return;
    }
    const state = result?.state ? String(result.state) : null;
    this.update = { state, ts };
    if (!state) return;
    const before = this.store.getSetting('box.updateState', null);
    this.store.setSetting('box.updateState', state);
    if (state !== 'up_to_date' && state !== before) {
      const settings = { ...DEFAULT_ALERT_SETTINGS, ...this.store.getSetting('alerts.settings', {}) };
      await this.alert({
        type: 'firmware_available',
        message: `La Freebox signale une mise à jour du firmware en attente (état : ${state}). Elle s'installe en général au prochain redémarrage.`,
        data: { state },
        push: settings.firmware,
      });
    }
  }

  /** Nouvelle version de firmware : toujours au journal, en push si le réglage « firmware » est coché. */
  async firmwareAlert(update, label) {
    const settings = { ...DEFAULT_ALERT_SETTINGS, ...this.store.getSetting('alerts.settings', {}) };
    await this.alert({
      type: 'firmware_update',
      message: `${label} mis à jour : ${update.previous} → ${update.version}`,
      data: { equipment: update.equipment, before: update.previous, after: update.version },
      push: settings.firmware,
    });
  }

  /**
   * Flux RSS du blog de Free : si une version plus récente que celle installée (même branche) est annoncée pour la box
   * ou un répéteur, alerte « firmware_published » une seule fois par version (push si le réglage firmwareRss est coché).
   */
  async checkReleases(ts = now()) {
    let items;
    try {
      const res = await this.fetchImpl(this.config.releasesFeedUrl, {
        headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'Freebox-Monitor' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      items = parseRss(await res.text());
    } catch (e) {
      // Erreur sans conséquence pour la collecte de la box : notée pour l'interface seulement
      this.releases = { ...(this.releases ?? {}), ts, error: `Flux RSS de Free illisible (${e.message})` };
      this.log.warn(this.releases.error);
      return;
    }
    const pick = (r) => (r ? { title: r.title, link: r.link, ts: r.ts, version: r.version } : null);
    const firstRepeater = this.repeaters?.items.find((r) => r.firmware);
    this.releases = {
      ts,
      latest: {
        server: pick(latestFor(items, 'server', this.system?.firmware, this.system?.model ?? '')),
        repeater: pick(firstRepeater ? latestFor(items, 'repeater', firstRepeater.firmware) : null),
      },
      error: items.length ? null : 'Flux RSS de Free vide',
    };
    this.store.setSetting('releases.last', this.releases);

    const alerted = new Set(this.store.getSetting('releases.alerted', []));
    const found = [];
    const box = newerRelease(items, 'server', this.system?.firmware, this.system?.model ?? '');
    if (box) found.push({ release: box, label: this.system.model || 'la Freebox Server', installed: this.system.firmware });
    const byVersion = new Map();
    for (const r of this.repeaters?.items ?? []) {
      const release = newerRelease(items, 'repeater', r.firmware);
      if (!release) continue;
      const entry = byVersion.get(release.version) ?? { release, names: [], installed: r.firmware };
      entry.names.push(r.name);
      byVersion.set(release.version, entry);
    }
    for (const { release, names, installed } of byVersion.values()) {
      found.push({ release, label: names.length > 1 ? `les répéteurs (${names.join(', ')})` : names[0], installed, target: 'repeater' });
    }
    const settings = { ...DEFAULT_ALERT_SETTINGS, ...this.store.getSetting('alerts.settings', {}) };
    for (const { release, label, installed, target = 'server' } of found) {
      const id = `${target}:${release.version}`;
      if (alerted.has(id)) continue;
      alerted.add(id);
      this.store.setSetting('releases.alerted', [...alerted].slice(-50));
      await this.alert({
        type: 'firmware_published',
        message: `Free annonce le firmware ${release.version} pour ${label} (installé : ${installed}). La mise à jour se fait en général toute seule, la nuit.`,
        data: { target, version: release.version, installed, link: release.link },
        push: settings.firmwareRss,
      });
    }
  }

  /** Répéteurs lus sur la box : état servi à l'interface, versions de firmware et alertes (voir repeaters.js). */
  async updateRepeaters(withHosts, ts = now()) {
    const items = withHosts.map(({ repeater, hosts }) => ({
      ...toRepeater(repeater),
      clients: (Array.isArray(hosts) ? hosts : []).filter((h) => h?.active !== false && h?.reachable !== false).length,
    }));
    this.repeaters = { ts, items };
    // Évaluation et mémoire mises à jour d'un bloc, avant tout await : pas de double alerte si deux collectes se croisent
    const settings = { ...DEFAULT_ALERT_SETTINGS, ...this.store.getSetting('alerts.settings', {}) };
    const outcome = evaluateRepeaters(items, {
      memory: this.store.getSetting('repeaters.memory', {}),
      requests: this.store.getSetting('repeaters.rebootRequests', {}),
      settings,
      now: ts,
    });
    this.store.setSetting('repeaters.memory', outcome.memory);
    this.store.setSetting('repeaters.rebootRequests', outcome.requests);
    const updates = items
      .map((r) => ({ r, update: this.store.recordFirmware(`repeater:${r.key}`, r.name, r.firmware, ts) }))
      .filter((u) => u.update?.previous);
    this.emit('repeaters', this.repeaters);
    for (const a of outcome.alerts) await this.alert(a);
    for (const { r, update } of updates) await this.firmwareAlert(update, `Firmware de ${r.name}`);
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
    // Clients Wi-Fi des répéteurs (débit lu chez le répéteur, ou déduit des compteurs d'octets)
    const repeaterHosts = await this.fetchRepeaterHosts();
    const { list: viaRepeater, counters } = repeaterStations(repeaterHosts ?? [], this.repeaterCounters, ts);
    this.repeaterCounters = counters;
    stations.push(...viaRepeater);
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
  /** Répéteurs Wi-Fi et leurs clients ; null si la box ne les gère pas ou ne répond pas. */
  async fetchRepeaterHosts() {
    if (this.repeatersSupported === false) return null;
    const withHosts = [];
    try {
      const repeaters = await this.freebox.get('repeater/');
      for (const repeater of Array.isArray(repeaters) ? repeaters : []) {
        withHosts.push({ repeater, hosts: await this.freebox.get(`repeater/${repeater.id}/host/`).catch(() => []) });
      }
      this.repeatersSupported = true;
    } catch (e) {
      // Box sans gestion des répéteurs (ancienne API) : on n'insiste pas
      if (e.status === 404 || e.code === 'invalid_api_version' || e.code === 'nodev') this.repeatersSupported = false;
      return null;
    }
    try {
      await this.updateRepeaters(withHosts);
    } catch (e) {
      this.log.warn(`Suivi des répéteurs : ${e.message}`);
    }
    return withHosts;
  }

  async applyRepeaters(devices) {
    const withHosts = await this.fetchRepeaterHosts();
    const current = withHosts ? repeaterLinks(withHosts) : null;
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
  async alert({ type, message, deviceKey = null, data = null, priority = 3, push = true }) {
    const event = this.store.addEvent({ type, message, deviceKey, data });
    this.log.info(`[${type}] ${message}`);
    this.emit('event', event);
    if (!this.notify || !push) return;
    try {
      const click = deviceKey ? `/appareils/${encodeURIComponent(deviceKey)}` : '/journal';
      await this.notify({ title: 'Freebox Monitor', message, priority, click, tag: `event-${event.id}` });
    } catch (e) {
      this.log.warn(`Notification non envoyée : ${e.message}`);
    }
  }
}
