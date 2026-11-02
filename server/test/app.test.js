import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { Accounts } from '../src/auth.js';
import { Collector } from '../src/collector.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { FreeboxClient } from '../src/freebox/client.js';
import { Secrets } from '../src/security.js';
import { host, startFakeFreebox } from './fake-freebox.js';

const quiet = { info() {}, warn() {}, error() {} };
let box;
let server;
let base;
let cookie = '';
let collector;
let store;
const sent = [];

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json() };
}

before(async () => {
  box = await startFakeFreebox();
  const config = loadConfig({ APP_SECRET: 'secret-de-test-assez-long', ADMIN_PASSWORD: 'motdepasse', FREEBOX_URL: box.url, WEB_DIR: '/inexistant' });
  store = openDatabase(':memory:');
  const secrets = new Secrets(config.appSecret);
  const credentials = {
    load: () => { const v = store.getSetting('freebox.credentials'); return v ? secrets.decrypt(v) : null; },
    save: (v) => store.setSetting('freebox.credentials', secrets.encrypt(v)),
    clear: () => store.setSetting('freebox.credentials', null),
  };
  const freebox = new FreeboxClient({ baseUrl: config.freeboxUrl, credentials, log: quiet });
  const notify = async (n) => { sent.push(n); };
  collector = new Collector({ freebox, store, config, notify, log: quiet });
  // Migration depuis l'ancien mot de passe unique (trop faible : à changer à la première connexion)
  const accounts = new Accounts(store);
  await accounts.bootstrap({ username: config.adminUsername, password: config.adminPassword }, quiet);
  const app = createApp({ config, store, secrets, freebox, collector, accounts, log: quiet });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  box.close();
  store.close();
});

test('l\'API demande une connexion', async () => {
  assert.equal((await call('GET', '/api/devices')).status, 401);
  assert.equal((await call('GET', '/api/auth/me')).body.setupRequired, false);
  assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'faux' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { password: 'motdepasse' })).status, 401);
  const login = await call('POST', '/api/auth/login', { username: 'Admin', password: 'motdepasse' });
  assert.equal(login.status, 200);
  assert.equal(login.body.mustChange, true);
  // Ancien mot de passe trop faible : tout est bloqué tant qu'il n'est pas changé
  assert.equal((await call('GET', '/api/devices')).body.code, 'password_change_required');
  assert.equal((await call('POST', '/api/auth/password', { currentPassword: 'motdepasse', newPassword: 'court' })).status, 400);
  assert.equal((await call('POST', '/api/auth/password', { currentPassword: 'faux', newPassword: 'Nouveau-mot-2026!' })).body.code, 'bad_current_password');
  const changed = await call('POST', '/api/auth/password', { currentPassword: 'motdepasse', newPassword: 'Nouveau-mot-2026!' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.mustChange, false);
  assert.equal((await call('GET', '/api/devices')).status, 200);
  const me = (await call('GET', '/api/auth/me')).body;
  assert.equal(me.authenticated, true);
  assert.equal(me.username, 'admin');
});

test('association, collecte et alertes', async () => {
  assert.equal((await call('GET', '/api/freebox')).body.paired, false);
  const pair = await call('POST', '/api/freebox/pair', {});
  assert.equal(pair.body.boxName, 'Freebox Ultra');
  assert.equal((await call('GET', '/api/freebox/pair')).body.status, 'pending');

  box.state.authStatus = 'granted';
  box.state.hosts = [host('ether-1', 'AA:01', 'proxmox', { ip: '192.168.1.20' })];
  assert.equal((await call('GET', '/api/freebox/pair')).body.status, 'granted');
  const info = (await call('GET', '/api/freebox')).body;
  assert.equal(info.paired, true);
  assert.equal(info.apiMajor, 15);
  // Le jeton n'est jamais stocké en clair
  assert.ok(!JSON.stringify(store.getSetting('freebox.credentials')).includes(box.state.appToken));

  await collector.pollConnection();
  await collector.pollSystem();
  await collector.pollDevices();
  const overview = (await call('GET', '/api/overview')).body;
  assert.equal(overview.connection.rateDown, 1000);
  assert.equal(overview.system.model, 'Freebox Ultra');
  assert.deepEqual(overview.devices, { total: 1, online: 1 });

  // Session expirée côté box : le serveur se reconnecte tout seul
  box.state.sessionToken = 'expiree';
  box.state.hosts.push(host('ether-2', 'AA:02', 'telephone-inconnu', { ip: '192.168.1.50' }));
  await collector.pollDevices();
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Nouvel appareil : telephone-inconnu/);

  // Appareil surveillé qui disparaît depuis plus de 10 minutes
  assert.equal((await call('PATCH', '/api/devices/AA%3A01', { watched: true })).body.watched, true);
  box.state.hosts[0] = host('ether-1', 'AA:01', 'proxmox', { reachable: false, lastSeen: Math.floor(Date.now() / 1000) - 3600 });
  await collector.pollDevices();
  assert.match(sent.at(-1).message, /proxmox est hors ligne/);
  const detail = (await call('GET', '/api/devices/AA%3A01')).body;
  assert.equal(detail.sessions.length, 1);
  assert.ok(detail.sessions[0].end);

  // Coupure Internet
  box.state.connection = { ...box.state.connection, state: 'down' };
  await collector.pollConnection();
  assert.match(sent.at(-1).message, /Connexion Internet perdue/);

  const events = (await call('GET', '/api/events')).body;
  assert.deepEqual(events.map((e) => e.type), ['wan_down', 'device_down', 'new_device']);

  const metrics = (await call('GET', '/api/metrics?range=1h')).body;
  assert.ok(metrics.series['wan.down'].length >= 1);

  const renamed = (await call('PUT', '/api/devices/AA%3A02/name', { name: 'Téléphone de Julien' })).body;
  assert.equal(renamed.name, 'Téléphone de Julien');
});

test('réglages des alertes', async () => {
  const saved = (await call('PUT', '/api/alerts/settings', { offlineMinutes: 5, newDevices: false })).body;
  assert.deepEqual(saved, { newDevices: false, offline: true, offlineMinutes: 5, nightlyScan: true, nightlyScanHour: 3 });
  assert.equal((await call('GET', '/api/alerts/settings')).body.offlineMinutes, 5);
});
