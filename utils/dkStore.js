'use strict';
/**
 * Storage exclusivo do modulo DK. Nao usa tabelas nem arquivos da divulgacao.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { getUserDir, normalizeTenantUid } = require('./userManager');

const DEFAULT_QTD = 5;
const MAX_QTD = 12;
const BATCH = 5;
const MAX_STATUS = 8;

function ownerKey(uid) {
  return String(normalizeTenantUid(uid) || '').trim();
}

function dkDir(uid) {
  const owner = ownerKey(uid);
  if (!owner) return null;
  const dir = path.join(getUserDir(owner), 'dk');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function absFile(uid, fileName) {
  const dir = dkDir(uid);
  if (!dir || !fileName) return null;
  const base = path.basename(String(fileName));
  if (!base || base === '.' || base === '..') return null;
  return path.join(dir, base);
}

function ensureTable() {
  try {
    const { ensureDkTables } = require('./sqlStore');
    if (typeof ensureDkTables === 'function') ensureDkTables();
  } catch (e) {
    logger.logAviso(`[dkStore] tabela: ${e.message}`);
  }
}

function emptyCfg(owner) {
  return {
    owner_key: owner,
    pay_text: '',
    repeat_text: '',
    repeat_file: null,
    repeat_tipo: null,
    repeat_mime: null,
    qtd: DEFAULT_QTD
  };
}

async function load(uid) {
  ensureTable();
  const owner = ownerKey(uid);
  if (!owner) return emptyCfg('');
  try {
    const { getAsync } = require('./sqlStore');
    const row = await getAsync('SELECT * FROM dk_config WHERE owner_key = ?', [owner]);
    if (!row) return emptyCfg(owner);
    const cfg = {
      owner_key: owner,
      pay_text: String(row.pay_text || row.texto || ''),
      repeat_text: String(row.repeat_text || row.texto || ''),
      repeat_file: row.repeat_file || row.media_file || null,
      repeat_tipo: row.repeat_tipo || row.media_tipo || null,
      repeat_mime: row.repeat_mime || row.media_mime || null,
      qtd: Math.min(MAX_QTD, Math.max(1, Number(row.qtd) || DEFAULT_QTD))
    };
    try { await seedStatusFromRepeat(owner, cfg); } catch (e) {
      logger.logAviso(`[dkStore] seed status: ${e.message}`);
    }
    return cfg;
  } catch (e) {
    logger.logAviso(`[dkStore] load: ${e.message}`);
    return emptyCfg(owner);
  }
}

async function save(uid, patch) {
  ensureTable();
  const owner = ownerKey(uid);
  if (!owner) return null;
  const prev = await load(owner);
  const next = {
    pay_text: patch.pay_text != null ? String(patch.pay_text) : prev.pay_text,
    repeat_text: patch.repeat_text != null ? String(patch.repeat_text) : prev.repeat_text,
    repeat_file: Object.prototype.hasOwnProperty.call(patch, 'repeat_file') ? patch.repeat_file : prev.repeat_file,
    repeat_tipo: Object.prototype.hasOwnProperty.call(patch, 'repeat_tipo') ? patch.repeat_tipo : prev.repeat_tipo,
    repeat_mime: Object.prototype.hasOwnProperty.call(patch, 'repeat_mime') ? patch.repeat_mime : prev.repeat_mime,
    qtd: patch.qtd != null ? Math.min(MAX_QTD, Math.max(1, Number(patch.qtd) || DEFAULT_QTD)) : prev.qtd
  };
  const ts = new Date().toISOString();
  const { runAsync } = require('./sqlStore');
  await runAsync(
    `INSERT INTO dk_config (owner_key, pay_text, repeat_text, repeat_file, repeat_tipo, repeat_mime, qtd, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(owner_key) DO UPDATE SET
       pay_text=excluded.pay_text,
       repeat_text=excluded.repeat_text,
       repeat_file=excluded.repeat_file,
       repeat_tipo=excluded.repeat_tipo,
       repeat_mime=excluded.repeat_mime,
       qtd=excluded.qtd,
       updated_at=excluded.updated_at`,
    [owner, next.pay_text, next.repeat_text, next.repeat_file, next.repeat_tipo, next.repeat_mime, next.qtd, ts]
  );
  return { owner_key: owner, ...next };
}

function writeBuffer(uid, prefix, buffer) {
  const dir = dkDir(uid);
  if (!dir || !buffer || !buffer.length) return null;
  const name = `${prefix}-${Date.now()}.bin`;
  fs.writeFileSync(path.join(dir, name), buffer);
  return name;
}

function readBuffer(uid, fileName) {
  const abs = absFile(uid, fileName);
  if (!abs || !fs.existsSync(abs)) return null;
  try {
    const buf = fs.readFileSync(abs);
    return buf && buf.length ? buf : null;
  } catch (_) {
    return null;
  }
}

function unlinkNamed(uid, fileName) {
  const abs = absFile(uid, fileName);
  if (!abs) return;
  try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch (_) { /* */ }
}

function repeatPack(uid, cfg) {
  const buf = readBuffer(uid, cfg && cfg.repeat_file);
  if (!buf) return null;
  return {
    buffer: buf,
    tipo: cfg.repeat_tipo || 'image',
    mimetype: cfg.repeat_mime || 'image/jpeg'
  };
}

async function listStatus(uid) {
  ensureTable();
  const owner = ownerKey(uid);
  if (!owner) return [];
  try {
    const { allAsync } = require('./sqlStore');
    const rows = await allAsync(
      'SELECT id, file_name, tipo, mime FROM dk_status_media WHERE owner_key = ? ORDER BY id ASC',
      [owner]
    );
    return rows || [];
  } catch (e) {
    logger.logAviso(`[dkStore] listStatus: ${e.message}`);
    return [];
  }
}

async function addStatus(uid, captured) {
  const owner = ownerKey(uid);
  if (!owner || !captured?.buffer) return null;
  const current = await listStatus(owner);
  if (current.length >= MAX_STATUS) {
    const err = new Error('status_cap');
    err.code = 'status_cap';
    throw err;
  }
  const file = writeBuffer(owner, 'st', captured.buffer);
  if (!file) return null;
  const { runAsync } = require('./sqlStore');
  const ts = new Date().toISOString();
  await runAsync(
    'INSERT INTO dk_status_media (owner_key, file_name, tipo, mime, created_at) VALUES (?,?,?,?,?)',
    [owner, file, captured.tipo || 'image', captured.mimetype || 'image/jpeg', ts]
  );
  return file;
}

async function removeStatus(uid, index1) {
  const owner = ownerKey(uid);
  const rows = await listStatus(owner);
  const i = Number(index1) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= rows.length) return false;
  const row = rows[i];
  const { runAsync } = require('./sqlStore');
  await runAsync('DELETE FROM dk_status_media WHERE id = ? AND owner_key = ?', [row.id, owner]);
  unlinkNamed(owner, row.file_name);
  return true;
}

async function statusPacks(uid) {
  const rows = await listStatus(uid);
  const out = [];
  for (const row of rows) {
    const buf = readBuffer(uid, row.file_name);
    if (!buf) continue;
    out.push({
      buffer: buf,
      tipo: row.tipo || 'image',
      mimetype: row.mime || 'image/jpeg'
    });
  }
  return out;
}

function saveRepeatMedia(uid, captured) {
  const owner = ownerKey(uid);
  if (!owner || !captured?.buffer) return null;
  const file = writeBuffer(owner, 'rp', captured.buffer);
  return {
    repeat_file: file,
    repeat_tipo: captured.tipo || 'image',
    repeat_mime: captured.mimetype || 'image/jpeg'
  };
}

async function seedStatusFromRepeat(uid, cfg) {
  const rows = await listStatus(uid);
  if (rows.length || !cfg?.repeat_file) return;
  const buf = readBuffer(uid, cfg.repeat_file);
  if (!buf) return;
  const file = writeBuffer(uid, 'st', buf);
  if (!file) return;
  const { runAsync } = require('./sqlStore');
  await runAsync(
    'INSERT INTO dk_status_media (owner_key, file_name, tipo, mime, created_at) VALUES (?,?,?,?,?)',
    [ownerKey(uid), file, cfg.repeat_tipo || 'image', cfg.repeat_mime || 'image/jpeg', new Date().toISOString()]
  );
}

async function clearRepeatMedia(uid) {
  const cfg = await load(uid);
  if (cfg.repeat_file) unlinkNamed(uid, cfg.repeat_file);
  return save(uid, { repeat_file: null, repeat_tipo: null, repeat_mime: null });
}

module.exports = {
  DEFAULT_QTD,
  MAX_QTD,
  BATCH,
  MAX_STATUS,
  ownerKey,
  load,
  save,
  repeatPack,
  listStatus,
  addStatus,
  removeStatus,
  statusPacks,
  saveRepeatMedia,
  clearRepeatMedia
};
