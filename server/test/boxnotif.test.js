import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { baseUrlError, describe } from '../src/boxnotif.js';
import { startHarness } from './harness.js';

test('adresse de ce serveur et textes des notifications', () => {
  assert.equal(baseUrlError('http://192.168.1.20:8086/'), null);
  assert.equal(baseUrlError('https://fbm.mondomaine.fr'), null);
  assert.match(baseUrlError('http://fbm.mondomaine.fr'), /IP locale/);
  assert.match(baseUrlError('ftp://x'), /https/);
  assert.match(baseUrlError(''), /Indique/);
  assert.deepEqual(describe({ payload: { type: 'lan_host', host_id: 'ether-aa:bb:cc:dd:ee:ff' } }),
    { title: 'Nouvel appareil sur le réseau', body: 'Un appareil s\'est connecté pour la première fois (AA:BB:CC:DD:EE:FF).', priority: 4 });
  assert.equal(describe({ title: 'Titre box', payload: { type: 'box_state', event: 'reboot' } }).body, 'La Freebox redémarre');
});

let h;
before(async () => { h = await startHarness(); });
after(() => h.close());

test('inscription du serveur auprès de la box, puis notification reçue', async () => {
  let r = await h.call('GET', '/api/box-notif');
  assert.equal(r.body.supported, true);
  assert.equal(r.body.registered, false);
  assert.deepEqual(r.body.targets.map((t) => [t.name, t.host]), [['Pixel 8', 'https://relais.exemple.fr']]);

  r = await h.call('PUT', '/api/box-notif', { baseUrl: 'http://example.com', subscriptions: ['lan_host'] });
  assert.equal(r.status, 400);
  r = await h.call('PUT', '/api/box-notif', { baseUrl: 'http://127.0.0.1:1/', subscriptions: [] });
  assert.equal(r.status, 400);
  r = await h.call('PUT', '/api/box-notif', { baseUrl: 'http://192.168.1.20:8086/', subscriptions: ['lan_host', 'box_state', 'inconnu'] });
  assert.equal(r.status, 200);
  const target = h.box.state.notifTargets.at(-1);
  assert.deepEqual(target.subscriptions, ['lan_host', 'box_state']);
  assert.match(target.api_url, /^http:\/\/192\.168\.1\.20:8086\/box-notif\/[0-9a-f]{32}$/);
  assert.equal(target.message_type, 'notification');

  // La box appelle le serveur (même chemin que l'adresse donnée)
  const path = new URL(target.api_url).pathname;
  r = await h.call('POST', '/box-notif/mauvais-secret/register', { box_id: 'b', device_id: 'd', token: target.token });
  assert.equal(r.status, 404);
  r = await h.call('POST', `${path}/register`, { box_id: 'b', device_id: 'd', token: 'autre' });
  assert.equal(r.status, 403);
  r = await h.call('POST', `${path}/register`, { box_id: 'b', device_id: target.id, token: target.token });
  assert.equal(r.status, 200);
  r = await h.call('POST', `${path}/send`, { box_id: 'b', devices: [target.id], payload: { type: 'box_state', event: 'pub_up' } });
  assert.deepEqual(r.body, { successIds: [target.id], failureIds: [] });
  assert.equal(h.sent.at(-1).message, 'Freebox : La connexion Internet est rétablie');

  r = await h.call('GET', '/api/box-notif');
  assert.equal(r.body.registered, true);
  assert.equal(r.body.confirmed, true);
  assert.equal(r.body.baseUrl, 'http://192.168.1.20:8086');
  assert.equal(r.body.lastCall.kind, 'send');
  assert.equal((await h.call('GET', '/api/events?limit=1')).body[0].type, 'box_notif');

  // Mise à jour, puis retrait
  await h.call('PUT', '/api/box-notif', { baseUrl: 'https://fbm.mondomaine.fr', subscriptions: ['lan_host'] });
  assert.equal(h.box.state.notifTargets.length, 2);
  assert.match(h.box.state.notifTargets[1].api_url, /^https:\/\/fbm\.mondomaine\.fr\/box-notif\//);
  await h.call('DELETE', '/api/box-notif');
  await h.call('DELETE', '/api/box-notif/targets/phone-1');
  assert.equal(h.box.state.notifTargets.length, 0);
});
