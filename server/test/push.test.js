import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { cleanSubscription, encryptPayload } from '../src/webpush.js';
import { startHarness } from './harness.js';

/** Navigateur simulé : ses clés d'abonnement et le déchiffrement aes128gcm (RFC 8291) de son côté. */
function fakeBrowser(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  function decrypt(body) {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const data = body.subarray(21 + idlen);
    const ikm = hmac(hmac(auth, ecdh.computeSecret(asPublic)),
      Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic, Buffer.from([1])])).subarray(0, 32);
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(data.subarray(-16));
    const plain = Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
    assert.equal(plain.at(-1), 2);
    return JSON.parse(plain.subarray(0, -1).toString('utf8'));
  }
  return { subscription, decrypt };
}

let h;
before(async () => { h = await startHarness(); });
after(() => h.close());

test('chiffrement aes128gcm : relu par le navigateur', () => {
  const b = fakeBrowser('https://push.example/abc');
  const body = encryptPayload(JSON.stringify({ title: 'Été', body: 'ok' }), b.subscription.keys);
  assert.deepEqual(b.decrypt(body), { title: 'Été', body: 'ok' });
});

test('abonnement : adresse https et clés de bonne taille exigées', () => {
  const { subscription } = fakeBrowser('https://push.example/abc');
  assert.ok(cleanSubscription(subscription));
  assert.equal(cleanSubscription({ ...subscription, endpoint: 'http://push.example/abc' }), null);
  assert.equal(cleanSubscription({ ...subscription, keys: { p256dh: 'abc', auth: subscription.keys.auth } }), null);
});

test('API push : abonnement, test, alerte, abonnement expiré supprimé', async () => {
  let r = await h.call('GET', '/api/push');
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.body.publicKey, 'base64url').length, 65);
  assert.deepEqual(r.body.subscriptions, []);

  r = await h.call('POST', '/api/push/test', {});
  assert.equal(r.status, 400);

  const phone = fakeBrowser('https://fcm.googleapis.com/fcm/send/telephone');
  const old = fakeBrowser('https://fcm.googleapis.com/fcm/send/expire');
  r = await h.call('POST', '/api/push/subscribe', { subscription: phone.subscription, label: 'Chrome · Android' });
  assert.equal(r.status, 200);
  await h.call('POST', '/api/push/subscribe', { subscription: old.subscription });
  assert.equal(r.body.subscriptions[0].label, 'Chrome · Android');
  assert.equal(r.body.subscriptions[0].service, 'fcm.googleapis.com');

  h.pushed.length = 0;
  r = await h.call('POST', '/api/push/test', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, 1);
  assert.equal(r.body.subscriptions.length, 1, 'abonnement expiré (410) supprimé');
  const req = h.pushed.find((p) => p.url.endsWith('/telephone'));
  assert.match(req.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  const message = phone.decrypt(req.body);
  assert.equal(message.title, 'Freebox Monitor');
  assert.match(message.body, /test/);

  // Une alerte de la collecte arrive aussi en push, avec le lien vers l'appareil
  h.pushed.length = 0;
  const { WebPush } = await import('../src/webpush.js');
  assert.ok(h.push instanceof WebPush);
  await h.push.send({ title: 'Freebox Monitor', message: 'Nouvel appareil : Pixel', priority: 4, click: '/appareils/aa' });
  assert.equal(h.pushed[0].headers.Urgency, 'high');
  assert.equal(phone.decrypt(h.pushed[0].body).url, '/appareils/aa');

  r = await h.call('POST', '/api/push/unsubscribe', { endpoint: phone.subscription.endpoint });
  assert.deepEqual(r.body.subscriptions, []);
  r = await h.call('GET', '/api/alerts/settings');
  assert.equal(r.body.push.subscriptions, 0);
});

test('coupure réseau : notification gardée puis renvoyée au retour', async () => {
  const { WebPush } = await import('../src/webpush.js');
  const phone = fakeBrowser('https://fcm.googleapis.com/fcm/send/coupure');
  h.store.savePushSubscription({ endpoint: phone.subscription.endpoint, ...phone.subscription.keys });
  let online = false;
  const got = [];
  const quiet = { info() {}, warn() {} };
  const push = new WebPush({
    store: h.store,
    secrets: { decrypt: () => h.push.keys, encrypt: (v) => v },
    subject: 'mailto:test@example.org',
    log: quiet,
    fetchImpl: async (_url, init) => {
      if (!online) throw new TypeError('fetch failed');
      got.push(phone.decrypt(init.body));
      return new Response(null, { status: 201 });
    },
  });
  try {
    assert.equal(await push.send({ title: 'Freebox Monitor', message: 'Connexion Internet perdue', priority: 4 }), 0);
    assert.equal(push.retries.length, 1);
    await push.flushRetries();
    assert.equal(push.retries.length, 1, 'toujours hors ligne : gardée');
    online = true;
    await push.flushRetries();
    assert.equal(push.retries.length, 0);
    assert.equal(got[0].body, 'Connexion Internet perdue');
    // Plus de 24 h d'attente : abandonnée
    online = false;
    await push.send({ title: 'Freebox Monitor', message: 'vieux' });
    online = true;
    got.length = 0;
    await push.flushRetries(Date.now() + 25 * 3600 * 1000);
    assert.equal(got.length, 0);
  } finally {
    push.stop();
    h.store.deletePushSubscription(phone.subscription.endpoint);
  }
});
