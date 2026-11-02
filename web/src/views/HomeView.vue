<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import RateChart from '../components/RateChart.vue';
import { bits, bytes, date, duration, EVENT_LABELS, MEDIA, rate, STATE } from '../format.js';
import { live } from '../live.js';

const RANGES = [
  { id: 'live', label: 'Direct', seconds: 300 },
  { id: '1h', label: '1 h', seconds: 3600 },
  { id: '24h', label: '24 h', seconds: 86400 },
  { id: '7d', label: '7 j', seconds: 7 * 86400 },
  { id: '30d', label: '30 j', seconds: 30 * 86400 },
  { id: '1y', label: '1 an', seconds: 365 * 86400 },
];

const overview = ref(null);
const range = ref('live');
const history = ref([]);
const error = ref('');

const connection = computed(() => live.connection ?? overview.value?.connection);
const system = computed(() => live.system ?? overview.value?.system);
const labels = computed(() => overview.value?.labels ?? {});
const rangeSeconds = computed(() => RANGES.find((r) => r.id === range.value).seconds);
const points = computed(() => (range.value === 'live' ? live.recent : history.value));

async function load() {
  try {
    overview.value = await api('/overview');
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}

async function loadHistory() {
  if (range.value === 'live') return;
  const r = await api(`/metrics?keys=wan.down,wan.up&range=${range.value}`);
  const up = new Map(r.series['wan.up'].map(([t, avg]) => [t, avg]));
  history.value = r.series['wan.down'].map(([t, avg]) => [t, avg, up.get(t) ?? null]);
}

onMounted(load);
watch(range, loadHistory);
watch(() => live.lastEvent, load);
watch(() => live.devicesVersion, load);
</script>

<template>
  <section>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="grid">
      <article class="card">
        <h2>Connexion Internet</h2>
        <template v-if="connection">
          <p class="status">
            <span class="dot" :class="connection.state === 'up' ? 'ok' : 'bad'" />
            {{ STATE[connection.state] ?? connection.state }} · {{ MEDIA[connection.media] ?? connection.media }}
          </p>
          <div class="rates">
            <div><span class="label">Descendant</span><strong class="down">{{ rate(connection.rateDown) }}</strong><span class="muted">max {{ bits(connection.bandwidthDown) }}</span></div>
            <div><span class="label">Montant</span><strong class="up">{{ rate(connection.rateUp) }}</strong><span class="muted">max {{ bits(connection.bandwidthUp) }}</span></div>
          </div>
          <dl>
            <dt>IPv4</dt><dd>{{ connection.ipv4 ?? '—' }}<span v-if="connection.ipv4PortRange" class="muted"> (partagée, ports {{ connection.ipv4PortRange.join('–') }})</span></dd>
            <dt>IPv6</dt><dd class="wrap">{{ connection.ipv6 ?? '—' }}</dd>
            <dt>Échangé</dt><dd>↓ {{ bytes(connection.bytesDown) }} · ↑ {{ bytes(connection.bytesUp) }}</dd>
          </dl>
        </template>
        <p v-else class="muted">En attente de la première mesure…</p>
      </article>

      <article class="card">
        <h2>Freebox Server</h2>
        <template v-if="system">
          <dl>
            <dt>Modèle</dt><dd>{{ system.model ?? '—' }}</dd>
            <dt>Firmware</dt><dd>{{ system.firmware ?? '—' }}</dd>
            <dt>Allumée depuis</dt><dd>{{ duration(system.uptime) }}</dd>
            <template v-for="s in system.sensors" :key="s.id">
              <dt>{{ labels[s.id] ?? s.name }}</dt><dd>{{ s.value }} °C</dd>
            </template>
            <template v-for="f in system.fans" :key="f.id">
              <dt>{{ labels[f.id] ?? f.name }}</dt><dd>{{ f.value }} tr/min</dd>
            </template>
          </dl>
        </template>
        <p v-else class="muted">En attente de la première mesure…</p>
        <p v-if="overview" class="muted">
          <RouterLink to="/appareils">{{ overview.devices.online }} appareils en ligne</RouterLink> sur {{ overview.devices.total }} connus
        </p>
      </article>
    </div>

    <article class="card">
      <div class="row between">
        <h2>Débits</h2>
        <div class="tabs">
          <button v-for="r in RANGES" :key="r.id" :class="{ active: range === r.id }" @click="range = r.id">{{ r.label }}</button>
        </div>
      </div>
      <RateChart :points="points" :range="rangeSeconds" />
      <p class="muted small">{{ range === 'live' ? 'Mesures en direct depuis l\'ouverture de la page' : 'Moyennes enregistrées par le serveur' }}</p>
    </article>

    <article v-if="overview?.events.length" class="card">
      <div class="row between">
        <h2>Derniers événements</h2>
        <RouterLink to="/journal">Tout le journal</RouterLink>
      </div>
      <ul class="events">
        <li v-for="e in overview.events" :key="e.id">
          <span class="tag" :class="e.type">{{ EVENT_LABELS[e.type] ?? e.type }}</span>
          <span>{{ e.message }}</span>
          <span class="muted small">{{ date(e.ts) }}</span>
        </li>
      </ul>
    </article>
  </section>
</template>
