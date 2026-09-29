// utils/evolution/quotas.js — burst VIP / throttle abusador
'use strict';

const { isCostly, normalizeCmd } = require('./classify');
const { hasUnlock } = require('./levels');
const { dayKey } = require('./scorer');
const { markDirtyProfile } = require('./store');

const BURST_MS = 60 * 60 * 1000;
const THROTTLE_MS = 20 * 60 * 1000;
const DAILY_COSTLY_SOFT = 40;

function successRatio(profile) {
  const ok = Number(profile.counters?.cmdsOk) || 0;
  const fail = Number(profile.counters?.cmdsFail) || 0;
  const t = ok + fail;
  if (t < 8) return 1;
  return ok / t;
}

/**
 * Atualiza quotas apos um evento de score.
 */
function refreshQuotas(profile, { ok, role = 'user', now = Date.now() } = {}) {
  if (!profile.quotas) {
    profile.quotas = {
      burstUntil: 0,
      burstMult: 1,
      throttleUntil: 0,
      failStreak: 0,
      daily: { day: null, costly: 0, tipKinds: {} }
    };
  }
  const today = dayKey(now);
  if (profile.quotas.daily?.day !== today) {
    profile.quotas.daily = { day: today, costly: 0, tipKinds: {} };
  }

  const ratio = successRatio(profile);
  const lvlOk = hasUnlock(profile, 'quota_burst_eligible') || (Number(profile.level) || 1) >= 5;
  const isVip = role === 'vip' || role === 'owner' || role === 'platform_admin';

  // Burst: VIP/dono com bom ratio e nivel
  if (isVip && lvlOk && ratio >= 0.85 && (Number(profile.quotas.failStreak) || 0) < 2) {
    if ((profile.quotas.burstUntil || 0) < now) {
      profile.quotas.burstUntil = now + BURST_MS;
      profile.quotas.burstMult = ratio >= 0.95 ? 1.8 : 1.5;
    }
  }

  // Throttle: muitos fails ou abuso costly
  if (!ok && (Number(profile.quotas.failStreak) || 0) >= 5) {
    profile.quotas.throttleUntil = Math.max(profile.quotas.throttleUntil || 0, now + THROTTLE_MS);
    profile.quotas.burstUntil = 0;
    profile.quotas.burstMult = 1;
  }
  if ((Number(profile.quotas.daily.costly) || 0) > DAILY_COSTLY_SOFT && ratio < 0.7) {
    profile.quotas.throttleUntil = Math.max(profile.quotas.throttleUntil || 0, now + THROTTLE_MS);
  }

  markDirtyProfile(profile);
  return profile.quotas;
}

function noteCostlyUse(profile, command, now = Date.now()) {
  if (!isCostly(command)) return;
  const today = dayKey(now);
  if (profile.quotas.daily?.day !== today) {
    profile.quotas.daily = { day: today, costly: 0, tipKinds: {} };
  }
  profile.quotas.daily.costly = (Number(profile.quotas.daily.costly) || 0) + 1;
  markDirtyProfile(profile);
}

/**
 * Ajuste de rate-limit para o router.
 * @returns {{ maxMult: number, denyCostly: boolean, reason: string|null, burst: boolean, throttle: boolean }}
 */
function getRateLimitAdjust(profile, command, now = Date.now()) {
  const q = profile?.quotas || {};
  const throttle = (q.throttleUntil || 0) > now;
  const burst = (q.burstUntil || 0) > now;
  const cmd = normalizeCmd(command);
  const costly = isCostly(cmd);

  if (throttle && costly) {
    return {
      maxMult: 0.4,
      denyCostly: (Number(q.failStreak) || 0) >= 8,
      reason: 'evolucao_throttle',
      burst: false,
      throttle: true
    };
  }
  if (burst) {
    return {
      maxMult: Number(q.burstMult) || 1.5,
      denyCostly: false,
      reason: null,
      burst: true,
      throttle: false
    };
  }
  return { maxMult: 1, denyCostly: false, reason: null, burst: false, throttle: false };
}

module.exports = {
  refreshQuotas,
  noteCostlyUse,
  getRateLimitAdjust,
  successRatio,
  BURST_MS,
  THROTTLE_MS
};
