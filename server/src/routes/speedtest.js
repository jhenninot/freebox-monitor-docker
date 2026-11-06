// Test de débit Internet (Speedtest by Ookla lancé par le serveur, voir speedtest.js)
import express from 'express';

export function speedtestRouter({ speedtest, store }) {
  const router = express.Router();

  router.get('/speedtest', (_req, res) => {
    res.json({ ...speedtest.state(), history: store.listSpeedtests(20) });
  });

  router.post('/speedtest', async (req, res) => {
    res.json(await speedtest.start(req.user.username));
  });

  return router;
}
