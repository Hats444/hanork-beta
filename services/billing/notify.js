'use strict';

const logger = require('../../logger');

function publicText(s) {
  return String(s || '')
    .replace(new RegExp(['APP', 'USR-'].join('_') + '[^\\s]+', 'gi'), '[token]')
    .replace(/TEST-[^\s]+/gi, '[token]')
    .slice(0, 900);
}

/** Telegram = /cmd. WhatsApp = .cmd. Nunca misturar. */
function isTelegramPlatform(platform) {
  return String(platform || '').toLowerCase() === 'telegram';
}

function cmd(platform, name) {
  const n = String(name || '').replace(/^[./]+/, '');
  return isTelegramPlatform(platform) ? `/${n}` : `.${n}`;
}

function postSaleSteps(platform, opts = {}) {
  const zipFail = !!(opts.zipFail || opts.zipFail);
  const uid = opts.telegramUserId || opts.sessionOwner || opts.uid;
  let after = '';
  try {
    after = require('../../utils/productOffer').howToAfterPay(uid);
  } catch (_) {
    after = 'Pagou. Agora conecta o WhatsApp.';
  }
  const planId = String(opts.planId || '');
  if (planId === 'daypass') {
    after +=
      '\nNas 24h: protecao de UM grupo. Sem divulgacao em massa.' +
      '\nAntes de acabar: plano de 30 dias em /comprar.';
  }
  if (zipFail) {
    return isTelegramPlatform(platform)
      ? `${after}\nZip nao anexei. Use /baixarbot.`
      : `${after}\nZip: use baixarbot no PV.`;
  }
  return after;
}

function postSaleKeyboard(platform) {
  if (!isTelegramPlatform(platform)) return null;
  return [
    [{ text: 'Conectar WhatsApp', callback_data: 'connect' }],
    [{ text: 'Suporte', callback_data: 'bill_suporte' }]
  ];
}

function vipWarnText(platform, { day, tag, expired = false, daypass = false } = {}) {
  const tg = isTelegramPlatform(platform);
  if (daypass && expired) {
    return tg
      ? 'O teste de 1 dia acabou.\nPlanos: /comprar\nConta: /minhaconta'
      : 'O teste de 1 dia acabou.\nPlanos: .comprar\nConta: .minhaconta';
  }
  if (daypass) {
    return tg
      ? `O teste de 1 dia acaba ${day ? '(' + day + ')' : 'em breve'}.\n30 dias: /comprar`
      : `O teste de 1 dia acaba ${day ? '(' + day + ')' : 'em breve'}.\n30 dias: .comprar`;
  }
  if (expired) {
    return tg
      ? 'Seu plano expirou neste bot.\nRenove: /comprar\nConta: /minhaconta'
      : 'Seu plano expirou neste bot.\nRenove: .comprar\nConta: .minhaconta';
  }
  if (tg) {
    return tag === 'd3'
      ? `Seu plano vence em ~3 dias (${day}).\nRenova no Telegram: /comprar (PIX na hora).`
      : `Seu plano vence amanha (${day}).\nRenova agora no Telegram: /comprar`;
  }
  return tag === 'd3'
    ? `Seu plano vence em ~3 dias (${day}).\nRenove: .comprar  |  .minhaconta`
    : `Seu plano vence amanha (${day}).\nRenove agora: .comprar  |  .minhaconta`;
}

async function notifyCustomer(order, text, extra) {
  const msg = publicText(text);
  if (!order || !msg) return;
  const doc = extra && extra.document;
  const fileName = (extra && extra.fileName) || 'hanork-bot.zip';
  try {
    if (order.platform === 'telegram') {
      const { bot } = require('../../telegramBot');
      const chatId = order.chat_jid || order.session_owner;
      if (!bot || !chatId) return;
      if (doc) {
        await bot.sendDocument(chatId, doc, { caption: msg }, { filename: fileName });
        return;
      }
      const kb = extra && extra.inline_keyboard
        ? { reply_markup: { inline_keyboard: extra.inline_keyboard } }
        : {};
      await bot.sendMessage(chatId, msg, kb);
      return;
    }
    const { activeConnections } = require('../../telegramBot');
    const owner = String(order.session_owner || '');
    const jid = order.chat_jid;
    if (!jid || !activeConnections) return;
    for (const conn of activeConnections.values()) {
      if (owner && String(conn._telegramUserId) !== owner) continue;
      if (typeof conn.sendMessage !== 'function') continue;
      if (doc) {
        await conn.sendMessage(jid, {
          document: doc,
          mimetype: 'application/zip',
          fileName,
          caption: msg
        }, { skipForward: true, _hanorkTrusted: true });
        return;
      }
      await conn.sendMessage(jid, { text: msg }, { skipForward: true, _hanorkTrusted: true });
      return;
    }
  } catch (e) {
    logger.logAviso(`[billing] notify: ${e.message}`);
  }
}

async function notifyAdmins(text) {
  const msg = publicText(text);
  try {
    const { bot } = require('../../telegramBot');
    const { ADMIN_IDS } = require('../../utils/userManager');
    if (!bot) return;
    for (const id of ADMIN_IDS || []) {
      await bot.sendMessage(id, msg).catch(() => {});
    }
  } catch (e) {
    logger.logAviso(`[billing] admin-notify: ${e.message}`);
  }
}

/** Aviso sem order (VIP a expirar / etc). Prefer Telegram. */
async function notifyUser({ platform, platformUser, sessionOwner, text } = {}) {
  const msg = publicText(text);
  if (!msg) return;
  const plat = String(platform || 'telegram').toLowerCase();
  const uid = String(platformUser || sessionOwner || '').trim();
  if (!uid) return;
  try {
    if (plat === 'telegram' || /^\d{5,}$/.test(uid)) {
      const { bot } = require('../../telegramBot');
      if (bot) {
        await bot.sendMessage(uid, msg).catch(() => {});
        return;
      }
    }
    const { activeConnections } = require('../../telegramBot');
    const owner = String(sessionOwner || uid);
    for (const conn of activeConnections.values()) {
      if (String(conn._telegramUserId) !== owner) continue;
      if (typeof conn.sendMessage !== 'function') continue;
      const jid = /^\d+@/.test(uid) ? uid : null;
      if (!jid) continue;
      await conn.sendMessage(jid, { text: msg }, { skipForward: true, _hanorkTrusted: true });
      return;
    }
  } catch (e) {
    logger.logAviso(`[billing] notifyUser: ${e.message}`);
  }
}

module.exports = {
  notifyCustomer,
  notifyAdmins,
  notifyUser,
  publicText,
  cmd,
  isTelegramPlatform,
  postSaleSteps,
  postSaleKeyboard,
  vipWarnText
};
