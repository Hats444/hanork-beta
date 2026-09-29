'use strict';
/**
 * Aviso de WhatsApp caiu — texto + teclado. Sem JID/sessao no texto do cliente.
 */

const COOLDOWN_MS = 20 * 60 * 1000;
const lastSent = new Map();

function kindFromReason(reason) {
  const s = String(reason || '').toLowerCase();
  if (/403|forbidden/.test(s)) return 'forbidden';
  if (/logged out|log out/.test(s)) return 'logged_out';
  if (/conflict|replaced|440/.test(s)) return 'conflict';
  if (/\bqr\b|qr expirou|qr refs/.test(s)) return 'qr';
  if (/411|mismatch/.test(s)) return 'mismatch';
  if (/max reconnect|max_reconnect/.test(s)) return 'max_reconnect';
  if (/401|persistente|auth|connection failure/.test(s)) return 'auth';
  return 'generic';
}

const TEXTS = {
  forbidden:
    'O WhatsApp recusou o bot (deslogou ou bloqueou).\nToque em Conectar WhatsApp e pareie de novo (QR ou codigo).',
  logged_out:
    'O WhatsApp desconectou esta sessao.\nToque em Conectar WhatsApp e pareie de novo.',
  auth:
    'Sua sessao do WhatsApp caiu.\nToque em Conectar WhatsApp (QR ou codigo).',
  conflict:
    'Outro aparelho assumiu o WhatsApp.\nReconectar tenta o mesmo numero. Conectar WhatsApp pareia de novo.',
  qr:
    'O QR expirou.\nToque em Conectar WhatsApp e gere outro.',
  mismatch:
    'O WhatsApp pediu pra parear de novo.\nToque em Conectar WhatsApp.',
  max_reconnect:
    'Nao deu pra religar o WhatsApp sozinho.\nToque em Conectar WhatsApp.',
  generic:
    'Sua sessao do WhatsApp caiu.\nToque em Conectar WhatsApp (QR ou codigo).'
};

function connectRow() {
  return [{ text: 'Conectar WhatsApp', callback_data: 'connect' }];
}

function buildNotice({ kind, sessionId, extraRows } = {}) {
  const k = TEXTS[kind] ? kind : kindFromReason(kind);
  const text = TEXTS[k] || TEXTS.generic;
  const keyboard = [];
  if (k === 'conflict' && sessionId) {
    keyboard.push([{ text: 'Reconectar', callback_data: `reconnect_${sessionId}` }]);
  }
  keyboard.push(connectRow());
  for (const row of extraRows || []) {
    if (row && row.length) keyboard.push(row);
  }
  return { kind: k, text, keyboard };
}

function cooldownKey(uid, kind) {
  return `${String(uid || '').trim()}:${kind || 'generic'}`;
}

function allowNotice(uid, kind, now = Date.now()) {
  const key = cooldownKey(uid, kind);
  const prev = lastSent.get(key) || 0;
  if (prev && now - prev < COOLDOWN_MS) return false;
  lastSent.set(key, now);
  return true;
}

function clearNoticeCooldown(uid, kind) {
  lastSent.delete(cooldownKey(uid, kind));
}

module.exports = {
  COOLDOWN_MS,
  kindFromReason,
  buildNotice,
  allowNotice,
  clearNoticeCooldown,
  TEXTS
};
