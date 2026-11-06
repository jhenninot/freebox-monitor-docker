// Versions de firmware annoncées par Free sur son blog (flux RSS de dev.freebox.fr, catégorie « Mise à jour »).
// L'API de la box ne dit pas qu'une version est sortie : on compare la version installée aux billets publiés.
// Le format des titres n'est pas documenté : la lecture reste volontairement tolérante.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text = '') {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    // Le HTML des billets arrive échappé (&lt;p&gt;) ou en CDATA : on garde les retours à la ligne
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*(\n\s*)+/g, '\n\n')
    .replace(/ *\n */g, '\n')
    .trim();
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decode(m[1]) : '';
};

/** Billets du flux : [{ title, link, ts, categories, summary, content }] (summary et content en texte brut). */
export function parseRss(xml = '') {
  const items = [];
  for (const m of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const body = m[1];
    const date = Date.parse(tag(body, 'pubDate'));
    items.push({
      title: tag(body, 'title'),
      link: tag(body, 'link') || null,
      ts: Number.isFinite(date) ? Math.floor(date / 1000) : null,
      categories: [...body.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((c) => decode(c[1])),
      summary: tag(body, 'description').replace(/\s*\[(…|&hellip;|\.\.\.)\]\s*$/, '…'),
      content: tag(body, 'content:encoded') || null,
    });
  }
  return items;
}

/** Quel équipement concerne un billet : 'repeater', 'server' ou null (Player, appli…). */
export function releaseTarget(item) {
  const text = `${item.title} ${item.categories.join(' ')}`;
  if (/r[ée]p[ée]teur|repeater/i.test(text)) return 'repeater';
  if (/player|t[ée]l[ée]commande|\bapp(li)?\b|android|ios|tv\b/i.test(item.title)) return null;
  if (/server|serveur|freebox\s*(os|ultra|delta|pop|r[ée]volution|mini|one)/i.test(text)) return 'server';
  return null;
}

/** Première version de la forme 4.9.2 (au moins deux nombres) dans le titre. */
export function versionOf(title = '') {
  return /\b(\d+(?:\.\d+){1,3})\b/.exec(title)?.[1] ?? null;
}

/** Compare deux versions « 4.9.10 » / « 4.9.2 » : négatif, nul ou positif. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const MODELS = { ultra: /ultra/i, delta: /delta/i, pop: /\bpop\b/i, revolution: /r[ée]volution|\bv6\b/i, mini: /mini/i, one: /\bone\b/i };
const modelsIn = (text = '') => Object.keys(MODELS).filter((m) => MODELS[m].test(text));

/**
 * Dernière version annoncée plus récente que celle installée, pour un type d'équipement.
 * Box : chaque modèle a sa branche (Révolution en 4.7, Ultra en 4.9…). Un billet compte s'il nomme le modèle installé,
 * ou, s'il ne nomme aucun modèle, s'il reste sur la même branche (mêmes deux premiers nombres).
 * Répéteurs : même premier nombre.
 */
export function newerRelease(items, target, installed, model = '') {
  const latest = latestFor(items, target, installed, model);
  return latest && compareVersions(latest.version, installed) > 0 ? latest : null;
}

/** Dernière version annoncée sur la branche de l'équipement installé (même si c'est celle installée). */
export function latestFor(items, target, installed, model = '') {
  if (!installed) return null;
  const branch = (v, n) => String(v).split('.').slice(0, n).join('.');
  const mine = modelsIn(model);
  const matches = (i) => {
    if (target !== 'server') return branch(i.version, 1) === branch(installed, 1);
    const named = modelsIn(i.title);
    if (named.length) return !mine.length || named.some((m) => mine.includes(m));
    return branch(i.version, 2) === branch(installed, 2);
  };
  const candidates = items
    .filter((i) => releaseTarget(i) === target)
    .map((i) => ({ ...i, version: versionOf(i.title) }))
    .filter((i) => i.version && matches(i))
    .sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0] ?? null;
}
