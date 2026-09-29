'use strict';

const logger = require('../logger');
const { sendInteractiveList } = require('../helpers');
const { prefixFromCtx } = require('../utils/configManager');
const { setStep } = require('../utils/stepHandlers');
const {
  listSections,
  postCategoryToCanal,
  byId,
  MAX_MULTI,
  clampCount,
} = require('../services/figurinhaCanalService');
const { previewText } = require('../utils/typography');
const { sendAsChannel } = require('../utils/channelForward');

const commands = {};

const ALIAS_MAP = {
  aleatoria: 'ale1',
  ale1: 'ale1',
  figurinhas: 'ale1',
  random1: 'ale1',
  ale2: 'ale2',
  figurinhas2: 'ale2',
  random2: 'ale2',
  emoji: 'figemoji',
  figemoji: 'figemoji',
  flork: 'figflork',
  figflork: 'figflork',
  ale: 'figale',
  figale: 'figale',
  memes: 'figmemes',
  figmemes: 'figmemes',
  anime: 'figanime',
  figanime: 'figanime',
  coreana: 'figcoreana',
  figcoreana: 'figcoreana',
  desenho: 'figdesenho',
  figdesenho: 'figdesenho',
  bebe: 'figbebe',
  figbebe: 'figbebe',
  animais: 'figanimais',
  figanimais: 'figanimais',
  amongus: 'amongus',
  among: 'amongus',
  trending: 'sly_trend',
  trend: 'sly_trend',
  buscar: 'sly_search',
  search: 'sly_search',
  pack: 'sly_pack',
  stickerly: 'sly_trend',
};

function canPostCanal(ctx) {
  try {
    const { isFreshSessionOwner } = require('../utils/authorization');
    if (isFreshSessionOwner(ctx)) return true;
  } catch (_) { /* ignore */ }
  if (ctx?.authRole === 'owner' || ctx?.authRole === 'platform_admin') return true;
  return !!(ctx?.isVip || ctx?.authRole === 'vip');
}

/** Texto do fluxo figurinha com selo de canal (igual .play / botoes OFF). */
async function sendFig(conn, ctx, text) {
  return sendAsChannel(conn, ctx.from, { text: String(text || '') }, {
    quoted: ctx.info,
    sessionId: ctx.sessionId || conn?._sessionId
  });
}

async function denyIfNotVip(conn, ctx) {
  if (canPostCanal(ctx)) return false;
  await sendFig(conn, ctx, 'So dono ou VIP posta figurinha no canal.').catch(() => {});
  return true;
}

function ensureSession(ctx) {
  if (!ctx.session || typeof ctx.session !== 'object') {
    try {
      const { getConversationSession } = require('../utils/conversationSession');
      ctx.session = getConversationSession(ctx.sessionId, ctx.sender);
    } catch (_) {
      ctx.session = { step: null };
    }
  }
  return ctx.session;
}

function defaultCount(ctx) {
  const s = ensureSession(ctx);
  return clampCount(s.figcDefaultCount || 1, 1);
}

async function reactOk(conn, info) {
  try {
    if (info?.key) {
      const jid = info.key.remoteJid || info.key.participant;
      if (jid) await conn.sendMessage(jid, { react: { text: '✅', key: info.key } });
    }
  } catch (_) { /* ignore */ }
}

async function openFigurinhaList(conn, ctx) {
  if (await denyIfNotVip(conn, ctx)) return;
  const p = prefixFromCtx(ctx);
  const def = defaultCount(ctx);
  const title = previewText('Figurinhas — canal');
  const footer = `Qtd padrao: ${def} · ${p}figurinha qtd N · max ${MAX_MULTI}`;
  await sendInteractiveList(
    conn,
    ctx.from,
    title,
    listSections(),
    footer,
    ctx.info,
    null,
    ctx.telegramUserId || null,
    conn._sessionId || ctx.sessionId || null
  );
}

function askQtyPrompt(ctx, catLabel) {
  const p = prefixFromCtx(ctx);
  const def = defaultCount(ctx);
  return (
    `${catLabel} — quantas postar no canal?\n` +
    `Manda um numero de 1 a ${MAX_MULTI} (padrao ${def}).\n` +
    `Ou: ${p}figurinha qtd ${def}`
  );
}

function beginCategoryFlow(conn, ctx, categoryId, count = null) {
  if (!canPostCanal(ctx)) {
    return denyIfNotVip(conn, ctx);
  }
  const cat = byId.get(categoryId);
  if (!cat) return sendFig(conn, ctx, 'Categoria desconhecida.');

  const s = ensureSession(ctx);
  s.figcCategory = categoryId;
  if (count != null) s.figcCount = clampCount(count, defaultCount(ctx));
  else delete s.figcCount;

  if (count == null) {
    setStep(ctx, 'awaiting_figc_qty');
    return sendFig(conn, ctx, askQtyPrompt(ctx, cat.label));
  }

  return continueAfterQty(conn, ctx, s.figcCount);
}

async function continueAfterQty(conn, ctx, count) {
  const s = ensureSession(ctx);
  const categoryId = s.figcCategory;
  const cat = byId.get(categoryId);
  if (!cat) {
    return sendFig(conn, ctx, 'Categoria perdida. Abre .figurinha de novo.');
  }
  s.figcCount = clampCount(count, defaultCount(ctx));

  if (cat.needs === 'texto') {
    setStep(ctx, 'awaiting_figc_amongus');
    return sendFig(conn, ctx, `Among Us (${s.figcCount}x) — manda o texto (ou "cancelar").`);
  }
  if (cat.needs === 'q') {
    setStep(ctx, 'awaiting_figc_search');
    return sendFig(conn, ctx, `Busca (${s.figcCount}x) — manda o termo (ou "cancelar").`);
  }
  if (cat.needs === 'url') {
    setStep(ctx, 'awaiting_figc_pack');
    return sendFig(conn, ctx, `Pack (${s.figcCount}x) — manda a URL (ou "cancelar").`);
  }

  return runPost(conn, ctx, categoryId, { count: s.figcCount });
}

async function runPost(conn, ctx, categoryId, extra = {}) {
  if (await denyIfNotVip(conn, ctx)) return;

  const cat = byId.get(categoryId);
  if (!cat) {
    return sendFig(conn, ctx, 'Categoria desconhecida.');
  }

  const count = clampCount(extra.count ?? ensureSession(ctx).figcCount ?? defaultCount(ctx), 1);
  const payload = { ...extra, count };

  let notifiedDup = false;
  let progress = null;
  try {
    const { createWhatsAppStatus } = require('../utils/statusProgress');
    progress = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'FIGURINHA');
    await progress.setRows([['Estado', 'buscando'], ['Categoria', cat.label], ['Qtd', String(count)]]);

    const result = await postCategoryToCanal(conn, categoryId, payload, (ev) => {
      if (ev?.dup && !notifiedDup) {
        notifiedDup = true;
        progress.setRows([['Estado', 'trocando repetida'], ['Categoria', cat.label]]).catch(() => {});
      }
    });

    await reactOk(conn, ctx.info);
    const extraParts = [];
    if (result.skippedDup) extraParts.push(`${result.skippedDup} repetida(s) trocada(s)`);
    if (result.apiErrors) extraParts.push(`${result.apiErrors} erro(s) de API reposto(s)`);
    const extraNote = extraParts.length ? ` · ${extraParts.join(' · ')}` : '';
    const want = result.want || count;
    let text;
    if (result.posted >= want) {
      text = `Enviado pro canal ${result.posted}/${want}${extraNote}`;
    } else {
      const faltou = want - result.posted;
      text =
        `Enviado pro canal ${result.posted}/${want} — ${faltou} nao foi possivel repor apos varias tentativas` +
        extraNote;
    }
    await progress.finish(previewText(text));
  } catch (e) {
    const msg = String(e?.message || e);
    logger.logAviso(`[figurinha] post fail ${categoryId}: ${msg}`);
    let user = 'Falhou ao postar no canal.';
    if (/texto_obrigatorio|termo_obrigatorio|url_obrigatoria/i.test(msg)) {
      user = 'Falta o dado pedido pra essa categoria.';
    } else if (/fonte_esgotada|todas_duplicadas|FIGURA_ESGOTADA/i.test(msg) || e?.code === 'FIGURA_ESGOTADA') {
      user =
        `Categoria "${e.label || categoryId}" esgotou figurinhas novas por enquanto.\n` +
        'Tente outra categoria (ex: aleatoria / sticker.ly).';
    } else if (/rate-limit|muitas requisi|429/i.test(msg) || e?.code === 'ZT_429') {
      const sec = Number(e?.retryAfterSec || (String(msg).match(/rate-limit:(\d+)/i) || [])[1]) || 90;
      user = `API em rate-limit agora. Espera ${sec}s e tenta de novo — a fonte nao acabou.`;
    } else if (/NO_API_KEY|Configure HANORK/i.test(msg)) {
      user = 'API key nao configurada no .env.';
    } else if (/canal_invalido|bot_offline/i.test(msg)) {
      user = 'Canal/sessao indisponivel agora.';
    } else if (/Connection Closed|Timed Out|ECONNRESET|not connected/i.test(msg)) {
      user = 'Sessao reiniciando. Manda o comando de novo em alguns segundos.';
      // nao tenta sendMessage se socket ja morreu
      return;
    } else if (/404|fora do ar|Endpoint|resposta_vazia|nenhuma_figurinha|stickerly/i.test(msg)) {
      user = 'API sem figurinha nessa rota. Tente outra categoria.';
    }
    try {
      if (progress) await progress.finish(previewText(user));
      else await sendFig(conn, ctx, user);
    } catch (_) { /* ignore */ }
  }
}

async function handleFigurinhaCanalClick(conn, ctx, buttonId) {
  if (await denyIfNotVip(conn, ctx)) return;
  const id = String(buttonId || '').replace(/^figc_/, '');
  if (!byId.get(id)) {
    await sendFig(conn, ctx, 'Opcao invalida.');
    return;
  }
  await beginCategoryFlow(conn, ctx, id, null);
}

const stepHandlers = {
  async awaiting_figc_qty(conn, ctx, text) {
    if (await denyIfNotVip(conn, ctx)) return true;
    const t = String(text || '').trim().toLowerCase();
    if (t === 'padrao' || t === 'default' || t === '') {
      await continueAfterQty(conn, ctx, defaultCount(ctx));
      return true;
    }
    const n = Number.parseInt(t.replace(/\D/g, ''), 10);
    if (!Number.isFinite(n) || n < 1) {
      await sendFig(conn, ctx, `Numero invalido. Manda 1–${MAX_MULTI} ou "cancelar".`);
      return false;
    }
    await continueAfterQty(conn, ctx, clampCount(n));
    return true;
  },
  async awaiting_figc_amongus(conn, ctx, text) {
    if (await denyIfNotVip(conn, ctx)) return true;
    const t = String(text || '').trim();
    if (!t) {
      await sendFig(conn, ctx, 'Texto vazio. Manda de novo ou "cancelar".');
      return false;
    }
    const count = ensureSession(ctx).figcCount || defaultCount(ctx);
    await runPost(conn, ctx, 'amongus', { texto: t, count });
    return true;
  },
  async awaiting_figc_search(conn, ctx, text) {
    if (await denyIfNotVip(conn, ctx)) return true;
    const t = String(text || '').trim();
    if (!t) {
      await sendFig(conn, ctx, 'Termo vazio. Manda de novo ou "cancelar".');
      return false;
    }
    const count = ensureSession(ctx).figcCount || defaultCount(ctx);
    await runPost(conn, ctx, 'sly_search', { q: t, count });
    return true;
  },
  async awaiting_figc_pack(conn, ctx, text) {
    if (await denyIfNotVip(conn, ctx)) return true;
    const t = String(text || '').trim();
    if (!/^https?:\/\//i.test(t)) {
      await sendFig(conn, ctx, 'URL invalida. Cole o link do pack ou "cancelar".');
      return false;
    }
    const count = ensureSession(ctx).figcCount || defaultCount(ctx);
    await runPost(conn, ctx, 'sly_pack', { url: t, count });
    return true;
  },
};

/** Extrai qtd e categoria de args: "5 anime", "anime 5", "qtd 5", "amongus 3 ola" */
function parseFigurinhaArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { kind: 'list' };

  if (/^(qtd|qty|quantidade|n)$/i.test(parts[0])) {
    const n = clampCount(parts[1], 0);
    if (!parts[1] || n < 1) return { kind: 'qtd_help' };
    return { kind: 'set_qtd', count: n };
  }

  let count = null;
  let catToken = null;
  let restParts = [];

  if (/^\d+$/.test(parts[0])) {
    count = clampCount(parts[0]);
    catToken = parts[1] || null;
    restParts = parts.slice(2);
  } else {
    catToken = parts[0];
    if (parts[1] && /^\d+$/.test(parts[1])) {
      count = clampCount(parts[1]);
      restParts = parts.slice(2);
    } else {
      restParts = parts.slice(1);
    }
  }

  if (!catToken) return { kind: 'list' };
  const catId = ALIAS_MAP[String(catToken).toLowerCase()];
  if (!catId) return { kind: 'list' };
  return {
    kind: 'run',
    catId,
    count,
    rest: restParts.join(' ').trim(),
  };
}

async function executeFigurinha(conn, ctx) {
  if (await denyIfNotVip(conn, ctx)) return;
  const raw = String(ctx.text || (ctx.args || []).join(' ') || '').trim();
  if (!raw) return openFigurinhaList(conn, ctx);

  const parsed = parseFigurinhaArgs(raw);
  if (parsed.kind === 'list') return openFigurinhaList(conn, ctx);

  if (parsed.kind === 'qtd_help') {
    return sendFig(
      conn,
      ctx,
      `Uso: ${prefixFromCtx(ctx)}figurinha qtd <1-${MAX_MULTI}>\nAtual: ${defaultCount(ctx)}`
    );
  }

  if (parsed.kind === 'set_qtd') {
    const s = ensureSession(ctx);
    s.figcDefaultCount = parsed.count;
    return sendFig(conn, ctx, previewText(`Qtd padrao de figurinhas no canal: ${parsed.count}`));
  }

  const { catId, count, rest } = parsed;
  const cat = byId.get(catId);
  const s = ensureSession(ctx);
  s.figcCategory = catId;
  if (count != null) s.figcCount = count;
  else s.figcCount = defaultCount(ctx);

  if (cat?.needs === 'texto') {
    if (!rest) {
      setStep(ctx, 'awaiting_figc_amongus');
      return sendFig(conn, ctx, `Among Us (${s.figcCount}x) — manda o texto (ou "cancelar").`);
    }
    return runPost(conn, ctx, catId, { texto: rest, count: s.figcCount });
  }
  if (cat?.needs === 'q') {
    if (!rest) {
      setStep(ctx, 'awaiting_figc_search');
      return sendFig(conn, ctx, `Busca (${s.figcCount}x) — manda o termo (ou "cancelar").`);
    }
    return runPost(conn, ctx, catId, { q: rest, count: s.figcCount });
  }
  if (cat?.needs === 'url') {
    if (!rest) {
      setStep(ctx, 'awaiting_figc_pack');
      return sendFig(conn, ctx, `Pack (${s.figcCount}x) — manda a URL (ou "cancelar").`);
    }
    return runPost(conn, ctx, catId, { url: rest, count: s.figcCount });
  }

  // Sem qtd no comando → pergunta (pra nao fixar 1)
  if (count == null && !/^\d+$/.test(String(raw).trim().split(/\s+/)[0])) {
    // `.figurinha anime` sem numero → pergunta qtd
    return beginCategoryFlow(conn, ctx, catId, null);
  }

  return runPost(conn, ctx, catId, { count: s.figcCount });
}

commands.figurinha = {
  useCtx: true,
  description: 'Lista categorias e posta N figurinhas no canal (dono/VIP)',
  usage: 'figurinha [N] [categoria] | figurinha qtd N',
  permission: 'vip',
  execute: executeFigurinha,
};
commands.figcanal = commands.figurinha;
commands.figurinhas = {
  useCtx: true,
  description: 'Posta N figurinhas aleatorias (fonte 1) no canal (dono/VIP)',
  usage: 'figurinhas [N]',
  permission: 'vip',
  execute: async (conn, ctx) => {
    if (await denyIfNotVip(conn, ctx)) return;
    const n = clampCount((ctx.args || [])[0], defaultCount(ctx));
    return beginCategoryFlow(conn, ctx, 'ale1', Number.isFinite(Number((ctx.args || [])[0])) ? n : null);
  },
};
commands.figurinhas2 = {
  useCtx: true,
  description: 'Posta N figurinhas aleatorias (fonte 2) no canal (dono/VIP)',
  usage: 'figurinhas2 [N]',
  permission: 'vip',
  execute: async (conn, ctx) => {
    if (await denyIfNotVip(conn, ctx)) return;
    const n = clampCount((ctx.args || [])[0], defaultCount(ctx));
    return beginCategoryFlow(conn, ctx, 'ale2', Number.isFinite(Number((ctx.args || [])[0])) ? n : null);
  },
};

module.exports = {
  commands,
  handleFigurinhaCanalClick,
  stepHandlers,
  openFigurinhaList,
};
