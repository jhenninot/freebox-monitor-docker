<script setup>
// Équipements Free : Freebox Server et répéteurs Wi-Fi (firmware, état, redémarrage, LED)
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { ago, date, duration } from '../format.js';
import { live } from '../live.js';

const STATUS = {
  starting: 'Démarrage…', running: 'En marche', rebooting: 'Redémarrage…', updating: 'Mise à jour…',
  reboot_failure: 'Échec du redémarrage', update_failure: 'Échec de la mise à jour',
};
const DISK = { not_detected: 'Non détecté', disabled: 'Désactivé', initializing: 'Initialisation', error: 'En erreur', active: 'Actif' };

const data = ref(null);
const error = ref('');
const message = ref('');
const busy = ref(false);

async function load() {
  try {
    data.value = await api('/equipment');
    error.value = '';
  } catch (e) {
    // Pendant un redémarrage de la box, ce serveur peut être injoignable (VM de la Freebox) : on réessaie
    if (!boxPending.value) error.value = e.message;
  }
}

const system = computed(() => data.value?.box.system ?? null);
const boxRequest = computed(() => data.value?.box.rebootRequest ?? null);
const boxPending = computed(() => Boolean(boxRequest.value) && !(data.value.box.bootTs > boxRequest.value.ts));
const repeaters = computed(() => data.value?.repeaters.items ?? []);
const manage = computed(() => data.value?.canManage !== false);
const repeaterPending = (r) => Boolean(r.rebootRequest);

// Relecture rapide pendant un redémarrage, sinon toutes les 30 s
let timer;
function schedule() {
  clearTimeout(timer);
  const pending = boxPending.value || repeaters.value.some(repeaterPending);
  timer = setTimeout(async () => { await load(); schedule(); }, pending ? 5000 : 30000);
}
onMounted(async () => { await load(); schedule(); });
onUnmounted(() => clearTimeout(timer));
watch(() => live.repeaters, load);
watch(() => live.lastEvent, load);

async function act(fn, done) {
  error.value = '';
  message.value = '';
  busy.value = true;
  try {
    data.value = await fn();
    message.value = done;
    schedule();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

function rebootBox() {
  if (!window.confirm('Redémarrer la Freebox ?\n\nInternet, le Wi-Fi, la téléphonie et la TV seront coupés 2 à 3 minutes. '
    + 'Si ce serveur tourne dans une VM de la Freebox, il redémarre aussi : la page se reconnectera toute seule.')) return;
  act(() => api('/equipment/box/reboot', { method: 'POST', body: {} }), 'Redémarrage de la Freebox demandé');
}

function rebootRepeater(r) {
  const clients = r.clients ? ` Les ${r.clients} appareil(s) connecté(s) à ce répéteur perdront le Wi-Fi 1 à 2 minutes.` : '';
  if (!window.confirm(`Redémarrer ${r.name} ?${clients}`)) return;
  act(() => api(`/equipment/repeaters/${encodeURIComponent(r.id)}/reboot`, { method: 'POST', body: {} }), `Redémarrage de ${r.name} demandé`);
}

function toggleLed(r) {
  act(() => api(`/equipment/repeaters/${encodeURIComponent(r.id)}/led`, { method: 'PUT', body: { enabled: !r.led } }),
    `LED de ${r.name} ${r.led ? 'éteinte' : 'allumée'}`);
}

const dotClass = (r) => (r.online === false || /failure/.test(r.status ?? '') ? 'bad' : r.status && r.status !== 'running' ? 'off' : 'ok');
const time = (ts) => new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
</script>

<template>
  <section>
    <h1>Équipements Free</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="message" class="ok">{{ message }}</p>
    <p v-if="data && !manage" class="banner">
      Redémarrer et changer la LED demandent le droit « Modification des réglages » : dans Freebox OS, Paramètres &gt;
      Gestion des accès &gt; Applications, coche-le pour Freebox Monitor (serveur).
    </p>

    <article class="card">
      <div class="row between">
        <h2>Freebox Server</h2>
        <button class="danger small" :disabled="busy || !manage || boxPending || !system" @click="rebootBox">Redémarrer</button>
      </div>
      <p v-if="boxPending" class="banner">
        Redémarrage demandé par {{ boxRequest.by }} à {{ time(boxRequest.ts) }}. La box revient en 2 à 3 minutes ;
        le retour sera inscrit au journal.
      </p>
      <template v-if="system">
        <dl>
          <dt>Modèle</dt><dd>{{ system.model ?? '—' }}</dd>
          <dt>Firmware</dt>
          <dd>{{ system.firmware ?? '—' }} · <a href="https://dev.freebox.fr/blog/" target="_blank" rel="noopener">notes de version</a></dd>
          <template v-if="data.box.update?.state">
            <dt>Mise à jour</dt>
            <dd>
              <span class="dot" :class="data.box.update.state === 'up_to_date' ? 'ok' : 'bad'" />
              {{ data.box.update.state === 'up_to_date' ? 'Firmware à jour' : `En attente (${data.box.update.state})` }}
              <span class="muted small">· état calculé par la box à son démarrage</span>
            </dd>
          </template>
          <dt>Démarrée</dt><dd>{{ date(data.box.bootTs) }} <span class="muted">({{ duration(system.uptime) }})</span></dd>
          <dt>N° de série</dt><dd>{{ system.serial ?? '—' }}</dd>
          <dt>Adresse MAC</dt><dd>{{ system.mac ?? '—' }}</dd>
          <template v-if="system.diskStatus"><dt>Disque</dt><dd>{{ DISK[system.diskStatus] ?? system.diskStatus }}</dd></template>
        </dl>
        <details v-if="data.box.firmware.length">
          <summary>Historique du firmware</summary>
          <ul class="small">
            <li v-for="f in data.box.firmware" :key="f.id">
              {{ date(f.ts) }} : {{ f.version }}<span v-if="f.previous" class="muted"> (avant : {{ f.previous }})</span><span v-else class="muted"> (première version vue)</span>
            </li>
          </ul>
        </details>
      </template>
      <p v-else-if="data" class="muted">En attente de la première mesure…</p>
    </article>

    <h2>Répéteurs Wi-Fi</h2>
    <p v-if="data && !data.repeaters.supported" class="muted">Cette Freebox ne gère pas les répéteurs Wi-Fi.</p>
    <p v-else-if="data && !repeaters.length" class="muted">Aucun répéteur Wi-Fi Freebox associé à la box.</p>
    <div class="grid">
      <article v-for="r in repeaters" :key="r.key" class="card">
        <div class="row between">
          <h2 class="status"><span class="dot" :class="dotClass(r)" /> {{ r.name }}</h2>
          <span class="muted small">{{ r.online === false ? 'Déconnecté' : STATUS[r.status] ?? r.status ?? '' }}</span>
        </div>
        <p v-if="repeaterPending(r)" class="banner">Redémarrage demandé par {{ r.rebootRequest.by }} à {{ time(r.rebootRequest.ts) }}…</p>
        <dl>
          <dt>Firmware</dt><dd>{{ r.firmware ?? '—' }}</dd>
          <dt>Clients Wi-Fi</dt><dd>{{ r.clients }}</dd>
          <template v-if="r.bootTime"><dt>Démarré</dt><dd>{{ date(r.bootTime) }} <span class="muted">({{ ago(r.bootTime).replace('il y a ', '') }})</span></dd></template>
          <template v-if="r.online === false && r.lastSeen"><dt>Vu</dt><dd>{{ ago(r.lastSeen) }}</dd></template>
          <dt>LED</dt><dd>{{ r.led === null ? '—' : r.led ? 'Allumée' : 'Éteinte' }}</dd>
          <dt>Adresse MAC</dt><dd>{{ r.mac ?? '—' }}</dd>
          <dt>N° de série</dt><dd>{{ r.serial ?? '—' }}</dd>
        </dl>
        <div class="row">
          <button class="ghost small" :disabled="busy || !manage || r.led === null || r.online === false" @click="toggleLed(r)">
            {{ r.led ? 'Éteindre la LED' : 'Allumer la LED' }}
          </button>
          <button class="danger small" :disabled="busy || !manage || repeaterPending(r) || r.online === false" @click="rebootRepeater(r)">Redémarrer</button>
        </div>
        <details v-if="r.firmwareHistory.length">
          <summary>Historique du firmware</summary>
          <ul class="small">
            <li v-for="f in r.firmwareHistory" :key="f.id">
              {{ date(f.ts) }} : {{ f.version }}<span v-if="f.previous" class="muted"> (avant : {{ f.previous }})</span><span v-else class="muted"> (première version vue)</span>
            </li>
          </ul>
        </details>
      </article>
    </div>
    <p class="muted small">
      La Freebox et les répéteurs se mettent à jour seuls (en général la nuit) : l'API ne permet pas de lancer une mise à jour,
      mais chaque nouvelle version est inscrite au journal.
    </p>
  </section>
</template>
