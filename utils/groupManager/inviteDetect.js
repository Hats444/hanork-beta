'use strict';

/**
 * Extrai convites de grupo WhatsApp de texto livre.
 * Nao entra no grupo — so normaliza o codigo.
 */

const LINK_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:chat\.whatsapp\.com\/(?:invite\/)?|wa\.me\/g\/|whatsapp\.com\/(?:chat|invite)\/)([A-Za-z0-9_-]{8,64})/gi;

const BAD_CODES = new Set(['invite', 'add', 'join', 'chat', 'www']);
const SKIP_PROTO_KEYS = new Set([
  'jpegThumbnail', 'fileSha256', 'fileEncSha256', 'mediaKey', 'messageSecret',
  'mediaKeyTimestamp', 'fileLength', 'waveform', 'scansSidecar'
]);

function hasInviteHint(text) {
  return /chat\.whatsapp\.com|wa\.me\/g\/|whatsapp\.com\/(?:chat|invite)\//i.test(String(text || ''));
}

/** Junta quebra de linha so logo apos o dominio do convite. */
function flattenInviteText(s) {
  return String(s || '').replace(
    /(chat\.whatsapp\.com\/(?:invite\/)?|wa\.me\/g\/|whatsapp\.com\/(?:chat|invite)\/)\s+/gi,
    '$1'
  );
}

function normalizeInviteCode(raw) {
  const code = String(raw || '').trim().split(/[?#/]/)[0];
  if (!code || code.length < 8 || code.length > 64) return '';
  if (BAD_CODES.has(code.toLowerCase())) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(code)) return '';
  return code;
}

function collectProtoInviteCodes(message, out, seen, depth = 0) {
  if (!message || typeof message !== 'object' || depth > 6) return;
  const inv = message.groupInviteMessage;
  if (inv && inv.inviteCode) {
    const code = normalizeInviteCode(inv.inviteCode);
    if (code && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  const nested = [
    message.ephemeralMessage?.message,
    message.viewOnceMessage?.message,
    message.viewOnceMessageV2?.message,
    message.viewOnceMessageV2Extension?.message,
    message.documentWithCaptionMessage?.message,
    message.editedMessage?.message,
    message.extendedTextMessage?.contextInfo?.quotedMessage,
    message.imageMessage?.contextInfo?.quotedMessage,
    message.videoMessage?.contextInfo?.quotedMessage
  ];
  for (const n of nested) {
    if (n && typeof n === 'object') collectProtoInviteCodes(n, out, seen, depth + 1);
  }
}

function collectProtoStrings(obj, out, depth, seenObj) {
  if (!obj || depth > 8) return;
  if (typeof obj === 'string') {
    if (obj.length >= 12) out.push(obj);
    return;
  }
  if (typeof obj !== 'object') return;
  if (seenObj.has(obj)) return;
  seenObj.add(obj);
  if (Array.isArray(obj)) {
    for (const x of obj) collectProtoStrings(x, out, depth + 1, seenObj);
    return;
  }
  for (const k of Object.keys(obj)) {
    if (SKIP_PROTO_KEYS.has(k)) continue;
    collectProtoStrings(obj[k], out, depth + 1, seenObj);
  }
}

function pushCodesFromText(s, out, seen) {
  const flat = flattenInviteText(s);
  if (!flat || !hasInviteHint(flat)) return;
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(flat))) {
    const code = normalizeInviteCode(m[1]);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
}

function extractInviteCodes(text, message) {
  const out = [];
  const seen = new Set();
  pushCodesFromText(text, out, seen);
  collectProtoInviteCodes(message, out, seen, 0);
  if (message && typeof message === 'object') {
    const blobs = [];
    collectProtoStrings(message, blobs, 0, new WeakSet());
    for (const blob of blobs) pushCodesFromText(blob, out, seen);
  }
  return out;
}

function inviteUrl(code) {
  const c = normalizeInviteCode(code);
  return c ? `https://chat.whatsapp.com/${c}` : '';
}

function harvestMessageText(ctx, info) {
  const parts = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s) parts.push(s);
  };
  if (ctx) {
    push(ctx.fullText);
    push(ctx.text);
    push(ctx.caption);
    push(ctx.body);
    const q = ctx.quoted;
    const qm = q && (q.message || q);
    if (qm && typeof qm === 'object') {
      push(qm.conversation);
      push(qm.extendedTextMessage?.text);
      push(qm.imageMessage?.caption);
      push(qm.videoMessage?.caption);
      push(qm.documentMessage?.caption);
    }
  }
  const raw = info?.message;
  if (raw && typeof raw === 'object') {
    try {
      const { getMessageText } = require('../../utils');
      push(getMessageText(raw));
    } catch (_) { /* ignore */ }
  }
  return parts.join('\n');
}

module.exports = {
  normalizeInviteCode,
  extractInviteCodes,
  hasInviteHint,
  inviteUrl,
  flattenInviteText,
  harvestMessageText
};
