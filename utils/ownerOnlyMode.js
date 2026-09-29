'use strict';
/**
 * Modo dono: HANORK_OWNER_ONLY=1
 * User comum / VIP / chip de cliente nao usa o bot.
 * Protecao de grupo (antilink etc.) continua no chip do dono.
 */

function isOwnerOnlyMode() {
  return /^(1|true|on|yes)$/i.test(String(process.env.HANORK_OWNER_ONLY || '').trim());
}

function isPlatformAdminId(id) {
  if (id == null || id === '') return false;
  try {
    const { isAdmin } = require('./userManager');
    return !!isAdmin(String(id).trim());
  } catch (_) {
    return false;
  }
}

/**
 * Telegram: so TELEGRAM_ADMIN_IDS.
 * WhatsApp: so o numero dono no chip cuja sessao e de um admin TG
 * (chip de cliente fica mudo mesmo se o cliente for "dono" da sessao).
 */
function allowOwnerOnlyActor(ctx = {}) {
  if (!isOwnerOnlyMode()) return true;
  const tg = ctx.telegramUserId || ctx.telegramChatId || null;
  if (ctx.platform === 'telegram' || ctx.isTelegram) {
    return isPlatformAdminId(tg || ctx.sender);
  }
  if (isPlatformAdminId(ctx.sender)) return true;
  if (!isPlatformAdminId(tg)) return false;
  try {
    const { isFreshSessionOwner } = require('./authorization');
    return !!isFreshSessionOwner(ctx);
  } catch (_) {
    return !!(ctx.isOwner && isPlatformAdminId(tg));
  }
}

module.exports = {
  isOwnerOnlyMode,
  isPlatformAdminId,
  allowOwnerOnlyActor
};
