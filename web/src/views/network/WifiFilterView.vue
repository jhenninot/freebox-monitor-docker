<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api.js';

const MODES = { disabled: 'Désactivé', whitelist: 'Liste blanche', blacklist: 'Liste noire' };
const data = ref(null);
const error = ref('');
const message = ref('');
const busy = ref(false);
const form = ref({ mac: '', type: 'blacklist', comment: '' });

async function load() {
  try {
    data.value = await api('/wifi-filter');
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(load);

async function act(fn, done) {
  error.value = '';
  message.value = '';
  busy.value = true;
  try {
    data.value = await fn();
    message.value = done;
    return true;
  } catch (e) {
    error.value = e.message;
    return false;
  } finally {
    busy.value = false;
  }
}

const whitelist = computed(() => data.value?.entries.filter((e) => e.type === 'whitelist') ?? []);
const blacklist = computed(() => data.value?.entries.filter((e) => e.type === 'blacklist') ?? []);
const viewerEntry = computed(() => data.value?.entries.find((e) => e.viewer) ?? null);

function setMode(mode) {
  const d = data.value;
  let body = { mode };
  if (mode === 'whitelist' && d.missingForWhitelist.length) {
    const names = d.missingForWhitelist.map((m) => (m.viewer ? `${m.name} (l'appareil que tu utilises)` : m.name)).join(', ');
    const add = window.confirm(`Ces appareils connectés perdraient le Wi-Fi en liste blanche : ${names}.\n\nOK : les ajouter à la liste blanche puis l'activer.\nAnnuler : ne rien changer.`);
    if (!add) return;
    body = { mode, addMissing: true };
  }
  if (mode === 'blacklist' && viewerEntry.value?.type === 'blacklist'
    && !window.confirm('L\'appareil que tu utilises est en liste noire : il perdra le Wi-Fi. Continuer ?')) return;
  if (mode === 'blacklist' && blacklist.value.length
    && !window.confirm(`${blacklist.value.length} appareil(s) en liste noire perdront le Wi-Fi. Activer la liste noire ?`)) return;
  act(() => api('/wifi-filter/mode', { method: 'PUT', body }), `Filtrage : ${MODES[mode]}`);
}

async function add() {
  if (data.value.viewer && form.value.mac.toUpperCase().replace(/-/g, ':') === data.value.viewer.mac && form.value.type === 'blacklist'
    && data.value.mode === 'blacklist' && !window.confirm('C\'est l\'appareil que tu utilises : il perdra le Wi-Fi. Continuer ?')) return;
  const ok = await act(() => api('/wifi-filter', { method: 'POST', body: form.value }), 'Appareil ajouté');
  if (ok) form.value = { mac: '', type: form.value.type, comment: '' };
}

function move(e) {
  const type = e.type === 'whitelist' ? 'blacklist' : 'whitelist';
  act(() => api(`/wifi-filter/${encodeURIComponent(e.id)}`, { method: 'PUT', body: { type, comment: e.comment } }), `${e.name} passé en ${MODES[type].toLowerCase()}`);
}

function remove(e) {
  if (data.value.mode === 'whitelist' && e.type === 'whitelist'
    && !window.confirm(`${e.name} perdra le Wi-Fi (liste blanche active). Le retirer ?`)) return;
  act(() => api(`/wifi-filter/${encodeURIComponent(e.id)}`, { method: 'DELETE' }), `${e.name} retiré`);
}

const pickDevice = (ev) => {
  const d = data.value.devices.find((x) => x.mac === ev.target.value);
  if (d) form.value = { ...form.value, mac: d.mac, comment: d.name };
  ev.target.value = '';
};
</script>

<template>
  <section>
    <RouterLink to="/reseau" class="muted">← Réseau</RouterLink>
    <h1>Filtrage Wi-Fi</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="message" class="ok">{{ message }}</p>
    <template v-if="data">
      <article class="card">
        <h2>Mode</h2>
        <div class="tabs">
          <button v-for="(label, m) in MODES" :key="m" :class="{ active: data.mode === m }" :disabled="busy" @click="data.mode !== m && setMode(m)">{{ label }}</button>
        </div>
        <p class="muted small">
          <template v-if="data.mode === 'whitelist'">Seuls les appareils de la liste blanche se connectent au Wi-Fi.</template>
          <template v-else-if="data.mode === 'blacklist'">Les appareils de la liste noire ne peuvent pas se connecter au Wi-Fi.</template>
          <template v-else>Tous les appareils peuvent se connecter au Wi-Fi (avec le mot de passe).</template>
          Les appareils en câble ne sont jamais concernés.
        </p>
        <p v-if="data.viewer" class="muted small">Tu consultes depuis {{ data.viewer.name }} ({{ data.viewer.mac }}).</p>
      </article>

      <div class="grid">
        <article v-for="group in [{ type: 'whitelist', title: 'Liste blanche', items: whitelist }, { type: 'blacklist', title: 'Liste noire', items: blacklist }]" :key="group.type" class="card">
          <h2>{{ group.title }} ({{ group.items.length }})</h2>
          <ul v-if="group.items.length" class="plain">
            <li v-for="e in group.items" :key="e.id">
              <span>
                <RouterLink v-if="e.device" :to="`/appareils/${encodeURIComponent(e.device.key)}`">{{ e.name }}</RouterLink>
                <template v-else>{{ e.name }}</template>
                <span v-if="e.viewer" class="badge gone">toi</span>
                <span v-if="e.onWifi" class="badge gone">en Wi-Fi</span>
                <div class="small muted">{{ e.mac }}</div>
              </span>
              <span class="row">
                <button class="ghost small" :disabled="busy" @click="move(e)">→ {{ e.type === 'whitelist' ? 'noire' : 'blanche' }}</button>
                <button class="danger small" :disabled="busy" @click="remove(e)">Retirer</button>
              </span>
            </li>
          </ul>
          <p v-else class="muted">Vide.</p>
        </article>
      </div>

      <article class="card">
        <h2>Ajouter un appareil</h2>
        <form class="row" @submit.prevent="add">
          <select aria-label="Choisir un appareil" @change="pickDevice">
            <option value="">Appareil connu…</option>
            <option v-for="d in data.devices" :key="d.key" :value="d.mac">{{ d.name }}</option>
          </select>
          <input v-model="form.mac" placeholder="AA:BB:CC:DD:EE:FF" required aria-label="Adresse MAC">
          <input v-model="form.comment" placeholder="Commentaire" aria-label="Commentaire">
          <select v-model="form.type" aria-label="Liste"><option value="whitelist">Liste blanche</option><option value="blacklist">Liste noire</option></select>
          <button :disabled="busy">Ajouter</button>
        </form>
      </article>
    </template>
  </section>
</template>
