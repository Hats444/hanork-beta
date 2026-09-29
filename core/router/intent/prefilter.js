// core/router/intent/prefilter.js
// Pre-filtro 100% local — short-list de candidatos antes do Ollama

const { buildCatalog, tokenize } = require('./catalog');
const { normalizeText, phraseMatchesText } = require('../../../utils/phraseMatch');

const MIN_SCORE = 0.12;

/**
 * @param {string} text
 * @param {{ topN?: number, platform?: string }} opts
 * @returns {Array<object>}
 */
function prefilterCandidates(text, opts = {}) {
  const topN = Math.max(1, Math.min(20, opts.topN || 10));
  const platform = opts.platform || null;
  const tokens = tokenize(text);
  if (!tokens.length) return [];

  const tokenSet = new Set(tokens);
  const textNorm = normalizeText(text);

  const scored = [];
  for (const entry of buildCatalog()) {
    if (platform && entry.platforms && !entry.platforms.includes(platform)) continue;

    let score = 0;
    let hits = 0;

    for (const kw of entry.keywords) {
      if (tokenSet.has(kw)) {
        hits++;
        score += kw === entry.command ? 0.45 : 0.18;
      }
    }

    // Mesma regra de phraseMatch em todo o bot
    for (const phrase of entry.phrases || []) {
      if (!phraseMatchesText(textNorm, phrase)) continue;
      const words = String(phrase).trim().split(/\s+/).length;
      score += 0.55 + Math.min(0.55, words * 0.22);
      hits += 2;
    }

    // overlap relativo
    if (entry.keywords.length) {
      score += (hits / Math.min(entry.keywords.length, 12)) * 0.2;
    }

    if (score < MIN_SCORE) continue;
    scored.push({ ...entry, score: Math.round(score * 1000) / 1000 });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

module.exports = {
  prefilterCandidates,
  MIN_SCORE
};
