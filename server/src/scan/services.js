// Ports connus, ports du scan rapide, lecture des bannières et comparaison de scans
// (traduction de domain/PortScan.kt de l'appli Android).

const S = (name, web = false, tls = false) => ({ name, web, tls });

/** Ports TCP courants et le service qu'on y trouve d'habitude. */
export const KNOWN_SERVICES = {
  20: S('FTP (données)'), 21: S('FTP'), 22: S('SSH'), 23: S('Telnet'), 25: S('SMTP'), 53: S('DNS'),
  80: S('HTTP', true), 81: S('Nginx Proxy Manager', true), 88: S('Kerberos'), 110: S('POP3'), 111: S('RPC (portmap)'),
  135: S('RPC Windows'), 139: S('NetBIOS'), 143: S('IMAP'), 389: S('LDAP'), 443: S('HTTPS', true, true),
  445: S('Partage Windows (SMB)'), 465: S('SMTP (TLS)'), 515: S('Imprimante (LPD)'), 548: S('Partage Apple (AFP)'),
  554: S('Flux vidéo (RTSP)'), 587: S('SMTP (envoi)'), 631: S('Imprimante (IPP)', true), 636: S('LDAP (TLS)'),
  853: S('DNS sur TLS'), 873: S('rsync'), 993: S('IMAP (TLS)'), 995: S('POP3 (TLS)'), 1080: S('Proxy SOCKS'),
  1194: S('OpenVPN'), 1433: S('SQL Server'), 1400: S('Sonos', true), 1883: S('MQTT'), 1900: S('UPnP'), 2049: S('NFS'),
  2375: S('API Docker'), 2376: S('API Docker (TLS)'), 3000: S('Web', true), 3001: S('Web (Uptime Kuma…)', true),
  3128: S('Proxy HTTP'), 3306: S('MySQL / MariaDB'), 3389: S('Bureau à distance (RDP)'), 4443: S('HTTPS', true, true),
  5000: S('Web', true), 5001: S('HTTPS', true, true), 5432: S('PostgreSQL'), 5900: S('VNC'), 5985: S('WinRM'),
  6052: S('ESPHome', true), 6379: S('Redis'), 6443: S('Kubernetes'), 7000: S('AirPlay'), 7878: S('Radarr', true),
  8000: S('Web', true), 8006: S('Proxmox VE', true, true), 8007: S('Proxmox Backup Server', true, true),
  8008: S('Web / Chromecast', true), 8009: S('Chromecast'), 8080: S('Web', true), 8081: S('Web', true), 8083: S('Web', true),
  8086: S('InfluxDB', true), 8088: S('Web', true), 8096: S('Jellyfin / Emby', true), 8123: S('Home Assistant', true),
  8181: S('Web', true), 8443: S('HTTPS', true, true), 8883: S('MQTT (TLS)'), 8888: S('Web', true), 8989: S('Sonarr', true),
  9000: S('Web (Portainer…)', true), 9001: S('Web', true), 9090: S('Web (Cockpit, Prometheus…)', true),
  9091: S('Transmission', true), 9100: S('Imprimante (RAW)'), 9443: S('HTTPS (Portainer…)', true, true),
  9925: S('Mealie', true), 10000: S('Webmin', true, true), 11211: S('Memcached'), 27017: S('MongoDB'),
  32400: S('Plex', true), 49152: S('UPnP'), 62078: S('Synchro iPhone'),
};

/** Ports du scan rapide : les services connus et quelques ports courants de plus. */
export const QUICK_SCAN_PORTS = [...new Set([
  ...Object.keys(KNOWN_SERVICES).map(Number),
  79, 106, 113, 119, 179, 199, 427, 444, 497, 513, 514, 543, 544, 990, 1025, 1026, 1027, 1110,
  1720, 1723, 2000, 2001, 2121, 2717, 3986, 4899, 5009, 5050, 5051, 5060, 5101, 5190, 5357,
  5555, 5631, 5800, 6000, 6001, 6646, 7070, 8010, 8082, 8084, 8085, 8089, 8090, 8099, 8200,
  8291, 8400, 8500, 8834, 9002, 9080, 9200, 9999, 10443, 49153, 49154, 49155, 49156, 49157,
])].sort((a, b) => a - b);
const QUICK_SET = new Set(QUICK_SCAN_PORTS);

export const MAX_PORT = 65535;

/** Adresse à ouvrir dans le navigateur, null si le port n'est pas un service web. */
export function portUrl(ip, p) {
  if (!p.web) return null;
  const scheme = p.tls ? 'https' : 'http';
  const standard = (p.tls && p.port === 443) || (!p.tls && p.port === 80);
  return standard ? `${scheme}://${ip}/` : `${scheme}://${ip}:${p.port}/`;
}

/**
 * Ports apparus et disparus entre deux scans. Un port n'est dit « fermé » que s'il a bien été testé cette fois-ci
 * (un scan rapide ne dit rien d'un port 12345 trouvé par un scan complet), et jamais après un scan arrêté.
 */
export function diffScans(previous, current) {
  if (!previous || !current || previous.ip !== current.ip) return { added: [], removed: [] };
  const before = new Set(previous.ports.map((p) => p.port));
  const now = new Set(current.ports.map((p) => p.port));
  const added = [...now].filter((p) => !before.has(p));
  const removed = current.stopped ? [] : [...before].filter((p) => !now.has(p) && (current.full || QUICK_SET.has(p)));
  return { added: added.sort((a, b) => a - b), removed: removed.sort((a, b) => a - b) };
}

const MAX_LENGTH = 120;

/** Première ligne lisible, sans caractères de contrôle, raccourcie. */
export function cleanBanner(raw) {
  const line = String(raw).split(/\r?\n/)
    .map((l) => [...l].filter((c) => (c >= ' ' && c <= '~') || c.charCodeAt(0) > 0xa0).join('').trim())
    .find((l) => l);
  if (!line) return null;
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1)}…` : line;
}

/** Bannière d'accueil (FTP, SMTP, POP3, IMAP...) sans le code « 220 » ou « * OK ». */
export function greetingBanner(raw) {
  const line = cleanBanner(raw);
  if (!line) return null;
  return line.replace(/^\d{3}[ -]/, '').replace(/^[*+]\s?OK\s*/i, '').trim() || null;
}

/** Nom du service d'après sa bannière d'accueil, null si on ne le reconnaît pas. */
export function serviceFromGreeting(raw) {
  const text = String(raw).trimStart();
  if (text.startsWith('SSH-')) return 'SSH';
  if (text.startsWith('+OK')) return 'POP3';
  if (text.startsWith('* OK')) return 'IMAP';
  if (text.startsWith('220') && /FTP/i.test(text)) return 'FTP';
  if (text.startsWith('220') && /E?SMTP/i.test(text)) return 'SMTP';
  if (text.startsWith('RFB ')) return 'VNC';
  if (text.startsWith('HTTP/')) return 'HTTP';
  return null;
}

/** Titre d'une page HTML, null s'il n'y en a pas. */
export function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const title = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return title || null;
}

/** Réponse HTTP : en-tête Server, titre de la page, ou adresse de redirection. */
export function httpBanner(response) {
  if (!response.startsWith('HTTP/')) return null;
  let end = response.indexOf('\r\n\r\n');
  if (end < 0) end = response.indexOf('\n\n');
  if (end < 0) end = response.length;
  const headers = response.slice(0, end).split(/\r?\n/);
  const body = response.slice(end);
  const status = Number.parseInt(headers[0].split(' ')[1], 10);
  const header = (name) => {
    const h = headers.slice(1).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    return h ? h.slice(h.indexOf(':') + 1).trim() || null : null;
  };
  const parts = [];
  if (header('Server')) parts.push(header('Server'));
  const title = htmlTitle(body);
  if (title) parts.push(`« ${title} »`);
  if (status >= 300 && status <= 399 && header('Location')) parts.push(`redirige vers ${header('Location')}`);
  if (!parts.length && Number.isFinite(status)) parts.push(`HTTP ${status}`);
  return cleanBanner(parts.join(' · '));
}

/** Message d'accueil MySQL / MariaDB : la version suit l'octet de protocole (10). */
export function mysqlBanner(bytes) {
  if (bytes.length < 6 || bytes[4] !== 10) return null;
  const end = bytes.indexOf(0, 5);
  if (end < 0) return null;
  const version = bytes.subarray(5, end).toString('latin1');
  if (!version || /[^ -~]/.test(version)) return null;
  return /MariaDB/i.test(version) ? `MariaDB ${version}` : `MySQL ${version}`;
}
