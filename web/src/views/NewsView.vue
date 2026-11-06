<script setup>
// Nouveautés Free : tout le flux du blog de Free gardé par le serveur, avec recherche et filtres
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import NewsList from '../components/NewsList.vue';
import { ago } from '../format.js';

const TYPES = [
  { id: 'all', label: 'Tout' }, { id: 'server', label: 'Box' }, { id: 'repeater', label: 'Répéteurs' }, { id: 'other', label: 'Autres' },
];
const PERIODS = [
  { id: 'all', label: 'Toutes dates', days: null }, { id: '30', label: '30 jours', days: 30 },
  { id: '180', label: '6 mois', days: 180 }, { id: '365', label: '1 an', days: 365 },
];
const PAGE = 20;

const data = ref(null);
const error = ref('');
const info = ref('');
const busy = ref(false);
const query = ref('');
const type = ref('all');
const period = ref('all');
const mineOnly = ref(false);
const oldestFirst = ref(false);
const categories = ref(new Set());
const shown = ref(PAGE);

async function load() {
  try {
    data.value = await api('/equipment/news');
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(load);

async function refresh(all) {
  busy.value = true;
  error.value = '';
  info.value = '';
  try {
    data.value = await api('/equipment/news/refresh', { method: 'POST', body: { all } });
    const added = data.value.added ?? 0;
    info.value = data.value.error ? '' : added ? `${added} nouveau${added > 1 ? 'x' : ''} billet${added > 1 ? 's' : ''}` : 'Aucun nouveau billet';
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

// Catégories présentes dans le flux, des plus fréquentes aux plus rares
const allCategories = computed(() => {
  const count = new Map();
  for (const i of data.value?.items ?? []) for (const c of i.categories) count.set(c, (count.get(c) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr')).map(([name, n]) => ({ name, n }));
});
function toggleCategory(name) {
  const next = new Set(categories.value);
  if (next.has(name)) next.delete(name); else next.add(name);
  categories.value = next;
  shown.value = PAGE;
}

// Sans accents, majuscules ni tirets : « wifi » trouve « Wi-Fi », « repeteur » trouve « Répéteur »
const normalize = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9.\s]+/g, '');
const filtered = computed(() => {
  const words = normalize(query.value).split(/\s+/).filter(Boolean);
  const days = PERIODS.find((p) => p.id === period.value).days;
  const since = days ? Date.now() / 1000 - days * 86400 : null;
  const items = (data.value?.items ?? []).filter((i) => {
    if (type.value === 'other' ? i.target : type.value !== 'all' && i.target !== type.value) return false;
    if (mineOnly.value && !i.mine) return false;
    if (since && (i.ts ?? 0) < since) return false;
    if (categories.value.size && !i.categories.some((c) => categories.value.has(c))) return false;
    if (words.length) {
      const text = normalize(`${i.title} ${i.summary ?? ''} ${i.content ?? ''} ${i.categories.join(' ')}`);
      if (!words.every((w) => text.includes(w))) return false;
    }
    return true;
  });
  return oldestFirst.value ? [...items].reverse() : items;
});
const visible = computed(() => filtered.value.slice(0, shown.value));
const filtersOn = computed(() => query.value || type.value !== 'all' || period.value !== 'all' || mineOnly.value || categories.value.size);
function reset() {
  query.value = '';
  type.value = 'all';
  period.value = 'all';
  mineOnly.value = false;
  categories.value = new Set();
  shown.value = PAGE;
}
</script>

<template>
  <section>
    <p><RouterLink to="/equipements">← Équipements Free</RouterLink></p>
    <div class="row between">
      <h1>Nouveautés Free</h1>
      <div class="row">
        <button class="ghost small" :disabled="busy" @click="refresh(false)">{{ busy ? 'Lecture…' : 'Actualiser' }}</button>
        <button class="ghost small" :disabled="busy" title="Lit aussi les pages plus anciennes du flux" @click="refresh(true)">Charger les anciens billets</button>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="data?.error" class="error">{{ data.error }}</p>
    <p v-if="info" class="ok">{{ info }}</p>

    <article v-if="data" class="card">
      <div class="toolbar">
        <input v-model="query" type="search" placeholder="Rechercher (titre, texte, version…)" @input="shown = PAGE">
        <select v-model="period" @change="shown = PAGE">
          <option v-for="p in PERIODS" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
        <select v-model="oldestFirst">
          <option :value="false">Plus récents d'abord</option>
          <option :value="true">Plus anciens d'abord</option>
        </select>
      </div>
      <div class="row between">
        <div class="tabs">
          <button v-for="t in TYPES" :key="t.id" :class="{ active: type === t.id }" @click="type = t.id; shown = PAGE">{{ t.label }}</button>
        </div>
        <label class="check"><input v-model="mineOnly" type="checkbox" @change="shown = PAGE"> Seulement ce qui concerne mon matériel</label>
      </div>
      <div v-if="allCategories.length" class="row news-categories">
        <span class="muted small">Catégories :</span>
        <button v-for="c in allCategories" :key="c.name" class="small" :class="categories.has(c.name) ? '' : 'ghost'" @click="toggleCategory(c.name)">
          {{ c.name }} <span class="muted">({{ c.n }})</span>
        </button>
      </div>
      <p class="muted small">
        {{ filtered.length }} billet{{ filtered.length > 1 ? 's' : '' }} sur {{ data.items.length }}
        <button v-if="filtersOn" class="ghost small" @click="reset">Effacer les filtres</button>
      </p>
    </article>

    <article v-if="data" class="card">
      <NewsList v-if="visible.length" :items="visible" />
      <p v-else class="muted">{{ data.items.length ? 'Aucun billet ne correspond aux filtres.' : 'Le flux n\'a pas encore été lu : clique sur Actualiser.' }}</p>
      <div v-if="filtered.length > shown" class="row">
        <button class="ghost small" @click="shown += PAGE">Afficher {{ Math.min(PAGE, filtered.length - shown) }} de plus</button>
      </div>
    </article>
    <p v-if="data" class="muted small">
      Billets du blog de Free (dev.freebox.fr) gardés par le serveur au fil des lectures (500 au plus), relus toutes les 6 h<template v-if="data.ts"> · dernière lecture {{ ago(data.ts) }}</template>.
    </p>
  </section>
</template>
