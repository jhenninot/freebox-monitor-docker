// Mise en forme des valeurs affichées (cf. domain/Units.kt et TimeFormat.kt de l'appli Android)

/** Débit en octets/s → texte en bit/s (Mb/s, Gb/s), comme Freebox OS. */
export function rate(bytesPerSecond) {
  return bits((bytesPerSecond || 0) * 8);
}

/** Valeur en bit/s → texte. */
export function bits(value) {
  const v = value || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gb/s`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} Mb/s`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} kb/s`;
  return `${Math.round(v)} b/s`;
}

export function bytes(value) {
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = value || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
export function date(ts) {
  return ts ? dateTime.format(new Date(ts * 1000)) : '—';
}

/** « il y a 5 min », « il y a 2 j » */
export function ago(ts) {
  if (!ts) return 'jamais';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return 'à l\'instant';
  return `il y a ${duration(diff)}`;
}

export const MEDIA = { ftth: 'Fibre', xdsl: 'ADSL / VDSL', ethernet: 'Ethernet', backup_4g: 'Secours 4G' };
export const STATE = { up: 'Connectée', down: 'Déconnectée', going_up: 'Connexion…', going_down: 'Déconnexion…' };

export const EVENT_LABELS = {
  new_device: 'Nouvel appareil',
  device_down: 'Hors ligne',
  device_back: 'De retour',
  wan_down: 'Coupure Internet',
  wan_up: 'Internet rétabli',
  ip_change: 'Changement d\'IP',
  box_reboot: 'Redémarrage',
  box_hot: 'Surchauffe',
  box_cool: 'Température normale',
  port_opened: 'Port ouvert',
  box_notif: 'Notification box',
  box_reboot_request: 'Redémarrage demandé',
  firmware_update: 'Firmware',
  repeater_down: 'Répéteur déconnecté',
  repeater_back: 'Répéteur reconnecté',
  repeater_failure: 'Répéteur en échec',
  repeater_reboot: 'Redémarrage répéteur',
  repeater_reboot_request: 'Redémarrage demandé',
};

export const HOST_TYPES = {
  workstation: 'Ordinateur fixe', laptop: 'Ordinateur portable', smartphone: 'Smartphone', tablet: 'Tablette',
  printer: 'Imprimante', vg_console: 'Console de jeux', television: 'Télévision', nas: 'NAS', ip_camera: 'Caméra IP',
  ip_phone: 'Téléphone IP', freebox_player: 'Freebox Player', freebox_hd: 'Freebox HD', freebox_crystal: 'Freebox Crystal',
  freebox_mini: 'Freebox Mini 4K', freebox_delta: 'Freebox Delta', freebox_one: 'Freebox One', freebox_wifi: 'Répéteur Wi-Fi Freebox',
  freebox_pop: 'Freebox Pop', networking_device: 'Équipement réseau', multimedia_device: 'Appareil multimédia', car: 'Voiture',
  watch: 'Montre connectée', light: 'Éclairage', outlet: 'Prise connectée', appliances: 'Électroménager', thermostat: 'Thermostat',
  shutter: 'Volet électrique', other: 'Autre',
};
