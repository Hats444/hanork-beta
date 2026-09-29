// utils/configManager.js
const fs = require('fs');
const path = require('path');
const { getUserDir, normalizeTenantUid } = require('./userManager');

// ===== CAMINHOS =====
function getConfigDir(telegramUserId) {
  const userDir = getUserDir(telegramUserId);
  const configDir = path.join(userDir, 'config');
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  return configDir;
}

function getConfigPath(telegramUserId) {
  return path.join(getConfigDir(telegramUserId), 'config.json');
}

// ===== CARREGAR / SALVAR =====
function carregarConfig(telegramUserId) {
  const uid = normalizeTenantUid(telegramUserId);
  if (!uid) return { prefix: '.', owners: [], vips: [], blacklist: [] };
  // SQL-first (cache esquecido no migrate/upsert)
  try {
    const store = require('./sqlStore');
    if (store.isReady()) {
      const hit = store.getCachedKv('config', uid);
      if (hit && typeof hit === 'object') return hit;
    }
  } catch (_) { /* fallback JSON */ }

  const configPath = getConfigPath(telegramUserId);
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      try { require('./sqlStore').upsertKv('config', uid, cfg); } catch (_) { /* */ }
      return cfg;
    }
  } catch (e) {
    console.error('[configManager] Erro ao carregar config:', e.message);
  }
  return { prefix: '.', owners: [], vips: [], blacklist: [] };
}

const DEFAULT_INTENT_ROUTER = {
  enabled: true,
  minConfidence: 0.85,
  minConfidenceSensitive: 0.93,
  /** Limiar so pra dica "quase acertou" (abaixo de executar) */
  tipMinConfidence: 0.45,
  /** Intent NL: user < vip — default vip (dono/vip/platform_admin) */
  minLevel: 'vip',
  prefilterTopN: 10,
  allowUrls: true,
  allowIdentifiers: true,
  allowSearch: false,
  allowNlu: true,
  allowInSentence: false,
  explicitCommandsFirst: true,
  safetyGate: true // applyIntentSafety sempre apos NLU
};

/** Motor de evolucao de usuarios (XP / niveis / A/B / quotas) */
const DEFAULT_EVOLUTION = {
  enabled: true,
  tipsEnabled: true,
  quotasEnabled: true,
  /** reorderMenu: futuro — boost soft no catalogo (off por padrao) */
  reorderMenu: false
};

const ROLE_RANK = { none: 0, user: 1, vip: 2, owner: 3, platform_admin: 4 };

/** role >= minLevel? (user < vip < owner < platform_admin). opts.isGroupAdmin: VIP usa cmds adm neste grupo. */
function roleMeetsMinLevel(role, minLevel = 'vip', opts = {}) {
  try {
    const { canUseCommand, normalizeRole } = require('./permissionEngine');
    const actor = role === 'group_admin' ? 'adm' : normalizeRole(role);
    const isGroupAdmin = !!(opts.isGroupAdmin || role === 'group_admin' || role === 'adm');
    return canUseCommand(actor, minLevel, { isGroupAdmin });
  } catch (_) {
    const have = ROLE_RANK[String(role || 'none')] ?? 0;
    const need = ROLE_RANK[String(minLevel || 'vip')] ?? ROLE_RANK.vip;
    return have >= need;
  }
}

function getIntentConfig(telegramUserId) {
  const config = getConfig(telegramUserId) || {};
  return { ...DEFAULT_INTENT_ROUTER, ...(config.intentRouter || {}) };
}

function setIntentRouterEnabled(telegramUserId, enabled) {
  const config = getConfig(telegramUserId) || {};
  config.intentRouter = { ...DEFAULT_INTENT_ROUTER, ...(config.intentRouter || {}), enabled: !!enabled };
  salvarConfig(telegramUserId, config);
  return config.intentRouter;
}

function updateIntentRouter(telegramUserId, patch = {}) {
  const config = getConfig(telegramUserId) || {};
  config.intentRouter = { ...DEFAULT_INTENT_ROUTER, ...(config.intentRouter || {}), ...patch };
  salvarConfig(telegramUserId, config);
  return config.intentRouter;
}

function getEvolutionConfig(telegramUserId) {
  const config = getConfig(telegramUserId) || {};
  return { ...DEFAULT_EVOLUTION, ...(config.evolution || {}) };
}

function updateEvolution(telegramUserId, patch = {}) {
  const config = getConfig(telegramUserId) || {};
  config.evolution = { ...DEFAULT_EVOLUTION, ...(config.evolution || {}), ...patch };
  salvarConfig(telegramUserId, config);
  return config.evolution;
}

function setEvolutionEnabled(telegramUserId, enabled) {
  return updateEvolution(telegramUserId, { enabled: !!enabled });
}

function salvarConfig(telegramUserId, config) {
  const uid = normalizeTenantUid(telegramUserId);
  if (!uid) return;
  let sqlOk = false;
  try {
    const store = require('./sqlStore');
    store.upsertKv('config', uid, config || {});
    sqlOk = !!store.isReady();
  } catch (_) { /* sql opcional */ }
  if (sqlOk) return;
  try {
    const configPath = getConfigPath(telegramUserId);
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[configManager] backup JSON falhou:', e.message);
  }
}

/** Leitura: JSON primario; se sumir, tenta restaurar do espelho SQL (async caller) */
async function restoreConfigFromSql(telegramUserId) {
  try {
    const raw = await require('./sqlStore').getKv('config', String(telegramUserId));
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object') {
      const configPath = getConfigPath(telegramUserId);
      fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2));
      return parsed;
    }
  } catch (_) { /* ignore */ }
  return null;
}

function getConfig(telegramUserId) {
  return carregarConfig(telegramUserId);
}

function updateConfig(telegramUserId, updates) {
  const config = carregarConfig(telegramUserId);
  Object.assign(config, updates);
  salvarConfig(telegramUserId, config);
  return config;
}

function isPersistedOwnerIdentity(jid) {
  let s = '';
  if (jid == null) s = '';
  else if (typeof jid === 'string') s = jid;
  else if (typeof jid === 'object') s = String(jid.id || jid.jid || jid._serialized || '');
  else s = String(jid);
  s = s.trim().replace(/:\d+(?=@)/, '');
  if (!s) return false;
  if (s.endsWith('@g.us') || s.endsWith('@newsletter') || s.endsWith('@broadcast') || s === 'status@broadcast') {
    return false;
  }
  if (s.endsWith('@lid') || s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us')) return true;
  // Digitos crus: telefone (11-15). ID do Telegram (~10) nao vira dono do Zap.
  return /^\d{11,15}$/.test(s);
}

function canonicalOwnerJid(jid) {
  let id = '';
  if (jid == null) id = '';
  else if (typeof jid === 'string') id = jid.trim();
  else if (typeof jid === 'object') id = String(jid.id || jid.jid || jid._serialized || '').trim();
  else id = String(jid).trim();
  if (!id) return '';
  if (/^\d{11,15}$/.test(id)) id = `${id}@s.whatsapp.net`;
  id = id.replace(/:\d+(?=@)/, '');
  if (!isPersistedOwnerIdentity(id)) return '';
  return id;
}

function sameOwnerIdentity(a, b) {
  try {
    return require('./authorization').matchesAuthorizedEntry(a, b);
  } catch (_) {
    return canonicalOwnerJid(a) === canonicalOwnerJid(b);
  }
}

/** 1 pessoa = 1 entrada. Prefere telefone; LID so se nao houver PN. */
function compactIdentityList(list) {
  const phones = [];
  const lids = [];
  for (const raw of list || []) {
    const id = canonicalOwnerJid(raw);
    if (!id) continue;
    if (id.includes('@lid')) lids.push(id);
    else phones.push(id);
  }
  const kept = [];
  for (const id of phones) {
    if (kept.some((k) => sameOwnerIdentity(k, id))) continue;
    kept.push(id);
  }
  for (const id of lids) {
    if (kept.some((k) => sameOwnerIdentity(k, id))) continue;
    kept.push(id);
  }
  return kept;
}

function formatOwnerLabel(jid) {
  const id = canonicalOwnerJid(jid);
  if (!id) return '';
  if (id.includes('@lid')) {
    try {
      const { getPhoneForLid } = require('../utils');
      const phone = getPhoneForLid(id);
      if (phone) return formatOwnerLabel(phone);
    } catch (_) { /* ignore */ }
    const part = id.split('@')[0];
    return `lid …${part.slice(-6)}`;
  }
  const d = id.split('@')[0].replace(/\D/g, '');
  return d ? `+${d}` : id;
}

function listOwnersForDisplay(telegramUserId) {
  return getOwners(telegramUserId).map(formatOwnerLabel).filter(Boolean);
}

function persistIdentityList(telegramUserId, field, next) {
  const config = getConfig(telegramUserId);
  const prev = Array.isArray(config[field]) ? config[field] : [];
  if (JSON.stringify(prev) === JSON.stringify(next)) return false;
  config[field] = next;
  salvarConfig(telegramUserId, config);
  try { require('./authorization').clearAuthCache(telegramUserId); } catch (_) { /* ignore */ }
  return true;
}

// ===== OWNERS =====
function getOwners(telegramUserId) {
  const raw = getConfig(telegramUserId).owners || [];
  return compactIdentityList(raw.filter(isPersistedOwnerIdentity));
}

/**
 * Dono efetivo = lista desta sessao + donos das contas TELEGRAM_ADMIN.
 * Dois chips (dois TG ids) reconhecem o mesmo numero no PV.
 */
function getEffectiveOwners(telegramUserId) {
  const seen = [];
  const push = (jid) => {
    const id = canonicalOwnerJid(jid);
    if (!id) return;
    if (seen.some((k) => sameOwnerIdentity(k, id))) return;
    seen.push(id);
  };
  for (const o of getOwners(telegramUserId) || []) push(o);
  try {
    const { ADMIN_IDS, isAdmin } = require('./userManager');
    // So une chips TELEGRAM_ADMIN entre si. Sessao de cliente nao herda WA do admin.
    if (!isAdmin(String(telegramUserId || ''))) {
      return compactIdentityList(seen);
    }
    for (const aid of ADMIN_IDS || []) {
      const id = String(aid || '').trim();
      if (!id || id === '123456789') continue;
      for (const o of getOwners(id) || []) push(o);
    }
    const { getAllSessions } = require('./sessionRegistry');
    for (const s of getAllSessions() || []) {
      const uid = String(s.telegramUserId || '');
      if (!uid || !isAdmin(uid)) continue;
      for (const o of getOwners(uid) || []) push(o);
    }
  } catch (_) { /* ignore */ }
  return compactIdentityList(seen);
}

/** Texto do menu Configuracoes (TG). Nunca chama .endsWith em JID objeto. */
function formatOwnersCaption(telegramUserId, { max = 8, sep = '\n' } = {}) {
  const labels = listOwnersForDisplay(telegramUserId);
  if (!labels.length) return 'Nenhum dono cadastrado (so o chip desta sessao).';
  const shown = labels.slice(0, Math.max(1, Number(max) || 8));
  const extra = labels.length > shown.length ? `${sep}... +${labels.length - shown.length}` : '';
  return shown.join(sep) + extra;
}

function addOwner(telegramUserId, jid) {
  const id = canonicalOwnerJid(jid);
  if (!id) return false;
  const config = getConfig(telegramUserId);
  const cur = Array.isArray(config.owners) ? config.owners : [];
  if (compactIdentityList(cur).some((o) => sameOwnerIdentity(o, id))) {
    persistIdentityList(telegramUserId, 'owners', compactIdentityList(cur));
    return false;
  }
  persistIdentityList(telegramUserId, 'owners', compactIdentityList([...cur, id]));
  return true;
}

/**
 * So atualiza cache LID↔PN. Nao grava dono — isso e so addowner/removeowner.
 */
function ensureOwnerAliases(telegramUserId, identities = []) {
  const list = Array.isArray(identities) ? identities : [identities];
  try {
    const { rememberLidPhonePair } = require('../utils');
    const lids = [];
    const pns = [];
    for (const raw of list) {
      const id = canonicalOwnerJid(raw);
      if (!id) continue;
      if (id.includes('@lid')) lids.push(id);
      else pns.push(id);
    }
    if (lids.length === 1 && pns.length === 1) {
      rememberLidPhonePair(lids[0], pns[0]);
    }
  } catch (_) { /* cache opcional */ }
  return false;
}

function removeOwner(telegramUserId, jid) {
  const id = canonicalOwnerJid(jid) || String(jid || '').trim();
  if (!id) return false;
  const config = getConfig(telegramUserId);
  const cur = Array.isArray(config.owners) ? config.owners : [];
  const next = cur.filter((o) => !sameOwnerIdentity(o, id) && canonicalOwnerJid(o) !== id);
  if (next.length === cur.length) {
    const compacted = compactIdentityList(cur);
    if (JSON.stringify(compacted) !== JSON.stringify(cur)) {
      persistIdentityList(telegramUserId, 'owners', compacted);
    }
    return false;
  }
  if (!next.length && cur.length) {
    return false;
  }
  persistIdentityList(telegramUserId, 'owners', compactIdentityList(next));
  return true;
}

function compactOwners(telegramUserId) {
  const config = getConfig(telegramUserId);
  const owners = compactIdentityList(config.owners || []);
  const vips = compactIdentityList(config.vips || []);
  const oChanged = persistIdentityList(telegramUserId, 'owners', owners);
  const vChanged = persistIdentityList(telegramUserId, 'vips', vips);
  return { owners: owners.length, vips: vips.length, changed: oChanged || vChanged };
}

function compactAllUserOwners() {
  const seen = new Set();
  const uids = [];
  try {
    const { ADMIN_IDS, DATA_ROOT } = require('./userManager');
    for (const id of ADMIN_IDS || []) {
      const s = String(id || '').trim();
      if (s) uids.push(s);
    }
    if (fs.existsSync(DATA_ROOT)) {
      for (const name of fs.readdirSync(DATA_ROOT)) {
        if (/^\d+$/.test(name)) uids.push(name);
      }
    }
  } catch (_) { /* ignore */ }
  try {
    const { getAllSessions } = require('./sessionRegistry');
    for (const s of getAllSessions() || []) {
      const uid = String(s.telegramUserId || '');
      if (uid) uids.push(uid);
    }
  } catch (_) { /* ignore */ }
  let n = 0;
  for (const uid of uids) {
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    try {
      if (compactOwners(uid).changed) n++;
    } catch (_) { /* ignore */ }
  }
  return n;
}

// ===== VIPS =====
function getVips(telegramUserId) {
  const raw = getConfig(telegramUserId).vips || [];
  return compactIdentityList(raw);
}

function addVip(telegramUserId, jid) {
  const id = canonicalOwnerJid(jid);
  if (!id) return false;
  const config = getConfig(telegramUserId);
  const cur = Array.isArray(config.vips) ? config.vips : [];
  if (compactIdentityList(cur).some((o) => sameOwnerIdentity(o, id))) {
    persistIdentityList(telegramUserId, 'vips', compactIdentityList(cur));
    return false;
  }
  persistIdentityList(telegramUserId, 'vips', compactIdentityList([...cur, id]));
  return true;
}

function removeVip(telegramUserId, jid) {
  const id = canonicalOwnerJid(jid) || String(jid || '').trim();
  if (!id) return false;
  const config = getConfig(telegramUserId);
  const cur = Array.isArray(config.vips) ? config.vips : [];
  const next = cur.filter((o) => !sameOwnerIdentity(o, id) && canonicalOwnerJid(o) !== id);
  if (next.length === cur.length) return false;
  persistIdentityList(telegramUserId, 'vips', compactIdentityList(next));
  return true;
}

// ===== BLACKLIST =====
function getBlacklist(telegramUserId) {
  return getConfig(telegramUserId).blacklist || [];
}

function addBlacklist(telegramUserId, jid) {
  const config = getConfig(telegramUserId);
  if (!config.blacklist) config.blacklist = [];
  if (!config.blacklist.includes(jid)) {
    config.blacklist.push(jid);
    salvarConfig(telegramUserId, config);
    return true;
  }
  return false;
}

function removeBlacklist(telegramUserId, jid) {
  const config = getConfig(telegramUserId);
  if (!config.blacklist) config.blacklist = [];
  const index = config.blacklist.indexOf(jid);
  if (index !== -1) {
    config.blacklist.splice(index, 1);
    salvarConfig(telegramUserId, config);
    return true;
  }
  return false;
}

// ===== PREFIXO =====
/** Prefixo padrao */
const DEFAULT_PREFIX = '.';
/** Caracteres tipicos de prefixo (so referencia / deteccao — nao sao aliases) */
const UNIVERSAL_PREFIXES = ['.', '/', '!', '#', '•', '$', '*'];

function getPrefix(telegramUserId) {
  const raw = getConfig(telegramUserId).prefix;
  if (raw == null || String(raw).trim() === '') return DEFAULT_PREFIX;
  return String(raw);
}

/**
 * Prefixo para textos de menu/ajuda/usage — sempre leitura live da config.
 * WhatsApp: getPrefix(user). Telegram: sempre `/`.
 * @param {string|number} [telegramUserId]
 * @param {{ platform?: string, prefix?: string }} [opts]
 * @returns {string}
 */
function displayPrefix(telegramUserId, opts = {}) {
  const platform = String(opts.platform || 'whatsapp').toLowerCase();
  if (platform === 'telegram') return '/';
  if (opts.conn && opts.conn._isTelegramShim) return '/';
  if (opts.ctx && (opts.ctx.platform === 'telegram' || opts.ctx.isTelegram)) return '/';
  // Config live sempre vence cache/ctx.prefix
  if (telegramUserId != null && telegramUserId !== '') {
    return getPrefix(telegramUserId);
  }
  if (opts.prefix != null && String(opts.prefix).trim() !== '') {
    return String(opts.prefix);
  }
  return DEFAULT_PREFIX;
}

/**
 * Prefixo a partir do ctx do comando (WA/TG).
 * Prefere config live (telegramUserId); fallback ctx.prefix.
 */
function prefixFromCtx(ctx = {}) {
  const platform = String(ctx.platform || (ctx.isTelegram ? 'telegram' : 'whatsapp')).toLowerCase();
  if (platform === 'telegram') return '/';
  return displayPrefix(ctx.telegramUserId, { prefix: ctx.prefix, platform: 'whatsapp' });
}

/**
 * Exemplo de comando com prefixo atual: cmdExample(uid, 'play') → "!play"
 * @param {string|number} telegramUserId
 * @param {string} command - nome ou usage (pode vir com prefixo antigo; e removido)
 * @param {{ platform?: string, prefix?: string }} [opts]
 */
function cmdExample(telegramUserId, command, opts = {}) {
  const p = displayPrefix(telegramUserId, opts);
  const raw = String(command || '').trim();
  const bare = raw.replace(/^[.\/!#•$*]+/, '');
  return `${p}${bare}`;
}

const LIVE_PREFIX_SKIP = /^(com|br|net|org|js|json|env|jpg|png|gif|mp3|mp4|webp|txt|md|zip|pdf|html|http|https|us|uk|io)$/i;

/**
 * Troca {p} e .cmd / !cmd / $cmd / #cmd pelo prefixo atual (nao mexe em .env / .com).
 */
function applyLivePrefix(text, prefix) {
  const p = String(prefix || '.');
  let s = String(text || '').split('{p}').join(p);
  s = s.replace(
    /(^|[\s(,:;|/])[.\/!#$•*]([a-zA-Z][a-zA-Z0-9_]{1,40})\b/g,
    (m, pre, cmd) => (LIVE_PREFIX_SKIP.test(cmd) ? m : `${pre}${p}${cmd}`)
  );
  return s;
}

/** Prefixo(s) aceitos: WA = so o configurado; TG = sempre / */
function getAcceptedPrefixes(telegramUserId, opts = {}) {
  const platform = String(opts.platform || 'whatsapp').toLowerCase();
  if (platform === 'telegram') return ['/'];
  return [getPrefix(telegramUserId)];
}

function formatPrefixStatus(telegramUserId) {
  const primary = getPrefix(telegramUserId);
  return (
    `WhatsApp: ${primary} (unico desta sessao — ponto, barra, asterisco, numero, letra...)\n` +
    `Telegram: / (fixo neste chat)\n` +
    `Trocar no Zap: ${primary}setprefix <novo> (max 2 chars)`
  );
}

function setPrefix(telegramUserId, newPrefix) {
  const config = getConfig(telegramUserId);
  const p = String(newPrefix || '').trim();
  if (!p || p.length > 2) return false;
  config.prefix = p;
  salvarConfig(telegramUserId, config);
  return true;
}

// ===== BOTÕES INTERATIVOS =====
function getButtonsEnabled(telegramUserId) {
  const config = getConfig(telegramUserId);
  return config.buttonsEnabled !== undefined ? config.buttonsEnabled : true;
}

function setButtonsEnabled(telegramUserId, enabled) {
  const config = getConfig(telegramUserId);
  config.buttonsEnabled = enabled;
  salvarConfig(telegramUserId, config);
  return true;
}

function getWhatsAppChannelId(telegramUserId) {
  const config = getConfig(telegramUserId);
  const { normalizeNewsletterJid, CHANNEL_JID } = require('./channelForward');
  // Default SEMPRE JID numerico — convite 0029... quebra encaminhada ("atualizacao nao e valida")
  return normalizeNewsletterJid(config.whatsappChannelId || CHANNEL_JID);
}

function setWhatsAppChannelId(telegramUserId, channelId) {
  const config = getConfig(telegramUserId);
  const { normalizeNewsletterJid, isValidNewsletterJid, CHANNEL_JID } = require('./channelForward');
  const raw = String(channelId || '').trim();
  if (!isValidNewsletterJid(raw)) {
    // Convite 0029... nao serve como newsletterJid — guarda fallback valido
    config.whatsappChannelId = CHANNEL_JID;
    salvarConfig(telegramUserId, config);
    return { ok: false, saved: CHANNEL_JID, reason: 'jid_invalido_use_numerico' };
  }
  config.whatsappChannelId = normalizeNewsletterJid(raw);
  salvarConfig(telegramUserId, config);
  return { ok: true, saved: config.whatsappChannelId };
}

// ===== MODERAÇÃO =====
function getModerationConfig(telegramUserId) {
  const config = getConfig(telegramUserId);
  return config.moderation || { enabledGroups: [] };
}

function setModerationConfig(telegramUserId, moderationConfig) {
  const config = getConfig(telegramUserId);
  config.moderation = moderationConfig;
  salvarConfig(telegramUserId, config);
  try {
    require('./sqlStore').mirrorModerationBlob(telegramUserId, moderationConfig);
  } catch (_) { /* sql opcional */ }
  return true;
}

// ===== NUKE CONFIG =====
function nukeChannelHint() {
  try {
    const { formatCanalPublicText } = require('./canal');
    return formatCanalPublicText().replace(/\n/g, ' ');
  } catch (_) {
    return '120363412971004933@newsletter';
  }
}

let _cachedNukeMenuImageB64 = undefined; // undefined=ainda nao leu; null=ausente

function loadNukeMenuImageBase64() {
  if (_cachedNukeMenuImageB64 !== undefined) return _cachedNukeMenuImageB64;
  const candidates = [
    path.join(__dirname, '..', 'brand', 'menu.jpg'),
    path.join(__dirname, '..', 'assets', 'menu.jpg')
  ];
  try {
    for (const imgPath of candidates) {
      if (fs.existsSync(imgPath)) {
        _cachedNukeMenuImageB64 = fs.readFileSync(imgPath).toString('base64');
        return _cachedNukeMenuImageB64;
      }
    }
  } catch (_) { /* ignore */ }
  _cachedNukeMenuImageB64 = null;
  return null;
}

/** Padrao Hanork quando o dono ainda nao configurou (ou /nukereset) */
function defaultNukeConfig() {
  return {
    groupName: 'by: bot hanork.',
    groupDesc: `Ate a proxima peregrinos, entrem no canal: ${nukeChannelHint()}`,
    groupMessage: 'ops, rs. 🤭',
    groupImage: loadNukeMenuImageBase64()
  };
}

function getNukeConfig(telegramUserId) {
  const config = getConfig(telegramUserId);
  if (config.nuke && typeof config.nuke === 'object') {
    return config.nuke;
  }
  return defaultNukeConfig();
}

function setNukeConfig(telegramUserId, nukeConfig) {
  const config = getConfig(telegramUserId);
  config.nuke = nukeConfig;
  salvarConfig(telegramUserId, config);
  return true;
}

// ===== EXPORTAÇÕES =====
module.exports = {
  getConfigDir,
  getConfigPath,
  carregarConfig,
  salvarConfig,
  restoreConfigFromSql,
  getConfig,
  updateConfig,
  getOwners,
  getEffectiveOwners,
  addOwner,
  ensureOwnerAliases,
  removeOwner,
  compactOwners,
  compactAllUserOwners,
  formatOwnerLabel,
  formatOwnersCaption,
  listOwnersForDisplay,
  getVips,
  addVip,
  removeVip,
  getBlacklist,
  addBlacklist,
  removeBlacklist,
  getPrefix,
  setPrefix,
  displayPrefix,
  prefixFromCtx,
  cmdExample,
  applyLivePrefix,
  getAcceptedPrefixes,
  formatPrefixStatus,
  DEFAULT_PREFIX,
  UNIVERSAL_PREFIXES,
  getButtonsEnabled,
  setButtonsEnabled,
  getWhatsAppChannelId,
  setWhatsAppChannelId,
  getModerationConfig,
  setModerationConfig,
  getNukeConfig,
  setNukeConfig,
  defaultNukeConfig,
  getIntentConfig,
  setIntentRouterEnabled,
  updateIntentRouter,
  DEFAULT_INTENT_ROUTER,
  getEvolutionConfig,
  updateEvolution,
  setEvolutionEnabled,
  DEFAULT_EVOLUTION,
  ROLE_RANK,
  roleMeetsMinLevel
};