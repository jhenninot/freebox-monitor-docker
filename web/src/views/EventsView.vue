<script setup>
import { onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import PushCard from '../components/PushCard.vue';
import { date, EVENT_LABELS } from '../format.js';
import { live } from '../live.js';

const events = ref([]);
const more = ref(true);
const settings = ref(null);
const info = ref('');
const error = ref('');

async function load() {
  events.value = await api('/events?limit=100');
  more.value = events.value.length === 100;
}

async function loadMore() {
  const last = events.value.at(-1);
  const next = await api(`/events?limit=100&before=${last.id}`);
  events.value.push(...next);
  more.value = next.length === 100;
}

onMounted(async () => {
  try {
    await load();
    settings.value = await api('/alerts/settings');
  } catch (e) {
    error.value = e.message;
  }
});
watch(() => live.lastEvent, (e) => { if (e) events.value.unshift(e); });

async function save() {
  info.value = '';
  error.value = '';
  try {
    const { newDevices, offline, offlineMinutes, nightlyScan, nightlyScanHour, firmware, firmwareRss, repeaters } = settings.value;
    const body = { newDevices, offline, offlineMinutes, nightlyScan, nightlyScanHour, firmware, firmwareRss, repeaters };
    Object.assign(settings.value, await api('/alerts/settings', { method: 'PUT', body }));
    info.value = 'Réglages enregistrés';
  } catch (e) {
    error.value = e.message;
  }
}

</script>

<template>
  <section>
    <article v-if="settings" class="card">
      <h2>Alertes</h2>
      <form @submit.prevent="save">
        <label class="check"><input v-model="settings.newDevices" type="checkbox"> Nouvel appareil sur le réseau</label>
        <label class="check"><input v-model="settings.offline" type="checkbox"> Appareil surveillé hors ligne, puis de retour</label>
        <label class="inline">
          Hors ligne après
          <input v-model.number="settings.offlineMinutes" type="number" min="1" max="1440"> min sans réponse
        </label>
        <label class="check"><input v-model="settings.nightlyScan" type="checkbox"> Port qui s'ouvre sur un appareil surveillé (scan rapide chaque nuit)</label>
        <label v-if="settings.nightlyScan" class="inline">
          Scan à
          <select v-model.number="settings.nightlyScanHour">
            <option v-for="h in 24" :key="h - 1" :value="h - 1">{{ h - 1 }} h</option>
          </select>
        </label>
        <label class="check"><input v-model="settings.repeaters" type="checkbox"> Répéteur Wi-Fi déconnecté de la box (même délai), redémarré, en échec de mise à jour</label>
        <label class="check"><input v-model="settings.firmware" type="checkbox"> Notification quand le firmware de la box ou d'un répéteur est mis à jour, ou quand la box signale une mise à jour en attente (toujours inscrit au journal)</label>
        <label class="check"><input v-model="settings.firmwareRss" type="checkbox"> Nouvelle version annoncée par Free sur son blog pour ta box ou tes répéteurs (flux RSS, lu toutes les 6 h)</label>
        <p class="muted small">Les coupures Internet, changements d'IP publique, redémarrages et surchauffe de la box sont toujours signalés.</p>
        <div class="row">
          <button>Enregistrer</button>
        </div>
      </form>
      <p v-if="info" class="ok">{{ info }}</p>
    </article>
    <PushCard v-if="settings" />
    <p v-if="error" class="error">{{ error }}</p>

    <article class="card">
      <h2>Journal</h2>
      <ul v-if="events.length" class="events">
        <li v-for="e in events" :key="e.id">
          <span class="tag" :class="e.type">{{ EVENT_LABELS[e.type] ?? e.type }}</span>
          <span>
            <RouterLink v-if="e.deviceKey" :to="`/appareils/${encodeURIComponent(e.deviceKey)}`">{{ e.message }}</RouterLink>
            <template v-else>{{ e.message }}</template>
          </span>
          <span class="muted small">{{ date(e.ts) }}</span>
        </li>
      </ul>
      <p v-else class="muted">Rien pour l'instant. La première vérification mémorise les appareils présents sans alerter.</p>
      <button v-if="more && events.length" class="ghost" @click="loadMore">Plus ancien</button>
    </article>
  </section>
</template>
