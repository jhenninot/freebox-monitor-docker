<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import DeviceTypeIcon from '../components/DeviceTypeIcon.vue';
import Icon from '../components/Icon.vue';
import LinkIcon from '../components/LinkIcon.vue';
import RateChart from '../components/RateChart.vue';
import TypeSelect from '../components/TypeSelect.vue';
import { ago, bytes, date, duration, EVENT_LABELS, HOST_TYPES, rate } from '../format.js';
import { live } from '../live.js';

const props = defineProps({ deviceKey: { type: String, required: true } });
const router = useRouter();
const device = ref(null);
const days = ref(7);
const newName = ref('');
const message = ref('');
const error = ref('');
const busy = ref(false);
const hostType = ref('');
const domainPrefix = ref('');
const leaseIp = ref('');
const leaseComment = ref('');
const wifi = ref(null);

async function load() {
  try {
    const d = await api(`/devices/${encodeURIComponent(props.deviceKey)}?days=${days.value}`);
    // Les champs du formulaire ne bougent pas pendant la saisie : seulement au premier chargement ou après un enregistrement
    if (!device.value || device.value.key !== d.key || !busy.value) {
      hostType.value = d.hostType;
      domainPrefix.value = d.box.localDomain ? d.box.domainName.replace(`.${d.box.localDomain}`, '') : '';
      leaseIp.value = d.lease?.ip ?? d.ipv4 ?? '';
      leaseComment.value = d.lease?.comment ?? d.name;
    }
    device.value = d;
  } catch (e) {
    error.value = e.message;
  }
}
async function loadWifi() {
  if (!device.value?.mac) return;
  wifi.value = await api(`/devices/${encodeURIComponent(props.deviceKey)}/wifi`).catch(() => null);
}
onMounted(async () => { await load(); loadWifi(); });
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

const path = (suffix = '') => `/devices/${encodeURIComponent(props.deviceKey)}${suffix}`;

/** Lance une action sur la box, affiche le résultat et recharge la fiche. */
async function act(fn, done) {
  message.value = '';
  error.value = '';
  busy.value = true;
  try {
    await fn();
    message.value = done;
    busy.value = false;
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

const rename = () => act(async () => {
  await api(path('/name'), { method: 'PUT', body: { name: newName.value } });
  newName.value = '';
}, 'Nom changé dans la Freebox');

const saveType = () => act(() => api(path('/box'), { method: 'PATCH', body: { hostType: hostType.value } }), 'Type enregistré');
const saveDomain = () => act(() => api(path('/box'), { method: 'PATCH', body: { domainPrefix: domainPrefix.value } }), domainPrefix.value ? 'Nom local enregistré' : 'Nom local supprimé');

const saveLease = () => act(() => (device.value.lease
  ? api(`/dhcp/leases/${encodeURIComponent(device.value.lease.id)}`, { method: 'PUT', body: { ip: leaseIp.value, comment: leaseComment.value } })
  : api('/dhcp/leases', { method: 'POST', body: { mac: device.value.mac, ip: leaseIp.value, comment: leaseComment.value } })), 'IP fixe enregistrée');

const removeLease = () => {
  if (!window.confirm(`Retirer l'IP fixe ${device.value.lease.ip} ?`)) return;
  act(() => api(`/dhcp/leases/${encodeURIComponent(device.value.lease.id)}`, { method: 'DELETE' }), 'IP fixe retirée');
};

const wake = () => act(() => api(path('/wol'), { method: 'POST', body: {} }), 'Demande de réveil envoyée');

const WIFI_STATUS = {
  blocked: 'Bloqué : il ne peut pas se connecter au Wi-Fi',
  listed_inactive: 'En liste noire, mais le filtrage MAC est désactivé : il peut se connecter',
  not_blocked: 'Non bloqué',
  whitelist_mode: 'Le Wi-Fi est en mode liste blanche : gère-le depuis l\'écran Filtrage Wi-Fi',
};

function setWifiBlocked(blocked) {
  if (blocked) {
    let text = `${device.value.name} ne pourra plus se connecter au Wi-Fi de la box (le câble reste possible).`;
    if (wifi.value?.filterState === 'disabled') {
      text += '\n\nLe filtrage MAC est désactivé : il sera activé en mode liste noire.';
      if (wifi.value.otherBlacklisted) text += ` Attention, ${wifi.value.otherBlacklisted} autre(s) appareil(s) déjà en liste noire seront bloqués aussi.`;
    }
    if (!window.confirm(text)) return;
  }
  act(async () => {
    wifi.value = await api(path('/wifi'), { method: 'PUT', body: { blocked } });
  }, blocked ? 'Appareil bloqué en Wi-Fi' : 'Appareil débloqué en Wi-Fi');
}

async function forget() {
  if (!window.confirm(`Oublier ${device.value.name} ? La box le retire de sa liste (il reviendra s'il se reconnecte) et son historique de présence est effacé.`)) return;
  try {
    await api(path(), { method: 'DELETE' });
    router.replace('/appareils');
  } catch (e) {
    error.value = e.message;
  }
}

// Historique de trafic (stations Wi-Fi et appareils seuls sur leur prise Ethernet)
const TRAFFIC_RANGES = [{ id: '1h', label: '1 h', seconds: 3600 }, { id: '24h', label: '24 h', seconds: 86400 }, { id: '7d', label: '7 j', seconds: 7 * 86400 }];
const trafficRange = ref('1h');
const trafficPoints = ref([]);
async function loadTraffic() {
  const down = `dev.${props.deviceKey}.down`;
  const up = `dev.${props.deviceKey}.up`;
  try {
    const r = await api(`/metrics?keys=${encodeURIComponent(`${down},${up}`)}&range=${trafficRange.value}`);
    const ups = new Map(r.series[up].map(([t, avg]) => [t, avg]));
    trafficPoints.value = r.series[down].map(([t, avg]) => [t, avg, ups.get(t) ?? null]);
  } catch {
    trafficPoints.value = [];
  }
}
onMounted(loadTraffic);
watch(trafficRange, loadTraffic);
watch(() => live.traffic, () => {
  const t = live.traffic?.items.find((i) => i.deviceKey === props.deviceKey);
  if (device.value && t) device.value.traffic = t;
});

// Scan de ports fait par le serveur
const scan = ref(null);
async function loadScan() {
  scan.value = await api(path('/scan')).catch(() => null);
}
onMounted(loadScan);
watch(() => live.scan, (p) => {
  if (!p || p.deviceKey !== props.deviceKey || !scan.value) return;
  if (p.running) scan.value = { ...scan.value, running: p };
  else loadScan();
});
async function startScan(full) {
  error.value = '';
  try {
    const running = await api(path('/scan'), { method: 'POST', body: { full } });
    scan.value = { ...scan.value, running };
  } catch (e) {
    error.value = e.message;
  }
}
const stopScan = () => api(path('/scan'), { method: 'DELETE' }).catch((e) => { error.value = e.message; });
const scanPercent = computed(() => {
  const r = scan.value?.running;
  return r?.total ? Math.round((r.done / r.total) * 100) : 0;
});
// Ports du dernier scan, plus ceux fermés depuis le précédent (barrés)
const scanRows = computed(() => {
  const last = scan.value?.last;
  if (!last) return [];
  const added = new Set(scan.value.diff?.added ?? []);
  const rows = last.ports.map((p) => ({ ...p, isNew: added.has(p.port) }));
  for (const port of scan.value.diff?.removed ?? []) rows.push({ port, service: '', banner: 'fermé depuis le scan précédent', gone: true });
  return rows.sort((a, b) => a.port - b.port);
});

const INFO_SOURCES = { upnp: 'UPnP', mdns: 'mDNS (Bonjour)', dhcp: 'DHCP', netbios: 'NetBIOS', wsd: 'WS-Discovery' };
</script>

<template>
  <section v-if="device">
    <RouterLink to="/appareils" class="muted">← Appareils</RouterLink>
    <h1><DeviceTypeIcon :type="device.hostType" large /> {{ device.name }} <LinkIcon :link="device.link" :online="device.online" small /></h1>
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
        <h2>Dans la Freebox</h2>
        <form class="row" @submit.prevent="rename">
          <input v-model="newName" :placeholder="device.name" maxlength="64" required aria-label="Nouveau nom">
          <button :disabled="busy">Renommer</button>
        </form>
        <form class="row" @submit.prevent="saveType">
          <TypeSelect v-model="hostType" />
          <button :disabled="busy || hostType === device.hostType">Changer le type</button>
        </form>
        <form v-if="device.box.localDomain" class="row" @submit.prevent="saveDomain">
          <span class="suffixed">
            <input v-model="domainPrefix" placeholder="nom-local" aria-label="Nom local">
            <span class="muted">.{{ device.box.localDomain }}</span>
          </span>
          <button :disabled="busy">Nom local</button>
        </form>
        <div class="row">
          <button class="ghost" :disabled="busy || !device.mac" @click="wake">Réveiller (Wake-on-LAN)</button>
          <button class="danger" :disabled="busy" @click="forget">Oublier</button>
        </div>
        <p class="muted small">Ces réglages sont enregistrés dans la box : ils apparaissent aussi dans Freebox OS.</p>
        <p v-if="message" class="ok">{{ message }}</p>
        <p v-if="error" class="error">{{ error }}</p>
      </article>
    </div>

    <div class="grid">
      <article v-if="device.mac" class="card">
        <h2>IP fixe</h2>
        <p v-if="device.lease"><Icon name="pin" /> Réservée : <strong>{{ device.lease.ip }}</strong></p>
        <p v-else class="muted">L'adresse de cet appareil est distribuée automatiquement et peut changer.</p>
        <form class="row" @submit.prevent="saveLease">
          <input v-model="leaseIp" placeholder="192.168.1.x" required aria-label="Adresse IP" class="ip-input">
          <input v-model="leaseComment" placeholder="Commentaire" aria-label="Commentaire">
          <button :disabled="busy">{{ device.lease ? 'Modifier' : 'Fixer l\'IP' }}</button>
          <button v-if="device.lease" type="button" class="danger" :disabled="busy" @click="removeLease">Retirer</button>
        </form>
      </article>
      <article v-if="device.mac" class="card">
        <h2>Wi-Fi</h2>
        <template v-if="wifi">
          <p>{{ WIFI_STATUS[wifi.status] }}</p>
          <button v-if="wifi.status === 'blocked' || wifi.status === 'listed_inactive'" :disabled="busy" @click="setWifiBlocked(false)">Débloquer</button>
          <button v-else-if="wifi.status === 'not_blocked'" class="danger" :disabled="busy" @click="setWifiBlocked(true)">Bloquer en Wi-Fi</button>
        </template>
        <p v-else class="muted">Filtrage Wi-Fi illisible (droit « Modification des réglages » nécessaire).</p>
      </article>
    </div>

    <article v-if="device.box.otherNames.length || device.box.info.length || device.box.ipv6.length" class="card">
      <h2>Infos détectées par la box</h2>
      <dl>
        <template v-if="device.box.ipv6.length"><dt>IPv6</dt><dd class="wrap">{{ device.box.ipv6.join(', ') }}</dd></template>
        <template v-for="n in device.box.otherNames" :key="`${n.source}-${n.name}`">
          <dt>Nom {{ INFO_SOURCES[n.source] ?? n.source }}</dt><dd>{{ n.name }}</dd>
        </template>
      </dl>
      <details v-for="section in device.box.info" :key="section.source">
        <summary>{{ INFO_SOURCES[section.source] ?? section.source }}</summary>
        <dl>
          <template v-for="[k, v] in section.entries" :key="k"><dt>{{ k }}</dt><dd class="wrap">{{ v }}</dd></template>
        </dl>
      </details>
    </article>

    <article v-if="device.traffic || trafficPoints.length" class="card">
      <div class="row between">
        <h2>Trafic</h2>
        <div class="tabs">
          <button v-for="r in TRAFFIC_RANGES" :key="r.id" :class="{ active: trafficRange === r.id }" @click="trafficRange = r.id">{{ r.label }}</button>
        </div>
      </div>
      <div v-if="device.traffic" class="rates">
        <div><span class="label">Reçoit</span><strong class="down">{{ rate(device.traffic.downRate) }}</strong><span class="muted">{{ bytes(device.traffic.downBytes) }} au total</span></div>
        <div><span class="label">Envoie</span><strong class="up">{{ rate(device.traffic.upRate) }}</strong><span class="muted">{{ bytes(device.traffic.upBytes) }} au total</span></div>
      </div>
      <RateChart v-if="trafficPoints.length" :points="trafficPoints" :range="TRAFFIC_RANGES.find((r) => r.id === trafficRange).seconds" />
      <p class="muted small">{{ device.traffic?.detail ?? '' }}{{ device.traffic?.link === 'wifi' ? ' · volume depuis la connexion au Wi-Fi' : device.traffic ? ' · volume depuis le démarrage de la box' : 'Pas de mesure récente' }}</p>
    </article>

    <article v-if="scan" class="card">
      <div class="row between">
        <h2>Ports ouverts</h2>
        <div v-if="!scan.running" class="row">
          <button class="ghost small" :disabled="!device.ipv4" @click="startScan(false)">Scan rapide</button>
          <button class="ghost small" :disabled="!device.ipv4" @click="startScan(true)">Scan complet</button>
        </div>
        <button v-else class="danger small" @click="stopScan">Arrêter</button>
      </div>
      <template v-if="scan.running">
        <p class="small">
          {{ scan.running.identifying ? 'Lecture des services trouvés…' : `${scan.running.full ? 'Scan complet' : 'Scan rapide'} : ${scan.running.done} / ${scan.running.total} ports testés` }}
          <template v-if="scan.running.found.length"> · ouverts : {{ scan.running.found.join(', ') }}</template>
        </p>
        <progress :value="scanPercent" max="100" />
      </template>
      <template v-if="scan.last">
        <p class="muted small">
          {{ scan.last.full ? 'Scan complet' : 'Scan rapide' }}{{ scan.last.nightly ? ' de nuit' : '' }} du {{ date(scan.last.ts) }} sur {{ scan.last.ip }}
          <template v-if="scan.last.stopped"> · arrêté avant la fin</template>
          <template v-if="scan.diff && !scan.diff.added.length && !scan.diff.removed.length && scan.history.length > 1"> · rien n'a changé depuis le scan précédent</template>
        </p>
        <table v-if="scanRows.length">
          <thead><tr><th>Port</th><th>Service</th><th>Ce qu'il annonce</th></tr></thead>
          <tbody>
            <tr v-for="p in scanRows" :key="p.port" :class="{ gone: p.gone }">
              <td>{{ p.port }}<span v-if="p.isNew" class="badge new">nouveau</span></td>
              <td><a v-if="p.url" :href="p.url" target="_blank" rel="noopener">{{ p.service }}</a><template v-else>{{ p.service }}</template></td>
              <td class="small wrap">{{ p.banner ?? '' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">Aucun port ouvert trouvé.</p>
      </template>
      <p v-else-if="!scan.running" class="muted small">
        Le serveur teste les ports TCP de l'appareil : scan rapide (environ 150 ports courants, quelques secondes) ou complet (1 à 65535, une à deux minutes).
      </p>
    </article>

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
