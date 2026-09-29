// commands/zt.js — dispatcher generico Hanork API (catalogo)
'use strict';

const logger = require('../logger');
const { ztCategoryAllowed } = require('../utils/contentGates');
const { allEntries, byCmd, loadCatalog, cmdsByCategory } = require('../core/zt/catalog');
const zt = require('../services/zerotwoClient');
const { prefixFromCtx } = require('../utils/configManager');
const { applyForwardMode } = require('../utils/channelForward');
const { friendlyMediaError } = require('../utils/onboarding');
const { splitTextParts } = require('../utils/textChunks');
const { formatApiUserText, isApiErrorPayload } = require('../core/zt/responseFormat');
const { formatReportBlock, labelValue } = require('../utils/typography');
const { enforceSearchQuery, shouldCapParam } = require('../utils/searchQueryLimit');

const commands = {};

function resolveParamValue(spec, ctx, args, text) {
  if (spec.from === 'fixed') return spec.value;
  if (spec.from === 'arg0') return args[0] || '';
  if (spec.from === 'arg1') return args[1] || '';
  if (spec.from === 'textRest') {
    if (args.length > 1) return args.slice(1).join(' ');
    return text;
  }
  if (spec.from === 'text' || !spec.from) return text || args.join(' ');
  return text;
}

function buildParams(entry, ctx) {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  const text = String(ctx.text || args.join(' ') || '').trim();
  const out = {};
  for (const spec of entry.params || []) {
    const v = resolveParamValue(spec, ctx, args, text);
    if (v !== undefined && v !== null && v !== '') {
      out[spec.name] = shouldCapParam(spec.name) ? enforceSearchQuery(String(v)) : v;
    }
  }
  return out;
}

async function downloadQuotedMedia(conn, ctx) {
  try {
    const raw = ctx.info?.message || ctx.info || {};
    const tgReply = raw.reply_to_message || ctx.info?.reply_to_message;
    if (tgReply && typeof conn.downloadTelegramMedia === 'function') {
      const buf = await conn.downloadTelegramMedia(tgReply);
      return Buffer.isBuffer(buf) ? buf : null;
    }
    const quoted = ctx.info?.message?.extendedTextMessage?.contextInfo?.quotedMessage
      || ctx.quoted?.message
      || null;
    if (!quoted) return null;
    const msg = quoted.imageMessage || quoted.videoMessage || quoted.documentMessage || quoted.stickerMessage;
    if (!msg) return null;
    if (typeof conn.downloadMediaMessage !== 'function') return null;
    const buf = await conn.downloadMediaMessage({ message: quoted });
    return Buffer.isBuffer(buf) ? buf : null;
  } catch (_) {
    return null;
  }
}

async function sendTextParts(conn, jid, text, quoted, sid) {
  const isTg = !!(conn?._isTelegramShim);
  const parts = splitTextParts(String(text || ''), isTg ? 3500 : 60000);
  let last = null;
  for (const part of parts) {
    const payload = applyForwardMode({ text: part }, sid, { force: true });
    last = await conn.sendMessage(jid, payload, { quoted, skipForward: true });
  }
  return last;
}

async function sendResult(conn, ctx, entry, result) {
  const sid = conn?._sessionId;
  const quoted = ctx.info;
  const jid = ctx.from;
  const isTg = !!(conn?._isTelegramShim || ctx.platform === 'telegram');
  const cat = String(entry.category || '');
  const path = String(entry.path || '');

  const isDownloadCat =
    /downloads/i.test(cat) ||
    /\/(api\/)?(dl|download)\//i.test(path) ||
    /tiktok|instagram|facebook|twitter|kwai|threads|capcut|pinterest|spotify|soundcloud|mediafire|ytvideo|ytaudio/i.test(
      String(entry.cmd || '') + path
    );

  const send = async (content) => {
    const isMedia = !!(
      content &&
      (content.audio || content.video || content.image || content.sticker || content.document)
    );
    const payload = isTg || isMedia ? content : applyForwardMode(content, sid, { force: true });
    return conn.sendMessage(jid, payload, {
      quoted: isMedia ? undefined : quoted,
      skipForward: true,
      _hanorkTrusted: true
    });
  };

  const sendPlayStyle = async (mediaContent) => {
    await send(mediaContent);
    if (isDownloadCat && !isTg) {
      await sendTextParts(
        conn,
        jid,
        formatReportBlock(String(entry.menuLabel || entry.cmd || 'DOWNLOAD').toUpperCase(), [
          labelValue('Status', 'enviado')
        ]),
        quoted,
        sid
      );
    }
  };

  if (result.kind === 'buffer') {
    const ct = String(result.contentType || '');
    const buf = result.buffer;
    const hint = entry.mediaHint;
    const kind = zt.guessMediaKind(buf, ct);
    if (!zt.isRealMediaBuffer(buf)) {
      return sendTextParts(
        conn,
        jid,
        formatReportBlock(String(entry.menuLabel || entry.cmd || 'API').toUpperCase(), [
          labelValue('Erro', 'A API devolveu metadados, nao o arquivo de midia.')
        ]),
        quoted,
        isTg ? null : sid
      );
    }
    if (hint === 'sticker' || kind === 'sticker' || /webp/i.test(ct) || /figurinhas/i.test(cat)) {
      return send({ sticker: buf });
    }
    if (hint === 'video' || kind === 'video' || /video/i.test(ct)) {
      return sendPlayStyle({ video: buf, mimetype: 'video/mp4' });
    }
    if (hint === 'gif' || kind === 'gif' || /gif/i.test(ct)) {
      return sendPlayStyle({ video: buf, gifPlayback: true });
    }
    if (
      kind === 'audio' ||
      /audio|mpeg|ogg|mp3/i.test(ct) ||
      /spotify|soundcloud|ytaudio|myinst/i.test(String(entry.cmd || ''))
    ) {
      return sendPlayStyle({ audio: buf, mimetype: ct.includes('audio') ? ct : 'audio/mpeg' });
    }
    if (kind === 'image' || /image/i.test(ct)) {
      return sendPlayStyle({ image: buf });
    }
    if (isDownloadCat) {
      return sendPlayStyle({ video: buf, mimetype: 'video/mp4' });
    }
    return send({ document: buf, mimetype: ct || 'application/octet-stream', fileName: 'arquivo' });
  }

  const data = result.data;
  const forceText =
    /^(ias|consultas|pesquisas)$/i.test(cat) ||
    /\/api\/ia2?\//i.test(path) ||
    /\/gemini\//i.test(path) ||
    /\/api\/transcrever/i.test(path) ||
    entry.response === 'json';

  const trySendMedia = async (mediaUrl) => {
    if (!mediaUrl) return false;
    try {
      const media = await zt.fetchBuffer(mediaUrl);
      await sendResult(conn, ctx, entry, { kind: 'buffer', ...media });
      return true;
    } catch (e) {
      logger.logAviso(`API_${entry.cmd}_MEDIA`, e.message);
      return false;
    }
  };

  const mediaUrl = zt.pickMediaUrl(data);
  const canFetch =
    mediaUrl &&
    !zt.isPageShareUrl(mediaUrl) &&
    zt.isLikelyMediaUrl(mediaUrl);
  if (canFetch) {
    const ok = await trySendMedia(mediaUrl);
    if (ok) return;
  }

  if (isDownloadCat && !forceText) {
    const rescued = await tryDedicatedDownload(conn, ctx, entry);
    if (rescued) return rescued;
    return sendTextParts(
      conn,
      jid,
      formatReportBlock(String(entry.menuLabel || entry.cmd || 'DOWNLOAD').toUpperCase(), [
        labelValue('Erro', 'A API devolveu so metadados, sem arquivo de video/audio.')
      ]),
      quoted,
      isTg ? null : sid
    );
  }

  if (mediaUrl && !forceText && !isDownloadCat) {
    return sendTextParts(
      conn,
      jid,
      formatReportBlock(String(entry.menuLabel || entry.cmd || 'API').toUpperCase(), [
        labelValue('Aviso', 'Nao foi possivel baixar a midia')
      ]),
      quoted,
      isTg ? null : sid
    );
  }

  // Texto / lista / consulta — nunca JSON.stringify ao user
  const formatted = formatApiUserText(entry, data, {
    listLimit: /pesquisas|animes|doramas|mangas|anichin|encontrei|mcpedl|wallpapers/i.test(cat)
      ? 8
      : 10
  });
  return sendTextParts(conn, jid, formatted.text, quoted, isTg ? null : sid);
}

async function pollHdVideo(conn, ctx, entry, startData) {
  const jobId =
    startData?.id ||
    startData?.jobId ||
    startData?.task_id ||
    startData?.resultado?.id ||
    startData?.result?.id;
  if (!jobId) {
    return sendResult(conn, ctx, entry, { kind: 'json', data: startData });
  }
  const statusPath = entry.path.includes('/status')
    ? entry.path
    : String(entry.path || '').replace(/\/?$/, '') + '/status';
  const dlPath = String(entry.path || '').replace(/\/status$/, '').replace(/\/?$/, '') + '/download';

  await conn.sendMessage(ctx.from, {
    text: formatReportBlock('HD VIDEO', [labelValue('Status', 'processando…'), labelValue('Job', String(jobId))])
  }, { quoted: ctx.info });

  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const st = await zt.getJson(statusPath, { id: jobId, jobId, task_id: jobId });
      const done =
        st?.status === true ||
        st?.ready === true ||
        /done|complete|pronto|finished/i.test(String(st?.state || st?.status || ''));
      const mediaUrl = zt.pickMediaUrl(st);
      if (mediaUrl) {
        const media = await zt.fetchBuffer(mediaUrl);
        return sendResult(conn, ctx, entry, { kind: 'buffer', ...media });
      }
      if (done) {
        try {
          const dl = await zt.request(dlPath, { id: jobId, jobId }, { response: 'auto', timeout: 120000 });
          return sendResult(conn, ctx, entry, dl);
        } catch (_) {
          return sendResult(conn, ctx, entry, { kind: 'json', data: st });
        }
      }
    } catch (e) {
      if (i === 11) throw e;
    }
  }
  return conn.sendMessage(ctx.from, {
    text: formatReportBlock('HD VIDEO', [labelValue('Erro', 'Timeout aguardando processamento')])
  }, { quoted: ctx.info });
}

async function executeEntry(conn, ctx, entry) {
  const p = prefixFromCtx(ctx);
  try {
    if (!ztCategoryAllowed(entry.category, entry)) {
      return conn.sendMessage(ctx.from, { text: 'Categoria indisponivel.' }, { quoted: ctx.info });
    }
    if (entry.upload) {
      const buf = await downloadQuotedMedia(conn, ctx);
      if (!buf) {
        return conn.sendMessage(ctx.from, {
          text: `Responda uma midia com ${p}${entry.cmd}`
        }, { quoted: ctx.info });
      }
      const data = await zt.uploadMultipart(entry.path, buf, 'upload.bin', buildParams(entry, ctx));
      return sendResult(conn, ctx, entry, { kind: 'json', data });
    }

    const params = buildParams(entry, ctx);
    const missingRequired = (entry.params || []).some(
      (sp) => sp.required && (params[sp.name] === undefined || params[sp.name] === '')
    );
    if (missingRequired) {
      const usage = `${p}${entry.cmd} <${(entry.params || []).filter((x) => x.required).map((x) => x.name).join('> <') || 'args'}>`;
      return conn.sendMessage(ctx.from, { text: `Uso: ${usage}` }, { quoted: ctx.info });
    }

    // HD video assincrono (start → status → download)
    if (/hd-video$/i.test(String(entry.path || '')) || /hdvideo$/i.test(String(entry.cmd || ''))) {
      const start = await zt.getJson(entry.path, params, 60000);
      if (isApiErrorPayload(start)) {
        return sendResult(conn, ctx, entry, { kind: 'json', data: start });
      }
      return pollHdVideo(conn, ctx, entry, start);
    }

    const prefer =
      entry.response === 'buffer'
        ? 'buffer'
        : entry.response === 'json' || /^(ias|consultas|pesquisas)$/i.test(String(entry.category || ''))
          ? 'json'
          : 'auto';
    const result = await zt.request(entry.path, params, {
      response: prefer,
      timeout: entry.nsfw ? 90000 : 60000
    });
    if (isIgMediaDownload(entry) && result.kind !== 'buffer') {
      const rescued = await tryDedicatedDownload(conn, ctx, entry);
      if (rescued) return rescued;
    }
    return sendResult(conn, ctx, entry, result);
  } catch (e) {
    if (e && e.code === 'SEARCH_QUERY_TOO_LONG') {
      return conn.sendMessage(ctx.from, { text: e.message }, { quoted: ctx.info });
    }
    if (isIgMediaDownload(entry)) {
      try {
        const rescued = await tryDedicatedDownload(conn, ctx, entry);
        if (rescued) return rescued;
      } catch (fb) {
        logger.logAviso(`API_${entry.cmd}`, fb && fb.message ? fb.message : fb);
      }
    }
    logger.logErro(`API_${entry.cmd}`, e.message);
    const msg = friendlyMediaError ? friendlyMediaError(e) : e.message;
    return conn.sendMessage(ctx.from, {
      text: formatReportBlock(String(entry.cmd || 'API').toUpperCase(), [labelValue('Erro', msg)])
    }, { quoted: ctx.info });
  }
}

function isIgMediaDownload(entry) {
  const c = String(entry.cmd || '');
  const p = String(entry.path || '');
  if (/stalk|followers|following/i.test(c + p)) return false;
  return (
    /\/(dl\/instagram|instagram\/(post|story|highlights))/i.test(p) ||
    /^(instagram2?|igpost|igstory|ighighlights)$/i.test(c)
  );
}

async function tryDedicatedDownload(conn, ctx, entry) {
  if (!isIgMediaDownload(entry)) return null;
  const { downloadInstagram } = require('../services/downloadService');
  const { resolveCtxFreeText } = require('../utils/commandTextParse');
  const params = buildParams(entry, ctx);
  const query = String(resolveCtxFreeText(ctx) || params.url || params.link || ctx.text || '').trim();
  if (!query) return null;
  const media = await downloadInstagram(query);
  if (!media?.mediaBuffer || !zt.isRealMediaBuffer(media.mediaBuffer)) return null;
  const video = media.type === 'video' || /\.mp4/i.test(String(media.mediaUrl || ''));
  logger.logAviso(`API_${entry.cmd}`, 'arquivo via downloader dedicado (ZT sem midia)');
  return sendResult(conn, ctx, entry, {
    kind: 'buffer',
    buffer: media.mediaBuffer,
    contentType: video ? 'video/mp4' : 'image/jpeg'
  });
}

const DEDICATED_DL_CMDS = (() => {
  try {
    return new Set(
      Object.keys(require('./downloads').commands || {}).map((n) => String(n).toLowerCase())
    );
  } catch (_) {
    return new Set(['instagram', 'tiktok', 'play', 'facebook', 'spotify']);
  }
})();

function registerEntry(entry) {
  const names = [entry.cmd, ...(entry.aliases || [])];
  // IAs individuais nao registram cmd proprio — usam .hanork (pool)
  const IA_BLOCK = new Set([
    'gpt', 'gpt4', 'claude', 'gemini', 'geminipro', 'mistral', 'deepseek', 'deepseek_r1',
    'chatgpt', 'chatgpt_5_5', 'gpt4o_mini', 'llama33', 'qwencoder', 'zerotwo', 'hanorkia', 'chatgpt4',
    'chatgpt_auto', 'chatgpt_5_3', 'chatgpt_5_mini', 'chatgpt_5_3_mini',
    'gpt35', 'gpt4o', 'claudesonnet', 'llama31', 'qwen', 'copilot',
    'apertus', 'chateverywhere', 'jeeves', 'krishna', 'overchat', 'quillbot', 'turboseek',
    'chatgpt55', 'gpt4omini'
  ]);
  try {
    const { HANORK_IA_ALIASES } = require('./hanorkChat');
    if (HANORK_IA_ALIASES) {
      for (const id of HANORK_IA_ALIASES) IA_BLOCK.add(id);
    }
  } catch (_) { /* */ }
  try {
    const { IA2_TEXT_MODELS } = require('../core/intent/providerPool');
    if (Array.isArray(IA2_TEXT_MODELS)) {
      for (const id of IA2_TEXT_MODELS) IA_BLOCK.add(String(id).toLowerCase());
    }
  } catch (_) { /* */ }
  for (const name of names) {
    if (!name || commands[name]) continue;
    if (DEDICATED_DL_CMDS.has(String(name).toLowerCase())) continue;
    if (IA_BLOCK.has(String(name).toLowerCase())) continue;
    // Docs ZT listam /consultas/serasa/* mas na API viva query= da 404
    // e o param nomeado devolve stub sem ficha. Consultas reais: CheckData + CEP/CNPJ/IP.
    if (String(entry.category || '') === 'consultas') continue;
    if (!ztCategoryAllowed(entry.category, entry)) continue;
    commands[name] = {
      useCtx: true,
      description: `Hanork API ${entry.category}: ${entry.menuLabel || entry.cmd}`,
      usage: `${name} ${((entry.params || []).filter((p) => p.required).map((p) => `<${p.name}>`).join(' ') || '[args]')}`.trim(),
      ztEntry: entry,
      execute: async (conn, ctx) => executeEntry(conn, ctx, entry)
    };
  }
}

// Menus por categoria (menu_hanork* primario; menu_zt* alias)
const CAT_MENUS = {
  downloads: 'menu_hanorkdownloads',
  montagem: 'menu_hanorkmontagem',
  logos: 'menu_hanorklogos',
  animes: 'menu_hanorkanimes',
  wallpapers: 'menu_hanorkwallpapers',
  pesquisas: 'menu_hanorkpesquisas',
  figurinhas: 'menu_hanorkfigurinhas',
  doramas: 'menu_hanorkdoramas',
  mangas: 'menu_hanorkmangas',
  canvas: 'menu_hanorkcanvas',
  ias: 'menu_hanorkias',
  outros: 'menu_hanorkoutros',
  nsfw: 'menu_hanorknsfw',
  cassino: 'menu_hanorkcassino',
  consultas: 'menu_hanorkconsultas',
  anichin: 'menu_hanorkanichin',
  encontrei: 'menu_hanorkencontrei',
  mcpedl: 'menu_hanorkmcpedl',
  jogos: 'menu_hanorkjogos',
  tinder: 'menu_hanorktinder',
  upload: 'menu_hanorkupload'
};

/** So estas cats aparecem no hub. O resto do catalogo continua registrado (cmd direto). */
const MENU_READY_CATS = new Set(['downloads', 'figurinhas', 'pesquisas']);

function buildCategoryMenuText(cat, prefix) {
  const list = cmdsByCategory(cat);
  const lines = list.map((e) => `${prefix}${e.cmd} — ${e.menuLabel || e.cmd}`);
  return `*Hanork API / ${cat}* (${list.length})\n${lines.join('\n')}`;
}

async function sendCategoryMenuAll(conn, ctx, cat) {
  if (!ztCategoryAllowed(cat)) {
    return conn.sendMessage(ctx.from, { text: 'Categoria indisponivel.' }, { quoted: ctx.info });
  }
  if (!MENU_READY_CATS.has(String(cat || ''))) {
    const p = prefixFromCtx(ctx);
    return conn.sendMessage(ctx.from, {
      text:
        `Essa categoria da API ainda nao esta no menu.\n` +
        `Downloads: ${p}play ${p}tiktok ${p}instagram\n` +
        `Chat: ${p}hanork\n` +
        `Hub: ${p}hanorkapi`
    }, { quoted: ctx.info });
  }
  // Lista interativa (mesmo padrao do menu principal) — fallback texto se botoes OFF
  try {
    const { sendCategoryPanel } = require('../utils/menuCatalog');
    const panel = await sendCategoryPanel(conn, {
      catId: `hanork_${cat}`,
      chatId: ctx.from,
      quoted: ctx.info,
      telegramUserId: ctx.telegramUserId,
      sessionId: ctx.sessionId || conn?._sessionId,
      isGroup: !!ctx.isGroup,
      viewerRole: ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user'),
      viewerCtx: ctx
    });
    if (panel) return panel;
  } catch (_) { /* fallback */ }

  const p = prefixFromCtx(ctx);
  const parts = splitTextParts(buildCategoryMenuText(cat, p), 60000);
  let last = null;
  for (const text of parts) {
    last = await conn.sendMessage(ctx.from, { text }, { quoted: ctx.info });
  }
  return last;
}

for (const [cat, menuCmd] of Object.entries(CAT_MENUS)) {
  const legacy = `menu_zt${cat}`;
  const handler = {
    useCtx: true,
    description: `Menu Hanork API ${cat}`,
    usage: menuCmd,
    execute: async (conn, ctx) => sendCategoryMenuAll(conn, ctx, cat)
  };
  commands[menuCmd] = handler;
  if (!commands[legacy]) commands[legacy] = { ...handler, usage: legacy };
}

async function sendApiRootMenu(conn, ctx) {
  const p = prefixFromCtx(ctx);
  const arg = String(ctx.text || '').trim().toLowerCase();
  if (arg) {
    const entry = byCmd(arg);
    if (entry) return executeEntry(conn, ctx, entry);
    const catKey = arg.replace(/^menu_(hanork|zt)/, '');
    if (CAT_MENUS[arg] || CAT_MENUS[catKey] || Object.keys(CAT_MENUS).includes(arg)) {
      const cat = CAT_MENUS[arg] ? arg : catKey;
      return sendCategoryMenuAll(conn, ctx, cat);
    }
  }
  // Hub interativo: mesma UX do menu principal (lista clicavel)
  try {
    const { sendCategoryPanel } = require('../utils/menuCatalog');
    const panel = await sendCategoryPanel(conn, {
      catId: 'hanorkapi',
      chatId: ctx.from,
      quoted: ctx.info,
      telegramUserId: ctx.telegramUserId,
      sessionId: ctx.sessionId || conn?._sessionId,
      isGroup: !!ctx.isGroup,
      viewerRole: ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user'),
      viewerCtx: ctx
    });
    if (panel) return panel;
  } catch (_) { /* fallback texto */ }

  const cat = loadCatalog();
  const lines = Object.entries(cat.byCategory || {})
    .filter(([k]) => MENU_READY_CATS.has(k))
    .map(([k, n]) => `• ${p}menu_hanork${k} (${n})`)
    .join('\n');
  const root =
    `*Hanork API*\n` +
    `No menu: downloads, figurinhas, pesquisas.\n` +
    `O resto do catalogo nao aparece (ainda nao testado). Chat: ${p}hanork\n\n` +
    `${lines || '(vazio)'}\n\n` +
    `Uso: ${p}play | ${p}tiktok | ${p}hanork`;
  const parts = splitTextParts(root, 60000);
  let last = null;
  for (const text of parts) {
    last = await conn.sendMessage(ctx.from, { text }, { quoted: ctx.info });
  }
  return last;
}

// Menu da API: hanorkapi / zt — o chat IA e .hanork em commands/hanorkChat.js
commands.hanorkapi = {
  useCtx: true,
  description: 'Menu Hanork API (cats testadas)',
  usage: 'hanorkapi [categoria|cmd]',
  execute: sendApiRootMenu
};
commands.zt = {
  useCtx: true,
  description: 'Alias de hanorkapi (menu API)',
  usage: 'zt [categoria|cmd]',
  execute: sendApiRootMenu
};

const infoHandler = {
  useCtx: true,
  description: 'Info de um comando do catalogo Hanork API',
  usage: 'hanorkinfo <cmd>',
  execute: async (conn, ctx) => {
    const name = String(ctx.text || ctx.args?.[0] || '').trim();
    const e = byCmd(name);
    if (!e) {
      return conn.sendMessage(ctx.from, { text: 'Cmd nao encontrado no catalogo Hanork API.' }, { quoted: ctx.info });
    }
    await conn.sendMessage(ctx.from, {
      text:
        `*${e.cmd}*\n` +
        `Cat: ${e.category}\n` +
        `Path: ${e.path}\n` +
        `Perm: ${e.permission}\n` +
        `Resp: ${e.response}\n` +
        `NSFW: ${e.nsfw ? 'sim' : 'nao'}`
    }, { quoted: ctx.info });
  }
};
commands.hanorkinfo = infoHandler;
commands.ztinfo = { ...infoHandler, usage: 'ztinfo <cmd>' };

// registra todos do catalogo
for (const entry of allEntries()) {
  registerEntry(entry);
}

module.exports = { commands, executeEntry, byCmd };
