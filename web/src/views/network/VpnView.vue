<script setup>
import QRCode from 'qrcode';
import { onMounted, ref } from 'vue';
import { api } from '../../api.js';
import { bytes, date } from '../../format.js';

const data = ref(null);
const error = ref('');
const message = ref('');
const busy = ref(false);
// Réglages en cours de saisie, par serveur
const settings = ref({});
const EMPTY_USER = { login: '', type: 'wireguard', password: '', ip: '', keepalive: '25' };
const userForm = ref({ ...EMPTY_USER });
const editingLogin = ref(null);
// Fichier de configuration affiché : { fileName, text, qr (svg) }
const file = ref(null);

const CIPHERS = { aes256: 'AES-256', aes128: 'AES-128', chacha20poly1305: 'ChaCha20-Poly1305', blowfish: 'Blowfish (ancien)' };

async function load() {
  try {
    data.value = await api('/vpn');
    settings.value = Object.fromEntries(data.value.servers.map((s) => [s.id, {
      port: s.config?.port ?? '',
      mtu: s.config?.conf_wireguard?.mtu ?? '',
      enableIpv4: s.config?.enable_ipv4,
      enableIpv6: s.config?.enable_ipv6,
      cipher: s.config?.conf_openvpn?.cipher,
      useTcp: s.config?.conf_openvpn?.use_tcp,
      disableFragment: s.config?.conf_openvpn?.disable_fragment,
    }]));
    if (!editingLogin.value && !userForm.value.ip) userForm.value.ip = data.value.nextFreeIp ?? '';
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

const running = (s) => s.state === 'started' || s.state === 'starting';
const toggle = (s) => act(() => api(`/vpn/servers/${s.id}`, { method: 'PUT', body: { enabled: !running(s) } }), `${s.label} ${running(s) ? 'arrêté' : 'démarré'}`);

function saveSettings(s) {
  const v = settings.value[s.id];
  const body = { port: v.port };
  if (s.config?.conf_wireguard) body.mtu = v.mtu;
  if (typeof v.enableIpv4 === 'boolean' && s.id !== 'openvpn_bridge') Object.assign(body, { enableIpv4: v.enableIpv4, enableIpv6: v.enableIpv6 });
  if (s.config?.conf_openvpn) Object.assign(body, { cipher: v.cipher, useTcp: v.useTcp, disableFragment: v.disableFragment });
  act(() => api(`/vpn/servers/${s.id}`, { method: 'PUT', body }), `Réglages ${s.label} enregistrés`);
}

function disconnect(c) {
  if (!window.confirm(`Déconnecter ${c.user} (${c.src_ip}) ?`)) return;
  act(() => api(`/vpn/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' }), `${c.user} déconnecté`);
}

function editUser(u) {
  editingLogin.value = u.login;
  userForm.value = { login: u.login, type: u.type, password: '', ip: u.ip_reservation, keepalive: String(u.conf_wireguard?.keepalive ?? 25) };
  document.getElementById('vpn-user-form')?.scrollIntoView({ behavior: 'smooth' });
}
function cancelUser() {
  editingLogin.value = null;
  userForm.value = { ...EMPTY_USER, ip: data.value?.nextFreeIp ?? '' };
}
async function saveUser() {
  const login = editingLogin.value;
  const ok = await act(
    () => (login ? api(`/vpn/users/${encodeURIComponent(login)}`, { method: 'PUT', body: userForm.value }) : api('/vpn/users', { method: 'POST', body: userForm.value })),
    login ? `Accès ${login} modifié` : `Accès ${userForm.value.login} créé`,
  );
  if (ok) cancelUser();
}
function removeUser(u) {
  if (!window.confirm(`Supprimer l'accès VPN ${u.login} ? Ses appareils ne pourront plus se connecter.`)) return;
  act(() => api(`/vpn/users/${encodeURIComponent(u.login)}`, { method: 'DELETE' }), `Accès ${u.login} supprimé`);
}

async function showConfig(u, server) {
  if (server.id !== 'wireguard'
    && !window.confirm('Pour OpenVPN, chaque téléchargement invalide le fichier précédent de cet utilisateur. Continuer ?')) return;
  error.value = '';
  try {
    const f = await api(`/vpn/users/${encodeURIComponent(u.login)}/config/${server.id}`);
    const qr = server.id === 'wireguard' ? await QRCode.toString(f.text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : null;
    file.value = { ...f, qr, server: server.label, login: u.login };
  } catch (e) {
    error.value = e.message;
  }
}
function download() {
  const url = URL.createObjectURL(new Blob([file.value.text], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: file.value.fileName });
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <section>
    <RouterLink to="/reseau" class="muted">← Réseau</RouterLink>
    <h1>Serveur VPN</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="message" class="ok">{{ message }}</p>
    <template v-if="data">
      <div class="grid">
        <article v-for="s in data.servers" :key="s.id" class="card">
          <div class="row between">
            <h2><span class="dot" :class="s.state === 'started' ? 'ok' : s.state === 'error' ? 'bad' : 'off'" /> {{ s.label }}</h2>
            <button :class="running(s) ? 'danger small' : 'small'" :disabled="busy" @click="toggle(s)">{{ running(s) ? 'Arrêter' : 'Démarrer' }}</button>
          </div>
          <p class="muted small">
            {{ s.stateLabel }}<template v-if="s.connectionCount"> · {{ s.connectionCount }} connecté(s)</template>
            <template v-if="s.config?.ip_start"> · clients en {{ s.config.ip_start }} – {{ s.config.ip_end }}</template>
          </p>
          <form v-if="s.config && settings[s.id]" @submit.prevent="saveSettings(s)">
            <label v-if="s.config.port !== undefined && s.config.port !== null && (s.config.conf_wireguard || s.config.conf_openvpn)" class="inline">
              Port <input v-model="settings[s.id].port" class="port-input">
            </label>
            <p v-else-if="s.config.port_ike" class="small muted">Ports IKE {{ s.config.port_ike }} et NAT {{ s.config.port_nat }}</p>
            <label v-if="s.config.conf_wireguard" class="inline">MTU <input v-model="settings[s.id].mtu" class="port-input"></label>
            <template v-if="s.config.conf_openvpn">
              <label class="inline">Chiffrement
                <select v-model="settings[s.id].cipher"><option v-for="(l, c) in CIPHERS" :key="c" :value="c">{{ l }}</option></select>
              </label>
              <label class="check"><input v-model="settings[s.id].useTcp" type="checkbox"> TCP au lieu d'UDP</label>
              <label class="check"><input v-model="settings[s.id].disableFragment" type="checkbox"> Désactiver la fragmentation</label>
            </template>
            <template v-if="typeof settings[s.id].enableIpv4 === 'boolean' && !['openvpn_bridge', 'pptp', 'wireguard'].includes(s.id)">
              <label class="check"><input v-model="settings[s.id].enableIpv4" type="checkbox"> IPv4</label>
              <label class="check"><input v-model="settings[s.id].enableIpv6" type="checkbox"> IPv6</label>
            </template>
            <button class="ghost small" :disabled="busy">Enregistrer</button>
          </form>
        </article>
      </div>

      <article class="card">
        <h2>Connexions en cours ({{ data.connections.length }})</h2>
        <table v-if="data.connections.length">
          <thead><tr><th>Utilisateur</th><th>Serveur</th><th>Depuis</th><th>Échangé</th><th /></tr></thead>
          <tbody>
            <tr v-for="c in data.connections" :key="c.id">
              <td>{{ c.user }}<div class="small muted">{{ c.local_ip }}</div></td>
              <td>{{ c.serverLabel }}</td>
              <td>{{ c.src_ip }}<div class="small muted">{{ c.auth_time ? date(c.auth_time) : '' }}</div></td>
              <td class="small">↓ {{ bytes(c.tx_bytes) }} · ↑ {{ bytes(c.rx_bytes) }}</td>
              <td class="actions"><button class="danger small" :disabled="busy" @click="disconnect(c)">Déconnecter</button></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">Personne n'est connecté.</p>
      </article>

      <article class="card">
        <h2>Utilisateurs ({{ data.users.length }})</h2>
        <table v-if="data.users.length">
          <thead><tr><th>Identifiant</th><th>Type</th><th>IP réservée</th><th /></tr></thead>
          <tbody>
            <tr v-for="u in data.users" :key="u.login">
              <td>{{ u.login }}</td>
              <td>{{ u.type === 'wireguard' ? 'WireGuard' : 'Standard (OpenVPN, IPsec, PPTP)' }}</td>
              <td>{{ u.ip_reservation || '—' }}</td>
              <td class="actions">
                <button v-for="srv in u.configServers" :key="srv.id" class="ghost small" @click="showConfig(u, srv)">Fichier {{ srv.label }}</button>
                <button class="ghost small" @click="editUser(u)">Modifier</button>
                <button class="danger small" :disabled="busy" @click="removeUser(u)">Supprimer</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">Aucun accès VPN.</p>
      </article>

      <article v-if="file" class="card">
        <div class="row between">
          <h2>{{ file.server }} · {{ file.login }}</h2>
          <button class="ghost small" @click="file = null">Fermer</button>
        </div>
        <div class="config-file">
          <div v-if="file.qr" class="qr">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-html="file.qr" />
            <p class="small muted">Dans l'appli WireGuard : + puis « Scanner depuis un code QR ».</p>
          </div>
          <pre>{{ file.text }}</pre>
        </div>
        <button @click="download">Télécharger {{ file.fileName }}</button>
        <p class="small muted">Ce fichier contient la clé de l'accès : ne le partage pas.</p>
      </article>

      <article id="vpn-user-form" class="card">
        <h2>{{ editingLogin ? `Modifier ${editingLogin}` : 'Créer un accès' }}</h2>
        <form @submit.prevent="saveUser">
          <div class="row">
            <input v-model="userForm.login" placeholder="Identifiant" :disabled="Boolean(editingLogin)" required aria-label="Identifiant">
            <select v-model="userForm.type" :disabled="Boolean(editingLogin)" aria-label="Type">
              <option value="wireguard">WireGuard</option>
              <option value="standard">Standard (OpenVPN, IPsec, PPTP)</option>
            </select>
            <input v-if="userForm.type === 'standard'" v-model="userForm.password" type="password" :placeholder="editingLogin ? 'Mot de passe (inchangé)' : 'Mot de passe (8 à 32)'" aria-label="Mot de passe">
            <input v-model="userForm.ip" class="ip-input" :placeholder="userForm.type === 'wireguard' ? 'IP réservée' : 'IP réservée (option)'" aria-label="IP réservée">
            <label v-if="userForm.type === 'wireguard'" class="inline">Keepalive <input v-model="userForm.keepalive" class="port-input"> s</label>
          </div>
          <div class="row">
            <button :disabled="busy">{{ editingLogin ? 'Enregistrer' : 'Créer' }}</button>
            <button v-if="editingLogin" type="button" class="ghost" @click="cancelUser">Annuler</button>
          </div>
          <p v-if="data.pool?.ip_start" class="muted small">Plage du VPN : {{ data.pool.ip_start }} – {{ data.pool.ip_end }}.</p>
        </form>
      </article>
    </template>
  </section>
</template>
