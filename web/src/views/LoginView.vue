<script setup>
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PasswordRules from '../components/PasswordRules.vue';
import { api, session, setSession } from '../api.js';
import { passwordRules } from '../password.js';

const route = useRoute();
const router = useRouter();
const username = ref('');
const password = ref('');
const confirm = ref('');
const error = ref('');
const busy = ref(false);

// Aucun compte en base : on crée le premier
const setup = computed(() => session.setupRequired);
const setupReady = computed(() => passwordRules(password.value, username.value).every((r) => r.ok) && password.value === confirm.value);

async function submit() {
  error.value = '';
  if (setup.value && password.value !== confirm.value) {
    error.value = 'Les deux mots de passe sont différents';
    return;
  }
  busy.value = true;
  try {
    const me = await api(setup.value ? '/auth/setup' : '/auth/login', {
      method: 'POST',
      body: { username: username.value, password: password.value },
    });
    setSession(me);
    if (me.mustChange) return router.replace('/compte');
    const next = typeof route.query.suite === 'string' && route.query.suite.startsWith('/') ? route.query.suite : '/';
    router.replace(next === '/connexion' ? '/' : next);
  } catch (e) {
    error.value = e.message;
    password.value = '';
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
      <p v-if="setup" class="muted">Première utilisation : crée le compte de l'interface.</p>
      <label>
        Identifiant
        <input v-model.trim="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
      </label>
      <label>
        Mot de passe
        <input v-model="password" type="password" :autocomplete="setup ? 'new-password' : 'current-password'" required>
      </label>
      <template v-if="setup">
        <label>
          Confirmation
          <input v-model="confirm" type="password" autocomplete="new-password" required>
        </label>
        <PasswordRules :password="password" :username="username" />
      </template>
      <p v-if="error" class="error">{{ error }}</p>
      <button :disabled="busy || (setup && !setupReady)">{{ setup ? 'Créer le compte' : 'Se connecter' }}</button>
    </form>
  </section>
</template>
