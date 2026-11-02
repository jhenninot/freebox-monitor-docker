// Service worker de Freebox Monitor : rend l'appli installable (PWA) et affiche les notifications push.
// Pas de cache hors ligne : l'interface n'a de sens que connectée au serveur.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Chrome demande un gestionnaire fetch pour proposer l'installation : on laisse passer vers le réseau
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const urgent = (data.priority ?? 3) >= 4;
  event.waitUntil(self.registration.showNotification(data.title || 'Freebox Monitor', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: data.tag,
    data: { url: data.url || '/journal' },
    requireInteraction: urgent,
    vibrate: urgent ? [200, 100, 200] : undefined,
    timestamp: Date.now(),
  }));
});

// Clic sur la notification : on reprend une fenêtre de l'appli déjà ouverte, sinon on en ouvre une
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      return existing.navigate(url).catch(() => null);
    }
    return self.clients.openWindow(url);
  })());
});

// Le navigateur a renouvelé l'abonnement : on prévient le serveur (la session de l'interface suffit)
self.addEventListener('pushsubscriptionchange', (event) => {
  const old = event.oldSubscription;
  event.waitUntil((async () => {
    const sub = event.newSubscription ?? await self.registration.pushManager.subscribe(old.options);
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ subscription: sub.toJSON(), label: 'Renouvelé' }),
    });
    if (old) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ endpoint: old.endpoint }),
      });
    }
  })().catch(() => null));
});
