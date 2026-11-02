// Conversion des réponses Freebox en objets simples pour la base et l'interface (cf. Mappers.kt)

/** Clé stable d'un appareil : son adresse MAC, ou l'id Freebox à défaut (même règle que l'appli Android). */
export const deviceKey = (device) => device.mac || device.id;

const WIFI_BANDS = { '2d4g': '2,4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' };

/** Appareil de GET lan/browser/pub/ → appareil normalisé. */
export function toDevice(host) {
  const mac = host.l2ident?.type === 'mac_address' ? host.l2ident.id : null;
  const l3 = Array.isArray(host.l3connectivities) ? host.l3connectivities : [];
  const byReachable = (a, b) => Number(b.reachable) - Number(a.reachable);
  const ipv4 = l3.filter((c) => c.af === 'ipv4').sort(byReachable).map((c) => c.addr);
  const ipv6 = l3.filter((c) => c.af === 'ipv6').sort(byReachable).map((c) => c.addr);
  const names = Array.isArray(host.names) ? host.names : [];
  const lastActivity = Number(host.last_activity) || 0;
  const lastTimeReachable = Number(host.last_time_reachable) || 0;
  const linkType = host.access_point?.connectivity_type;
  const band = host.access_point?.wifi_information?.band;
  const device = {
    id: String(host.id),
    name: host.primary_name || names[0]?.name || mac || String(host.id),
    mac,
    ipv4,
    ipv6,
    vendor: host.vendor_name || null,
    hostType: host.host_type || 'other',
    online: Boolean(host.reachable),
    firstActivity: Number(host.first_activity) || 0,
    lastActivity,
    lastSeen: Math.max(lastActivity, lastTimeReachable),
    link: linkType === 'wifi' ? 'wifi' : linkType === 'ethernet' ? 'ethernet' : null,
    wifiBand: band ? (WIFI_BANDS[band] ?? band) : null,
    raw: host,
  };
  device.key = deviceKey(device);
  return device;
}

/** GET connection/ → état de la connexion Internet. Débits en octets/s, bande passante en bit/s. */
export function toConnection(c) {
  return {
    state: c.state ?? 'unknown',
    media: c.media ?? null,
    type: c.type ?? null,
    ipv4: c.ipv4 ?? null,
    ipv6: c.ipv6 ?? null,
    rateDown: Number(c.rate_down) || 0,
    rateUp: Number(c.rate_up) || 0,
    bandwidthDown: Number(c.bandwidth_down) || 0,
    bandwidthUp: Number(c.bandwidth_up) || 0,
    bytesDown: Number(c.bytes_down) || 0,
    bytesUp: Number(c.bytes_up) || 0,
    ipv4PortRange: Array.isArray(c.ipv4_port_range) ? c.ipv4_port_range : null,
  };
}

/** GET system/ → modèle, firmware, durée depuis le démarrage, capteurs. */
export function toSystem(s) {
  const values = (list) => (Array.isArray(list) ? list : [])
    .filter((v) => v && v.id !== undefined && Number.isFinite(Number(v.value)))
    .map((v) => ({ id: String(v.id), name: v.name || String(v.id), value: Number(v.value) }));
  return {
    model: s.model_info?.pretty_name || s.board_name || null,
    firmware: s.firmware_version || null,
    uptime: Number(s.uptime_val) || 0,
    serial: s.serial || null,
    sensors: values(s.sensors),
    fans: values(s.fans),
  };
}
