'use strict';
/** Boas-vindas / saida personalizaveis (Duda + Zero Two). Sem frase padrao inutil. */

const GENERIC_WELCOME = 'Bem-vindo(a) @user ao grupo!';
const GENERIC_LEAVE = '@user saiu do grupo.';

function isGenericTemplate(text, kind) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (kind === 'leave') return s === GENERIC_LEAVE;
  return s === GENERIC_WELCOME;
}

function horaBrt() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());
}

function tempoBrt() {
  const h = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false
    }).format(new Date())
  );
  if (h < 12) return 'bom dia';
  if (h < 18) return 'boa tarde';
  return 'boa noite';
}

function fillPlaceholders(template, ctx) {
  const jid = String(ctx.jid || '');
  const num = jid.split('@')[0] || '';
  const mention = num ? `@${num}` : '';
  const groupName = String(ctx.groupName || '');
  const prefix = String(ctx.prefix || '.');
  const map = {
    '@user': mention,
    '@grupo': groupName,
    '@group': groupName,
    '#numerodele#': mention,
    '#nomedogp#': groupName,
    '#hora#': horaBrt(),
    '#tempo#': tempoBrt(),
    '#prefixo#': prefix,
    '#prefix#': prefix,
    '#descrição#': String(ctx.groupDesc || ''),
    '#descricao#': String(ctx.groupDesc || ''),
    '#nomebot#': String(ctx.botName || 'Hanork'),
    '#wame#': num ? `wa.me/${num}` : '',
    '#numero#': num
  };
  let out = String(template || '');
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  out = out.replace(/>\s*prefixo\b/gi, prefix);
  out = out.replace(/\{prefixo\}/gi, prefix);
  out = out.replace(/\{prefix\}/gi, prefix);
  out = out.replace(/#\w+#/g, '');
  return out.trim();
}

function mediaKind(isAdd, slot) {
  if (slot === 'foto') return isAdd ? 'foto' : 'foto_saiu';
  if (slot === 'fig') return isAdd ? 'fig' : 'fig_saiu';
  return isAdd ? 'audio' : 'audio_saiu';
}

async function loadBundle(telegramUserId, groupId, isAdd) {
  const shop = require('./shopStore');
  const [foto, fig, audio] = await Promise.all([
    shop.getWelcomeMedia(telegramUserId, groupId, mediaKind(isAdd, 'foto')),
    shop.getWelcomeMedia(telegramUserId, groupId, mediaKind(isAdd, 'fig')),
    shop.getWelcomeMedia(telegramUserId, groupId, mediaKind(isAdd, 'audio'))
  ]);
  return { foto, fig, audio };
}

async function sendStickerBuf(conn, groupId, item) {
  if (!item || !item.data) return;
  if (/webp/i.test(item.mime || '')) {
    await conn.sendMessage(groupId, { sticker: item.data });
    return;
  }
  const { sendSticker } = require('../services/stickerService');
  await sendSticker(conn, groupId, item.data, null, { kind: 'image' });
}

async function sendWelcomeLeave(conn, opts) {
  const groupId = String(opts.groupId || '');
  const jid = String(opts.jid || '');
  const telegramUserId = opts.telegramUserId;
  const flags = opts.flags || {};
  const lists = opts.lists || {};
  const isAdd = opts.action === 'add';
  if (!groupId.endsWith('@g.us') || !jid) return false;
  if (isAdd && !flags.bemvindo) return false;
  if (!isAdd && !flags.saiu) return false;

  const textRaw = isAdd ? lists.welcomeText : lists.leaveText;
  const customText = !isGenericTemplate(textRaw, isAdd ? 'welcome' : 'leave');
  const media = await loadBundle(telegramUserId, groupId, isAdd);
  if (!customText && !media.foto && !media.fig && !media.audio) return false;

  let groupName = groupId;
  let groupDesc = '';
  try {
    const { peekGroupMetadata, getCachedGroupMetadata } = require('./groupMetaCache');
    const meta = peekGroupMetadata(groupId) || await getCachedGroupMetadata(conn, groupId).catch(() => null);
    if (meta?.subject) groupName = meta.subject;
    if (meta?.desc) groupDesc = String(meta.desc).slice(0, 400);
  } catch (_) { /* */ }

  let prefix = '.';
  try {
    prefix = require('./configManager').getPrefix(telegramUserId) || '.';
  } catch (_) { /* */ }

  const text = customText
    ? fillPlaceholders(textRaw, {
      jid,
      groupName,
      groupDesc,
      prefix,
      botName: conn?.user?.name || 'Hanork'
    })
    : '';

  const mentions = [jid];
  try {
    if (media.foto && media.foto.data) {
      await conn.sendMessage(groupId, {
        image: media.foto.data,
        caption: text || undefined,
        mentions
      });
    } else if (text) {
      await conn.sendMessage(groupId, { text, mentions });
    }
  } catch (e) {
    require('../logger').logAviso(`[WELCOME] texto/foto: ${e.message}`);
  }
  try {
    if (media.fig) await sendStickerBuf(conn, groupId, media.fig);
  } catch (e) {
    require('../logger').logAviso(`[WELCOME] fig: ${e.message}`);
  }
  try {
    if (media.audio && media.audio.data) {
      await conn.sendMessage(groupId, {
        audio: media.audio.data,
        mimetype: media.audio.mime || 'audio/mpeg',
        ptt: true
      });
    }
  } catch (e) {
    require('../logger').logAviso(`[WELCOME] audio: ${e.message}`);
  }
  return true;
}

function howto(p) {
  return (
    `Nada de frase padrao. Voce monta o BV.\n` +
    `Texto: ${p}legendabv Oi @user no @grupo\n` +
    `Foto: ${p}fotobv (responda a foto)\n` +
    `Fig: ${p}figbv (responda)\n` +
    `Audio: ${p}audiobv (responda)\n` +
    `Saida: ${p}legendasaiu · ${p}fotosaida · ${p}figsaida · ${p}audiosaida\n` +
    `Tags: @user @grupo #hora# #tempo# #prefixo# (ou > prefixo) #nomedogp# #numerodele#\n` +
    `Tirar midia: ${p}fotobv off`
  );
}

async function statusLines(telegramUserId, groupId, lists) {
  const shop = require('./shopStore');
  const on = async (k) => {
    const row = await shop.getWelcomeMedia(telegramUserId, groupId, k);
    return row && row.data ? 'ok' : 'nao';
  };
  const w = isGenericTemplate(lists?.welcomeText, 'welcome') ? 'nao' : 'ok';
  const s = isGenericTemplate(lists?.leaveText, 'leave') ? 'nao' : 'ok';
  const [f, g, a, fs, gs, as] = await Promise.all([
    on('foto'), on('fig'), on('audio'), on('foto_saiu'), on('fig_saiu'), on('audio_saiu')
  ]);
  return [
    `Entrada — texto ${w} · foto ${f} · fig ${g} · audio ${a}`,
    `Saida — texto ${s} · foto ${fs} · fig ${gs} · audio ${as}`
  ].join('\n');
}

module.exports = {
  GENERIC_WELCOME,
  GENERIC_LEAVE,
  isGenericTemplate,
  fillPlaceholders,
  sendWelcomeLeave,
  howto,
  statusLines
};
