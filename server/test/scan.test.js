import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { identify, scanPorts } from '../src/scan/scanner.js';
import {
  diffScans, greetingBanner, httpBanner, mysqlBanner, portUrl, QUICK_SCAN_PORTS, serviceFromGreeting,
} from '../src/scan/services.js';
import { host } from './fake-freebox.js';
import { startHarness } from './harness.js';

test('bannières et services', () => {
  assert.equal(serviceFromGreeting('SSH-2.0-OpenSSH_9.2p1 Debian\r\n'), 'SSH');
  assert.equal(serviceFromGreeting('220 ProFTPD Server ready'), 'FTP');
  assert.equal(greetingBanner('220 mail.example ESMTP Postfix\r\n'), 'mail.example ESMTP Postfix');
  assert.equal(greetingBanner('* OK Dovecot ready.'), 'Dovecot ready.');
  assert.equal(httpBanner('HTTP/1.1 200 OK\r\nServer: nginx\r\n\r\n<html><title>Proxmox &amp; co</title>'), 'nginx · « Proxmox & co »');
  assert.equal(httpBanner('HTTP/1.1 302 Found\r\nLocation: /login\r\n\r\n'), 'redirige vers /login');
  assert.equal(httpBanner('HTTP/1.1 404 Not Found\r\n\r\n'), 'HTTP 404');
  const greeting = Buffer.concat([Buffer.from([0x4a, 0, 0, 0, 10]), Buffer.from('10.11.6-MariaDB\0rest', 'latin1')]);
  assert.equal(mysqlBanner(greeting), 'MariaDB 10.11.6-MariaDB');
  assert.equal(portUrl('192.168.1.2', { port: 8006, web: true, tls: true }), 'https://192.168.1.2:8006/');
  assert.equal(portUrl('192.168.1.2', { port: 80, web: true, tls: false }), 'http://192.168.1.2/');
  assert.equal(portUrl('192.168.1.2', { port: 22, web: false }), null);
});

test('comparaison de scans', () => {
  const scan = (ports, extra = {}) => ({ ip: '1.2.3.4', full: false, stopped: false, ports: ports.map((port) => ({ port })), ...extra });
  assert.deepEqual(diffScans(scan([22, 80, 12345]), scan([22, 443])), { added: [443], removed: [80] }, '12345 non testé en scan rapide');
  assert.deepEqual(diffScans(scan([22, 12345]), scan([22], { full: true })), { added: [], removed: [12345] });
  assert.deepEqual(diffScans(scan([22, 80]), scan([22], { stopped: true })), { added: [], removed: [] });
  assert.deepEqual(diffScans(scan([22]), { ...scan([80]), ip: '5.6.7.8' }), { added: [], removed: [] });
  assert.ok(QUICK_SCAN_PORTS.includes(8123) && QUICK_SCAN_PORTS.includes(9999));
});

// Vrais services locaux : un serveur web et un service qui se présente (comme SSH)
let web;
let ssh;
let closedPort;
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
before(async () => {
  web = http.createServer((_req, res) => { res.setHeader('Server', 'test-web'); res.end('<title>Ma page</title>'); });
  ssh = net.createServer((socket) => { socket.on('error', () => {}); socket.end('SSH-2.0-OpenSSH_9.2\r\n'); });
  const tmp = net.createServer();
  closedPort = await listen(tmp);
  tmp.close();
  web.port = await listen(web);
  ssh.port = await listen(ssh);
});
after(() => { web.close(); ssh.close(); });

test('scanner réel sur 127.0.0.1', async () => {
  const progress = [];
  const open = await scanPorts('127.0.0.1', [closedPort, web.port, ssh.port], { onProgress: (d) => progress.push(d) });
  assert.deepEqual(open, [web.port, ssh.port].sort((a, b) => a - b));
  assert.equal(progress.at(-1), 3);
  const w = await identify('127.0.0.1', web.port);
  assert.deepEqual([w.service, w.banner, w.web, w.tls], ['HTTP', 'test-web · « Ma page »', true, false]);
  const s = await identify('127.0.0.1', ssh.port);
  assert.deepEqual([s.service, s.banner], ['SSH', 'SSH-2.0-OpenSSH_9.2']);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await scanPorts('127.0.0.1', [web.port], { signal: controller.signal }), []);
});

test('API de scan, comparaison et alerte de nuit', async () => {
  const h = await startHarness();
  try {
    // Faux scanner : les ports ouverts changent d'un scan à l'autre
    let openPorts = [22, 80];
    h.collector.scans.scanner = {
      scanPorts: async (_ip, ports, { onProgress }) => { onProgress(ports.length); return openPorts.filter((p) => ports.includes(p)); },
      identify: async (_ip, port) => ({ port, service: port === 22 ? 'SSH' : 'HTTP', banner: null, web: port !== 22, tls: false }),
    };
    h.box.state.hosts = [host('ether-1', 'AA:00:00:00:00:01', 'proxmox', { ip: '192.168.1.20' })];
    await h.collector.pollDevices();
    const key = encodeURIComponent('AA:00:00:00:00:01');

    let r = await h.call('POST', `/api/devices/${key}/scan`, { full: false });
    assert.equal(r.status, 202);
    assert.equal(r.body.total, QUICK_SCAN_PORTS.length);
    await new Promise((resolve) => setTimeout(resolve, 50));
    r = await h.call('GET', `/api/devices/${key}/scan`);
    assert.equal(r.body.running, null);
    assert.deepEqual(r.body.last.ports.map((p) => [p.port, p.url]), [[22, null], [80, 'http://192.168.1.20/']]);

    // Scan de nuit : appareil surveillé, un port s'ouvre
    await h.call('PATCH', `/api/devices/${key}`, { watched: true });
    openPorts = [22, 8123];
    await h.collector.nightlyScanDue(new Date(2026, 10, 3, 3, 0));
    assert.equal(await h.collector.nightlyScanDue(new Date(2026, 10, 3, 3, 30)), false, 'une fois par nuit');
    assert.match(h.sent.at(-1).message, /Nouveau port ouvert sur proxmox : 8123 \(HTTP\)/);
    r = await h.call('GET', `/api/devices/${key}/scan`);
    assert.deepEqual(r.body.diff, { added: [8123], removed: [80] });
    assert.equal(r.body.history.length, 2);
    assert.equal(r.body.last.nightly, true);

    r = await h.call('PUT', '/api/alerts/settings', { nightlyScan: false, nightlyScanHour: 4 });
    assert.equal(r.body.nightlyScanHour, 4);
    assert.equal(await h.collector.nightlyScanDue(new Date(2026, 10, 4, 4, 0)), false, 'désactivé');

    // Oublier l'appareil efface ses scans
    await h.call('DELETE', `/api/devices/${key}`);
    assert.equal(h.store.listPortScans('AA:00:00:00:00:01').length, 0);
  } finally {
    h.close();
  }
});
