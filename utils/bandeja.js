'use strict';
/**
 * Bandeja de status de grupo (groupStatusMessageV2).
 * Espelho do proto real (dissecar): image/video/texto +
 * contextInfo.isGroupStatus + statusSourceType TEXT + pairedMediaType NOT_PAIRED_MEDIA.
 * Store proprio (nao mistura com divulgacaoJob).
 */
const fs = require('fs');
const path = require('path');
const { getUserDir } = require('./userManager');
const { captureMediaFromCtx } = require('./divulgacao');
const { sendGroupStatusV2, directedCap } = require('./groupStatusV2');

const SCOPE = 'bandeja';
const MEDIA_FILE = 'bandeja.bin';
const DIRECTED_CAP = directedCap();

function uidOf(conn, ctx) {
  return String(ctx?.telegramUserId || conn?._telegramUserId || conn?._sessionId || 'default');
}

function storeDir(uid) {
  const dir = path.join(getUserDir(uid), 'config');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function jsonPath(uid) {
  return path.join(storeDir(uid), 'bandeja.json');
}

function mediaPath(uid) {
  return path.join(storeDir(uid), MEDIA_FILE);
}

function emptyTpl() {
  return {
    texto: '',
    midiaTipo: null,
    midiaMimetype: null,
    updatedAt: null
  };
}

function readDisk(uid) {
  try {
    const p = jsonPath(uid);
    if (!fs.existsSync(p)) return emptyTpl();
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ...emptyTpl(), ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch (_) {
    return emptyTpl();
  }
}

function writeDisk(uid, tpl) {
  const next = { ...emptyTpl(), ...tpl, updatedAt: new Date().toISOString() };
  fs.writeFileSync(jsonPath(uid), JSON.stringify(next));
  try {
    const store = require('./sqlStore');
    if (store.isReady()) store.upsertKv(SCOPE, String(uid), { ...next, midiaFile: MEDIA_FILE });
  } catch (_) { /* SQL opcional */ }
  return next;
}

function getTemplate(uid) {
  try {
    const store = require('./sqlStore');
    if (store.isReady()) {
      const hit = store.getCachedKv(SCOPE, String(uid));
      if (hit && typeof hit === 'object') {
        const disk = readDisk(uid);
        return { ...emptyTpl(), ...disk, ...hit };
      }
    }
  } catch (_) { /* cache miss */ }
  return readDisk(uid);
}

function setTexto(uid, texto) {
  const cur = getTemplate(uid);
  return writeDisk(uid, { ...cur, texto: String(texto || '').trim() });
}

function setMidia(uid, buffer, meta) {
  if (!buffer || !buffer.length) return null;
  fs.writeFileSync(mediaPath(uid), buffer);
  const cur = getTemplate(uid);
  return writeDisk(uid, {
    ...cur,
    midiaTipo: (meta && meta.tipo) || 'image',
    midiaMimetype: (meta && meta.mimetype) || 'image/jpeg'
  });
}

function clearTemplate(uid) {
  try {
    const abs = mediaPath(uid);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) { /* */ }
  return writeDisk(uid, emptyTpl());
}

function getMidiaBuffer(uid, tpl) {
  const t = tpl || getTemplate(uid);
  if (!t.midiaTipo) return null;
  try {
    const abs = mediaPath(uid);
    if (!fs.existsSync(abs)) return null;
    const buf = fs.readFileSync(abs);
    if (!buf || !buf.length) return null;
    return { buffer: buf, tipo: t.midiaTipo, mimetype: t.midiaMimetype };
  } catch (_) {
    return null;
  }
}

function isReady(uid) {
  const t = getTemplate(uid);
  return !!(String(t.texto || '').trim() || getMidiaBuffer(uid, t));
}

function formatSummary(uid) {
  const t = getTemplate(uid);
  const pack = getMidiaBuffer(uid, t);
  const texto = String(t.texto || '').trim();
  const midia = pack ? pack.tipo : 'nenhuma';
  const preview = texto ? (texto.length > 180 ? texto.slice(0, 177) + '...' : texto) : '(vazio)';
  return `BANDEJA (status de grupo V2)\n\nTexto:\n${preview}\n\nMidia: ${midia}\nPronto: ${isReady(uid) ? 'sim' : 'nao'}`;
}

function bandejaPayload(uid) {
  const tpl = getTemplate(uid);
  const pack = getMidiaBuffer(uid, tpl);
  return {
    texto: String(tpl.texto || '').trim(),
    buffer: pack?.buffer,
    tipo: pack?.tipo,
    mimetype: pack?.mimetype
  };
}

async function sendBandejaTodos(conn, groupJid, uid) {
  return sendGroupStatusV2(conn, groupJid, { ...bandejaPayload(uid), mode: 'todos' });
}

async function sendBandejaMembros(conn, groupJid, uid) {
  return sendGroupStatusV2(conn, groupJid, { ...bandejaPayload(uid), mode: 'membros' });
}

async function sendBandejaCanal(conn, canalJid, uid) {
  const { sendChannelStatus } = require('./groupStatusV2');
  return sendChannelStatus(conn, canalJid, bandejaPayload(uid));
}

async function captureBandejaMedia(ctx, kind) {
  return captureMediaFromCtx(ctx, kind);
}

module.exports = {
  uidOf,
  getTemplate,
  setTexto,
  setMidia,
  clearTemplate,
  getMidiaBuffer,
  isReady,
  formatSummary,
  sendBandejaTodos,
  sendBandejaMembros,
  sendBandejaCanal,
  captureBandejaMedia,
  DIRECTED_CAP
};
