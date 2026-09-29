// utils/evolution/abTips.js — A/B + conversao
'use strict';

const { TIP_VARIANTS, TIP_THROTTLE } = require('./constants');
const { hasUnlock } = require('./levels');
const { dayKey } = require('./scorer');
const { markDirtyProfile } = require('./store');
const { bumpTipStat } = require('./ranking');

const tipThrottle = new Map(); // key -> ts

function variantFor(profile, kind) {
  // 10% explore opposite variant when advanced unlock
  const seed = profile?.ab?.tipSeed === 'B' ? 'B' : 'A';
  if (hasUnlock(profile, 'ab_advanced') && Math.random() < 0.12) {
    return seed === 'A' ? 'B' : 'A';
  }
  return seed;
}

function tipKey(kind, variant) {
  return `${kind}_${variant}`;
}

function canShowTip(profile, kind, { isGroup = false, now = Date.now() } = {}) {
  if (!hasUnlock(profile, 'tips_on') && kind !== 'level_up') return false;

  const throttleMs = kind === 'level_up'
    ? TIP_THROTTLE.level_up
    : (isGroup ? TIP_THROTTLE.group : TIP_THROTTLE.dm);

  const tKey = `${profile.telegramUserId}:${profile.sender}:${kind}`;
  const last = tipThrottle.get(tKey) || 0;
  if (throttleMs > 0 && now - last < throttleMs) return false;

  const shown = profile.ab?.shown?.[kind];
  if (shown?.at && now - shown.at < TIP_THROTTLE.sameKind && kind !== 'level_up') {
    return false;
  }

  const today = dayKey(now);
  if (profile.quotas?.daily?.day !== today) {
    profile.quotas.daily = { day: today, costly: 0, tipKinds: {} };
  }
  const kindsToday = profile.quotas.daily.tipKinds || {};
  const maxTips = hasUnlock(profile, 'daily_second_tip') ? 2 : 1;
  const countToday = Object.values(kindsToday).reduce((a, b) => a + (Number(b) || 0), 0);
  if (kind !== 'level_up' && countToday >= maxTips) return false;

  return true;
}

function renderTip(kind, variant, prefix, ctx = {}) {
  const pack = TIP_VARIANTS[kind];
  if (!pack) return null;
  const fn = pack[variant] || pack.A;
  if (typeof fn !== 'function') return null;
  try {
    return fn(prefix || '.', ctx);
  } catch (_) {
    return null;
  }
}

function markTipShown(profile, kind, variant, telegramUserId, now = Date.now()) {
  if (!profile.ab) profile.ab = { tipSeed: 'A', shown: {}, conversions: 0 };
  if (!profile.ab.shown) profile.ab.shown = {};
  profile.ab.shown[kind] = { variant, at: now, converted: false };
  const today = dayKey(now);
  if (profile.quotas.daily?.day !== today) {
    profile.quotas.daily = { day: today, costly: 0, tipKinds: {} };
  }
  if (!profile.quotas.daily.tipKinds) profile.quotas.daily.tipKinds = {};
  profile.quotas.daily.tipKinds[kind] = (Number(profile.quotas.daily.tipKinds[kind]) || 0) + 1;
  profile.counters.tipsShown = (Number(profile.counters.tipsShown) || 0) + 1;
  tipThrottle.set(`${profile.telegramUserId}:${profile.sender}:${kind}`, now);
  bumpTipStat(telegramUserId, tipKey(kind, variant), 'shown');
  markDirtyProfile(profile);
}

/**
 * Marca conversao se tip recente aponta pra acao.
 */
function maybeConvert(profile, command, telegramUserId, now = Date.now()) {
  const cmd = String(command || '').toLowerCase();
  const shown = profile?.ab?.shown || {};
  const windowMs = 24 * 60 * 60 * 1000;
  const checks = [
    {
      kind: 'upsell_vip',
      match: /^(hanork|gpt|claude|deepsearch|analisar|comprar|sobre|planos|figurinha)/
    },
    {
      kind: 'upsell_pro',
      match: /^(comprar|sobre|planos|div|addgrupo|divstatus)/
    },
    {
      kind: 'reco',
      match: null // any cmd after reco counts soft — handled below
    },
    {
      kind: 'fail_help',
      match: null
    }
  ];

  for (const c of checks) {
    const row = shown[c.kind];
    if (!row || row.converted) continue;
    if (!row.at || now - row.at > windowMs) continue;
    if (c.match && !c.match.test(cmd)) continue;
    if (!c.match && c.kind === 'reco') {
      // conversao soft: usou algum cmd diferente do tip window
      if (!cmd) continue;
    }
    row.converted = true;
    bumpTipStat(telegramUserId, tipKey(c.kind, row.variant || 'A'), 'converted');
    markDirtyProfile(profile);
    return { kind: c.kind, variant: row.variant || 'A' };
  }
  return null;
}

module.exports = {
  variantFor,
  canShowTip,
  renderTip,
  markTipShown,
  maybeConvert,
  tipKey
};
