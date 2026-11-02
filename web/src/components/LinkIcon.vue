<script setup>
// Pastille ronde : Wi-Fi ou câble selon la connexion de l'appareil, fond rouge s'il est en ligne, gris sinon
const props = defineProps({
  link: { type: String, default: null },
  online: { type: Boolean, default: false },
});
const title = () => `${props.link === 'wifi' ? 'Wi-Fi' : props.link === 'ethernet' ? 'Câble' : 'Connexion inconnue'} · ${props.online ? 'connecté' : 'déconnecté'}`;
</script>

<template>
  <span class="link-icon" :class="{ on: online }" :title="title()" role="img" :aria-label="title()">
    <svg v-if="link === 'wifi'" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 9.5a13.5 13.5 0 0 1 19 0" />
      <path d="M5.8 12.8a8.8 8.8 0 0 1 12.4 0" />
      <path d="M9.1 16.1a4.1 4.1 0 0 1 5.8 0" />
      <circle cx="12" cy="19.2" r="1.3" class="fill" />
    </svg>
    <svg v-else-if="link === 'ethernet'" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 4h14v10h-3v3h-3v3h-2v-3H8v-3H5z" />
      <path d="M9 4v3M12 4v3M15 4v3" />
    </svg>
    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h3l2 -5 4 10 2 -5h5" />
    </svg>
  </span>
</template>

<style scoped>
.link-icon {
  width: 28px; height: 28px; border-radius: 50%; flex: none;
  display: inline-grid; place-items: center;
  background: var(--border); color: var(--muted);
}
.link-icon.on { background: var(--accent); color: #fff; }
.link-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.link-icon svg .fill { fill: currentColor; stroke: none; }
</style>
