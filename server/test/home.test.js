import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { toFtth } from '../src/freebox/mappers.js';
import { deviceTraffic, rankTraffic } from '../src/freebox/traffic.js';
import { host } from './fake-freebox.js';
import { startHarness } from './harness.js';

const devices = [
  { key: 'AA:00:00:00:00:01', mac: 'AA:00:00:00:00:01', name: 'téléphone' },
  { key: 'AA:00:00:00:00:02', mac: 'AA:00:00:00:00:02', name: 'proxmox' },
];

test('trafic : stations Wi-Fi additionnées, prises Ethernet', () => {
  const stations = [
    { mac: 'aa:00:00:00:00:01', tx_rate: 100, rx_rate: 10, tx_bytes: 1000, rx_bytes: 50 },
    { mac: 'AA:00:00:00:00:01', tx_rate: 20, rx_rate: 5, tx_bytes: 0, rx_bytes: 0 },
    { mac: 'BB:00:00:00:00:09', hostname: 'invité', tx_rate: 1, rx_rate: 1 },
  ];
  const ports = [
    { port: { id: 1, mac_list: [{ mac: 'AA:00:00:00:00:02', hostname: 'pve' }] }, stats: { tx_bytes_rate: 5000, rx_bytes_rate: 300, tx_bytes: 9e9, rx_good_bytes: 1e9 } },
    { port: { id: 2, mac_list: [{ mac: 'CC:00:00:00:00:01' }, { mac: 'CC:00:00:00:00:02', hostname: 'tv' }] }, stats: {} },
  ];
  const items = deviceTraffic(stations, ports, devices);
  const phone = items.find((t) => t.id === 'wifi:AA:00:00:00:00:01');
  assert.deepEqual([phone.name, phone.deviceKey, phone.downRate, phone.upRate, phone.downBytes], ['téléphone', 'AA:00:00:00:00:01', 120, 15, 1000]);
  assert.equal(items.find((t) => t.id === 'wifi:BB:00:00:00:00:09').name, 'invité');
  const pve = items.find((t) => t.id === 'eth:1');
  assert.deepEqual([pve.name, pve.deviceKey, pve.downRate, pve.upBytes], ['proxmox', 'AA:00:00:00:00:02', 5000, 1e9]);
  const shared = items.find((t) => t.id === 'eth:2');
  assert.equal(shared.name, 'Prise Ethernet 2');
  assert.match(shared.detail, /2 appareils : CC:00:00:00:00:01, tv/);
  assert.deepEqual(rankTraffic(items).map((t) => t.id).slice(0, 2), ['eth:1', 'wifi:AA:00:00:00:00:01']);
  assert.equal(rankTraffic(items, 'volume')[0].id, 'eth:1');
});

test('fibre : puissances en dBm', () => {
  assert.deepEqual(toFtth({ link: true, sfp_present: true, sfp_has_signal: true, sfp_has_power_report: true, sfp_pwr_rx: -1850, sfp_pwr_tx: 420 }),
    { sfpPresent: true, signal: true, powerReport: true, rxPower: -18.5, txPower: 4.2 });
  assert.equal(toFtth({ sfp_has_signal: true, link: false }).signal, false);
});

let h;
before(async () => {
  h = await startHarness();
  h.box.state.hosts = [host('wifi-1', 'AA:00:00:00:00:01', 'téléphone'), host('ether-2', 'AA:00:00:00:00:02', 'proxmox')];
  h.box.state.stations[1] = [{ mac: 'AA:00:00:00:00:01', tx_rate: 200, rx_rate: 20, tx_bytes: 5000, rx_bytes: 500 }];
  h.box.state.switchStatus = [{ id: 1, link: 'up', mac_list: [{ mac: 'AA:00:00:00:00:02' }] }, { id: 2, link: 'down', mac_list: [] }];
  h.box.state.portStats[1] = { tx_bytes_rate: 4000, rx_bytes_rate: 100, tx_bytes: 8000, rx_good_bytes: 800 };
  await h.collector.pollDevices();
});
after(() => h.close());

test('API trafic, historique par appareil et fiche', async () => {
  await h.collector.pollTraffic();
  let r = await h.call('GET', '/api/traffic');
  assert.deepEqual(r.body.items.map((t) => t.name), ['proxmox', 'téléphone']);
  r = await h.call('GET', '/api/traffic?sort=volume');
  assert.equal(r.body.sort, 'volume');
  assert.equal(r.body.items[0].name, 'proxmox');
  const key = encodeURIComponent('AA:00:00:00:00:01');
  r = await h.call('GET', `/api/metrics?keys=${encodeURIComponent('dev.AA:00:00:00:00:01.down')}&range=1h`);
  assert.equal(r.body.series['dev.AA:00:00:00:00:01.down'][0][1], 200);
  r = await h.call('GET', `/api/devices/${key}`);
  assert.equal(r.body.traffic.downRate, 200);
});

test('signal fibre et alerte température', async () => {
  await h.collector.pollConnection();
  await h.collector.pollSystem();
  let r = await h.call('GET', '/api/overview');
  assert.deepEqual(r.body.system.ftth, { sfpPresent: true, signal: true, powerReport: true, rxPower: -18.5, txPower: 4.2 });

  h.box.state.system.sensors[0].value = 88;
  await h.collector.pollSystem();
  await h.collector.pollSystem();
  assert.equal(h.sent.filter((n) => /Température élevée/.test(n.message)).length, 1, 'une seule alerte');
  h.box.state.system.sensors[0].value = 82;
  await h.collector.pollSystem();
  assert.ok(!h.sent.some((n) => /normale/.test(n.message)), 'hystérésis de 5 °C');
  h.box.state.system.sensors[0].value = 70;
  await h.collector.pollSystem();
  assert.ok(h.sent.some((n) => /revenue à la normale/.test(n.message)));
  r = await h.call('GET', '/api/events?limit=10');
  const types = (r.body.events ?? r.body).map((e) => e.type);
  assert.ok(types.includes('box_hot') && types.includes('box_cool'));

  h.box.state.connection.media = 'xdsl';
  await h.collector.pollConnection();
  await h.collector.pollSystem();
  assert.equal(h.collector.system.ftth, null);
});

test('répéteur relié en CPL : ses clients Wi-Fi ne sont pas vus en câble', async () => {
  const h2 = await startHarness();
  try {
    const behind = (id, mac, name) => ({ ...host(id, mac, name), access_point: { connectivity_type: 'ethernet', type: 'gateway' } });
    h2.box.state.hosts = [behind('ether-a', 'AA:00:00:00:00:0A', 'tablette'), behind('ether-b', 'AA:00:00:00:00:0B', 'pc bureau')];
    h2.box.state.repeaters = [{ id: 1, name: 'Répéteur salon' }];
    h2.box.state.repeaterHosts[1] = [
      { l2ident: { id: 'aa:00:00:00:00:0a', type: 'mac_address' }, access_point: { connectivity_type: 'wifi', wifi_information: { band: '5g' } } },
    ];
    await h2.collector.pollDevices();
    let list = (await h2.call('GET', '/api/devices')).body;
    const byName = Object.fromEntries(list.map((d) => [d.name, [d.link, d.wifiBand]]));
    assert.deepEqual(byName, { tablette: ['wifi', '5 GHz'], 'pc bureau': ['ethernet', null] });
    const detail = (await h2.call('GET', `/api/devices/${encodeURIComponent('AA:00:00:00:00:0A')}`)).body;
    assert.equal(detail.box.repeater, 'Répéteur salon');

    // Hors ligne et plus listée par le répéteur : garde sa dernière connexion connue
    h2.box.state.hosts[0].reachable = false;
    h2.box.state.repeaterHosts[1] = [];
    await h2.collector.pollDevices();
    list = (await h2.call('GET', '/api/devices')).body;
    assert.equal(list.find((d) => d.name === 'tablette').link, 'wifi');
  } finally {
    h2.close();
  }
});
