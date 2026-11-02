<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api.js';

const data = ref(null);
const error = ref('');
const message = ref('');
const busy = ref(false);
const EMPTY = { proto: 'tcp', wanStart: '', wanEnd: '', lanIp: '', lanPort: '', srcIp: '', comment: '' };
const form = ref({ ...EMPTY });
// id de la redirection en cours de modification, null pour un ajout
const editingId = ref(null);

async function load() {
  try {
    data.value = await api('/portfwd');
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
    await fn();
    message.value = done;
    await load();
    return true;
  } catch (e) {
    error.value = e.message;
    return false;
  } finally {
    busy.value = false;
  }
}

const ports = (start, end) => (end !== start ? `${start}–${end}` : `${start}`);
const lanPorts = (r) => ports(r.lan_port, r.lan_port + (r.wan_port_end - r.wan_port_start));

function edit(r) {
  editingId.value = r.id;
  form.value = {
    proto: r.ip_proto,
    wanStart: String(r.wan_port_start),
    wanEnd: r.wan_port_end !== r.wan_port_start ? String(r.wan_port_end) : '',
    lanIp: r.lan_ip,
    lanPort: String(r.lan_port),
    srcIp: r.src_ip !== '0.0.0.0' ? r.src_ip : '',
    comment: r.comment,
  };
  document.getElementById('fwd-form')?.scrollIntoView({ behavior: 'smooth' });
}
function cancel() {
  editingId.value = null;
  form.value = { ...EMPTY };
}

async function save() {
  const id = editingId.value;
  const ok = await act(
    () => (id === null ? api('/portfwd', { method: 'POST', body: form.value }) : api(`/portfwd/${id}`, { method: 'PUT', body: form.value })),
    id === null ? 'Redirection ajoutée' : 'Redirection modifiée',
  );
  if (ok) cancel();
}

const toggle = (r) => act(() => api(`/portfwd/${r.id}`, { method: 'PUT', body: { enabled: !r.enabled } }), r.enabled ? 'Redirection désactivée' : 'Redirection activée');

function remove(r) {
  if (!window.confirm(`Supprimer la redirection du port ${ports(r.wan_port_start, r.wan_port_end)} vers ${r.lan_ip} ?`)) return;
  act(() => api(`/portfwd/${r.id}`, { method: 'DELETE' }), 'Redirection supprimée');
}

const pickDevice = (e) => {
  if (e.target.value) form.value.lanIp = e.target.value;
  e.target.value = '';
};
const range = computed(() => data.value?.ipv4PortRange);
</script>

<template>
  <section>
    <RouterLink to="/reseau" class="muted">← Réseau</RouterLink>
    <h1>Redirections de ports</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="message" class="ok">{{ message }}</p>
    <template v-if="data">
      <div v-if="data.dmz?.enabled" class="banner">
        <strong>DMZ active</strong> vers {{ data.dmz.device?.name ?? data.dmz.ip }} ({{ data.dmz.ip }}) :
        tout le trafic entrant non redirigé arrive sur cet appareil. Elle se règle dans Freebox OS.
      </div>
      <div v-if="range" class="banner">Ton IPv4 est partagée : seuls les ports {{ range[0] }} à {{ range[1] }} sont utilisables.</div>

      <article class="card">
        <h2>Redirections ({{ data.rules.length }})</h2>
        <table v-if="data.rules.length">
          <thead><tr><th>Port externe</th><th>Vers</th><th>Commentaire</th><th /></tr></thead>
          <tbody>
            <template v-for="r in data.rules" :key="r.id">
              <tr :class="{ muted: !r.enabled }">
                <td>{{ ports(r.wan_port_start, r.wan_port_end) }} <span class="small muted">{{ r.ip_proto.toUpperCase() }}</span></td>
                <td>
                  <RouterLink v-if="r.device" :to="`/appareils/${encodeURIComponent(r.device.key)}`">{{ r.device.name }}</RouterLink>
                  <span v-else>{{ r.hostname || r.lan_ip }}</span>
                  <div class="small muted">{{ r.lan_ip }}:{{ lanPorts(r) }}<template v-if="r.src_ip && r.src_ip !== '0.0.0.0'"> · depuis {{ r.src_ip }} seulement</template></div>
                </td>
                <td>{{ r.comment }}</td>
                <td class="actions">
                  <label class="check switch" :title="r.enabled ? 'Désactiver' : 'Activer'"><input type="checkbox" :checked="r.enabled" :disabled="busy" @change="toggle(r)"> active</label>
                  <button class="ghost small" @click="edit(r)">Modifier</button>
                  <button class="danger small" :disabled="busy" @click="remove(r)">Supprimer</button>
                </td>
              </tr>
              <tr v-if="r.enabled && r.warnings.length" class="warnings">
                <td colspan="4"><p v-for="w in r.warnings" :key="w" class="small">⚠️ {{ w }}</p></td>
              </tr>
            </template>
          </tbody>
        </table>
        <p v-else class="muted">Aucune redirection.</p>
      </article>

      <article id="fwd-form" class="card">
        <h2>{{ editingId === null ? 'Ajouter une redirection' : 'Modifier la redirection' }}</h2>
        <form @submit.prevent="save">
          <div class="row">
            <select v-model="form.proto" aria-label="Protocole"><option value="tcp">TCP</option><option value="udp">UDP</option></select>
            <input v-model="form.wanStart" class="port-input" placeholder="Port externe" required aria-label="Port externe">
            <input v-model="form.wanEnd" class="port-input" placeholder="jusqu'à" aria-label="Port externe de fin">
            <span>→</span>
            <input v-model="form.lanIp" class="ip-input" placeholder="192.168.1.x" required aria-label="IP de destination">
            <select aria-label="Choisir un appareil" @change="pickDevice">
              <option value="">Appareil…</option>
              <option v-for="d in data.devices" :key="d.key" :value="d.ipv4">{{ d.name }} ({{ d.ipv4 }})</option>
            </select>
            <input v-model="form.lanPort" class="port-input" placeholder="Port interne" aria-label="Port interne">
          </div>
          <div class="row">
            <input v-model="form.srcIp" class="ip-input" placeholder="IP source (toutes)" aria-label="IP source autorisée">
            <input v-model="form.comment" placeholder="Commentaire" aria-label="Commentaire" class="grow">
            <button :disabled="busy">{{ editingId === null ? 'Ajouter' : 'Enregistrer' }}</button>
            <button v-if="editingId !== null" type="button" class="ghost" @click="cancel">Annuler</button>
          </div>
          <p class="muted small">Port interne vide = même port. « jusqu'à » permet de rediriger une plage de ports.</p>
        </form>
      </article>

      <article v-if="data.incoming.length" class="card">
        <h2>Ports utilisés par la box</h2>
        <table>
          <tbody>
            <tr v-for="p in data.incoming" :key="p.id"><td>{{ p.in_port }} <span class="small muted">{{ p.type.toUpperCase() }}</span></td><td>{{ p.label }}</td></tr>
          </tbody>
        </table>
      </article>
    </template>
  </section>
</template>
