<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../../api.js';
import { date } from '../../format.js';

const data = ref(null);
const error = ref('');
const message = ref('');
const busy = ref(false);
const baseUrl = ref('');
const subscriptions = ref([]);

async function load() {
  try {
    data.value = await api('/box-notif');
    if (data.value.supported) {
      baseUrl.value = data.value.baseUrl || window.location.origin;
      subscriptions.value = [...data.value.subscriptions];
    }
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
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function save() {
  const wasRegistered = data.value.registered;
  let dropped = [];
  await act(async () => {
    ({ dropped } = await api('/box-notif', { method: 'PUT', body: { baseUrl: baseUrl.value, subscriptions: subscriptions.value } }));
  }, wasRegistered ? 'Inscription mise à jour' : 'Serveur inscrit : la box va confirmer en appelant son adresse');
  if (dropped?.length && !error.value) {
    message.value += `. La box n'a pas retenu : ${dropped.map(label).join(', ')} (fonction absente ou désactivée sur ta Freebox).`;
  }
}

function unregister() {
  if (!window.confirm('Ne plus recevoir les notifications de la box sur ce serveur ?')) return;
  act(() => api('/box-notif', { method: 'DELETE' }), 'Inscription retirée');
}

function removeTarget(t) {
  if (!window.confirm(`Retirer « ${t.name} » des destinataires des notifications de la box ?`)) return;
  act(() => api(`/box-notif/targets/${encodeURIComponent(t.id)}`, { method: 'DELETE' }), `${t.name} retiré`);
}

const label = (id) => data.value?.subjects.find((s) => s.id === id)?.label ?? id;
const CALLS = { register: 'inscription confirmée', unregister: 'désinscription', send: 'notification reçue' };
</script>

<template>
  <section>
    <RouterLink to="/reseau" class="muted">← Réseau</RouterLink>
    <h1>Notifications de la box</h1>
    <p class="muted small">
      La Freebox prévient elle-même de certains événements (nouvel appareil, redémarrage, mot de passe changé, appel manqué…).
      Ce serveur s'inscrit comme destinataire : chaque notification arrive dans le journal et en notification push sur tes appareils abonnés (Journal et alertes).
    </p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="message" class="ok">{{ message }}</p>
    <template v-if="data">
      <p v-if="!data.supported" class="banner">Ta Freebox ne propose pas encore les notifications (API 11) : mets à jour Freebox OS.</p>
      <template v-else>
        <article class="card">
          <h2>
            <span class="dot" :class="data.confirmed ? 'ok' : data.registered ? 'bad' : 'off'" />
            {{ data.confirmed ? 'Inscrit et confirmé par la box' : data.registered ? 'Inscrit, en attente de la box' : 'Pas inscrit' }}
          </h2>
          <p v-if="data.registered && !data.confirmed" class="small">
            La box n'a pas encore appelé ce serveur : vérifie qu'elle peut joindre l'adresse ci-dessous (même réseau, ou HTTPS via Nginx Proxy Manager).
          </p>
          <p v-if="data.lastCall" class="muted small">Dernier appel de la box : {{ CALLS[data.lastCall.kind] ?? data.lastCall.kind }}, {{ date(data.lastCall.ts) }}</p>
          <form @submit.prevent="save">
            <label>
              Adresse de ce serveur, vue par la box
              <input v-model="baseUrl" placeholder="http://192.168.1.20:8086 ou https://freebox-monitor.mondomaine.fr" required>
            </label>
            <p class="muted small">
              Une IP locale en http suffit (la box et le serveur Docker sont sur le même réseau) ; sinon une adresse https.
              <template v-if="baseUrl">La box appellera {{ baseUrl.replace(/\/+$/, '') }}/box-notif/… (un secret est ajouté automatiquement).</template>
            </p>
            <label v-for="s in data.subjects" :key="s.id" class="check">
              <input v-model="subscriptions" type="checkbox" :value="s.id"> {{ s.label }}
            </label>
            <div class="row">
              <button :disabled="busy">{{ data.registered ? 'Mettre à jour' : 'Inscrire ce serveur' }}</button>
              <button v-if="data.registered" type="button" class="danger" :disabled="busy" @click="unregister">Désinscrire</button>
            </div>
          </form>
        </article>

        <article class="card">
          <h2>Destinataires inscrits sur la box ({{ data.targets.length }})</h2>
          <table v-if="data.targets.length">
            <thead><tr><th>Nom</th><th>Notifications</th><th>Relais</th><th /></tr></thead>
            <tbody>
              <tr v-for="t in data.targets" :key="t.id">
                <td>{{ t.name }}<span v-if="t.mine" class="badge gone">ce serveur</span><div v-if="t.lastUse" class="small muted">utilisé le {{ date(t.lastUse) }}</div></td>
                <td class="small">{{ t.subscriptions.map(label).join(', ') }}</td>
                <td class="small">{{ t.host }}</td>
                <td class="actions"><button v-if="!t.mine" class="danger small" :disabled="busy" @click="removeTarget(t)">Retirer</button></td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">Aucun.</p>
        </article>
      </template>
    </template>
  </section>
</template>
