// Chiffrement du jeton Freebox et cookies de session signés
import crypto from 'node:crypto';

/** Signature demandée par la Freebox à l'ouverture de session : HMAC-SHA1(app_token, challenge) en hexadécimal. */
export function hmacSha1Hex(key, message) {
  return crypto.createHmac('sha1', key).update(message).digest('hex');
}

export class Secrets {
  constructor(appSecret) {
    // Deux clés distinctes dérivées du même secret : une pour chiffrer, une pour signer
    this.encKey = crypto.createHash('sha256').update(`enc:${appSecret}`).digest();
    this.signKey = crypto.createHash('sha256').update(`sign:${appSecret}`).digest();
  }

  /** Chiffre un objet en AES-256-GCM. Résultat : iv.tag.données, en base64url. */
  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
  }

  /** Déchiffre ce que encrypt() a produit. Renvoie null si le secret a changé ou si la valeur est abîmée. */
  decrypt(text) {
    try {
      const [iv, tag, data] = String(text).split('.').map((p) => Buffer.from(p, 'base64url'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encKey, iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
    } catch {
      return null;
    }
  }

  /** Jeton de session signé : charge utile en base64url + HMAC-SHA256. */
  sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', this.signKey).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  /** Vérifie un jeton signé et renvoie sa charge utile, ou null. */
  verify(token) {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const expected = crypto.createHmac('sha256', this.signKey).update(body).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }
}
