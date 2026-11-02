// Appels à l'API du serveur. Une réponse 401 renvoie à l'écran de connexion.
import { reactive } from 'vue';

// État de la connexion, rempli par /auth/me, /auth/login, /auth/setup et /auth/password
export const session = reactive({ authenticated: null, username: null, mustChange: false, setupRequired: false });

export function setSession(me) {
  Object.assign(session, {
    authenticated: Boolean(me?.authenticated),
    username: me?.username ?? null,
    mustChange: Boolean(me?.mustChange),
    setupRequired: Boolean(me?.setupRequired),
  });
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // réponse vide
  }
  if (res.status === 401 && !path.startsWith('/auth/')) session.authenticated = false;
  if (res.status === 403 && data?.code === 'password_change_required') session.mustChange = true;
  if (!res.ok) throw new ApiError(data?.error || `Erreur HTTP ${res.status}`, res.status, data?.code);
  return data;
}

/** Flux temps réel (Server-Sent Events) : débits, événements, état de la collecte. */
export function openLive(handlers) {
  const source = new EventSource('/api/live');
  for (const [type, handler] of Object.entries(handlers)) {
    source.addEventListener(type, (e) => handler(JSON.parse(e.data)));
  }
  return () => source.close();
}
