// Équipements Free : Freebox Server et répéteurs Wi-Fi (état, firmware, redémarrage, LED).
// Redémarrer et changer la LED demandent le droit « Modification des réglages de la Freebox ».
import express from 'express';
import { HttpError } from './box.js';

// Pas deux demandes de redémarrage du même équipement dans ce délai (double clic, deux onglets...)
const REBOOT_COOLDOWN_SECONDS = 5 * 60;
const now = () => Math.floor(Date.now() / 1000);

export function equipmentRouter({ freebox, store, collector }) {
  const router = express.Router();

  const repeaterOr404 = (id) => {
    const repeater = collector.repeaters?.items.find((r) => String(r.id) === String(id));
    if (!repeater) throw new HttpError(404, 'Répéteur inconnu');
    return repeater;
  };
  const cooldown = (request) => {
    const wait = request ? request.ts + REBOOT_COOLDOWN_SECONDS - now() : 0;
    if (wait > 0) throw new HttpError(429, `Redémarrage déjà demandé par ${request.by}, réessaie dans ${Math.ceil(wait / 60)} min`);
  };
  const refreshRepeaters = () => collector.fetchRepeaterHosts().catch(() => null);

  const view = () => {
    const system = collector.system;
    const requests = store.getSetting('repeaters.rebootRequests', {});
    return {
      // false seulement si la box a répondu sans le droit « settings » ; null si la session n'est pas encore ouverte
      canManage: freebox.permissions && 'settings' in freebox.permissions ? Boolean(freebox.permissions.settings) : null,
      box: {
        system,
        bootTs: system ? system.ts - system.uptime : null,
        rebootRequest: store.getSetting('box.rebootRequest', null),
        update: collector.update,
        release: collector.releases?.latest?.server ?? null,
        firmware: store.listFirmware('box', 20),
      },
      releases: { ts: collector.releases?.ts ?? null, error: collector.releases?.error ?? null, enabled: Boolean(collector.config.releasesFeedUrl) },
      repeaters: {
        release: collector.releases?.latest?.repeater ?? null,
        supported: collector.repeatersSupported !== false,
        ts: collector.repeaters?.ts ?? null,
        items: (collector.repeaters?.items ?? []).map((r) => ({
          ...r,
          rebootRequest: requests[r.key] ?? null,
          firmwareHistory: store.listFirmware(`repeater:${r.key}`, 20),
        })),
      },
    };
  };

  router.get('/equipment', (_req, res) => res.json(view()));

  // Billets du blog de Free (flux RSS lu par le collecteur) ; mine : concerne la box ou un répéteur d'ici
  const news = (limit) => {
    const latest = collector.releases?.latest ?? {};
    const items = store.listNews(limit).map((i) => ({
      ...i,
      mine: Boolean(i.version && ((i.target === 'server' && i.version === latest.server?.version)
        || (i.target === 'repeater' && i.version === latest.repeater?.version))),
    }));
    return {
      ts: collector.releases?.ts ?? null,
      error: collector.releases?.error ?? null,
      added: collector.releases?.added ?? null,
      enabled: Boolean(collector.config.releasesFeedUrl),
      items,
    };
  };
  const limitOf = (req) => Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 500, 1), 500);

  // ?limit=10 pour la carte de la page Équipements ; sans limite : tout le flux gardé (500 billets au plus)
  router.get('/equipment/news', (req, res) => res.json(news(limitOf(req))));

  // Relecture à la demande ; all=true lit aussi les pages plus anciennes du flux (jusqu'à 10)
  let lastRefresh = 0;
  router.post('/equipment/news/refresh', async (req, res) => {
    if (!collector.config.releasesFeedUrl) throw new HttpError(400, 'Lecture du flux désactivée (FREE_RELEASES_URL vide)');
    if (Date.now() - lastRefresh < 15000) throw new HttpError(429, 'Flux relu il y a moins de 15 s, réessaie dans un instant');
    lastRefresh = Date.now();
    await collector.checkReleases(now(), { pages: req.body?.all ? 10 : 1 });
    res.json(news(limitOf(req)));
  });

  router.post('/equipment/box/reboot', async (req, res) => {
    cooldown(store.getSetting('box.rebootRequest', null));
    await freebox.post('system/reboot/', {});
    const by = req.user.username;
    store.setSetting('box.rebootRequest', { ts: now(), by });
    // Inscrit tout de suite : ce serveur peut s'arrêter avec la box (VM de la Freebox)
    await collector.alert({ type: 'box_reboot_request', message: `Redémarrage de la Freebox demandé par ${by}`, push: false });
    res.json(view());
  });

  router.post('/equipment/repeaters/:id/reboot', async (req, res) => {
    const repeater = repeaterOr404(req.params.id);
    const requests = store.getSetting('repeaters.rebootRequests', {});
    cooldown(requests[repeater.key]);
    await freebox.post(`repeater/${encodeURIComponent(repeater.id)}/reboot/`, {});
    const by = req.user.username;
    store.setSetting('repeaters.rebootRequests', { ...store.getSetting('repeaters.rebootRequests', {}), [repeater.key]: { ts: now(), by, sawDown: false } });
    await collector.alert({ type: 'repeater_reboot_request', message: `Redémarrage de ${repeater.name} demandé par ${by}`, push: false });
    await refreshRepeaters();
    res.json(view());
  });

  router.put('/equipment/repeaters/:id/led', async (req, res) => {
    const repeater = repeaterOr404(req.params.id);
    if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'enabled (true ou false) attendu');
    await freebox.put(`repeater/${encodeURIComponent(repeater.id)}`, { led_activated: req.body.enabled });
    await refreshRepeaters();
    res.json(view());
  });

  return router;
}
