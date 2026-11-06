<script setup>
// Pop-up du test de débit : jauge animée façon Speedtest (ping, débit descendant, débit montant).
// Le test tourne sur le serveur (client Speedtest by Ookla) ; la progression arrive par le flux temps réel.
import { computed, ref, watch } from 'vue';
import { api, session } from '../api.js';
import { date } from '../format.js';
import { live } from '../live.js';

const emit = defineEmits(['done']);
const dialog = ref(null);
const state = ref(null);
const history = ref([]);
const error = ref('');
const starting = ref(false);

// Échelle non linéaire de la jauge, en Mb/s
const STOPS = [0, 10, 50, 100, 250, 500, 1000, 2500, 5000];
const CX = 150;
const CY = 150;
const R = 110;
const START = -135;
const SPAN = 270;

const frac = (v) => {
  if (!(v > 0)) return 0;
  for (let i = 1; i < STOPS.length; i += 1) {
    if (v <= STOPS[i]) return (i - 1 + (v - STOPS[i - 1]) / (STOPS[i] - STOPS[i - 1])) / (STOPS.length - 1);
  }
  return 1;
};
const point = (deg, r) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};
const [ax, ay] = point(START, R);
const [bx, by] = point(START + SPAN, R);
const ARC = `M${ax.toFixed(1)},${ay.toFixed(1)} A${R},${R} 0 1 1 ${bx.toFixed(1)},${by.toFixed(1)}`;
const TICKS = STOPS.map((s, i) => {
  const [x, y] = point(START + (SPAN * i) / (STOPS.length - 1), R - 26);
  return { x: x.toFixed(1), y: (y + 4).toFixed(1), label: s >= 1000 ? `${s / 1000}G` : String(s) };
});

const PHASES = {
  start: 'Préparation…',
  ping: 'Mesure du ping',
  download: 'Débit descendant',
  upload: 'Débit montant',
  done: 'Terminé · débit descendant',
  error: 'Échec du test',
};

const running = computed(() => Boolean(state.value?.running));
const phase = computed(() => state.value?.phase ?? null);
// Valeur montrée par l'aiguille : débit de l'étape en cours, sinon zéro
const gaugeValue = computed(() => {
  if (phase.value === 'download') return state.value.down ?? 0;
  if (phase.value === 'upload') return state.value.up ?? 0;
  // Test terminé : la jauge garde le débit descendant
  if (phase.value === 'done') return state.value.down ?? 0;
  return 0;
});
const gaugeColor = computed(() => (phase.value === 'upload' ? 'var(--up)' : 'var(--down)'));
const needleDeg = computed(() => START + SPAN * frac(gaugeValue.value));
const bigText = computed(() => {
  if (['download', 'upload', 'done'].includes(phase.value)) return num(gaugeValue.value);
  if (phase.value === 'ping') return state.value.ping === null ? '…' : num(state.value.ping);
  return '–';
});
const bigUnit = computed(() => (phase.value === 'ping' ? 'ms' : 'Mb/s'));

const serverText = computed(() => {
  const s = state.value?.server;
  if (!s) return 'Serveur le plus proche';
  return [s.name, s.location].filter(Boolean).join(' · ');
});

function num(v) {
  if (v === null || v === undefined) return '–';
  return v >= 100 ? String(Math.round(v)) : v.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
}

async function load() {
  try {
    const r = await api('/speedtest');
    history.value = r.history;
    const { history: _h, ...s } = r;
    state.value = s.phase ? s : null;
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}

async function start() {
  starting.value = true;
  error.value = '';
  try {
    state.value = await api('/speedtest', { method: 'POST', body: {} });
  } catch (e) {
    error.value = e.message;
  } finally {
    starting.value = false;
  }
}

// Progression poussée par le serveur
watch(() => live.speedtest, (s) => {
  if (!s) return;
  state.value = s;
  if (s.phase === 'done' && s.result) {
    if (!history.value.some((h) => h.id === s.result.id)) history.value = [s.result, ...history.value].slice(0, 20);
    emit('done', s.result);
  }
});

async function open() {
  dialog.value.showModal();
  await load();
}
function close() {
  dialog.value.close();
}
defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="speedtest" aria-labelledby="speedtest-title" @click.self="close">
    <div class="box">
      <div class="head">
        <h2 id="speedtest-title">Test de débit</h2>
        <button class="ghost x" type="button" aria-label="Fermer" @click="close">×</button>
      </div>
      <p class="muted small">Serveur : {{ serverText }}<template v-if="state?.isp && state.isp !== state.server?.name"> · {{ state.isp }}</template></p>

      <svg class="gauge" viewBox="0 0 300 240" role="img" :aria-label="`${PHASES[phase] ?? 'Prêt'} : ${bigText} ${bigUnit}`">
        <text v-for="t in TICKS" :key="t.label" :x="t.x" :y="t.y" text-anchor="middle" class="tick">{{ t.label }}</text>
        <path :d="ARC" class="track" pathLength="1" />
        <path v-if="gaugeValue > 0" :d="ARC" class="arc" pathLength="1" :stroke="gaugeColor" :stroke-dasharray="`${frac(gaugeValue)} 1`" />
        <g class="needle" :style="{ transform: `rotate(${needleDeg}deg)` }">
          <line x1="150" y1="150" x2="150" y2="68" />
        </g>
        <circle cx="150" cy="150" r="7" class="hub" />
        <text x="150" y="198" text-anchor="middle" class="value">{{ bigText }}</text>
        <text x="150" y="217" text-anchor="middle" class="unit">{{ bigUnit }}</text>
      </svg>
      <p class="phase" :class="{ error: phase === 'error' }">{{ phase ? PHASES[phase] : 'Prêt' }}</p>

      <div class="metrics">
        <div class="metric ping" :class="{ active: phase === 'ping' }">
          <span class="label">Ping</span><strong>{{ num(state?.ping) }}</strong><span class="muted small">ms</span>
        </div>
        <div class="metric down" :class="{ active: phase === 'download' }">
          <span class="label">↓ Descendant</span><strong>{{ num(state?.down) }}</strong><span class="muted small">Mb/s</span>
        </div>
        <div class="metric up" :class="{ active: phase === 'upload' }">
          <span class="label">↑ Montant</span><strong>{{ num(state?.up) }}</strong><span class="muted small">Mb/s</span>
        </div>
      </div>

      <p v-if="state?.error" class="error small">{{ state.error }}</p>
      <p v-if="error" class="error small">{{ error }}</p>

      <div class="foot">
        <span class="muted small">
          <template v-if="state?.busy">Trafic des autres appareils au lancement : ↓ {{ num(state.busy.down) }} · ↑ {{ num(state.busy.up) }} Mb/s</template>
          <template v-else-if="running">Le test dure une vingtaine de secondes et utilise toute la connexion.</template>
          <a v-if="state?.url && !running" :href="state.url" target="_blank" rel="noopener"> · Voir sur speedtest.net</a>
        </span>
        <button type="button" :disabled="running || starting" @click="start">
          {{ running ? (state?.by && state.by !== session.username ? `Test lancé par ${state.by}…` : 'Test en cours…') : phase ? 'Relancer' : 'Lancer le test' }}
        </button>
      </div>

      <details v-if="history.length" class="history">
        <summary>Derniers tests ({{ history.length }})</summary>
        <table>
          <thead><tr><th>Date</th><th>Ping</th><th>↓ Mb/s</th><th>↑ Mb/s</th></tr></thead>
          <tbody>
            <tr v-for="h in history" :key="h.id">
              <td>{{ date(h.ts) }}<div class="muted small">{{ h.by }}</div></td>
              <td>{{ num(h.ping) }}</td>
              <td class="down">{{ num(h.down) }}</td>
              <td class="up">{{ num(h.up) }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </div>
  </dialog>
</template>

<style scoped>
.speedtest { border: 0; padding: 0; border-radius: 16px; background: var(--card); color: var(--text); width: min(440px, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); }
.speedtest::backdrop { background: rgb(0 0 0 / 45%); }
.box { padding: 1rem 1.1rem 1.1rem; }
.head { display: flex; justify-content: space-between; align-items: center; }
.head h2 { margin: 0; }
.x { font-size: 1.3rem; line-height: 1; padding: 0.1rem 0.5rem; }
.gauge { display: block; width: 100%; max-width: 340px; margin: 0 auto; }
.tick { font-size: 10px; fill: var(--muted); }
.track, .arc { fill: none; stroke-width: 16; stroke-linecap: round; }
.track { stroke: var(--grid); }
.arc { transition: stroke-dasharray 0.25s linear, stroke 0.3s; }
.needle { transform-origin: 150px 150px; transition: transform 0.25s linear; }
.needle line { stroke: var(--text); stroke-width: 3; stroke-linecap: round; }
.hub { fill: var(--text); }
.value { font-size: 30px; font-weight: 700; fill: var(--text); font-variant-numeric: tabular-nums; }
.unit { font-size: 11px; fill: var(--muted); }
.phase { text-align: center; margin: 0.2rem 0 0.6rem; font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.phase.error { color: var(--bad); }
.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
.metric { display: flex; flex-direction: column; align-items: center; border: 1px solid var(--border); border-radius: 10px; padding: 0.5rem 0.25rem; transition: border-color 0.2s; }
.metric strong { font-size: 1.25rem; font-variant-numeric: tabular-nums; }
.metric .label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.metric.ping.active { border-color: var(--ok); }
.metric.down.active { border-color: var(--down); }
.metric.up.active { border-color: var(--up); }
.foot { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.8rem; }
.history { margin-top: 0.8rem; }
.history summary { cursor: pointer; color: var(--muted); font-size: 0.9rem; }
.history table { width: 100%; border-collapse: collapse; font-size: 0.88rem; margin-top: 0.4rem; }
.history th, .history td { text-align: right; padding: 0.3rem 0.25rem; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.history th:first-child, .history td:first-child { text-align: left; }
.down { color: var(--down); }
.up { color: var(--up); }
@media (prefers-reduced-motion: reduce) { .arc, .needle { transition: none; } }
</style>
