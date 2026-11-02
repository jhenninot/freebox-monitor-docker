// Base SQLite (module node:sqlite, sans dépendance native) : schéma, migrations et requêtes
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Chaque migration est appliquée une seule fois, dans l'ordre. Ne jamais modifier une migration déjà publiée :
// en ajouter une nouvelle à la fin.
const MIGRATIONS = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Appareils vus sur le réseau. key = adresse MAC (ou id Freebox à défaut)
  CREATE TABLE devices (
    key         TEXT PRIMARY KEY,
    fbx_id      TEXT NOT NULL,
    name        TEXT NOT NULL,
    mac         TEXT,
    ipv4        TEXT,
    vendor      TEXT,
    host_type   TEXT,
    link        TEXT,
    wifi_band   TEXT,
    online      INTEGER NOT NULL DEFAULT 0,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    watched     INTEGER NOT NULL DEFAULT 0,
    hidden      INTEGER NOT NULL DEFAULT 0,
    raw         TEXT
  );

  -- Périodes de présence : end_ts NULL tant que l'appareil est en ligne
  CREATE TABLE device_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_key  TEXT NOT NULL REFERENCES devices(key) ON DELETE CASCADE,
    start_ts    INTEGER NOT NULL,
    end_ts      INTEGER,
    ipv4        TEXT
  );
  CREATE INDEX device_sessions_device ON device_sessions(device_key, start_ts);

  -- Mesures brutes (débits, températures...) puis leurs moyennes à la minute et à l'heure
  CREATE TABLE metrics (
    ts    INTEGER NOT NULL,
    key   TEXT NOT NULL,
    value REAL NOT NULL
  );
  CREATE INDEX metrics_key_ts ON metrics(key, ts);

  CREATE TABLE metrics_1m (
    ts INTEGER NOT NULL, key TEXT NOT NULL,
    avg REAL NOT NULL, min REAL NOT NULL, max REAL NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY (key, ts)
  ) WITHOUT ROWID;

  CREATE TABLE metrics_1h (
    ts INTEGER NOT NULL, key TEXT NOT NULL,
    avg REAL NOT NULL, min REAL NOT NULL, max REAL NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY (key, ts)
  ) WITHOUT ROWID;

  -- Journal : alertes et changements d'état de la box
  CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    type        TEXT NOT NULL,
    device_key  TEXT,
    message     TEXT NOT NULL,
    data        TEXT
  );
  CREATE INDEX events_ts ON events(ts);
  `,
];

const now = () => Math.floor(Date.now() / 1000);

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return new Store(db);
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < MIGRATIONS.length; i += 1) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Sources des courbes selon la période demandée : on évite d'envoyer des dizaines de milliers de points
const SOURCES = [
  { maxRange: 3 * 3600, table: 'metrics', step: 0 },
  { maxRange: 3 * 86400, table: 'metrics_1m', step: 60 },
  { maxRange: Infinity, table: 'metrics_1h', step: 3600 },
];

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    return transaction(this.db, fn);
  }

  // --- Réglages (clé / valeur JSON) ---

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setSetting(key, value) {
    if (value === null || value === undefined) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    } else {
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, JSON.stringify(value));
    }
  }

  // --- Appareils ---

  listDevices() {
    return this.db.prepare('SELECT * FROM devices ORDER BY online DESC, name COLLATE NOCASE').all().map(deviceRow);
  }

  getDevice(key) {
    const row = this.db.prepare('SELECT * FROM devices WHERE key = ?').get(key);
    return row ? deviceRow(row) : null;
  }

  deviceKeys() {
    return new Set(this.db.prepare('SELECT key FROM devices').all().map((r) => r.key));
  }

  /**
   * Enregistre la liste lue sur la Freebox : met à jour les appareils et ouvre / ferme les sessions de présence.
   * Renvoie les clés des appareils qui viennent d'arriver en ligne et de partir.
   */
  saveDevices(devices, ts = now()) {
    const select = this.db.prepare('SELECT online FROM devices WHERE key = ?');
    const upsert = this.db.prepare(`
      INSERT INTO devices (key, fbx_id, name, mac, ipv4, vendor, host_type, link, wifi_band, online, first_seen, last_seen, raw)
      VALUES (@key, @fbxId, @name, @mac, @ipv4, @vendor, @hostType, @link, @wifiBand, @online, @firstSeen, @lastSeen, @raw)
      ON CONFLICT(key) DO UPDATE SET
        fbx_id = excluded.fbx_id, name = excluded.name, mac = excluded.mac, ipv4 = excluded.ipv4,
        vendor = excluded.vendor, host_type = excluded.host_type, link = excluded.link, wifi_band = excluded.wifi_band,
        online = excluded.online, last_seen = MAX(devices.last_seen, excluded.last_seen),
        first_seen = MIN(devices.first_seen, excluded.first_seen), raw = excluded.raw
    `);
    const openSession = this.db.prepare('INSERT INTO device_sessions (device_key, start_ts, ipv4) VALUES (?, ?, ?)');
    const closeSession = this.db.prepare('UPDATE device_sessions SET end_ts = ? WHERE device_key = ? AND end_ts IS NULL');

    const cameOnline = [];
    const wentOffline = [];
    this.transaction(() => {
      for (const d of devices) {
        const before = select.get(d.key);
        upsert.run({
          key: d.key,
          fbxId: d.id,
          name: d.name,
          mac: d.mac,
          ipv4: d.ipv4[0] ?? null,
          vendor: d.vendor,
          hostType: d.hostType,
          link: d.link,
          wifiBand: d.wifiBand,
          online: d.online ? 1 : 0,
          firstSeen: d.firstActivity || ts,
          lastSeen: d.lastSeen || (d.online ? ts : 0),
          raw: JSON.stringify(d.raw ?? null),
        });
        const wasOnline = before ? before.online === 1 : false;
        if (d.online && !wasOnline) {
          openSession.run(d.key, ts, d.ipv4[0] ?? null);
          cameOnline.push(d.key);
        } else if (!d.online && wasOnline) {
          // Fin de session : dernier signe de vie connu de la box, sinon maintenant
          closeSession.run(d.lastSeen && d.lastSeen <= ts ? d.lastSeen : ts, d.key);
          wentOffline.push(d.key);
        }
      }
    });
    return { cameOnline, wentOffline };
  }

  updateDeviceFlags(key, { watched, hidden }) {
    const fields = [];
    const values = [];
    if (watched !== undefined) { fields.push('watched = ?'); values.push(watched ? 1 : 0); }
    if (hidden !== undefined) { fields.push('hidden = ?'); values.push(hidden ? 1 : 0); }
    if (!fields.length) return this.getDevice(key);
    this.db.prepare(`UPDATE devices SET ${fields.join(', ')} WHERE key = ?`).run(...values, key);
    return this.getDevice(key);
  }

  watchedKeys() {
    return new Set(this.db.prepare('SELECT key FROM devices WHERE watched = 1').all().map((r) => r.key));
  }

  deviceSessions(key, since) {
    return this.db.prepare(`
      SELECT start_ts AS start, end_ts AS end, ipv4 FROM device_sessions
      WHERE device_key = ? AND (end_ts IS NULL OR end_ts >= ?)
      ORDER BY start_ts DESC LIMIT 500
    `).all(key, since).map((r) => ({ start: r.start, end: r.end, ipv4: r.ipv4 }));
  }

  // --- Mesures ---

  addMetrics(values, ts = now()) {
    const insert = this.db.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)');
    this.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (Number.isFinite(value)) insert.run(ts, key, value);
      }
    });
  }

  /**
   * Calcule les moyennes à la minute et à l'heure des dernières heures (opération idempotente,
   * relancée chaque minute), puis supprime ce qui dépasse la durée de conservation.
   */
  rollup(retention, ts = now()) {
    const minuteEnd = ts - (ts % 60);
    const hourEnd = ts - (ts % 3600);
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO metrics_1m (ts, key, avg, min, max, n)
        SELECT ts - (ts % 60), key, AVG(value), MIN(value), MAX(value), COUNT(*)
        FROM metrics WHERE ts >= ? AND ts < ? GROUP BY key, ts - (ts % 60)
      `).run(minuteEnd - 2 * 3600, minuteEnd);
      this.db.prepare(`
        INSERT OR REPLACE INTO metrics_1h (ts, key, avg, min, max, n)
        SELECT ts - (ts % 3600), key, SUM(avg * n) / SUM(n), MIN(min), MAX(max), SUM(n)
        FROM metrics_1m WHERE ts >= ? AND ts < ? GROUP BY key, ts - (ts % 3600)
      `).run(hourEnd - 48 * 3600, hourEnd);
      this.db.prepare('DELETE FROM metrics WHERE ts < ?').run(ts - retention.rawDays * 86400);
      this.db.prepare('DELETE FROM metrics_1m WHERE ts < ?').run(ts - retention.minuteDays * 86400);
      this.db.prepare('DELETE FROM events WHERE ts < ?').run(ts - retention.eventDays * 86400);
    });
  }

  /**
   * Séries pour les courbes : { key: [[ts, avg, min, max], ...] }, au plus ~points valeurs par série.
   * La table source dépend de la période (brut, minute ou heure).
   */
  series(keys, from, to = now(), points = 300) {
    const range = Math.max(1, to - from);
    const source = SOURCES.find((s) => range <= s.maxRange);
    const bucket = Math.max(source.step || 1, Math.ceil(range / points / 10) * 10);
    const sql = source.table === 'metrics'
      ? `SELECT key, ts - (ts % ${bucket}) AS t, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max
         FROM metrics WHERE key = ? AND ts >= ? AND ts <= ? GROUP BY t ORDER BY t`
      : `SELECT key, ts - (ts % ${bucket}) AS t, SUM(avg * n) / SUM(n) AS avg, MIN(min) AS min, MAX(max) AS max
         FROM ${source.table} WHERE key = ? AND ts >= ? AND ts <= ? GROUP BY t ORDER BY t`;
    const stmt = this.db.prepare(sql);
    const result = {};
    for (const key of keys) {
      result[key] = stmt.all(key, from, to).map((r) => [r.t, round(r.avg), round(r.min), round(r.max)]);
    }
    return { from, to, bucket, series: result };
  }

  // --- Journal ---

  addEvent({ type, message, deviceKey = null, data = null }, ts = now()) {
    const info = this.db.prepare('INSERT INTO events (ts, type, device_key, message, data) VALUES (?, ?, ?, ?, ?)')
      .run(ts, type, deviceKey, message, data ? JSON.stringify(data) : null);
    return { id: Number(info.lastInsertRowid), ts, type, deviceKey, message, data };
  }

  listEvents({ limit = 100, before = null, deviceKey = null } = {}) {
    const where = [];
    const values = [];
    if (before) { where.push('id < ?'); values.push(before); }
    if (deviceKey) { where.push('device_key = ?'); values.push(deviceKey); }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...values, Math.min(limit, 500)).map((r) => ({
      id: r.id, ts: r.ts, type: r.type, deviceKey: r.device_key, message: r.message,
      data: r.data ? JSON.parse(r.data) : null,
    }));
  }

  /** Copie cohérente de la base (sauvegarde), même pendant l'écriture. */
  backup(file) {
    fs.rmSync(file, { force: true });
    this.db.prepare('VACUUM INTO ?').run(file);
  }
}

const round = (v) => (v === null ? null : Math.round(v * 100) / 100);

function deviceRow(r) {
  return {
    key: r.key,
    id: r.fbx_id,
    name: r.name,
    mac: r.mac,
    ipv4: r.ipv4,
    vendor: r.vendor,
    hostType: r.host_type,
    link: r.link,
    wifiBand: r.wifi_band,
    online: r.online === 1,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    watched: r.watched === 1,
    hidden: r.hidden === 1,
  };
}
