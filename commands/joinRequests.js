'use strict';
/**
 * Comandos de solicitacao de entrada em grupo.
 * .aceitar | .recusar | .aceitarall | .recusarall | .pedidosentrada
 * Toggle .autoconvite vive em groupsecurity (flag por grupo, igual protecoes).
 */
const {
  refreshJoinAlert,
  approveLatest,
  rejectLatest,
  approveAll,
  rejectAll,
  formatResult,
  resolveGroupJid
} = require('../utils/joinRequestManager');
const {
  isGroupAdminStrict,
  collectMessageSenderIds
} = require('../utils/moderation');
const { cancelStep } = require('../utils/stepHandlers');
const { previewText } = require('../utils/typography');

const commands = {};

async function reply(conn, ctx, text) {
  let dest = '';
  if (typeof ctx === 'object' && ctx) {
    dest = String(ctx.from || resolveGroupJid(ctx) || ctx.sender || '').trim();
  }
  if (!dest || dest === 'undefined' || dest === 'null') return;
  // Baileys jidDecode explode se JID for lixo
  if (!dest.includes('@') && !/^\d{8,}$/.test(dest)) return;
  try {
    await conn.sendMessage(dest, { text }, ctx.info ? { quoted: ctx.info } : undefined);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/forbidden|jidDecode|undefined/i.test(msg)) {
      const logger = require('../logger');
      logger.logAviso(`[joinReq] reply skip: ${msg}`);
      return;
    }
    throw e;
  }
}

async function assertGroupAdmin(conn, ctx) {
  const gid = resolveGroupJid(ctx);
  if (gid && typeof ctx === 'object') ctx.from = gid;
  if (!gid) {
    await reply(conn, ctx, 'Use dentro do grupo.');
    return false;
  }
  if (ctx.isOwner) return true;
  const extra = collectMessageSenderIds(ctx.info || {}, [ctx.senderAlt]);
  const sender = ctx.sender || extra[0];
  const ok = await isGroupAdminStrict(conn, gid, sender, extra);
  if (!ok) {
    try {
      const logger = require('../logger');
      logger.logAviso(`[joinReq] deny role=${ctx.authRole || '?'} vip=${ctx.isVip ? 1 : 0}`);
    } catch (_) { /* ignore */ }
    await reply(conn, ctx, 'Apenas admin do grupo ou dono da sessao.');
    return false;
  }
  return true;
}

commands.aceitar = {
  useCtx: true,
  description: 'Aceita a solicitacao de entrada mais recente',
  usage: 'aceitar',
  execute: async (conn, ctx) => {
    if (!(await assertGroupAdmin(conn, ctx))) return;
    const res = await approveLatest(conn, ctx.from);
    await conn.sendMessage(ctx.from, { text: previewText(formatResult(res)) }, { quoted: ctx.info });
  }
};

commands.recusar = {
  useCtx: true,
  description: 'Recusa a solicitacao de entrada mais recente',
  usage: 'recusar',
  execute: async (conn, ctx) => {
    if (!(await assertGroupAdmin(conn, ctx))) return;
    const res = await rejectLatest(conn, ctx.from);
    await conn.sendMessage(ctx.from, { text: previewText(formatResult(res)) }, { quoted: ctx.info });
  }
};

commands.aceitarall = {
  useCtx: true,
  description: 'Aceita todas as solicitacoes pendentes',
  usage: 'aceitarall',
  execute: async (conn, ctx) => {
    if (!(await assertGroupAdmin(conn, ctx))) return;
    const res = await approveAll(conn, ctx.from);
    await conn.sendMessage(ctx.from, { text: previewText(formatResult(res)) }, { quoted: ctx.info });
  }
};

commands.recusarall = {
  useCtx: true,
  description: 'Recusa todas as solicitacoes pendentes',
  usage: 'recusarall',
  execute: async (conn, ctx) => {
    if (!(await assertGroupAdmin(conn, ctx))) return;
    const res = await rejectAll(conn, ctx.from);
    await conn.sendMessage(ctx.from, { text: previewText(formatResult(res)) }, { quoted: ctx.info });
  }
};

commands.pedidosentrada = {
  useCtx: true,
  description: 'Lista solicitacoes pendentes e atualiza alerta',
  usage: 'pedidosentrada',
  execute: async (conn, ctx) => {
    if (!(await assertGroupAdmin(conn, ctx))) return;
    const r = await refreshJoinAlert(conn, ctx.from, {
      telegramUserId: ctx.telegramUserId,
      sessionId: ctx.sessionId,
      notifyEmpty: true
    });
    if (!r.ok) {
      return conn.sendMessage(ctx.from, { text: `Falha: ${r.error}` }, { quoted: ctx.info });
    }
    if (!r.pending?.length) return;
    await conn.sendMessage(ctx.from, {
      text: previewText(`${r.pending.length} pendente(s) — veja a mensagem com botoes.`)
    }, { quoted: ctx.info });
  }
};

const stepHandlers = {
  async awaiting_join_accept_all(conn, ctx, text) {
    if (!(await assertGroupAdmin(conn, ctx))) {
      cancelStep(ctx);
      return true;
    }
    const t = String(text || '').trim().toLowerCase();
    if (/^(n|nao|não|cancel|cancelar|no)$/i.test(t)) {
      cancelStep(ctx);
      await conn.sendMessage(ctx.from, { text: 'Cancelado.' }, { quoted: ctx.info });
      return true;
    }
    if (!/^(s|sim|yes|ok|confirma|confirmar)$/i.test(t)) {
      await conn.sendMessage(ctx.from, {
        text: 'Responda sim para confirmar ou cancelar.'
      }, { quoted: ctx.info });
      return false;
    }
    cancelStep(ctx);
    const res = await approveAll(conn, ctx.from);
    await conn.sendMessage(ctx.from, { text: previewText(formatResult(res)) }, { quoted: ctx.info });
    return true;
  },
  async awaiting_join_reject_all(conn, ctx, text) {
    if (!(await assertGroupAdmin(conn, ctx))) {
      cancelStep(ctx);
      return true;
    }
    const t = String(text || '').trim().toLowerCase();
    if (/^(n|nao|não|cancel|cancelar|no)$/i.test(t)) {
      cancelStep(ctx);
      await conn.sendMessage(ctx.from, { text: 'Cancelado.' }, { quoted: ctx.info });
      return true;
    }
    if (!/^(s|sim|yes|ok|confirma|confirmar)$/i.test(t)) {
      await conn.sendMessage(ctx.from, {
        text: 'Responda sim para confirmar ou cancelar.'
      }, { quoted: ctx.info });
      return false;
    }
    cancelStep(ctx);
    const res = await rejectAll(conn, ctx.from);
    await conn.sendMessage(ctx.from, { text: previewText(formatResult(res)) }, { quoted: ctx.info });
    return true;
  }
};

/** Clique nos botoes join_* — revalida admin no momento */
async function handleJoinRequestClick(conn, ctx, buttonId) {
  const id = String(buttonId || '').trim();
  if (!/^join_(accept|reject)(_all)?$/i.test(id)) return false;
  if (!(await assertGroupAdmin(conn, ctx))) return true;

  let res;
  if (id === 'join_accept') res = await approveLatest(conn, ctx.from);
  else if (id === 'join_reject') res = await rejectLatest(conn, ctx.from);
  else if (id === 'join_accept_all') res = await approveAll(conn, ctx.from);
  else if (id === 'join_reject_all') res = await rejectAll(conn, ctx.from);

  await conn.sendMessage(ctx.from, { text: previewText(formatResult(res)) }, { quoted: ctx.info });
  return true;
}

module.exports = { commands, stepHandlers, handleJoinRequestClick };
