// Réseau > Notifications de la box : inscrire ce serveur comme cible des notifications de la Freebox
import express from 'express';
import {
  BOX_SUBSCRIPTIONS, baseUrlError, DEFAULT_BOX_SUBSCRIPTIONS, normalizeBaseUrl, NOTIF_API_MAJOR, notifIdentity,
} from '../boxnotif.js';
import { HttpError } from './box.js';

const enc = encodeURIComponent;
export const TARGET_NAME = 'Freebox Monitor (serveur)';

export function boxNotifRouter({ freebox, store, config, log = console }) {
  const router = express.Router();
  // Message de la box souvent vague (« Erreur de notification ») : on dit ce qui a été refusé
  const refused = (e) => {
    if (e.name !== 'FreeboxError' || e.code === 'insufficient_rights' || e.code === 'unreachable') return e;
    e.message = `La box a refusé l'inscription (${e.message}${e.code ? `, code ${e.code}` : ''}). `
      + 'Si un autre destinataire « Freebox Monitor » est listé plus bas, retire-le puis réessaie.';
    return e;
  };
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
        // Laissé par une ancienne installation (autre machine ou base remise à zéro)
        stale: !isMine(t) && t.name === TARGET_NAME,
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
      id: targetId, name: TARGET_NAME, type: 'android', token, subscriptions: subs, api_url: apiUrlOf(baseUrl), message_type: 'notification',
    };
    const targets = await listTargets();
    const existing = targets.find(isMine);
    if (existing) await freebox.put(`notif/targets/${enc(existing.id)}`, { ...body, id: existing.id });
    else {
      store.setSetting('boxnotif.registration', null);
      // Destinataire laissé par une ancienne installation de Freebox Monitor (autre machine, base neuve) :
      // la box refuse alors la nouvelle inscription (« Erreur de notification »). On le remplace.
      const orphans = targets.filter((t) => t.name === TARGET_NAME && !isMine(t));
      try {
        await freebox.post('notif/targets/', body);
      } catch (e) {
        if (e.name !== 'FreeboxError' || !orphans.length) throw refused(e);
        for (const t of orphans) {
          log.info(`Notifications de la box : remplacement de l'ancien destinataire ${t.id} (${String(t.api_url ?? '').replace(/^(https?:\/\/[^/]+).*$/, '$1')})`);
          await freebox.del(`notif/targets/${enc(t.id)}`);
        }
        store.setSetting('boxnotif.registration', null);
        try {
          await freebox.post('notif/targets/', body);
        } catch (e2) {
          throw refused(e2);
        }
      }
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
    // Certaines box répondent « OK » sans rien retirer (destinataire créé par une autre application associée)
    if ((await listTargets()).some((t) => t.id === req.params.id)) {
      throw new HttpError(409, 'La box a accepté la demande mais garde ce destinataire : il a sans doute été créé par une autre installation de Freebox Monitor. '
        + 'Retire-le depuis cette installation (bouton Désinscrire), ou retire son application dans Freebox OS (Paramètres > Gestion des accès > Applications).');
    }
    res.json({ ok: true });
  });

  return router;
}
