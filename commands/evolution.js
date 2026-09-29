// commands/evolution.js — .nivel / .evolucao / .rank / painel dono
'use strict';

const { stripAccents, previewText } = require('../utils/typography');
const { prefixFromCtx, getEvolutionConfig, updateEvolution } = require('../utils/configManager');
const evo = require('../utils/evolution');

const commands = {};

function reply(conn, ctx, text) {
  const from = ctx.from || ctx.info?.key?.remoteJid;
  if (!from) return Promise.resolve();
  return conn.sendMessage(from, { text: stripAccents(text) }, { quoted: ctx.info || null });
}

function uidOf(ctx) {
  return String(ctx.telegramUserId || ctx.conn?._telegramUserId || '');
}

function senderOf(ctx) {
  return ctx.sender || ctx.info?.key?.participant || ctx.from || '';
}

commands.nivel = {
  useCtx: true,
  description: 'Seu nivel de evolucao (XP / streak)',
  usage: 'nivel',
  execute: async (conn, ctx) => {
    const uid = uidOf(ctx);
    const cfg = getEvolutionConfig(uid);
    if (!cfg.enabled) return reply(conn, ctx, 'Evolucao desligada nesta sessao.');
    const profile = evo.getProfile(uid, senderOf(ctx));
    const p = prefixFromCtx(ctx) || '.';
    return reply(conn, ctx, evo.levels.formatLevelCard(profile, p));
  }
};

commands.evolucao = {
  useCtx: true,
  description: 'Painel completo de evolucao (familias, burst, reco)',
  usage: 'evolucao',
  execute: async (conn, ctx) => {
    const uid = uidOf(ctx);
    const cfg = getEvolutionConfig(uid);
    if (!cfg.enabled) return reply(conn, ctx, 'Evolucao desligada nesta sessao.');
    const profile = evo.getProfile(uid, senderOf(ctx));
    const p = prefixFromCtx(ctx) || '.';
    return reply(conn, ctx, evo.formatEvolutionReport(profile, uid, p));
  }
};
commands.evo = commands.evolucao;

commands.desbloqueios = {
  useCtx: true,
  description: 'Lista desbloqueios do seu nivel',
  usage: 'desbloqueios',
  execute: async (conn, ctx) => {
    const uid = uidOf(ctx);
    const profile = evo.getProfile(uid, senderOf(ctx));
    const p = prefixFromCtx(ctx) || '.';
    return reply(conn, ctx, evo.formatUnlocks(profile, p));
  }
};

commands.rank = {
  useCtx: true,
  description: 'Leaderboard de evolucao da sessao',
  usage: 'rank',
  execute: async (conn, ctx) => {
    const uid = uidOf(ctx);
    const profile = evo.getProfile(uid, senderOf(ctx));
    if (!evo.levels.hasUnlock(profile, 'leaderboard') && !ctx.isOwner && !ctx.isVip) {
      const p = prefixFromCtx(ctx) || '.';
      return reply(
        conn,
        ctx,
        `Leaderboard libera no nivel Floresta.\nSeu nivel: ${profile.level} · ${p}nivel`
      );
    }
    const p = prefixFromCtx(ctx) || '.';
    return reply(conn, ctx, evo.formatLeaderboard(uid, p));
  }
};
commands.ranking = commands.rank;
commands.evoleader = commands.rank;

commands.evoadmin = {
  useCtx: true,
  description: 'Painel A/B tips + top cmds (dono)',
  usage: 'evoadmin',
  execute: async (conn, ctx) => {
    if (!ctx.isOwner) return reply(conn, ctx, 'Apenas dono.');
    const uid = uidOf(ctx);
    return reply(conn, ctx, evo.formatAdmin(uid));
  }
};

commands.evoreset = {
  useCtx: true,
  description: 'Reseta evolucao de um JID (dono) — evoreset <jid|me>',
  usage: 'evoreset <jid|me>',
  execute: async (conn, ctx) => {
    if (!ctx.isOwner) return reply(conn, ctx, 'Apenas dono.');
    const uid = uidOf(ctx);
    const arg = String(ctx.args?.[0] || '').trim().toLowerCase();
    if (!arg) return reply(conn, ctx, `Uso: ${prefixFromCtx(ctx)}evoreset me|<jid>`);
    const target = arg === 'me' ? senderOf(ctx) : arg;
    evo.resetProfile(uid, target);
    return reply(conn, ctx, `Evolucao resetada: ${String(target).slice(0, 32)}`);
  }
};

commands.evoconfig = {
  useCtx: true,
  description: 'Liga/desliga motor de evolucao (dono)',
  usage: 'evoconfig on|off|tips on|off|quotas on|off|status',
  execute: async (conn, ctx) => {
    if (!ctx.isOwner) return reply(conn, ctx, 'Apenas dono.');
    const uid = uidOf(ctx);
    const a0 = String(ctx.args?.[0] || '').toLowerCase();
    const a1 = String(ctx.args?.[1] || '').toLowerCase();
    const p = prefixFromCtx(ctx) || '.';

    if (!a0 || a0 === 'status') {
      const c = getEvolutionConfig(uid);
      return reply(
        conn,
        ctx,
        previewText(
          `EVO CONFIG\nenabled=${c.enabled}\ntips=${c.tipsEnabled}\nquotas=${c.quotasEnabled}\nreorderMenu=${c.reorderMenu}\n\n${p}evoconfig on|off\n${p}evoconfig tips on|off\n${p}evoconfig quotas on|off`
        )
      );
    }

    if (a0 === 'on' || a0 === 'off') {
      updateEvolution(uid, { enabled: a0 === 'on' });
      return reply(conn, ctx, `Evolucao ${a0}.`);
    }
    if (a0 === 'tips' && (a1 === 'on' || a1 === 'off')) {
      updateEvolution(uid, { tipsEnabled: a1 === 'on' });
      return reply(conn, ctx, `Tips evolucao ${a1}.`);
    }
    if (a0 === 'quotas' && (a1 === 'on' || a1 === 'off')) {
      updateEvolution(uid, { quotasEnabled: a1 === 'on' });
      return reply(conn, ctx, `Quotas evolucao ${a1}.`);
    }
    return reply(conn, ctx, `Uso: ${p}evoconfig on|off|tips on|off|quotas on|off|status`);
  }
};

module.exports = { commands };
