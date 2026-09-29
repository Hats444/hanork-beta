'use strict';
/**
 * Aviso Telegram com foto do menu: edita a mesma mensagem enquanto a chave nao muda.
 * Nao usa o cache do menu principal (senao o recado diario apaga o menu).
 */

const logger = require('../logger');

function parseStored(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && raw.messageId) return raw;
  try {
    const o = JSON.parse(String(raw));
    if (o && o.messageId) return o;
  } catch (_) { /* */ }
  const n = parseInt(String(raw), 10);
  if (Number.isFinite(n) && n > 0) return { messageId: n };
  return null;
}

async function readPtr(scope, key) {
  try {
    const { getKv } = require('./sqlStore');
    return parseStored(await getKv(scope, key));
  } catch (_) {
    return null;
  }
}

async function writePtr(scope, key, messageId) {
  try {
    const { upsertKvAsync } = require('./sqlStore');
    await upsertKvAsync(scope, key, JSON.stringify({ messageId: Number(messageId) }));
  } catch (_) { /* */ }
}

function menuBuffer() {
  try {
    const tg = require('../telegramBot');
    const buf = typeof tg.getMenuImageBuffer === 'function' ? tg.getMenuImageBuffer() : null;
    if (buf && Buffer.isBuffer(buf) && buf.length) return buf;
  } catch (_) { /* */ }
  return null;
}

function clampCaption(text) {
  const s = String(text || '').slice(0, 1024);
  try {
    const { clampText, TG_CAPTION_MAX } = require('./statusProgress');
    return clampText(s, TG_CAPTION_MAX || 1024);
  } catch (_) {
    return s;
  }
}

/**
 * @param {{ chatId: string|number, kvKey: string, caption: string, keyboard?: any[][], kvScope?: string }} opts
 */
async function upsertStickyPhoto({ chatId, kvKey, caption, keyboard, kvScope = 'ops' } = {}) {
  const id = String(chatId || '').trim();
  const key = String(kvKey || '').trim();
  const body = clampCaption(caption);
  if (!id || !key || !body) return null;
  let bot;
  try {
    bot = require('../telegramBot').bot;
  } catch (_) {
    bot = null;
  }
  if (!bot) return null;

  const kb = keyboard && keyboard.length
    ? { reply_markup: { inline_keyboard: keyboard } }
    : {};
  const prev = await readPtr(kvScope, key);
  const photo = menuBuffer();

  if (prev && prev.messageId) {
    try {
      if (photo) {
        await bot.editMessageCaption(body, {
          chat_id: id,
          message_id: prev.messageId,
          ...kb
        });
      } else {
        await bot.editMessageText(body, {
          chat_id: id,
          message_id: prev.messageId,
          ...kb
        });
      }
      return { messageId: prev.messageId, edited: true };
    } catch (e) {
      logger.logAviso(`[sticky] edit: ${e.message}`);
    }
  }

  let sent;
  try {
    if (photo) {
      sent = await bot.sendPhoto(id, photo, { caption: body, ...kb });
    } else {
      sent = await bot.sendMessage(id, body, kb);
    }
  } catch (e) {
    logger.logAviso(`[sticky] send: ${e.message}`);
    return null;
  }
  const mid = sent && sent.message_id;
  if (mid) await writePtr(kvScope, key, mid);
  return { messageId: mid, edited: false };
}

/**
 * Texto puro (aviso de queda): edita a mesma msg; se falhar, manda nova.
 */
async function upsertStickyText({ chatId, kvKey, text, keyboard, kvScope = 'ops' } = {}) {
  const id = String(chatId || '').trim();
  const key = String(kvKey || '').trim();
  const body = String(text || '').slice(0, 3500);
  if (!id || !key || !body) return null;
  let bot;
  try {
    bot = require('../telegramBot').bot;
  } catch (_) {
    bot = null;
  }
  if (!bot) return null;
  const kb = keyboard && keyboard.length
    ? { reply_markup: { inline_keyboard: keyboard } }
    : {};
  const prev = await readPtr(kvScope, key);
  if (prev && prev.messageId) {
    try {
      await bot.editMessageText(body, {
        chat_id: id,
        message_id: prev.messageId,
        ...kb
      });
      return { messageId: prev.messageId, edited: true };
    } catch (e) {
      logger.logAviso(`[sticky] text-edit: ${e.message}`);
    }
  }
  try {
    const sent = await bot.sendMessage(id, body, kb);
    const mid = sent && sent.message_id;
    if (mid) await writePtr(kvScope, key, mid);
    return { messageId: mid, edited: false };
  } catch (e) {
    logger.logAviso(`[sticky] text-send: ${e.message}`);
    return null;
  }
}

module.exports = {
  upsertStickyPhoto,
  upsertStickyText,
  menuBuffer
};
