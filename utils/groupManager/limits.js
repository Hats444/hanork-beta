'use strict';

const DEFAULTS = {
  maxTotalGroups: 100,
  maxGroupsPerSession: 100,
  maxJoinsPerDay: 80,
  maxLeavesPerDay: 20,
  maxBatchSize: 25,
  joinDelayMs: 15000,
  leaveDelayMs: 15000,
  maxAttemptsPerInvite: 3,
  autoRefill: false
};

/** Botoes do painel Limites (teto de ocupacao = grupos em que o bot esta). */
const OCCUPANCY_PRESETS = [10, 25, 50, 100, 200];

function clampInt(n, min, max, fallback) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** false/0/"off" = OFF. Sem chave gravada = default (OFF). */
function coerceAutoRefill(v, fallback = DEFAULTS.autoRefill) {
  if (v === false || v === 0 || v === '0') return false;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'false' || s === 'off' || s === 'nao' || s === 'não' || s === 'no') return false;
  if (v === true || v === 1 || v === '1') return true;
  if (s === 'true' || s === 'on' || s === 'yes' || s === 'sim') return true;
  return fallback;
}

function todayKey() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(new Date());
}

function scope(ownerKey) {
  return `gm:${String(ownerKey || '').slice(0, 80)}`;
}

function loadLimits(ownerKey) {
  const store = require('../sqlStore');
  const raw = store.getCachedKv(scope(ownerKey), 'limits') || {};
  return {
    maxTotalGroups: clampInt(raw.maxTotalGroups, 1, 500, DEFAULTS.maxTotalGroups),
    maxGroupsPerSession: clampInt(raw.maxGroupsPerSession, 1, 500, DEFAULTS.maxGroupsPerSession),
    maxJoinsPerDay: clampInt(
      raw.maxJoinsPerDay == null || Number(raw.maxJoinsPerDay) === 30
        ? DEFAULTS.maxJoinsPerDay
        : raw.maxJoinsPerDay,
      1,
      200,
      DEFAULTS.maxJoinsPerDay
    ),
    maxLeavesPerDay: clampInt(raw.maxLeavesPerDay, 1, 200, DEFAULTS.maxLeavesPerDay),
    maxBatchSize: clampInt(raw.maxBatchSize, 1, 50, DEFAULTS.maxBatchSize),
    joinDelayMs: clampInt(raw.joinDelayMs, 3000, 120000, DEFAULTS.joinDelayMs),
    leaveDelayMs: clampInt(raw.leaveDelayMs, 3000, 120000, DEFAULTS.leaveDelayMs),
    maxAttemptsPerInvite: clampInt(raw.maxAttemptsPerInvite, 1, 10, DEFAULTS.maxAttemptsPerInvite),
    autoRefill: coerceAutoRefill(raw.autoRefill, DEFAULTS.autoRefill)
  };
}

function saveLimits(ownerKey, patch) {
  const cur = loadLimits(ownerKey);
  const next = { ...cur, ...(patch || {}) };
  next.maxTotalGroups = clampInt(next.maxTotalGroups, 1, 500, DEFAULTS.maxTotalGroups);
  next.maxGroupsPerSession = clampInt(next.maxGroupsPerSession, 1, 500, DEFAULTS.maxGroupsPerSession);
  next.maxJoinsPerDay = clampInt(next.maxJoinsPerDay, 1, 200, DEFAULTS.maxJoinsPerDay);
  next.maxLeavesPerDay = clampInt(next.maxLeavesPerDay, 1, 200, DEFAULTS.maxLeavesPerDay);
  next.maxBatchSize = clampInt(next.maxBatchSize, 1, 50, DEFAULTS.maxBatchSize);
  next.joinDelayMs = clampInt(next.joinDelayMs, 3000, 120000, DEFAULTS.joinDelayMs);
  next.leaveDelayMs = clampInt(next.leaveDelayMs, 3000, 120000, DEFAULTS.leaveDelayMs);
  next.maxAttemptsPerInvite = clampInt(next.maxAttemptsPerInvite, 1, 10, DEFAULTS.maxAttemptsPerInvite);
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'autoRefill')) {
    next.autoRefill = coerceAutoRefill(patch.autoRefill, false);
  } else {
    next.autoRefill = coerceAutoRefill(next.autoRefill, DEFAULTS.autoRefill);
  }
  require('../sqlStore').upsertKv(scope(ownerKey), 'limits', next);
  return next;
}

function isAutoRefillOn(ownerKey) {
  return loadLimits(ownerKey).autoRefill === true;
}

function loadState(ownerKey) {
  const store = require('../sqlStore');
  const raw = store.getCachedKv(scope(ownerKey), 'state') || {};
  const day = todayKey();
  if (raw.dayKey !== day) {
    return {
      paused: !!raw.paused,
      joinsToday: 0,
      leavesToday: 0,
      dayKey: day,
      lastJoinAt: raw.lastJoinAt || null,
      lastLeaveAt: raw.lastLeaveAt || null
    };
  }
  return {
    paused: !!raw.paused,
    joinsToday: Number(raw.joinsToday) || 0,
    leavesToday: Number(raw.leavesToday) || 0,
    dayKey: day,
    lastJoinAt: raw.lastJoinAt || null,
    lastLeaveAt: raw.lastLeaveAt || null
  };
}

function saveState(ownerKey, state) {
  require('../sqlStore').upsertKv(scope(ownerKey), 'state', {
    paused: !!state.paused,
    joinsToday: Number(state.joinsToday) || 0,
    leavesToday: Number(state.leavesToday) || 0,
    dayKey: state.dayKey || todayKey(),
    lastJoinAt: state.lastJoinAt || null,
    lastLeaveAt: state.lastLeaveAt || null
  });
  return loadState(ownerKey);
}

function setPaused(ownerKey, paused) {
  const st = loadState(ownerKey);
  st.paused = !!paused;
  return saveState(ownerKey, st);
}

function bumpJoins(ownerKey, n) {
  const st = loadState(ownerKey);
  st.joinsToday += Math.max(0, Number(n) || 0);
  st.lastJoinAt = new Date().toISOString();
  return saveState(ownerKey, st);
}

function bumpLeaves(ownerKey, n) {
  const st = loadState(ownerKey);
  st.leavesToday += Math.max(0, Number(n) || 0);
  st.lastLeaveAt = new Date().toISOString();
  return saveState(ownerKey, st);
}

/**
 * quantidade_real = MIN(pedido, capacidades, pendentes)
 */
function computeJoinCount({
  requested,
  maxBatchSize,
  maxTotalGroups,
  activeGroups,
  maxGroupsPerSession,
  sessionGroups,
  maxJoinsPerDay,
  joinsToday,
  pending
}) {
  const pedido = Math.max(0, Number(requested) || 0);
  const capGlobal = Math.max(0, (Number(maxTotalGroups) || 0) - (Number(activeGroups) || 0));
  const capSessao = Math.max(0, (Number(maxGroupsPerSession) || 0) - (Number(sessionGroups) || 0));
  const capDia = Math.max(0, (Number(maxJoinsPerDay) || 0) - (Number(joinsToday) || 0));
  const pend = Math.max(0, Number(pending) || 0);
  const batch = Math.max(0, Number(maxBatchSize) || 0);
  return Math.min(pedido, capGlobal, capSessao, capDia, pend, batch);
}

function computeLeaveCount({
  requested,
  maxBatchSize,
  maxLeavesPerDay,
  leavesToday,
  activeGroups
}) {
  const pedido = Math.max(0, Number(requested) || 0);
  const capDia = Math.max(0, (Number(maxLeavesPerDay) || 0) - (Number(leavesToday) || 0));
  const ativos = Math.max(0, Number(activeGroups) || 0);
  const batch = Math.max(0, Number(maxBatchSize) || 0);
  return Math.min(pedido, capDia, ativos, batch);
}

module.exports = {
  DEFAULTS,
  OCCUPANCY_PRESETS,
  coerceAutoRefill,
  isAutoRefillOn,
  loadLimits,
  saveLimits,
  loadState,
  saveState,
  setPaused,
  bumpJoins,
  bumpLeaves,
  computeJoinCount,
  computeLeaveCount,
  todayKey
};
