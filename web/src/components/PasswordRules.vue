<script setup>
import { computed } from 'vue';
import { passwordRules } from '../password.js';

const props = defineProps({
  password: { type: String, default: '' },
  username: { type: String, default: '' },
});
const rules = computed(() => passwordRules(props.password, props.username));
</script>

<template>
  <ul class="rules" aria-live="polite">
    <li v-for="r in rules" :key="r.label" :class="{ ok: r.ok }">
      <span aria-hidden="true">{{ r.ok ? '✓' : '○' }}</span> {{ r.label }}
    </li>
  </ul>
</template>

<style scoped>
.rules { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 0.15rem 0.8rem; font-size: 0.85rem; color: var(--muted); }
.rules li.ok { color: var(--ok); }
</style>
