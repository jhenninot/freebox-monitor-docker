<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../../api.js';
import { duration } from '../../format.js';

const data = ref(null);
const error = ref('');
const message = ref('');
const busy = ref(false);
// Ligne en cours de modification : { id, ip, comment }
const editing = ref(null);
// Formulaire d'ajout
const form = ref({ mac: '', ip: '', comment: '' });

async function load() {
  try {
    data.value = await api('/dhcp');
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

async function add() {
  const ok = await act(() => api('/dhcp/leases', { method: 'POST', body: form.value }), `IP ${form.value.ip} réservée`);
  if (ok) form.value = { mac: '', ip: '', comment: '' };
}

/** « Fixer » : pré-remplit le formulaire avec une adresse distribuée automatiquement. */
function fix(lease) {
  form.value = { mac: lease.mac, ip: lease.ip, comment: lease.device?.name ?? lease.hostname };
  document.getElementById('add-lease')?.scrollIntoView({ behavior: 'smooth' });
}

async function save() {
  const { id, ip, comment } = editing.value;
  const ok = await act(() => api(`/dhcp/leases/${encodeURIComponent(id)}`, { method: 'PUT', body: { ip, comment } }), 'IP fixe modifiée');
  if (ok) editing.value = null;
}

function remove(lease) {
  if (!window.confirm(`Retirer l'IP fixe ${lease.ip} (${lease.device?.name ?? lease.mac}) ?`)) return;
  act(() => api(`/dhcp/leases/${encodeURIComponent(lease.id)}`, { method: 'DELETE' }), 'IP fixe retirée');
}

const deviceLink = (d) => `/appareils/${encodeURIComponent(d.key)}`;
</script>

<template>
  <section>
    <RouterLink to="/reseau" class="muted">← Réseau</RouterLink>
    <h1>IP fixes</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="message" class="ok">{{ message }}</p>
    <template v-if="data">
      <p class="muted small">
        Serveur DHCP {{ data.config.enabled ? 'actif' : 'désactivé' }} · box {{ data.config.gateway }} / {{ data.config.netmask }}
        · adresses distribuées de {{ data.config.rangeStart }} à {{ data.config.rangeEnd }}
        <template v-if="data.config.dns.length"> · DNS {{ data.config.dns.join(', ') }}</template>
        · <RouterLink to="/reseau/dns">modifier les DNS</RouterLink>
      </p>

      <div v-if="data.watchedWithoutLease.length" class="banner">
        <strong>Appareils surveillés sans IP fixe :</strong>
        <template v-for="(d, i) in data.watchedWithoutLease" :key="d.key">
          {{ i ? ', ' : ' ' }}<a href="#add-lease" @click.prevent="fix({ mac: d.mac, ip: d.ipv4 ?? '', device: d })">{{ d.name }}</a>
        </template>.
        Leur adresse peut changer ; clique sur un nom pour la fixer.
      </div>

      <article class="card">
        <h2>Adresses réservées ({{ data.staticLeases.length }})</h2>
        <table v-if="data.staticLeases.length">
          <thead><tr><th>IP</th><th>Appareil</th><th>MAC</th><th>Commentaire</th><th /></tr></thead>
          <tbody>
            <tr v-for="l in data.staticLeases" :key="l.id">
              <template v-if="editing?.id === l.id">
                <td><input v-model="editing.ip" class="ip-input" aria-label="Adresse IP"></td>
                <td>{{ l.device?.name ?? l.hostname }}</td>
                <td class="small">{{ l.mac }}</td>
                <td><input v-model="editing.comment" aria-label="Commentaire"></td>
                <td class="actions">
                  <button class="small" :disabled="busy" @click="save">Enregistrer</button>
                  <button class="ghost small" @click="editing = null">Annuler</button>
                </td>
              </template>
              <template v-else>
                <td>{{ l.ip }}</td>
                <td>
                  <RouterLink v-if="l.device" :to="deviceLink(l.device)"><span class="dot" :class="l.device.online ? 'ok' : 'off'" /> {{ l.device.name }}</RouterLink>
                  <span v-else class="muted">{{ l.hostname || 'inconnu' }}</span>
                </td>
                <td class="small">{{ l.mac }}</td>
                <td>{{ l.comment }}</td>
                <td class="actions">
                  <button class="ghost small" @click="editing = { id: l.id, ip: l.ip, comment: l.comment }">Modifier</button>
                  <button class="danger small" :disabled="busy" @click="remove(l)">Retirer</button>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">Aucune IP fixe.</p>
      </article>

      <article id="add-lease" class="card">
        <h2>Réserver une adresse</h2>
        <form class="row" @submit.prevent="add">
          <input v-model="form.mac" placeholder="AA:BB:CC:DD:EE:FF" required aria-label="Adresse MAC">
          <input v-model="form.ip" placeholder="192.168.1.x" required class="ip-input" aria-label="Adresse IP">
          <input v-model="form.comment" placeholder="Commentaire" aria-label="Commentaire">
          <button :disabled="busy">Réserver</button>
        </form>
      </article>

      <article v-if="data.dynamicLeases.length" class="card">
        <h2>Adresses distribuées automatiquement</h2>
        <table>
          <thead><tr><th>IP</th><th>Appareil</th><th>MAC</th><th>Bail restant</th><th /></tr></thead>
          <tbody>
            <tr v-for="l in data.dynamicLeases" :key="l.mac">
              <td>{{ l.ip }}</td>
              <td>
                <RouterLink v-if="l.device" :to="deviceLink(l.device)">{{ l.device.name }}</RouterLink>
                <span v-else class="muted">{{ l.hostname || 'inconnu' }}</span>
              </td>
              <td class="small">{{ l.mac }}</td>
              <td class="small">{{ duration(l.remaining) }}</td>
              <td class="actions"><button class="ghost small" @click="fix(l)">Fixer</button></td>
            </tr>
          </tbody>
        </table>
      </article>
    </template>
  </section>
</template>
