import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { dnsServersError } from '../src/freebox/rules.js';
import { startHarness } from './harness.js';

test('règles : serveurs DNS', () => {
  assert.equal(dnsServersError(['1.1.1.1', ' 1.0.0.1 ', '']), null);
  assert.match(dnsServersError([]), /au moins un/);
  assert.match(dnsServersError(['1.1.1.1', 'a.b.c.d']), /invalide : a\.b\.c\.d/);
  assert.match(dnsServersError(['1.1.1.1', '1.1.1.1']), /deux fois/);
  assert.match(dnsServersError(['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4', '1.1.1.5', '1.1.1.6']), /au plus 5/);
});

let h;
before(async () => { h = await startHarness(); });
after(() => h.close());

test('DNS : lecture, modification et test', async () => {
  let r = await h.call('GET', '/api/dns');
  assert.deepEqual(r.body.servers, ['192.168.1.254']);
  assert.equal(r.body.gateway, '192.168.1.254');
  assert.ok(r.body.presets.some((p) => p.id === 'quad9'));

  r = await h.call('PUT', '/api/dns', { servers: ['9.9.9.9', 'x'] });
  assert.equal(r.status, 400);

  r = await h.call('PUT', '/api/dns', { servers: ['192.168.1.2', '9.9.9.9'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.servers, ['192.168.1.2', '9.9.9.9']);
  assert.deepEqual(h.box.state.dhcpConfig.dns, ['192.168.1.2', '9.9.9.9', '', '', '']);

  r = await h.call('POST', '/api/dns/test', { servers: ['192.168.1.2', '9.9.9.9'] });
  assert.deepEqual(r.body.results.map((x) => x.ok), [false, true]);
  assert.equal((await h.call('POST', '/api/dns/test', { servers: ['nope'] })).status, 400);
});
