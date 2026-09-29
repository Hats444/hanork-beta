// utils/evolution/levels.js
'use strict';

const { LEVELS } = require('./constants');

function levelFromXp(xp) {
  const n = Math.max(0, Number(xp) || 0);
  let cur = LEVELS[0];
  for (const lv of LEVELS) {
    if (n >= lv.xp) cur = lv;
  }
  return cur;
}

function nextLevel(levelId) {
  const id = Number(levelId) || 1;
  return LEVELS.find((l) => l.id === id + 1) || null;
}

function progressToNext(xp) {
  const cur = levelFromXp(xp);
  const nxt = nextLevel(cur.id);
  if (!nxt) {
    return { cur, nxt: null, pct: 100, need: 0, have: Number(xp) || 0 };
  }
  const span = nxt.xp - cur.xp;
  const have = Math.max(0, (Number(xp) || 0) - cur.xp);
  const pct = span > 0 ? Math.min(100, Math.round((have / span) * 100)) : 100;
  return { cur, nxt, pct, need: Math.max(0, nxt.xp - (Number(xp) || 0)), have };
}

function hasUnlock(profile, unlockId) {
  return Array.isArray(profile?.unlocks) && profile.unlocks.includes(unlockId);
}

function applyLevelUnlocks(profile) {
  const lv = levelFromXp(profile.xp);
  const gained = [];
  for (const L of LEVELS) {
    if (L.id > lv.id) break;
    for (const u of L.unlocks) {
      if (!profile.unlocks.includes(u)) {
        profile.unlocks.push(u);
        gained.push(u);
      }
    }
  }
  const prev = Number(profile.level) || 1;
  profile.level = lv.id;
  return { level: lv, leveledUp: lv.id > prev, from: prev, gained };
}

function formatLevelCard(profile, prefix = '.') {
  const p = prefix || '.';
  const prog = progressToNext(profile.xp);
  const barLen = 10;
  const filled = Math.round((prog.pct / 100) * barLen);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(barLen - filled)}`;
  const lines = [
    `NIVEL ${prog.cur.id} — ${prog.cur.name}`,
    `XP ${profile.xp}${prog.nxt ? ` · prox ${prog.nxt.name} (${prog.need} xp)` : ' · MAX'}`,
    `[${bar}] ${prog.pct}%`,
    `Streak ${profile.streakDays || 0}d · cmds ok ${profile.counters?.cmdsOk || 0}`,
    `Desbloqueios: ${p}desbloqueios · detalhe: ${p}evolucao`
  ];
  return lines.join('\n');
}

module.exports = {
  LEVELS,
  levelFromXp,
  nextLevel,
  progressToNext,
  hasUnlock,
  applyLevelUnlocks,
  formatLevelCard
};
