// utils/banManager.js
// Sistema de banimento — SQL primario, JSON backup
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const BANNED_FILE = path.join(__dirname, '../banned.json');

function loadBanned() {
  try {
    const store = require('./sqlStore');
    if (store.isReady()) {
      const hit = store.getCachedKv('bans', 'global');
      if (Array.isArray(hit)) return hit.map(String);
    }
  } catch (_) { /* fallback */ }

  try {
    if (fs.existsSync(BANNED_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(BANNED_FILE, 'utf-8'));
      const list = Array.isArray(parsed) ? parsed.map(String) : [];
      try { require('./sqlStore').upsertKv('bans', 'global', list); } catch (_) { /* */ }
      return list;
    }
  } catch (e) {
    logger.logErro('BAN_MANAGER', `Erro ao carregar banidos: ${e.message}`);
  }
  return [];
}

function saveBanned(bannedList) {
  const list = Array.isArray(bannedList) ? bannedList.map(String) : [];
  try {
    require('./sqlStore').upsertKv('bans', 'global', list);
  } catch (_) { /* */ }
  try {
    fs.writeFileSync(BANNED_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) {
    logger.logErro('BAN_MANAGER', `backup JSON falhou: ${e.message}`);
  }
  return true;
}

function isBanned(userId) {
  return loadBanned().includes(String(userId));
}

function banUser(userId) {
  const bannedList = loadBanned();
  const userIdStr = String(userId);
  if (bannedList.includes(userIdStr)) return false;
  bannedList.push(userIdStr);
  const saved = saveBanned(bannedList);
  if (saved) logger.logInfo(`Usuario ${userIdStr} banido.`);
  return saved;
}

function unbanUser(userId) {
  const bannedList = loadBanned();
  const userIdStr = String(userId);
  const index = bannedList.indexOf(userIdStr);
  if (index === -1) return false;
  bannedList.splice(index, 1);
  const saved = saveBanned(bannedList);
  if (saved) logger.logInfo(`Usuario ${userIdStr} desbanido.`);
  return saved;
}

function listBanned() {
  return loadBanned();
}

function clearBanned() {
  return saveBanned([]);
}

module.exports = {
  isBanned,
  banUser,
  unbanUser,
  listBanned,
  clearBanned
};
