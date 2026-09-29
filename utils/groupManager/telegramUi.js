'use strict';

const gm = require('./index');
const logger = require('../../logger');

function keyboard(snap) {
  const pauseBtn = snap.paused
    ? { text: 'Continuar', callback_data: 'gm_resume' }
    : { text: 'Pausar', callback_data: 'gm_pause' };
  return [
    [
      { text: 'Entrar em 1', callback_data: 'gm_join_1' },
      { text: 'Entrar em 5', callback_data: 'gm_join_5' }
    ],
    [
      { text: 'Entrar em 10', callback_data: 'gm_join_10' },
      { text: 'Entrar em 25', callback_data: 'gm_join_25' }
    ],
    [{ text: 'Maximo possivel', callback_data: 'gm_join_max' }],
    [
      { text: 'Ver fila', callback_data: 'gm_queue' },
      { text: 'Grupos ativos', callback_data: 'gm_active' }
    ],
    [
      { text: 'Limites', callback_data: 'gm_limits' },
      { text: 'Historico', callback_data: 'gm_hist' }
    ],
    [
      { text: 'Sair de 1', callback_data: 'gm_leave_1' },
      { text: 'Sair de 5', callback_data: 'gm_leave_5' },
      { text: 'Sair de 10', callback_data: 'gm_leave_10' }
    ],
    [pauseBtn, { text: 'Atualizar', callback_data: 'gm_home' }],
    [
      { text: 'Voltar', callback_data: 'menu_divulgacao' },
      { text: 'Fechar', callback_data: 'close' }
    ]
  ];
}

function queueKeyboard(snap) {
  const pauseBtn = snap.paused
    ? { text: 'Continuar', callback_data: 'gm_resume' }
    : { text: 'Pausar', callback_data: 'gm_pause' };
  return [
    [{ text: 'Entrar em 10', callback_data: 'gm_join_10' }],
    [
      { text: 'Reprocessar falhos', callback_data: 'gm_reprocess' },
      { text: 'Limpar invalidos', callback_data: 'gm_clear' }
    ],
    [pauseBtn, { text: 'Atualizar', callback_data: 'gm_queue' }],
    [{ text: 'Voltar', callback_data: 'gm_home' }]
  ];
}

function limitsKeyboard(snap) {
  const presets = gm.OCCUPANCY_PRESETS || [10, 25, 50, 100, 200];
  const row1 = presets.slice(0, 3).map((n) => ({ text: `Max ${n}`, callback_data: `gm_lim_${n}` }));
  const row2 = presets.slice(3).map((n) => ({ text: `Max ${n}`, callback_data: `gm_lim_${n}` }));
  const autoOn = !!(snap && snap.limits && snap.limits.autoRefill === true);
  return [
    row1,
    row2,
    [{
      text: autoOn ? 'Auto-repor: ON' : 'Auto-repor: OFF',
      callback_data: autoOn ? 'gm_auto_off' : 'gm_auto_on'
    }],
    [{ text: 'Voltar', callback_data: 'gm_home' }]
  ];
}

function activeKeyboard(page, pages) {
  const row = [];
  if (page > 1) row.push({ text: 'Anterior', callback_data: `gm_ap_${page - 1}` });
  if (page < pages) row.push({ text: 'Proxima', callback_data: `gm_ap_${page + 1}` });
  const kb = [];
  if (row.length) kb.push(row);
  kb.push([{ text: 'Voltar', callback_data: 'gm_home' }]);
  return kb;
}

async function sendOrEdit(bot, chatId, text, kb, editMsgId) {
  const opts = { reply_markup: { inline_keyboard: kb } };
  if (editMsgId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts });
      return;
    } catch (_) { /* nova msg */ }
  }
  await bot.sendMessage(chatId, text, opts);
}

async function sendPanel(bot, chatId, userId, editMsgId) {
  const snap = await gm.snapshot(String(userId));
  await sendOrEdit(bot, chatId, gm.panelText(snap), keyboard(snap), editMsgId);
}

function parseJoinN(id) {
  if (id === 'gm_join_max') return 'max';
  const m = String(id).match(/^gm_join_(\d+)$/);
  return m ? Number(m[1]) : 1;
}

async function handleCallback(bot, { chatId, userId, data, messageId }) {
  const uid = String(userId);
  const id = String(data || '');
  const editId = messageId;

  if (id === 'gm_home' || id === 'menu_grupos') {
    await sendPanel(bot, chatId, uid, editId);
    return true;
  }
  if (id === 'gm_queue') {
    const snap = await gm.snapshot(uid);
    await sendOrEdit(bot, chatId, gm.queueText(snap), queueKeyboard(snap), editId);
    return true;
  }
  if (id === 'gm_limits') {
    const snap = await gm.snapshot(uid);
    await sendOrEdit(bot, chatId, gm.limitsText(snap), limitsKeyboard(snap), editId);
    return true;
  }
  if (id.startsWith('gm_lim_')) {
    const n = parseInt(id.slice(7), 10);
    if (Number.isFinite(n) && n >= 1) {
      gm.saveLimits(uid, { maxTotalGroups: n });
    }
    const snap = await gm.snapshot(uid);
    await sendOrEdit(
      bot,
      chatId,
      `Teto gravado: ${snap.maxTotal} grupos.\nTeto = para de entrar. Nao sai dos grupos sozinho.` +
      (snap.limits.autoRefill === true
        ? ' Em falta: completa sozinho (auto-repor ON).'
        : ' Auto-repor OFF: nao entra sozinho.') +
      `\n\n` + gm.limitsText(snap),
      limitsKeyboard(snap),
      editId
    );
    return true;
  }
  if (id === 'gm_auto_on' || id === 'gm_auto_off') {
    gm.saveLimits(uid, { autoRefill: id === 'gm_auto_on' });
    if (id === 'gm_auto_on') setImmediate(() => { gm.maintainOccupancy(uid).catch(() => {}); });
    const snap = await gm.snapshot(uid);
    await sendOrEdit(bot, chatId, gm.limitsText(snap), limitsKeyboard(snap), editId);
    return true;
  }
  if (id === 'gm_hist') {
    const snap = await gm.snapshot(uid);
    const text = [
      'HISTORICO',
      '',
      `Ultima entrada: ${snap.lastJoinLabel}`,
      `Entradas hoje: ${snap.joinsToday}/${snap.maxJoins}`,
      `Saidas hoje: ${snap.leavesToday}/${snap.maxLeaves}`,
      `Entraram: ${snap.joined + snap.alreadyMember}`,
      `Falhos: ${snap.failed}`
    ].join('\n');
    await sendOrEdit(bot, chatId, text, [[{ text: 'Voltar', callback_data: 'gm_home' }]], editId);
    return true;
  }
  if (id === 'gm_active' || id.startsWith('gm_ap_')) {
    const page = id.startsWith('gm_ap_') ? parseInt(id.slice(6), 10) || 1 : 1;
    const snap = await gm.snapshot(uid);
    const pack = gm.activePage(snap, page);
    await sendOrEdit(bot, chatId, pack.text, activeKeyboard(pack.page, pack.pages), editId);
    return true;
  }
  if (id === 'gm_pause') {
    gm.setPaused(uid, true);
    const snap = await gm.snapshot(uid);
    await sendOrEdit(bot, chatId, gm.queueText(snap), queueKeyboard(snap), editId);
    return true;
  }
  if (id === 'gm_resume') {
    gm.setPaused(uid, false);
    const snap = await gm.snapshot(uid);
    await sendOrEdit(bot, chatId, gm.queueText(snap), queueKeyboard(snap), editId);
    return true;
  }
  if (id === 'gm_reprocess') {
    await gm.reprocess(uid);
    const snap = await gm.snapshot(uid);
    await sendOrEdit(bot, chatId, gm.queueText(snap), queueKeyboard(snap), editId);
    return true;
  }
  if (id === 'gm_clear') {
    await gm.clearInvalid(uid);
    const snap = await gm.snapshot(uid);
    await sendOrEdit(bot, chatId, gm.queueText(snap), queueKeyboard(snap), editId);
    return true;
  }
  if (id.startsWith('gm_join_')) {
    const n = parseJoinN(id);
    await sendOrEdit(bot, chatId, `Entrando em ate ${n}...`, [[{ text: 'Atualizar', callback_data: 'gm_home' }]], editId);
    setImmediate(() => {
      let preferredSessionId;
      try {
        const { getLiveConnForUser } = require('../../telegramBot');
        preferredSessionId = getLiveConnForUser(uid)?.sessionId;
      } catch (_) { /* ignore */ }
      gm.joinBatch(uid, n, {
        preferredSessionId,
        manual: true,
        onProgress: async (step, label) => {
          await sendOrEdit(
            bot,
            chatId,
            `GRUPOS\n${step}: ${label}`,
            [[{ text: 'Atualizar', callback_data: 'gm_home' }]],
            editId
          );
        }
      }).then(async (out) => {
        const snap = await gm.snapshot(uid);
        let head = '';
        if (!out.ok && out.reason === 'paused') head = 'Fila pausada.';
        else if (!out.ok && out.reason === 'no-session') head = 'Nenhuma sessao WhatsApp conectada.';
        else if (!out.ok && out.reason === 'auto-off') head = 'Auto-repor OFF. Toque Entrar so quando quiser entrar.';
        else if (!out.ok && out.reason === 'occupancy-unknown') head = 'Nao deu pra contar os grupos no Zap agora.';
        else if (!out.ok && out.reason === 'at-cap') {
          head = `Teto atingido. Grupos: ${out.activeGroups || 0} / ${out.maxTotal || 0}.`;
        } else if (!out.ok) {
          head = `Nada a entrar (pedido ${out.requested || n}, pendentes ${out.pending || 0}).`;
        } else {
          const failN = (out.results || []).filter((r) => !r.ok).length;
          const skipN = out.skipped || failN;
          const skipHint = skipN ? ` Pulou ${skipN} link(s) morto(s) e tentou o proximo.` : '';
          const shortHint = out.done < (out.real || n)
            ? ` Pedido ${out.real || n}, entrou ${out.done} (fila/teto).`
            : '';
          const divN = out.divList != null ? out.divList : snap.ativos;
          head = `Entrou em ${out.done} grupo(s).${skipHint}${shortHint}\nLista DIV: ${divN}.`;
        }
        await sendOrEdit(bot, chatId, `${head}\n\n${gm.panelText(snap)}`, keyboard(snap), editId);
      }).catch((e) => {
        logger.logAviso(`[gm-tg] join: ${e.message}`);
        sendOrEdit(bot, chatId, `Erro: ${String(e.message || e).slice(0, 160)}`, [[{ text: 'Voltar', callback_data: 'gm_home' }]], editId).catch(() => {});
      });
    });
    return true;
  }
  if (id === 'gm_leave_1' || id === 'gm_leave_5' || id === 'gm_leave_10') {
    const n = Number(id.replace('gm_leave_', '')) || 1;
    const prep = await gm.prepareLeave(uid, n);
    if (!prep.real) {
      await sendOrEdit(bot, chatId, 'Nada para sair (lista vazia ou limite diario).', [[{ text: 'Voltar', callback_data: 'gm_home' }]], editId);
      return true;
    }
    const preview = prep.jids.slice(0, 5).join('\n');
    const extra = prep.jids.length > 5 ? `\n+${prep.jids.length - 5} grupos` : '';
    await sendOrEdit(
      bot,
      chatId,
      `Voce esta prestes a sair de ${prep.real} grupo(s).\n\n${preview}${extra}`,
      [[
        { text: 'Confirmar', callback_data: 'gm_leave_ok' },
        { text: 'Cancelar', callback_data: 'gm_leave_no' }
      ]],
      editId
    );
    return true;
  }
  if (id === 'gm_leave_no') {
    gm.clearPendingLeave(uid);
    await sendPanel(bot, chatId, uid, editId);
    return true;
  }
  if (id === 'gm_leave_ok') {
    await sendOrEdit(bot, chatId, 'Saindo...', [[{ text: 'Atualizar', callback_data: 'gm_home' }]], editId);
    setImmediate(() => {
      gm.confirmLeave(uid, {
        onProgress: async (step, label) => {
          sendOrEdit(bot, chatId, `GRUPOS\n${step}: ${label}`, [[{ text: 'Atualizar', callback_data: 'gm_home' }]], editId).catch(() => {});
        }
      }).then(async (out) => {
        const snap = await gm.snapshot(uid);
        const head = out.ok ? `Saiu de ${out.done} grupo(s).` : 'Confirmacao expirou. Peca a saida de novo.';
        await sendOrEdit(bot, chatId, `${head}\n\n${gm.panelText(snap)}`, keyboard(snap), editId);
      }).catch((e) => {
        sendOrEdit(bot, chatId, `Erro: ${String(e.message || e).slice(0, 160)}`, [[{ text: 'Voltar', callback_data: 'gm_home' }]], editId).catch(() => {});
      });
    });
    return true;
  }
  return false;
}

module.exports = {
  keyboard,
  sendPanel,
  handleCallback
};
