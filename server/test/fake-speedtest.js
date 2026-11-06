#!/usr/bin/env node
// Faux client Speedtest by Ookla : même sortie JSON ligne par ligne (-f jsonl -p yes), valeurs fixes.
// FAKE_SPEEDTEST=fail : erreur réseau comme le vrai client (ligne « log » de niveau error, code 2).
const out = (o) => process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...o })}\n`);
const server = { id: 4010, host: 'speedtest.free.fr', port: 8080, name: 'Free SAS', location: 'Paris', country: 'France', ip: '212.27.40.240' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!process.argv.includes('--accept-license') || !process.argv.includes('jsonl')) process.exit(3);

if (process.env.FAKE_SPEEDTEST === 'fail') {
  process.stderr.write(`${JSON.stringify({ type: 'log', level: 'error', message: 'Cannot open socket: Timeout occurred in connect.' })}\n`);
  process.exit(2);
}
const delay = Number(process.env.FAKE_SPEEDTEST_DELAY_MS || 5);
out({ type: 'testStart', isp: 'Free SAS', interface: { internalIp: '192.168.1.94', externalIp: '82.64.1.2' }, server });
for (let p = 0.25; p <= 1; p += 0.25) { out({ type: 'ping', ping: { jitter: 0.4, latency: 4 + p, progress: p } }); await sleep(delay); }
for (let p = 0.1; p <= 1.001; p += 0.1) { out({ type: 'download', download: { bandwidth: 115_000_000 * p, bytes: 1e8 * p, elapsed: 8000 * p, progress: p } }); await sleep(delay); }
for (let p = 0.1; p <= 1.001; p += 0.1) { out({ type: 'upload', upload: { bandwidth: 73_000_000 * p, bytes: 5e7 * p, elapsed: 8000 * p, progress: p } }); await sleep(delay); }
out({
  type: 'result',
  ping: { jitter: 0.42, latency: 4.21, low: 3.9, high: 5.1 },
  download: { bandwidth: 115_123_456, bytes: 1_200_000_000, elapsed: 10000 },
  upload: { bandwidth: 73_400_000, bytes: 700_000_000, elapsed: 10000 },
  packetLoss: 0,
  isp: 'Free SAS',
  interface: { internalIp: '192.168.1.94', externalIp: '82.64.1.2' },
  server,
  result: { id: 'abc', url: 'https://www.speedtest.net/result/c/abc', persisted: true },
});
