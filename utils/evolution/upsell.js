// utils/evolution/upsell.js — decide tip apos evento
'use strict';

const { hasUnlock } = require('./levels');
const { failAlt, familyOf } = require('./classify');
const { recommendForProfile } = require('./ranking');
const {
  variantFor,
  canShowTip,
  renderTip,
  markTipShown
} = require('./abTips');
const { stripAccents } = require('../typography');

function roleIsVip(role) {
  return role === 'vip' || role === 'owner' || role === 'platform_admin';
}

/**
 * Escolhe no max 1 tip prioritario.
 * @returns {{ kind, variant, text }|null}
 */
function chooseTip(profile, {
  scoreMeta = {},
  command = '',
  role = 'user',
  prefix = '.',
  isGroup = false,
  telegramUserId,
  now = Date.now()
} = {}) {
  const p = prefix || '.';
  const vip = roleIsVip(role);

  // 1) Level up sempre (se permitido throttle)
  if (scoreMeta.leveledUp && canShowTip(profile, 'level_up', { isGroup, now })) {
    const variant = variantFor(profile, 'level_up');
    const text = renderTip('level_up', variant, p, {
      fromName: `Nv${scoreMeta.fromLevel || scoreMeta.level?.id - 1 || '?'}`,
      toName: scoreMeta.level?.name || `Nv${profile.level}`,
      toId: scoreMeta.level?.id || profile.level
    });
    if (text) {
      markTipShown(profile, 'level_up', variant, telegramUserId, now);
      return { kind: 'level_up', variant, text: stripAccents(text) };
    }
  }

  // 2) Fail help
  if (scoreMeta.family && scoreMeta.ok === false && !scoreMeta.denied) {
    const alt = failAlt(command);
    const fails = Number(profile.cmdHits?.[command]?.fail) || 0;
    if (alt && fails >= 2 && canShowTip(profile, 'fail_help', { isGroup, now })) {
      const variant = variantFor(profile, 'fail_help');
      const text = renderTip('fail_help', variant, p, { cmd: command, alt });
      if (text) {
        markTipShown(profile, 'fail_help', variant, telegramUserId, now);
        return { kind: 'fail_help', variant, text: stripAccents(text) };
      }
    }
  }

  // 3) Upsell VIP
  if (
    !vip &&
    hasUnlock(profile, 'upsell_vip') &&
    (Number(profile.counters?.cmdsOk) || 0) >= 12 &&
    canShowTip(profile, 'upsell_vip', { isGroup, now })
  ) {
    const variant = variantFor(profile, 'upsell_vip');
    const text = renderTip('upsell_vip', variant, p, {});
    if (text) {
      markTipShown(profile, 'upsell_vip', variant, telegramUserId, now);
      return { kind: 'upsell_vip', variant, text: stripAccents(text) };
    }
  }

  // 4) Upsell Pro (ja VIP, grupo maduro)
  if (
    vip &&
    hasUnlock(profile, 'upsell_pro') &&
    ((Number(profile.counters?.protecao) || 0) >= 3 || (Number(profile.counters?.canal) || 0) >= 2) &&
    canShowTip(profile, 'upsell_pro', { isGroup, now })
  ) {
    const variant = variantFor(profile, 'upsell_pro');
    const text = renderTip('upsell_pro', variant, p, {});
    if (text) {
      markTipShown(profile, 'upsell_pro', variant, telegramUserId, now);
      return { kind: 'upsell_pro', variant, text: stripAccents(text) };
    }
  }

  // 5) Streak nudge
  if (
    scoreMeta.firstOfDay &&
    (Number(profile.streakDays) || 0) >= 2 &&
    hasUnlock(profile, 'streak_visible') &&
    canShowTip(profile, 'streak', { isGroup, now })
  ) {
    const variant = variantFor(profile, 'streak');
    const text = renderTip('streak', variant, p, { streak: profile.streakDays });
    if (text) {
      markTipShown(profile, 'streak', variant, telegramUserId, now);
      return { kind: 'streak', variant, text: stripAccents(text) };
    }
  }

  // 6) Reco
  if (
    hasUnlock(profile, 'reco_cmds') &&
    (Number(profile.counters?.cmdsOk) || 0) >= 5 &&
    canShowTip(profile, 'reco', { isGroup, now })
  ) {
    const recs = recommendForProfile(profile, telegramUserId, 1);
    const cmd = recs[0] || 'play';
    const variant = variantFor(profile, 'reco');
    const text = renderTip('reco', variant, p, { cmd });
    if (text) {
      markTipShown(profile, 'reco', variant, telegramUserId, now);
      return { kind: 'reco', variant, text: stripAccents(text) };
    }
  }

  return null;
}

function shouldSkipFamilyNoise(command) {
  const fam = familyOf(command);
  return fam === 'menu' && Math.random() > 0.15;
}

module.exports = {
  chooseTip,
  shouldSkipFamilyNoise,
  roleIsVip
};
