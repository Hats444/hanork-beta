// utils/selfMessageGuard.js
// P0: evita loop — mensagens do proprio bot nao reentram no pipeline

const botSentIds = new Map(); // id -> expiresAt
const TTL_MS = 5 * 60 * 1000;
const MAX_IDS = 5000;

let cachedTgBotId = null;

function prune() {
  const now = Date.now();
  if (botSentIds.size < MAX_IDS) {
    for (const [id, exp] of botSentIds) {
      if (exp < now) botSentIds.delete(id);
    }
    return;
  }
  for (const [id, exp] of botSentIds) {
    if (exp < now) botSentIds.delete(id);
  }
  while (botSentIds.size > MAX_IDS) {
    const first = botSentIds.keys().next().value;
    botSentIds.delete(first);
  }
}

/** Marca ID enviado pelo bot (eco Baileys / TG) */
function rememberBotSentId(id) {
  if (!id) return;
  prune();
  botSentIds.set(String(id), Date.now() + TTL_MS);
}

/** Marca texto enviado pelo bot (fallback quando fromMe/LID falha) */
const botSentTexts = new Map(); // hash -> expiresAt
function rememberBotSentText(text) {
  const t = String(text || '').trim().slice(0, 240).toLowerCase();
  if (t.length < 8) return;
  prune();
  botSentTexts.set(t, Date.now() + TTL_MS);
}

function isBotSentText(text) {
  const t = String(text || '').trim().slice(0, 240).toLowerCase();
  if (!t) return false;
  const exp = botSentTexts.get(t);
  if (!exp) return false;
  if (exp < Date.now()) {
    botSentTexts.delete(t);
    return false;
  }
  return true;
}

function isBotSentId(id) {
  if (!id) return false;
  const exp = botSentIds.get(String(id));
  if (!exp) return false;
  if (exp < Date.now()) {
    botSentIds.delete(String(id));
    return false;
  }
  return true;
}

/** Relatorio/ajuda/deny que o proprio bot mandou — nao reentra como comando. */
function looksLikeOwnBotOutput(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^este comando e restrito/i.test(t)) return true;
  if (/^apenas o dono da sessao/i.test(t)) return true;
  if (/\nEXEMPLOS\b/i.test(t) && /\bosint\b/i.test(t)) return true;
  if (/^OSINT\b/i.test(t) && t.includes('\n')) return true;
  if (/^SPOTIFY\b/i.test(t) && t.includes('\n')) return true;
  return false;
}

function extractWaText(info) {
  try {
    let m = info?.message || {};
    try {
      const { unwrapWaMessage } = require('../contextParser');
      m = unwrapWaMessage(m) || m;
    } catch (_) { /* unwrap opcional */ }
    return (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.documentMessage?.caption ||
      m.buttonsResponseMessage?.selectedDisplayText ||
      m.listResponseMessage?.title ||
      ''
    );
  } catch (_) {
    return '';
  }
}

/**
 * WA: ignora eco do bot. Permite fromMe so se for comando explicito com prefixo
 * (dono digitando no proprio chip) e NAO estiver na lista de IDs enviados pelo bot.
 * @returns {{ ignore: boolean, reason?: string }}
 */
function shouldIgnoreWhatsAppMessage(info, opts = {}) {
  const key = info?.key || {};
  const text = String(extractWaText(info) || '').trim();

  // Fallback: mesmo texto que o bot acabou de enviar (LID/fromMe inconsistente)
  if (text && isBotSentText(text)) {
    return { ignore: true, reason: 'bot_sent_text_echo' };
  }

  if (!key.fromMe) return { ignore: false };

  const id = key.id;
  if (isBotSentId(id)) {
    return { ignore: true, reason: 'bot_sent_echo' };
  }

  if (looksLikeOwnBotOutput(text)) {
    return { ignore: true, reason: 'fromMe_bot_output' };
  }

  // fromMe: so comando REAL com o prefixo desta sessao (nao `...`)
  const { parsePrefixedCommand } = require('./commandTextParse');
  const configured = String(opts.prefix || '.').slice(0, 2) || '.';
  const parsed = parsePrefixedCommand(text, configured, { platform: 'whatsapp' });
  if (parsed.command) {
    return { ignore: false, reason: 'fromMe_explicit_command' };
  }
  if (configured && text.startsWith(configured) && text.length > configured.length) {
    return { ignore: false, reason: 'fromMe_has_prefix' };
  }

  return { ignore: true, reason: 'fromMe_no_prefix' };
}

/**
 * TG: ignora mensagens do proprio bot
 */
function shouldIgnoreTelegramMessage(msg, botId) {
  if (!msg?.from) return { ignore: false };
  if (msg.from.is_bot && botId && String(msg.from.id) === String(botId)) {
    return { ignore: true, reason: 'telegram_self' };
  }
  if (botId && String(msg.from.id) === String(botId)) {
    return { ignore: true, reason: 'telegram_self' };
  }
  // Mensagens de canal/assinatura as vezes vem sem from tipico — so ignora is_bot generico do nosso id
  return { ignore: false };
}

function setCachedTgBotId(id) {
  if (id != null) cachedTgBotId = String(id);
}

function getCachedTgBotId() {
  return cachedTgBotId;
}

module.exports = {
  rememberBotSentId,
  rememberBotSentText,
  isBotSentId,
  isBotSentText,
  shouldIgnoreWhatsAppMessage,
  shouldIgnoreTelegramMessage,
  setCachedTgBotId,
  getCachedTgBotId,
  extractWaText
};
