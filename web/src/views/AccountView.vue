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

// Changement d'identifiant
const newUsername = ref('');
const renamePassword = ref('');
const renameError = ref('');
const renamed = ref(false);
const renaming = ref(false);
const usernameOk = computed(() => /^[a-zA-Z0-9._-]{3,32}$/.test(newUsername.value) && newUsername.value !== session.username);

async function rename() {
  renameError.value = '';
  renamed.value = false;
  renaming.value = true;
  try {
    setSession(await api('/auth/username', { method: 'POST', body: { currentPassword: renamePassword.value, newUsername: newUsername.value } }));
    newUsername.value = '';
    renamePassword.value = '';
    renamed.value = true;
  } catch (e) {
    renameError.value = e.message;
  } finally {
    renaming.value = false;
  }
}

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
  <section class="center account">
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

    <form v-if="!forced" class="card narrow" @submit.prevent="rename">
      <h2>Changer l'identifiant</h2>
      <label>
        Nouvel identifiant
        <input v-model.trim="newUsername" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" required>
      </label>
      <p class="muted">3 à 32 caractères : lettres, chiffres, point, tiret et souligné.</p>
      <label>
        Mot de passe actuel
        <input v-model="renamePassword" type="password" autocomplete="current-password" required>
      </label>
      <p v-if="renameError" class="error">{{ renameError }}</p>
      <p v-if="renamed" class="ok">Identifiant changé : utilise-le à la prochaine connexion.</p>
      <button :disabled="renaming || !usernameOk || !renamePassword">Changer l'identifiant</button>
    </form>
  </section>
</template>

<style scoped>
.account { align-content: center; gap: 0; }
</style>
