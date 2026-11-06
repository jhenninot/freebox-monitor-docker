<script setup>
// Billets du blog de Free : titre, date, résumé, texte complet dépliable
import { ref } from 'vue';
import { date } from '../format.js';

defineProps({ items: { type: Array, required: true }, highlight: { type: String, default: '' } });

const TARGETS = { server: 'Box', repeater: 'Répéteur' };
const opened = ref(new Set());
function toggle(i) {
  const next = new Set(opened.value);
  const id = i.link ?? i.title;
  if (next.has(id)) next.delete(id); else next.add(id);
  opened.value = next;
}
const isOpen = (i) => opened.value.has(i.link ?? i.title);
</script>

<template>
  <ul class="news">
    <li v-for="i in items" :key="i.link ?? i.title" :class="{ mine: i.mine }">
      <div class="row between">
        <a v-if="i.link" :href="i.link" target="_blank" rel="noopener" class="news-title">{{ i.title }}</a>
        <span v-else class="news-title">{{ i.title }}</span>
        <span class="muted small">{{ date(i.ts) }}</span>
      </div>
      <div class="row news-tags">
        <span v-if="i.mine" class="badge new">ton matériel</span>
        <span v-if="TARGETS[i.target]" class="badge gone">{{ i.version ? `${TARGETS[i.target]} ${i.version}` : TARGETS[i.target] }}</span>
        <span v-for="c in i.categories" :key="c" class="badge gone">{{ c }}</span>
      </div>
      <p v-if="!isOpen(i) && i.summary" class="muted small">{{ i.summary }}</p>
      <p v-if="isOpen(i)" class="news-content small">{{ i.content || i.summary }}</p>
      <button v-if="i.content" class="ghost small" @click="toggle(i)">{{ isOpen(i) ? 'Réduire' : 'Lire le billet' }}</button>
    </li>
  </ul>
</template>
