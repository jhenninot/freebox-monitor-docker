// Fausse Freebox pour les tests : implémente juste ce que le serveur appelle
import express from 'express';
import { hmacSha1Hex } from '../src/security.js';

export function startFakeFreebox(port = 0) {
  const state = {
    appToken: 'app-token-secret',
    challenge: 'challenge-1',
    authStatus: 'pending',
    sessionToken: null,
    connection: { state: 'up', media: 'ftth', ipv4: '82.1.2.3', rate_down: 1000, rate_up: 200, bandwidth_down: 8e9, bandwidth_up: 7e8 },
    system: { firmware_version: '4.9.0', uptime_val: 1000, model_info: { pretty_name: 'Freebox Ultra' }, sensors: [{ id: 'temp_cpu', name: 'CPU', value: 55 }], fans: [{ id: 'fan0', name: 'Ventilateur', value: 1200 }] },
    hosts: [],
    renamed: [],
    wol: [],
    dhcpConfig: { enabled: true, gateway: '192.168.1.254', netmask: '255.255.255.0', ip_range_start: '192.168.1.10', ip_range_end: '192.168.1.50', dns: ['192.168.1.254', ''] },
    staticLeases: [],
    dynamicLeases: [],
    wifiConfig: { enabled: true, mac_filter_state: 'disabled' },
    macFilters: [],
    ftth: { link: true, sfp_present: true, sfp_has_signal: true, sfp_has_power_report: true, sfp_pwr_rx: -1850, sfp_pwr_tx: 420 },
    aps: [{ id: 0 }, { id: 1 }],
    stations: { 0: [], 1: [] },
    switchStatus: [],
    portStats: {},
    redirs: [],
    incoming: [{ id: 'https', enabled: true, type: 'tcp', in_port: 443 }, { id: 'wireguard', enabled: false, type: 'udp', in_port: 51820 }],
    dmz: { enabled: false, ip: '' },
    vpnServers: [{ name: 'wireguard', type: 'wireguard', state: 'started', connection_count: 1 }, { name: 'openvpn_routed', type: 'openvpn', state: 'stopped', connection_count: 0 }],
    vpnConfigs: {
      wireguard: { id: 'wireguard', type: 'wireguard', enabled: true, port: 51820, min_port: 1024, max_port: 65535, conf_wireguard: { mtu: 1360 }, ip_start: '192.168.27.65', ip_end: '192.168.27.94' },
      openvpn_routed: { id: 'openvpn_routed', type: 'openvpn', enabled: false, port: 1194, min_port: 1024, max_port: 65535, enable_ipv4: true, enable_ipv6: false, conf_openvpn: { cipher: 'aes256', use_tcp: false, disable_fragment: false } },
    },
    vpnConnections: [{ id: 'c1', vpn: 'wireguard', user: 'julien', authenticated: true, auth_time: 1700000000, src_ip: '80.1.2.3', src_port: 40000, local_ip: '192.168.27.65', rx_bytes: 1e6, tx_bytes: 5e6 }],
    vpnUsers: [{ login: 'julien', type: 'wireguard', password_set: false, ip_reservation: '192.168.27.65', conf_wireguard: { keepalive: 25, psk: true } }],
    vpnClientConfigs: [],
    repeaters: [],
    repeaterHosts: {},
    notifTargets: [{ id: 'phone-1', name: 'Pixel 8', type: 'android', subscriptions: ['lan_host'], api_url: 'https://relais.exemple.fr/secret', message_type: 'notification', last_use: 1700000000 }],
    vpnClientStatus: { enabled: false, state: 'down', last_error: 'none' },
  };
  let nextRedir = 1;
  const ok = (res, result) => res.json({ success: true, result });
  const app = express();
  app.use(express.json());
  app.get('/api_version', (_req, res) => res.json({ uid: 'box-uid', device_name: 'Freebox Server', box_model_name: 'Freebox Ultra', api_version: '15.0' }));
  const api = express.Router();
  api.post('/login/authorize/', (_req, res) => ok(res, { app_token: state.appToken, track_id: 42 }));
  api.get('/login/authorize/:id', (_req, res) => ok(res, { status: state.authStatus, challenge: state.challenge }));
  api.get('/login/', (_req, res) => ok(res, { logged_in: false, challenge: state.challenge }));
  api.post('/login/session/', (req, res) => {
    if (req.body.password !== hmacSha1Hex(state.appToken, state.challenge)) {
      return res.status(403).json({ success: false, error_code: 'invalid_token', msg: 'Jeton invalide' });
    }
    state.sessionToken = `session-${Date.now()}`;
    ok(res, { session_token: state.sessionToken, permissions: { settings: true } });
  });
  api.use((req, res, next) => {
    if (req.get('X-Fbx-App-Auth') !== state.sessionToken) {
      return res.status(403).json({ success: false, error_code: 'auth_required', msg: 'Authentification requise' });
    }
    next();
  });
  api.get('/connection/', (_req, res) => ok(res, state.connection));
  api.get('/system/', (_req, res) => ok(res, state.system));
  api.get('/connection/ftth/', (_req, res) => ok(res, state.ftth));
  api.get('/wifi/ap/', (_req, res) => ok(res, state.aps));
  api.get('/wifi/ap/:id/stations/', (req, res) => ok(res, state.stations[req.params.id] ?? []));
  api.get('/switch/status/', (_req, res) => ok(res, state.switchStatus));
  api.get('/switch/port/:id/stats', (req, res) => ok(res, state.portStats[req.params.id] ?? {}));
  api.get('/lan/browser/pub/', (_req, res) => ok(res, state.hosts));
  api.put('/lan/browser/pub/:id/', (req, res) => {
    state.renamed.push(req.body);
    const host = state.hosts.find((h) => h.id === req.params.id);
    if (host) {
      const { id, ...changes } = req.body;
      Object.assign(host, changes);
    }
    ok(res, host);
  });
  api.delete('/lan/browser/pub/:id/', (req, res) => {
    state.hosts = state.hosts.filter((h) => h.id !== req.params.id);
    ok(res);
  });
  api.post('/lan/wol/pub/', (req, res) => { state.wol.push(req.body); ok(res); });

  api.get('/dhcp/config/', (_req, res) => ok(res, state.dhcpConfig));
  api.get('/dhcp/static_lease/', (_req, res) => ok(res, state.staticLeases));
  api.get('/dhcp/dynamic_lease/', (_req, res) => ok(res, state.dynamicLeases));
  api.post('/dhcp/static_lease/', (req, res) => {
    const lease = { id: req.body.mac, mac: req.body.mac, ip: req.body.ip, comment: req.body.comment, hostname: '' };
    state.staticLeases.push(lease);
    ok(res, lease);
  });
  api.put('/dhcp/static_lease/:id', (req, res) => {
    const lease = state.staticLeases.find((l) => l.id === req.params.id);
    Object.assign(lease, req.body);
    ok(res, lease);
  });
  api.delete('/dhcp/static_lease/:id', (req, res) => {
    state.staticLeases = state.staticLeases.filter((l) => l.id !== req.params.id);
    ok(res);
  });

  api.get('/fw/redir/', (_req, res) => ok(res, state.redirs));
  api.get('/fw/incoming/', (_req, res) => ok(res, state.incoming));
  api.get('/fw/dmz/', (_req, res) => ok(res, state.dmz));
  api.post('/fw/redir/', (req, res) => {
    const rule = { id: nextRedir++, enabled: true, hostname: '', ...req.body };
    state.redirs.push(rule);
    ok(res, rule);
  });
  api.put('/fw/redir/:id', (req, res) => {
    const rule = state.redirs.find((r) => r.id === Number(req.params.id));
    Object.assign(rule, req.body);
    ok(res, rule);
  });
  api.delete('/fw/redir/:id', (req, res) => {
    state.redirs = state.redirs.filter((r) => r.id !== Number(req.params.id));
    ok(res);
  });
  api.put('/wifi/mac_filter/:id', (req, res) => {
    const entry = state.macFilters.find((f) => f.id === req.params.id);
    Object.assign(entry, req.body);
    ok(res, entry);
  });
  api.get('/vpn/', (_req, res) => ok(res, state.vpnServers));
  api.get('/vpn/connection/', (_req, res) => ok(res, state.vpnConnections));
  api.delete('/vpn/connection/:id', (req, res) => { state.vpnConnections = state.vpnConnections.filter((c) => c.id !== req.params.id); ok(res); });
  api.get('/vpn/user/', (_req, res) => ok(res, state.vpnUsers));
  api.post('/vpn/user/', (req, res) => {
    const { password, ...user } = req.body;
    const created = { password_set: Boolean(password), ...user };
    state.vpnUsers.push(created);
    ok(res, created);
  });
  api.put('/vpn/user/:login', (req, res) => {
    const user = state.vpnUsers.find((u) => u.login === req.params.login);
    const { password, ...changes } = req.body;
    Object.assign(user, changes, password ? { password_set: true } : {});
    ok(res, user);
  });
  api.delete('/vpn/user/:login', (req, res) => { state.vpnUsers = state.vpnUsers.filter((u) => u.login !== req.params.login); ok(res); });
  api.get('/vpn/ip_pool/', (_req, res) => ok(res, { ip_start: '192.168.27.65', ip_end: '192.168.27.94', reservations: state.vpnUsers.filter((u) => u.ip_reservation).map((u) => ({ login: u.login, ip: u.ip_reservation })) }));
  api.get('/vpn/download_config/:server/:login/plain', (req, res) => res.type('text/plain').send(`[Interface]\nPrivateKey = cle-${req.params.login}=\nAddress = 192.168.27.65/32\n\n[Peer]\nPublicKey = serveur=\nEndpoint = 82.1.2.3:51820\n`));
  api.get('/vpn/:id/config/', (req, res) => ok(res, state.vpnConfigs[req.params.id]));
  api.put('/vpn/:id/config/', (req, res) => {
    const c = state.vpnConfigs[req.params.id];
    for (const [k, v] of Object.entries(req.body)) c[k] = v && typeof v === 'object' ? { ...c[k], ...v } : v;
    const server = state.vpnServers.find((s) => s.name === req.params.id);
    if (typeof req.body.enabled === 'boolean') server.state = req.body.enabled ? 'started' : 'stopped';
    ok(res, c);
  });
  api.get('/vpn_client/config/', (_req, res) => ok(res, state.vpnClientConfigs));
  api.post('/vpn_client/config/', (req, res) => {
    const c = { id: `cfg${state.vpnClientConfigs.length + 1}`, active: false, ...req.body };
    state.vpnClientConfigs.push(c);
    ok(res, c);
  });
  api.put('/vpn_client/config/:id', (req, res) => {
    const c = state.vpnClientConfigs.find((x) => x.id === req.params.id);
    if (req.body.active) state.vpnClientConfigs.forEach((x) => { x.active = false; });
    Object.assign(c, req.body);
    ok(res, c);
  });
  api.delete('/vpn_client/config/:id', (req, res) => { state.vpnClientConfigs = state.vpnClientConfigs.filter((x) => x.id !== req.params.id); ok(res); });
  api.get('/vpn_client/status', (_req, res) => ok(res, state.vpnClientStatus));
  api.get('/vpn_client/log', (_req, res) => ok(res, '12:00 connexion\n12:01 refusé'));
  api.get('/repeater/', (_req, res) => ok(res, state.repeaters));
  api.get('/repeater/:id/host/', (req, res) => ok(res, state.repeaterHosts[req.params.id] ?? []));
  api.get('/notif/targets/', (_req, res) => ok(res, state.notifTargets.map(({ token, ...t }) => t)));
  api.post('/notif/targets/', (req, res) => {
    if (!req.body.id) return res.status(400).json({ success: false, error_code: 'invalid_request', msg: 'invalid id' });
    if (state.notifTargets.some((t) => t.api_url === req.body.api_url)) return res.status(400).json({ success: false, error_code: 'exists', msg: 'Erreur de notification' });
    // Comme certaines box : id réécrit, sujets inconnus du modèle ignorés
    const subscriptions = req.body.subscriptions.filter((x) => !state.notifUnsupported?.includes(x));
    state.notifTargets.push({ ...req.body, subscriptions, id: state.notifRewriteId ? `box-${req.body.id}` : req.body.id });
    ok(res);
  });
  api.put('/notif/targets/:id', (req, res) => {
    const subscriptions = req.body.subscriptions.filter((x) => !state.notifUnsupported?.includes(x));
    Object.assign(state.notifTargets.find((t) => t.id === req.params.id), { ...req.body, subscriptions, id: req.params.id });
    ok(res);
  });
  api.delete('/notif/targets/:id', (req, res) => { state.notifTargets = state.notifTargets.filter((t) => t.id !== req.params.id); ok(res); });
  api.get('/wifi/config/', (_req, res) => ok(res, state.wifiConfig));
  api.put('/wifi/config/', (req, res) => { Object.assign(state.wifiConfig, req.body); ok(res, state.wifiConfig); });
  api.get('/wifi/mac_filter/', (_req, res) => ok(res, state.macFilters));
  api.post('/wifi/mac_filter/', (req, res) => {
    const entry = { id: `${req.body.mac}-${req.body.type}`, ...req.body, hostname: '' };
    state.macFilters.push(entry);
    ok(res, entry);
  });
  api.delete('/wifi/mac_filter/:id', (req, res) => {
    state.macFilters = state.macFilters.filter((f) => f.id !== req.params.id);
    ok(res);
  });
  app.use('/api/v15', api);

  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, state, close: () => server.close() });
    });
  });
}

export function host(id, mac, name, { reachable = true, ip = '192.168.1.10', lastSeen = Math.floor(Date.now() / 1000) } = {}) {
  return {
    id,
    primary_name: name,
    host_type: 'workstation',
    vendor_name: 'ACME',
    l2ident: { id: mac, type: 'mac_address' },
    reachable,
    active: reachable,
    last_activity: lastSeen,
    last_time_reachable: lastSeen,
    first_activity: lastSeen - 3600,
    l3connectivities: [{ addr: ip, af: 'ipv4', reachable, active: reachable }],
    access_point: { connectivity_type: 'wifi', wifi_information: { band: '5g' } },
  };
}
