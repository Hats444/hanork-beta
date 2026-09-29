'use strict';
/**
 * Modulo DK / entrardk — independente da divulgacao.
 *
 * Isolamento: este arquivo NAO importa divulgacao, divulgacaoAuto, divulgacaoGroupGap,
 * statuspost, groupStatusV2, joinService, nem writeMediaFile da DIV.
 *
 * Modo 1 (`dk`): neste grupo — 1) bolha nativa de pagamento (nao texto)
 *    + mencao de nao-admins  2) fotos do status DK. Sem confirmacao.
 *
 * Modo 2 (`dk N texto`): N vezes o texto + midia do modo repeticao. Teto = HEAVY (12).
 * Delay: utils.delay generico (nao o gap da DIV).
 *
 * entrardk: MESMO grupo — ciclo entra → posta ate BATCH (5) → sai → entra de novo
 * ate o total N. Sem N: 1 visita de 5 (ou qtd gravada). So grupo aberto
 * (joinApprovalMode). Join/leave direto no Baileys.
 */
const logger = require('../logger');
const crypto = require('crypto');
const { isGroup, delay } = require('../utils');
const { previewText, stripAccents } = require('../utils/typography');
const { prefixFromCtx, displayPrefix } = require('../utils/configManager');
const dkStore = require('../utils/dkStore');
const { captureDkMedia } = require('../utils/dkMedia');
const { listNonAdminMentions } = require('../utils/dkMembers');

const DK_MAX_N = dkStore.MAX_QTD;
const DK_BATCH = dkStore.BATCH;
const BLAST = { skipForward: true, _hanorkTrusted: true };
const REPEAT_GAP_MS = 1600;
const JOIN_GAP_MS = 1800;
const MENTION_CAP = 80;
/** proto ContextInfo.StatusSourceType.TEXT — dump live veio numero 4. */
const STATUS_SOURCE_TEXT = 4;
const runningEnter = new Set();

const INVITE_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:chat\.whatsapp\.com\/(?:invite\/)?|wa\.me\/g\/|whatsapp\.com\/(?:chat|invite)\/)([A-Za-z0-9_-]{8,64})/gi;

const commands = {};

function parseDkArgs(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a || '').trim()).filter(Boolean) : [];
  if (!list.length) return { mode: 1 };
  const raw = String(list[0] || '').trim();
  if (!/^\d+$/.test(raw)) return { mode: 'usage' };
  return { mode: 2, n: parseInt(raw, 10), text: list.slice(1).join(' ').trim() };
}

function parseEntrardkArgs(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a || '').trim()).filter(Boolean) : [];
  let n = null;
  let rest = list;
  if (list.length && /^\d+$/.test(list[0])) {
    n = parseInt(list[0], 10);
    rest = list.slice(1);
  }
  return { n, restText: rest.join(' ') };
}

function say(conn, ctx, text) {
  const body = previewText(stripAccents(String(text || '').trim()));
  if (!body) return null;
  return conn.sendMessage(ctx.from, { text: body }, { quoted: ctx.info });
}

function sessionUid(ctx, conn) {
  return ctx.telegramUserId || conn?._telegramUserId || null;
}

function isChannelChat(ctx) {
  if (ctx?.isChannel) return true;
  const jid = String(ctx?.from || '');
  return /@newsletter$/i.test(jid);
}

function face(text) {
  return previewText(stripAccents(String(text || '').trim()));
}

function inviteRequiresApproval(info) {
  if (!info || typeof info !== 'object') return false;
  const raw = info.joinApprovalMode ?? info.membershipApprovalMode ?? info.isMembershipApprovalEnabled
    ?? info.joinApproval ?? info.memberApprovalMode;
  if (raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'on') return true;
  if (raw && typeof raw === 'object') {
    if (raw.enabled === true || raw.mode === true || raw.value === true) return true;
    const s = String(raw.mode || raw.state || '').toLowerCase();
    if (s === 'on' || s === 'true' || s === 'required' || s === 'approval') return true;
  }
  return false;
}

function asGroupJid(raw) {
  if (!raw) return '';
  if (typeof raw === 'object') {
    return asGroupJid(raw.id || raw.jid || raw.gid || raw.groupJid);
  }
  const s = String(raw).trim();
  if (/@g\.us$/i.test(s)) return s;
  const user = s.replace(/@.*$/, '').split(':')[0];
  if (/^\d{8,}$/.test(user)) return `${user}@g.us`;
  return '';
}

function alreadyMemberError(e) {
  const s = String(e?.message || e || '').toLowerCase();
  const code = e?.output?.statusCode || e?.status || e?.data || '';
  if (Number(code) === 409) return true;
  return /already|is.?participant|already.?member|conflict/i.test(s);
}

function extractInviteCode(text) {
  const blob = String(text || '');
  const flat = blob.replace(
    /(chat\.whatsapp\.com\/(?:invite\/)?|wa\.me\/g\/|whatsapp\.com\/(?:chat|invite)\/)\s+/gi,
    '$1'
  );
  INVITE_RE.lastIndex = 0;
  const m = INVITE_RE.exec(flat);
  const code = m && m[1] ? String(m[1]).split(/[?#/]/)[0] : '';
  if (!code || code.length < 8 || code.length > 64) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(code)) return '';
  if (/^(invite|add|join|chat|www)$/i.test(code)) return '';
  return code;
}

function pickInviteCode(ctx, extraText) {
  const chunks = [
    extraText,
    ctx?.text,
    (ctx?.args || []).join(' '),
    ctx?.body,
    ctx?.quoted?.text
  ];
  for (const c of chunks) {
    const code = extractInviteCode(c);
    if (code) return code;
  }
  const proto = ctx?.info?.message || ctx?.msg?.message || ctx?.quoted?.message;
  const inv = proto?.groupInviteMessage?.inviteCode
    || proto?.ephemeralMessage?.message?.groupInviteMessage?.inviteCode;
  if (inv) return extractInviteCode(`https://chat.whatsapp.com/${inv}`) || String(inv);
  return '';
}

/**
 * Bolha nativa — mesma forma da Duda / groupPaymentPost:
 * relay cru de requestPaymentMessage (amount + expiry 0).
 * sendMessage/hzxx esvazia a note e o Zap pinta como texto.
 * FromContent tambem — nao usar.
 */
function paymentPayload(text, mentions) {
  const mentionedJid = [...new Set((mentions || []).map(String).filter(Boolean))].slice(0, MENTION_CAP);
  const extendedTextMessage = { text: String(text || '') };
  if (mentionedJid.length) {
    extendedTextMessage.contextInfo = {
      mentionedJid,
      forwardingScore: 999,
      isForwarded: true
    };
  }
  return {
    requestPaymentMessage: {
      currencyCodeIso4217: 'BRL',
      amount1000: '0',
      noteMessage: { extendedTextMessage },
      expiryTimestamp: '0',
      amount: {
        value: '0',
        offset: 0,
        currencyCode: 'BRL'
      }
    }
  };
}

function makeDkMsgId(conn) {
  try {
    const { generateMessageIDV2 } = require('@systemzero/baileys');
    if (typeof generateMessageIDV2 === 'function') return generateMessageIDV2(conn?.user?.id);
  } catch (_) { /* fallback */ }
  return `3EB0${crypto.randomBytes(9).toString('hex').toUpperCase()}`;
}

async function sendDkPay(conn, groupJid, text, mentions) {
  const body = String(text || '').trim();
  if (!body) {
    logger.logErro('dk-pay', 'texto vazio — aborta etapa de pagamento');
    throw new Error('pay_text vazio');
  }
  const mentionedJid = [...new Set((mentions || []).map(String).filter(Boolean))].slice(0, MENTION_CAP);
  logger.logInfo(`[dk] pay start mentions=${mentionedJid.length} jid=${String(groupJid || '').slice(-8)}`);

  const payload = paymentPayload(body, mentionedJid);
  if (!payload.requestPaymentMessage) {
    throw new Error('proto pagamento invalido');
  }
  await conn.relayMessage(groupJid, payload, {
    messageId: makeDkMsgId(conn),
    skipForward: true,
    _hanorkTrusted: true,
    _hanorkAllowPayment: true,
    useCachedGroupMetadata: true
  });
  logger.logInfo(`[dk] pay native ok mentions=${mentionedJid.length}`);
  return { kind: 'native', mentions: mentionedJid.length };
}

async function sendDkStatusPhotos(conn, groupJid, packs) {
  const photos = (packs || []).filter((p) => p?.buffer && String(p.tipo || 'image') === 'image');
  if (!photos.length) {
    logger.logErro('dk-status', 'nenhuma foto na lista — etapa de status nao dispara');
    throw new Error('status sem foto');
  }
  let sent = 0;
  for (let i = 0; i < photos.length; i += 1) {
    if (i > 0) await delay(REPEAT_GAP_MS);
    const pack = photos[i];
    await conn.sendMessage(groupJid, {
      image: pack.buffer,
      mimetype: pack.mimetype || 'image/jpeg',
      groupStatus: true,
      contextInfo: {
        isGroupStatus: true,
        statusSourceType: STATUS_SOURCE_TEXT
      }
    }, {
      skipForward: true,
      _hanorkTrusted: true,
      useCachedGroupMetadata: true,
      messageId: makeDkMsgId(conn)
    });
    sent += 1;
  }
  logger.logInfo(`[dk] status photos sent=${sent}/${photos.length}`);
  return sent;
}

async function sendRepeatUnit(conn, chatId, text, pack) {
  const caption = face(text);
  if (!pack?.buffer) {
    if (!caption) throw new Error('vazio');
    return conn.sendMessage(chatId, { text: caption }, BLAST);
  }
  const tipo = String(pack.tipo || 'image').toLowerCase();
  if (tipo === 'video' || tipo === 'gif') {
    return conn.sendMessage(chatId, {
      video: pack.buffer,
      gifPlayback: tipo === 'gif',
      caption,
      mimetype: pack.mimetype || 'video/mp4'
    }, BLAST);
  }
  return conn.sendMessage(chatId, {
    image: pack.buffer,
    caption,
    mimetype: pack.mimetype || 'image/jpeg'
  }, BLAST);
}

async function sendRepeatTimes(conn, chatId, times, text, pack) {
  let sent = 0;
  for (let i = 0; i < times; i += 1) {
    if (i > 0) await delay(REPEAT_GAP_MS);
    await sendRepeatUnit(conn, chatId, text, pack);
    sent += 1;
  }
  return sent;
}

function yesNo(ok) {
  return ok ? 'sim' : 'nao';
}

async function sendDkMenu(conn, ctx) {
  const uid = sessionUid(ctx, conn);
  const p = prefixFromCtx(ctx) || '.';
  const row = await dkStore.load(uid);
  const photos = await dkStore.listStatus(uid);
  const pack = dkStore.repeatPack(uid, row);
  const dest = ctx.from || ctx.chatId || '';
  const telegramUserId = ctx.telegramUserId || conn?._telegramUserId;
  const sessionId = ctx.sessionId || conn?._sessionId;
  const prefix = conn?._isTelegramShim ? '/' : displayPrefix(telegramUserId);
  const intro = previewText(
    `Menu DK\nPrefixo: ${prefix}\n\n` +
    `Texto de pagamento: ${yesNo(!!String(row.pay_text || '').trim())}\n` +
    `Fotos do status: ${photos.length}\n` +
    `Texto do modo repeticao: ${yesNo(!!String(row.repeat_text || '').trim())}\n` +
    `Midia do modo repeticao: ${yesNo(!!pack?.buffer)}\n` +
    `Quantidade do entrar: ${row.qtd}\n` +
    `Por visita o bot manda ${DK_BATCH}, sai e entra de novo no mesmo grupo.`
  );
  const items = [
    { name: 'dk', desc: 'Pagamento nativo + status (fotos), ou dk N texto', usage: 'dk' },
    { name: 'entrardk', desc: 'Entra no grupo aberto, posta, sai e entra de novo', usage: 'entrardk 7 <link>' },
    { name: 'dkpay', desc: 'Texto da mensagem de pagamento', usage: 'dkpay <texto>' },
    { name: 'msgdk', desc: 'Texto padrao do modo repeticao', usage: 'msgdk <texto>' },
    { name: 'fotodk', desc: 'Adiciona foto na lista do status', usage: 'fotodk' },
    { name: 'listfotodk', desc: 'Lista as fotos do status', usage: 'listfotodk' },
    { name: 'rmfotodk', desc: 'Remove foto n do status', usage: 'rmfotodk 1' },
    { name: 'dkmidia', desc: 'Midia do modo repeticao (responda)', usage: 'dkmidia' },
    { name: 'apagardk', desc: 'Apaga so a midia do modo repeticao', usage: 'apagardk' },
    { name: 'qtddk', desc: 'Total de postagens do entrar', usage: 'qtddk 7' }
  ];
  const { rowFromCatalogItem } = require('../utils/menuCatalog');
  const { sendInteractiveList, sendButtonlessFallback } = require('../helpers');
  const { areButtonsOn } = require('../utils/sessionRegistry');
  const buttonsOn = areButtonsOn(sessionId, telegramUserId) && !conn?._isTelegramShim;
  const lines = [intro, '', previewText('Comandos')];
  for (const it of items) {
    lines.push(previewText(`${p}${it.usage} — ${it.desc}`));
  }
  const fullText = lines.join('\n');
  if (!buttonsOn) {
    return sendButtonlessFallback(conn, dest, {
      text: fullText,
      quoted: ctx.info,
      telegramUserId,
      sessionId
    });
  }
  return sendInteractiveList(
    conn,
    dest,
    intro,
    [{
      title: 'DK',
      rows: items.map((it) => rowFromCatalogItem(it, prefix))
    }],
    'Hanork Bot',
    ctx.info,
    'menu.jpg',
    telegramUserId,
    sessionId
  );
}

async function joinOpenGroup(conn, code) {
  if (!conn || typeof conn.groupGetInviteInfo !== 'function') {
    throw new Error('groupGetInviteInfo indisponivel');
  }
  const info = await conn.groupGetInviteInfo(code);
  if (inviteRequiresApproval(info)) {
    const err = new Error('approval');
    err.code = 'approval';
    throw err;
  }
  let jid = asGroupJid(info);
  let already = false;
  try {
    if (typeof conn.groupAcceptInvite !== 'function') {
      throw new Error('groupAcceptInvite indisponivel');
    }
    const result = await conn.groupAcceptInvite(code);
    jid = asGroupJid(result) || jid;
  } catch (e) {
    if (alreadyMemberError(e)) {
      already = true;
      if (!jid) {
        const again = await conn.groupGetInviteInfo(code);
        jid = asGroupJid(again);
      }
    } else {
      throw e;
    }
  }
  jid = asGroupJid(jid);
  if (!jid) {
    const err = new Error('sem grupo');
    err.code = 'nojid';
    throw err;
  }
  return { jid, already };
}

async function leaveGroup(conn, jid) {
  if (!jid || typeof conn.groupLeave !== 'function') return;
  try {
    await conn.groupLeave(jid);
  } catch (e) {
    logger.logErro('dk-leave', e);
  }
}

async function runMode1(conn, ctx, uid, p) {
  const cfg = await dkStore.load(uid);
  const payText = String(cfg.pay_text || '').trim();
  const photos = await dkStore.statusPacks(uid);
  const missing = [];
  if (!payText) missing.push(`texto de pagamento (${p}dkpay)`);
  if (!photos.length) missing.push(`foto do status (${p}fotodk)`);
  if (missing.length) {
    return say(conn, ctx, `Falta configurar: ${missing.join(' e ')}. Abre ${p}menu_dk.`);
  }
  try {
    const listed = await listNonAdminMentions(conn, ctx.from);
    logger.logInfo(
      `[dk] pay mentions=${listed.mentions.length} adminSkip=${listed.adminN} total=${listed.total}`
    );
    await sendDkPay(conn, ctx.from, payText, listed.mentions);
  } catch (e) {
    logger.logErro('dk-pay', e);
    return say(conn, ctx, 'Nao consegui mandar o pagamento. Confere o texto no menu DK e tenta de novo.');
  }
  await delay(400);
  try {
    await sendDkStatusPhotos(conn, ctx.from, photos);
  } catch (e) {
    logger.logErro('dk-status', e);
    return say(conn, ctx, 'O pagamento saiu. O status nao. Confere as fotos no menu DK.');
  }
  return null;
}

async function runMode2(conn, ctx, uid, p, n, freeText) {
  if (!Number.isFinite(n) || n < 1 || n > DK_MAX_N) {
    return say(conn, ctx, `Quantidade invalida. Use de 1 a ${DK_MAX_N}.`);
  }
  const cfg = await dkStore.load(uid);
  const body = String(freeText || '').trim() || String(cfg.repeat_text || '').trim();
  const pack = dkStore.repeatPack(uid, cfg);
  const missing = [];
  if (!body) missing.push(`texto (${p}dk 9 seu texto ou ${p}msgdk)`);
  if (!pack?.buffer) missing.push(`midia do modo repeticao (${p}dkmidia)`);
  if (missing.length) {
    return say(conn, ctx, `Falta configurar: ${missing.join(' e ')}.`);
  }
  try {
    await sendRepeatTimes(conn, ctx.from, n, body, pack);
  } catch (e) {
    logger.logErro('dk-repeat', e);
    return say(conn, ctx, 'Nao consegui repetir. Tenta de novo daqui a pouco.');
  }
  return null;
}

commands.dk = {
  useCtx: true,
  description: 'Neste grupo: pagamento nativo + status (fotos), ou dk N texto',
  usage: 'dk | dk <n> <texto>',
  execute: async (conn, ctx) => {
    const p = prefixFromCtx(ctx) || '.';
    if (isChannelChat(ctx) || !isGroup(ctx.from)) {
      return say(conn, ctx, `So em grupo. Menu: ${p}menu_dk`);
    }
    const uid = sessionUid(ctx, conn);
    if (!uid) return say(conn, ctx, 'Sessao sem dono.');
    const parsed = parseDkArgs(ctx.args);
    if (parsed.mode === 'usage') {
      return say(conn, ctx, `${p}dk — pagamento + status neste grupo\n${p}dk 9 texto — repete 9 vezes\n${p}menu_dk — config`);
    }
    if (parsed.mode === 1) return runMode1(conn, ctx, uid, p);
    return runMode2(conn, ctx, uid, p, parsed.n, parsed.text);
  }
};

commands.entrardk = {
  useCtx: true,
  description: 'Entra em grupo aberto, manda o DK de repeticao, sai e entra de novo ate o total',
  usage: 'entrardk [n] <link>',
  execute: async (conn, ctx) => {
    const p = prefixFromCtx(ctx) || '.';
    const uid = sessionUid(ctx, conn);
    if (!uid) return say(conn, ctx, 'Sessao sem dono.');
    if (runningEnter.has(uid)) {
      return say(conn, ctx, 'Ja tem um entrar DK rodando nesta sessao.');
    }
    const parsed = parseEntrardkArgs(ctx.args);
    const row = await dkStore.load(uid);
    let total = parsed.n != null ? parsed.n : row.qtd;
    if (!Number.isFinite(total) || total < 1 || total > DK_MAX_N) {
      return say(conn, ctx, `Quantidade invalida. Use de 1 a ${DK_MAX_N}. Ex: ${p}entrardk 7 <link>`);
    }
    const code = pickInviteCode(ctx, parsed.restText);
    if (!code) {
      return say(conn, ctx, `Manda o link do grupo. Ex: ${p}entrardk 7 https://chat.whatsapp.com/...`);
    }
    const pack = dkStore.repeatPack(uid, row);
    const texto = String(row.repeat_text || '').trim();
    if (!pack?.buffer || !texto) {
      return say(conn, ctx, `Falta texto e midia do modo repeticao. ${p}msgdk e ${p}dkmidia, depois ${p}menu_dk`);
    }
    if (parsed.n != null) {
      try { await dkStore.save(uid, { qtd: total }); } catch (_) { /* */ }
    }
    runningEnter.add(uid);
    let startedIn = false;
    let jid = '';
    let sent = 0;
    try {
      const first = await joinOpenGroup(conn, code);
      jid = first.jid;
      startedIn = first.already;
      await delay(900);
      while (sent < total) {
        if (sent > 0) {
          const again = await joinOpenGroup(conn, code);
          jid = again.jid;
          await delay(900);
        }
        const chunk = Math.min(DK_BATCH, total - sent);
        const n = await sendRepeatTimes(conn, jid, chunk, texto, pack);
        sent += n;
        const more = sent < total;
        if (more || !startedIn) {
          await delay(600);
          await leaveGroup(conn, jid);
          if (more) await delay(JOIN_GAP_MS);
        }
      }
      if (startedIn) {
        try { await joinOpenGroup(conn, code); } catch (e) {
          logger.logAviso(`[dk] rejoin: ${e.message}`);
        }
      }
      return say(conn, ctx, `Pronto. Mandei ${sent}.`);
    } catch (e) {
      if (jid && !startedIn) {
        try { await leaveGroup(conn, jid); } catch (_) { /* */ }
      }
      if (e && e.code === 'approval') {
        return say(conn, ctx, 'Esse grupo pede solicitacao pra entrar. So funciona se for aberto.');
      }
      logger.logErro('entrardk', e);
      const kind = String(e.message || e);
      if (/expired|not-found|invalid/i.test(kind)) {
        return say(conn, ctx, 'Link invalido ou vencido.');
      }
      return say(conn, ctx, 'Nao consegui entrar ou mandar. Confere se o grupo e aberto.');
    } finally {
      runningEnter.delete(uid);
    }
  }
};

async function textFieldCmd(conn, ctx, field, emptyHint) {
  const p = prefixFromCtx(ctx) || '.';
  const uid = sessionUid(ctx, conn);
  const text = String(ctx.text || (ctx.args || []).join(' ') || '').trim();
  if (!text) {
    const row = await dkStore.load(uid);
    const cur = String(row[field] || '').trim();
    return say(conn, ctx, cur ? `Texto atual:\n${cur}` : emptyHint.replace(/\{p\}/g, p));
  }
  await dkStore.save(uid, { [field]: text });
  return say(conn, ctx, `Texto gravado.\nVer: ${p}menu_dk`);
}

commands.dkpay = {
  useCtx: true,
  description: 'Texto da mensagem de pagamento do DK',
  usage: 'dkpay <texto>',
  execute: async (conn, ctx) => textFieldCmd(conn, ctx, 'pay_text', 'Manda o texto. Ex: {p}dkpay pix na chave do cardapio')
};
commands.msgdkpay = commands.dkpay;

commands.msgdk = {
  useCtx: true,
  description: 'Texto padrao do modo repeticao do DK',
  usage: 'msgdk <texto>',
  execute: async (conn, ctx) => textFieldCmd(conn, ctx, 'repeat_text', 'Manda o texto. Ex: {p}msgdk promocao de hoje')
};

commands.qtddk = {
  useCtx: true,
  description: 'Quantas vezes o entrar DK manda no total',
  usage: 'qtddk <n>',
  execute: async (conn, ctx) => {
    const p = prefixFromCtx(ctx) || '.';
    const uid = sessionUid(ctx, conn);
    const n = parseInt((ctx.args && ctx.args[0]) || '', 10);
    if (!Number.isFinite(n) || n < 1 || n > DK_MAX_N) {
      const row = await dkStore.load(uid);
      return say(conn, ctx, `Agora: ${row.qtd}. Use ${p}qtddk 7 (1 a ${DK_MAX_N}).`);
    }
    await dkStore.save(uid, { qtd: n });
    return say(conn, ctx, `Quantidade do entrar: ${n}. Por visita manda ${DK_BATCH}.`);
  }
};

commands.fotodk = {
  useCtx: true,
  description: 'Adiciona foto na lista do status DK (mande ou responda)',
  usage: 'fotodk',
  execute: async (conn, ctx) => {
    const p = prefixFromCtx(ctx) || '.';
    const uid = sessionUid(ctx, conn);
    const captured = await captureDkMedia(ctx, 'image');
    if (!captured) return say(conn, ctx, `Responda uma foto com ${p}fotodk`);
    try {
      await dkStore.addStatus(uid, captured);
    } catch (e) {
      if (e && e.code === 'status_cap') {
        return say(conn, ctx, `Limite de ${dkStore.MAX_STATUS} fotos. ${p}rmfotodk 1 pra tirar uma.`);
      }
      logger.logErro('dk-fotodk', e);
      return say(conn, ctx, 'Nao consegui gravar a foto.');
    }
    const rows = await dkStore.listStatus(uid);
    return say(conn, ctx, `Foto ${rows.length} gravada no status. ${p}menu_dk`);
  }
};

commands.listfotodk = {
  useCtx: true,
  description: 'Lista as fotos do status DK',
  usage: 'listfotodk',
  execute: async (conn, ctx) => {
    const p = prefixFromCtx(ctx) || '.';
    const uid = sessionUid(ctx, conn);
    const rows = await dkStore.listStatus(uid);
    if (!rows.length) return say(conn, ctx, `Nenhuma foto. Responda uma com ${p}fotodk`);
    return say(conn, ctx, `${rows.length} foto(s) no status. Remover: ${p}rmfotodk 1`);
  }
};

commands.rmfotodk = {
  useCtx: true,
  description: 'Remove foto n da lista do status DK',
  usage: 'rmfotodk [n]',
  execute: async (conn, ctx) => {
    const p = prefixFromCtx(ctx) || '.';
    const uid = sessionUid(ctx, conn);
    const n = parseInt((ctx.args && ctx.args[0]) || '1', 10);
    const ok = await dkStore.removeStatus(uid, n);
    if (!ok) return say(conn, ctx, `Numero invalido. ${p}listfotodk`);
    return say(conn, ctx, `Foto ${n} removida.`);
  }
};

async function saveRepeatMediaCmd(conn, ctx, kind) {
  const p = prefixFromCtx(ctx) || '.';
  const uid = sessionUid(ctx, conn);
  const captured = await captureDkMedia(ctx, kind);
  if (!captured) {
    return say(conn, ctx, kind === 'video'
      ? `Responda um video com ${p}videodk`
      : `Responda uma foto ou video com ${p}dkmidia`);
  }
  const meta = dkStore.saveRepeatMedia(uid, captured);
  if (!meta) return say(conn, ctx, 'Nao consegui gravar a midia.');
  await dkStore.save(uid, meta);
  return say(conn, ctx, `Midia do modo repeticao gravada. ${p}menu_dk`);
}

commands.dkmidia = {
  useCtx: true,
  description: 'Grava a midia do modo repeticao (responda foto ou video)',
  usage: 'dkmidia',
  execute: async (conn, ctx) => {
    const img = await captureDkMedia(ctx, 'image');
    if (img) {
      ctx._dkCaptured = img;
      const p = prefixFromCtx(ctx) || '.';
      const uid = sessionUid(ctx, conn);
      const meta = dkStore.saveRepeatMedia(uid, img);
      await dkStore.save(uid, meta);
      return say(conn, ctx, `Midia do modo repeticao gravada. ${p}menu_dk`);
    }
    return saveRepeatMediaCmd(conn, ctx, 'video');
  }
};

commands.videodk = {
  useCtx: true,
  description: 'Grava video do modo repeticao (responda)',
  usage: 'videodk',
  execute: async (conn, ctx) => saveRepeatMediaCmd(conn, ctx, 'video')
};

commands.apagardk = {
  useCtx: true,
  description: 'Apaga so a midia do modo repeticao',
  usage: 'apagardk',
  execute: async (conn, ctx) => {
    const p = prefixFromCtx(ctx) || '.';
    const uid = sessionUid(ctx, conn);
    await dkStore.clearRepeatMedia(uid);
    return say(conn, ctx, `Midia do modo repeticao apagada. ${p}dkmidia pra gravar outra.`);
  }
};

commands.menu_dk = {
  useCtx: true,
  description: 'Menu do DK: o que esta gravado e os comandos',
  usage: 'menu_dk',
  execute: async (conn, ctx) => sendDkMenu(conn, ctx)
};
commands.dkmenu = commands.menu_dk;
commands.menudk = commands.menu_dk;

module.exports = {
  commands,
  parseDkArgs,
  parseEntrardkArgs,
  DK_MAX_N,
  DK_BATCH,
  inviteRequiresApproval,
  extractInviteCode,
  paymentPayload
};
