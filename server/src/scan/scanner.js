// Scan de ports TCP fait par le serveur (la Freebox ne sait pas le faire) : une connexion complète par port,
// sans droits particuliers. Traduction de data/PortScanner.kt.
import net from 'node:net';
import tls from 'node:tls';
import {
  cleanBanner, greetingBanner, httpBanner, KNOWN_SERVICES, mysqlBanner, serviceFromGreeting,
} from './services.js';

export const TIMEOUTS = { connect: 400, bannerConnect: 1500, greeting: 2000, response: 3000 };

/** Le port accepte-t-il une connexion ? Un port fermé répond tout de suite, un port filtré attend le délai. */
export function isOpen(ip, port, timeout = TIMEOUTS.connect) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Teste les ports avec `workers` connexions en parallèle. onProgress(testés) et onOpen(port) sont appelés au fil de l'eau.
 * signal (AbortSignal) arrête le scan : les ports déjà trouvés sont renvoyés. Résultat : ports ouverts triés.
 */
export async function scanPorts(ip, ports, { workers = 200, timeout, signal, onProgress = () => {}, onOpen = () => {} } = {}) {
  let next = 0;
  let done = 0;
  const open = [];
  const worker = async () => {
    while (!signal?.aborted) {
      const i = next++;
      if (i >= ports.length) return;
      if (await isOpen(ip, ports[i], timeout)) {
        open.push(ports[i]);
        onOpen(ports[i]);
      }
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, ports.length) }, worker));
  return open.sort((a, b) => a - b);
}

/** Ouvre une connexion, envoie `request` s'il y en a une et lit la réponse (jusqu'à `limit` octets). null si rien. */
export function readBytes(ip, port, { request = null, secure = false, limit = 1024 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let socket;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(readTimer);
      socket?.destroy();
      resolve(size ? Buffer.concat(chunks) : null);
    };
    let readTimer = null;
    const connectTimer = setTimeout(finish, TIMEOUTS.bannerConnect);
    const onReady = () => {
      clearTimeout(connectTimer);
      readTimer = setTimeout(finish, request ? TIMEOUTS.response : TIMEOUTS.greeting);
      if (request) socket.write(request);
    };
    // Les appareils du réseau local ont presque tous un certificat auto-signé : on l'accepte pour lire le titre de la page
    socket = secure
      ? tls.connect({ host: ip, port, rejectUnauthorized: false }, onReady)
      : net.connect({ host: ip, port }, onReady);
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      // Une bannière d'accueil tient en une ligne : inutile d'attendre la suite
      if (size >= limit || (!request && chunk.includes(10))) finish();
    });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
  });
}

async function webBanner(ip, port, secure) {
  const request = `GET / HTTP/1.0\r\nHost: ${ip}:${port}\r\nUser-Agent: FreeboxMonitor\r\nAccept: text/html\r\nConnection: close\r\n\r\n`;
  const bytes = await readBytes(ip, port, { request, secure, limit: 32 * 1024 });
  if (!bytes) return null;
  const text = bytes.toString('utf8');
  if (!text.startsWith('HTTP/')) return null;
  // nginx répond en clair « The plain HTTP request was sent to HTTPS port » : c'est un port HTTPS
  if (!secure && /sent to HTTPS port/i.test(text)) return null;
  return httpBanner(text) ?? 'HTTP';
}

/** Lit ce que le service ouvert sur `port` veut bien dire de lui. */
export async function identify(ip, port) {
  const known = KNOWN_SERVICES[port];
  const base = { port, service: known?.name ?? 'Inconnu', banner: null, web: Boolean(known?.web), tls: Boolean(known?.tls) };
  try {
    // Port web connu : on demande la page d'accueil (en HTTPS d'abord si c'est l'habitude)
    if (known?.web) {
      for (const secure of known.tls ? [true, false] : [false, true]) {
        const banner = await webBanner(ip, port, secure);
        if (banner) return { ...base, banner, web: true, tls: secure };
      }
      return base;
    }
    // Sinon on écoute : SSH, FTP, SMTP, POP3, IMAP, VNC, MySQL parlent les premiers
    const greeting = await readBytes(ip, port);
    if (greeting) {
      if (port === 3306) {
        const banner = mysqlBanner(greeting);
        if (banner) return { ...base, banner };
      }
      const text = greeting.toString('latin1');
      const service = serviceFromGreeting(text);
      if (service === 'HTTP') return { ...base, service: 'HTTP', banner: httpBanner(text), web: true };
      const banner = service === 'SSH' ? cleanBanner(text) : greetingBanner(text);
      return { ...base, service: !known && service ? service : base.service, banner };
    }
    // Silencieux : c'est peut-être une page web sur un port inhabituel
    for (const secure of [false, true]) {
      const banner = await webBanner(ip, port, secure);
      if (banner) return { ...base, service: known ? base.service : (secure ? 'HTTPS' : 'HTTP'), banner, web: true, tls: secure };
    }
  } catch {
    // On garde ce qu'on sait du port
  }
  return base;
}
