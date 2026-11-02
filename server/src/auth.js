// Comptes de l'interface : identifiant + mot de passe haché (scrypt), politique de mot de passe,
// limitation des essais et création du premier compte
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt N=2^15, r=8, p=1 : ~32 Mo de mémoire et ~100 ms par calcul, recommandation OWASP
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLen: 64 };
const maxmem = (params) => 128 * params.N * params.r * 2;

export const PASSWORD_POLICY = { minLength: 12, maxLength: 128 };
export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;

/** Liste des règles non respectées (vide si le mot de passe convient). */
export function passwordProblems(password, username = '') {
  const pw = String(password ?? '');
  const problems = [];
  if ([...pw].length < PASSWORD_POLICY.minLength) problems.push(`au moins ${PASSWORD_POLICY.minLength} caractères`);
  if ([...pw].length > PASSWORD_POLICY.maxLength) problems.push(`au plus ${PASSWORD_POLICY.maxLength} caractères`);
  if (!/\p{Ll}/u.test(pw)) problems.push('une minuscule');
  if (!/\p{Lu}/u.test(pw)) problems.push('une majuscule');
  if (!/\p{Nd}/u.test(pw)) problems.push('un chiffre');
  if (!/[^\p{L}\p{Nd}\s]/u.test(pw)) problems.push('un caractère spécial');
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) problems.push('ne pas contenir l\'identifiant');
  return problems;
}

export function passwordError(password, username) {
  const problems = passwordProblems(password, username);
  return problems.length ? `Mot de passe trop faible : il faut ${problems.join(', ')}` : null;
}

export function usernameError(username) {
  return USERNAME_PATTERN.test(String(username ?? ''))
    ? null
    : 'Identifiant : 3 à 32 caractères parmi lettres, chiffres, point, tiret et souligné';
}

/** Hache un mot de passe : scrypt$N$r$p$sel$empreinte (base64url). */
export async function hashPassword(password, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password).normalize('NFC'), salt, params.keyLen, { N: params.N, r: params.r, p: params.p, maxmem: maxmem(params) });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const [algo, N, r, p, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  const expected = Buffer.from(hash, 'base64url');
  try {
    const given = await scrypt(String(password ?? '').normalize('NFC'), Buffer.from(salt, 'base64url'), expected.length, { ...params, maxmem: maxmem(params) });
    return crypto.timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

/** Mot de passe aléatoire conforme à la politique (réinitialisation en ligne de commande). */
export function randomPassword() {
  for (;;) {
    const pw = `${crypto.randomBytes(12).toString('base64url')}-7aA`;
    if (!passwordProblems(pw).length) return pw;
  }
}

/** Limite les essais ratés par adresse IP : au-delà de 10 par quart d'heure, l'adresse est refusée. */
export function ipLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();
  const recent = (ip) => (failures.get(ip) || []).filter((x) => Date.now() - x < windowMs);
  return {
    blocked: (ip) => recent(ip).length >= max,
    fail(ip) {
      if (failures.size > 10000) failures.clear();
      failures.set(ip, [...recent(ip), Date.now()]);
    },
  };
}

// Après 5 échecs de suite sur un compte : blocage 1 min, puis 2, 4... jusqu'à 15 min
const FREE_FAILURES = 5;
const lockSeconds = (failures) => Math.min(15 * 60, 60 * 2 ** Math.max(0, failures - FREE_FAILURES));

const now = () => Math.floor(Date.now() / 1000);

export class Accounts {
  constructor(store, { hashParams = SCRYPT } = {}) {
    this.db = store.db;
    this.hashParams = hashParams;
    this.dummyHash = null;
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  get(id) {
    return userRow(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  find(username) {
    return userRow(this.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '')));
  }

  async create(username, password, { mustChange = false } = {}) {
    const ts = now();
    const hash = await hashPassword(password, this.hashParams);
    const info = this.db.prepare(`INSERT INTO users (username, password_hash, must_change, created_at, password_changed_at)
      VALUES (?, ?, ?, ?, ?)`).run(username, hash, mustChange ? 1 : 0, ts, ts);
    return this.get(Number(info.lastInsertRowid));
  }

  /**
   * Vérifie identifiant et mot de passe. Renvoie { user } ou { error, retryAfter }.
   * Un identifiant inconnu coûte le même calcul qu'un vrai, pour ne pas révéler quels comptes existent.
   */
  async authenticate(username, password) {
    const user = this.find(username);
    if (!user) {
      this.dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'), this.hashParams);
      await verifyPassword(password, this.dummyHash);
      return { error: 'invalid' };
    }
    const ts = now();
    if (user.lockedUntil > ts) return { error: 'locked', retryAfter: user.lockedUntil - ts };
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(password, row.password_hash))) {
      const failures = user.failedAttempts + 1;
      const lockedUntil = failures >= FREE_FAILURES ? ts + lockSeconds(failures) : 0;
      this.db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(failures, lockedUntil, user.id);
      return { error: 'invalid', retryAfter: lockedUntil ? lockedUntil - ts : 0 };
    }
    this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0, last_login_at = ? WHERE id = ?').run(ts, user.id);
    return { user: this.get(user.id) };
  }

  /** Nouveau mot de passe : les sessions ouvertes ailleurs sont fermées (session_version + 1). */
  async setPassword(id, password, { mustChange = false } = {}) {
    const hash = await hashPassword(password, this.hashParams);
    this.db.prepare(`UPDATE users SET password_hash = ?, must_change = ?, session_version = session_version + 1,
      failed_attempts = 0, locked_until = 0, password_changed_at = ? WHERE id = ?`).run(hash, mustChange ? 1 : 0, now(), id);
    return this.get(id);
  }

  /** Nouvel identifiant. Renvoie le compte, ou null si l'identifiant est déjà pris. */
  rename(id, username) {
    const other = this.find(username);
    if (other && other.id !== id) return null;
    this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
    return this.get(id);
  }

  /**
   * Migration depuis l'ancien ADMIN_PASSWORD : s'il n'existe encore aucun compte, en crée un avec ce mot de passe.
   * Si le mot de passe ne respecte pas la politique, il faudra le changer à la première connexion.
   */
  async bootstrap({ username = 'admin', password = '' } = {}, log = console) {
    if (this.count() > 0 || !password) return null;
    const weak = passwordProblems(password, username).length > 0;
    const user = await this.create(username, password, { mustChange: weak });
    log.info?.(`Compte « ${username} » créé avec le mot de passe ADMIN_PASSWORD`
      + (weak ? ' (trop faible : à changer à la première connexion)' : ''));
    return user;
  }
}

function userRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    mustChange: r.must_change === 1,
    sessionVersion: r.session_version,
    failedAttempts: r.failed_attempts,
    lockedUntil: r.locked_until,
    createdAt: r.created_at,
    passwordChangedAt: r.password_changed_at,
    lastLoginAt: r.last_login_at,
  };
}
