<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { date } from '../format.js';
import { currentSubscription, disablePush, enablePush, isStandalone, pushSupport } from '../push.js';

const support = ref(pushSupport());
const publicKey = ref('');
const subscriptions = ref([]);
const mine = ref(null); // adresse d'abonnement de ce navigateur
const busy = ref(false);
const info = ref('');
const error = ref('');

const subscribedHere = computed(() => Boolean(mine.value && subscriptions.value.some((s) => s.endpoint === mine.value)));
const installHint = computed(() => !isStandalone());

async function refresh() {
  const data = await api('/push');
  publicKey.value = data.publicKey;
  subscriptions.value = data.subscriptions;
  mine.value = (await currentSubscription().catch(() => null))?.endpoint ?? null;
}

onMounted(async () => {
  try {
    await refresh();
  } catch (e) {
    error.value = e.message;
  }
});

async function run(action, done) {
  busy.value = true;
  info.value = '';
  error.value = '';
  try {
    const result = await action();
    if (result?.subscriptions) subscriptions.value = result.subscriptions;
    mine.value = (await currentSubscription().catch(() => null))?.endpoint ?? null;
    info.value = done;
  } catch (e) {
    error.value = e.message;
    await refresh().catch(() => null); // un abonnement expiré a pu être supprimé
  } finally {
    support.value = pushSupport();
    busy.value = false;
  }
}

const enable = () => run(() => enablePush(publicKey.value), 'Notifications activées sur cet appareil');
const disable = (endpoint) => run(() => disablePush(endpoint), 'Appareil retiré des notifications');
const test = () => run(() => api('/push/test', { method: 'POST', body: {} }), 'Notification de test envoyée');
</script>

<template>
  <article class="card">
    <h2>Notifications push</h2>
    <p class="muted small">
      Les alertes ci-dessus arrivent en notification sur chaque appareil abonné (Chrome, Edge, Firefox, Android,
      iPhone avec l'appli installée), même quand Freebox Monitor est fermé.
    </p>

    <p v-if="support === 'insecure'" class="error">
      Le navigateur n'autorise les notifications qu'en HTTPS. Ouvre Freebox Monitor par son adresse en https
      (Nginx Proxy Manager, voir le README) pour les activer.
    </p>
    <p v-else-if="support === 'ios-install'" class="muted">
      Sur iPhone, installe d'abord l'appli : bouton Partager de Safari, « Sur l'écran d'accueil », puis ouvre-la depuis l'icône.
    </p>
    <p v-else-if="support === 'unsupported'" class="error">Ce navigateur ne gère pas les notifications push.</p>
    <p v-else-if="support === 'denied'" class="error">
      Les notifications sont bloquées pour ce site : autorise-les dans les réglages du navigateur (icône à gauche de l'adresse), puis recharge la page.
    </p>

    <div class="row">
      <button v-if="support === 'ok' && !subscribedHere" :disabled="busy || !publicKey" @click="enable">Activer sur cet appareil</button>
      <button v-if="subscribedHere" class="ghost" :disabled="busy" @click="disable(mine)">Désactiver sur cet appareil</button>
      <button type="button" class="ghost" :disabled="busy || !subscriptions.length" @click="test">Tester la notification</button>
    </div>
    <p v-if="support === 'ok' && installHint" class="muted small">
      Astuce : installe l'appli (menu de Chrome, « Installer Freebox Monitor » ou « Ajouter à l'écran d'accueil ») pour l'ouvrir en un geste depuis une notification.
    </p>

    <h3>Appareils abonnés</h3>
    <ul v-if="subscriptions.length" class="subs">
      <li v-for="s in subscriptions" :key="s.endpoint">
        <span>
          <strong>{{ s.label || 'Navigateur' }}</strong>
          <span v-if="s.endpoint === mine" class="tag">cet appareil</span>
          <br><span class="muted small">Abonné le {{ date(s.createdAt) }}<template v-if="s.lastOk"> · dernière notification reçue par {{ s.service }} le {{ date(s.lastOk) }}</template></span>
        </span>
        <button class="ghost" :disabled="busy" @click="disable(s.endpoint)">Retirer</button>
      </li>
    </ul>
    <p v-else class="muted">Aucun appareil abonné : les alertes restent seulement dans le journal.</p>

    <p v-if="info" class="ok">{{ info }}</p>
    <p v-if="error" class="error">{{ error }}</p>
  </article>
</template>

<style scoped>
.subs { list-style: none; padding: 0; margin: 0 0 0.5rem; }
.subs li { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.25)); }
.subs li:last-child { border-bottom: 0; }
.subs .tag { margin-left: 0.5rem; }
</style>
