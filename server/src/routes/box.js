// Actions sur les appareils dans la Freebox (type, nom local, Wake-on-LAN, blocage Wi-Fi, oubli) et IP fixes (DHCP).
// Toutes demandent le droit « Modification des réglages de la Freebox ».
import express from 'express';
import {
  domainFullName, domainPrefixError, normalizeMac, staticLeaseError, wifiBlockStatus,
} from '../freebox/rules.js';

const enc = encodeURIComponent;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function boxRouter({ freebox, store, collector }) {
  const router = express.Router();

  const deviceOr404 = (key) => {
    const device = store.getDevice(key);
    if (!device) throw new HttpError(404, 'Appareil inconnu');
    return device;
  };
  const macOr400 = (device) => {
    if (!device.mac) throw new HttpError(400, 'Cet appareil n\'a pas d\'adresse MAC connue');
    return normalizeMac(device.mac);
  };
  // Relit la box tout de suite pour que l'interface affiche l'état à jour
  const refreshDevices = () => collector.guard('devices', () => collector.pollDevices());

  // --- Réglages de l'appareil dans la box ---

  router.patch('/devices/:key/box', async (req, res) => {
    const device = deviceOr404(req.params.key);
    const raw = store.getDeviceRaw(device.key) ?? {};
    const body = { id: device.id };
    const { hostType, domainPrefix, persistent } = req.body ?? {};
    if (typeof hostType === 'string' && hostType) body.host_type = hostType;
    if (typeof persistent === 'boolean') body.persistent = persistent;
    if (typeof domainPrefix === 'string') {
      if (!raw.local_domain) throw new HttpError(400, 'Ta Freebox ne gère pas les noms locaux (API 16 nécessaire)');
      const error = domainPrefixError(domainPrefix, raw.local_domain);
      if (error) throw new HttpError(400, error);
      body.domain_name = domainFullName(domainPrefix, raw.local_domain);
    }
    await freebox.put(`lan/browser/pub/${enc(device.id)}/`, body);
    await refreshDevices();
    res.json(store.getDevice(device.key));
  });

  router.post('/devices/:key/wol', async (req, res) => {
    const device = deviceOr404(req.params.key);
    await freebox.post('lan/wol/pub/', { mac: macOr400(device), password: '' });
    res.json({ ok: true });
  });

  // Oublier : la box retire l'appareil de sa liste (il reviendra s'il se reconnecte), on efface son historique
  router.delete('/devices/:key', async (req, res) => {
    const device = deviceOr404(req.params.key);
    await freebox.del(`lan/browser/pub/${enc(device.id)}/`);
    store.deleteDevice(device.key);
    res.json({ ok: true });
  });

  // --- Blocage en Wi-Fi (liste noire du filtrage MAC) ---

  const wifiInfo = async (device) => {
    const mac = macOr400(device);
    const [config, filters] = await Promise.all([freebox.get('wifi/config/'), freebox.get('wifi/mac_filter/')]);
    const list = Array.isArray(filters) ? filters : [];
    const entry = list.find((f) => normalizeMac(f.mac) === mac) ?? null;
    const filterState = config?.mac_filter_state ?? 'disabled';
    return {
      filterState,
      entry,
      status: wifiBlockStatus(filterState, entry?.type ?? null),
      otherBlacklisted: list.filter((f) => f.type === 'blacklist' && f !== entry).length,
    };
  };

  router.get('/devices/:key/wifi', async (req, res) => {
    res.json(await wifiInfo(deviceOr404(req.params.key)));
  });

  /**
   * Pour bloquer, si le filtrage est désactivé, on l'active en mode liste noire (comme l'appli Android).
   * Pour débloquer, on retire seulement l'entrée : le mode de filtrage ne change pas.
   */
  router.put('/devices/:key/wifi', async (req, res) => {
    const device = deviceOr404(req.params.key);
    const blocked = req.body?.blocked === true;
    const info = await wifiInfo(device);
    if (blocked) {
      if (info.filterState === 'whitelist') throw new HttpError(409, 'Le Wi-Fi est en mode liste blanche : retire l\'appareil de la liste blanche à la place');
      if (info.entry && info.entry.type !== 'blacklist') await freebox.del(`wifi/mac_filter/${enc(info.entry.id)}`);
      if (info.entry?.type !== 'blacklist') {
        await freebox.post('wifi/mac_filter/', { mac: macOr400(device), type: 'blacklist', comment: device.name });
      }
      if (info.filterState === 'disabled') await freebox.put('wifi/config/', { mac_filter_state: 'blacklist' });
    } else if (info.entry) {
      await freebox.del(`wifi/mac_filter/${enc(info.entry.id)}`);
    }
    res.json(await wifiInfo(device));
  });

  // --- IP fixes (baux DHCP statiques) ---

  const dhcpState = async () => {
    const [config, statics, dynamics] = await Promise.all([
      freebox.get('dhcp/config/'),
      freebox.get('dhcp/static_lease/'),
      freebox.get('dhcp/dynamic_lease/').catch(() => []),
    ]);
    collector.staticLeases = Array.isArray(statics) ? statics : [];
    return { config: config ?? {}, statics: collector.staticLeases, dynamics: Array.isArray(dynamics) ? dynamics : [] };
  };

  const checkLease = async (mac, ip) => {
    const { config, statics } = await dhcpState();
    const takenIps = Object.fromEntries(statics.map((l) => [l.ip, l.mac]));
    const error = staticLeaseError({ mac, ip, gateway: config.gateway, netmask: config.netmask, takenIps });
    if (error) throw new HttpError(400, error);
  };

  router.get('/dhcp', async (_req, res) => {
    const { config, statics, dynamics } = await dhcpState();
    const devices = store.listDevices();
    const byMac = new Map(devices.filter((d) => d.mac).map((d) => [normalizeMac(d.mac), d]));
    const fixed = new Set(statics.map((l) => normalizeMac(l.mac)));
    const deviceOf = (mac) => {
      const d = byMac.get(normalizeMac(mac));
      return d ? { key: d.key, name: d.name, online: d.online } : null;
    };
    res.json({
      config: {
        enabled: Boolean(config.enabled),
        gateway: config.gateway ?? '',
        netmask: config.netmask ?? '',
        rangeStart: config.ip_range_start ?? '',
        rangeEnd: config.ip_range_end ?? '',
        dns: Array.isArray(config.dns) ? config.dns.filter(Boolean) : [],
      },
      staticLeases: statics.map((l) => ({ id: l.id, mac: l.mac, ip: l.ip, comment: l.comment ?? '', hostname: l.hostname ?? '', device: deviceOf(l.mac) }))
        .sort((a, b) => ipSort(a.ip, b.ip)),
      // Adresses distribuées automatiquement, qu'on peut « fixer »
      dynamicLeases: dynamics.filter((l) => !l.is_static && !fixed.has(normalizeMac(l.mac)))
        .map((l) => ({ mac: l.mac, ip: l.ip, hostname: l.hostname ?? '', remaining: l.lease_remaining ?? 0, device: deviceOf(l.mac) }))
        .sort((a, b) => ipSort(a.ip, b.ip)),
      // Rappel : appareils surveillés sans IP fixe
      watchedWithoutLease: devices.filter((d) => d.watched && d.mac && !fixed.has(normalizeMac(d.mac)))
        .map((d) => ({ key: d.key, name: d.name, ipv4: d.ipv4, mac: d.mac })),
    });
  });

  router.post('/dhcp/leases', async (req, res) => {
    const mac = normalizeMac(req.body?.mac);
    const ip = String(req.body?.ip ?? '').trim();
    await checkLease(mac, ip);
    const lease = await freebox.post('dhcp/static_lease/', { mac, ip, comment: String(req.body?.comment ?? '').trim() });
    await collector.refreshStaticLeases();
    res.json(lease);
  });

  router.put('/dhcp/leases/:id', async (req, res) => {
    const ip = String(req.body?.ip ?? '').trim();
    await checkLease(req.params.id, ip);
    const lease = await freebox.put(`dhcp/static_lease/${enc(req.params.id)}`, { ip, comment: String(req.body?.comment ?? '').trim() });
    await collector.refreshStaticLeases();
    res.json(lease);
  });

  router.delete('/dhcp/leases/:id', async (req, res) => {
    await freebox.del(`dhcp/static_lease/${enc(req.params.id)}`);
    await collector.refreshStaticLeases();
    res.json({ ok: true });
  });

  return router;
}

function ipSort(a, b) {
  const n = (ip) => String(ip).split('.').reduce((acc, x) => acc * 256 + Number(x), 0);
  return n(a) - n(b);
}
