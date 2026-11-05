import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDatabase } from '../src/db.js';
import { toRepeater } from '../src/freebox/mappers.js';
import { duration, evaluateRepeaters, REBOOT_GIVE_UP_SECONDS } from '../src/repeaters.js';
import { startHarness } from './harness.js';

const repeater = (over = {}) => ({
  id: 1, name: 'Répéteur salon', model: 'fbxwmr', firmware_version: '1.2.0', status: 'running', connection: 'connected',
  boot_time: 1000, last_seen: 5000, led_activated: true, main_mac: 'aa:bb:cc:00:00:01', sn: 'SN1', api_ver: '1.0', ...over,
});

test('répéteur : lecture des champs de la box', () => {
  const r = toRepeater(repeater({ boot_time: '2026-11-05T10:00:00Z' }));
  assert.equal(r.key, 'SN1');
  assert.equal(r.mac, 'AA:BB:CC:00:00:01');
  assert.equal(r.firmware, '1.2.0');
  assert.equal(r.online, true);
  assert.equal(r.led, true);
  assert.equal(r.bootTime, Date.parse('2026-11-05T10:00:00Z') / 1000);
  assert.equal(toRepeater({ id: 3, boot_time: 1700000000000 }).bootTime, 1700000000);
  assert.equal(toRepeater({ id: 3 }).key, '3');
  assert.equal(duration(160), '2 min 40 s');
  assert.equal(duration(3900), '1 h 05 min');
});

test('répéteur : déconnexion, retour, échec et redémarrage', () => {
  const settings = { offlineMinutes: 10, repeaters: true };
  const at = (r, state, now) => evaluateRepeaters([toRepeater(r)], { ...state, settings, now });

  // Premier passage : on mémorise sans alerter
  let s = at(repeater(), {}, 5000);
  assert.deepEqual(s.alerts, []);
  // Déconnecté depuis 5 min : rien encore ; 10 min : alerte une seule fois
  s = at(repeater({ connection: 'disconnected', last_seen: 5000 }), s, 5300);
  assert.deepEqual(s.alerts, []);
  s = at(repeater({ connection: 'disconnected', last_seen: 5000 }), s, 5600);
  assert.equal(s.alerts[0].type, 'repeater_down');
  s = at(repeater({ connection: 'disconnected', last_seen: 5000 }), s, 5700);
  assert.deepEqual(s.alerts, []);
  s = at(repeater(), s, 5800);
  assert.equal(s.alerts[0].type, 'repeater_back');
  // Échec de mise à jour
  s = at(repeater({ status: 'update_failure' }), s, 5900);
  assert.equal(s.alerts[0].type, 'repeater_failure');
  assert.match(s.alerts[0].message, /échec de la mise à jour/);
  // Redémarrage non demandé : boot_time qui avance
  s = at(repeater({ boot_time: 5950 }), s, 6000);
  assert.equal(s.alerts[0].type, 'repeater_reboot');
  assert.match(s.alerts[0].message, /a redémarré/);
});

test('répéteur : redémarrage demandé, suivi jusqu\'au retour ou abandon', () => {
  const settings = { offlineMinutes: 1, repeaters: true };
  const at = (r, state, now) => evaluateRepeaters([toRepeater(r)], { ...state, settings, now });
  let s = at(repeater(), {}, 5000);
  s = { ...s, requests: { SN1: { ts: 5000, by: 'julien', sawDown: false } } };
  s = at(repeater({ status: 'rebooting', connection: 'disconnected' }), s, 5100);
  assert.deepEqual(s.alerts, [], 'pas d\'alerte « déconnecté » pendant le redémarrage demandé');
  s = at(repeater({ boot_time: 5120 }), s, 5160);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0].message, /de retour après 2 min 40 s \(redémarrage demandé par julien\)/);
  assert.deepEqual(s.requests, {});

  // Pas de retour : abandon du suivi avec alerte
  s = { ...s, requests: { SN1: { ts: 6000, by: 'julien', sawDown: false } } };
  s = at(repeater({ status: 'rebooting', connection: 'disconnected' }), s, 6000 + REBOOT_GIVE_UP_SECONDS + 1);
  assert.equal(s.alerts[0].type, 'repeater_down');
  assert.match(s.alerts[0].message, /n'est pas revenu/);
});

test('base : historique des firmwares', () => {
  const store = openDatabase(':memory:');
  assert.equal(store.recordFirmware('box', 'Freebox', '4.9.0', 100).previous, null);
  assert.equal(store.recordFirmware('box', 'Freebox', '4.9.0', 200), null);
  assert.equal(store.recordFirmware('box', 'Freebox', '4.9.1', 300).previous, '4.9.0');
  assert.deepEqual(store.listFirmware('box').map((f) => f.version), ['4.9.1', '4.9.0']);
  store.close();
});

let h;
before(async () => {
  h = await startHarness();
  h.box.state.repeaters = [repeater()];
  await h.collector.pollSystem();
  await h.collector.fetchRepeaterHosts();
});
after(() => h.close());

test('page Équipements Free : box et répéteurs', async () => {
  const r = (await h.call('GET', '/api/equipment')).body;
  assert.equal(r.canManage, true);
  assert.equal(r.box.system.firmware, '4.9.0');
  assert.deepEqual(r.box.firmware.map((f) => f.version), ['4.9.0']);
  assert.equal(r.repeaters.items.length, 1);
  assert.equal(r.repeaters.items[0].name, 'Répéteur salon');
  assert.equal(r.repeaters.items[0].firmwareHistory[0].version, '1.2.0');
  assert.deepEqual((await h.call('GET', '/api/overview')).body.repeaters, { total: 1, online: 1 });
});

test('firmware mis à jour : journal et push selon le réglage', async () => {
  h.sent.length = 0;
  h.box.state.system.firmware_version = '4.9.1';
  await h.collector.pollSystem();
  let events = h.store.listEvents({ limit: 5 });
  assert.equal(events[0].type, 'firmware_update');
  assert.match(events[0].message, /Firmware de la Freebox mis à jour : 4\.9\.0 → 4\.9\.1/);
  assert.equal(h.sent.length, 1);

  await h.call('PUT', '/api/alerts/settings', { firmware: false });
  h.box.state.repeaters[0].firmware_version = '1.3.0';
  await h.collector.fetchRepeaterHosts();
  events = h.store.listEvents({ limit: 5 });
  assert.match(events[0].message, /Firmware de Répéteur salon mis à jour : 1\.2\.0 → 1\.3\.0/);
  assert.equal(h.sent.length, 1, 'pas de push');
  await h.call('PUT', '/api/alerts/settings', { firmware: true });
});

test('LED et redémarrage d\'un répéteur', async () => {
  let r = await h.call('PUT', '/api/equipment/repeaters/1/led', { enabled: false });
  assert.equal(r.status, 200);
  assert.equal(h.box.state.repeaters[0].led_activated, false);
  assert.equal(r.body.repeaters.items[0].led, false);

  r = await h.call('POST', '/api/equipment/repeaters/1/reboot', {});
  assert.equal(r.status, 200);
  assert.deepEqual(h.box.state.reboots, ['repeater-1']);
  assert.equal(r.body.repeaters.items[0].rebootRequest.by, 'julien');
  assert.equal(h.store.listEvents({ limit: 1 })[0].type, 'repeater_reboot_request');
  // Double clic : refusé
  r = await h.call('POST', '/api/equipment/repeaters/1/reboot', {});
  assert.equal(r.status, 429);
  assert.equal((await h.call('POST', '/api/equipment/repeaters/9/reboot', {})).status, 404);

  // Retour du répéteur
  Object.assign(h.box.state.repeaters[0], { status: 'running', boot_time: Math.floor(Date.now() / 1000) });
  await h.collector.fetchRepeaterHosts();
  const e = h.store.listEvents({ limit: 1 })[0];
  assert.equal(e.type, 'repeater_reboot');
  assert.match(e.message, /de retour après .*demandé par julien/);
});

test('redémarrage de la Freebox demandé puis constaté', async () => {
  let r = await h.call('POST', '/api/equipment/box/reboot', {});
  assert.equal(r.status, 200);
  assert.ok(h.box.state.reboots.includes('box'));
  assert.equal(r.body.box.rebootRequest.by, 'julien');
  assert.equal(h.store.listEvents({ limit: 1 })[0].type, 'box_reboot_request');
  assert.equal((await h.call('POST', '/api/equipment/box/reboot', {})).status, 429);

  // Serveur redémarré avec la box (VM) : nouveau collecteur, l'heure de démarrage gardée en base suffit
  h.box.state.system.uptime_val = 30;
  h.collector.system = null;
  await h.collector.pollSystem();
  const e = h.store.listEvents({ limit: 1 })[0];
  assert.equal(e.type, 'box_reboot');
  assert.match(e.message, /à la demande de julien, de retour après/);
  assert.equal(h.store.getSetting('box.rebootRequest'), null);
});

test('droit « Modification des réglages » manquant', async () => {
  h.freebox.permissions = { settings: false };
  assert.equal((await h.call('GET', '/api/equipment')).body.canManage, false);
  h.freebox.permissions = { settings: true };
});
