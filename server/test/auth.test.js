import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Accounts, hashPassword, passwordProblems, randomPassword, usernameError, verifyPassword } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { startHarness } from './harness.js';

const fast = { N: 1024, r: 8, p: 1, keyLen: 32 };

test('politique de mot de passe', () => {
  assert.deepEqual(passwordProblems('Motdepasse-2026!'), []);
  assert.ok(passwordProblems('Court-1!').includes('au moins 12 caractères'));
  assert.ok(passwordProblems('motdepasse-2026!').includes('une majuscule'));
  assert.ok(passwordProblems('MOTDEPASSE-2026!').includes('une minuscule'));
  assert.ok(passwordProblems('Motdepasse-deux!').includes('un chiffre'));
  assert.ok(passwordProblems('Motdepasse2026ab').includes('un caractère spécial'));
  assert.ok(passwordProblems('Julien-2026-xyz!', 'julien').includes('ne pas contenir l\'identifiant'));
  assert.deepEqual(passwordProblems(randomPassword()), []);
  assert.equal(usernameError('julien'), null);
  assert.ok(usernameError('a b'));
});

test('hachage scrypt', async () => {
  const hash = await hashPassword('Motdepasse-2026!', fast);
  assert.match(hash, /^scrypt\$1024\$8\$1\$/);
  assert.notEqual(hash, await hashPassword('Motdepasse-2026!', fast), 'sel aléatoire');
  assert.ok(await verifyPassword('Motdepasse-2026!', hash));
  assert.ok(!(await verifyPassword('Motdepasse-2027!', hash)));
  assert.ok(!(await verifyPassword('x', 'abîmé')));
});

test('blocage après 5 échecs et migration depuis ADMIN_PASSWORD', async () => {
  const store = openDatabase(':memory:');
  const accounts = new Accounts(store, { hashParams: fast });
  const quiet = { info() {} };
  const user = await accounts.bootstrap({ username: 'admin', password: 'Motdepasse-2026!' }, quiet);
  assert.equal(user.mustChange, false, 'mot de passe déjà conforme');
  assert.equal(await accounts.bootstrap({ username: 'autre', password: 'x' }, quiet), null, 'une seule fois');
  for (let i = 0; i < 4; i += 1) assert.equal((await accounts.authenticate('admin', 'faux')).retryAfter, 0);
  assert.equal((await accounts.authenticate('admin', 'faux')).retryAfter, 60);
  assert.equal((await accounts.authenticate('admin', 'Motdepasse-2026!')).error, 'locked');
  assert.equal((await accounts.authenticate('inconnu', 'x')).error, 'invalid');
  store.close();
});

test('premier compte depuis l\'interface, changement de mot de passe et sessions', async () => {
  const h = await startHarness();
  try {
    // Un compte existe déjà : plus de création possible
    assert.equal((await h.call('POST', '/api/auth/setup', { username: 'pirate', password: 'Motdepasse-2026!' })).status, 409);
    assert.equal((await h.call('GET', '/api/auth/me')).body.username, 'julien');

    const old = await h.call('GET', '/api/auth/me');
    assert.equal(old.status, 200);
    const r = await h.call('POST', '/api/auth/password', { currentPassword: 'Motdepasse-2026!', newPassword: 'Julien-2026-xyz!' });
    assert.equal(r.status, 400, 'contient l\'identifiant');
    assert.equal((await h.call('POST', '/api/auth/password', { currentPassword: 'Motdepasse-2026!', newPassword: 'Autre-Secret-42?' })).status, 200);
    // La session courante reste ouverte avec le nouveau cookie
    assert.equal((await h.call('GET', '/api/devices')).status, 200);
    await h.call('POST', '/api/auth/logout', {});
    assert.equal((await h.call('POST', '/api/auth/login', { username: 'julien', password: 'Motdepasse-2026!' })).status, 401);
    assert.equal((await h.call('POST', '/api/auth/login', { username: 'julien', password: 'Autre-Secret-42?' })).status, 200);

    // Base vide : le premier compte se crée depuis l'interface
    h.store.db.exec('DELETE FROM users');
    await h.call('POST', '/api/auth/logout', {});
    assert.equal((await h.call('GET', '/api/auth/me')).body.setupRequired, true);
    assert.equal((await h.call('POST', '/api/auth/setup', { username: 'julien', password: 'faible' })).status, 400);
    const setup = await h.call('POST', '/api/auth/setup', { username: 'julien', password: 'Motdepasse-2026!' });
    assert.equal(setup.status, 200);
    assert.equal(setup.body.authenticated, true);
    assert.equal((await h.call('GET', '/api/devices')).status, 200);
  } finally {
    h.close();
  }
});

test('un changement de mot de passe ferme les autres sessions', async () => {
  const h = await startHarness();
  try {
    const accounts = new Accounts(h.store, { hashParams: fast });
    await accounts.setPassword(accounts.find('julien').id, 'Ailleurs-2026-!!');
    assert.equal((await h.call('GET', '/api/devices')).status, 401);
  } finally {
    h.close();
  }
});
