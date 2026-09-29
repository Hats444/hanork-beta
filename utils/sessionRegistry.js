// utils/sessionRegistry.js
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { getUserDir, isAdmin, ensureUserDir } = require('./userManager');
const { v4: uuidv4 } = require('uuid');

// ===== LER MAX_SESSIONS DO .env (fallback para 20) =====
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 20;

const REGISTRY_FILE = path.join(__dirname, '../data/system/registry.json');

function loadRegistry() {
  try {
    const store = require('./sqlStore');
    if (store.isReady()) {
      const hit = store.getCachedKv('system', 'registry');
      if (hit && typeof hit === 'object' && Array.isArray(hit.sessions)) return hit;
    }
  } catch (_) { /* fallback */ }

  try {
    if (!fs.existsSync(REGISTRY_FILE)) return { sessions: [] };
    const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    try { require('./sqlStore').upsertKv('system', 'registry', reg); } catch (_) { /* */ }
    return reg;
  } catch {
    return { sessions: [] };
  }
}

function saveRegistry(registry) {
  const payload = registry && typeof registry === 'object' ? registry : { sessions: [] };
  try {
    require('./sqlStore').upsertKv('system', 'registry', payload);
  } catch (_) { /* */ }

  const dir = path.dirname(REGISTRY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempFile = REGISTRY_FILE + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2));
    fs.renameSync(tempFile, REGISTRY_FILE);
  } catch (e) {
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch (_) { /* */ }
    }
    // SQL ja salvou — nao derruba o bot se so o backup JSON falhar
    logger.logAviso(`[sessionRegistry] backup JSON: ${e.message}`);
  }
}

function canCreateSession() {
  const registry = loadRegistry();
  return registry.sessions.length < MAX_SESSIONS;
}

function assertCanRegisterSession(metadata = {}) {
  if (metadata.method === 'legacy') return;
  try {
    const reason = require('./memoryWatch').pairBlockReason();
    if (reason) {
      const err = new Error(reason);
      err.code = 'SESSION_RAM';
      throw err;
    }
  } catch (e) {
    if (e && e.code === 'SESSION_RAM') throw e;
  }
  if (!canCreateSession()) {
    const err = new Error(`Limite maximo de ${MAX_SESSIONS} sessoes atingido.`);
    err.code = 'SESSION_LIMIT';
    throw err;
  }
}

function getSession(sessionId) {
  const registry = loadRegistry();
  return registry.sessions.find(s => s.sessionId === sessionId) || null;
}

function getUserSessions(telegramUserId) {
  const registry = loadRegistry();
  return registry.sessions.filter(s => s.telegramUserId === String(telegramUserId));
}

function getAllSessions() {
  return loadRegistry().sessions;
}

function registerSession(telegramUserId, sessionId, metadata = {}) {
  assertCanRegisterSession(metadata);
  const registry = loadRegistry();
  if (registry.sessions.some(s => s.sessionId === sessionId)) {
    throw new Error(`Sessão ${sessionId} já existe.`);
  }
  // Regra: cada usuario do Telegram pode ter no maximo 1 sessao WhatsApp.
  // Isso evita que um usuario acumule multiplas sessoes e ocupe vagas que
  // poderiam ser usadas por outros usuarios do limite global.
  const existing = registry.sessions.filter(s => s.telegramUserId === String(telegramUserId));
  if (existing.length >= 1) {
    const err = new Error('Voce ja possui uma sessao. Apague-a antes de criar uma nova.');
    err.code = 'SESSION_LIMIT_PER_USER';
    throw err;
  }
  registry.sessions.push({
    sessionId,
    telegramUserId: String(telegramUserId),
    status: 'connecting',
    createdAt: Date.now(),
    connectionMethod: metadata.connectionMethod || 'telegram',
    phoneNumber: metadata.phoneNumber || undefined,
    buttonMode: metadata.buttonMode !== undefined ? metadata.buttonMode : true, // Default: ON
    forwardMode: metadata.forwardMode === true, // true = OFF (encaminhada de canal)
    ...metadata,
  });
  saveRegistry(registry);
  const sessionDir = getSessionDir(sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  return sessionId;
}

function updateSessionStatus(sessionId, status, extra = {}) {
  const registry = loadRegistry();
  const session = registry.sessions.find(s => s.sessionId === sessionId);
  if (!session) {
    // Nao throw: reconnect/cleanup de sessao ja apagada gerava UNHANDLED_REJECTION
    return false;
  }
  session.status = status;
  Object.assign(session, extra);
  saveRegistry(registry);
  return true;
}

function getSessionButtonMode(sessionId) {
  const session = getSession(sessionId);
  if (!session) return true; // Default: ON
  return session.buttonMode !== undefined ? session.buttonMode : true;
}

function toggleSessionButtonMode(sessionId) {
  const registry = loadRegistry();
  const session = registry.sessions.find(s => s.sessionId === sessionId);
  if (!session) throw new Error(`Sessão ${sessionId} não encontrada.`);
  session.buttonMode = !session.buttonMode;
  session.buttonModeUpdatedAt = Date.now();
  // Botoes OFF <=> encaminhada de canal (forwardMode)
  session.forwardMode = session.buttonMode === false;
  session.forwardModeUpdatedAt = Date.now();
  saveRegistry(registry);
  try {
    const { setForwardMode } = require('./channelForward');
    setForwardMode(sessionId, session.buttonMode === false);
  } catch (_) { /* ignore circular during boot */ }
  return session.buttonMode;
}

function setSessionButtonMode(sessionId, enabled) {
  const registry = loadRegistry();
  const session = registry.sessions.find(s => s.sessionId === sessionId);
  if (!session) throw new Error(`Sessão ${sessionId} não encontrada.`);
  session.buttonMode = !!enabled;
  session.buttonModeUpdatedAt = Date.now();
  session.forwardMode = session.buttonMode === false;
  session.forwardModeUpdatedAt = Date.now();
  saveRegistry(registry);
  try {
    const { setForwardMode } = require('./channelForward');
    setForwardMode(sessionId, session.buttonMode === false);
  } catch (_) { /* ignore */ }
  return session.buttonMode;
}

/**
 * Fonte unica do ON/OFF de botoes.
 * Com telegramUserId: config.buttonsEnabled manda (TG/WA sync).
 * Sem user: cai no buttonMode da sessao.
 * Toggle sempre via syncButtonsMode — nao mexer so numa das flags.
 */
function areButtonsOn(sessionId, telegramUserId = null) {
  if (telegramUserId != null && telegramUserId !== '') {
    try {
      const { getButtonsEnabled } = require('./configManager');
      return getButtonsEnabled(telegramUserId) !== false;
    } catch (_) { /* ignore */ }
  }
  if (sessionId) return getSessionButtonMode(sessionId) !== false;
  return true;
}

/**
 * Liga/desliga botoes em TODAS as sessoes do user + config.
 * @returns {boolean} novo estado
 */
function syncButtonsMode(telegramUserId, enabled, preferSessionId = null) {
  const on = !!enabled;
  try {
    const { setButtonsEnabled } = require('./configManager');
    setButtonsEnabled(telegramUserId, on);
  } catch (_) { /* ignore */ }

  const sessions = getUserSessions(telegramUserId) || [];
  const seen = new Set();
  for (const s of sessions) {
    if (!s?.sessionId || seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);
    try {
      setSessionButtonMode(s.sessionId, on);
    } catch (_) { /* ignore */ }
  }
  if (preferSessionId && !seen.has(preferSessionId)) {
    try {
      setSessionButtonMode(preferSessionId, on);
    } catch (_) { /* ignore */ }
  }
  return on;
}

function toggleButtonsSynced(telegramUserId, sessionId) {
  const current = areButtonsOn(sessionId, telegramUserId);
  return syncButtonsMode(telegramUserId, !current, sessionId);
}

function deleteSession(sessionId, force = false) {
  const registry = loadRegistry();
  const idx = registry.sessions.findIndex(s => s.sessionId === sessionId);
  if (idx === -1) throw new Error(`Sessão ${sessionId} não encontrada.`);
  const session = registry.sessions[idx];
  const sessionDir = getSessionDir(sessionId);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  registry.sessions.splice(idx, 1);
  saveRegistry(registry);
  return session;
}

function getSessionDir(sessionId) {
  const registry = loadRegistry();
  const session = registry.sessions.find(s => s.sessionId === sessionId);
  if (!session) throw new Error(`Sessão ${sessionId} não registrada.`);
  const userDir = getUserDir(session.telegramUserId);
  return path.join(userDir, 'sessions', sessionId);
}

function canAccessSession(telegramUserId, sessionId) {
  const session = getSession(sessionId);
  if (!session) return false;
  if (isAdmin(telegramUserId)) return true;
  return session.telegramUserId === String(telegramUserId);
}

module.exports = {
  loadRegistry,
  saveRegistry,
  canCreateSession,
  assertCanRegisterSession,
  getSession,
  getUserSessions,
  getAllSessions,
  registerSession,
  updateSessionStatus,
  getSessionButtonMode,
  toggleSessionButtonMode,
  setSessionButtonMode,
  areButtonsOn,
  syncButtonsMode,
  toggleButtonsSynced,
  deleteSession,
  getSessionDir,
  canAccessSession,
  MAX_SESSIONS,
};