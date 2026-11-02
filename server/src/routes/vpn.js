// Réseau > VPN : serveur VPN de la box (réglages, connexions, utilisateurs, fichiers de configuration)
// et client VPN de la box (la Freebox se connecte elle-même à un VPN extérieur).
import express from 'express';
import {
  clientError, clientState, configFileName, configServers, nextFreeIp, parseWireGuardConf, serverLabel, serverSettingsError,
  serverState, STANDARD, userError, WIREGUARD,
} from '../freebox/vpn.js';
import { HttpError } from './box.js';

const enc = encodeURIComponent;
const list = (v) => (Array.isArray(v) ? v : []);
const CIPHERS = ['blowfish', 'aes128', 'aes256', 'chacha20poly1305'];

export function vpnRouter({ freebox }) {
  const router = express.Router();

  // --- Serveur VPN ---

  const pool = () => freebox.get('vpn/ip_pool/').catch(() => null);

  router.get('/vpn', async (_req, res) => {
    const [servers, connections, users, ipPool] = await Promise.all([
      freebox.get('vpn/'),
      freebox.get('vpn/connection/').catch(() => []),
      freebox.get('vpn/user/').catch(() => []),
      pool(),
    ]);
    const configs = await Promise.all(list(servers).map((s) => freebox.get(`vpn/${enc(s.name)}/config/`).catch(() => null)));
    res.json({
      servers: list(servers).map((s, i) => ({
        id: s.name,
        label: serverLabel(s.name, s.type),
        type: s.type,
        state: s.state,
        stateLabel: serverState(s.state),
        connectionCount: s.connection_count ?? 0,
        config: configs[i],
      })),
      connections: list(connections).map((c) => ({ ...c, serverLabel: serverLabel(c.vpn) })),
      users: list(users).map((u) => ({ ...u, configServers: configServers(u.type).map((id) => ({ id, label: serverLabel(id) })) })),
      pool: ipPool,
      nextFreeIp: ipPool ? nextFreeIp(ipPool) : null,
    });
  });

  // Connexions en cours seulement (page d'accueil)
  router.get('/vpn/connections', async (_req, res) => {
    const connections = await freebox.get('vpn/connection/');
    res.json(list(connections).map((c) => ({ ...c, serverLabel: serverLabel(c.vpn) })));
  });

  router.put('/vpn/servers/:id', async (req, res) => {
    const id = req.params.id;
    const current = await freebox.get(`vpn/${enc(id)}/config/`);
    const b = req.body ?? {};
    const update = {};
    if (typeof b.enabled === 'boolean') update.enabled = b.enabled;
    if (typeof b.enableIpv4 === 'boolean') update.enable_ipv4 = b.enableIpv4;
    if (typeof b.enableIpv6 === 'boolean') update.enable_ipv6 = b.enableIpv6;
    const hasMtu = current.conf_wireguard && b.mtu !== undefined;
    if (b.port !== undefined || hasMtu) {
      const error = serverSettingsError(b.port ?? '', current.min_port, current.max_port, hasMtu ? b.mtu : null);
      if (error) throw new HttpError(400, error);
    }
    if (b.port !== undefined && String(b.port).trim()) update.port = Number(b.port);
    if (hasMtu) update.conf_wireguard = { mtu: Number(b.mtu) };
    if (current.conf_openvpn) {
      const ovpn = {};
      if (CIPHERS.includes(b.cipher)) ovpn.cipher = b.cipher;
      if (typeof b.useTcp === 'boolean') ovpn.use_tcp = b.useTcp;
      if (typeof b.disableFragment === 'boolean') ovpn.disable_fragment = b.disableFragment;
      if (Object.keys(ovpn).length) update.conf_openvpn = ovpn;
    }
    res.json(await freebox.put(`vpn/${enc(id)}/config/`, update));
  });

  router.delete('/vpn/connections/:id', async (req, res) => {
    await freebox.del(`vpn/connection/${enc(req.params.id)}`);
    res.json({ ok: true });
  });

  const userBody = async (b, isNew, login) => {
    const type = b.type === WIREGUARD ? WIREGUARD : STANDARD;
    const ipPool = await pool();
    const takenIps = Object.fromEntries(list(ipPool?.reservations).map((r) => [r.ip, r.login]));
    const password = String(b.password ?? '');
    const ip = String(b.ip ?? '').trim();
    const error = userError({ login, type, password, ip, isNew, pool: ipPool, takenIps });
    if (error) throw new HttpError(400, error);
    const body = { ip_reservation: ip };
    if (isNew) Object.assign(body, { login, type });
    if (password) body.password = password;
    if (type === WIREGUARD) {
      const keepalive = Number.parseInt(b.keepalive, 10);
      body.conf_wireguard = { keepalive: Number.isFinite(keepalive) && keepalive >= 0 ? keepalive : 0, psk: b.psk !== false };
    }
    return body;
  };

  router.post('/vpn/users', async (req, res) => {
    const login = String(req.body?.login ?? '').trim();
    res.json(await freebox.post('vpn/user/', await userBody(req.body ?? {}, true, login)));
  });

  router.put('/vpn/users/:login', async (req, res) => {
    const users = list(await freebox.get('vpn/user/'));
    const user = users.find((u) => u.login === req.params.login);
    if (!user) throw new HttpError(404, 'Utilisateur inconnu');
    res.json(await freebox.put(`vpn/user/${enc(user.login)}`, await userBody({ ...req.body, type: user.type }, false, user.login)));
  });

  router.delete('/vpn/users/:login', async (req, res) => {
    await freebox.del(`vpn/user/${enc(req.params.login)}`);
    res.json({ ok: true });
  });

  // Fichier de configuration. Attention : pour OpenVPN, chaque téléchargement invalide le fichier précédent.
  router.get('/vpn/users/:login/config/:server', async (req, res) => {
    const { login, server } = req.params;
    const text = await freebox.getText(`vpn/download_config/${enc(server)}/${enc(login)}/plain`);
    res.json({ fileName: configFileName(server, login), text });
  });

  // --- Client VPN de la box ---

  // Les clés privées ne quittent pas le serveur
  const hideSecrets = (c) => {
    const wg = c.conf_wireguard ? { ...c.conf_wireguard, local_priv_key: undefined, remote_preshared_key: undefined } : undefined;
    const pptp = c.conf_pptp ? { ...c.conf_pptp, password: undefined } : undefined;
    return { ...c, conf_wireguard: wg, conf_pptp: pptp };
  };

  router.get('/vpn-client', async (_req, res) => {
    const [configs, status] = await Promise.all([freebox.get('vpn_client/config/'), freebox.get('vpn_client/status').catch(() => null)]);
    res.json({
      configs: list(configs).map(hideSecrets),
      status: status ? { ...status, stateLabel: clientState(status.state), errorLabel: clientError(status.last_error) } : null,
    });
  });

  router.get('/vpn-client/log', async (_req, res) => {
    const log = await freebox.get('vpn_client/log').catch(() => '');
    res.json({ log: typeof log === 'string' ? log : JSON.stringify(log, null, 2) });
  });

  /** { description, type: wireguard + text (.conf) | pptp + pptp { remoteHost, username, password } } → corps pour la box. */
  const clientBody = (b, isNew) => {
    const body = {};
    if (typeof b.description === 'string') {
      if (!b.description.trim()) throw new HttpError(400, 'Il faut une description');
      body.description = b.description.trim();
    }
    if (typeof b.active === 'boolean') body.active = b.active;
    if (isNew) {
      if (!body.description) throw new HttpError(400, 'Il faut une description');
      if (!['wireguard', 'pptp'].includes(b.type)) throw new HttpError(400, 'Type de VPN non géré (WireGuard ou PPTP)');
      body.type = b.type;
    }
    if (typeof b.text === 'string' && b.text.trim()) {
      const conf = parseWireGuardConf(b.text);
      if (!conf) throw new HttpError(400, 'Fichier WireGuard incomplet : il faut PrivateKey, PublicKey et Endpoint');
      body.conf_wireguard = conf;
    } else if (isNew && b.type === 'wireguard') {
      throw new HttpError(400, 'Colle le contenu du fichier .conf WireGuard');
    }
    if (b.pptp) {
      const { remoteHost = '', username = '', password = '' } = b.pptp;
      if (isNew && (!remoteHost.trim() || !username.trim() || !password)) throw new HttpError(400, 'Serveur, identifiant et mot de passe sont obligatoires');
      body.conf_pptp = { remote_host: remoteHost.trim(), username: username.trim(), ...(password ? { password } : {}) };
    }
    return body;
  };

  router.post('/vpn-client/configs', async (req, res) => {
    res.json(hideSecrets(await freebox.post('vpn_client/config/', clientBody(req.body ?? {}, true))));
  });

  router.put('/vpn-client/configs/:id', async (req, res) => {
    res.json(hideSecrets(await freebox.put(`vpn_client/config/${enc(req.params.id)}`, clientBody(req.body ?? {}, false))));
  });

  router.delete('/vpn-client/configs/:id', async (req, res) => {
    await freebox.del(`vpn_client/config/${enc(req.params.id)}`);
    res.json({ ok: true });
  });

  return router;
}
