<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, session } from '../api.js';

const route = useRoute();
const router = useRouter();
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await api('/auth/login', { method: 'POST', body: { password: password.value } });
    session.authenticated = true;
    const next = typeof route.query.suite === 'string' && route.query.suite.startsWith('/') ? route.query.suite : '/';
    router.replace(next === '/connexion' ? '/' : next);
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="center">
    <form class="card narrow" @submit.prevent="submit">
      <img src="/icon.svg" alt="" width="48" height="48">
      <h1>Freebox Monitor</h1>
      <label>
        Mot de passe
        <input v-model="password" type="password" autocomplete="current-password" required autofocus>
      </label>
      <p v-if="error" class="error">{{ error }}</p>
      <button :disabled="busy">Se connecter</button>
    </form>
  </section>
</template>
