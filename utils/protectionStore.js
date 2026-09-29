'use strict';
/**
 * Fonte unica de flags de protecao de grupo.
 * Leitura: RAM (invalidada em toda escrita). Persistencia: SQL group_protections.
 * group_flags EAV e JSON viram cache/legado — nao sao fonte de verdade.
 *
 * PK inclui telegram_user_id (bot multi-sessao). groupId sozinho misturaria tenants.
 */

const logger = require('../logger');

const ram = new Map();
const pendingAtk = new Map();
const PENDING_ATK_MS = 60_000;
const ATTACK_VECTORS = [
  'antiatkstatus',
  'antiatkinvisivel',
  'antiatkpagamento',
  'antiatkcrash',
  'antiatkpoll',
  'antiatkmencao',
  'antiatkreacao',
  'antiatkedicao'
];

function cacheKey(uid, gid) {
  return `${String(uid || '')}|${String(gid || '')}`;
}

const DEFAULT_ON_FLAGS = new Set();
const PROT_FLAGS_VERSION = 2;
const RESET_ON_V2 = [
  'soadm',
  'autoconvite',
  'antiadminRevert',
  'antiadminDetect',
  'surfPayment',
  'surfGroupStatus',
  'surfForwardSpoof',
  'surfMetaAi',
  'surfBizFake',
  'surfPhishAd',
  'surfNativeFlow',
  'surfViewOnce',
  'surfCapMentions',
  'surfCapMedia',
  'surfFakePoll',
  'surfSettingsFlood'
];

function defaults() {
  try {
    const { DEFAULT_GROUP_FLAGS } = require('./moderation');
    const out = { ...(DEFAULT_GROUP_FLAGS || {}) };
    if (out.antifloodsticker == null) out.antifloodsticker = 0;
    else out.antifloodsticker = Math.max(0, Number(out.antifloodsticker) || 0);
    return out;
  } catch (_) {
    return {};
  }
}

function knownFlags() {
  return new Set(Object.keys(defaults()));
}

function coerceFlag(flag, value) {
  if (flag === 'antifloodsticker' || flag === 'flagsVersion') return Math.max(0, Number(value) || 0);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value || '').toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
}

function jsonLegacyFlags(uid, gid) {
  try {
    const { getModerationConfig } = require('./configManager');
    return ((getModerationConfig(uid) || {}).groupFlags || {})[gid] || {};
  } catch (_) {
    return {};
  }
}

function invalidate(uid, gid) {
  ram.delete(cacheKey(uid, gid));
}

function applyStored(stored) {
  const base = defaults();
  const src = stored && typeof stored === 'object' ? stored : {};
  const ver = Number(src.flagsVersion) || 0;
  for (const [k, v] of Object.entries(src)) {
    if (k === 'soadmChosen' || k === 'flagsVersion') continue;
    if (!Object.prototype.hasOwnProperty.call(base, k) && k !== 'antifloodsticker') continue;
    base[k] = coerceFlag(k, v);
  }
  if (ver < PROT_FLAGS_VERSION) {
    for (const k of RESET_ON_V2) {
      if (Object.prototype.hasOwnProperty.call(base, k)) base[k] = false;
    }
  }
  base.soadmChosen = true;
  base.flagsVersion = Math.max(ver, PROT_FLAGS_VERSION);
  return base;
}

function seedFromLegacy(uid, gid) {
  const stored = {};
  let eav = null;
  try {
    const sql = require('./sqlStore');
    eav = sql.getCachedGroupFlags(uid, gid);
  } catch (_) { /* */ }
  const json = jsonLegacyFlags(uid, gid);
  const known = knownFlags();
  for (const src of [json, eav || {}]) {
    for (const [k, v] of Object.entries(src)) {
      if (!known.has(k)) continue;
      const coerced = coerceFlag(k, v);
      if (DEFAULT_ON_FLAGS.has(k) && !coerced) continue;
      stored[k] = coerced;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(stored, 'antiflood')) {
    try {
      const { getModerationConfig } = require('./configManager');
      const cfg = getModerationConfig(uid) || {};
      const groups = Array.isArray(cfg.enabledGroups) ? cfg.enabledGroups : [];
      if (groups.some((g) => String(g || '') === gid)) stored.antiflood = true;
    } catch (_) { /* enabledGroups opcional */ }
  }
  return stored;
}

function loadMerged(uid, gid) {
  const k = cacheKey(uid, gid);
  if (ram.has(k)) return applyStored(ram.get(k));
  let stored = null;
  try {
    stored = require('./sqlStore').getCachedGroupProtections(uid, gid);
  } catch (_) { /* */ }
  if (!stored) stored = seedFromLegacy(uid, gid);
  const merged = applyStored(stored);
  ram.set(k, { ...merged });
  return merged;
}

function getAllProtections(groupId, telegramUserId) {
  return loadMerged(String(telegramUserId || ''), String(groupId || ''));
}

function getProtection(groupId, flag, telegramUserId) {
  const flags = getAllProtections(groupId, telegramUserId);
  return flags[flag];
}

/** Grupos desta sessao com a flag ligada (RAM + SQL + legado antiflood). */
function listGroupsWithFlag(telegramUserId, flag) {
  const uid = String(telegramUserId || '');
  const key = String(flag || '');
  const hits = new Set();
  if (!uid || !key) return [];
  try {
    for (const [ck, stored] of ram.entries()) {
      if (!String(ck).startsWith(`${uid}|`)) continue;
      const gid = String(ck).slice(uid.length + 1);
      if (applyStored(stored)[key]) hits.add(gid);
    }
  } catch (_) { /* ignore */ }
  try {
    const rows = require('./sqlStore').listCachedGroupProtections(uid);
    for (const r of rows || []) {
      if (coerceFlag(key, (r.flags || {})[key])) hits.add(String(r.groupId || ''));
    }
  } catch (_) { /* SQL opcional */ }
  if (key === 'antiflood') {
    try {
      const { getModerationConfig } = require('./configManager');
      for (const g of (getModerationConfig(uid) || {}).enabledGroups || []) {
        const gid = String(g || '');
        if (gid && getProtection(gid, 'antiflood', uid)) hits.add(gid);
      }
    } catch (_) { /* legado */ }
  }
  return [...hits].filter(Boolean);
}

const persistChain = new Map();

async function persistRowNow(uid, gid, stored) {
  const sql = require('./sqlStore');
  await sql.upsertGroupProtectionsAsync(uid, gid, stored);
  for (const [flag, value] of Object.entries(stored || {})) {
    await sql.upsertGroupFlagAsync(uid, gid, flag, value);
  }
  if (sql.isReady()) return;
  try {
    const { getModerationConfig, setModerationConfig } = require('./configManager');
    const cfg = getModerationConfig(uid) || { enabledGroups: [], groupFlags: {} };
    if (!cfg.groupFlags) cfg.groupFlags = {};
    cfg.groupFlags[gid] = { ...(cfg.groupFlags[gid] || {}), ...stored };
    setModerationConfig(uid, cfg);
  } catch (_) { /* JSON so se SQL cair */ }
}

function persistRow(uid, gid, stored) {
  const k = cacheKey(uid, gid);
  const snap = { ...(stored || {}) };
  const prev = persistChain.get(k) || Promise.resolve();
  const next = prev
    .then(() => persistRowNow(uid, gid, snap))
    .catch((e) => logger.logAviso(`[PROT] persist falhou: ${e.message || e}`));
  persistChain.set(k, next);
  return next;
}

async function setProtection(groupId, flag, value, actorId, telegramUserId) {
  const uid = String(telegramUserId || '');
  const gid = String(groupId || '');
  const key = String(flag || '');
  if (!uid || !gid || !key) return getAllProtections(gid, uid);
  const known = knownFlags();
  if (!known.has(key)) {
    logger.logAviso(`[PROT] flag desconhecida recusada: ${key}`);
    return getAllProtections(gid, uid);
  }
  const current = loadMerged(uid, gid);
  const oldValue = current[key];
  const nextVal = coerceFlag(key, value);
  const stored = { ...current, [key]: nextVal, flagsVersion: PROT_FLAGS_VERSION };
  if (key === 'soadm') stored.soadmChosen = true;
  ram.set(cacheKey(uid, gid), stored);
  if (key === 'antiflood') {
    try {
      const sql = require('./sqlStore');
      if (!sql.isReady()) {
        const { enableModeration, disableModeration } = require('./moderation');
        if (nextVal) enableModeration(gid, uid);
        else disableModeration(gid, uid);
      }
    } catch (_) { /* JSON enabledGroups so se SQL cair */ }
  }
  try {
    await persistRow(uid, gid, stored);
  } catch (e) {
    logger.logAviso(`[PROT] persist falhou: ${e.message || e}`);
  }
  if (key === 'antiadmin') {
    try {
      const store = require('./groupTheftStore');
      await store.upsert(gid, uid, {
        protection_enabled: nextVal ? 1 : 0,
        revert_enabled: nextVal && stored.antiadminRevert !== false ? 1 : (nextVal ? 1 : 0)
      });
    } catch (_) { /* ignore */ }
  }
  try {
    await require('./sqlStore').insertProtectionChange({
      telegramUserId: uid,
      groupId: gid,
      flag: key,
      oldValue,
      newValue: nextVal,
      actorId: String(actorId || '')
    });
  } catch (e) {
    logger.logAviso(`[PROT] audit falhou: ${e.message || e}`);
  }
  return applyStored(stored);
}

async function resetAllGroupProtections(groupId, actorId, telegramUserId) {
  const uid = String(telegramUserId || '');
  const gid = String(groupId || '');
  if (!uid || !gid) return getAllProtections(gid, uid);
  const known = knownFlags();
  let last = getAllProtections(gid, uid);
  for (const key of known) {
    if (key === 'grupoDivulgacao') continue;
    const val = key === 'antifloodsticker' ? 0 : false;
    last = await setProtection(gid, key, val, actorId, uid);
  }
  return last;
}

function denyToggleText() {
  return 'So dono da sessao, VIP, dono do grupo ou admin do grupo (e o bot precisa ser admin) pode alterar protecao.';
}

function participantIsWaAdmin(p) {
  if (!p || typeof p !== 'object') return false;
  return !!(p.admin || p.isAdmin || p.isSuperAdmin);
}

function idsMatchParticipant(p, ids, logic) {
  const rec = logic.extractJidsFromParticipant ? logic.extractJidsFromParticipant(p) : {};
  const pids = [rec.id, rec.lid, rec.pn, p.id, p.lid, p.jid, p.phoneNumber].filter(Boolean);
  return ids.some((id) => pids.some((pid) => logic.sameId(id, pid)));
}

function isWaAdminInMeta(meta, jid, extra = []) {
  const logic = require('./groupTheftLogic');
  const ids = [jid, ...(Array.isArray(extra) ? extra : [extra])].filter(Boolean);
  if (!meta || !ids.length) return false;
  for (const p of meta.participants || []) {
    if (!idsMatchParticipant(p, ids, logic)) continue;
    return participantIsWaAdmin(p);
  }
  return false;
}

function botIsGroupAdmin(meta, conn) {
  if (!meta || !conn?.user) return false;
  const ids = [conn.user.id, conn.user.lid, conn.user.jid].filter(Boolean);
  return isWaAdminInMeta(meta, ids[0], ids.slice(1));
}

function canTogglePolicy(senderId, groupId, ctx = {}) {
  try {
    const { isFreshSessionOwner, isBotSessionOwner } = require('./authorization');
    if (ctx && isFreshSessionOwner(ctx)) return true;
    const sender = String(senderId || ctx?.sender || '');
    const extras = [ctx.senderAlt, ctx.senderPn, ctx.senderLid].filter(Boolean);
    if (ctx.telegramUserId && isBotSessionOwner(ctx.telegramUserId, sender, extras, ctx.conn)) {
      return true;
    }
  } catch (_) {
    if (ctx && (ctx.authRole === 'owner' || ctx.authRole === 'platform_admin')) return true;
  }
  const sender = String(senderId || ctx?.sender || '');
  const extras = [ctx.senderAlt, ctx.senderPn, ctx.senderLid].filter(Boolean);
  const gid = String(groupId || ctx?.from || '');
  if (!sender || !gid || !/@g\.us$/i.test(gid)) return false;
  try {
    const logic = require('./groupTheftLogic');
    const { peekGroupMetadata } = require('./groupMetaCache');
    const meta = peekGroupMetadata(gid);
    const native = logic.nativeOwnerFromMeta(meta);
    if (native && logic.sameId(sender, native)) return true;
    const rec = require('./groupTheftStore').peek(gid, ctx.telegramUserId);
    if (rec?.registered_owner_jid && logic.sameId(sender, rec.registered_owner_jid)) return true;
    // Admin nativo do Zap: so se o BOT tambem for admin neste grupo.
    if (meta && botIsGroupAdmin(meta, ctx.conn) && isWaAdminInMeta(meta, sender, extras)) {
      return true;
    }
  } catch (_) { /* meta/sql opcional */ }
  return false;
}

function assertCanToggle(ctx) {
  const gid = ctx?.from || ctx?.groupId || '';
  const sender = ctx?.sender || ctx?.senderPn || '';
  if (canTogglePolicy(sender, gid, ctx)) return { ok: true };
  return { ok: false, text: denyToggleText() };
}

function pendingKey(ctx) {
  return `${ctx.telegramUserId || ''}|${ctx.from || ''}|${ctx.sender || ''}`;
}

function armAtkConfirm(ctx, turnOn) {
  pendingAtk.set(pendingKey(ctx), { on: !!turnOn, exp: Date.now() + PENDING_ATK_MS });
}

function peekAtkConfirm(ctx) {
  const k = pendingKey(ctx);
  const rec = pendingAtk.get(k);
  if (!rec) return null;
  if (Date.now() > rec.exp) {
    pendingAtk.delete(k);
    return null;
  }
  return rec;
}

function clearAtkConfirm(ctx) {
  pendingAtk.delete(pendingKey(ctx));
}

async function applyAttackVectors(groupId, turnOn, actorId, telegramUserId) {
  let last = null;
  for (const flag of ATTACK_VECTORS) {
    last = await setProtection(groupId, flag, !!turnOn, actorId, telegramUserId);
  }
  return last;
}

/** Presets de protecao (loja / divulgacao / fechado). */
const PROTECTION_PRESETS = {
  loja: {
    label: 'Loja',
    desc: 'antilink soft + antifake + antistatus + antiadmin (revert)',
    flags: {
      antilink: true,
      antifake: true,
      antistatus: true,
      antiadmin: true,
      antiadminRevert: true,
      antiadminAlert: true
    }
  },
  divulgacao: {
    label: 'Divulgacao',
    desc: 'antilinkgp + antifake + antistatus + antiadmin',
    flags: {
      antilinkGp: true,
      antifake: true,
      antistatus: true,
      antiadmin: true,
      antiadminRevert: true,
      antiadminAlert: true
    }
  },
  fechado: {
    label: 'Fechado',
    desc: 'loja + antiatk status/invisivel/pagamento + antilinkHard',
    flags: {
      antilink: true,
      antilinkHard: true,
      antifake: true,
      antistatus: true,
      antiatkstatus: true,
      antiatkinvisivel: true,
      antiatkpagamento: true,
      antiadmin: true,
      antiadminRevert: true,
      antiadminAlert: true,
      antiadminDetect: true
    }
  }
};

async function applyProtectionPreset(groupId, presetId, actorId, telegramUserId) {
  const pack = PROTECTION_PRESETS[String(presetId || '').toLowerCase()];
  if (!pack) return { ok: false, message: 'Preset invalido. Use: loja | divulgacao | fechado' };
  let last = null;
  for (const [flag, val] of Object.entries(pack.flags)) {
    last = await setProtection(groupId, flag, !!val, actorId, telegramUserId);
  }
  try {
    const store = require('./groupTheftStore');
    if (pack.flags.antiadmin) {
      await store.upsert(groupId, telegramUserId, {
        protection_enabled: 1,
        revert_enabled: pack.flags.antiadminRevert === false ? 0 : 1,
        alert_enabled: pack.flags.antiadminAlert === false ? 0 : 1,
        attack_detect: pack.flags.antiadminDetect ? 1 : 0
      });
    }
  } catch (_) { /* store opcional */ }
  return { ok: true, preset: String(presetId).toLowerCase(), label: pack.label, desc: pack.desc, last };
}

async function handleAtkConfirm(conn, ctx, id) {
  const gate = assertCanToggle(ctx);
  if (!gate.ok) {
    return conn.sendMessage(ctx.from, { text: gate.text }, { quoted: ctx.info });
  }
  if (id === 'prot_atk_cancel') {
    clearAtkConfirm(ctx);
    return conn.sendMessage(ctx.from, { text: 'Cancelado.' }, { quoted: ctx.info });
  }
  const rec = peekAtkConfirm(ctx);
  clearAtkConfirm(ctx);
  if (!rec) {
    return conn.sendMessage(ctx.from, { text: 'Pedido expirou. Manda o comando de novo.' }, { quoted: ctx.info });
  }
  await applyAttackVectors(ctx.from, rec.on, ctx.sender, ctx.telegramUserId);
  const p = require('./configManager').prefixFromCtx(ctx);
  return conn.sendMessage(ctx.from, {
    text: rec.on
      ? `8 vetores antiatk ligados neste grupo.\nPainel: ${p}gpseguranca`
      : `8 vetores antiatk desligados neste grupo.\nPainel: ${p}gpseguranca`
  }, { quoted: ctx.info });
}

async function migrateExistingSummary() {
  const out = { groups: 0, inheritedTrue: 0 };
  try {
    const sql = require('./sqlStore');
    const rows = await sql.migrateGroupProtectionsFromLegacy();
    out.groups = rows.groups || 0;
    out.inheritedTrue = rows.inheritedTrue || 0;
  } catch (e) {
    logger.logAviso(`[PROT] migrate: ${e.message || e}`);
  }
  return out;
}

/** Contagem sync (RAM). Para SQL completo use summarizeProtectionsAsync. */
function summarizeProtections() {
  const out = { groups: 0, antiadmin: 0, antilink: 0, antiatk: 0 };
  const seen = new Set();
  const countBag = (uid, gid, flags) => {
    const k = `${uid}|${gid}`;
    if (seen.has(k) || !flags || typeof flags !== 'object') return;
    const any =
      !!flags.antiadmin ||
      !!flags.antilink ||
      !!flags.antilinkHard ||
      !!flags.antilinkGp ||
      !!flags.antistatus ||
      ATTACK_VECTORS.some((f) => !!flags[f]);
    if (!any) return;
    seen.add(k);
    out.groups += 1;
    if (flags.antiadmin) out.antiadmin += 1;
    if (flags.antilink || flags.antilinkHard || flags.antilinkGp) out.antilink += 1;
    if (ATTACK_VECTORS.some((f) => !!flags[f])) out.antiatk += 1;
  };
  try {
    for (const [ck, flags] of ram.entries()) {
      const [uid, gid] = String(ck).split('|');
      countBag(uid, gid, flags);
    }
  } catch (_) { /* ignore */ }
  return out;
}

async function summarizeProtectionsAsync() {
  const out = summarizeProtections();
  try {
    const sql = require('./sqlStore');
    const rows = await sql.allAsync(
      `SELECT telegram_user_id, group_id, flags_json FROM group_protections`
    );
    const seen = new Set();
    // rebuild from SQL as source of truth
    out.groups = 0;
    out.antiadmin = 0;
    out.antilink = 0;
    out.antiatk = 0;
    for (const row of rows || []) {
      let flags = {};
      try { flags = JSON.parse(row.flags_json || '{}'); } catch (_) { flags = {}; }
      const k = `${row.telegram_user_id}|${row.group_id}`;
      if (seen.has(k)) continue;
      const any =
        !!flags.antiadmin ||
        !!flags.antilink ||
        !!flags.antilinkHard ||
        !!flags.antilinkGp ||
        !!flags.antistatus ||
        ATTACK_VECTORS.some((f) => !!flags[f]);
      if (!any) continue;
      seen.add(k);
      out.groups += 1;
      if (flags.antiadmin) out.antiadmin += 1;
      if (flags.antilink || flags.antilinkHard || flags.antilinkGp) out.antilink += 1;
      if (ATTACK_VECTORS.some((f) => !!flags[f])) out.antiatk += 1;
    }
  } catch (_) { /* SQL opcional */ }
  return out;
}

function parseOnOff(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const first = t.split(/\s+/)[0];
  if (/^(on|1|true|ativar|ativa|liga|ligar|sim|yes)$/.test(first)) return true;
  if (/^(off|0|false|desativar|desativa|desliga|desligar|nao|não|no)$/.test(first)) return false;
  return null;
}

module.exports = {
  getProtection,
  getAllProtections,
    setProtection,
    resetAllGroupProtections,
    listGroupsWithFlag,
  canTogglePolicy,
  canTogglePolicy: canTogglePolicy,
  assertCanToggle,
  assertCanToggle: assertCanToggle,
  denyToggleText,
  denyToggleText: denyToggleText,
  invalidate,
  ATTACK_VECTORS,
  PROTECTION_PRESETS,
  applyProtectionPreset,
  armAtkConfirm,
  handleAtkConfirm,
  applyAttackVectors,
  migrateExistingSummary,
  summarizeProtections,
  summarizeProtectionsAsync,
  knownFlags,
  parseOnOff,
  botIsGroupAdmin,
  isWaAdminInMeta
};
