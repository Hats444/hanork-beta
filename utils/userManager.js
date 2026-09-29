// utils/userManager.js
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const DATA_ROOT = path.join(__dirname, '../data/users');
const ADMIN_IDS = process.env.TELEGRAM_ADMIN_IDS
  ? process.env.TELEGRAM_ADMIN_IDS.split(',').map(id => id.trim())
  : ['123456789']; // ← substitua pelo seu ID real

/** Recusa undefined/null/"" — sessoes sem uid nao compartilham data/users/undefined. */
function normalizeTenantUid(telegramUserId) {
  if (telegramUserId == null) return null;
  const uid = String(telegramUserId).trim();
  if (!uid || uid === 'undefined' || uid === 'null') return null;
  return uid;
}

function getUserDir(telegramUserId) {
  const uid = normalizeTenantUid(telegramUserId);
  if (!uid) {
    logger.logAviso('[userManager] uid invalido — recusando pasta compartilhada (undefined/null)');
    return path.join(DATA_ROOT, '_rejected');
  }
  const dir = path.join(DATA_ROOT, uid);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getUserMetadata(telegramUserId) {
  const uid = normalizeTenantUid(telegramUserId);
  if (!uid) return { role: 'user', telegramUserId: '', isAdmin: false };
  let meta = { role: 'user' };
  try {
    const store = require('./sqlStore');
    if (store.isReady()) {
      const hit = store.getCachedKv('user_meta', uid);
      if (hit && typeof hit === 'object') meta = { ...hit };
    }
  } catch (_) { /* fallback */ }

  if (!meta || meta.role == null) {
    const dir = getUserDir(telegramUserId);
    const metaPath = path.join(dir, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        try { require('./sqlStore').upsertKv('user_meta', uid, meta); } catch (_) { /* */ }
      } catch {}
    }
  }
  meta.telegramUserId = uid;
  meta.isAdmin = ADMIN_IDS.includes(uid);
  if (meta.isAdmin) meta.role = 'admin';
  return meta;
}

function saveUserMetadata(telegramUserId, meta) {
  const uid = normalizeTenantUid(telegramUserId);
  if (!uid) return;
  try {
    require('./sqlStore').upsertKv('user_meta', uid, meta || {});
  } catch (_) { /* */ }
  try {
    const dir = getUserDir(telegramUserId);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));
  } catch (_) { /* */ }
}

function isAdmin(telegramUserId) {
  return ADMIN_IDS.includes(String(telegramUserId));
}

function ensureUserDir(telegramUserId) {
  const dir = getUserDir(telegramUserId);
  const subDirs = ['config', 'sessions', 'backups', 'cache', 'stats'];
  for (const sub of subDirs) {
    const p = path.join(dir, sub);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
  return dir;
}

module.exports = {
  getUserDir,
  getUserMetadata,
  saveUserMetadata,
  isAdmin,
  ensureUserDir,
  normalizeTenantUid,
  ADMIN_IDS,
  DATA_ROOT,
};