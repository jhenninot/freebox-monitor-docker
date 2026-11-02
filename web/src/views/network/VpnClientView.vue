<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../../api.js';
import { bytes, date, rate } from '../../format.js';

const data = ref(null);
const error = ref('');
const message = ref('');
const busy = ref(false);
const log = ref(null);
const EMPTY = { type: 'wireguard', description: '', text: '', pptp: { remoteHost: '', username: '', password: '' } };
const form = ref(structuredClone(EMPTY));

async function load() {
  try {
    data.value = await api('/vpn-client');
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

const TYPES = { wireguard: 'WireGuard', pptp: 'PPTP', openvpn: 'OpenVPN' };

const activate = (c) => act(() => api(`/vpn-client/configs/${encodeURIComponent(c.id)}`, { method: 'PUT', body: { active: !c.active } }), c.active ? `${c.description} désactivée` : `${c.description} activée : la box s'y connecte`);

function remove(c) {
  if (!window.confirm(`Supprimer la configuration « ${c.description} » ?`)) return;
  act(() => api(`/vpn-client/configs/${encodeURIComponent(c.id)}`, { method: 'DELETE' }), 'Configuration supprimée');
}

async function readFile(ev) {
  const f = ev.target.files?.[0];
  if (!f) return;
  form.value.text = await f.text();
  if (!form.value.description) form.value.description = f.name.replace(/\.conf$/i, '');
}

async function add() {
  const { type, description, text, pptp } = form.value;
  const body = type === 'wireguard' ? { type, description, text } : { type, description, pptp };
  const ok = await act(() => api('/vpn-client/configs', { method: 'POST', body }), `Configuration « ${description} » ajoutée`);
  if (ok) form.value = structuredClone(EMPTY);
}

async function loadLog() {
  try {
    log.value = (await api('/vpn-client/log')).log || 'Journal vide.';
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <section>
    <RouterLink to="/reseau" class="muted">← Réseau</RouterLink>
    <h1>Client VPN de la box</h1>
    <p class="muted small">La Freebox se connecte elle-même à un VPN extérieur (fournisseur VPN, bureau) et y fait passer le trafic de tout le réseau.</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="message" class="ok">{{ message }}</p>
    <template v-if="data">
      <article v-if="data.status" class="card">
        <h2>État</h2>
        <p class="status">
          <span class="dot" :class="data.status.state === 'up' ? 'ok' : data.status.errorLabel ? 'bad' : 'off'" />
          {{ data.status.stateLabel }}<template v-if="data.status.active_vpn_description"> · {{ data.status.active_vpn_description }}</template>
        </p>
        <p v-if="data.status.errorLabel" class="error small">Dernière erreur : {{ data.status.errorLabel }}</p>
        <dl v-if="data.status.state === 'up'">
          <template v-if="data.status.ipv4?.ip_mask"><dt>Adresse</dt><dd>{{ data.status.ipv4.ip_mask.ip }}</dd></template>
          <template v-if="data.status.last_up"><dt>Connecté depuis</dt><dd>{{ date(data.status.last_up) }}</dd></template>
          <template v-if="data.status.stats">
            <dt>Débit</dt><dd>↓ {{ rate(data.status.stats.rate_down) }} · ↑ {{ rate(data.status.stats.rate_up) }}</dd>
            <dt>Échangé</dt><dd>↓ {{ bytes(data.status.stats.bytes_down) }} · ↑ {{ bytes(data.status.stats.bytes_up) }}</dd>
          </template>
        </dl>
        <details @toggle="(e) => e.target.open && !log && loadLog()">
          <summary>Journal de connexion</summary>
          <pre>{{ log ?? 'Chargement…' }}</pre>
        </details>
      </article>

      <article class="card">
        <h2>Configurations ({{ data.configs.length }})</h2>
        <table v-if="data.configs.length">
          <thead><tr><th>Nom</th><th>Type</th><th>Serveur</th><th /></tr></thead>
          <tbody>
            <tr v-for="c in data.configs" :key="c.id">
              <td><strong v-if="c.active">● </strong>{{ c.description }}</td>
              <td>{{ TYPES[c.type] ?? c.type }}</td>
              <td class="small">{{ c.conf_wireguard ? `${c.conf_wireguard.remote_addr}:${c.conf_wireguard.remote_port}` : c.conf_pptp?.remote_host ?? '' }}</td>
              <td class="actions">
                <button :class="c.active ? 'ghost small' : 'small'" :disabled="busy" @click="activate(c)">{{ c.active ? 'Désactiver' : 'Activer' }}</button>
                <button class="danger small" :disabled="busy" @click="remove(c)">Supprimer</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">Aucune configuration.</p>
        <p class="muted small">Une seule configuration est active à la fois.</p>
      </article>

      <article class="card">
        <h2>Ajouter une configuration</h2>
        <form @submit.prevent="add">
          <div class="row">
            <select v-model="form.type" aria-label="Type"><option value="wireguard">WireGuard</option><option value="pptp">PPTP</option></select>
            <input v-model="form.description" placeholder="Nom (ex. Proton VPN)" required aria-label="Nom" class="grow">
          </div>
          <template v-if="form.type === 'wireguard'">
            <div class="row">
              <input type="file" accept=".conf,text/plain" aria-label="Fichier .conf" @change="readFile">
            </div>
            <textarea v-model="form.text" rows="8" placeholder="[Interface]&#10;PrivateKey = …&#10;Address = …&#10;&#10;[Peer]&#10;PublicKey = …&#10;Endpoint = …" aria-label="Contenu du fichier .conf" />
            <p class="muted small">Fichier .conf donné par ton fournisseur VPN : choisis-le ou colle son contenu.</p>
          </template>
          <div v-else class="row">
            <input v-model="form.pptp.remoteHost" placeholder="Serveur" required aria-label="Serveur">
            <input v-model="form.pptp.username" placeholder="Identifiant" required aria-label="Identifiant">
            <input v-model="form.pptp.password" type="password" placeholder="Mot de passe" required aria-label="Mot de passe">
          </div>
          <button :disabled="busy">Ajouter</button>
        </form>
      </article>
    </template>
  </section>
</template>
