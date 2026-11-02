<script setup>
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, session, setSession } from './api.js';
import { live, startLive, stopLive } from './live.js';

const route = useRoute();
const router = useRouter();
const ready = ref(false);
const paired = ref(true);

async function checkPairing() {
  try {
    const info = await api('/freebox');
    paired.value = info.paired;
    if (!info.paired && route.path !== '/association') router.replace('/association');
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
        <RouterLink to="/reseau">Réseau</RouterLink>
        <RouterLink to="/journal">Journal</RouterLink>
      </nav>
      <span class="spacer" />
      <span v-if="live.status?.lastError" class="pill bad" :title="live.status.lastError.message">Freebox injoignable</span>
      <RouterLink to="/compte" class="account" title="Mon compte : changer le mot de passe">{{ session.username }}</RouterLink>
      <button class="ghost" @click="logout">Déconnexion</button>
    </header>
    <main>
      <RouterView v-if="session.authenticated || route.meta.public" />
    </main>
  </div>
</template>
