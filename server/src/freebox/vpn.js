// Serveur et client VPN de la Freebox : libellés et règles (traduction de domain/Vpn.kt)
import { ipToNumber, isValidIp } from './rules.js';

export const WIREGUARD = 'wireguard';
export const STANDARD = 'standard';

export function serverLabel(name, type = '') {
  return {
    openvpn_routed: 'OpenVPN (routé)', openvpn_bridge: 'OpenVPN (bridgé)', pptp: 'PPTP', ipsec: 'IPsec', wireguard: 'WireGuard',
  }[name] ?? (name || type);
}

export function serverState(state) {
  return { started: 'Démarré', stopped: 'Arrêté', starting: 'Démarrage…', stopping: 'Arrêt…', error: 'En erreur' }[state] ?? state;
}

/** Serveurs pour lesquels la box fournit un fichier de configuration à cet utilisateur. */
export const configServers = (userType) => (userType === WIREGUARD ? ['wireguard'] : ['openvpn_routed', 'openvpn_bridge']);

/** Nom du fichier : l'appli WireGuard en fait le nom du tunnel (15 caractères, lettres, chiffres et _=+.-). */
export function configFileName(server, login) {
  const clean = String(login).replace(/[^A-Za-z0-9_=+.-]/g, '_');
  return server === 'wireguard' ? `${`fbx-${clean}`.slice(0, 15)}.conf` : `freebox-${clean}.ovpn`;
}

const LOGIN = /^[A-Za-z0-9._@-]+$/;

const inRange = (ip, start, end) => {
  const n = ipToNumber(ip);
  const a = ipToNumber(start);
  const b = ipToNumber(end);
  return n !== null && a !== null && b !== null && n >= a && n <= b;
};

/**
 * Formulaire d'un utilisateur VPN. password vide en modification = inchangé.
 * takenIps : { ip: login }. Renvoie un message d'erreur ou null.
 */
export function userError({ login, type, password = '', ip = '', isNew, pool = null, takenIps = {} }) {
  const l = String(login ?? '').trim();
  const address = String(ip ?? '').trim();
  if (!l) return 'Il faut un identifiant';
  if (!LOGIN.test(l)) return 'Identifiant : lettres, chiffres et . _ - @ seulement';
  if (type === STANDARD && isNew && !password) return 'Il faut un mot de passe';
  if (password && (password.length < 8 || password.length > 32)) return 'Le mot de passe doit faire entre 8 et 32 caractères';
  if (type === WIREGUARD && !address) return 'WireGuard a besoin d\'une IP réservée';
  if (address && !isValidIp(address)) return 'Adresse IP invalide';
  if (address && pool?.ip_start && !inRange(address, pool.ip_start, pool.ip_end)) {
    return `L'adresse doit être dans la plage du VPN (${pool.ip_start} – ${pool.ip_end})`;
  }
  if (address && takenIps[address] && takenIps[address] !== l) return `Cette adresse est déjà réservée pour ${takenIps[address]}`;
  return null;
}

/** Première adresse libre de la plage VPN, ou null. */
export function nextFreeIp(pool) {
  const start = ipToNumber(pool?.ip_start);
  const end = ipToNumber(pool?.ip_end);
  if (start === null || end === null) return null;
  const taken = new Set((pool.reservations ?? []).map((r) => ipToNumber(r.ip)));
  for (let n = start; n <= end; n++) {
    if (!taken.has(n)) return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  }
  return null;
}

/** Port et MTU d'un serveur. port : texte ou nombre ; mtu : null si le serveur n'en a pas. */
export function serverSettingsError(port, minPort, maxPort, mtu = null) {
  const text = String(port ?? '').trim();
  const p = /^\d+$/.test(text) ? Number(text) : null;
  if (text && p === null) return 'Port invalide';
  if (p !== null && minPort && maxPort && (p < minPort || p > maxPort)) return `Le port doit être entre ${minPort} et ${maxPort}`;
  if (p !== null && (p < 1 || p > 65535)) return 'Le port doit être entre 1 et 65535';
  if (mtu !== null && mtu !== undefined) {
    const m = Number.parseInt(String(mtu).trim(), 10);
    if (!(m >= 512 && m <= 1420) || !/^\d+$/.test(String(mtu).trim())) return 'Le MTU doit être entre 512 et 1420';
  }
  return null;
}

// --- Client VPN de la box ---

export function clientState(state) {
  return {
    waiting_wan: 'En attente de la connexion Internet', going_up: 'Connexion…', up: 'Connecté', going_down: 'Déconnexion…', down: 'Déconnecté',
  }[state] ?? (state || 'Inconnu');
}

export function clientError(error) {
  if (!error || error === 'none') return null;
  return {
    internal: 'Erreur interne de la box',
    authentication_failed: 'Identifiants refusés',
    auth_failed: 'Identifiants refusés',
    resolv_failed: 'Nom du serveur introuvable',
    connect_timeout: 'Le serveur ne répond pas',
    connect_failed: 'Connexion refusée',
    setup_control_failed: 'Échec de la négociation PPTP',
    setup_call_failed: 'Échec de la négociation PPTP',
    protocol: 'Erreur de protocole',
    remote_terminated: 'Connexion fermée par le serveur',
    remote_disconnect: 'Connexion fermée par le serveur',
  }[error] ?? error;
}

/** « 1.2.3.4:51820 » ou « [2001:db8::1]:51820 » → { host, port }, ou null. */
export function splitEndpoint(endpoint) {
  const e = String(endpoint ?? '').trim();
  let host;
  let port;
  if (e.startsWith('[')) {
    host = e.slice(1, e.indexOf(']'));
    port = e.includes(']:') ? e.slice(e.indexOf(']:') + 2) : '';
  } else {
    const i = e.lastIndexOf(':');
    host = i >= 0 ? e.slice(0, i) : e;
    port = i >= 0 ? e.slice(i + 1) : '';
  }
  const p = /^\d+$/.test(port) ? Number(port) : null;
  if (!host || p === null || p < 1 || p > 65535) return null;
  return { host, port: p };
}

/** « 10.0.0.2/32 » → { ip, len } (32 par défaut en IPv4, 128 en IPv6). */
export function parseCidr(value) {
  const [ip, len] = String(value).split('/').map((x) => x.trim());
  const n = Number.parseInt(len, 10);
  return { ip, len: Number.isFinite(n) ? n : (ip.includes(':') ? 128 : 32) };
}

export const splitList = (value) => String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Fichier .conf WireGuard d'un fournisseur VPN → conf_wireguard du client VPN de la box, ou null s'il manque l'essentiel. */
export function parseWireGuardConf(text) {
  let section = '';
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      section = line.replace(/[[\]]/g, '').toLowerCase();
      continue;
    }
    // Les clés en base64 finissent par « = » : on ne coupe qu'au premier « = »
    const i = line.indexOf('=');
    const key = (i >= 0 ? line.slice(0, i) : line).trim().toLowerCase();
    const value = i >= 0 ? line.slice(i + 1).trim() : '';
    if (key && !(`${section}.${key}` in values)) values[`${section}.${key}`] = value;
  }
  const privateKey = values['interface.privatekey'];
  const publicKey = values['peer.publickey'];
  const endpoint = splitEndpoint(values['peer.endpoint']);
  if (!privateKey || !publicKey || !endpoint) return null;
  const mtu = Number.parseInt(values['interface.mtu'], 10);
  return {
    remote_addr: endpoint.host,
    remote_port: endpoint.port,
    remote_public_key: publicKey,
    remote_preshared_key: values['peer.presharedkey'] ?? '',
    local_priv_key: privateKey,
    local_addr: splitList(values['interface.address']).map(parseCidr),
    dns: splitList(values['interface.dns']),
    ...(Number.isFinite(mtu) ? { mtu } : {}),
  };
}
