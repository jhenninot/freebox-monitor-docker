import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { startHarness } from './harness.js';

let h;
before(async () => { h = await startHarness(); });
after(() => h.close());

const finished = async () => {
  for (;;) {
    const [state] = await once(h.speedtest, 'progress');
    if (!state.running) return state;
  }
};

test('test de débit : progression, résultat enregistré, un seul à la fois', async () => {
  let r = await h.call('GET', '/api/speedtest');
  assert.equal(r.status, 200);
  assert.equal(r.body.running, false);
  assert.deepEqual(r.body.history, []);

  const phases = new Set();
  const onProgress = (s) => phases.add(s.phase);
  h.speedtest.on('progress', onProgress);
  const done = finished();
  r = await h.call('POST', '/api/speedtest', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.running, true);
  assert.equal(r.body.by, 'julien');
  assert.ok(r.body.busy, 'trafic de la box lu avant le test');

  const second = await h.call('POST', '/api/speedtest', {});
  assert.equal(second.status, 409);
  assert.match(second.body.error, /déjà en cours/);

  const state = await done;
  h.speedtest.off('progress', onProgress);
  assert.equal(state.phase, 'done');
  assert.ok(phases.has('download') && phases.has('upload'));
  assert.equal(state.result.down, 921);
  assert.equal(state.result.up, 587.2);
  assert.equal(state.result.ping, 4.2);
  assert.deepEqual(state.result.server, { name: 'Free SAS', location: 'Paris', country: 'France' });
  assert.equal(state.result.url, 'https://www.speedtest.net/result/c/abc');

  r = await h.call('GET', '/api/speedtest');
  assert.equal(r.body.history.length, 1);
  assert.equal(r.body.history[0].by, 'julien');
  assert.equal(r.body.history[0].down, 921);
});

test('test de débit : erreur du client rapportée', async () => {
  process.env.FAKE_SPEEDTEST = 'fail';
  try {
    const done = finished();
    await h.call('POST', '/api/speedtest', {});
    const state = await done;
    assert.equal(state.phase, 'error');
    assert.match(state.error, /Timeout/);
    assert.equal((await h.call('GET', '/api/speedtest')).body.history.length, 1, 'rien enregistré');
  } finally {
    delete process.env.FAKE_SPEEDTEST;
  }
});

test('test de débit : client absent', async () => {
  const bin = h.speedtest.bin;
  h.speedtest.bin = '/inexistant/speedtest';
  try {
    const done = finished();
    await h.call('POST', '/api/speedtest', {});
    const state = await done;
    assert.match(state.error, /introuvable/);
  } finally {
    h.speedtest.bin = bin;
  }
});

