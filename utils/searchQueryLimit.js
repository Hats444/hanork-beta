'use strict';
/**
 * Teto de caracteres em termo de busca (nome de musica, google, ytsearch, etc.).
 * Link http(s) usa teto maior. Nao vale pra texto de grupo/DIV/nuke.
 */

const SEARCH_MAX = Math.max(20, parseInt(process.env.HANORK_SEARCH_QUERY_MAX || '100', 10) || 100);
const URL_MAX = Math.max(80, parseInt(process.env.HANORK_SEARCH_URL_MAX || '500', 10) || 500);

function looksLikeUrl(text) {
  const t = String(text || '').trim();
  if (/^https?:\/\//i.test(t)) return true;
  return /(?:youtube\.com|youtu\.be|open\.spotify\.com|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|soundcloud\.com|pin\.it|pinterest\.|mediafire\.com|threads\.net|capcut\.com|twitter\.com|x\.com|kwai\.com)\//i.test(t);
}

function searchQueryMax(text) {
  return looksLikeUrl(text) ? URL_MAX : SEARCH_MAX;
}

class SearchQueryTooLongError extends Error {
  constructor(max, got) {
    super(`Nome grande demais (${got} caracteres). Maximo ${max}.`);
    this.name = 'SearchQueryTooLongError';
    this.code = 'SEARCH_QUERY_TOO_LONG';
    this.max = max;
    this.got = got;
  }
}

function enforceSearchQuery(text) {
  const q = String(text || '').replace(/\s+/g, ' ').trim();
  if (!q) return '';
  const max = searchQueryMax(q);
  if (q.length > max) throw new SearchQueryTooLongError(max, q.length);
  return q;
}

const SEARCH_PARAM_RE = /^(query|q|texto|text|search|nome|prompt|termo|url|link)$/i;

function shouldCapParam(name) {
  return SEARCH_PARAM_RE.test(String(name || ''));
}

/** WhatsApp: le o termo, recusa vazio/grande demais e responde na hora. */
async function readSearchQuery(conn, ctx, emptyUso) {
  const { resolveCtxFreeText } = require('./commandTextParse');
  const raw = resolveCtxFreeText(ctx);
  if (!raw) {
    if (emptyUso) {
      await conn.sendMessage(ctx.from, { text: emptyUso }, { quoted: ctx.info });
    }
    return null;
  }
  try {
    return enforceSearchQuery(raw);
  } catch (e) {
    await conn.sendMessage(ctx.from, { text: e.message }, { quoted: ctx.info });
    return null;
  }
}

module.exports = {
  SEARCH_MAX,
  URL_MAX,
  looksLikeUrl,
  searchQueryMax,
  SearchQueryTooLongError,
  enforceSearchQuery,
  shouldCapParam,
  readSearchQuery
};
