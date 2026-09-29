// utils/telegramBaileysShim.js — conn.sendMessage (Baileys) → Telegram Bot API
'use strict';

const logger = require('../logger');

function toBuffer(data) {
  if (data == null) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') {
    if (/^https?:\/\//i.test(data) || data.startsWith('file://')) return data;
    return Buffer.from(data);
  }
  if (data?.url) return data.url;
  if (Buffer.isBuffer(data?.data)) return data.data;
  return null;
}

function keyFromMsg(sent) {
  const id = sent?.message_id != null ? String(sent.message_id) : null;
  return id ? { id, remoteJid: 'telegram' } : null;
}

function stripWaMarkup(text) {
  return String(text || '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1');
}

async function sendTelegramText(bot, cid, raw, maxLen = 3900) {
  const { splitTextParts } = require('./textChunks');
  const text = stripWaMarkup(raw);
  const parts = splitTextParts(text, maxLen);
  let last = null;
  for (const part of parts) {
    last = await bot.sendMessage(cid, part);
  }
  return last;
}

/**
 * @param {import('node-telegram-bot-api')} bot
 * @param {string|number} chatId
 * @param {string|number} [userId]
 */
function createTelegramBaileysShim(bot, chatId, userId = null) {
  const cid = chatId;
  const msgIdByKey = new Map();

  async function downloadTelegramMedia(replyMsg) {
    if (!replyMsg) return null;
    const fileId =
      replyMsg.photo?.[replyMsg.photo.length - 1]?.file_id ||
      replyMsg.video?.file_id ||
      replyMsg.document?.file_id ||
      replyMsg.sticker?.file_id ||
      replyMsg.audio?.file_id ||
      replyMsg.voice?.file_id ||
      null;
    if (!fileId) return null;
    const path = require('path');
    const fs = require('fs');
    const tmpDir = path.join(__dirname, '..', 'data', 'cache', 'tg_shim');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const saved = await bot.downloadFile(fileId, tmpDir);
      const buf = await fs.promises.readFile(saved);
      try { fs.unlinkSync(saved); } catch (_) {}
      return buf;
    } catch (e) {
      logger.logAviso(`[tgShim] downloadMedia: ${e.message}`);
      return null;
    }
  }

  async function sendMessage(_jid, content, _opts = {}) {
    if (!content || typeof content !== 'object') {
      throw new Error('tgShim: content invalido');
    }

    // Edit status (statusProgress WA)
    if (content.edit && content.text != null) {
      const mid = content.edit?.id || msgIdByKey.get(String(content.edit?.id));
      const messageId = Number(content.edit?.id || mid);
      if (!messageId) {
        const sent = await sendTelegramText(bot, cid, content.text);
        return { key: keyFromMsg(sent) };
      }
      try {
        const body = stripWaMarkup(content.text).slice(0, 3900);
        const sent = await bot.editMessageText(body, {
          chat_id: cid,
          message_id: messageId
        });
        return { key: keyFromMsg(sent) || { id: String(messageId), remoteJid: 'telegram' } };
      } catch (_) {
        const sent = await sendTelegramText(bot, cid, content.text);
        return { key: keyFromMsg(sent) };
      }
    }

    // Delete status
    if (content.delete) {
      const messageId = Number(content.delete?.id || content.delete);
      if (messageId) {
        try { await bot.deleteMessage(cid, messageId); } catch (_) {}
      }
      return { key: null };
    }

    const caption = content.caption != null ? stripWaMarkup(content.caption).slice(0, 1000) : undefined;

    if (content.text != null && !content.image && !content.video && !content.audio && !content.document && !content.sticker) {
      const sent = await sendTelegramText(bot, cid, content.text);
      return { key: keyFromMsg(sent) };
    }

    if (content.sticker != null) {
      const buf = toBuffer(content.sticker);
      const sent = await bot.sendSticker(cid, buf);
      return { key: keyFromMsg(sent) };
    }

    if (content.image != null) {
      const buf = toBuffer(content.image);
      const sent = await bot.sendPhoto(cid, buf, caption ? { caption } : {});
      return { key: keyFromMsg(sent) };
    }

    if (content.video != null) {
      const buf = toBuffer(content.video);
      if (content.gifPlayback) {
        try {
          const sent = await bot.sendAnimation(cid, buf, caption ? { caption } : {});
          return { key: keyFromMsg(sent) };
        } catch (_) { /* fallback video */ }
      }
      const sent = await bot.sendVideo(cid, buf, caption ? { caption } : {});
      return { key: keyFromMsg(sent) };
    }

    if (content.audio != null) {
      const buf = toBuffer(content.audio);
      if (content.ptt) {
        const sent = await bot.sendVoice(cid, buf, caption ? { caption } : {});
        return { key: keyFromMsg(sent) };
      }
      const sent = await bot.sendAudio(cid, buf, {
        ...(caption ? { caption } : {}),
        filename: content.fileName || 'audio.mp3'
      });
      return { key: keyFromMsg(sent) };
    }

    if (content.document != null) {
      const buf = toBuffer(content.document);
      const sent = await bot.sendDocument(cid, buf, {
        ...(caption ? { caption } : {}),
        filename: content.fileName || 'arquivo'
      });
      return { key: keyFromMsg(sent) };
    }

    // Fallback: stringify
    const sent = await bot.sendMessage(cid, stripWaMarkup(JSON.stringify(content)).slice(0, 3900));
    return { key: keyFromMsg(sent) };
  }

  const noop = async () => undefined;
  const notSupported = async (name) => {
    throw new Error(`Comando precisa do WhatsApp (conn.${name} indisponivel no Telegram)`);
  };

  const base = {
    _isTelegramShim: true,
    _telegramBot: bot,
    _telegramChatId: cid,
    _telegramUserId: userId != null ? String(userId) : null,
    _sessionId: userId != null ? `tg:${userId}` : 'tg',
    user: { id: userId != null ? String(userId) : 'telegram' },
    sendMessage,
    downloadTelegramMedia,
    downloadMediaMessage: async (msg) => {
      const nested = msg?.message || msg;
      if (nested?.reply_to_message) return downloadTelegramMedia(nested.reply_to_message);
      return null;
    },
    // Stubs Baileys usados por cmds cotidianos (ping, tools, etc.)
    sendPresenceUpdate: noop,
    presenceSubscribe: noop,
    readMessages: noop,
    sendReceipt: noop,
    chatModify: noop,
    updateMediaMessage: noop,
    refreshMediaConn: async () => ({}),
    query: async () => ({}),
    end: noop,
    logout: noop,
    ws: { readyState: 1, close: () => {} },
    ev: { on: () => {}, off: () => {}, emit: () => {}, removeAllListeners: () => {} },
    groupMetadata: () => notSupported('groupMetadata'),
    groupParticipantsUpdate: () => notSupported('groupParticipantsUpdate'),
    updateProfileName: () => notSupported('updateProfileName'),
    updateProfileStatus: () => notSupported('updateProfileStatus'),
    updateProfilePicture: () => notSupported('updateProfilePicture')
  };

  // Qualquer metodo Baileys faltante → no-op (evita "is not a function" no TG)
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol') return undefined;
      if (String(prop).startsWith('_')) return undefined;
      return noop;
    }
  });
}

function isHanorkApiCommand(name, getCommandFn) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (n === 'hanork' || n === 'hanorkinfo' || n === 'zt' || n === 'ztinfo') return true;
  if (n.startsWith('menu_hanork') || n.startsWith('menu_zt')) return true;
  try {
    const cmd = typeof getCommandFn === 'function' ? getCommandFn(n) : null;
    return !!(cmd && cmd.ztEntry);
  } catch (_) {
    return false;
  }
}

module.exports = {
  createTelegramBaileysShim,
  isHanorkApiCommand,
  stripWaMarkup
};
