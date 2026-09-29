// utils/phraseMatch.js
// Match de frases do Intent Router — regra unica em todo o bot
// - 1 palavra ambigua (menu/logs) so casa sozinha
// - Frases multi-palavra: so com fronteira de palavra (nunca "menu admin" ⊂ "menu admins")

/** Substantivos ambiguos: nunca casam como substring */
const EXACT_ONLY_WORDS = new Set([
  'menu',
  'ajuda',
  'help',
  'stats',
  'status',
  'logs',
  'config',
  'opcoes',
  'opções',
  'admin',
  'adm',
  'admins'
]);

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} textNorm - ja normalizado
 * @param {string} phrase
 * @returns {boolean}
 */
function phraseMatchesText(textNorm, phrase) {
  const p = normalizeText(phrase);
  const t = normalizeText(textNorm);
  if (!p || !t) return false;
  if (t === p) return true;

  const isSingleWord = !/\s/.test(p);
  if (isSingleWord) {
    const tokens = t.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && tokens[0] === p) return true;
    if (EXACT_ONLY_WORDS.has(p)) return false;
    // verbos/cmds: "play X", "nuke esse grupo"
    return t.startsWith(`${p} `);
  }

  // Multi-palavra: fronteira de token — evita "menu admin" casar "menu admins"
  const esc = escapeRegex(p).replace(/\\?\s+/g, '\\s+');
  const re = new RegExp(`(?:^|\\s)${esc}(?:\\s|$)`);
  return re.test(t);
}

/** Score de especificidade — frase mais longa vence */
function phraseSpecificity(textNorm, phrase) {
  const p = normalizeText(phrase);
  const t = normalizeText(textNorm);
  if (!phraseMatchesText(t, p)) return -1;
  return p.length + (t === p ? 50 : 0) + (p.includes(' ') ? 10 : 0);
}

/** Pedido de menu ("menu X", "abre o menu...") — nao e acao destrutiva */
function looksLikeMenuRequest(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (t === 'menu' || t === 'menu principal') return true;
  if (/^(abre|abrir|mostrar|mostra|manda|me mostra)\s+(o\s+)?menu(\s|$)/.test(t)) return true;
  if (/^menu\s+\S+/.test(t)) return true;
  return false;
}

module.exports = {
  EXACT_ONLY_WORDS,
  normalizeText,
  phraseMatchesText,
  phraseSpecificity,
  looksLikeMenuRequest
};
