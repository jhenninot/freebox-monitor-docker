import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { parsePortForward, portForwardWarnings } from '../src/freebox/rules.js';
import { host } from './fake-freebox.js';
import { startHarness } from './harness.js';

const lan = { gateway: '192.168.1.254', netmask: '255.255.255.0' };

test('redirection : validation du formulaire', () => {
  const ok = parsePortForward({ wanStart: '8443', lanIp: '192.168.1.20', comment: ' NPM ' }, lan);
  assert.deepEqual(ok.rule, { ip_proto: 'tcp', wan_port_start: 8443, wan_port_end: 8443, lan_ip: '192.168.1.20', lan_port: 8443, src_ip: '0.0.0.0', comment: 'NPM' });
  const err = (form) => parsePortForward({ lanIp: '192.168.1.20', ...form }, lan).error;
  assert.match(err({ wanStart: '0' }), /Port externe invalide/);
  assert.match(err({ wanStart: '100', wanEnd: '90' }), /supérieur ou égal/);
  assert.match(err({ wanStart: '100', wanEnd: '200', lanPort: '65500' }), /dépasse 65535/);
  assert.match(err({ wanStart: '80', lanIp: '10.0.0.1' }), /réseau local/);
  assert.match(err({ wanStart: '80', srcIp: 'x' }), /source invalide/);
  assert.equal(parsePortForward({ wanStart: 51820, proto: 'udp', lanIp: '192.168.1.20' }, lan).rule.ip_proto, 'udp');
});

test('redirection : avertissements', () => {
  const rule = { id: 0, ip_proto: 'tcp', wan_port_start: 440, wan_port_end: 450, lan_ip: '192.168.1.20', lan_port: 440 };
  const others = [{ id: 3, enabled: true, ip_proto: 'tcp', wan_port_start: 445, wan_port_end: 445, lan_ip: '192.168.1.30', lan_port: 445, comment: 'smb' }];
  const incoming = [{ id: 'https', enabled: true, type: 'tcp', in_port: 443 }];
  const w = portForwardWarnings(rule, others, incoming, new Set(), [1024, 2047]);
  assert.equal(w.length, 4);
  assert.match(w[0], /« Accès distant Freebox OS \(HTTPS\) »/);
  assert.match(w[1], /192\.168\.1\.30:445 \(smb\)/);
  assert.match(w[2], /pas d'IP fixe/);
  assert.match(w[3], /ports 1024 à 2047/);
  assert.deepEqual(portForwardWarnings({ ...rule, wan_port_start: 8000, wan_port_end: 8000 }, others, incoming, new Set(['192.168.1.20']), null), []);
});

let h;
before(async () => {
  h = await startHarness();
  h.box.state.hosts = [
    host('ether-1', 'AA:00:00:00:00:01', 'proxmox', { ip: '192.168.1.20' }),
    // L'appareil depuis lequel on consulte l'interface (les tests appellent depuis 127.0.0.1)
    host('wifi-2', 'AA:00:00:00:00:02', 'mon pc', { ip: '127.0.0.1' }),
  ];
  h.box.state.stations[1] = [{ mac: 'AA:00:00:00:00:03' }];
  await h.collector.pollDevices();
});
after(() => h.close());

test('API redirections : ajout, désactivation, modification, suppression', async () => {
  let r = await h.call('POST', '/api/portfwd', { wanStart: '443', lanIp: '192.168.1.20', comment: 'NPM' });
  assert.equal(r.status, 200);
  assert.equal(r.body.device.name, 'proxmox');
  assert.equal(r.body.warnings.length, 2, 'service HTTPS de la box + pas d\'IP fixe');
  const id = r.body.id;
  r = await h.call('POST', '/api/portfwd', { wanStart: '80', lanIp: '10.0.0.1' });
  assert.equal(r.status, 400);

  r = await h.call('PUT', `/api/portfwd/${id}`, { enabled: false });
  assert.equal(r.body.enabled, false);
  assert.equal(h.box.state.redirs[0].lan_port, 443, 'le reste ne bouge pas');
  r = await h.call('PUT', `/api/portfwd/${id}`, { wanStart: '8443', lanPort: '443', lanIp: '192.168.1.20', comment: 'NPM' });
  assert.equal(r.body.wan_port_start, 8443);

  h.box.state.dmz = { enabled: true, ip: '192.168.1.20' };
  r = await h.call('GET', '/api/portfwd');
  assert.deepEqual(r.body.dmz, { enabled: true, ip: '192.168.1.20', device: { key: 'AA:00:00:00:00:01', name: 'proxmox', online: true } });
  assert.deepEqual(r.body.incoming.map((p) => p.label), ['Accès distant Freebox OS (HTTPS)']);
  assert.equal(r.body.rules.length, 1);
  await h.call('DELETE', `/api/portfwd/${id}`);
  assert.equal(h.box.state.redirs.length, 0);
});

test('API filtrage Wi-Fi : garde-fou de la liste blanche', async () => {
  let r = await h.call('GET', '/api/wifi-filter');
  assert.equal(r.body.mode, 'disabled');
  assert.equal(r.body.viewer.name, 'mon pc');
  assert.deepEqual(r.body.missingForWhitelist.map((d) => [d.mac, d.viewer]), [['AA:00:00:00:00:02', true], ['AA:00:00:00:00:03', false]]);

  r = await h.call('POST', '/api/wifi-filter', { mac: 'aa-00-00-00-00-01', type: 'blacklist', comment: 'proxmox' });
  assert.equal(r.body.entries[0].name, 'proxmox');
  r = await h.call('POST', '/api/wifi-filter', { mac: 'AA:00:00:00:00:01', type: 'whitelist' });
  assert.equal(r.status, 409);

  r = await h.call('PUT', '/api/wifi-filter/mode', { mode: 'whitelist' });
  assert.equal(r.status, 409);
  assert.equal(r.body.missing.length, 2);
  assert.equal(h.box.state.wifiConfig.mac_filter_state, 'disabled');

  r = await h.call('PUT', '/api/wifi-filter/mode', { mode: 'whitelist', addMissing: true });
  assert.equal(r.body.mode, 'whitelist');
  assert.deepEqual(r.body.missingForWhitelist, []);
  assert.equal(r.body.entries.filter((e) => e.type === 'whitelist').length, 2);

  const entry = r.body.entries.find((e) => e.mac === 'AA:00:00:00:00:01');
  r = await h.call('PUT', `/api/wifi-filter/${encodeURIComponent(entry.id)}`, { type: 'whitelist', comment: 'pve' });
  assert.equal(r.body.entries.find((e) => e.mac === 'AA:00:00:00:00:01').type, 'whitelist');
  r = await h.call('DELETE', `/api/wifi-filter/${encodeURIComponent(entry.id)}`);
  assert.equal(r.body.entries.length, 2);
  await h.call('PUT', '/api/wifi-filter/mode', { mode: 'disabled' });
});
