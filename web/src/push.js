// Notifications push du navigateur (PWA) : abonnement de cet appareil auprès du serveur.
import { api } from './api.js';

const b64uToBytes = (text) => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const sameKey = (buffer, text) => {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  const b = b64uToBytes(text);
  return a.length === b.length && a.every((v, i) => v === b[i]);
};

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/**
 * Ce que permet ce navigateur : 'ok', 'insecure' (pas de HTTPS), 'ios-install' (iPhone : installer d'abord
 * l'appli sur l'écran d'accueil), 'unsupported', ou 'denied' (notifications bloquées par l'utilisateur).
 */
export function pushSupport() {
  if (!window.isSecureContext) return 'insecure';
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

/** Nom lisible de cet appareil, pour la liste des abonnés. */
export function deviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  const os = /Android/.test(ua) ? 'Android' : isIos() ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os, isStandalone() ? 'appli' : ''].filter(Boolean).join(' · ');
}

async function registration() {
  return navigator.serviceWorker.getRegistration('/') ?? navigator.serviceWorker.register('/sw.js');
}

/** Abonnement actuel de ce navigateur (null s'il n'est pas abonné). */
export async function currentSubscription() {
  if (pushSupport() !== 'ok') return null;
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Demande l'autorisation, abonne ce navigateur et l'enregistre sur le serveur. */
export async function enablePush(publicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications refusées : autorise-les pour ce site dans les réglages du navigateur');
  await navigator.serviceWorker.register('/sw.js');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // Clé du serveur changée (APP_SECRET modifié...) : l'ancien abonnement ne sert plus
  if (sub && !sameKey(sub.options?.applicationServerKey, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
  return api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), label: deviceLabel() } });
}

/** Désabonne ce navigateur (ou un autre appareil de la liste, par son adresse d'abonnement). */
export async function disablePush(endpoint) {
  const sub = await currentSubscription().catch(() => null);
  if (sub && (!endpoint || sub.endpoint === endpoint)) {
    endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => null);
  }
  return api('/push/unsubscribe', { method: 'POST', body: { endpoint } });
}
