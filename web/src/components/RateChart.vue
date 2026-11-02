<script setup>
// Courbe des débits descendant / montant. points : [[ts, descendant, montant], ...] en octets/s
import { CategoryScale, Chart, Filler, LinearScale, LineController, LineElement, PointElement, Tooltip } from 'chart.js';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { rate } from '../format.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);

const props = defineProps({
  points: { type: Array, required: true },
  range: { type: Number, default: 3600 },
});

const canvas = ref(null);
let chart = null;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function timeLabel(ts) {
  const d = new Date(ts * 1000);
  let opts = { hour: '2-digit', minute: '2-digit' };
  if (props.range > 2 * 86400) opts = { day: '2-digit', month: '2-digit' };
  else if (props.range <= 600) opts = { ...opts, second: '2-digit' };
  return d.toLocaleString('fr-FR', opts);
}

function data() {
  // Mb/s pour l'axe, plus lisible qu'en octets
  const mbps = (v) => (v === null ? null : (v * 8) / 1e6);
  return {
    datasets: [
      {
        label: 'Descendant',
        data: props.points.map(([t, down]) => ({ x: t, y: mbps(down) })),
        borderColor: css('--down'),
        backgroundColor: `${css('--down')}22`,
        fill: true,
      },
      {
        label: 'Montant',
        data: props.points.map(([t, , up]) => ({ x: t, y: mbps(up) })),
        borderColor: css('--up'),
        backgroundColor: `${css('--up')}22`,
        fill: true,
      },
    ],
  };
}

onMounted(() => {
  const grid = css('--grid');
  const text = css('--muted');
  chart = new Chart(canvas.value, {
    type: 'line',
    data: data(),
    options: {
      animation: false,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false },
      elements: { point: { radius: 0 }, line: { borderWidth: 1.5, tension: 0 } },
      scales: {
        x: { type: 'linear', grid: { color: grid }, ticks: { color: text, maxTicksLimit: 7, callback: (v) => timeLabel(v) } },
        y: { beginAtZero: true, grid: { color: grid }, ticks: { color: text, callback: (v) => `${v} Mb/s` } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].parsed.x * 1000).toLocaleString('fr-FR'),
            label: (item) => `${item.dataset.label} : ${rate((item.parsed.y * 1e6) / 8)}`,
          },
        },
      },
    },
  });
});

watch(() => [props.points, props.points.length], () => {
  if (!chart) return;
  chart.data = data();
  chart.update('none');
});

onBeforeUnmount(() => chart?.destroy());
</script>

<template>
  <div class="chart"><canvas ref="canvas" /></div>
</template>
