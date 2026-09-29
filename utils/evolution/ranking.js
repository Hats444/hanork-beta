// utils/evolution/ranking.js — popularidade de cmds + leaderboard sessao
'use strict';

const { normalizeCmd, familyOf } = require('./classify');
const { loadSessionRank, markDirtyRank, listCachedProfilesForSession } = require('./store');

function bumpCmdRank(telegramUserId, command, { ok = true } = {}) {
  const cmd = normalizeCmd(command);
  if (!cmd) return null;
  const rank = loadSessionRank(telegramUserId);
  if (!rank.cmds[cmd]) {
    rank.cmds[cmd] = { uses: 0, ok: 0, fail: 0, family: familyOf(cmd), last: 0 };
  }
  const row = rank.cmds[cmd];
  row.uses++;
  if (ok) row.ok++;
  else row.fail++;
  row.last = Date.now();
  row.family = familyOf(cmd);

  // trim
  const keys = Object.keys(rank.cmds);
  if (keys.length > 200) {
    keys.sort((a, b) => (rank.cmds[a].last || 0) - (rank.cmds[b].last || 0));
    for (const k of keys.slice(0, keys.length - 200)) delete rank.cmds[k];
  }

  markDirtyRank(rank);
  return rank;
}

function scoreCmd(row) {
  const uses = Number(row?.uses) || 0;
  const ok = Number(row?.ok) || 0;
  const fail = Number(row?.fail) || 0;
  const ratio = uses ? ok / uses : 0;
  // retencao: sucesso pesa mais; fail recente puxa pra baixo
  return uses * (0.55 + 0.45 * ratio) - fail * 0.35;
}

function topCommands(telegramUserId, limit = 8, { family = null, minUses = 2 } = {}) {
  const rank = loadSessionRank(telegramUserId);
  let entries = Object.entries(rank.cmds || {});
  if (family) entries = entries.filter(([, r]) => r.family === family);
  entries = entries
    .filter(([, r]) => (Number(r.uses) || 0) >= minUses)
    .map(([cmd, r]) => ({ cmd, ...r, score: scoreCmd(r) }))
    .sort((a, b) => b.score - a.score);
  return entries.slice(0, limit);
}

function recommendForProfile(profile, telegramUserId, limit = 3) {
  const used = new Set(Object.keys(profile?.cmdHits || {}));
  const famCounts = profile?.families || {};
  const topFam = Object.entries(famCounts)
    .sort((a, b) => (b[1]?.n || 0) - (a[1]?.n || 0))
    .map(([f]) => f)[0] || null;

  const pool = topCommands(telegramUserId, 20, { minUses: 1 });
  const out = [];
  for (const row of pool) {
    if (used.has(row.cmd)) continue;
    if (topFam && row.family !== topFam && out.length === 0) {
      // prefer same family first
      continue;
    }
    out.push(row.cmd);
    if (out.length >= limit) break;
  }
  if (out.length < limit) {
    for (const row of pool) {
      if (out.includes(row.cmd)) continue;
      out.push(row.cmd);
      if (out.length >= limit) break;
    }
  }
  // defaults se sessao fria
  while (out.length < limit) {
    for (const d of ['play', 's', 'menu', 'google', 'hanork']) {
      if (!out.includes(d)) out.push(d);
      if (out.length >= limit) break;
    }
    break;
  }
  return out.slice(0, limit);
}

function updateLeaderboard(telegramUserId, profile) {
  const rank = loadSessionRank(telegramUserId);
  const entry = {
    sender: profile.sender,
    xp: profile.xp,
    level: profile.level,
    streak: profile.streakDays || 0,
    updatedAt: Date.now()
  };
  const list = Array.isArray(rank.topUsers) ? rank.topUsers.filter((u) => u.sender !== profile.sender) : [];
  list.push(entry);
  list.sort((a, b) => (b.xp || 0) - (a.xp || 0));
  rank.topUsers = list.slice(0, 15);
  markDirtyRank(rank);
  return rank.topUsers;
}

function leaderboard(telegramUserId, limit = 10) {
  const rank = loadSessionRank(telegramUserId);
  // merge cache profiles (mais fresco)
  const cached = listCachedProfilesForSession(telegramUserId).map((p) => ({
    sender: p.sender,
    xp: p.xp,
    level: p.level,
    streak: p.streakDays || 0
  }));
  const map = new Map();
  for (const u of rank.topUsers || []) map.set(u.sender, u);
  for (const u of cached) {
    const prev = map.get(u.sender);
    if (!prev || (u.xp || 0) >= (prev.xp || 0)) map.set(u.sender, u);
  }
  return [...map.values()].sort((a, b) => (b.xp || 0) - (a.xp || 0)).slice(0, limit);
}

function bumpTipStat(telegramUserId, tipKey, field = 'shown') {
  const rank = loadSessionRank(telegramUserId);
  if (!rank.tipStats[tipKey]) rank.tipStats[tipKey] = { shown: 0, converted: 0 };
  rank.tipStats[tipKey][field] = (Number(rank.tipStats[tipKey][field]) || 0) + 1;
  markDirtyRank(rank);
}

function tipConversionRates(telegramUserId) {
  const rank = loadSessionRank(telegramUserId);
  const out = [];
  for (const [k, v] of Object.entries(rank.tipStats || {})) {
    const shown = Number(v.shown) || 0;
    const converted = Number(v.converted) || 0;
    out.push({
      key: k,
      shown,
      converted,
      rate: shown ? converted / shown : 0
    });
  }
  return out.sort((a, b) => b.rate - a.rate || b.shown - a.shown);
}

module.exports = {
  bumpCmdRank,
  topCommands,
  recommendForProfile,
  updateLeaderboard,
  leaderboard,
  bumpTipStat,
  tipConversionRates,
  scoreCmd
};
