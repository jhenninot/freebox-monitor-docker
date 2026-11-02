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
