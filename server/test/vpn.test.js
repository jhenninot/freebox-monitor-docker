import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  configFileName, nextFreeIp, parseWireGuardConf, serverSettingsError, splitEndpoint, userError,
} from '../src/freebox/vpn.js';
import { startHarness } from './harness.js';

const pool = { ip_start: '192.168.27.65', ip_end: '192.168.27.94', reservations: [{ login: 'julien', ip: '192.168.27.65' }] };

test('VPN : règles utilisateurs, ports, fichiers', () => {
  const base = { login: 'tel', type: 'wireguard', ip: '192.168.27.66', isNew: true, pool, takenIps: { '192.168.27.65': 'julien' } };
  assert.equal(userError(base), null);
  assert.match(userError({ ...base, login: 'mon tel' }), /lettres, chiffres/);
  assert.match(userError({ ...base, ip: '' }), /IP réservée/);
  assert.match(userError({ ...base, ip: '192.168.27.200' }), /plage du VPN/);
  assert.match(userError({ ...base, ip: '192.168.27.65' }), /réservée pour julien/);
  assert.match(userError({ ...base, type: 'standard', ip: '' }), /mot de passe/);
  assert.match(userError({ ...base, password: 'court' }), /entre 8 et 32/);
  assert.equal(nextFreeIp(pool), '192.168.27.66');
  assert.equal(serverSettingsError('80', 1024, 65535, null), 'Le port doit être entre 1024 et 65535');
  assert.equal(serverSettingsError('51820', 1024, 65535, '1500'), 'Le MTU doit être entre 512 et 1420');
  assert.equal(serverSettingsError('51820', 1024, 65535, '1360'), null);
  assert.equal(configFileName('wireguard', 'julien.henninot@x'), 'fbx-julien.henn.conf');
  assert.equal(configFileName('openvpn_routed', 'a b'), 'freebox-a_b.ovpn');
  assert.deepEqual(splitEndpoint('[2001:db8::1]:51820'), { host: '2001:db8::1', port: 51820 });
  assert.equal(splitEndpoint('vpn.example.com'), null);
});

test('VPN : lecture d\'un fichier WireGuard', () => {
  const conf = `[Interface]
PrivateKey = cHJpdmF0ZQ==   # clé
Address = 10.2.0.2/32, fd00::2
DNS = 10.2.0.1
MTU = 1380
[Peer]
PublicKey = cHVibGlj=
Endpoint = 185.1.2.3:51820
AllowedIPs = 0.0.0.0/0`;
  assert.deepEqual(parseWireGuardConf(conf), {
    remote_addr: '185.1.2.3', remote_port: 51820, remote_public_key: 'cHVibGlj=', remote_preshared_key: '', local_priv_key: 'cHJpdmF0ZQ==',
    local_addr: [{ ip: '10.2.0.2', len: 32 }, { ip: 'fd00::2', len: 128 }], dns: ['10.2.0.1'], mtu: 1380,
  });
  assert.equal(parseWireGuardConf('[Interface]\nPrivateKey = x'), null);
});

let h;
before(async () => { h = await startHarness(); });
after(() => h.close());

test('API serveur VPN : réglages, connexions, utilisateurs, fichier', async () => {
  let r = await h.call('GET', '/api/vpn');
  assert.deepEqual(r.body.servers.map((s) => [s.label, s.stateLabel]), [['WireGuard', 'Démarré'], ['OpenVPN (routé)', 'Arrêté']]);
  assert.equal(r.body.nextFreeIp, '192.168.27.66');
  assert.deepEqual(r.body.users[0].configServers, [{ id: 'wireguard', label: 'WireGuard' }]);

  r = await h.call('PUT', '/api/vpn/servers/wireguard', { mtu: '2000' });
  assert.equal(r.status, 400);
  r = await h.call('PUT', '/api/vpn/servers/wireguard', { port: '51821', mtu: '1400' });
  assert.equal(r.body.port, 51821);
  assert.equal(r.body.conf_wireguard.mtu, 1400);
  r = await h.call('PUT', '/api/vpn/servers/openvpn_routed', { enabled: true, cipher: 'chacha20poly1305', useTcp: true });
  assert.equal(h.box.state.vpnServers[1].state, 'started');
  assert.deepEqual(h.box.state.vpnConfigs.openvpn_routed.conf_openvpn, { cipher: 'chacha20poly1305', use_tcp: true, disable_fragment: false });

  await h.call('DELETE', '/api/vpn/connections/c1');
  assert.equal(h.box.state.vpnConnections.length, 0);

  r = await h.call('POST', '/api/vpn/users', { login: 'tel', type: 'wireguard', ip: '192.168.27.65' });
  assert.equal(r.status, 400);
  r = await h.call('POST', '/api/vpn/users', { login: 'tel', type: 'wireguard', ip: '192.168.27.66', keepalive: '25' });
  assert.equal(r.body.ip_reservation, '192.168.27.66');
  r = await h.call('PUT', '/api/vpn/users/tel', { ip: '192.168.27.67', keepalive: 0 });
  assert.equal(r.body.ip_reservation, '192.168.27.67');
  r = await h.call('GET', '/api/vpn/users/tel/config/wireguard');
  assert.equal(r.body.fileName, 'fbx-tel.conf');
  assert.match(r.body.text, /PrivateKey = cle-tel=/);
  await h.call('DELETE', '/api/vpn/users/tel');
  assert.equal(h.box.state.vpnUsers.length, 1);
});

test('API client VPN : import WireGuard, PPTP, activation, journal', async () => {
  let r = await h.call('POST', '/api/vpn-client/configs', { description: 'Proton', type: 'wireguard', text: '[Interface]\nPrivateKey = x' });
  assert.equal(r.status, 400);
  r = await h.call('POST', '/api/vpn-client/configs', {
    description: 'Proton', type: 'wireguard', text: '[Interface]\nPrivateKey = secret=\nAddress = 10.2.0.2/32\n[Peer]\nPublicKey = pub=\nEndpoint = 1.2.3.4:51820',
  });
  assert.equal(r.body.conf_wireguard.remote_addr, '1.2.3.4');
  assert.equal(r.body.conf_wireguard.local_priv_key, undefined, 'la clé privée n\'est pas renvoyée');
  assert.equal(h.box.state.vpnClientConfigs[0].conf_wireguard.local_priv_key, 'secret=');
  r = await h.call('POST', '/api/vpn-client/configs', { description: 'Bureau', type: 'pptp', pptp: { remoteHost: 'vpn.bureau.fr', username: 'j', password: 'p' } });
  assert.equal(r.body.conf_pptp.remote_host, 'vpn.bureau.fr');
  r = await h.call('PUT', `/api/vpn-client/configs/${r.body.id}`, { active: true });
  assert.equal(r.body.active, true);
  r = await h.call('GET', '/api/vpn-client');
  assert.equal(r.body.configs.length, 2);
  assert.equal(r.body.status.stateLabel, 'Déconnecté');
  assert.equal(r.body.status.errorLabel, null);
  assert.match((await h.call('GET', '/api/vpn-client/log')).body.log, /refusé/);
  await h.call('DELETE', '/api/vpn-client/configs/cfg1');
  assert.equal(h.box.state.vpnClientConfigs.length, 1);
});
