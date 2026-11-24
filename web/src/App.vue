<script setup>
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, session, setSession } from './api.js';
import { live, startLive, stopLive } from './live.js';

const route = useRoute();
const router = useRouter();
const ready = ref(false);
const paired = ref(true);
// Détail de l'erreur de collecte (le survol du badge n'existe pas sur mobile)
const showError = ref(false);
const when = (ts) => new Date(ts * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function checkPairing() {
  try {
    const info = await api('/freebox');
    paired.value = info.paired;
    if (!info.paired && !['/association', '/compte'].includes(route.path)) router.replace('/association');
  } catch {
    // erreur réseau : on reste sur l'écran courant
  }
}

onMounted(async () => {
  try {
    setSession(await api('/auth/me'));
  } catch {
    session.authenticated = false;
  }
  ready.value = true;
});

watch(() => session.authenticated, async (auth) => {
  if (auth === false) {
    stopLive();
    if (route.path !== '/connexion') router.replace({ path: '/connexion', query: { suite: route.fullPath } });
  } else if (auth) {
    startLive();
    if (session.mustChange) router.replace('/compte');
    else await checkPairing();
  }
});

// Mot de passe à changer (ancien ADMIN_PASSWORD trop faible ou mot de passe provisoire) : seul l'écran du compte est accessible
watch(() => [session.mustChange, route.path], ([must, p]) => {
  if (session.authenticated && must && p !== '/compte') router.replace('/compte');
});

// Après l'association, l'écran d'association prévient l'appli
watch(() => route.path, (p) => { if (session.authenticated && !session.mustChange && p !== '/association') checkPairing(); });

async function logout() {
  await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  setSession(await api('/auth/me').catch(() => null));
}
</script>

<template>
  <div v-if="ready" class="layout">
    <header v-if="session.authenticated" class="topbar">
      <RouterLink to="/" class="brand">
        <img src="/icon.svg" alt="" width="28" height="28">
        <span>Freebox Monitor</span>
      </RouterLink>
      <nav v-if="paired && !session.mustChange">
        <RouterLink to="/">Accueil</RouterLink>
        <RouterLink to="/appareils">Appareils</RouterLink>
        <RouterLink to="/equipements" title="Équipements Free : Freebox Server et répéteurs Wi-Fi">Équipements</RouterLink>
        <RouterLink to="/reseau">Réseau</RouterLink>
        <RouterLink to="/journal">Journal</RouterLink>
      </nav>
      <span class="spacer" />
      <button v-if="live.status?.lastError" class="pill bad status-pill" :title="live.status.lastError.message" @click="showError = !showError">
        {{ live.status.lastError.unreachable === false ? 'Collecte en erreur' : 'Freebox injoignable' }}
      </button>
      <RouterLink to="/compte" class="account" title="Mon compte : changer le mot de passe">{{ session.username }}</RouterLink>
      <button class="ghost" @click="logout">Déconnexion</button>
    </header>
    <div v-if="session.authenticated && showError && live.status?.lastError" class="status-detail" @click="showError = false">
      <p>{{ live.status.lastError.message }}</p>
      <p class="muted small">
        Depuis {{ when(live.status.lastError.since ?? live.status.lastError.ts) }}
        <template v-if="live.status.lastSuccess"> · dernière réponse de la box {{ when(live.status.lastSuccess) }}</template>
      </p>
    </div>
    <main>
      <RouterView v-if="session.authenticated || route.meta.public" />
    </main>
  </div>
</template>
