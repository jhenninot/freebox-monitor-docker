// Alertes : nouvel appareil sur le réseau, appareil surveillé hors ligne puis de retour.
// evaluateAlerts est la traduction de domain/Alerts.kt (appli Android), en fonction pure testée.

export const DEFAULT_ALERT_SETTINGS = {
  newDevices: true,
  offline: true,
  // Délai sans réponse avant de considérer un appareil surveillé hors ligne
  offlineMinutes: 10,
  // Scan de ports de nuit des appareils surveillés : alerte si un port s'ouvre
  nightlyScan: true,
  nightlyScanHour: 3,
  // Firmware de la box ou d'un répéteur mis à jour : notification push (toujours inscrit au journal)
  firmware: true,
  // Répéteur Wi-Fi déconnecté de la box (même délai que les appareils), échec de mise à jour ou de redémarrage
  repeaters: true,
};

/** Normalise des réglages reçus de l'interface. */
export function cleanAlertSettings(input = {}, current = DEFAULT_ALERT_SETTINGS) {
  const minutes = Number.parseInt(input.offlineMinutes ?? current.offlineMinutes, 10);
  const hour = Number.parseInt(input.nightlyScanHour ?? current.nightlyScanHour, 10);
  const defaults = DEFAULT_ALERT_SETTINGS;
  return {
    nightlyScan: typeof input.nightlyScan === 'boolean' ? input.nightlyScan : (current.nightlyScan ?? defaults.nightlyScan),
    nightlyScanHour: Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : (current.nightlyScanHour ?? defaults.nightlyScanHour),
    newDevices: typeof input.newDevices === 'boolean' ? input.newDevices : current.newDevices,
    offline: typeof input.offline === 'boolean' ? input.offline : current.offline,
    firmware: typeof input.firmware === 'boolean' ? input.firmware : (current.firmware ?? defaults.firmware),
    repeaters: typeof input.repeaters === 'boolean' ? input.repeaters : (current.repeaters ?? defaults.repeaters),
    offlineMinutes: Number.isFinite(minutes) ? Math.min(Math.max(minutes, 1), 24 * 60) : current.offlineMinutes,
  };
}

/**
 * Compare la liste actuelle des appareils à ce qui a été vu avant.
 * memory = { known: [clés], down: [clés], initialized } ; watched = Set des clés surveillées.
 * La première vérification ne signale rien : elle mémorise.
 */
export function evaluateAlerts(devices, settings, watched, memory, nowSeconds) {
  const keys = devices.map((d) => d.key);
  if (!memory?.initialized) {
    const down = devices.filter((d) => watched.has(d.key) && !d.online).map((d) => d.key);
    return { newDevices: [], wentDown: [], cameBack: [], memory: { known: keys, down, initialized: true } };
  }

  const known = new Set(memory.known);
  const wasDown = new Set(memory.down);
  const newDevices = settings.newDevices ? devices.filter((d) => !known.has(d.key)) : [];

  const threshold = settings.offlineMinutes * 60;
  const isDown = (d) => !d.online && nowSeconds - d.lastSeen >= threshold;
  const watchedDevices = devices.filter((d) => watched.has(d.key));
  const wentDown = watchedDevices.filter((d) => isDown(d) && !wasDown.has(d.key));
  const cameBack = watchedDevices.filter((d) => d.online && wasDown.has(d.key));

  const down = new Set([...wasDown, ...wentDown.map((d) => d.key)]);
  cameBack.forEach((d) => down.delete(d.key));
  // Un appareil qui n'est plus surveillé n'a plus à être retenu comme hors ligne
  [...down].forEach((k) => { if (!watched.has(k)) down.delete(k); });

  return {
    newDevices,
    wentDown: settings.offline ? wentDown : [],
    cameBack: settings.offline ? cameBack : [],
    memory: { known: [...new Set([...known, ...keys])], down: [...down], initialized: true },
  };
}
