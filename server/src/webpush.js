// Notifications Web Push (navigateur, PWA) : clés VAPID (RFC 8292) et chiffrement aes128gcm (RFC 8291),
// avec node:crypto seulement. Les abonnements des navigateurs sont gardés en base (table push_subscriptions).
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (text) => Buffer.from(String(text || ''), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Nouvelle paire de clés VAPID : publique (point P-256 non compressé, 65 octets) et privée (32 octets), en base64url. */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidPrivateKeyObject({ publicKey, privateKey }) {
  const pub = fromB64u(publicKey);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privateKey },
  });
}

/** En-tête Authorization VAPID pour un service de push (aud = origine de l'adresse d'abonnement). */
export function vapidAuthorization(endpoint, keys, subject, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: subject }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: vapidPrivateKeyObject(keys),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/** Chiffre le message pour un abonnement (clés p256dh et auth données par le navigateur), en un seul enregistrement. */
export function encryptPayload(payload, { p256dh, auth }, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Clés d\'abonnement invalides');

  const local = ecdh ?? crypto.createECDH('prime256v1');
  if (!ecdh) local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);

  // IKM = HKDF(auth, ECDH, "WebPush: info" || clé du navigateur || clé du serveur)
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);

  // Données + délimiteur de dernier enregistrement (0x02)
  const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Vérifie et normalise un abonnement envoyé par l'interface (PushSubscription.toJSON()). */
export function cleanSubscription(input) {
  const endpoint = String(input?.endpoint || '');
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || endpoint.length > 1024) return null;
  const p256dh = String(input?.keys?.p256dh || '');
  const auth = String(input?.keys?.auth || '');
  if (fromB64u(p256dh).length !== 65 || fromB64u(auth).length !== 16) return null;
  return { endpoint, p256dh, auth };
}

/**
 * Envoi aux navigateurs abonnés. Les clés VAPID sont créées au premier démarrage et gardées chiffrées en base.
 * send({ title, message, priority, click, tag }) : click = page ouverte au clic sur la notification.
 */
export class WebPush {
  constructor({ store, secrets, subject, fetchImpl = fetch, log = console }) {
    this.store = store;
    this.subject = subject;
    this.fetch = fetchImpl;
    this.log = log;
    const saved = store.getSetting('push.vapid');
    let keys = saved ? secrets.decrypt(saved) : null;
    if (!keys?.publicKey || !keys?.privateKey) {
      if (saved) log.warn?.('Clés Web Push illisibles (APP_SECRET a changé ?) : nouvelles clés, réabonne tes navigateurs');
      keys = generateVapidKeys();
      store.setSetting('push.vapid', secrets.encrypt(keys));
      store.clearPushSubscriptions();
    }
    this.keys = keys;
    // Envois ratés faute de réseau (coupure Internet...) : retentés chaque minute pendant 24 h
    this.retries = [];
    this.retryTimer = null;
  }

  stop() {
    clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  get publicKey() {
    return this.keys.publicKey;
  }

  get count() {
    return this.store.listPushSubscriptions().length;
  }

  /** Envoie à tous les abonnés. Renvoie le nombre d'envois réussis ; les abonnements expirés sont supprimés. */
  async send({ title, message, priority = 3, click = '/journal', tag }) {
    const subscriptions = this.store.listPushSubscriptions();
    if (!subscriptions.length) return 0;
    // Un seul enregistrement de 4 Ko au plus : le texte est raccourci si besoin
    const payload = JSON.stringify({ title, body: String(message).slice(0, 1000), url: click, tag, priority });
    const results = await Promise.allSettled(subscriptions.map((s) => this.sendOne(s, payload, priority)));
    let ok = 0;
    let queued = 0;
    const failures = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') { ok += 1; return; }
      if (!r.reason.http) {
        // Service de push injoignable : on réessaiera quand le réseau reviendra
        this.queueRetry(subscriptions[i].endpoint, payload, priority);
        queued += 1;
      }
      failures.push(`${subscriptions[i].label || 'navigateur'} : ${r.reason.message}`);
      this.log.warn?.(`Notification push non envoyée (${failures.at(-1)})${r.reason.http ? '' : ', nouvel essai dans 1 min'}`);
    });
    if (ok) this.log.info?.(`Alerte envoyée par Web Push à ${ok} navigateur(s) : ${title}`);
    if (!ok && !queued) throw new Error(failures.join(' ; '));
    return ok;
  }

  queueRetry(endpoint, payload, priority, now = Date.now()) {
    this.retries.push({ endpoint, payload, priority, since: now });
    if (this.retries.length > 100) this.retries.shift();
    this.retryTimer ??= setInterval(() => this.flushRetries().catch(() => null), 60 * 1000);
    this.retryTimer.unref?.();
  }

  /** Renvoie les notifications en attente (dans l'ordre), abandonne celles de plus de 24 h. */
  async flushRetries(now = Date.now()) {
    const pending = this.retries.splice(0).filter((r) => now - r.since < 24 * 3600 * 1000);
    const subscriptions = new Map(this.store.listPushSubscriptions().map((s) => [s.endpoint, s]));
    for (const r of pending) {
      const subscription = subscriptions.get(r.endpoint);
      if (!subscription) continue;
      try {
        await this.sendOne(subscription, r.payload, r.priority);
        this.log.info?.(`Notification push en attente envoyée (${subscription.label || 'navigateur'})`);
      } catch (e) {
        if (!e.http) this.retries.push(r);
      }
    }
    if (!this.retries.length) this.stop();
  }

  async sendOne(subscription, payload, priority) {
    const res = await this.fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(subscription.endpoint, this.keys, this.subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(24 * 3600),
        Urgency: priority >= 4 ? 'high' : 'normal',
      },
      body: encryptPayload(payload, subscription),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404 || res.status === 410) {
      // Abonnement résilié (navigateur désinstallé, permission retirée...)
      this.store.deletePushSubscription(subscription.endpoint);
      throw Object.assign(new Error('abonnement expiré, supprimé'), { http: true });
    }
    if (res.status === 429 || res.status >= 500) {
      // Service de push surchargé : traité comme une panne réseau, donc réessayé
      throw new Error(`service de push indisponible (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 200)}`), { http: true });
    }
    this.store.touchPushSubscription(subscription.endpoint);
  }
}
