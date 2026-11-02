<script setup>
// Icône du type d'appareil donné par la box (host_type)
import { computed } from 'vue';
import { HOST_TYPES } from '../format.js';

const props = defineProps({ type: { type: String, default: 'other' } });

const GROUPS = {
  workstation: 'desktop', laptop: 'laptop', smartphone: 'phone', ip_phone: 'phone', tablet: 'tablet', printer: 'printer',
  vg_console: 'console', television: 'tv', multimedia_device: 'tv', freebox_player: 'tv', freebox_hd: 'tv',
  freebox_crystal: 'tv', freebox_mini: 'tv', freebox_one: 'tv', freebox_pop: 'tv', freebox_delta: 'router',
  nas: 'nas', ip_camera: 'camera', networking_device: 'router', freebox_wifi: 'router', car: 'car', watch: 'watch',
  light: 'home', outlet: 'home', appliances: 'home', thermostat: 'home', shutter: 'home',
};
// Tracés au trait, 24 × 24
const PATHS = {
  desktop: ['M3 4h18v12H3z', 'M8 20h8', 'M12 16v4'],
  laptop: ['M5 5h14v10H5z', 'M2 19h20l-2-4H4z'],
  phone: ['M7 2h10v20H7z', 'M11 18h2'],
  tablet: ['M4 3h16v18H4z', 'M11 18h2'],
  printer: ['M6 9V3h12v6', 'M6 17H4v-8h16v8h-2', 'M6 14h12v7H6z'],
  console: ['M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L14 15h-4l-1 .6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4z', 'M7 11v3M5.5 12.5h3', 'M16 12h.01M18 13.5h.01'],
  tv: ['M3 6h18v12H3z', 'M8 21h8', 'M8 2l4 4 4-4'],
  nas: ['M5 3h14v18H5z', 'M5 9h14M5 15h14', 'M8 6h.01M8 12h.01M8 18h.01'],
  camera: ['M3 7h12v10H3z', 'M15 10l6-3v10l-6-3'],
  router: ['M3 14h18v6H3z', 'M7 17h.01M11 17h.01', 'M8 14l-2-8M16 14l2-8'],
  car: ['M5 11l2-5h10l2 5', 'M3 11h18v6H3z', 'M7 17v2M17 17v2', 'M7 14h.01M17 14h.01'],
  watch: ['M7 6h10v12H7z', 'M9 6l1-4h4l1 4M9 18l1 4h4l1-4', 'M12 10v2l1.5 1'],
  home: ['M3 11l9-8 9 8', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
  other: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7', 'M12 17h.01'],
};
const paths = computed(() => PATHS[GROUPS[props.type] ?? 'other']);
const label = computed(() => HOST_TYPES[props.type] ?? props.type ?? 'Autre');
</script>

<template>
  <span class="type-icon" :title="label" role="img" :aria-label="label">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path v-for="d in paths" :key="d" :d="d" /></svg>
  </span>
</template>

<style scoped>
.type-icon { width: 34px; height: 34px; border-radius: 10px; flex: none; display: inline-grid; place-items: center; background: var(--bg); color: var(--text); }
.type-icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
</style>
