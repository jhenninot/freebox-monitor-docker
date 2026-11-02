// Règles du mot de passe, affichées pendant la saisie (le serveur refait la vérification, voir server/src/auth.js)
export const MIN_LENGTH = 12;

export function passwordRules(password, username = '') {
  const pw = password || '';
  const rules = [
    { label: `${MIN_LENGTH} caractères minimum`, ok: [...pw].length >= MIN_LENGTH },
    { label: 'une minuscule', ok: /\p{Ll}/u.test(pw) },
    { label: 'une majuscule', ok: /\p{Lu}/u.test(pw) },
    { label: 'un chiffre', ok: /\p{Nd}/u.test(pw) },
    { label: 'un caractère spécial', ok: /[^\p{L}\p{Nd}\s]/u.test(pw) },
  ];
  if (username) rules.push({ label: 'sans l\'identifiant', ok: pw.length > 0 && !pw.toLowerCase().includes(username.toLowerCase()) });
  return rules;
}
