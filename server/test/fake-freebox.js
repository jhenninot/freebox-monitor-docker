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
    if (host) host.primary_name = req.body.primary_name;
    ok(res, host);
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
