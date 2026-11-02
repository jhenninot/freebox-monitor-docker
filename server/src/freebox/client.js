// Client de l'API locale Freebox OS : association, session HMAC-SHA1 et appels authentifiés.
// Même logique que l'appli Android (FreeboxRepository.kt), avec son propre app_id.
import { hmacSha1Hex } from '../security.js';

// La Freebox refuse les app_id trop longs (« app_id is too long ») : rester court
export const APP_ID = 'fr.jhenninot.fbmonitor';
export const APP_NAME = 'Freebox Monitor (serveur)';
const DEFAULT_API_MAJOR = 8;
const MAX_API_MAJOR = 16;

export class FreeboxError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = 'FreeboxError';
    this.code = code;
    this.status = status;
  }
}

/** Version d'API à utiliser : celle de la box, entre 8 et la plus récente testée. */
export function apiMajorOf(apiVersion) {
  const major = Number.parseInt(String(apiVersion ?? '').split('.')[0], 10);
  if (!Number.isFinite(major)) return DEFAULT_API_MAJOR;
  return Math.min(Math.max(major, DEFAULT_API_MAJOR), MAX_API_MAJOR);
}

/**
 * credentials : { load(): {appToken, uid, apiMajor, boxName} | null, save(value), clear() }
 * Le jeton d'application est fourni chiffré par l'appelant ; ici il ne vit qu'en mémoire.
 */
export class FreeboxClient {
  constructor({ baseUrl, credentials, appVersion = '0.1.0', fetchImpl = fetch, log = console }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.credentials = credentials;
    this.appVersion = appVersion;
    this.fetch = fetchImpl;
    this.log = log;
    this.sessionToken = null;
    this.permissions = {};
    this.loginPromise = null;
    this.pending = null; // association en cours : { appToken, trackId }
  }

  get paired() {
    return Boolean(this.credentials.load()?.appToken);
  }

  apiBase(major) {
    return `${this.baseUrl}/api/v${major ?? this.credentials.load()?.apiMajor ?? DEFAULT_API_MAJOR}/`;
  }

  async raw(method, url, { body, auth = true, timeoutMs = 10000 } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.sessionToken) headers['X-Fbx-App-Auth'] = this.sessionToken;
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new FreeboxError(`Freebox injoignable (${e.cause?.code || e.name}) : ${url.replace(/\?.*/, '')}`, { code: 'unreachable' });
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      throw new FreeboxError(`Réponse illisible de la Freebox (HTTP ${res.status})`, { status: res.status });
    }
    if (!json?.success) {
      throw new FreeboxError(json?.msg || `Erreur Freebox (HTTP ${res.status})`, { code: json?.error_code ?? null, status: res.status });
    }
    return json.result;
  }

  /** GET /api_version : identité de la box, sans authentification. */
  async discover() {
    const res = await this.fetch(`${this.baseUrl}/api_version`, { signal: AbortSignal.timeout(5000) })
      .catch((e) => { throw new FreeboxError(`Freebox injoignable à ${this.baseUrl} (${e.cause?.code || e.name})`, { code: 'unreachable' }); });
    if (!res.ok) throw new FreeboxError(`${this.baseUrl} ne répond pas comme une Freebox (HTTP ${res.status})`);
    const info = await res.json();
    return {
      uid: info.uid ?? null,
      boxName: info.box_model_name || info.device_name || 'Freebox',
      deviceName: info.device_name ?? null,
      apiVersion: info.api_version ?? null,
      apiMajor: apiMajorOf(info.api_version),
    };
  }

  // --- Association (validation sur l'écran du Freebox Server) ---

  async startPairing(deviceName = 'Serveur Docker') {
    const info = await this.discover();
    const result = await this.raw('POST', `${this.apiBase(info.apiMajor)}login/authorize/`, {
      auth: false,
      body: { app_id: APP_ID, app_name: APP_NAME, app_version: this.appVersion, device_name: deviceName },
    });
    this.pending = { appToken: result.app_token, trackId: result.track_id, info };
    return { trackId: result.track_id, boxName: info.boxName };
  }

  /** Statut de l'association en cours : pending, granted, denied, timeout ou unknown. */
  async pairingStatus() {
    if (!this.pending) return { status: this.paired ? 'granted' : 'none' };
    const { appToken, trackId, info } = this.pending;
    const result = await this.raw('GET', `${this.apiBase(info.apiMajor)}login/authorize/${trackId}`, { auth: false });
    if (result.status === 'granted') {
      this.credentials.save({ appToken, uid: info.uid, apiMajor: info.apiMajor, boxName: info.boxName });
      this.pending = null;
      this.sessionToken = null;
    } else if (result.status !== 'pending') {
      this.pending = null;
    }
    return { status: result.status };
  }

  unpair() {
    this.credentials.clear();
    this.sessionToken = null;
    this.permissions = {};
    this.pending = null;
  }

  // --- Session ---

  async login() {
    // Un seul login à la fois, partagé par les appels concurrents
    if (!this.loginPromise) {
      this.loginPromise = this.doLogin().finally(() => { this.loginPromise = null; });
    }
    return this.loginPromise;
  }

  async doLogin() {
    const creds = this.credentials.load();
    if (!creds?.appToken) throw new FreeboxError('Serveur non associé à la Freebox', { code: 'not_paired' });
    // La version d'API peut changer après une mise à jour de la box
    try {
      const info = await this.discover();
      if (info.apiMajor !== creds.apiMajor || info.boxName !== creds.boxName) {
        this.credentials.save({ ...creds, apiMajor: info.apiMajor, boxName: info.boxName, uid: info.uid ?? creds.uid });
      }
    } catch (e) {
      this.log.warn?.(`api_version illisible, on garde la version connue : ${e.message}`);
    }
    const { challenge } = await this.raw('GET', `${this.apiBase()}login/`, { auth: false });
    try {
      const session = await this.raw('POST', `${this.apiBase()}login/session/`, {
        auth: false,
        body: { app_id: APP_ID, password: hmacSha1Hex(creds.appToken, challenge) },
      });
      this.sessionToken = session.session_token;
      this.permissions = session.permissions ?? {};
    } catch (e) {
      // Appli révoquée dans Freebox OS : il faut refaire l'association
      if (e.code === 'invalid_token') {
        this.log.warn?.('Jeton Freebox refusé : association à refaire');
        this.unpair();
      }
      throw e;
    }
  }

  /** Appel authentifié, avec réouverture de session si elle a expiré. */
  async request(method, path, body) {
    if (!this.sessionToken) await this.login();
    try {
      return await this.raw(method, this.apiBase() + path, { body });
    } catch (e) {
      if (e.code === 'auth_required' || e.code === 'invalid_session') {
        this.sessionToken = null;
        await this.login();
        return this.raw(method, this.apiBase() + path, { body });
      }
      throw e;
    }
  }

  get(path) { return this.request('GET', path); }
  put(path, body) { return this.request('PUT', path, body); }
  post(path, body) { return this.request('POST', path, body); }
  del(path) { return this.request('DELETE', path); }
}
