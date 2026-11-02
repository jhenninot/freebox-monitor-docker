<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';

const router = useRouter();
const info = ref(null);
const step = ref('idle'); // idle, pending, granted, denied, timeout
const error = ref('');
let timer = null;

onMounted(async () => {
  info.value = await api('/freebox').catch((e) => { error.value = e.message; return null; });
});
onUnmounted(() => clearInterval(timer));

async function start() {
  error.value = '';
  try {
    const r = await api('/freebox/pair', { method: 'POST', body: { deviceName: 'Serveur Docker' } });
    info.value = { ...info.value, boxName: r.boxName };
    step.value = 'pending';
    timer = setInterval(poll, 2000);
  } catch (e) {
    error.value = e.message;
  }
}

async function poll() {
  try {
    const { status } = await api('/freebox/pair');
    if (status === 'pending') return;
    clearInterval(timer);
    step.value = status;
    if (status === 'granted') setTimeout(() => router.replace('/'), 1500);
  } catch (e) {
    clearInterval(timer);
    error.value = e.message;
    step.value = 'idle';
  }
}

async function unpair() {
  await api('/freebox/pair', { method: 'DELETE' });
  info.value = await api('/freebox');
  step.value = 'idle';
}
</script>

<template>
  <section class="center">
    <div class="card narrow">
      <h1>Association avec la Freebox</h1>
      <template v-if="info?.paired && step !== 'granted'">
        <p>Le serveur est associé à <strong>{{ info.boxName }}</strong> (API v{{ info.apiMajor }}).</p>
        <div class="row">
          <RouterLink to="/" class="button">Retour à l'accueil</RouterLink>
          <button class="danger" @click="unpair">Supprimer l'association</button>
        </div>
      </template>
      <template v-else-if="step === 'idle'">
        <p>Le serveur va demander l'accès à la Freebox joignable à <code>{{ info?.url }}</code>.</p>
        <p>Il faudra valider la demande sur l'écran du Freebox Server (flèche de droite), ou dans l'appli Freebox Connect pour une Freebox Pop.</p>
        <button @click="start">Associer</button>
      </template>
      <template v-else-if="step === 'pending'">
        <p class="big">Valide la demande sur l'écran de la Freebox…</p>
        <p class="muted">{{ info?.boxName }} attend ta réponse.</p>
      </template>
      <template v-else-if="step === 'granted'">
        <p class="big ok">Association validée</p>
        <p class="muted">Pour renommer des appareils, coche « Modification des réglages de la Freebox » pour « Freebox Monitor (serveur) » dans Freebox OS, Paramètres de la Freebox &gt; Gestion des accès &gt; Applications.</p>
      </template>
      <template v-else>
        <p class="error">{{ step === 'denied' ? 'Demande refusée sur la Freebox.' : 'Délai dépassé, la demande n\'a pas été validée.' }}</p>
        <button @click="start">Recommencer</button>
      </template>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </section>
</template>
