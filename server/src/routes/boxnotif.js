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

  // La box peut renvoyer notre cible sous un autre id que celui donné à l'inscription :
  // on la reconnaît aussi au secret dans son adresse et à l'id qu'elle a donné en appelant /register
  const listTargets = async () => {
    const targets = await freebox.get('notif/targets/');
    return (Array.isArray(targets) ? targets : []).filter((t, i, all) => all.findIndex((x) => x.id === t.id) === i);
  };
  const isMine = (t) => {
    const { targetId, secret } = notifIdentity(store);
    const registration = store.getSetting('boxnotif.registration');
    return t.id === targetId || (registration?.deviceId && t.id === registration.deviceId) || String(t.api_url ?? '').includes(`/box-notif/${secret}`);
  };

  router.get('/box-notif', async (_req, res) => {
    const subjects = BOX_SUBSCRIPTIONS.map(([id, label]) => ({ id, label }));
    if (!supported()) return res.json({ supported: false, subjects });
    const list = await listTargets();
    const mine = list.find(isMine) ?? null;
    const baseUrl = store.getSetting('boxnotif.baseUrl') || config.publicUrl || '';
    res.json({
      supported: true,
      subjects,
      baseUrl,
      registered: Boolean(mine),
      // Confirmé quand la box a bien appelé ce serveur (POST /register)
      confirmed: Boolean(mine && store.getSetting('boxnotif.registration')),
      subscriptions: mine?.subscriptions ?? DEFAULT_BOX_SUBSCRIPTIONS,
      targetId: mine?.id ?? null,
      lastCall: store.getSetting('boxnotif.lastCall'),
      targets: list.map((t) => ({
        id: t.id, name: t.name, type: t.type, subscriptions: t.subscriptions ?? [], lastUse: t.last_use ?? 0, mine: isMine(t),
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
    const existing = (await listTargets()).find(isMine);
    if (existing) await freebox.put(`notif/targets/${enc(existing.id)}`, { ...body, id: existing.id });
    else {
      store.setSetting('boxnotif.registration', null);
      await freebox.post('notif/targets/', body);
    }
    store.setSetting('boxnotif.baseUrl', normalizeBaseUrl(baseUrl));
    // Sujets demandés que la box n'a pas gardés (fonction absente sur ce modèle, par exemple)
    const saved = (await listTargets()).find(isMine);
    const dropped = saved ? subs.filter((x) => !(saved.subscriptions ?? []).includes(x)) : [];
    res.json({ ok: true, dropped });
  });

  router.delete('/box-notif', async (_req, res) => {
    requireSupported();
    const existing = (await listTargets()).find(isMine);
    if (existing) await freebox.del(`notif/targets/${enc(existing.id)}`);
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
