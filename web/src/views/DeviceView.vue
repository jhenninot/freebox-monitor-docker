<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { ago, date, duration, EVENT_LABELS, HOST_TYPES } from '../format.js';
import { live } from '../live.js';

const props = defineProps({ deviceKey: { type: String, required: true } });
const device = ref(null);
const days = ref(7);
const newName = ref('');
const message = ref('');
const error = ref('');

async function load() {
  try {
    device.value = await api(`/devices/${encodeURIComponent(props.deviceKey)}?days=${days.value}`);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(load);
watch(days, load);
watch(() => live.devicesVersion, load);

const now = () => Math.floor(Date.now() / 1000);

// Part du temps en ligne sur la période affichée
const presence = computed(() => {
  if (!device.value) return null;
  const from = now() - days.value * 86400;
  const online = device.value.sessions.reduce((acc, s) => acc + Math.max(0, (s.end ?? now()) - Math.max(s.start, from)), 0);
  return Math.min(100, Math.round((online / (days.value * 86400)) * 100));
});

// Bandes de présence sur la période, en pourcentage de la largeur
const bands = computed(() => {
  if (!device.value) return [];
  const from = now() - days.value * 86400;
  const span = days.value * 86400;
  return device.value.sessions.map((s) => {
    const start = Math.max(s.start, from);
    const end = s.end ?? now();
    return { left: ((start - from) / span) * 100, width: Math.max(0.3, ((end - start) / span) * 100), title: `${date(s.start)} → ${s.end ? date(s.end) : 'maintenant'}` };
  });
});

async function setFlag(field, value) {
  device.value = { ...device.value, ...(await api(`/devices/${encodeURIComponent(props.deviceKey)}`, { method: 'PATCH', body: { [field]: value } })) };
}

async function rename() {
  message.value = '';
  error.value = '';
  try {
    await api(`/devices/${encodeURIComponent(props.deviceKey)}/name`, { method: 'PUT', body: { name: newName.value } });
    message.value = 'Nom changé dans la Freebox';
    newName.value = '';
    await load();
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <section v-if="device">
    <RouterLink to="/appareils" class="muted">← Appareils</RouterLink>
    <h1><span class="dot" :class="device.online ? 'ok' : 'off'" /> {{ device.name }}</h1>
    <div class="grid">
      <article class="card">
        <dl>
          <dt>État</dt><dd>{{ device.online ? 'En ligne' : `Hors ligne, vu ${ago(device.lastSeen)}` }}</dd>
          <dt>Type</dt><dd>{{ HOST_TYPES[device.hostType] ?? device.hostType }}</dd>
          <dt>IPv4</dt><dd>{{ device.ipv4 ?? '—' }}</dd>
          <dt>MAC</dt><dd>{{ device.mac ?? '—' }}</dd>
          <dt>Fabricant</dt><dd>{{ device.vendor ?? '—' }}</dd>
          <dt>Connexion</dt><dd>{{ device.link === 'wifi' ? `Wi-Fi ${device.wifiBand ?? ''}` : device.link === 'ethernet' ? 'Câble' : '—' }}</dd>
          <dt>Vu la 1re fois</dt><dd>{{ date(device.firstSeen) }}</dd>
        </dl>
        <label class="check"><input type="checkbox" :checked="device.watched" @change="setFlag('watched', $event.target.checked)"> Surveiller (alerte s'il passe hors ligne)</label>
        <label class="check"><input type="checkbox" :checked="device.hidden" @change="setFlag('hidden', $event.target.checked)"> Masquer dans la liste</label>
      </article>
      <article class="card">
        <h2>Renommer</h2>
        <form class="row" @submit.prevent="rename">
          <input v-model="newName" :placeholder="device.name" maxlength="64" required>
          <button>Enregistrer</button>
        </form>
        <p class="muted small">Le nom est changé dans la Freebox : il apparaît aussi dans Freebox OS et l'appli Android.</p>
        <p v-if="message" class="ok">{{ message }}</p>
        <p v-if="error" class="error">{{ error }}</p>
      </article>
    </div>

    <article class="card">
      <div class="row between">
        <h2>Présence</h2>
        <div class="tabs">
          <button v-for="d in [1, 7, 30]" :key="d" :class="{ active: days === d }" @click="days = d">{{ d }} j</button>
        </div>
      </div>
      <p>En ligne {{ presence }} % du temps sur {{ days }} jour{{ days > 1 ? 's' : '' }}.</p>
      <div class="presence">
        <span v-for="(b, i) in bands" :key="i" :style="{ left: `${b.left}%`, width: `${b.width}%` }" :title="b.title" />
      </div>
      <div class="row between muted small"><span>il y a {{ days }} j</span><span>maintenant</span></div>
      <table v-if="device.sessions.length">
        <thead><tr><th>Arrivée</th><th>Départ</th><th>Durée</th><th>IP</th></tr></thead>
        <tbody>
          <tr v-for="s in device.sessions.slice(0, 30)" :key="s.start">
            <td>{{ date(s.start) }}</td>
            <td>{{ s.end ? date(s.end) : 'en ligne' }}</td>
            <td>{{ duration((s.end ?? now()) - s.start) }}</td>
            <td>{{ s.ipv4 ?? '' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">Aucune présence enregistrée sur la période.</p>
    </article>

    <article v-if="device.events.length" class="card">
      <h2>Événements</h2>
      <ul class="events">
        <li v-for="e in device.events" :key="e.id">
          <span class="tag" :class="e.type">{{ EVENT_LABELS[e.type] ?? e.type }}</span>
          <span>{{ e.message }}</span>
          <span class="muted small">{{ date(e.ts) }}</span>
        </li>
      </ul>
    </article>
  </section>
  <p v-else-if="error" class="error">{{ error }}</p>
</template>
