// utils/tgSendPatch.js — scrub erros tecnicos no Telegram (espelha waSendPatch)
'use strict';

const logger = require('../logger');
const { scrubUserFacingText, toPublicError } = require('../core/router/errorHandler');

function patchTelegramBot(bot) {
  if (!bot || bot._hanorkTgScrubbed) return bot;

  if (typeof bot.sendMessage === 'function') {
    const orig = bot.sendMessage.bind(bot);
    bot.sendMessage = async (chatId, text, options) => {
      const raw = typeof text === 'string' ? text : String(text ?? '');
      const safe = scrubUserFacingText(raw, { channel: 'telegram', chatId: String(chatId || '').slice(0, 24) });
      return orig(chatId, safe, options);
    };
  }

  if (typeof bot.answerCallbackQuery === 'function') {
    const origCb = bot.answerCallbackQuery.bind(bot);
    bot.answerCallbackQuery = async (callbackQueryId, options = {}) => {
      const opts = { ...(options || {}) };
      if (typeof opts.text === 'string') {
        const before = opts.text;
        opts.text = scrubUserFacingText(before, { channel: 'telegram-cb' }).slice(0, 200);
        if (opts.text !== before) {
          try {
            logger.logUserFacingError('TG_CB_SCRUB', before.slice(0, 500), {});
          } catch (_) { /* */ }
        }
      }
      return origCb(callbackQueryId, opts);
    };
  }

  bot._hanorkTgScrubbed = true;
  return bot;
}

function publicTgError(err) {
  return toPublicError(err);
}

module.exports = { patchTelegramBot, publicTgError };
