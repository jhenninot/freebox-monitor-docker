// Abonnements des navigateurs aux notifications push (PWA)
import express from 'express';
import { cleanSubscription } from '../webpush.js';

export function pushRouter({ push, store }) {
  const router = express.Router();

  const list = () => store.listPushSubscriptions().map((s) => ({
    endpoint: s.endpoint,
    label: s.label,
    service: new URL(s.endpoint).host,
    createdAt: s.createdAt,
    lastOk: s.lastOk,
  }));

  // Clé publique VAPID (applicationServerKey du navigateur) et navigateurs abonnés
  router.get('/push', (_req, res) => {
    res.json({ publicKey: push.publicKey, subscriptions: list() });
  });

  router.post('/push/subscribe', (req, res) => {
    const subscription = cleanSubscription(req.body?.subscription);
    if (!subscription) return res.status(400).json({ error: 'Abonnement push invalide' });
    const label = String(req.body?.label || '').trim().slice(0, 80) || null;
    store.savePushSubscription({ ...subscription, label });
    res.json({ subscriptions: list() });
  });

  router.post('/push/unsubscribe', (req, res) => {
    store.deletePushSubscription(String(req.body?.endpoint || ''));
    res.json({ subscriptions: list() });
  });

  // Notification de test envoyée à tous les navigateurs abonnés
  router.post('/push/test', async (_req, res) => {
    if (!push.count) return res.status(400).json({ error: 'Aucun navigateur abonné : active d\'abord les notifications sur cet appareil' });
    const sent = await push.send({ title: 'Freebox Monitor', message: 'Notification de test : les alertes arrivent bien.', click: '/journal', tag: 'test' })
      .catch((e) => { const err = new Error(`Notification non envoyée : ${e.message}`); err.status = 502; throw err; });
    res.json({ sent, subscriptions: list() });
  });

  return router;
}
