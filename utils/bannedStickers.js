'use strict';
/**
 * Lista de figurinhas bloqueadas no ENVIO (match exacto de hash).
 * Nenhuma figurinha fora da lista e afetada.
 * Persistencia: kv_store scope=stickerban:{telegramUserId}
 */

const logger = require('../logger');
const { idsOf, fromMessage, fromStickerNode, fromBuffer, stickerNodeFromMessage } = require('./stickerFingerprint');

function scope(telegramUserId) {
  return `stickerban:${String(telegramUserId || 'na')}`;
}

function loadState(telegramUserId) {
  try {
    const { getCachedKv } = require('./sqlStore');
    const raw = getCachedKv(scope(telegramUserId), 'state');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { banned: {}, triggers: {} };
    return {
      banned: raw.banned && typeof raw.banned === 'object' ? raw.banned : {},
      triggers: raw.triggers && typeof raw.triggers === 'object' ? raw.triggers : {}
    };
  } catch (_) {
    return { banned: {}, triggers: {} };
  }
}

function saveState(telegramUserId, state) {
  try {
    const { upsertKv } = require('./sqlStore');
    upsertKv(scope(telegramUserId), 'state', {
      banned: state.banned || {},
      triggers: state.triggers || {},
      ts: Date.now()
    });
  } catch (e) {
    logger.logAviso(`[stickerban] save: ${e.message}`);
  }
}

function addFingerprint(telegramUserId, fp, kind = 'banned') {
  const ids = idsOf(fp);
  if (!ids.length) return { ok: false, reason: 'sem_id' };
  const state = loadState(telegramUserId);
  const bucket = kind === 'trigger' ? state.triggers : state.banned;
  const rec = {
    sha256: fp.sha256 || '',
    encSha256: fp.encSha256 || '',
    byteSha256: fp.byteSha256 || '',
    fileLength: fp.fileLength || 0,
    at: new Date().toISOString()
  };
  for (const id of ids) bucket[id] = rec;
  if (kind === 'trigger') {
    for (const id of ids) state.banned[id] = rec;
  }
  saveState(telegramUserId, state);
  return { ok: true, ids, count: Object.keys(bucket).length };
}

function removeFingerprint(telegramUserId, fpOrHex) {
  const ids = typeof fpOrHex === 'string'
    ? [String(fpOrHex).toLowerCase()].filter(Boolean)
    : idsOf(fpOrHex);
  if (!ids.length) return { ok: false, removed: 0 };
  const state = loadState(telegramUserId);
  let n = 0;
  for (const id of ids) {
    if (state.banned[id]) { delete state.banned[id]; n += 1; }
    if (state.triggers[id]) { delete state.triggers[id]; n += 1; }
  }
  saveState(telegramUserId, state);
  return { ok: true, removed: n };
}

function matches(map, fp) {
  if (!map || !fp) return false;
  return idsOf(fp).some((id) => !!map[id]);
}

function isBanned(telegramUserId, fp) {
  if (!fp) return false;
  return matches(loadState(telegramUserId).banned, fp);
}

function isTrigger(telegramUserId, fp) {
  if (!fp) return false;
  return matches(loadState(telegramUserId).triggers, fp);
}

function listBanned(telegramUserId) {
  const state = loadState(telegramUserId);
  const seen = new Set();
  const out = [];
  for (const [id, rec] of Object.entries(state.banned || {})) {
    const key = rec.sha256 || rec.encSha256 || id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: key, trigger: !!(state.triggers[id] || state.triggers[key]), ...rec });
  }
  return out;
}

function fingerprintFromSendContent(content, options) {
  if (!content || typeof content !== 'object') return null;
  if (Buffer.isBuffer(content.sticker)) return fromBuffer(content.sticker);
  if (content.stickerMessage) return fromStickerNode(content.stickerMessage);
  const node = stickerNodeFromMessage(content);
  if (node) return fromStickerNode(node);
  const quoted = options?.quoted;
  if (quoted) {
    const q = fromMessage(quoted);
    if (q) return q;
  }
  return fromMessage({ message: content });
}

function assertSendableSticker(telegramUserId, content, options) {
  const fp = fingerprintFromSendContent(content, options);
  if (!fp) return;
  if (!isBanned(telegramUserId, fp)) return;
  const err = new Error('Figurinha na lista de bloqueio. Nao reenvio.');
  err.code = 'BANNED_STICKER';
  throw err;
}

module.exports = {
  addFingerprint,
  removeFingerprint,
  isBanned,
  isTrigger,
  listBanned,
  fingerprintFromSendContent,
  assertSendableSticker,
  loadState
};
