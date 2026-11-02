<script setup>
// Sommaire des réglages réseau de la box. Les écrans arrivent au fur et à mesure des lots.
const SECTIONS = [
  { to: '/reseau/ip-fixes', title: 'IP fixes', text: 'Baux DHCP statiques, adresses à fixer, rappel des appareils surveillés' },
];
</script>

<template>
  <section>
    <h1>Réseau</h1>
    <div class="grid">
      <RouterLink v-for="s in SECTIONS" :key="s.to" :to="s.to" class="card link-card">
        <h2>{{ s.title }}</h2>
        <p class="muted">{{ s.text }}</p>
      </RouterLink>
    </div>
    <p class="muted small">Ces écrans modifient la box : il faut le droit « Modification des réglages de la Freebox » pour l'application dans Freebox OS.</p>
  </section>
</template>
