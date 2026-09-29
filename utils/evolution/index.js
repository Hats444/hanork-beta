// utils/evolution/index.js — API publica
'use strict';

const constants = require('./constants');
const store = require('./store');
const classify = require('./classify');
const levels = require('./levels');
const scorer = require('./scorer');
const quotas = require('./quotas');
const ranking = require('./ranking');
const abTips = require('./abTips');
const upsell = require('./upsell');
const pipeline = require('./pipeline');

function getProfile(telegramUserId, sender) {
  return store.loadProfile(telegramUserId, sender);
}

function formatEvolutionReport(profile, telegramUserId, prefix = '.') {
  const p = prefix || '.';
  const prog = levels.progressToNext(profile.xp);
  const recs = ranking.recommendForProfile(profile, telegramUserId, 3);
  const ratio = quotas.successRatio(profile);
  const q = profile.quotas || {};
  const now = Date.now();
  const burstLeft = Math.max(0, (q.burstUntil || 0) - now);
  const throttleLeft = Math.max(0, (q.throttleUntil || 0) - now);

  const famTop = Object.entries(profile.families || {})
    .sort((a, b) => (b[1]?.n || 0) - (a[1]?.n || 0))
    .slice(0, 5)
    .map(([f, v]) => `${f}:${v.n}`)
    .join(' · ') || '—';

  const lines = [
    'EVOLUCAO HANORK',
    levels.formatLevelCard(profile, p),
    '',
    `Familias: ${famTop}`,
    `Sucesso: ${Math.round(ratio * 100)}% · fail streak ${q.failStreak || 0}`,
    burstLeft > 0
      ? `Burst ativo ${Math.ceil(burstLeft / 60000)}min (x${q.burstMult || 1})`
      : 'Burst: inativo',
    throttleLeft > 0
      ? `Throttle costly ${Math.ceil(throttleLeft / 60000)}min`
      : 'Throttle: ok',
    '',
    `Recomenda: ${recs.map((c) => p + c).join(' · ')}`,
    `A/B seed ${profile.ab?.tipSeed || 'A'} · tips ${profile.counters?.tipsShown || 0}→${profile.counters?.tipsConverted || 0}`,
    '',
    `${p}nivel  ${p}rank  ${p}desbloqueios  ${p}comprar`
  ];
  return lines.join('\n');
}

function formatUnlocks(profile, prefix = '.') {
  const p = prefix || '.';
  const list = (profile.unlocks || []).map((u) => `• ${u}`).join('\n') || '• base';
  return `DESBLOQUEIOS (Nv ${profile.level})\n${list}\n\nDetalhe: ${p}evolucao`;
}

function formatLeaderboard(telegramUserId, prefix = '.') {
  const p = prefix || '.';
  const rows = ranking.leaderboard(telegramUserId, 10);
  if (!rows.length) return `Ranking vazio.\nUse comandos pra pontuar · ${p}evolucao`;
  const lines = ['LEADERBOARD EVOLUCAO'];
  rows.forEach((u, i) => {
    const who = String(u.sender || '').slice(-6) || '?';
    lines.push(`${i + 1}. …${who}  Lv${u.level}  ${u.xp}xp  ${u.streak || 0}d`);
  });
  lines.push('', `Seu progresso: ${p}nivel`);
  return lines.join('\n');
}

function formatAdmin(telegramUserId) {
  const tips = ranking.tipConversionRates(telegramUserId).slice(0, 8);
  const top = ranking.topCommands(telegramUserId, 10, { minUses: 1 });
  const lines = ['EVO ADMIN'];
  lines.push('Tips A/B:');
  if (!tips.length) lines.push('  (sem dados)');
  for (const t of tips) {
    lines.push(`  ${t.key}: ${t.converted}/${t.shown} (${Math.round(t.rate * 100)}%)`);
  }
  lines.push('', 'Top cmds:');
  for (const c of top) {
    lines.push(`  ${c.cmd}: ${c.uses}u ok=${c.ok} fail=${c.fail} s=${c.score.toFixed(1)}`);
  }
  return lines.join('\n');
}

module.exports = {
  ...constants,
  store,
  classify,
  levels,
  scorer,
  quotas,
  ranking,
  abTips,
  upsell,
  recordCommandOutcome: pipeline.recordCommandOutcome,
  rateLimitAdjustFor: pipeline.rateLimitAdjustFor,
  getProfile,
  formatEvolutionReport,
  formatUnlocks,
  formatLeaderboard,
  formatAdmin,
  flush: store.flushDirty,
  resetProfile: store.resetProfile
};
