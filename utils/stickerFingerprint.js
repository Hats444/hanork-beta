'use strict';
/**
 * ID de figurinha = fileSha256 do proto (hex). Nao e filtro generico.
 * Rename/reencode muda os bytes; o SHA do Zap na msg original nao muda.
 */

const crypto = require('crypto');

const LRU_MAX = 900;
const lru = new Map(); // `${sessionId}:${stanzaId}` -> fingerprint

function toHex(v) {
  if (!v) return '';
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s.startsWith('<')) return '';
    if (/^[0-9a-fA-F]{32,}$/.test(s) && s.length % 2 === 0) return s.toLowerCase();
    try {
      const buf = Buffer.from(s, 'base64');
      if (buf.length >= 16) return buf.toString('hex');
    } catch (_) { /* ignore */ }
    return '';
  }
  return '';
}

function unwrapMsg(message) {
  let msg = message;
  if (!msg || typeof msg !== 'object') return msg;
  try {
    const { unwrapWaMessage } = require('../contextParser');
    msg = unwrapWaMessage(msg) || msg;
  } catch (_) { /* ignore */ }
  return msg;
}

function stickerNodeFromMessage(message) {
  const msg = unwrapMsg(message);
  if (!msg || typeof msg !== 'object') return null;
  return msg.stickerMessage
    || msg.lottieStickerMessage?.message?.stickerMessage
    || null;
}

function fromStickerNode(node) {
  if (!node || typeof node !== 'object') return null;
  const sha256 = toHex(node.fileSha256);
  const encSha256 = toHex(node.fileEncSha256);
  if (!sha256 && !encSha256) return null;
  return {
    sha256,
    encSha256,
    fileLength: Number(node.fileLength || 0) || 0,
    height: Number(node.height || 0) || 0,
    width: Number(node.width || 0) || 0,
    animated: !!node.isAnimated,
    mimetype: String(node.mimetype || 'image/webp')
  };
}

function fromMessage(infoOrMsg) {
  if (!infoOrMsg) return null;
  const message = infoOrMsg.message || infoOrMsg;
  return fromStickerNode(stickerNodeFromMessage(message));
}

function fromQuoted(info) {
  const msg = unwrapMsg(info?.message);
  const ctx =
    msg?.extendedTextMessage?.contextInfo
    || msg?.stickerMessage?.contextInfo
    || msg?.imageMessage?.contextInfo
    || msg?.videoMessage?.contextInfo
    || null;
  const quoted = ctx?.quotedMessage;
  if (!quoted) return null;
  return fromStickerNode(stickerNodeFromMessage(quoted));
}

function idsOf(fp) {
  if (!fp) return [];
  return [fp.sha256, fp.encSha256, fp.byteSha256].map((x) => String(x || '').toLowerCase()).filter((x) => x.length >= 32);
}

function fromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return null;
  return {
    sha256: '',
    encSha256: '',
    byteSha256: crypto.createHash('sha256').update(buf).digest('hex'),
    fileLength: buf.length,
    height: 0,
    width: 0,
    animated: false,
    mimetype: 'image/webp'
  };
}

function remember(sessionId, info) {
  const id = info?.key?.id;
  const sid = String(sessionId || '');
  if (!id || !sid) return null;
  const fp = fromMessage(info);
  if (!fp) return null;
  const key = `${sid}:${id}`;
  if (lru.has(key)) lru.delete(key);
  lru.set(key, {
    fp,
    participant: info.key.participant || info.key.participantAlt || info.key.participantPn || '',
    remoteJid: info.key.remoteJid || '',
    fromMe: !!info.key.fromMe
  });
  while (lru.size > LRU_MAX) {
    const first = lru.keys().next().value;
    lru.delete(first);
  }
  return fp;
}

function lookup(sessionId, stanzaId) {
  if (!stanzaId) return null;
  const hit = lru.get(`${sessionId}:${stanzaId}`);
  if (hit) return hit;
  try {
    const { getCache } = require('../cache');
    const cached = getCache(sessionId)?.get(String(stanzaId));
    if (!cached) return null;
    const fp = fromMessage(cached);
    if (!fp) return null;
    return {
      fp,
      participant: cached.key?.participant || cached.key?.participantAlt || '',
      remoteJid: cached.key?.remoteJid || '',
      fromMe: !!cached.key?.fromMe
    };
  } catch (_) {
    return null;
  }
}

function formatLines(fp) {
  if (!fp) return ['Sem ID de figurinha (fileSha256 ausente).'];
  const { labelValue } = require('./typography');
  const rows = [];
  if (fp.sha256) rows.push(labelValue('fileSha256', fp.sha256));
  if (fp.encSha256) rows.push(labelValue('fileEncSha256', fp.encSha256));
  if (fp.byteSha256) rows.push(labelValue('sha256 bytes', fp.byteSha256));
  rows.push(labelValue('Tamanho', String(fp.fileLength || '-')));
  if (fp.width || fp.height) rows.push(labelValue('Px', `${fp.width}x${fp.height}`));
  return rows;
}

module.exports = {
  toHex,
  fromStickerNode,
  fromMessage,
  fromQuoted,
  fromBuffer,
  idsOf,
  remember,
  lookup,
  formatLines,
  stickerNodeFromMessage
};
