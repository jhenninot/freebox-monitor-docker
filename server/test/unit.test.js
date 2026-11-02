import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanAlertSettings, DEFAULT_ALERT_SETTINGS, evaluateAlerts } from '../src/alerts.js';
import { openDatabase } from '../src/db.js';
import { apiMajorOf } from '../src/freebox/client.js';
import { toDevice, toSystem } from '../src/freebox/mappers.js';
import { hmacSha1Hex, Secrets } from '../src/security.js';
import { host } from './fake-freebox.js';

const dev = (key, online, lastSeen = 0) => ({ key, name: key, online, lastSeen, ipv4: [] });

test('HMAC-SHA1 de la session Freebox', () => {
  assert.equal(hmacSha1Hex('key', 'The quick brown fox jumps over the lazy dog'), 'de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9');
});

test('version d\'API bornée entre 8 et 16', () => {
  assert.equal(apiMajorOf('16.1'), 16);
  assert.equal(apiMajorOf('17.0'), 16);
  assert.equal(apiMajorOf('6.0'), 8);
  assert.equal(apiMajorOf(undefined), 8);
});

test('chiffrement et signature', () => {
  const s = new Secrets('un-secret-de-test-assez-long');
  const enc = s.encrypt({ appToken: 'abc' });
  assert.deepEqual(s.decrypt(enc), { appToken: 'abc' });
  assert.equal(new Secrets('un-autre-secret-de-test').decrypt(enc), null);
  const token = s.sign({ sub: 'admin', exp: 1 });
  assert.deepEqual(s.verify(token), { sub: 'admin', exp: 1 });
  assert.equal(s.verify(`${token}x`), null);
  assert.equal(s.verify('nimporte.quoi'), null);
});

test('conversion d\'un appareil Freebox', () => {
  const d = toDevice(host('ether-aa:bb', 'AA:BB:CC:DD:EE:FF', 'proxmox', { ip: '192.168.1.20', lastSeen: 1000 }));
  assert.equal(d.key, 'AA:BB:CC:DD:EE:FF');
  assert.equal(d.name, 'proxmox');
  assert.deepEqual(d.ipv4, ['192.168.1.20']);
  assert.equal(d.link, 'wifi');
  assert.equal(d.wifiBand, '5 GHz');
  assert.equal(d.lastSeen, 1000);
  const anonymous = toDevice({ id: 'x1', names: [{ name: 'nas.local' }] });
  assert.equal(anonymous.key, 'x1');
  assert.equal(anonymous.name, 'nas.local');
  assert.equal(anonymous.online, false);
});

test('conversion du système ignore les capteurs illisibles', () => {
  const s = toSystem({ sensors: [{ id: 'a', value: 40 }, { id: 'b', value: 'n/a' }], uptime_val: 5 });
  assert.deepEqual(s.sensors, [{ id: 'a', name: 'a', value: 40 }]);
  assert.equal(s.uptime, 5);
});

test('alertes : la première vérification mémorise sans rien signaler', () => {
  const out = evaluateAlerts([dev('a', true), dev('b', false)], DEFAULT_ALERT_SETTINGS, new Set(['b']), null, 1000);
  assert.deepEqual(out.newDevices, []);
  assert.deepEqual(out.memory, { known: ['a', 'b'], down: ['b'], initialized: true });
});

test('alertes : nouvel appareil, hors ligne après le délai, puis retour', () => {
  const settings = { ...DEFAULT_ALERT_SETTINGS, offlineMinutes: 10 };
  const watched = new Set(['a']);
  let memory = { known: ['a'], down: [], initialized: true };

  let out = evaluateAlerts([dev('a', false, 1000), dev('c', true)], settings, watched, memory, 1000 + 5 * 60);
  assert.deepEqual(out.newDevices.map((d) => d.key), ['c']);
  assert.deepEqual(out.wentDown, [], 'pas encore 10 minutes');
  memory = out.memory;

  out = evaluateAlerts([dev('a', false, 1000), dev('c', true)], settings, watched, memory, 1000 + 11 * 60);
  assert.deepEqual(out.newDevices, []);
  assert.deepEqual(out.wentDown.map((d) => d.key), ['a']);
  memory = out.memory;

  out = evaluateAlerts([dev('a', false, 1000)], settings, watched, memory, 1000 + 20 * 60);
  assert.deepEqual(out.wentDown, [], 'pas de répétition');

  out = evaluateAlerts([dev('a', true, 2000)], settings, watched, out.memory, 2000);
  assert.deepEqual(out.cameBack.map((d) => d.key), ['a']);
  assert.deepEqual(out.memory.down, []);
});

test('réglages d\'alertes nettoyés', () => {
  assert.deepEqual(cleanAlertSettings({ offlineMinutes: '0', newDevices: 'oui' }), { ...DEFAULT_ALERT_SETTINGS, offlineMinutes: 1 });
  assert.equal(cleanAlertSettings({ offlineMinutes: 99999 }).offlineMinutes, 1440);
});

test('base : sessions de présence et agrégats', () => {
  const store = openDatabase(':memory:');
  const a = toDevice(host('ether-a', 'AA', 'pc', { lastSeen: 1000 }));
  let r = store.saveDevices([a], 1000);
  assert.deepEqual(r.cameOnline, ['AA']);
  r = store.saveDevices([{ ...a, online: false, lastSeen: 1500 }], 1600);
  assert.deepEqual(r.wentOffline, ['AA']);
  assert.deepEqual(store.deviceSessions('AA', 0), [{ start: 1000, end: 1500, ipv4: '192.168.1.10' }]);
  assert.equal(store.updateDeviceFlags('AA', { watched: true }).watched, true);
  assert.deepEqual([...store.watchedKeys()], ['AA']);

  const base = 1_700_000_000 - (1_700_000_000 % 3600);
  for (let i = 0; i < 120; i += 1) store.addMetrics({ 'wan.down': i }, base + i * 10);
  store.rollup({ rawDays: 7, minuteDays: 90, eventDays: 365 }, base + 2 * 3600);
  const minutes = store.db.prepare('SELECT * FROM metrics_1m WHERE key = ? ORDER BY ts').all('wan.down');
  assert.equal(minutes.length, 20);
  assert.equal(minutes[0].avg, 2.5);
  const hours = store.db.prepare('SELECT * FROM metrics_1h WHERE key = ?').all('wan.down');
  assert.equal(hours.length, 1);
  assert.equal(hours[0].n, 120);
  assert.equal(hours[0].max, 119);

  const raw = store.series(['wan.down'], base, base + 3600);
  assert.ok(raw.series['wan.down'].length > 0);
  const day = store.series(['wan.down'], base, base + 86400);
  assert.equal(day.bucket >= 60, true);
  store.close();
});
