// utils/evolution/pipeline.js — entrada unica pos-comando
'use strict';

const logger = require('../../logger');
const { getEvolutionConfig, displayPrefix } = require('../configManager');
const { loadProfile, markDirtyProfile } = require('./store');
const { applyCommandScore, applyConversionBonus } = require('./scorer');
const { refreshQuotas, noteCostlyUse, getRateLimitAdjust } = require('./quotas');
const { bumpCmdRank, updateLeaderboard } = require('./ranking');
const { maybeConvert } = require('./abTips');
const { chooseTip, shouldSkipFamilyNoise } = require('./upsell');
const { outcomeFromError, normalizeCmd } = require('./classify');
const { levelFromXp } = require('./levels');

/**
 * Registra outcome + tip opcional.
 * Nunca lanca — safe no hot path.
 */
async function recordCommandOutcome(conn, {
  telegramUserId,
  sender,
  command,
  ok = true,
  error = null,
  role = 'user',
  chatId = null,
  isGroup = false,
  quoted = null,
  platform = 'whatsapp',
  sendTip = true
} = {}) {
  try {
    const uid = String(telegramUserId || '');
    if (!uid || !sender) return null;

    const cfg = getEvolutionConfig(uid);
    if (!cfg.enabled) return null;

    const cmd = normalizeCmd(command);
    if (!cmd) return null;
    // nao pontuar cmds do proprio sistema de evolucao em loop de tip
    if (/^(nivel|evolucao|rank|desbloqueios|evoleader|evoadmin|evoreset|evoconfig)$/.test(cmd)) {
      // ainda conta conversao se veio de tip
    }

    let outcome = ok ? 'ok' : 'fail';
    if (error) outcome = outcomeFromError(error);
    const denied = outcome === 'denied';
    const success = outcome === 'ok';

    const profile = loadProfile(uid, sender);
    const fromLevel = profile.level;

    // conversao A/B antes do score (usa tip anterior)
    const converted = maybeConvert(profile, cmd, uid);
    let convertMeta = null;
    if (converted) {
      convertMeta = applyConversionBonus(profile, converted.kind);
    }

    let scoreMeta = {
      xpDelta: 0,
      leveledUp: false,
      level: levelFromXp(profile.xp),
      ok: success,
      denied,
      fromLevel
    };

    if (!/^(nivel|evolucao|rank|desbloqueios|evoleader|evoadmin|evoreset|evoconfig)$/.test(cmd)) {
      scoreMeta = applyCommandScore(profile, {
        command: cmd,
        ok: success,
        denied,
        now: Date.now()
      });
      scoreMeta.ok = success;
      scoreMeta.denied = denied;
      scoreMeta.fromLevel = fromLevel;

      if (!denied) {
        bumpCmdRank(uid, cmd, { ok: success });
        noteCostlyUse(profile, cmd);
        refreshQuotas(profile, { ok: success, role });
        if (hasLeaderboard(profile)) updateLeaderboard(uid, profile);
      }
    } else if (convertMeta?.leveledUp) {
      scoreMeta.leveledUp = true;
      scoreMeta.level = convertMeta.level;
    }

    let tip = null;
    if (
      sendTip &&
      cfg.tipsEnabled &&
      !denied &&
      !shouldSkipFamilyNoise(cmd)
    ) {
      const prefix = displayPrefix(uid, { platform });
      tip = chooseTip(profile, {
        scoreMeta: { ...scoreMeta, fromLevel },
        command: cmd,
        role,
        prefix,
        isGroup,
        telegramUserId: uid
      });
    }

    if (tip?.text) {
      const lvl = scoreMeta?.level?.name || profile.level || '?';
      logger.logInfo(
        `[evolution] tip=${tip.kind}/${tip.variant || '-'} cmd=${cmd} xp+${scoreMeta?.xpDelta || 0} ` +
        `level=${lvl} ${String(tip.text).replace(/\s+/g, ' ').slice(0, 140)}`
      );
    } else if (scoreMeta?.leveledUp) {
      logger.logInfo(
        `[evolution] level_up cmd=${cmd} xp+${scoreMeta?.xpDelta || 0} ` +
        `level=${scoreMeta?.level?.name || profile.level || '?'}`
      );
    }

    markDirtyProfile(profile);
    return { profile, scoreMeta, tip, converted, convertMeta };
  } catch (e) {
    try {
      logger.logAviso(`[evolution] record fail: ${e.message}`);
    } catch (_) { /* */ }
    return null;
  }
}

function hasLeaderboard(profile) {
  return Array.isArray(profile?.unlocks) && profile.unlocks.includes('leaderboard');
}

function rateLimitAdjustFor(telegramUserId, sender, command) {
  try {
    const cfg = getEvolutionConfig(telegramUserId);
    if (!cfg.enabled || !cfg.quotasEnabled) {
      return { maxMult: 1, denyCostly: false, reason: null, burst: false, throttle: false };
    }
    const profile = loadProfile(telegramUserId, sender);
    return getRateLimitAdjust(profile, command);
  } catch (_) {
    return { maxMult: 1, denyCostly: false, reason: null, burst: false, throttle: false };
  }
}

module.exports = {
  recordCommandOutcome,
  rateLimitAdjustFor
};
