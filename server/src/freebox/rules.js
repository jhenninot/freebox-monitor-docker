// Règles de validation reprises de l'appli Android (domain/Ipv4.kt, LocalDomain.kt, WifiBlocking.kt)

// --- Adresses IPv4 et MAC ---

/** "192.168.1.20" → 3232235796, ou null si l'adresse n'est pas une IPv4 valide. */
export function ipToNumber(ip) {
  const parts = String(ip ?? '').trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

export const isValidIp = (ip) => ipToNumber(ip) !== null;

/** Vrai si ip est dans le même sous-réseau que gateway pour le masque netmask. */
export function sameSubnet(ip, gateway, netmask) {
  const a = ipToNumber(ip);
  const g = ipToNumber(gateway);
  const m = ipToNumber(netmask);
  if (a === null || g === null || m === null) return false;
  // Opérations bit à bit en non signé (>>> 0) : les adresses dépassent 2^31
  return ((a & m) >>> 0) === ((g & m) >>> 0);
}

export const isValidMac = (mac) => /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(String(mac ?? '').trim());

/** Format de la Freebox : "AA:BB:CC:DD:EE:FF". */
export const normalizeMac = (mac) => String(mac ?? '').trim().replace(/-/g, ':').toUpperCase();

/**
 * Vérifie une IP fixe avant de l'envoyer à la box. takenIps : { ip: mac } des IP déjà réservées.
 * Renvoie un message d'erreur, ou null si tout va bien.
 */
export function staticLeaseError({ mac, ip, gateway = '', netmask = '', takenIps = {} }) {
  const cleanIp = String(ip ?? '').trim();
  if (!isValidMac(mac)) return 'Adresse MAC invalide (format AA:BB:CC:DD:EE:FF)';
  if (!isValidIp(cleanIp)) return 'Adresse IP invalide';
  if (cleanIp === gateway) return 'Cette adresse est celle de la Freebox';
  if (gateway && netmask && !sameSubnet(cleanIp, gateway, netmask)) {
    return `L'adresse doit être dans le réseau local (${gateway} / ${netmask})`;
  }
  const owner = takenIps[cleanIp];
  if (owner && normalizeMac(owner) !== normalizeMac(mac)) return 'Cette adresse est déjà réservée pour un autre appareil';
  return null;
}

// --- Noms DNS locaux (API 16) : "proxmox.home.arpa" ---

/** Partie choisie par l'utilisateur : "proxmox" pour "proxmox.home.arpa". */
export function domainPrefix(domainName, localDomain) {
  const name = domainName ?? '';
  const suffix = `.${localDomain}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

/** Nom complet à envoyer à la box, ou "" pour supprimer le nom. */
export function domainFullName(prefix, localDomain) {
  const p = String(prefix ?? '').trim().toLowerCase();
  return p ? `${p}.${localDomain}` : '';
}

/** Règles de la Freebox pour le nom local. Renvoie un message d'erreur, ou null si le nom est valide. */
export function domainPrefixError(prefix, localDomain) {
  const p = String(prefix ?? '').trim().toLowerCase();
  if (!p) return null;
  if (domainFullName(p, localDomain).length > 255) return 'Nom trop long';
  if (!/^[a-z0-9.-]+$/.test(p)) return 'Seuls les lettres sans accent, chiffres, tirets et points sont acceptés';
  if (/^[-.]|[-.]$/.test(p)) return 'Le nom ne peut pas commencer ni finir par un tiret ou un point';
  for (const label of p.split('.')) {
    if (!label) return 'Deux points ne peuvent pas se suivre';
    if (/^\d/.test(label)) return 'Chaque partie du nom doit commencer par une lettre';
    if (label.startsWith('-') || label.endsWith('-')) return 'Un tiret ne peut pas toucher un point';
  }
  return null;
}

/** Proposition de nom à partir du nom de l'appareil : "Serveur Proxmox" → "serveur-proxmox". */
export function suggestDomainPrefix(deviceName) {
  return String(deviceName ?? '')
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[\d-]+/, '');
}

// --- Filtrage MAC du Wi-Fi ---
// La box a un seul mode pour tout le Wi-Fi (mac_filter_state) : disabled, blacklist ou whitelist.

/** blocked, listed_inactive (en liste noire mais filtrage désactivé), not_blocked ou whitelist_mode. */
export function wifiBlockStatus(filterState, entryType) {
  if (filterState === 'whitelist') return 'whitelist_mode';
  if (entryType !== 'blacklist') return 'not_blocked';
  return filterState === 'blacklist' ? 'blocked' : 'listed_inactive';
}

/** Vrai si un appareil n'a pas accès au Wi-Fi avec ce mode (entryType : type de son entrée, ou null). */
export function wifiRefused(mode, entryType) {
  if (mode === 'whitelist') return entryType !== 'whitelist';
  if (mode === 'blacklist') return entryType === 'blacklist';
  return false;
}

/** MAC de needed absentes de la liste blanche : ces appareils perdraient le Wi-Fi en passant en liste blanche. */
export function missingFromWhitelist(whitelist, needed) {
  const listed = new Set(whitelist.map(normalizeMac));
  return [...new Set(needed.map(normalizeMac))].filter((m) => m && !listed.has(m));
}

// --- Redirections de ports (traduction de domain/PortRules.kt) ---

export const ANY_SOURCE = '0.0.0.0';

/** Libellés des ports utilisés par les services de la Freebox (GET fw/incoming/). */
export function incomingPortLabel(id) {
  return {
    http: 'Accès distant Freebox OS (HTTP)',
    https: 'Accès distant Freebox OS (HTTPS)',
    'bittorrent-main': 'BitTorrent',
    'bittorrent-dht': 'BitTorrent (DHT)',
    ftp: 'Serveur FTP',
    'ftp-passive': 'Serveur FTP (mode passif)',
    'openvpn-routed': 'OpenVPN (routé)',
    'openvpn-bridge': 'OpenVPN (bridgé)',
    'ipsec-ikev2': 'VPN IPsec (IKEv2)',
    'ipsec-nat': 'VPN IPsec (NAT)',
    pptp: 'VPN PPTP',
    wireguard: 'VPN WireGuard',
  }[id] ?? id;
}

const portNumber = (v) => {
  const text = String(v ?? '').trim();
  return /^\d+$/.test(text) ? Number(text) : null;
};
const validPort = (n) => n !== null && n >= 1 && n <= 65535;

/**
 * Formulaire de redirection (valeurs texte ou nombres) → { error } ou { rule } prête pour la box.
 * Port de fin et port interne vides = port de début ; IP source vide = toutes.
 */
export function parsePortForward(form = {}, { gateway = '', netmask = '' } = {}) {
  const start = portNumber(form.wanStart);
  const empty = (v) => String(v ?? '').trim() === '';
  const end = empty(form.wanEnd) ? start : portNumber(form.wanEnd);
  const lan = empty(form.lanPort) ? start : portNumber(form.lanPort);
  const lanIp = String(form.lanIp ?? '').trim();
  const srcIp = String(form.srcIp ?? '').trim();
  const proto = form.proto === 'udp' ? 'udp' : 'tcp';
  let error = null;
  if (!validPort(start)) error = 'Port externe invalide (1 à 65535)';
  else if (!validPort(end)) error = 'Port externe de fin invalide';
  else if (end < start) error = 'Le port de fin doit être supérieur ou égal au port de début';
  else if (!validPort(lan)) error = 'Port interne invalide';
  else if (lan + (end - start) > 65535) error = 'La plage de ports internes dépasse 65535';
  else if (!isValidIp(lanIp)) error = 'Adresse IP de destination invalide';
  else if (gateway && netmask && !sameSubnet(lanIp, gateway, netmask)) error = 'L\'IP de destination doit être dans le réseau local';
  else if (srcIp && !isValidIp(srcIp)) error = 'Adresse IP source invalide';
  if (error) return { error };
  return {
    rule: {
      ip_proto: proto,
      wan_port_start: start,
      wan_port_end: end,
      lan_ip: lanIp,
      lan_port: lan,
      src_ip: srcIp || ANY_SOURCE,
      comment: String(form.comment ?? '').trim(),
    },
  };
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart <= bEnd && bStart <= aEnd;

/**
 * Points d'attention sur une redirection (format de la box) : conflit avec un service de la Freebox ou une autre
 * redirection, destination sans IP fixe, ports hors de la plage attribuée quand l'IPv4 est partagée.
 */
export function portForwardWarnings(rule, others, incoming, staticIps, ipv4PortRange) {
  const warnings = [];
  for (const p of incoming) {
    if (p.enabled && p.type === rule.ip_proto && p.in_port >= rule.wan_port_start && p.in_port <= rule.wan_port_end) {
      warnings.push(`Le port ${p.in_port} est aussi utilisé par « ${incomingPortLabel(p.id)} » : la redirection est prioritaire.`);
    }
  }
  for (const o of others) {
    if (o.id === rule.id || !o.enabled || o.ip_proto !== rule.ip_proto) continue;
    if (overlaps(rule.wan_port_start, rule.wan_port_end, o.wan_port_start, o.wan_port_end)) {
      warnings.push(`Chevauche la redirection vers ${o.lan_ip}:${o.lan_port} (${o.comment || o.hostname || 'sans nom'}).`);
    }
  }
  if (rule.lan_ip && !staticIps.has(rule.lan_ip)) {
    warnings.push(`${rule.lan_ip} n'a pas d'IP fixe : la redirection cassera si l'appareil change d'adresse.`);
  }
  if (Array.isArray(ipv4PortRange) && ipv4PortRange.length === 2) {
    const [min, max] = ipv4PortRange;
    if (rule.wan_port_start < min || rule.wan_port_end > max) warnings.push(`Ton IPv4 est partagée : seuls les ports ${min} à ${max} sont utilisables.`);
  }
  return warnings;
}
