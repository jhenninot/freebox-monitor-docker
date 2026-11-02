// Scans de ports lancés depuis l'interface ou chaque nuit sur les appareils surveillés
import { EventEmitter } from 'node:events';
import { identify as identifyPort, scanPorts } from './scanner.js';
import { diffScans, KNOWN_SERVICES, MAX_PORT, QUICK_SCAN_PORTS } from './services.js';

const now = () => Math.floor(Date.now() / 1000);
const FULL_PORTS = Array.from({ length: MAX_PORT }, (_, i) => i + 1);
const IDENTIFY_PARALLEL = 8;

export class PortScans extends EventEmitter {
  /** scanner : { scanPorts, identify } remplaçable dans les tests. alert : envoie une alerte (journal + ntfy). */
  constructor({ store, alert = async () => {}, scanner = { scanPorts, identify: identifyPort }, log = console }) {
    super();
    this.store = store;
    this.alert = alert;
    this.scanner = scanner;
    this.log = log;
    // Scans en cours par appareil : { deviceKey, ip, full, done, total, found, identifying, startedAt, controller }
    this.running = new Map();
  }

  progress(key) {
    const s = this.running.get(key);
    if (!s) return null;
    const { controller, lastEmit, ...visible } = s;
    return { ...visible, running: true };
  }

  publish(s, force = false) {
    // Au plus une mise à jour par seconde pendant le test des ports
    const t = Date.now();
    if (!force && t - (s.lastEmit ?? 0) < 1000) return;
    s.lastEmit = t;
    this.emit('progress', this.progress(s.deviceKey));
  }

  /** Lance un scan et attend sa fin. Renvoie le résultat enregistré. */
  async run(device, { full = false, nightly = false } = {}) {
    if (!device.ipv4) throw Object.assign(new Error('Adresse IPv4 inconnue : impossible de scanner'), { status: 400 });
    if (this.running.has(device.key)) throw Object.assign(new Error('Un scan est déjà en cours pour cet appareil'), { status: 409 });
    const ports = full ? FULL_PORTS : QUICK_SCAN_PORTS;
    const controller = new AbortController();
    const s = { deviceKey: device.key, ip: device.ipv4, full, nightly, done: 0, total: ports.length, found: [], identifying: false, startedAt: now(), controller };
    this.running.set(device.key, s);
    this.publish(s, true);
    try {
      const open = await this.scanner.scanPorts(device.ipv4, ports, {
        signal: controller.signal,
        onProgress: (done) => { s.done = done; this.publish(s); },
        onOpen: (port) => { s.found = [...s.found, port].sort((a, b) => a - b); this.publish(s, true); },
      });
      const stopped = controller.signal.aborted;
      s.identifying = true;
      this.publish(s, true);
      const identified = [];
      for (let i = 0; i < open.length; i += IDENTIFY_PARALLEL) {
        identified.push(...await Promise.all(open.slice(i, i + IDENTIFY_PARALLEL).map((p) => this.scanner.identify(device.ipv4, p))));
      }
      const previous = this.store.lastPortScan(device.key);
      const result = this.store.addPortScan({ deviceKey: device.key, ts: now(), ip: device.ipv4, full, stopped, nightly, ports: identified });
      const diff = diffScans(previous, result);
      if (nightly && previous && diff.added.length) {
        const list = diff.added.map((p) => `${p} (${identified.find((x) => x.port === p)?.service ?? KNOWN_SERVICES[p]?.name ?? '?'})`).join(', ');
        await this.alert({
          type: 'port_opened',
          deviceKey: device.key,
          message: `${diff.added.length > 1 ? 'Nouveaux ports ouverts' : 'Nouveau port ouvert'} sur ${device.name} : ${list}`,
          tags: ['unlock'],
          priority: 4,
          data: { ports: diff.added, ip: device.ipv4 },
        });
      }
      return { ...result, diff };
    } finally {
      this.running.delete(device.key);
      this.emit('progress', { deviceKey: device.key, running: false });
    }
  }

  /** Démarre un scan sans l'attendre (depuis l'interface). Les erreurs de démarrage sont renvoyées tout de suite. */
  start(device, options) {
    if (!device.ipv4) throw Object.assign(new Error('Adresse IPv4 inconnue : impossible de scanner'), { status: 400 });
    if (this.running.has(device.key)) throw Object.assign(new Error('Un scan est déjà en cours pour cet appareil'), { status: 409 });
    this.run(device, options).catch((e) => this.log.warn(`Scan de ${device.name} : ${e.message}`));
    return this.progress(device.key);
  }

  /** Arrête le test des ports ; les ports déjà trouvés sont quand même identifiés et gardés. */
  stop(key) {
    const s = this.running.get(key);
    if (!s) return false;
    s.controller.abort();
    return true;
  }

  stopAll() {
    for (const s of this.running.values()) s.controller.abort();
  }

  /**
   * Scan de nuit : scan rapide des appareils surveillés en ligne, l'un après l'autre.
   * Alerte si un port s'est ouvert depuis le scan précédent (le premier scan sert de référence).
   */
  async nightly() {
    const devices = this.store.listDevices().filter((d) => d.watched && d.online && d.ipv4);
    for (const device of devices) {
      try {
        await this.run(device, { nightly: true });
      } catch (e) {
        this.log.warn(`Scan de nuit de ${device.name} : ${e.message}`);
      }
    }
    return devices.length;
  }
}
