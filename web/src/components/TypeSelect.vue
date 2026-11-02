<script setup>
// Liste déroulante des types d'appareil avec leur icône (un <select> natif ne sait pas afficher d'images)
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { HOST_TYPES } from '../format.js';
import DeviceTypeIcon from './DeviceTypeIcon.vue';

const model = defineModel({ type: String, default: 'other' });
const open = ref(false);
const active = ref(0);
const root = ref(null);
const list = ref(null);
const options = Object.entries(HOST_TYPES).map(([value, label]) => ({ value, label }));
const current = computed(() => options.find((o) => o.value === model.value) ?? { value: model.value, label: model.value });

async function show() {
  open.value = true;
  active.value = Math.max(0, options.findIndex((o) => o.value === model.value));
  await nextTick();
  list.value?.children[active.value]?.scrollIntoView({ block: 'nearest' });
}
function choose(i) {
  model.value = options[i].value;
  open.value = false;
  root.value?.querySelector('button')?.focus();
}
async function key(e) {
  if (!open.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(); }
    return;
  }
  if (e.key === 'Escape') { open.value = false; return; }
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active.value); return; }
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  active.value = (active.value + step + options.length) % options.length;
  await nextTick();
  list.value?.children[active.value]?.scrollIntoView({ block: 'nearest' });
}
const outside = (e) => { if (open.value && !root.value?.contains(e.target)) open.value = false; };
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
</script>

<template>
  <div ref="root" class="type-select" @keydown="key">
    <button type="button" class="trigger" aria-haspopup="listbox" :aria-expanded="open" aria-label="Type d'appareil" @click="open ? (open = false) : show()">
      <DeviceTypeIcon :type="current.value" small />
      <span class="label">{{ current.label }}</span>
      <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    <ul v-if="open" ref="list" class="options" role="listbox" aria-label="Type d'appareil">
      <li
        v-for="(o, i) in options" :key="o.value" role="option" :aria-selected="o.value === model"
        :class="{ active: i === active, selected: o.value === model }"
        @pointerenter="active = i" @click="choose(i)"
      >
        <DeviceTypeIcon :type="o.value" small />
        <span>{{ o.label }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.type-select { position: relative; flex: 1; min-width: 220px; }
.trigger {
  width: 100%; display: flex; align-items: center; gap: 0.5rem; text-align: left; font-size: 1rem;
  background: var(--bg); color: var(--text); border: 1px solid var(--border); padding: 0.25rem 0.6rem 0.25rem 0.3rem;
}
.trigger .label { flex: 1; }
.chevron { width: 16px; height: 16px; fill: none; stroke: var(--muted); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.options {
  position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 4px); max-height: 320px; overflow-y: auto;
  list-style: none; margin: 0; padding: 0.25rem; background: var(--card); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.15);
}
.options li { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.4rem; border-radius: 8px; cursor: pointer; }
.options li.active { background: var(--bg); }
.options li.selected { font-weight: 600; }
</style>
