<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { ago, HOST_TYPES } from '../format.js';
import { live } from '../live.js';

const devices = ref([]);
const search = ref('');
const filter = ref('all'); // all, online, offline, watched
const sort = ref('name');
const showHidden = ref(false);
const error = ref('');

async function load() {
  try {
    devices.value = await api('/devices');
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(load);
watch(() => live.devicesVersion, load);

const ipValue = (ip) => (ip ? ip.split('.').reduce((acc, n) => acc * 256 + Number(n), 0) : Infinity);

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  const list = devices.value.filter((d) => {
    if (filter.value === 'online' && !d.online) return false;
    if (filter.value === 'offline' && d.online) return false;
    if (filter.value === 'watched' && !d.watched) return false;
    if (!q) return true;
    return [d.name, d.ipv4, d.mac, d.vendor].some((v) => v?.toLowerCase().includes(q));
  });
  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name, 'fr'),
    ip: (a, b) => ipValue(a.ipv4) - ipValue(b.ipv4),
    activity: (a, b) => b.lastSeen - a.lastSeen,
    vendor: (a, b) => (a.vendor ?? '~').localeCompare(b.vendor ?? '~', 'fr'),
  };
  return list.sort((a, b) => Number(b.online) - Number(a.online) || sorters[sort.value](a, b));
});
const shown = computed(() => visible.value.filter((d) => !d.hidden));
const hidden = computed(() => visible.value.filter((d) => d.hidden));

async function toggle(device, field) {
  const updated = await api(`/devices/${encodeURIComponent(device.key)}`, { method: 'PATCH', body: { [field]: !device[field] } });
  Object.assign(device, updated);
}
</script>

<template>
  <section>
    <div class="toolbar">
      <input v-model="search" type="search" placeholder="Nom, IP, MAC, fabricant">
      <select v-model="filter">
        <option value="all">Tous</option>
        <option value="online">En ligne</option>
        <option value="offline">Hors ligne</option>
        <option value="watched">Surveillés</option>
      </select>
      <select v-model="sort">
        <option value="name">Tri par nom</option>
        <option value="ip">Tri par IP</option>
        <option value="activity">Tri par activité</option>
        <option value="vendor">Tri par fabricant</option>
      </select>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <p class="muted small">{{ shown.length }} appareils affichés · ⭐ = surveillé (alerte s'il passe hors ligne)</p>

    <ul class="devices">
      <li v-for="d in shown" :key="d.key" :class="{ offline: !d.online }">
        <button class="star" :class="{ on: d.watched }" :title="d.watched ? 'Ne plus surveiller' : 'Surveiller'" @click="toggle(d, 'watched')">★</button>
        <RouterLink :to="`/appareils/${encodeURIComponent(d.key)}`" class="device">
          <span class="dot" :class="d.online ? 'ok' : 'off'" />
          <span class="name">{{ d.name }}</span>
          <span class="muted small">{{ HOST_TYPES[d.hostType] ?? d.hostType }}<template v-if="d.vendor"> · {{ d.vendor }}</template></span>
          <span class="ip">{{ d.ipv4 ?? '' }}</span>
          <span class="muted small">{{ d.online ? (d.link === 'wifi' ? `Wi-Fi ${d.wifiBand ?? ''}` : d.link === 'ethernet' ? 'Câble' : 'En ligne') : ago(d.lastSeen) }}</span>
        </RouterLink>
        <button class="ghost small" @click="toggle(d, 'hidden')">Masquer</button>
      </li>
    </ul>

    <template v-if="hidden.length">
      <button class="ghost" @click="showHidden = !showHidden">Appareils masqués ({{ hidden.length }})</button>
      <ul v-if="showHidden" class="devices">
        <li v-for="d in hidden" :key="d.key" class="offline">
          <span class="star" />
          <RouterLink :to="`/appareils/${encodeURIComponent(d.key)}`" class="device">
            <span class="dot" :class="d.online ? 'ok' : 'off'" />
            <span class="name">{{ d.name }}</span>
            <span class="muted small">{{ d.vendor }}</span>
            <span class="ip">{{ d.ipv4 ?? '' }}</span>
            <span class="muted small">{{ d.online ? 'En ligne' : ago(d.lastSeen) }}</span>
          </RouterLink>
          <button class="ghost small" @click="toggle(d, 'hidden')">Afficher</button>
        </li>
      </ul>
    </template>
  </section>
</template>
