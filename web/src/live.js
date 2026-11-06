// État temps réel partagé par les écrans, alimenté par /api/live
import { reactive } from 'vue';
import { openLive } from './api.js';

export const live = reactive({
  connection: null,
  system: null,
  status: null,
  lastEvent: null,
  // Incrémenté à chaque changement de la liste des appareils : les écrans se rechargent
  devicesVersion: 0,
  // Dernier relevé du trafic par appareil
  traffic: null,
  // Dernière progression de scan de ports reçue : { deviceKey, running, done, total, found, identifying }
  scan: null,
  // Répéteurs Wi-Fi : { ts, items }
  repeaters: null,
  // Test de débit en cours ou dernier terminé (voir SpeedtestDialog)
  speedtest: null,
  // Débits des 5 dernières minutes pour le graphique « en direct »
  recent: [],
});

let close = null;

export function startLive() {
  if (close) return;
  close = openLive({
    connection(c) {
      live.connection = c;
      // Le serveur renvoie la dernière mesure connue à chaque reconnexion : pas de doublon
      if (live.recent.length && live.recent.at(-1)[0] >= c.ts) return;
      live.recent.push([c.ts, c.rateDown, c.rateUp]);
      const limit = c.ts - 300;
      while (live.recent.length && live.recent[0][0] < limit) live.recent.shift();
    },
    system(s) { live.system = s; },
    status(s) { live.status = s; },
    event(e) { live.lastEvent = e; },
    devices() { live.devicesVersion += 1; },
    traffic(t) { live.traffic = t; },
    scan(p) { live.scan = p; },
    repeaters(r) { live.repeaters = r; },
    speedtest(s) { live.speedtest = s; },
  });
}

export function stopLive() {
  close?.();
  close = null;
}
