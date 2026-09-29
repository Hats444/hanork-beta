'use strict';

const { requireSessionOwner } = require('../utils/authorization');
const { prefixFromCtx } = require('../utils/configManager');
const { sendInteractiveList, sendInteractiveButtons } = require('../helpers');
const { formatReportBlock, labelValue } = require('../utils/typography');
const { createWhatsAppStatus } = require('../utils/statusProgress');
const gm = require('../utils/groupManager');
const logger = require('../logger');

const commands = {};

function parseN(raw, fallback = 1) {
  const t = String(raw || '').trim().toLowerCase();
  if (t === 'max' || t === 'maximo' || t === 'máximo') return 'max';
  const n = parseInt(t, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

async function ack(conn, ctx, text) {
  try {
    await conn.sendMessage(ctx.from, { text: String(text).slice(0, 900) }, { quoted: ctx.info, skipForward: true });
  } catch (e) {
    logger.logAviso(`[gm] ack: ${e.message}`);
  }
}

function joinRows() {
  return [
    { id: 'gm_join_1', title: 'Entrar em 1', description: 'lote 1' },
    { id: 'gm_join_5', title: 'Entrar em 5', description: 'lote 5' },
    { id: 'gm_join_10', title: 'Entrar em 10', description: 'lote 10' },
    { id: 'gm_join_25', title: 'Entrar em 25', description: 'lote 25' },
    { id: 'gm_join_max', title: 'Maximo', description: 'capacidade restante' }
  ];
}

function navRows(snap) {
  return [
    { id: 'gm_queue', title: 'Fila', description: `${snap.pending} pendentes` },
    { id: 'gm_active', title: 'Ativos', description: `${snap.ativos} na lista oficial` },
    { id: 'gm_limits', title: 'Limites', description: `${snap.ocupacao} / ${snap.maxTotal}` },
    { id: 'gm_hist', title: 'Historico', description: 'ultima entrada' },
    { id: 'div_grupos_lista', title: 'Lista addgrupo', description: 'grupos marcados no grupo' }
  ];
}

function leaveRows() {
  return [
    { id: 'gm_leave_1', title: 'Sair de 1', description: 'pede confirmacao' },
    { id: 'gm_leave_5', title: 'Sair de 5', description: 'pede confirmacao' },
    { id: 'gm_leave_10', title: 'Sair de 10', description: 'pede confirmacao' }
  ];
}

function markOperator(conn, ctx) {
  try {
    const { rememberPanelOperator } = require('../utils/interactiveClickGuard');
    rememberPanelOperator(conn, ctx.from, ctx.sender);
    if (ctx.senderAlt) rememberPanelOperator(conn, ctx.from, ctx.senderAlt);
  } catch (_) { /* ignore */ }
}

async function showHome(conn, ctx) {
  markOperator(conn, ctx);
  const snap = await gm.snapshot(ctx.telegramUserId);
  const p = prefixFromCtx(ctx);
  const text = gm.panelText(snap) + `\n\n${p}grupoentrar N  ·  ${p}gruposair N`;
  await sendInteractiveList(
    conn,
    ctx.from,
    text,
    [
      { title: 'Entrar', rows: joinRows() },
      { title: 'Ver', rows: navRows(snap) },
      { title: 'Sair', rows: leaveRows() }
    ],
    'so dono',
    ctx.info,
    null,
    ctx.telegramUserId,
    ctx.sessionId,
    {
      listTitle: 'Acoes',
      extraButtons: [
        { id: 'gm_join_1', label: 'Entrar em 1' },
        { id: 'gm_join_5', label: 'Entrar em 5' }
      ]
    }
  );
}

async function showQueue(conn, ctx) {
  markOperator(conn, ctx);
  const snap = await gm.snapshot(ctx.telegramUserId);
  const rows = [
    { id: 'gm_join_10', title: 'Entrar em 10', description: 'lote' },
    { id: 'gm_reprocess', title: 'Reprocessar falhos', description: `${snap.failed} falhos` },
    { id: 'gm_clear', title: 'Limpar invalidos', description: 'expirados/invalidos' },
    snap.paused
      ? { id: 'gm_resume', title: 'Continuar', description: 'retoma a fila' }
      : { id: 'gm_pause', title: 'Pausar', description: 'nao entra mais agora' },
    { id: 'gm_home', title: 'Voltar', description: 'painel' }
  ];
  await sendInteractiveList(
    conn,
    ctx.from,
    gm.queueText(snap),
    [{ title: 'Fila', rows }],
    'so dono',
    ctx.info,
    null,
    ctx.telegramUserId,
    ctx.sessionId,
    { listTitle: 'Fila' }
  );
}

async function showActive(conn, ctx, page) {
  const snap = await gm.snapshot(ctx.telegramUserId);
  const pack = gm.activePage(snap, page);
  const rows = [{ id: 'gm_home', title: 'Voltar', description: 'painel' }];
  if (pack.page > 1) {
    rows.unshift({ id: `gm_ap_${pack.page - 1}`, title: 'Anterior', description: `pag ${pack.page - 1}` });
  }
  if (pack.page < pack.pages) {
    rows.push({ id: `gm_ap_${pack.page + 1}`, title: 'Proxima', description: `pag ${pack.page + 1}` });
  }
  await sendInteractiveList(
    conn,
    ctx.from,
    pack.text,
    [{ title: 'Lista', rows }],
    'so dono',
    ctx.info,
    null,
    ctx.telegramUserId,
    ctx.sessionId,
    { listTitle: 'Ativos' }
  );
}

function limitRows(snap) {
  const cur = Number(snap.maxTotal) || 100;
  const presets = gm.OCCUPANCY_PRESETS || [10, 25, 50, 100, 200];
  return presets.map((n) => ({
    id: `gm_lim_${n}`,
    title: `Max ${n}`,
    description: n === cur ? 'atual' : `teto ${n} grupos`
  }));
}

async function showLimits(conn, ctx) {
  const snap = await gm.snapshot(ctx.telegramUserId);
  const p = prefixFromCtx(ctx);
  const text = gm.limitsText(snap) + `\n${p}grupoconfig max N`;
  await sendInteractiveList(
    conn,
    ctx.from,
    text,
    [{
      title: 'Teto de grupos',
      rows: [
        ...limitRows(snap),
        {
          id: snap.limits.autoRefill === true ? 'gm_auto_off' : 'gm_auto_on',
          title: snap.limits.autoRefill === true ? 'Auto-repor ON' : 'Auto-repor OFF',
          description: snap.limits.autoRefill === true ? 'completa se o bot sair' : 'off = nao entra sozinho'
        },
        { id: 'gm_home', title: 'Voltar', description: 'painel' }
      ]
    }],
    'so dono',
    ctx.info,
    null,
    ctx.telegramUserId,
    ctx.sessionId,
    { listTitle: 'Limites' }
  );
}

async function showHist(conn, ctx) {
  const snap = await gm.snapshot(ctx.telegramUserId);
  const text = formatReportBlock('HISTORICO', [
    labelValue('Ultima entrada', snap.lastJoinLabel),
    labelValue('Entradas hoje', `${snap.joinsToday}/${snap.maxJoins}`),
    labelValue('Saidas hoje', `${snap.leavesToday}/${snap.maxLeaves}`),
    labelValue('Entraram (fila)', String(snap.joined + snap.alreadyMember)),
    labelValue('Falhos', String(snap.failed))
  ]);
  await sendInteractiveList(
    conn,
    ctx.from,
    text,
    [{ title: 'Nav', rows: [{ id: 'gm_home', title: 'Voltar', description: 'painel' }] }],
    'so dono',
    ctx.info,
    null,
    ctx.telegramUserId,
    ctx.sessionId,
    { listTitle: 'Historico' }
  );
}

function runJoinJob(conn, ctx, n) {
  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'GRUPOS');
        try {
          await status.update('Fila', `Entrando em ate ${n === 'max' ? 'max' : n}...`);
          const out = await gm.joinBatch(ctx.telegramUserId, n, {
            preferredSessionId: ctx.sessionId,
            manual: true,
            onProgress: (step, label) => status.update(String(step), label)
          });
          if (!out.ok && out.reason === 'paused') {
            await status.finish('Fila pausada. Continue no gerenciador.');
            return;
          }
          if (!out.ok && out.reason === 'no-session') {
            await status.finish('Nenhuma sessao WhatsApp conectada.');
            return;
          }
          if (!out.ok && out.reason === 'auto-off') {
            await status.finish('Auto-repor esta OFF. Use Entrar no gerenciador se quiser entrar agora.');
            return;
          }
          if (!out.ok && out.reason === 'occupancy-unknown') {
            await status.finish('Nao deu pra contar os grupos no Zap agora. Tenta de novo em instantes.');
            return;
          }
          if (!out.ok && out.reason === 'at-cap') {
            await status.finish(
              `Teto atingido. Grupos: ${out.activeGroups || 0} / ${out.maxTotal || 0}. Nao entra mais ate sair ou aumentar o teto.`
            );
            return;
          }
          if (!out.ok && out.real === 0) {
            await status.finish(
              `Nada a entrar.\nPedido: ${out.requested || n}\nPendentes: ${out.pending || 0}\nGrupos: ${out.activeGroups || 0} / ${out.maxTotal || 0}`
            );
            return;
          }
          const skipN = out.skipped || (out.results || []).filter((r) => !r.ok).length;
          const skipHint = skipN
            ? `\nPulou ${skipN} link(s) morto(s) e tentou o proximo.`
            : '';
          await status.finish(
            `Entrou em ${out.done} grupo(s).${skipHint}\nLista DIV: ${out.divList != null ? out.divList : '?'}\nPedido: ${out.requested} · alvo: ${out.real}\nGrupos: ${out.activeGroups || '?'} / ${out.maxTotal || '?'}`
          );
        } catch (e) {
          const msg = String(e.message || e).slice(0, 160);
          logger.logAviso(`[gm] join job: ${msg}`);
          try { await status.finish(`Erro: ${msg}`); } catch (_) { /* ignore */ }
        }
      })
      .catch((e) => logger.logAviso(`[gm] join spawn: ${e.message}`));
  });
}

async function askLeave(conn, ctx, n) {
  const prep = await gm.prepareLeave(ctx.telegramUserId, n);
  if (!prep.real) {
    await ack(conn, ctx, 'Nada para sair (lista vazia ou limite diario).');
    return;
  }
  const preview = prep.jids.slice(0, 5).join('\n');
  const extra = prep.jids.length > 5 ? `\n+${prep.jids.length - 5} grupos` : '';
  await sendInteractiveButtons(
    conn,
    ctx.from,
    `Voce esta prestes a sair de ${prep.real} grupo(s).\n\n${preview}${extra}\n\nEles saem da lista oficial de divulgacao.`,
    [
      { id: 'gm_leave_ok', label: 'Confirmar' },
      { id: 'gm_leave_no', label: 'Cancelar' }
    ],
    'so dono',
    ctx.info
  );
}

function runLeaveJob(conn, ctx) {
  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'GRUPOS');
        try {
          const out = await gm.confirmLeave(ctx.telegramUserId, {
            onProgress: (step, label) => status.update(String(step), label)
          });
          if (!out.ok) {
            await status.finish('Confirmacao expirou. Peça a saida de novo.');
            return;
          }
          await status.finish(`Saiu de ${out.done} grupo(s).`);
        } catch (e) {
          try { await status.finish(`Erro: ${String(e.message || e).slice(0, 160)}`); } catch (_) { /* ignore */ }
        }
      })
      .catch((e) => logger.logAviso(`[gm] leave spawn: ${e.message}`));
  });
}

async function handleGroupManagerClick(conn, ctx, btnId) {
  if (!(await requireSessionOwner(conn, ctx))) return;
  markOperator(conn, ctx);
  const id = String(btnId || '');
  if (id === 'gm_home') return showHome(conn, ctx);
  if (id === 'gm_queue') return showQueue(conn, ctx);
  if (id === 'gm_active') return showActive(conn, ctx, 1);
  if (id === 'gm_limits') return showLimits(conn, ctx);
  if (id.startsWith('gm_lim_')) {
    const n = parseInt(id.slice(7), 10);
    if (Number.isFinite(n) && n >= 1) {
      gm.saveLimits(ctx.telegramUserId, { maxTotalGroups: n });
      await showLimits(conn, ctx);
      return;
    }
    return showLimits(conn, ctx);
  }
  if (id === 'gm_auto_on' || id === 'gm_auto_off') {
    gm.saveLimits(ctx.telegramUserId, { autoRefill: id === 'gm_auto_on' });
    if (id === 'gm_auto_on') {
      setImmediate(() => { gm.maintainOccupancy(ctx.telegramUserId).catch(() => {}); });
    }
    return showLimits(conn, ctx);
  }
  if (id === 'gm_hist') return showHist(conn, ctx);
  if (id.startsWith('gm_ap_')) return showActive(conn, ctx, parseInt(id.slice(6), 10) || 1);
  if (id === 'gm_join_1') return runJoinJob(conn, ctx, 1);
  if (id === 'gm_join_5') return runJoinJob(conn, ctx, 5);
  if (id === 'gm_join_10') return runJoinJob(conn, ctx, 10);
  if (id === 'gm_join_25') return runJoinJob(conn, ctx, 25);
  if (id === 'gm_join_max') return runJoinJob(conn, ctx, 'max');
  if (id === 'gm_leave_1') return askLeave(conn, ctx, 1);
  if (id === 'gm_leave_5') return askLeave(conn, ctx, 5);
  if (id === 'gm_leave_10') return askLeave(conn, ctx, 10);
  if (id === 'gm_leave_ok') return runLeaveJob(conn, ctx);
  if (id === 'gm_leave_no') {
    gm.clearPendingLeave(ctx.telegramUserId);
    return showHome(conn, ctx);
  }
  if (id === 'gm_reprocess') {
    await gm.reprocess(ctx.telegramUserId);
    return showQueue(conn, ctx);
  }
  if (id === 'gm_clear') {
    await gm.clearInvalid(ctx.telegramUserId);
    return showQueue(conn, ctx);
  }
  if (id === 'gm_pause') {
    gm.setPaused(ctx.telegramUserId, true);
    return showQueue(conn, ctx);
  }
  if (id === 'gm_resume') {
    gm.setPaused(ctx.telegramUserId, false);
    return showQueue(conn, ctx);
  }
}

commands.grupos = {
  useCtx: true,
  description: 'Gerenciador de grupos: fila de convites + cadastro na divulgacao',
  usage: 'grupos',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    await showHome(conn, ctx);
  }
};

commands.grupolista = {
  useCtx: true,
  description: 'Lista paginada dos grupos ativos na divulgacao',
  usage: 'grupolista [pagina]',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    const page = parseInt(ctx.args?.[0], 10) || 1;
    await showActive(conn, ctx, page);
  }
};

commands.grupoconfig = {
  useCtx: true,
  description: 'Limites do gerenciador de grupos',
  usage: 'grupoconfig [max N]',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    const head = String(ctx.args?.[0] || '').trim().toLowerCase();
    if (head === 'max' || head === 'maxgrupos' || head === 'teto' || head === 'ocupacao') {
      const n = parseInt(ctx.args?.[1], 10);
      if (!Number.isFinite(n) || n < 1) {
        await ack(conn, ctx, `Uso: ${prefixFromCtx(ctx)}grupoconfig max 80 (1 a 500).`);
        return;
      }
      gm.saveLimits(ctx.telegramUserId, { maxTotalGroups: n });
      return showLimits(conn, ctx);
    }
    await showLimits(conn, ctx);
  }
};

commands.grupoentrar = {
  useCtx: true,
  description: 'Entra em N convites pendentes e cadastra na divulgacao',
  usage: 'grupoentrar [N|max]',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    const n = parseN(ctx.args?.[0], 1);
    runJoinJob(conn, ctx, n);
  }
};

commands.gruposair = {
  useCtx: true,
  description: 'Sai de N grupos da lista oficial (pede confirmacao)',
  usage: 'gruposair [N]',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    const n = parseN(ctx.args?.[0], 1);
    await askLeave(conn, ctx, n);
  }
};

module.exports = { commands, handleGroupManagerClick };
