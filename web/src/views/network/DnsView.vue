<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api.js';

const data = ref(null);
// Liste en cours de modification (copie de data.servers)
const servers = ref([]);
// Résultats du dernier test, par adresse
const tests = ref({});
const error = ref('');
const message = ref('');
const busy = ref(false);
const testing = ref(false);

async function load() {
  try {
    data.value = await api('/dns');
    servers.value = [...data.value.servers];
    if (!servers.value.length) servers.value = [''];
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(load);

const filled = computed(() => servers.value.map((s) => s.trim()).filter(Boolean));
const changed = computed(() => data.value && filled.value.join(',') !== data.value.servers.join(','));
// Sans la box dans la liste, les noms locaux (proxmox.home.arpa...) ne sont plus résolus
const withoutBox = computed(() => data.value?.gateway && filled.value.length && !filled.value.includes(data.value.gateway));

const presets = computed(() => (data.value
  ? [{ id: 'freebox', name: 'Freebox', servers: [data.value.gateway], text: 'La box répond elle-même (noms locaux compris)' }, ...data.value.presets]
  : []));
const isCurrent = (p) => p.servers.join(',') === filled.value.join(',');

function usePreset(p) {
  servers.value = [...p.servers];
  message.value = '';
}
function add() {
  if (servers.value.length < data.value.max) servers.value.push('');
}
function remove(i) {
  servers.value.splice(i, 1);
  if (!servers.value.length) servers.value.push('');
}
function move(i, delta) {
  const j = i + delta;
  [servers.value[i], servers.value[j]] = [servers.value[j], servers.value[i]];
}

async function test() {
  error.value = '';
  testing.value = true;
  try {
    const { results } = await api('/dns/test', { method: 'POST', body: { servers: filled.value } });
    tests.value = Object.fromEntries(results.map((r) => [r.server, r]));
  } catch (e) {
    error.value = e.message;
  } finally {
    testing.value = false;
  }
}

async function save() {
  const failing = filled.value.filter((s) => tests.value[s] && !tests.value[s].ok);
  const warn = failing.length ? `\n\nAttention : ${failing.join(', ')} n'a pas répondu au test.` : '';
  if (!window.confirm(`Distribuer ces serveurs DNS à tous les appareils du réseau ?\n${filled.value.join(', ')}${warn}`)) return;
  error.value = '';
  message.value = '';
  busy.value = true;
  try {
    data.value = await api('/dns', { method: 'PUT', body: { servers: filled.value } });
    servers.value = [...data.value.servers];
    message.value = 'Serveurs DNS enregistrés. Les appareils les prendront au renouvellement de leur bail DHCP (ou en se reconnectant).';
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section>
    <RouterLink to="/reseau" class="muted">← Réseau</RouterLink>
    <h1>DNS</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="message" class="ok">{{ message }}</p>
    <template v-if="data">
      <p class="muted small">
        Serveurs DNS que le DHCP de la box donne aux appareils, dans l'ordre de préférence.
        <template v-if="!data.enabled"> Le serveur DHCP de la box est désactivé : ce réglage n'a pas d'effet.</template>
      </p>

      <article class="card">
        <h2>Préréglages</h2>
        <div class="presets">
          <button v-for="p in presets" :key="p.id" class="ghost preset" :class="{ current: isCurrent(p) }" :title="p.text" @click="usePreset(p)">
            <strong>{{ p.name }}</strong>
            <span class="small muted">{{ p.servers.join(', ') }}</span>
          </button>
        </div>
        <p class="muted small">Un préréglage remplit la liste ci-dessous ; rien n'est envoyé à la box avant « Enregistrer ».</p>
      </article>

      <article class="card">
        <h2>Serveurs distribués</h2>
        <div v-for="(_, i) in servers" :key="i" class="row server-row">
          <span class="muted small rank">{{ i + 1 }}</span>
          <input v-model="servers[i]" class="ip-input" placeholder="192.168.1.x" :aria-label="`Serveur DNS ${i + 1}`">
          <button class="ghost small" :disabled="i === 0" title="Monter" @click="move(i, -1)">↑</button>
          <button class="ghost small" :disabled="i === servers.length - 1" title="Descendre" @click="move(i, 1)">↓</button>
          <button class="ghost small" title="Retirer" @click="remove(i)">✕</button>
          <span v-if="tests[servers[i].trim()]" class="small" :class="tests[servers[i].trim()].ok ? 'ok' : 'error'">
            <template v-if="tests[servers[i].trim()].ok">répond en {{ tests[servers[i].trim()].ms }} ms</template>
            <template v-else>{{ tests[servers[i].trim()].error }}</template>
          </span>
        </div>
        <p v-if="withoutBox" class="banner small">
          La box ({{ data.gateway }}) n'est pas dans la liste : les noms locaux des appareils (ex. <code>proxmox.home.arpa</code>) ne seront plus résolus,
          sauf si ton serveur DNS les relaie vers la box.
        </p>
        <div class="row">
          <button class="ghost" :disabled="servers.length >= data.max" @click="add">Ajouter un serveur</button>
          <button class="ghost" :disabled="testing || !filled.length" @click="test">{{ testing ? 'Test…' : 'Tester' }}</button>
          <button :disabled="busy || !changed || !filled.length" @click="save">Enregistrer</button>
        </div>
        <p class="muted small">Le test interroge chaque serveur depuis Freebox Monitor (résolution de www.free.fr). {{ data.max }} serveurs au plus, en IPv4.</p>
      </article>
    </template>
  </section>
</template>

<style scoped>
.presets { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
.preset { display: flex; flex-direction: column; align-items: flex-start; gap: 0.1rem; text-align: left; }
.preset.current { border-color: var(--accent); }
.server-row { margin-bottom: 0.5rem; }
.rank { width: 1rem; text-align: right; }
</style>
