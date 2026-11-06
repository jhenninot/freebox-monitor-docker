// Test de débit Internet lancé depuis le serveur avec le client officiel Speedtest by Ookla.
// L'API Freebox n'en propose pas : le conteneur tourne dans le réseau de la box (VM Freebox ou serveur Docker),
// donc le test mesure la connexion de la box. Un seul test à la fois, lancé à la main depuis l'interface.
// Sortie du client : une ligne JSON par étape (-f jsonl), avec la progression (-p yes).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { HttpError } from './routes/box.js';

const now = () => Math.floor(Date.now() / 1000);
// Octets/s (unité du client Ookla) → Mb/s, arrondi au dixième
const mbps = (bytesPerSecond) => Math.round(((Number(bytesPerSecond) || 0) * 8) / 1e5) / 10;
const ms = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);
// Pas plus de 5 mises à jour par seconde vers les navigateurs
const EMIT_EVERY_MS = 200;

const idle = () => ({
  running: false, phase: null, progress: 0, by: null, startedAt: null,
  ping: null, jitter: null, down: null, up: null, server: null, isp: null, busy: null, error: null,
});

export class Speedtest extends EventEmitter {
  /**
   * bin : chemin du client Speedtest (SPEEDTEST_BIN). serverId : serveur imposé (SPEEDTEST_SERVER_ID), sinon le plus proche.
   * busyRates() : débits instantanés de la box en octets/s ({ down, up }) juste avant le test, ou null.
   */
  constructor({ store, bin = 'speedtest', serverId = null, timeoutSeconds = 120, busyRates = async () => null, log = console, spawnImpl = spawn }) {
    super();
    this.store = store;
    this.bin = bin;
    this.serverId = serverId;
    this.timeoutMs = timeoutSeconds * 1000;
    this.busyRates = busyRates;
    this.log = log;
    this.spawn = spawnImpl;
    this.current = idle();
    this.lastEmit = 0;
    this.child = null;
  }

  state() {
    return { ...this.current };
  }

  /** Lance un test. Erreur 409 si un test est déjà en cours. Rend la main tout de suite : la suite arrive par 'progress'. */
  async start(by) {
    if (this.current.running) throw new HttpError(409, `Un test est déjà en cours (lancé par ${this.current.by})`);
    this.current = { ...idle(), running: true, phase: 'start', by, startedAt: now() };
    this.publish(true);
    // Trafic des autres appareils au moment du lancement : explique un résultat plus bas que prévu
    try {
      const rates = await this.busyRates();
      if (rates) this.current.busy = { down: mbps(rates.down), up: mbps(rates.up) };
    } catch {
      // box injoignable : le test peut quand même tourner
    }
    this.run();
    return this.state();
  }

  stop() {
    this.child?.kill('SIGKILL');
  }

  run() {
    const args = ['--accept-license', '--accept-gdpr', '-f', 'jsonl', '-p', 'yes'];
    if (this.serverId) args.push('-s', String(this.serverId));
    let child;
    try {
      child = this.spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.fail(e);
      return;
    }
    this.child = child;
    let result = null;
    let errorMessage = null;
    const timer = setTimeout(() => {
      errorMessage = 'Le test a dépassé 2 minutes et a été arrêté';
      child.kill('SIGKILL');
    }, this.timeoutMs);

    const onLine = (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'result') result = msg;
      else if (msg.type === 'log' && msg.level === 'error') errorMessage ??= String(msg.message || 'Erreur du client Speedtest');
      else this.onProgress(msg);
    };
    readLines(child.stdout, onLine);
    readLines(child.stderr, onLine);

    child.on('error', (e) => {
      clearTimeout(timer);
      this.child = null;
      this.fail(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      this.child = null;
      if (!this.current.running) return; // déjà traité par 'error'
      if (result && code === 0) this.finish(result);
      else this.fail(new Error(errorMessage || `Le client Speedtest s'est arrêté (code ${code})`));
    });
  }

  onProgress(msg) {
    const c = this.current;
    const phase = c.phase;
    if (msg.type === 'testStart') {
      c.phase = 'ping';
      c.server = serverOf(msg.server);
      c.isp = msg.isp ?? null;
    } else if (msg.type === 'ping' && msg.ping) {
      c.phase = 'ping';
      c.ping = ms(msg.ping.latency);
      c.jitter = ms(msg.ping.jitter);
      c.progress = Number(msg.ping.progress) || 0;
    } else if (msg.type === 'download' && msg.download) {
      c.phase = 'download';
      c.down = mbps(msg.download.bandwidth);
      c.progress = Number(msg.download.progress) || 0;
    } else if (msg.type === 'upload' && msg.upload) {
      c.phase = 'upload';
      c.up = mbps(msg.upload.bandwidth);
      c.progress = Number(msg.upload.progress) || 0;
    } else {
      return;
    }
    // Chaque changement d'étape part tout de suite, les progressions au plus 5 fois par seconde
    this.publish(c.phase !== phase);
  }

  finish(r) {
    const entry = this.store.addSpeedtest({
      by: this.current.by,
      ping: ms(r.ping?.latency),
      jitter: ms(r.ping?.jitter),
      down: mbps(r.download?.bandwidth),
      up: mbps(r.upload?.bandwidth),
      packetLoss: Number.isFinite(Number(r.packetLoss)) ? Math.round(Number(r.packetLoss) * 10) / 10 : null,
      server: serverOf(r.server),
      isp: r.isp ?? null,
      url: typeof r.result?.url === 'string' && r.result.url.startsWith('https://') ? r.result.url : null,
      busy: this.current.busy,
    });
    this.log.info?.(`Test de débit : ↓ ${entry.down} Mb/s, ↑ ${entry.up} Mb/s, ping ${entry.ping} ms (${entry.by})`);
    this.current = { ...this.current, ...entry, running: false, phase: 'done', progress: 1, result: entry };
    this.publish(true);
  }

  fail(e) {
    const message = e.code === 'ENOENT'
      ? 'Client Speedtest introuvable dans le conteneur (mettre à jour l\'image)'
      : e.message;
    this.log.warn(`Test de débit en échec : ${message}`);
    this.current = { ...this.current, running: false, phase: 'error', error: message };
    this.publish(true);
  }

  publish(force = false) {
    const t = Date.now();
    if (!force && t - this.lastEmit < EMIT_EVERY_MS) return;
    this.lastEmit = t;
    this.emit('progress', this.state());
  }
}

function serverOf(s) {
  if (!s || typeof s !== 'object') return null;
  return { name: String(s.name ?? ''), location: String(s.location ?? ''), country: String(s.country ?? '') };
}

function readLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) onLine(line);
    }
  });
  stream.on('end', () => { if (buffer.trim()) onLine(buffer.trim()); });
}
