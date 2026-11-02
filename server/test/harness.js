// Monte le serveur complet devant une fausse Freebox, déjà associé et connecté à l'interface
import { createApp } from '../src/app.js';
import { Collector } from '../src/collector.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { FreeboxClient } from '../src/freebox/client.js';
import { Secrets } from '../src/security.js';
import { startFakeFreebox } from './fake-freebox.js';

const quiet = { info() {}, warn() {}, error() {} };

export async function startHarness() {
  const box = await startFakeFreebox();
  const config = loadConfig({ APP_SECRET: 'secret-de-test-assez-long', ADMIN_PASSWORD: 'motdepasse', FREEBOX_URL: box.url, WEB_DIR: '/inexistant' });
  const store = openDatabase(':memory:');
  const secrets = new Secrets(config.appSecret);
  const credentials = {
    load: () => { const v = store.getSetting('freebox.credentials'); return v ? secrets.decrypt(v) : null; },
    save: (v) => store.setSetting('freebox.credentials', secrets.encrypt(v)),
    clear: () => store.setSetting('freebox.credentials', null),
  };
  // Déjà associé
  credentials.save({ appToken: box.state.appToken, uid: 'box-uid', apiMajor: 15, boxName: 'Freebox Ultra' });
  const freebox = new FreeboxClient({ baseUrl: config.freeboxUrl, credentials, log: quiet });
  const sent = [];
  const notify = async (n) => { sent.push(n); };
  const collector = new Collector({ freebox, store, config, notify, log: quiet });
  const app = createApp({ config, store, secrets, freebox, collector, notify, log: quiet });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  await call('POST', '/api/auth/login', { password: 'motdepasse' });

  return {
    box, store, collector, freebox, sent, call,
    close() {
      server.close();
      box.close();
      store.close();
    },
  };
}
