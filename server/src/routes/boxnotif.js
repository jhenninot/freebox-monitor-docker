// Réseau > Notifications de la box : inscrire ce serveur comme cible des notifications de la Freebox
import express from 'express';
import {
  BOX_SUBSCRIPTIONS, baseUrlError, DEFAULT_BOX_SUBSCRIPTIONS, normalizeBaseUrl, NOTIF_API_MAJOR, notifIdentity,
} from '../boxnotif.js';
import { HttpError } from './box.js';

const enc = encodeURIComponent;

export function boxNotifRouter({ freebox, store, config }) {
  const router = express.Router();
  const supported = () => (freebox.credentials.load()?.apiMajor ?? 0) >= NOTIF_API_MAJOR;
  const requireSupported = () => {
    if (!supported()) throw new HttpError(400, 'Ta Freebox ne propose pas encore les notifications (API 11) : mets à jour Freebox OS.');
  };
  const apiUrlOf = (base) => `${normalizeBaseUrl(base)}/box-notif/${notifIdentity(store).secret}`;

  router.get('/box-notif', async (_req, res) => {
    const subjects = BOX_SUBSCRIPTIONS.map(([id, label]) => ({ id, label }));
    if (!supported()) return res.json({ supported: false, subjects });
    const { targetId } = notifIdentity(store);
    const targets = await freebox.get('notif/targets/');
    const list = (Array.isArray(targets) ? targets : []).filter((t, i, all) => all.findIndex((x) => x.id === t.id) === i);
    const mine = list.find((t) => t.id === targetId) ?? null;
    const baseUrl = store.getSetting('boxnotif.baseUrl') || config.publicUrl || '';
    res.json({
      supported: true,
      subjects,
      baseUrl,
      registered: Boolean(mine),
      // Confirmé quand la box a bien appelé ce serveur (POST /register)
      confirmed: Boolean(mine && store.getSetting('boxnotif.registration')),
      subscriptions: mine?.subscriptions ?? DEFAULT_BOX_SUBSCRIPTIONS,
      lastCall: store.getSetting('boxnotif.lastCall'),
      targets: list.map((t) => ({
        id: t.id, name: t.name, type: t.type, subscriptions: t.subscriptions ?? [], lastUse: t.last_use ?? 0, mine: t.id === targetId,
        // Adresse masquée : elle contient le secret du relais
        host: String(t.api_url ?? '').replace(/^(https?:\/\/[^/]+).*$/, '$1'),
      })),
    });
  });

  /** Inscrit ou met à jour ce serveur. { baseUrl, subscriptions } */
  router.put('/box-notif', async (req, res) => {
    requireSupported();
    const { baseUrl, subscriptions } = req.body ?? {};
    const error = baseUrlError(baseUrl);
    if (error) throw new HttpError(400, error);
    const known = new Set(BOX_SUBSCRIPTIONS.map(([id]) => id));
    const subs = (Array.isArray(subscriptions) ? subscriptions : []).filter((s) => known.has(s));
    if (!subs.length) throw new HttpError(400, 'Choisis au moins un type de notification');
    const { targetId, token } = notifIdentity(store);
    const body = {
      id: targetId, name: 'Freebox Monitor (serveur)', type: 'android', token, subscriptions: subs, api_url: apiUrlOf(baseUrl), message_type: 'notification',
    };
    const targets = await freebox.get('notif/targets/');
    const exists = (Array.isArray(targets) ? targets : []).some((t) => t.id === targetId);
    if (exists) await freebox.put(`notif/targets/${enc(targetId)}`, body);
    else {
      store.setSetting('boxnotif.registration', null);
      await freebox.post('notif/targets/', body);
    }
    store.setSetting('boxnotif.baseUrl', normalizeBaseUrl(baseUrl));
    res.json({ ok: true });
  });

  router.delete('/box-notif', async (_req, res) => {
    requireSupported();
    await freebox.del(`notif/targets/${enc(notifIdentity(store).targetId)}`).catch((e) => { if (e.status !== 404) throw e; });
    store.setSetting('boxnotif.registration', null);
    res.json({ ok: true });
  });

  // Retirer une autre cible (ancien téléphone...)
  router.delete('/box-notif/targets/:id', async (req, res) => {
    requireSupported();
    await freebox.del(`notif/targets/${enc(req.params.id)}`);
    res.json({ ok: true });
  });

  return router;
}
