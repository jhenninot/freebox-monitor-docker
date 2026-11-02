// Scans de ports d'un appareil, faits par le serveur
import express from 'express';
import { diffScans, portUrl } from '../scan/services.js';
import { HttpError } from './box.js';

export function scanRouter({ store, scans }) {
  const router = express.Router();

  const deviceOf = (req) => {
    const device = store.getDevice(req.params.key);
    if (!device) throw new HttpError(404, 'Appareil inconnu');
    return device;
  };
  const withUrls = (scan) => (scan ? { ...scan, ports: scan.ports.map((p) => ({ ...p, url: portUrl(scan.ip, p) })) } : null);

  // Dernier scan, différences avec le précédent, historique et scan en cours
  router.get('/devices/:key/scan', (req, res) => {
    const device = deviceOf(req);
    const [last, previous, ...older] = store.listPortScans(device.key);
    res.json({
      running: scans.progress(device.key),
      last: withUrls(last ?? null),
      diff: last ? diffScans(previous ?? null, last) : null,
      history: [last, previous, ...older].filter(Boolean)
        .map(({ id, ts, ip, full, stopped, nightly, ports }) => ({ id, ts, ip, full, stopped, nightly, ports: ports.map((p) => p.port) })),
    });
  });

  router.post('/devices/:key/scan', (req, res) => {
    const device = deviceOf(req);
    res.status(202).json(scans.start(device, { full: req.body?.full === true }));
  });

  router.delete('/devices/:key/scan', (req, res) => {
    const device = deviceOf(req);
    res.json({ stopped: scans.stop(device.key) });
  });

  return router;
}
