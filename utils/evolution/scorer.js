// utils/evolution/scorer.js — XP, streak, caps, milestones
'use strict';

const { FAMILY_XP, XP_RULES } = require('./constants');
const { familyOf, normalizeCmd } = require('./classify');
const { applyLevelUnlocks } = require('./levels');
const { markDirtyProfile } = require('./store');

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hourKey(ts = Date.now()) {
  return `${dayKey(ts)}T${new Date(ts).getHours()}`;
}

function pushHistory(profile, entry) {
  if (!Array.isArray(profile.history)) profile.history = [];
  profile.history.push(entry);
  if (profile.history.length > 60) profile.history = profile.history.slice(-60);
}

function bumpCounter(profile, key, n = 1) {
  if (!profile.counters) profile.counters = {};
  profile.counters[key] = (Number(profile.counters[key]) || 0) + n;
}

function applyStreak(profile, now = Date.now()) {
  const today = dayKey(now);
  const last = profile.lastActiveDay;
  let bonus = 0;
  let firstOfDay = false;
  if (last === today) {
    return { bonus, firstOfDay, streakChanged: false };
  }
  firstOfDay = true;
  if (!last) {
    profile.streakDays = 1;
  } else {
    const prev = new Date(`${last}T12:00:00`);
    const cur = new Date(`${today}T12:00:00`);
    const diff = Math.round((cur - prev) / 86400000);
    if (diff === 1) {
      profile.streakDays = Math.min(XP_RULES.streakCap, (Number(profile.streakDays) || 0) + 1);
    } else {
      profile.streakDays = 1;
    }
  }
  profile.lastActiveDay = today;
  bonus = Math.min(XP_RULES.streakCap, profile.streakDays) * Math.floor(XP_RULES.streakDay / 3);
  if (profile.streakDays >= 2) {
    bonus += XP_RULES.streakDay;
  }
  bonus += XP_RULES.firstOfDay;
  return { bonus, firstOfDay, streakChanged: true };
}

function softCapMult(profile, cmd, now = Date.now()) {
  const hk = hourKey(now);
  if (!profile.hourlyCaps) profile.hourlyCaps = {};
  const bucket = profile.hourlyCaps[hk] || {};
  const n = Number(bucket[cmd]) || 0;
  bucket[cmd] = n + 1;
  profile.hourlyCaps[hk] = bucket;
  // prune old hours
  for (const k of Object.keys(profile.hourlyCaps)) {
    if (k < dayKey(now - 86400000)) delete profile.hourlyCaps[k];
  }
  if (n >= XP_RULES.softCapPerCmdPerHour) return XP_RULES.softCapXpMult;
  return 1;
}

/**
 * Aplica evento de comando no profile. Mutates + markDirty.
 * @returns {{ xpDelta, leveledUp, level, unlocksGained, firstOfDay, streakDays }}
 */
function applyCommandScore(profile, {
  command,
  ok = true,
  denied = false,
  family: familyHint = null,
  now = Date.now()
} = {}) {
  const cmd = normalizeCmd(command);
  const family = familyHint || familyOf(cmd);
  const table = FAMILY_XP[family] || FAMILY_XP.other;

  bumpCounter(profile, 'cmds');
  if (denied) {
    // nao conta fail agressivo; so tentou algo restrito
    pushHistory(profile, { t: now, type: 'denied', cmd, xp: 0 });
    markDirtyProfile(profile);
    return {
      xpDelta: 0,
      leveledUp: false,
      level: profile.level,
      unlocksGained: [],
      firstOfDay: false,
      streakDays: profile.streakDays || 0,
      family,
      denied: true
    };
  }

  let xpDelta = ok ? table.ok : table.fail;
  const capMult = softCapMult(profile, cmd, now);
  xpDelta = Math.round(xpDelta * capMult);

  const streak = applyStreak(profile, now);
  xpDelta += streak.bonus;

  // diversidade: nova familia no dia
  if (!profile.families[family]) profile.families[family] = { n: 0, xp: 0, last: 0 };
  const fam = profile.families[family];
  const famDay = dayKey(fam.last || 0);
  if (streak.firstOfDay || famDay !== dayKey(now)) {
    if ((Number(fam.n) || 0) === 0 || famDay !== dayKey(now)) {
      // first hit of this family today
      if ((Number(fam.n) || 0) > 0 && famDay !== dayKey(now)) {
        xpDelta += XP_RULES.diversityBonus;
      } else if ((Number(fam.n) || 0) === 0) {
        xpDelta += XP_RULES.diversityBonus;
      }
    }
  }
  fam.n = (Number(fam.n) || 0) + 1;
  fam.xp = (Number(fam.xp) || 0) + Math.max(0, xpDelta);
  fam.last = now;

  if (!profile.cmdHits[cmd]) profile.cmdHits[cmd] = { ok: 0, fail: 0, last: 0 };
  if (ok) {
    profile.cmdHits[cmd].ok++;
    bumpCounter(profile, 'cmdsOk');
    if (family === 'sticker') bumpCounter(profile, 'sticker');
    if (family === 'download') bumpCounter(profile, 'downloadOk');
    if (family === 'consulta') bumpCounter(profile, 'consulta');
    if (family === 'ia') bumpCounter(profile, 'ia');
    if (family === 'protecao') bumpCounter(profile, 'protecao');
    if (family === 'canal') bumpCounter(profile, 'canal');
    if (family === 'div') bumpCounter(profile, 'div');
    profile.quotas.failStreak = 0;
  } else {
    profile.cmdHits[cmd].fail++;
    bumpCounter(profile, 'cmdsFail');
    if (family === 'download') bumpCounter(profile, 'downloadFail');
    profile.quotas.failStreak = (Number(profile.quotas.failStreak) || 0) + 1;
    if (profile.quotas.failStreak > 0 && profile.quotas.failStreak % 3 === 0) {
      xpDelta += XP_RULES.failStreakPenalty;
    }
  }
  profile.cmdHits[cmd].last = now;

  // trim cmdHits
  const keys = Object.keys(profile.cmdHits);
  if (keys.length > 80) {
    keys.sort((a, b) => (profile.cmdHits[a].last || 0) - (profile.cmdHits[b].last || 0));
    for (const k of keys.slice(0, keys.length - 80)) delete profile.cmdHits[k];
  }

  profile.xp = Math.max(0, (Number(profile.xp) || 0) + xpDelta);
  const lvl = applyLevelUnlocks(profile);
  if (lvl.leveledUp) {
    profile.xp += XP_RULES.levelUpBonus;
    xpDelta += XP_RULES.levelUpBonus;
    profile.milestones.push({
      t: now,
      type: 'level_up',
      from: lvl.from,
      to: lvl.level.id,
      name: lvl.level.name
    });
    if (profile.milestones.length > 40) profile.milestones = profile.milestones.slice(-40);
  }

  pushHistory(profile, {
    t: now,
    type: ok ? 'ok' : 'fail',
    cmd,
    family,
    xp: xpDelta
  });

  markDirtyProfile(profile);
  return {
    xpDelta,
    leveledUp: !!lvl.leveledUp,
    level: lvl.level,
    unlocksGained: lvl.gained || [],
    firstOfDay: streak.firstOfDay,
    streakDays: profile.streakDays || 0,
    family,
    denied: false
  };
}

function applyConversionBonus(profile, kind, now = Date.now()) {
  const bonus = XP_RULES.conversionBonus;
  profile.xp = (Number(profile.xp) || 0) + bonus;
  bumpCounter(profile, 'tipsConverted');
  profile.ab.conversions = (Number(profile.ab.conversions) || 0) + 1;
  const lvl = applyLevelUnlocks(profile);
  pushHistory(profile, { t: now, type: 'convert', kind, xp: bonus });
  markDirtyProfile(profile);
  return { bonus, leveledUp: lvl.leveledUp, level: lvl.level };
}

module.exports = {
  dayKey,
  hourKey,
  applyCommandScore,
  applyConversionBonus,
  applyStreak
};
