// utils/evolution/store.js — persistencia SQL kv + cache RAM
'use strict';

const { SCHEMA_VERSION } = require('./constants');

const profileCache = new Map(); // key -> profile
const sessionRankCache = new Map(); // telegramUserId -> rank blob
const dirtyProfiles = new Set();
const dirtyRanks = new Set();

function senderKey(sender) {
  return String(sender || '')
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@lid$/i, '')
    .replace(/:.*$/, '')
    .trim()
    .slice(0, 64) || 'unknown';
}

function profileKey(telegramUserId, sender) {
  return `${String(telegramUserId || '0')}:${senderKey(sender)}`;
}

function emptyProfile(telegramUserId, sender) {
  const now = Date.now();
  return {
    v: SCHEMA_VERSION,
    telegramUserId: String(telegramUserId || ''),
    sender: senderKey(sender),
    xp: 0,
    level: 1,
    streakDays: 0,
    lastActiveDay: null,
    firstSeenAt: now,
    updatedAt: now,
    counters: {
      cmds: 0,
      cmdsOk: 0,
      cmdsFail: 0,
      sticker: 0,
      downloadOk: 0,
      downloadFail: 0,
      consulta: 0,
      ia: 0,
      protecao: 0,
      canal: 0,
      div: 0,
      tipsShown: 0,
      tipsConverted: 0
    },
    families: {},
    cmdHits: {},
    hourlyCaps: {},
    unlocks: ['base'],
    milestones: [],
    quotas: {
      burstUntil: 0,
      burstMult: 1,
      throttleUntil: 0,
      failStreak: 0,
      daily: { day: null, costly: 0, tipKinds: {} }
    },
    ab: {
      tipSeed: Math.abs(hash32(profileKey(telegramUserId, sender))) % 2 === 0 ? 'A' : 'B',
      shown: {},
      conversions: 0
    },
    history: []
  };
}

function hash32(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function emptySessionRank(telegramUserId) {
  return {
    v: SCHEMA_VERSION,
    telegramUserId: String(telegramUserId || ''),
    updatedAt: Date.now(),
    cmds: {},
    tipStats: {},
    topUsers: []
  };
}

function migrateProfile(raw, telegramUserId, sender) {
  const base = emptyProfile(telegramUserId, sender);
  if (!raw || typeof raw !== 'object') return base;
  const p = { ...base, ...raw };
  p.v = SCHEMA_VERSION;
  p.counters = { ...base.counters, ...(raw.counters || {}) };
  p.families = { ...(raw.families || {}) };
  p.cmdHits = { ...(raw.cmdHits || {}) };
  p.hourlyCaps = { ...(raw.hourlyCaps || {}) };
  p.unlocks = Array.isArray(raw.unlocks) ? [...new Set(['base', ...raw.unlocks])] : ['base'];
  p.milestones = Array.isArray(raw.milestones) ? raw.milestones.slice(-40) : [];
  p.quotas = { ...base.quotas, ...(raw.quotas || {}) };
  p.quotas.daily = { ...base.quotas.daily, ...(raw.quotas?.daily || {}) };
  p.ab = { ...base.ab, ...(raw.ab || {}) };
  p.ab.shown = { ...(raw.ab?.shown || {}) };
  p.history = Array.isArray(raw.history) ? raw.history.slice(-60) : [];
  p.telegramUserId = String(telegramUserId || p.telegramUserId || '');
  p.sender = senderKey(sender || p.sender);
  return p;
}

function getSql() {
  try {
    return require('../sqlStore');
  } catch (_) {
    return null;
  }
}

function loadProfile(telegramUserId, sender) {
  const key = profileKey(telegramUserId, sender);
  if (profileCache.has(key)) return profileCache.get(key);

  let raw = null;
  const store = getSql();
  if (store) {
    try {
      raw = store.getCachedKv('evolution', key);
      if (!raw && typeof store.getKv === 'function') {
        // sync path: warm may not have run; try cache only
      }
    } catch (_) { /* */ }
  }
  const profile = migrateProfile(raw, telegramUserId, sender);
  profileCache.set(key, profile);
  return profile;
}

function saveProfile(profile, { flush = false } = {}) {
  if (!profile) return;
  const key = profileKey(profile.telegramUserId, profile.sender);
  profile.updatedAt = Date.now();
  profileCache.set(key, profile);
  dirtyProfiles.add(key);
  if (flush) flushDirty();
}

function loadSessionRank(telegramUserId) {
  const uid = String(telegramUserId || '');
  if (sessionRankCache.has(uid)) return sessionRankCache.get(uid);
  let raw = null;
  const store = getSql();
  if (store) {
    try {
      raw = store.getCachedKv('evolution_rank', uid);
    } catch (_) { /* */ }
  }
  const rank = raw && typeof raw === 'object'
    ? { ...emptySessionRank(uid), ...raw, cmds: { ...(raw.cmds || {}) }, tipStats: { ...(raw.tipStats || {}) } }
    : emptySessionRank(uid);
  sessionRankCache.set(uid, rank);
  return rank;
}

function saveSessionRank(rank, { flush = false } = {}) {
  if (!rank) return;
  const uid = String(rank.telegramUserId || '');
  rank.updatedAt = Date.now();
  sessionRankCache.set(uid, rank);
  dirtyRanks.add(uid);
  if (flush) flushDirty();
}

function flushDirty() {
  const store = getSql();
  if (!store || typeof store.upsertKv !== 'function') {
    dirtyProfiles.clear();
    dirtyRanks.clear();
    return;
  }
  for (const key of dirtyProfiles) {
    const p = profileCache.get(key);
    if (p) {
      try {
        store.upsertKv('evolution', key, p);
      } catch (_) { /* */ }
    }
  }
  dirtyProfiles.clear();
  for (const uid of dirtyRanks) {
    const r = sessionRankCache.get(uid);
    if (r) {
      try {
        store.upsertKv('evolution_rank', uid, r);
      } catch (_) { /* */ }
    }
  }
  dirtyRanks.clear();
}

// Debounce flush
let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDirty();
  }, 1500);
  flushTimer.unref?.();
}

function markDirtyProfile(profile) {
  saveProfile(profile, { flush: false });
  scheduleFlush();
}

function markDirtyRank(rank) {
  saveSessionRank(rank, { flush: false });
  scheduleFlush();
}

function listCachedProfilesForSession(telegramUserId) {
  const prefix = `${String(telegramUserId || '')}:`;
  const out = [];
  for (const [k, p] of profileCache.entries()) {
    if (k.startsWith(prefix)) out.push(p);
  }
  return out;
}

function resetProfile(telegramUserId, sender) {
  const p = emptyProfile(telegramUserId, sender);
  saveProfile(p, { flush: true });
  return p;
}

module.exports = {
  senderKey,
  profileKey,
  emptyProfile,
  loadProfile,
  saveProfile,
  markDirtyProfile,
  loadSessionRank,
  saveSessionRank,
  markDirtyRank,
  flushDirty,
  scheduleFlush,
  listCachedProfilesForSession,
  resetProfile
};
