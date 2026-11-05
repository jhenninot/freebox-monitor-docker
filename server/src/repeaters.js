// Suivi des répéteurs Wi-Fi Freebox : déconnexion de la box puis retour, échecs de mise à jour ou de redémarrage,
// redémarrage demandé depuis l'interface puis retour. Fonction pure : la mémoire est gardée en base par le collecteur.

/** Durée lisible : « 2 min 40 s », « 1 h 05 min », « 3 j 2 h ». */
export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${s} s`;
}

// Après une demande de redémarrage : suivi jusqu'au retour, abandonné (avec alerte) au-delà de ce délai
export const REBOOT_GIVE_UP_SECONDS = 15 * 60;
const FAILURES = { reboot_failure: 'échec du redémarrage', update_failure: 'échec de la mise à jour' };

/**
 * repeaters : sortie de toRepeater ; memory : { [key]: { online, status, bootTime, downSince, downAlerted } } ;
 * requests : { [key]: { ts, by, sawDown } } demandes de redémarrage en cours ; settings : réglages d'alertes.
 * Renvoie { alerts: [{ type, message, priority, push }], memory, requests }.
 */
export function evaluateRepeaters(repeaters, { memory = {}, requests = {}, settings, now }) {
  const alerts = [];
  const nextMemory = { ...memory };
  const nextRequests = { ...requests };
  const threshold = (settings.offlineMinutes ?? 10) * 60;
  const push = Boolean(settings.repeaters);

  for (const r of repeaters) {
    const before = memory[r.key];
    const request = nextRequests[r.key] ? { ...nextRequests[r.key] } : null;
    const state = {
      online: r.online,
      status: r.status,
      bootTime: r.bootTime ?? before?.bootTime ?? null,
      downSince: before?.downSince ?? null,
      downAlerted: before?.downAlerted ?? false,
    };
    const running = r.online !== false && (r.status === null || r.status === 'running');

    if (request) {
      if (r.online === false || ['rebooting', 'starting'].includes(r.status)) request.sawDown = true;
      const rebooted = request.sawDown || (r.bootTime && r.bootTime >= request.ts - 5);
      if (rebooted && running) {
        alerts.push({
          type: 'repeater_reboot',
          message: `${r.name} de retour après ${duration(now - request.ts)} (redémarrage demandé par ${request.by})`,
          push,
        });
        delete nextRequests[r.key];
        state.downSince = null;
        state.downAlerted = false;
      } else if (now - request.ts > REBOOT_GIVE_UP_SECONDS) {
        alerts.push({ type: 'repeater_down', message: `${r.name} n'est pas revenu ${duration(REBOOT_GIVE_UP_SECONDS)} après la demande de redémarrage`, priority: 4, push });
        delete nextRequests[r.key];
        state.downAlerted = true;
        state.downSince = state.downSince ?? request.ts;
      } else {
        nextRequests[r.key] = request;
      }
    }

    if (before) {
      // Redémarrage que personne n'a demandé ici (coupure de courant, mise à jour...)
      if (!request && before.bootTime && r.bootTime && r.bootTime > before.bootTime + 60) {
        alerts.push({ type: 'repeater_reboot', message: `${r.name} a redémarré${r.firmware ? ` (firmware ${r.firmware})` : ''}`, push });
      }
      if (FAILURES[r.status] && before.status !== r.status) {
        alerts.push({ type: 'repeater_failure', message: `${r.name} : ${FAILURES[r.status]}`, priority: 4, push });
      }
      if (r.online === false) {
        state.downSince = state.downSince ?? (r.lastSeen && r.lastSeen <= now ? r.lastSeen : now);
        // Pendant le suivi d'une demande de redémarrage, pas d'alerte : l'abandon du suivi en donne une
        if (!state.downAlerted && !nextRequests[r.key] && now - state.downSince >= threshold) {
          if (settings.repeaters) {
            alerts.push({ type: 'repeater_down', message: `${r.name} est déconnecté de la Freebox depuis ${duration(now - state.downSince)}`, priority: 4, push });
          }
          state.downAlerted = true;
        }
      } else if (r.online === true) {
        if (state.downAlerted && settings.repeaters) {
          alerts.push({ type: 'repeater_back', message: `${r.name} est de nouveau connecté à la Freebox`, push });
        }
        state.downSince = null;
        state.downAlerted = false;
      }
    } else if (r.online === false) {
      state.downSince = r.lastSeen && r.lastSeen <= now ? r.lastSeen : now;
    }
    nextMemory[r.key] = state;
  }
  return { alerts, memory: nextMemory, requests: nextRequests };
}
