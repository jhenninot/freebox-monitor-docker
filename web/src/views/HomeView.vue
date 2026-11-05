<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../api.js';
import RateChart from '../components/RateChart.vue';
import { ago, bits, bytes, date, duration, EVENT_LABELS, MEDIA, rate, STATE } from '../format.js';
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
// Trafic par appareil
const trafficSort = ref('rate');
const trafficData = ref(null);
const showAllTraffic = ref(false);
// Même seuil que l'alerte côté serveur (TEMP_ALERT_CELSIUS)
const hottest = computed(() => (system.value?.sensors?.length ? Math.max(...system.value.sensors.map((s) => s.value)) : null));
const hot = computed(() => hottest.value !== null && hottest.value >= (overview.value?.tempAlertCelsius ?? 85));
const ftth = computed(() => system.value?.ftth ?? null);
const dbm = (v) => (v === null || v === undefined ? '—' : `${v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} dBm`);

const trafficItems = computed(() => {
  const items = trafficData.value?.items ?? [];
  const value = (t) => (trafficSort.value === 'volume' ? t.downBytes + t.upBytes : t.downRate + t.upRate);
  const sorted = [...items].sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name, 'fr'));
  return showAllTraffic.value ? sorted : sorted.slice(0, 8);
});
async function loadTraffic() {
  trafficData.value = await api(`/traffic?sort=${trafficSort.value}`).catch(() => trafficData.value);
}

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

// Connexions au serveur VPN de la box (null : illisible, droit « Modification des réglages » manquant)
const vpn = ref(null);
async function loadVpn() {
  vpn.value = await api('/vpn/connections').catch(() => null);
}
let vpnTimer;
onMounted(() => { load(); loadTraffic(); loadVpn(); vpnTimer = setInterval(loadVpn, 30000); });
onUnmounted(() => clearInterval(vpnTimer));
watch(() => live.traffic, (t) => { if (t) trafficData.value = { ...t, sort: trafficSort.value }; });
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
            <template v-if="ftth?.sfpPresent">
              <dt>Signal fibre</dt><dd><span class="dot" :class="ftth.signal ? 'ok' : 'bad'" /> {{ ftth.signal ? 'Présent' : 'Absent' }}</dd>
              <template v-if="ftth.powerReport">
                <dt>Puissance reçue / émise</dt><dd>{{ dbm(ftth.rxPower) }} / {{ dbm(ftth.txPower) }}</dd>
              </template>
            </template>
          </dl>
        </template>
        <p v-else class="muted">En attente de la première mesure…</p>
      </article>

      <article class="card">
        <h2>Freebox Server</h2>
        <template v-if="system">
          <p v-if="hot" class="pill bad">Température élevée ({{ hottest }} °C) : vérifie l'aération de la box</p>
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
          <template v-if="overview.repeaters?.total">
            · <RouterLink to="/equipements">{{ overview.repeaters.total }} répéteur{{ overview.repeaters.total > 1 ? 's' : '' }} Wi-Fi</RouterLink>
            <span v-if="overview.repeaters.online < overview.repeaters.total" class="error">({{ overview.repeaters.total - overview.repeaters.online }} déconnecté{{ overview.repeaters.total - overview.repeaters.online > 1 ? 's' : '' }})</span>
          </template>
        </p>
        <p class="small"><RouterLink to="/equipements">Équipements Free : firmware, redémarrage</RouterLink></p>
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

    <article v-if="vpn" class="card">
      <div class="row between">
        <h2>Connexions VPN ({{ vpn.length }})</h2>
        <RouterLink to="/reseau/vpn">Serveur VPN</RouterLink>
      </div>
      <table v-if="vpn.length" class="traffic">
        <thead><tr><th>Utilisateur</th><th>Depuis</th><th>Reçoit</th><th>Envoie</th></tr></thead>
        <tbody>
          <tr v-for="c in vpn" :key="c.id">
            <td>{{ c.user }}<div class="muted small">{{ c.serverLabel }}<template v-if="c.local_ip"> · {{ c.local_ip }}</template></div></td>
            <td>{{ c.src_ip }}<div class="muted small">{{ c.auth_time ? ago(c.auth_time) : '' }}</div></td>
            <td class="down">{{ bytes(c.tx_bytes) }}</td>
            <td class="up">{{ bytes(c.rx_bytes) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">Personne n'est connecté au VPN de la box.</p>
    </article>

    <article v-if="trafficData?.items.length" class="card">
      <div class="row between">
        <h2>Trafic par appareil</h2>
        <div class="tabs">
          <button :class="{ active: trafficSort === 'rate' }" @click="trafficSort = 'rate'">Débit actuel</button>
          <button :class="{ active: trafficSort === 'volume' }" @click="trafficSort = 'volume'">Volume</button>
        </div>
      </div>
      <table class="traffic">
        <thead><tr><th>Appareil</th><th>Reçoit</th><th>Envoie</th></tr></thead>
        <tbody>
          <tr v-for="t in trafficItems" :key="t.id">
            <td>
              <RouterLink v-if="t.deviceKey" :to="`/appareils/${encodeURIComponent(t.deviceKey)}`">{{ t.name }}</RouterLink>
              <span v-else>{{ t.name }}</span>
              <div class="muted small">{{ t.detail }}</div>
            </td>
            <td class="down">{{ trafficSort === 'volume' ? bytes(t.downBytes) : rate(t.downRate) }}</td>
            <td class="up">{{ trafficSort === 'volume' ? bytes(t.upBytes) : rate(t.upRate) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="row between">
        <p class="muted small">Wi-Fi : volume depuis la connexion de l'appareil. Ethernet : par prise, depuis le démarrage de la box.</p>
        <button v-if="trafficData.items.length > 8" class="ghost small" @click="showAllTraffic = !showAllTraffic">{{ showAllTraffic ? 'Réduire' : `Tout afficher (${trafficData.items.length})` }}</button>
      </div>
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
