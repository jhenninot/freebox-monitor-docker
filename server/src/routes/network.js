// Réseau > Redirections de ports (avec l'état de la DMZ) et Réseau > Filtrage Wi-Fi (listes blanche / noire).
// Les modifications demandent le droit « Modification des réglages de la Freebox ».
import express from 'express';
import {
  incomingPortLabel, isValidMac, missingFromWhitelist, normalizeMac, parsePortForward, portForwardWarnings,
} from '../freebox/rules.js';
import { HttpError } from './box.js';

const enc = encodeURIComponent;
const list = (v) => (Array.isArray(v) ? v : []);
const MODES = ['disabled', 'whitelist', 'blacklist'];
const TYPES = ['whitelist', 'blacklist'];

export function networkRouter({ freebox, store, collector }) {
  const router = express.Router();
  const deviceByIp = (ip) => (ip ? store.listDevices().find((d) => d.ipv4 === ip) ?? null : null);
  const deviceByMac = (mac) => store.listDevices().find((d) => d.mac && normalizeMac(d.mac) === normalizeMac(mac)) ?? null;
  const brief = (d) => (d ? { key: d.key, name: d.name, online: d.online } : null);

  // --- Redirections de ports ---

  const fwState = async () => {
    const [rules, incoming, dmz, dhcp, statics] = await Promise.all([
      freebox.get('fw/redir/'),
      freebox.get('fw/incoming/').catch(() => []),
      freebox.get('fw/dmz/').catch(() => null),
      freebox.get('dhcp/config/').catch(() => ({})),
      freebox.get('dhcp/static_lease/').catch(() => []),
    ]);
    return { rules: list(rules), incoming: list(incoming), dmz, dhcp: dhcp ?? {}, staticIps: new Set(list(statics).map((l) => l.ip)) };
  };
  const portRange = () => collector.connection?.ipv4PortRange ?? null;
  const present = (rule, state) => ({
    ...rule,
    device: brief(deviceByIp(rule.lan_ip)),
    warnings: portForwardWarnings(rule, state.rules, state.incoming, state.staticIps, portRange()),
  });

  router.get('/portfwd', async (_req, res) => {
    const state = await fwState();
    res.json({
      rules: state.rules.sort((a, b) => a.wan_port_start - b.wan_port_start).map((r) => present(r, state)),
      incoming: state.incoming.filter((p) => p.enabled).map((p) => ({ ...p, label: incomingPortLabel(p.id) })),
      dmz: state.dmz ? { enabled: Boolean(state.dmz.enabled), ip: state.dmz.ip ?? '', device: brief(deviceByIp(state.dmz.ip)) } : null,
      lan: { gateway: state.dhcp.gateway ?? '', netmask: state.dhcp.netmask ?? '' },
      ipv4PortRange: portRange(),
      // Appareils proposés comme destination
      devices: store.listDevices().filter((d) => d.ipv4 && !d.hidden).map((d) => ({ key: d.key, name: d.name, ipv4: d.ipv4 })),
    });
  });

  const parsed = async (body) => {
    const state = await fwState();
    const { error, rule } = parsePortForward(body, state.dhcp);
    if (error) throw new HttpError(400, error);
    return { state, rule };
  };

  router.post('/portfwd', async (req, res) => {
    const { state, rule } = await parsed(req.body);
    const created = await freebox.post('fw/redir/', { ...rule, enabled: req.body?.enabled !== false });
    state.rules.push(created);
    res.json(present(created, state));
  });

  router.put('/portfwd/:id', async (req, res) => {
    const id = Number(req.params.id);
    // { enabled } seul : activer / désactiver sans revalider le reste
    if (Object.keys(req.body ?? {}).length === 1 && typeof req.body.enabled === 'boolean') {
      const updated = await freebox.put(`fw/redir/${id}`, { enabled: req.body.enabled });
      const state = await fwState();
      return res.json(present(updated ?? state.rules.find((r) => r.id === id), state));
    }
    const { state, rule } = await parsed(req.body);
    const body = typeof req.body.enabled === 'boolean' ? { ...rule, enabled: req.body.enabled } : rule;
    const updated = await freebox.put(`fw/redir/${id}`, body);
    state.rules = state.rules.map((r) => (r.id === id ? updated : r));
    res.json(present(updated, state));
  });

  router.delete('/portfwd/:id', async (req, res) => {
    await freebox.del(`fw/redir/${Number(req.params.id)}`);
    res.json({ ok: true });
  });

  // --- Filtrage MAC du Wi-Fi ---

  const wifiState = async (req) => {
    const [config, filters, aps] = await Promise.all([
      freebox.get('wifi/config/'),
      freebox.get('wifi/mac_filter/'),
      freebox.get('wifi/ap/').catch(() => []),
    ]);
    // Appareils connectés au Wi-Fi en ce moment : ils perdraient l'accès en passant en liste blanche
    const stations = [];
    for (const ap of list(aps)) stations.push(...list(await freebox.get(`wifi/ap/${ap.id}/stations/`).catch(() => [])));
    const wifiMacs = [...new Set(stations.map((s) => normalizeMac(s.mac)).filter(Boolean))];
    // L'appareil depuis lequel on consulte l'interface, s'il est sur le réseau local
    const viewer = deviceByIp(String(req.ip ?? '').replace(/^::ffff:/, ''));
    const entries = list(filters).map((f) => {
      const device = deviceByMac(f.mac);
      return {
        id: f.id, mac: normalizeMac(f.mac), type: f.type, comment: f.comment ?? '',
        name: device?.name || (f.hostname && normalizeMac(f.hostname) !== normalizeMac(f.mac) ? f.hostname : '') || f.comment || normalizeMac(f.mac),
        device: brief(device),
        onWifi: wifiMacs.includes(normalizeMac(f.mac)),
        viewer: Boolean(viewer?.mac && normalizeMac(viewer.mac) === normalizeMac(f.mac)),
      };
    }).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    const whitelist = entries.filter((e) => e.type === 'whitelist').map((e) => e.mac);
    const needed = [...(viewer?.mac ? [viewer.mac] : []), ...wifiMacs];
    return {
      mode: config?.mac_filter_state ?? 'disabled',
      entries,
      viewer: viewer?.mac ? { key: viewer.key, name: viewer.name, mac: normalizeMac(viewer.mac) } : null,
      missingForWhitelist: missingFromWhitelist(whitelist, needed).map((mac) => {
        const device = deviceByMac(mac);
        return { mac, name: device?.name ?? mac, viewer: Boolean(viewer?.mac && normalizeMac(viewer.mac) === mac) };
      }),
      // Appareils connus proposés à l'ajout
      devices: store.listDevices().filter((d) => d.mac && !d.hidden).map((d) => ({ key: d.key, name: d.name, mac: normalizeMac(d.mac), link: d.link })),
    };
  };

  router.get('/wifi-filter', async (req, res) => res.json(await wifiState(req)));

  /**
   * Change le mode. Passer en liste blanche couperait le Wi-Fi des appareils absents de la liste :
   * refusé (409, avec la liste) sauf si addMissing (on les ajoute d'abord) ou force.
   */
  router.put('/wifi-filter/mode', async (req, res) => {
    const { mode, addMissing = false, force = false } = req.body ?? {};
    if (!MODES.includes(mode)) throw new HttpError(400, 'Mode de filtrage inconnu');
    const state = await wifiState(req);
    if (mode === 'whitelist' && state.missingForWhitelist.length && !force) {
      if (!addMissing) {
        return res.status(409).json({ error: 'Ces appareils perdraient le Wi-Fi en liste blanche', missing: state.missingForWhitelist });
      }
      for (const d of state.missingForWhitelist) {
        const existing = state.entries.find((e) => e.mac === d.mac);
        if (existing) await freebox.put(`wifi/mac_filter/${enc(existing.id)}`, { type: 'whitelist', comment: existing.comment || d.name });
        else await freebox.post('wifi/mac_filter/', { mac: d.mac, type: 'whitelist', comment: d.name });
      }
    }
    await freebox.put('wifi/config/', { mac_filter_state: mode });
    res.json(await wifiState(req));
  });

  router.post('/wifi-filter', async (req, res) => {
    const { mac, type, comment = '' } = req.body ?? {};
    if (!isValidMac(mac)) throw new HttpError(400, 'Adresse MAC invalide (format AA:BB:CC:DD:EE:FF)');
    if (!TYPES.includes(type)) throw new HttpError(400, 'Liste inconnue');
    const state = await wifiState(req);
    if (state.entries.some((e) => e.mac === normalizeMac(mac))) throw new HttpError(409, 'Cet appareil est déjà dans une liste : modifie son entrée');
    await freebox.post('wifi/mac_filter/', { mac: normalizeMac(mac), type, comment: String(comment).trim() });
    res.json(await wifiState(req));
  });

  router.put('/wifi-filter/:id', async (req, res) => {
    const { type, comment } = req.body ?? {};
    if (!TYPES.includes(type)) throw new HttpError(400, 'Liste inconnue');
    await freebox.put(`wifi/mac_filter/${enc(req.params.id)}`, { type, comment: String(comment ?? '').trim() });
    res.json(await wifiState(req));
  });

  router.delete('/wifi-filter/:id', async (req, res) => {
    await freebox.del(`wifi/mac_filter/${enc(req.params.id)}`);
    res.json(await wifiState(req));
  });

  return router;
}
