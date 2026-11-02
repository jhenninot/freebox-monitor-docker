import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  domainPrefixError, missingFromWhitelist, sameSubnet, staticLeaseError, suggestDomainPrefix, wifiBlockStatus,
} from '../src/freebox/rules.js';
import { host } from './fake-freebox.js';
import { startHarness } from './harness.js';

test('règles : sous-réseau et IP fixe', () => {
  assert.ok(sameSubnet('192.168.1.20', '192.168.1.254', '255.255.255.0'));
  assert.ok(!sameSubnet('192.168.2.20', '192.168.1.254', '255.255.255.0'));
  const base = { gateway: '192.168.1.254', netmask: '255.255.255.0', takenIps: { '192.168.1.30': 'AA:00:00:00:00:02' } };
  assert.equal(staticLeaseError({ ...base, mac: 'aa-00-00-00-00-01', ip: '192.168.1.20' }), null);
  assert.match(staticLeaseError({ ...base, mac: 'zz', ip: '192.168.1.20' }), /MAC invalide/);
  assert.match(staticLeaseError({ ...base, mac: 'AA:00:00:00:00:01', ip: '192.168.1.254' }), /celle de la Freebox/);
  assert.match(staticLeaseError({ ...base, mac: 'AA:00:00:00:00:01', ip: '10.0.0.2' }), /réseau local/);
  assert.match(staticLeaseError({ ...base, mac: 'AA:00:00:00:00:01', ip: '192.168.1.30' }), /déjà réservée/);
  assert.equal(staticLeaseError({ ...base, mac: 'aa:00:00:00:00:02', ip: '192.168.1.30' }), null, 'sa propre IP');
});

test('règles : nom local et Wi-Fi', () => {
  assert.equal(domainPrefixError('proxmox', 'home.arpa'), null);
  assert.equal(domainPrefixError('', 'home.arpa'), null);
  assert.match(domainPrefixError('mon pc', 'home.arpa'), /lettres sans accent/);
  assert.match(domainPrefixError('-pc', 'home.arpa'), /commencer ni finir/);
  assert.match(domainPrefixError('a..b', 'home.arpa'), /Deux points/);
  assert.match(domainPrefixError('1pc', 'home.arpa'), /commencer par une lettre/);
  assert.equal(suggestDomainPrefix('Serveur Proxmox Élysée'), 'serveur-proxmox-elysee');
  assert.equal(wifiBlockStatus('blacklist', 'blacklist'), 'blocked');
  assert.equal(wifiBlockStatus('disabled', 'blacklist'), 'listed_inactive');
  assert.equal(wifiBlockStatus('whitelist', null), 'whitelist_mode');
  assert.equal(wifiBlockStatus('blacklist', null), 'not_blocked');
  assert.deepEqual(missingFromWhitelist(['aa:bb:cc:dd:ee:ff'], ['AA-BB-CC-DD-EE-FF', '11:22:33:44:55:66', '11:22:33:44:55:66']), ['11:22:33:44:55:66']);
});

let h;
const KEY = encodeURIComponent('AA:00:00:00:00:01');

before(async () => {
  h = await startHarness();
  h.box.state.hosts = [
    { ...host('ether-1', 'AA:00:00:00:00:01', 'proxmox', { ip: '192.168.1.20' }), local_domain: 'home.arpa', domain_name: '', names: [{ name: 'pve', source: 'dhcp' }], info: { upnp: { modelName: 'PVE', empty: '' } } },
    host('ether-2', 'AA:00:00:00:00:02', 'nas', { ip: '192.168.1.30' }),
  ];
  h.box.state.dynamicLeases = [{ mac: 'AA:00:00:00:00:02', ip: '192.168.1.30', hostname: 'nas', is_static: false, lease_remaining: 3600 }];
  await h.collector.pollDevices();
});
after(() => h.close());

test('fiche appareil : infos de la box', async () => {
  const d = (await h.call('GET', `/api/devices/${KEY}`)).body;
  assert.equal(d.box.localDomain, 'home.arpa');
  assert.equal(d.box.domainName, '');
  assert.deepEqual(d.box.otherNames, [{ name: 'pve', source: 'dhcp' }]);
  assert.deepEqual(d.box.info, [{ source: 'upnp', entries: [['modelName', 'PVE']] }]);
  assert.equal(d.lease, null);
});

test('type, nom local, Wake-on-LAN', async () => {
  let r = await h.call('PATCH', `/api/devices/${KEY}/box`, { hostType: 'nas', domainPrefix: 'Proxmox' });
  assert.equal(r.status, 200);
  assert.equal(r.body.hostType, 'nas');
  assert.equal(h.box.state.hosts[0].domain_name, 'proxmox.home.arpa');
  r = await h.call('PATCH', `/api/devices/${KEY}/box`, { domainPrefix: 'mon pc' });
  assert.equal(r.status, 400);
  r = await h.call('POST', `/api/devices/${KEY}/wol`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(h.box.state.wol, [{ mac: 'AA:00:00:00:00:01', password: '' }]);
});

test('IP fixe : création, conflit, rappel, suppression', async () => {
  let dhcp = (await h.call('GET', '/api/dhcp')).body;
  assert.equal(dhcp.config.gateway, '192.168.1.254');
  assert.deepEqual(dhcp.config.dns, ['192.168.1.254']);
  assert.equal(dhcp.dynamicLeases[0].device.name, 'nas');

  await h.call('PATCH', `/api/devices/${KEY}`, { watched: true });
  dhcp = (await h.call('GET', '/api/dhcp')).body;
  assert.deepEqual(dhcp.watchedWithoutLease.map((d) => d.name), ['proxmox']);

  let r = await h.call('POST', '/api/dhcp/leases', { mac: 'aa:00:00:00:00:01', ip: '192.168.1.20', comment: 'Proxmox' });
  assert.equal(r.status, 200);
  r = await h.call('POST', '/api/dhcp/leases', { mac: 'AA:00:00:00:00:02', ip: '192.168.1.20' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /déjà réservée/);

  const list = (await h.call('GET', '/api/devices')).body;
  assert.equal(list.find((d) => d.name === 'proxmox').fixedIp, true);
  assert.equal((await h.call('GET', `/api/devices/${KEY}`)).body.lease.ip, '192.168.1.20');
  dhcp = (await h.call('GET', '/api/dhcp')).body;
  assert.deepEqual(dhcp.watchedWithoutLease, []);

  r = await h.call('PUT', `/api/dhcp/leases/${KEY}`, { ip: '192.168.1.21', comment: 'pve' });
  assert.equal(r.body.ip, '192.168.1.21');
  await h.call('DELETE', `/api/dhcp/leases/${KEY}`);
  assert.equal((await h.call('GET', '/api/dhcp')).body.staticLeases.length, 0);
});

test('blocage Wi-Fi : active la liste noire, puis débloque', async () => {
  let r = await h.call('GET', `/api/devices/${KEY}/wifi`);
  assert.equal(r.body.status, 'not_blocked');
  r = await h.call('PUT', `/api/devices/${KEY}/wifi`, { blocked: true });
  assert.equal(r.body.status, 'blocked');
  assert.equal(h.box.state.wifiConfig.mac_filter_state, 'blacklist');
  r = await h.call('PUT', `/api/devices/${KEY}/wifi`, { blocked: false });
  assert.equal(r.body.status, 'not_blocked');
  assert.equal(h.box.state.wifiConfig.mac_filter_state, 'blacklist', 'le mode ne change pas');

  h.box.state.wifiConfig.mac_filter_state = 'whitelist';
  r = await h.call('PUT', `/api/devices/${KEY}/wifi`, { blocked: true });
  assert.equal(r.status, 409);
  h.box.state.wifiConfig.mac_filter_state = 'disabled';
});

test('oublier un appareil', async () => {
  const r = await h.call('DELETE', `/api/devices/${encodeURIComponent('AA:00:00:00:00:02')}`);
  assert.equal(r.status, 200);
  assert.equal(h.box.state.hosts.length, 1);
  assert.equal((await h.call('GET', `/api/devices/${encodeURIComponent('AA:00:00:00:00:02')}`)).status, 404);
});
