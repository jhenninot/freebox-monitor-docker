<script setup>
// Petites icônes dessinées (à la place des emoji) : pin = IP fixe, star = surveillé, warning = avertissement
import { computed } from 'vue';

const props = defineProps({
  name: { type: String, required: true },
  title: { type: String, default: '' },
});
const ICONS = {
  pin: { paths: ['M9 3h6', 'M10 3v6l-3 4h10l-3-4V3', 'M12 13v8'] },
  star: { paths: ['M12 2.5 L14.9 8.5 L21.5 9.4 L16.7 14 L17.9 20.5 L12 17.4 L6.1 20.5 L7.3 14 L2.5 9.4 L9.1 8.5 Z'], fill: true },
  warning: { paths: ['M12 3L2 20h20z', 'M12 10v4', 'M12 17h.01'] },
};
const icon = computed(() => ICONS[props.name] ?? ICONS.warning);
</script>

<template>
  <svg class="icon" :class="[name, { filled: icon.fill }]" viewBox="0 0 24 24" :role="title ? 'img' : undefined" :aria-label="title || undefined" :aria-hidden="title ? undefined : 'true'">
    <title v-if="title">{{ title }}</title>
    <path v-for="d in icon.paths" :key="d" :d="d" />
  </svg>
</template>

<style scoped>
.icon { width: 1em; height: 1em; vertical-align: -0.12em; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.icon.filled { fill: currentColor; stroke-width: 1.2; }
.icon.pin { color: var(--accent); }
.icon.star { color: #e8b10e; }
.icon.warning { color: #b7791f; }
</style>
