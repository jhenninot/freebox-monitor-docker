<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import PasswordRules from '../components/PasswordRules.vue';
import { api, session, setSession } from '../api.js';
import { passwordRules } from '../password.js';

const router = useRouter();
const current = ref('');
const next = ref('');
const confirm = ref('');
const error = ref('');
const done = ref(false);
const busy = ref(false);

const forced = computed(() => session.mustChange);
const ready = computed(() => current.value && next.value === confirm.value
  && passwordRules(next.value, session.username).every((r) => r.ok));

async function submit() {
  error.value = '';
  done.value = false;
  if (next.value !== confirm.value) {
    error.value = 'Les deux nouveaux mots de passe sont différents';
    return;
  }
  busy.value = true;
  try {
    const wasForced = forced.value;
    setSession(await api('/auth/password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } }));
    current.value = '';
    next.value = '';
    confirm.value = '';
    done.value = true;
    if (wasForced) router.replace('/');
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
      <h1>Mon compte</h1>
      <p class="muted">Connecté en tant que <strong>{{ session.username }}</strong>.</p>
      <p v-if="forced" class="error">
        Ton mot de passe ne respecte pas les règles de sécurité : choisis-en un nouveau pour continuer.
      </p>
      <h2>Changer le mot de passe</h2>
      <input type="text" name="username" autocomplete="username" :value="session.username" hidden readonly>
      <label>
        Mot de passe actuel
        <input v-model="current" type="password" autocomplete="current-password" required>
      </label>
      <label>
        Nouveau mot de passe
        <input v-model="next" type="password" autocomplete="new-password" required>
      </label>
      <label>
        Confirmation
        <input v-model="confirm" type="password" autocomplete="new-password" required>
      </label>
      <PasswordRules :password="next" :username="session.username || ''" />
      <p class="muted">Les autres appareils connectés seront déconnectés.</p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="done" class="ok">Mot de passe changé.</p>
      <button :disabled="busy || !ready">Changer le mot de passe</button>
    </form>
  </section>
</template>
