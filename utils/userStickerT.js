'use strict';
/**
 * T pessoal: pack/autor que cada user grava e aplica no .t / t (roubar fisico).
 * Chave = identidade WA do remetente (PN+LID), nao o dono da sessao.
 */

const { upsertKv, getCachedKv } = require('./sqlStore');

const PACK_MAX = 80;

function scope(telegramUserId) {
  return `stickert:${String(telegramUserId || 'na')}`;
}

function canon(j) {
  return String(j || '').split(':')[0].trim();
}

function identityKeys(ctx) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const c = canon(v);
    if (!c || seen.has(c)) return;
    seen.add(c);
    out.push(c);
  };
  try {
    const { resolveCanonicalIdentity } = require('./authorization');
    for (const id of resolveCanonicalIdentity(ctx.sender || ctx.from, ctx) || []) push(id);
  } catch (_) { /* ignore */ }
  push(ctx.sender);
  push(ctx.senderAlt);
  push(ctx.info?.key?.participant);
  push(ctx.info?.key?.participantAlt);
  push(ctx.info?.key?.participantPn);
  push(ctx.info?.key?.remoteJidAlt);
  return out;
}

function loadMap(telegramUserId) {
  const raw = getCachedKv(scope(telegramUserId), 'map');
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function saveMap(telegramUserId, map) {
  upsertKv(scope(telegramUserId), 'map', map);
}

function parsePackAuthor(raw, fallbackName) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const i = s.indexOf('/');
  let pack;
  let author;
  if (i >= 0) {
    pack = s.slice(0, i).trim();
    author = s.slice(i + 1).trim();
  } else {
    pack = s;
    author = String(fallbackName || s).trim();
  }
  pack = pack.slice(0, PACK_MAX) || 'Hanork';
  author = (author || pack).slice(0, PACK_MAX) || pack;
  return { pack, author };
}

function getT(ctx) {
  const tid = ctx.telegramUserId || ctx.conn?._telegramUserId;
  const map = loadMap(tid);
  for (const k of identityKeys(ctx)) {
    if (map[k] && map[k].pack) return { pack: map[k].pack, author: map[k].author || map[k].pack };
  }
  return null;
}

function setT(ctx, pack, author) {
  const tid = ctx.telegramUserId || ctx.conn?._telegramUserId;
  const rec = {
    pack: String(pack || '').slice(0, PACK_MAX),
    author: String(author || pack || '').slice(0, PACK_MAX),
    ts: Date.now()
  };
  if (!rec.pack) return null;
  const map = loadMap(tid);
  for (const k of identityKeys(ctx)) map[k] = rec;
  saveMap(tid, map);
  return rec;
}

function formatT(rec) {
  if (!rec) return '';
  return `${rec.pack}/${rec.author}`;
}

function packMetaFromT(ctx, fallback) {
  const fb = (fallback && fallback.packname)
    ? fallback
    : { packname: 'by: @hanorkbeta', author: 'dono: @hanork' };
  try {
    const rec = getT(ctx || {});
    if (rec && rec.pack) return { packname: rec.pack, author: rec.author || rec.pack };
  } catch (_) { /* sem T */ }
  return fb;
}

module.exports = {
  PACK_MAX,
  parsePackAuthor,
  getT,
  setT,
  formatT,
  packMetaFromT,
  identityKeys
};
