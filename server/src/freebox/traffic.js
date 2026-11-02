// Trafic par appareil (traduction de domain/Bandwidth.kt).
//
// La Freebox ne donne pas de compteur par appareil dans lan/browser. On combine donc :
// - les stations Wi-Fi (wifi/ap/{id}/stations/) : débit et volume par appareil depuis son association ;
// - les prises Ethernet (switch/port/{id}/stats) : débit et volume par prise depuis le démarrage de la box.
//   Plusieurs appareils derrière une même prise (switch, CPL...) ne peuvent pas être départagés.
// Débits en octets/s, volumes en octets, vus depuis l'appareil (down = ce qu'il reçoit).
import { normalizeMac } from './rules.js';

const pos = (n) => Math.max(0, Number(n) || 0);

/** devices : appareils de la base (key, name, mac) pour retrouver les noms et ouvrir les fiches. */
export function deviceTraffic(stations, ports, devices) {
  const byMac = new Map(devices.filter((d) => d.mac).map((d) => [normalizeMac(d.mac), d]));

  // Un appareil vu à la fois par la box et par un répéteur : on garde la mesure de la box
  const direct = new Set(stations.filter((s) => s?.mac && !s._repeater).map((s) => normalizeMac(s.mac)));
  stations = stations.filter((s) => !s?._repeater || !direct.has(normalizeMac(s.mac)));

  // Un même appareil peut apparaître sur deux radios (2,4 et 5 GHz) : on additionne
  const groups = new Map();
  for (const s of stations) {
    if (!s?.mac) continue;
    const mac = normalizeMac(s.mac);
    groups.set(mac, [...(groups.get(mac) ?? []), s]);
  }
  const sum = (list, field) => list.reduce((acc, s) => acc + pos(s[field]), 0);
  const wifi = [...groups].map(([mac, list]) => {
    const device = byMac.get(mac);
    const repeater = list.find((s) => s._repeater)?._repeater;
    return {
      id: `wifi:${mac}`,
      name: device?.name ?? list.find((s) => s.hostname)?.hostname ?? mac,
      deviceKey: device?.key ?? null,
      link: 'wifi',
      detail: repeater ? `Wi-Fi · via ${repeater}` : 'Wi-Fi',
      // tx = de la box vers l'appareil, donc ce que l'appareil télécharge
      downRate: sum(list, 'tx_rate'),
      upRate: sum(list, 'rx_rate'),
      downBytes: sum(list, 'tx_bytes'),
      upBytes: sum(list, 'rx_bytes'),
    };
  });

  const ethernet = ports.map(({ port, stats }) => {
    const entries = Array.isArray(port.mac_list) ? port.mac_list : [];
    const label = (e) => e.hostname || e.name || normalizeMac(e.mac);
    const macs = [...new Set(entries.map((e) => normalizeMac(e.mac)).filter(Boolean))];
    let name;
    let detail;
    let device = null;
    if (macs.length === 1) {
      device = byMac.get(macs[0]) ?? null;
      name = device?.name ?? label(entries.find((e) => normalizeMac(e.mac) === macs[0]));
      detail = `Ethernet · prise ${port.id}`;
    } else {
      name = `Prise Ethernet ${port.id}`;
      detail = macs.length === 0
        ? 'Aucun appareil identifié'
        : `${macs.length} appareils : ${macs.map((m) => byMac.get(m)?.name ?? label(entries.find((e) => normalizeMac(e.mac) === m))).join(', ')}`;
    }
    return {
      id: `eth:${port.id}`,
      name,
      deviceKey: device?.key ?? null,
      link: 'ethernet',
      detail,
      // tx = la box envoie sur la prise, donc l'appareil reçoit
      downRate: pos(stats.tx_bytes_rate),
      upRate: pos(stats.rx_bytes_rate),
      downBytes: pos(stats.tx_bytes),
      upBytes: pos(stats.rx_good_bytes),
    };
  });

  return [...wifi, ...ethernet];
}

/** Du plus gros consommateur au plus petit ; à égalité, par nom. sort : rate ou volume. */
export function rankTraffic(traffic, sort = 'rate') {
  const value = (t) => (sort === 'volume' ? t.downBytes + t.upBytes : t.downRate + t.upRate);
  return [...traffic].sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
}

/**
 * Clients Wi-Fi des répéteurs (repeater/{id}/host/), au format des stations de la box.
 * Le point d'accès (access_point) porte les compteurs vus depuis le répéteur : tx = vers l'appareil.
 * Si le répéteur ne donne pas de débit, on le déduit des octets depuis le relevé précédent.
 * prev : compteurs du relevé précédent { mac: { ts, tx, rx } } ; renvoie les nouveaux.
 */
export function repeaterStations(repeaters, prev = {}, ts = Math.floor(Date.now() / 1000)) {
  const list = [];
  const counters = {};
  for (const { repeater, hosts } of repeaters) {
    const name = repeater.name || repeater.model || `Répéteur ${repeater.id}`;
    for (const host of Array.isArray(hosts) ? hosts : []) {
      const ap = host.access_point ?? {};
      const mac = normalizeMac(host.l2ident?.id);
      if (!mac || ap.connectivity_type === 'ethernet' || host.active === false || host.reachable === false) continue;
      const tx = Number(ap.tx_bytes);
      const rx = Number(ap.rx_bytes);
      const hasBytes = Number.isFinite(tx) && Number.isFinite(rx);
      if (hasBytes) counters[mac] = { ts, tx, rx };
      const before = prev?.[mac];
      const elapsed = before ? ts - before.ts : 0;
      const rate = (field, now, then) => {
        if (ap[field] != null) return pos(ap[field]);
        // Compteur remis à zéro (reconnexion) : pas de débit ce coup-ci
        return hasBytes && elapsed > 0 && now >= then ? (now - then) / elapsed : 0;
      };
      list.push({
        mac,
        hostname: host.primary_name || null,
        _repeater: name,
        tx_rate: rate('tx_rate', tx, before?.tx),
        rx_rate: rate('rx_rate', rx, before?.rx),
        tx_bytes: hasBytes ? tx : 0,
        rx_bytes: hasBytes ? rx : 0,
      });
    }
  }
  return { list, counters };
}
