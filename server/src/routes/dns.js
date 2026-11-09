// Serveurs DNS distribués aux appareils par le DHCP de la Freebox (dhcp/config/ → dns).
// La modification demande le droit « Modification des réglages de la Freebox ».
import { Resolver } from 'node:dns/promises';
import express from 'express';
import { cleanDnsList, dnsServersError, isValidIp, MAX_DHCP_DNS } from '../freebox/rules.js';
import { HttpError } from './box.js';

/** Serveurs publics proposés en un clic. */
export const DNS_PRESETS = [
  { id: 'cloudflare', name: 'Cloudflare', servers: ['1.1.1.1', '1.0.0.1'], text: 'Rapide, sans filtrage' },
  { id: 'cloudflare-family', name: 'Cloudflare Familles', servers: ['1.1.1.3', '1.0.0.3'], text: 'Bloque les logiciels malveillants et les contenus pour adultes' },
  { id: 'quad9', name: 'Quad9', servers: ['9.9.9.9', '149.112.112.112'], text: 'Bloque les domaines malveillants, basé en Suisse' },
  { id: 'google', name: 'Google', servers: ['8.8.8.8', '8.8.4.4'], text: 'Sans filtrage' },
  { id: 'fdn', name: 'FDN', servers: ['80.67.169.12', '80.67.169.40'], text: 'Associatif français, sans filtrage ni journalisation' },
];

const TEST_NAME = 'www.free.fr';

/** Interroge un serveur DNS pour vérifier qu'il répond, avec le temps de réponse. */
export async function testDnsServer(server, { name = TEST_NAME, timeout = 2000 } = {}) {
  const resolver = new Resolver({ timeout, tries: 1 });
  resolver.setServers([server]);
  const start = performance.now();
  try {
    const addresses = await resolver.resolve4(name);
    return { server, ok: true, ms: Math.round(performance.now() - start), addresses };
  } catch (e) {
    const error = { ETIMEOUT: 'Pas de réponse', ECONNREFUSED: 'Connexion refusée', ENOTFOUND: `Ne trouve pas ${name}` }[e.code];
    return { server, ok: false, error: error ?? `Erreur (${e.code ?? e.message})` };
  }
}

export function dnsRouter({ freebox, testServer = testDnsServer }) {
  const router = express.Router();

  const state = async () => {
    const config = (await freebox.get('dhcp/config/')) ?? {};
    return {
      enabled: Boolean(config.enabled),
      gateway: config.gateway ?? '',
      servers: cleanDnsList(config.dns),
      max: MAX_DHCP_DNS,
      presets: DNS_PRESETS,
    };
  };

  router.get('/dns', async (_req, res) => {
    res.json(await state());
  });

  router.put('/dns', async (req, res) => {
    const servers = req.body?.servers;
    const error = dnsServersError(servers);
    if (error) throw new HttpError(400, error);
    // La box attend toujours 5 cases : on complète avec des chaînes vides
    const dns = cleanDnsList(servers);
    while (dns.length < MAX_DHCP_DNS) dns.push('');
    await freebox.put('dhcp/config/', { dns });
    res.json(await state());
  });

  // Vérifie que des serveurs répondent avant de les distribuer à tout le réseau
  router.post('/dns/test', async (req, res) => {
    const servers = cleanDnsList(req.body?.servers);
    if (!servers.length) throw new HttpError(400, 'Indique au moins un serveur DNS');
    const invalid = servers.find((ip) => !isValidIp(ip));
    if (invalid) throw new HttpError(400, `Adresse IPv4 invalide : ${invalid}`);
    res.json({ name: TEST_NAME, results: await Promise.all(servers.slice(0, MAX_DHCP_DNS).map((s) => testServer(s))) });
  });

  return router;
}
