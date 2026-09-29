// services/searchRanker.js
// Ranking / dedup de resultados de busca (T9)

function normalizeUrl(url) {
  try {
    const u = new URL(String(url || ''));
    u.hash = '';
    let path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}${u.search}`.toLowerCase();
  } catch {
    return String(url || '').replace(/\/$/, '').toLowerCase();
  }
}

function domainOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Dedup por URL normalizada, dominio+titulo similar; ordena por data (recente) e score simples.
 */
function rankAndDedup(results = [], query = '') {
  const seenUrl = new Set();
  const seenTitleDomain = new Set();
  const qTokens = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const scored = [];
  for (const r of results || []) {
    if (!r || !r.url) continue;
    const nurl = normalizeUrl(r.url);
    if (seenUrl.has(nurl)) continue;
    const dom = domainOf(r.url);
    const tk = `${dom}|${titleKey(r.title)}`;
    if (tk !== '|' && seenTitleDomain.has(tk)) continue;
    seenUrl.add(nurl);
    if (tk !== '|') seenTitleDomain.add(tk);

    let score = 0;
    const hay = `${r.title || ''} ${r.description || ''}`.toLowerCase();
    for (const t of qTokens) {
      if (hay.includes(t)) score += 2;
    }
    if (r.date) {
      const ts = Date.parse(r.date);
      if (!Number.isNaN(ts)) score += Math.min(5, Math.floor((Date.now() - ts) / -86400000) + 5);
    }
    if (r.source === 'google_news') score += 1;
    scored.push({ ...r, _score: score });
  }

  scored.sort((a, b) => (b._score || 0) - (a._score || 0));
  return scored.map(({ _score, ...rest }) => rest);
}

module.exports = {
  rankAndDedup,
  normalizeUrl,
  domainOf
};
