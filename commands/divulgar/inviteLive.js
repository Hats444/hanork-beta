'use strict';
/**
 * .divulgar — atalho ADM pro painel DIV unico (CTA+Status #1/#2 + link vivo).
 * Nao e um sistema paralelo: abre os mesmos botoes de config/status/CTA.
 */
const { requireSessionOwner } = require('../../utils/authorization');
const { isAdmin } = require('../../utils/userManager');
const {
  showSlotsPanel,
  showStatusPanel,
  showCtaPanel,
  handleInvitePanelAction
} = require('./config');

async function cmdDivulgar(conn, ctx) {
  if (!(await requireSessionOwner(conn, ctx))) return;
  if (!isAdmin(String(ctx.telegramUserId || ''))) {
    const { sendDivulgacaoMessage } = require('../../utils/divulgacaoReply');
    return sendDivulgacaoMessage(conn, ctx, {
      text: 'So ADMIN Telegram — use o menu de divulgacao normal.'
    }, { quoted: ctx.info });
  }

  const args = (ctx.args || []).map((a) => String(a || '').toLowerCase());
  const sub = args[0] || '';

  if (sub === 'setgrupo' || sub === 'setgroup') {
    ctx.args = args.slice(1);
    return handleInvitePanelAction(conn, ctx, 'setgrupo');
  }
  if (sub === 'status') {
    if (args[1] === 'preview') return handleInvitePanelAction(conn, ctx, 'preview_status');
    if (args[1] === 'tpl' || args[1] === 'aplicar') return handleInvitePanelAction(conn, ctx, 'tpl_status');
    return showStatusPanel(conn, ctx, 'Painel status (botoes). Link vivo = {{groupInviteLink}}.');
  }
  if (sub === 'cta') {
    if (args[1] === 'preview') return handleInvitePanelAction(conn, ctx, 'preview_cta');
    if (args[1] === 'tpl' || args[1] === 'aplicar') return handleInvitePanelAction(conn, ctx, 'tpl_cta');
    return showCtaPanel(conn, ctx, 'Painel CTA (botoes). Use Texto+link grupo se quiser o padrao.');
  }
  if (sub === 'grupo' || sub === 'vergrupo') {
    const { resolveInviteGroupJid } = require('../../utils/divulgacaoInviteLink');
    const { sendDivulgacaoMessage } = require('../../utils/divulgacaoReply');
    const jid = resolveInviteGroupJid({ telegramUserId: ctx.telegramUserId });
    return sendDivulgacaoMessage(conn, ctx, {
      text: jid
        ? `Grupo do convite: ${jid}\n\nTrocar: no grupo oficial toque \"Grupo do convite\" no painel.`
        : 'Nenhum grupo. No grupo oficial: CTA + Status → Grupo do convite.'
    }, { quoted: ctx.info });
  }

  return showSlotsPanel(
    conn,
    ctx,
    'Padroes CTA+Status — editar/midia/enviar/auto no mesmo menu.'
  );
}

const commands = {
  divulgar: {
    useCtx: true,
    description: 'ADM: atalho pro menu unico CTA+Status / link vivo',
    usage: 'divulgar [cta|status|setgrupo]',
    execute: cmdDivulgar
  }
};

module.exports = { commands, cmdDivulgar };
