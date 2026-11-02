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
  };
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
