'use strict';
/**
 * Fase 2: bantmp, autoaceitar, x9config, agenda pontual, bloquearcmd,
 * convidar, saigps, msgantipv.
 */

const { previewText } = require('../utils/typography');
const { prefixFromCtx } = require('../utils/configManager');
const store = require('../utils/groupModStore');
const {
  getGroupSecurity,
  resolveTargetJid,
  isKickableJid
} = require('../utils/moderation');

const commands = {};

function pfx(ctx) {
  try { return prefixFromCtx(ctx) || '.'; } catch (_) { return '.'; }
}

async function reply(conn, ctx, text) {
  const dest = ctx.from || ctx.chatId || '';
  if (!dest) return;
  await conn.sendMessage(dest, { text: previewText(text) }, ctx.info ? { quoted: ctx.info } : undefined);
}

async function needAdm(conn, ctx) {
  const { needOwnerGroup } = require('./groupsecurity');
  if (typeof needOwnerGroup === 'function') {
    return needOwnerGroup(conn, ctx);
  }
  try {
    const { isFreshSessionOwner } = require('../utils/authorization');
    if (isFreshSessionOwner(ctx)) return true;
  } catch (_) {
    if (ctx.isOwner) return true;
  }
  await reply(conn, ctx, 'Apenas o dono da sessao ou um admin deste grupo.');
  return false;
}

function needDono(conn, ctx) {
  try {
    const { isFreshSessionOwner } = require('../utils/authorization');
    if (isFreshSessionOwner(ctx)) {
      ctx.isOwner = true;
      return true;
    }
  } catch (_) {
    if (ctx.isOwner) return true;
  }
  reply(conn, ctx, 'Apenas o dono da sessao.');
  return false;
}

async function denyTarget(conn, ctx, jid) {
  try {
    const { checkTargetActionLive } = require('../utils/permissionEngine');
    const r = await checkTargetActionLive(conn, ctx, jid);
    if (!r.allowed) {
      await reply(conn, ctx, 'Nao posso remover dono, VIP ou admin.');
      return true;
    }
  } catch (_) {
    try {
      const { checkTargetAction } = require('../utils/permissionEngine');
      const r = checkTargetAction(conn, ctx, jid);
      if (!r.allowed) {
        await reply(conn, ctx, 'Nao posso remover dono, VIP ou admin.');
        return true;
      }
    } catch (_e) {
      await reply(conn, ctx, 'Nao posso remover dono, VIP ou admin.');
      return true;
    }
  }
  return false;
}

commands.bantmp = {
  useCtx: true,
  description: 'Remove por um tempo e reentra sozinho',
  usage: 'bantmp 1h (responda ou @)',
  execute: async (conn, ctx) => {
    if (!ctx.isGroup) return reply(conn, ctx, 'Use no grupo.');
    if (!(await needAdm(conn, ctx))) return;
    const tokens = String(ctx.text || (ctx.args || []).join(' ') || '').trim().split(/\s+/).filter(Boolean);
    let durRaw = '';
    const rest = [];
    for (const tok of tokens) {
      if (!durRaw && store.parseDurationMs(tok) > 0) durRaw = tok;
      else rest.push(tok);
    }
    if (!durRaw) {
      return reply(conn, ctx, `Uso: ${pfx(ctx)}bantmp 30m (responda ou marque).\nEx: 10s, 30m, 1h, 2d.`);
    }
    const ms = store.parseDurationMs(durRaw);
    if (ms < 10_000) return reply(conn, ctx, 'Minimo 10 segundos.');
    if (rest.length) {
      ctx.args = rest;
      ctx.text = rest.join(' ');
    }
    const jid = await resolveTargetJid(ctx, conn);
    if (ctx._hanorkTargetImmune) {
      return reply(conn, ctx, 'Nao posso remover dono, VIP ou admin.');
    }
    if (!jid || !isKickableJid(jid)) {
      return reply(conn, ctx, 'Responda a msg ou marque o membro.');
    }
    if (await denyTarget(conn, ctx, jid)) return;
    try {
      await conn.groupParticipantsUpdate(ctx.from, [jid], 'remove');
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const hint = /not-authorized|forbidden|admin/i.test(msg)
        ? 'O bot precisa ser admin deste grupo.'
        : `Falha: ${msg}`;
      return reply(conn, ctx, hint);
    }
    const restoreAt = Date.now() + ms;
    await store.addTempBan(ctx.telegramUserId, ctx.from, jid, restoreAt);
    return reply(
      conn,
      ctx,
      `Removido ate ${store.formatWhen(restoreAt)} (BRT). Depois o bot tenta reentrar.`
    );
  }
};

commands.autoaceitartempo = {
  useCtx: true,
  description: 'Espera entre aceites automaticos',
  usage: 'autoaceitartempo 10s|5m|1h',
  execute: async (conn, ctx) => {
    if (!ctx.isGroup) return reply(conn, ctx, 'Use no grupo.');
    if (!(await needAdm(conn, ctx))) return;
    const raw = String(ctx.text || (ctx.args || [])[0] || '').trim();
    const ms = store.parseDurationMs(raw);
    if (!ms) {
      const rec = await store.getJoinAuto(ctx.telegramUserId, ctx.from);
      return reply(conn, ctx, `Espera atual: ${rec.cooldown_sec}s.\nUso: ${pfx(ctx)}autoaceitartempo 10s`);
    }
    const flags = getGroupSecurity(ctx.from, ctx.telegramUserId);
    if (!flags.autoaceitar) {
      await reply(conn, ctx, `Liga antes: ${pfx(ctx)}autoaceitar on`);
    }
    const sec = Math.max(1, Math.round(ms / 1000));
    await store.setJoinAutoCooldown(ctx.telegramUserId, ctx.from, sec);
    return reply(conn, ctx, `Espera entre aceites: ${sec}s.`);
  }
};
commands.setattacc = commands.autoaceitartempo;

commands.fecharas = {
  useCtx: true,
  description: 'Fecha o grupo num horario (uma vez)',
  usage: 'fecharas 22:00 | fecharas 4h',
  execute: async (conn, ctx) => {
    if (!ctx.isGroup) return reply(conn, ctx, 'Use no grupo.');
    if (!(await needAdm(conn, ctx))) return;
    const spec = store.parseScheduleSpec(String(ctx.text || (ctx.args || []).join(' ') || '').trim());
    if (!spec) {
      return reply(conn, ctx, `Uso: ${pfx(ctx)}fecharas 22:00\nou ${pfx(ctx)}fecharas 4h`);
    }
    const ok = await store.upsertOnceSchedule(ctx.telegramUserId, ctx.from, 'close', spec.fireAt);
    if (!ok) return reply(conn, ctx, 'Horario invalido.');
    return reply(conn, ctx, `Grupo fecha as ${store.formatWhen(spec.fireAt)} (BRT).`);
  }
};

commands.bloquearcmd = {
  useCtx: true,
  description: 'Desliga um comando em toda a sessao',
  usage: 'bloquearcmd <comando>',
  execute: async (conn, ctx) => {
    if (!needDono(conn, ctx)) return;
    const name = store.normCmd(ctx.text || (ctx.args || [])[0] || '');
    if (!name) return reply(conn, ctx, `Uso: ${pfx(ctx)}bloquearcmd play`);
    const r = await store.blockCmd(ctx.telegramUserId, name);
    if (!r.ok) {
      if (r.reason === 'ja') return reply(conn, ctx, `Ja estava desligado: ${name}`);
      return reply(conn, ctx, `Nao da pra desligar esse comando: ${name}`);
    }
    return reply(conn, ctx, `Comando desligado nesta sessao: ${r.cmd}\nDono ainda usa. Lista: ${pfx(ctx)}listablockcmd`);
  }
};
commands.bloquearcomando = commands.bloquearcmd;

commands.desbloquearcmd = {
  useCtx: true,
  description: 'Liga de novo um comando da sessao',
  usage: 'desbloquearcmd <comando>',
  execute: async (conn, ctx) => {
    if (!needDono(conn, ctx)) return;
    const name = store.normCmd(ctx.text || (ctx.args || [])[0] || '');
    if (!name) return reply(conn, ctx, `Uso: ${pfx(ctx)}desbloquearcmd play`);
    const r = await store.unblockCmd(ctx.telegramUserId, name);
    if (!r.ok) return reply(conn, ctx, `Esse comando nao estava desligado: ${name}`);
    return reply(conn, ctx, `Comando ligado de novo: ${r.cmd}`);
  }
};
commands.desbloquearcomando = commands.desbloquearcmd;

commands.listablockcmd = {
  useCtx: true,
  description: 'Lista comandos desligados nesta sessao',
  usage: 'listablockcmd',
  execute: async (conn, ctx) => {
    if (!needDono(conn, ctx)) return;
    const list = await store.listBlockedCmds(ctx.telegramUserId);
    if (!list.length) return reply(conn, ctx, 'Nenhum comando desligado nesta sessao.');
    return reply(conn, ctx, `Comandos desligados:\n${list.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
  }
};
commands.comandosblock = commands.listablockcmd;

commands.convidar = {
  useCtx: true,
  description: 'Manda o link do grupo no PV da pessoa',
  usage: 'convidar (responda ou @)',
  execute: async (conn, ctx) => {
    if (!ctx.isGroup) return reply(conn, ctx, 'Use no grupo.');
    if (!(await needAdm(conn, ctx))) return;
    const jid = await resolveTargetJid(ctx, conn);
    if (!jid || !isKickableJid(jid)) {
      return reply(conn, ctx, 'Responda a msg ou marque quem vai receber o convite.');
    }
    let code = '';
    try {
      code = await conn.groupInviteCode(ctx.from);
    } catch (e) {
      return reply(conn, ctx, 'Nao peguei o link. O bot precisa ser admin.');
    }
    const link = `https://chat.whatsapp.com/${code}`;
    let subject = '';
    try {
      const { peekGroupMetadata } = require('../utils/groupMetaCache');
      subject = String((peekGroupMetadata(ctx.from) || {}).subject || '').trim();
    } catch (_) { /* */ }
    const txt = subject
      ? `Convite para o grupo ${subject}:\n${link}`
      : `Convite para o grupo:\n${link}`;
    try {
      await conn.sendMessage(jid, { text: txt });
    } catch (e) {
      return reply(conn, ctx, 'Nao consegui mandar no PV (a pessoa precisa ter o bot no Zap).');
    }
    return reply(conn, ctx, 'Convite enviado no privado.');
  }
};

commands.sairgps = {
  useCtx: true,
  description: 'Sai de um grupo da lista (por numero)',
  usage: 'sairgps [n]',
  execute: async (conn, ctx) => {
    if (!needDono(conn, ctx)) return;
    const idx = parseInt(String(ctx.text || (ctx.args || [])[0] || '').trim(), 10);
    let groups = [];
    try {
      const { peekAllGroupMetas } = require('../utils/groupMetaCache');
      const all = peekAllGroupMetas() || [];
      groups = (Array.isArray(all) ? all : []).filter((g) => g && String(g.id || '').endsWith('@g.us'));
    } catch (_) { /* */ }
    if (!groups.length && typeof conn.groupFetchAllParticipating === 'function') {
      try {
        const all = await conn.groupFetchAllParticipating();
        for (const [id, g] of Object.entries(all || {})) {
          if (String(id).endsWith('@g.us')) groups.push({ id, subject: (g && g.subject) || '' });
        }
      } catch (_) { /* */ }
    }
    if (!groups.length) return reply(conn, ctx, 'Nao achei grupos nesta sessao agora.');
    const cap = groups.slice(0, 40);
    if (!idx || idx < 1) {
      const lines = cap.map((g, i) => {
        const name = String(g.subject || g.id || '').slice(0, 40) || g.id;
        return `${i + 1}. ${name}`;
      });
      const extra = groups.length > cap.length ? `\n… +${groups.length - cap.length}` : '';
      return reply(conn, ctx, `Grupos (use ${pfx(ctx)}sairgps N):\n${lines.join('\n')}${extra}`);
    }
    const target = cap[idx - 1];
    if (!target || !target.id) return reply(conn, ctx, 'Numero invalido.');
    try {
      const uid = ctx.telegramUserId || conn._telegramUserId;
      if (uid) {
        const { retireDeadGroup } = require('../utils/divulgacaoDeadReplace');
        await retireDeadGroup(target.id, uid, 'manual_leave');
      } else {
        await conn.groupLeave(target.id);
      }
      return reply(conn, ctx, `Sai do grupo ${idx}.`);
    } catch (e) {
      return reply(conn, ctx, `Falha ao sair: ${e.message}`);
    }
  }
};

commands.msgantipv = {
  useCtx: true,
  description: 'Texto do aviso de anti-PV (1x)',
  usage: 'msgantipv <texto>|off',
  execute: async (conn, ctx) => {
    if (!needDono(conn, ctx)) return;
    const raw = String(ctx.text || (ctx.args || []).join(' ') || '').trim();
    if (!raw) {
      const cur = await store.getPvNotice(ctx.telegramUserId);
      return reply(
        conn,
        ctx,
        cur
          ? `Aviso atual:\n${cur}\n\nPra voltar o padrao: ${pfx(ctx)}msgantipv off`
          : `Sem texto custom. Uso: ${pfx(ctx)}msgantipv Seu recado`
      );
    }
    if (/^(off|0|padrao|padrão|reset)$/i.test(raw)) {
      await store.setPvNotice(ctx.telegramUserId, '');
      return reply(conn, ctx, 'Aviso do anti-PV voltou ao padrao.');
    }
    const saved = await store.setPvNotice(ctx.telegramUserId, raw);
    return reply(conn, ctx, `Aviso do anti-PV salvo:\n${saved}`);
  }
};

module.exports = { commands, needAdm };
