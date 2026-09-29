// utils/statusProgress.js
// Uma mensagem de status editada progressivamente (WA Baileys + Telegram)

const logger = require('../logger');
const { formatStatusBlock } = require('./typography');
const { splitTextParts } = require('./textChunks');

const TG_TEXT_MAX = 3900;
const TG_CAPTION_MAX = 1000;
const WA_TEXT_MAX = 3500;
const WA_CHUNK_GAP_MS = 400;
const MIN_EDIT_MS = Number(process.env.HANORK_STATUS_EDIT_MS || 1500);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeThrottledEdit(doEdit) {
  let lastAt = 0;
  let timer = null;
  let pending = null;
  async function throttled(text) {
    const now = Date.now();
    const wait = lastAt ? MIN_EDIT_MS - (now - lastAt) : 0;
    if (wait > 0) {
      pending = text;
      if (!timer) {
        timer = setTimeout(async () => {
          timer = null;
          const next = pending;
          pending = null;
          if (next != null) {
            lastAt = Date.now();
            await doEdit(next);
          }
        }, wait);
      }
      return;
    }
    lastAt = now;
    await doEdit(text);
  }
  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return throttled;
}

function isConnClosedErr(err) {
  const m = String(err?.message || err || '');
  return /connection closed|timed out|socket hang|ECONNRESET|not connected|Connection Terminated/i.test(m);
}

function clampText(text, max = TG_TEXT_MAX) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 20)}\n\n...(cortado)`;
}

function isWaSendJid(jid) {
  const s = String(jid || '');
  if (!s.includes('@')) return false;
  if (s.endsWith('@broadcast') || s === 'status@broadcast') return false;
  return true;
}

/** Quoted sem key.id faz o Baileys estourar: Cannot read properties of undefined (reading 'undefined'). */
function usableQuoted(quoted) {
  if (!quoted || typeof quoted !== 'object') return null;
  const key = quoted.key || quoted;
  if (!key || typeof key !== 'object') return null;
  if (!key.id) return null;
  if (!key.remoteJid && !key.remoteJidAlt) return null;
  return quoted.key ? quoted : { key };
}

function noopStatus() {
  return {
    platform: 'whatsapp',
    key: null,
    messageId: null,
    async update() {},
    async setRows() {},
    async finish() {},
    async remove() {}
  };
}

async function createWhatsAppStatus(conn, jid, quoted = null, title = 'STATUS', opts = {}) {
  if (!isWaSendJid(jid) || typeof conn?.sendMessage !== 'function') {
    return noopStatus();
  }
  const forwardFinal = opts.forwardFinal === true;
  const initial = formatStatusBlock(title, [['Estado', 'iniciando']]);
  let key = null;
  let dead = false;
  const q = usableQuoted(quoted);
  const sendOpts = q ? { quoted: q, skipForward: true } : { skipForward: true };

  try {
    const sent = await conn.sendMessage(jid, { text: initial }, sendOpts);
    key = sent?.key || null;
  } catch (e) {
    if (isConnClosedErr(e)) dead = true;
    else {
      const msg = String(e?.message || e);
      if (/reading ['"]undefined['"]|item-not-found/i.test(msg)) {
        dead = true;
        logger.logAviso(`[statusProgress/WA] send skip: ${msg}`);
      } else {
        logger.logErro('[statusProgress/WA] send:', e.message);
      }
    }
  }

  async function editRaw(text) {
    if (dead) return;
    const body = clampText(text, 60000);
    if (!key) {
      try {
        const sent = await conn.sendMessage(jid, { text: body }, { skipForward: true });
        key = sent?.key || null;
      } catch (e) {
        if (isConnClosedErr(e)) dead = true;
        else logger.logErro('[statusProgress/WA] resend:', e.message);
      }
      return;
    }
    try {
      await conn.sendMessage(jid, { text: body, edit: key }, { skipForward: true });
    } catch (e) {
      if (isConnClosedErr(e)) {
        dead = true;
        return;
      }
      try { logger.logAviso(`[statusProgress/WA] edit falhou (${e.message}) — mantem 1 msg`); } catch (_) {}
    }
  }
  const edit = makeThrottledEdit(editRaw);

  return {
    platform: 'whatsapp',
    key,
    messageId: null,
    async update(label, value) {
      await edit(formatStatusBlock(title, [[label, String(value ?? '').slice(0, 200)]]));
    },
    async setRows(rows) {
      await edit(formatStatusBlock(title, rows));
    },
    async finish(finalText) {
      if (finalText == null) return;
      if (typeof edit.cancel === 'function') edit.cancel();
      const s = String(finalText);
      const oneMessage = opts.oneMessage === true;
      const cap = Number(opts.finishMax) > 0
        ? Number(opts.finishMax)
        : (oneMessage ? 60000 : WA_TEXT_MAX);
      const body = s.length <= cap ? s : `${s.slice(0, cap - 70)}\n(…teto WhatsApp)`;
      if (oneMessage) {
        try {
          if (key) await conn.sendMessage(jid, { delete: key }, { skipForward: true });
        } catch (_) {}
        key = null;
        try {
          const sent = await conn.sendMessage(jid, { text: body }, sendOpts);
          key = sent?.key || null;
        } catch (e) {
          if (isConnClosedErr(e)) {
            dead = true;
            return;
          }
          logger.logErro('[statusProgress/WA] finish one:', e.message);
          try {
            const sent = await conn.sendMessage(jid, { text: body }, { skipForward: true });
            key = sent?.key || key;
          } catch (e2) {
            logger.logErro('[statusProgress/WA] finish fallback:', e2.message);
          }
        }
        return;
      }
      if (forwardFinal) {
        try {
          if (key) await conn.sendMessage(jid, { delete: key }, { skipForward: true });
        } catch (_) {}
        key = null;
        const { sendAsChannel } = require('./channelForward');
        const parts = s.length <= WA_TEXT_MAX ? [s] : splitTextParts(s, WA_TEXT_MAX);
        for (let i = 0; i < parts.length; i++) {
          if (dead) return;
          try {
            const sent = await sendAsChannel(conn, jid, { text: parts[i] });
            if (i === 0) key = sent?.key || key;
          } catch (e) {
            if (isConnClosedErr(e)) {
              dead = true;
              return;
            }
            logger.logErro('[statusProgress/WA] forward:', e.message);
            try {
              const sent = await conn.sendMessage(jid, { text: parts[i] }, { skipForward: true });
              if (i === 0) key = sent?.key || key;
            } catch (e2) {
              logger.logErro('[statusProgress/WA] fallback:', e2.message);
            }
          }
          if (i < parts.length - 1) await sleep(WA_CHUNK_GAP_MS);
        }
        return;
      }
      if (s.length <= WA_TEXT_MAX) {
        await editRaw(s);
        return;
      }
      try {
        if (key) await conn.sendMessage(jid, { delete: key }, { skipForward: true });
      } catch (_) {}
      key = null;
      const parts = splitTextParts(s, WA_TEXT_MAX);
      for (let i = 0; i < parts.length; i++) {
        if (dead) return;
        try {
          const sent = await conn.sendMessage(jid, { text: parts[i] }, { skipForward: true });
          if (i === 0) key = sent?.key || key;
        } catch (e) {
          if (isConnClosedErr(e)) {
            dead = true;
            return;
          }
          logger.logErro('[statusProgress/WA] chunk:', e.message);
        }
        if (i < parts.length - 1) await sleep(WA_CHUNK_GAP_MS);
      }
    },
    async remove() {
      if (!key || dead) return;
      try {
        await conn.sendMessage(jid, { delete: key }, { skipForward: true });
      } catch (e) {
        if (!isConnClosedErr(e)) logger.logAviso(`[statusProgress/WA] delete: ${e.message}`);
      }
      key = null;
    }
  };
}

async function createTelegramStatus(bot, chatId, title = 'STATUS') {
  const initial = formatStatusBlock(title, [['Estado', 'iniciando']]);
  let messageId = null;

  try {
    const sent = await bot.sendMessage(chatId, clampText(initial));
    messageId = sent?.message_id || null;
  } catch (e) {
    logger.logErro('[statusProgress/TG] send:', e.message);
  }

  async function sendChunks(full) {
    const parts = splitTextParts(String(full ?? ''), TG_TEXT_MAX);
    for (const part of parts) {
      try {
        await bot.sendMessage(chatId, part);
      } catch (e) {
        logger.logErro('[statusProgress/TG] chunk:', e.message);
      }
    }
  }

  async function editRaw(text) {
    const body = clampText(text);
    if (!messageId) {
      try {
        const sent = await bot.sendMessage(chatId, body);
        messageId = sent?.message_id || null;
      } catch (e) {
        logger.logErro('[statusProgress/TG] resend:', e.message);
      }
      return;
    }
    try {
      await bot.editMessageText(body, { chat_id: chatId, message_id: messageId });
    } catch (e) {
      const msg = e.message || '';
      if (/not modified/i.test(msg)) return;
      if (/MESSAGE_TOO_LONG|too long/i.test(msg)) {
        try {
          await bot.deleteMessage(chatId, messageId);
        } catch (_) {}
        messageId = null;
        await sendChunks(text);
        return;
      }
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (_) {}
      messageId = null;
      try {
        const sent = await bot.sendMessage(chatId, body);
        messageId = sent?.message_id || null;
      } catch (e2) {
        logger.logErro('[statusProgress/TG] fallback:', e2.message);
      }
    }
  }
  const edit = makeThrottledEdit(editRaw);

  return {
    platform: 'telegram',
    key: null,
    messageId,
    async update(label, value) {
      await edit(formatStatusBlock(title, [[label, String(value ?? '').slice(0, 120)]]));
    },
    async setRows(rows) {
      await edit(formatStatusBlock(title, rows));
    },
    async finish(finalText) {
      if (finalText == null) return;
      if (typeof edit.cancel === 'function') edit.cancel();
      const s = String(finalText);
      if (s.length > TG_TEXT_MAX) {
        try {
          if (messageId) await bot.deleteMessage(chatId, messageId);
        } catch (_) {}
        messageId = null;
        await sendChunks(s);
        return;
      }
      await editRaw(s);
    },
    async remove() {
      if (!messageId) return;
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (e) {
        logger.logAviso(`[statusProgress/TG] delete: ${e.message}`);
      }
      messageId = null;
    }
  };
}

async function createStatusProgress(platform, opts = {}) {
  if (platform === 'telegram') {
    return createTelegramStatus(opts.bot, opts.chatId, opts.title || 'STATUS');
  }
  return createWhatsAppStatus(opts.conn, opts.jid || opts.chatId, opts.quoted || null, opts.title || 'STATUS');
}

module.exports = {
  createWhatsAppStatus,
  createTelegramStatus,
  createStatusProgress,
  clampText,
  TG_TEXT_MAX,
  TG_CAPTION_MAX,
  WA_TEXT_MAX
};
