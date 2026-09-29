// utils/onboarding.js — textos UX (restrito / rate-limit / tip Intent)
'use strict';

const logger = require('../logger');
const { displayPrefix, getIntentConfig } = require('./configManager');
const { previewText, stripAccents } = require('./typography');

const hintThrottle = new Map(); // key -> ts

/** Fallback se tipMinConfidence nao estiver na config */
const HINT_MIN_SCORE_DEFAULT = 0.45;
const HINT_THROTTLE_GROUP_MS = 180000; // 3 min
const HINT_THROTTLE_DM_MS = 60000;

function chatKey(jidOrChatId) {
  return String(jidOrChatId || '').trim() || 'unknown';
}

function buildRestrictedText(prefix = '.') {
  const p = prefix || '.';
  return stripAccents(
    `Este comando e de plano pago.\n` +
    `Teste 1 dia ou plano da loja: ${p}comprar\n` +
    `Menu: ${p}menu  ${p}tutorial`
  );
}

function buildRateLimitText(retryAfterSec = 0) {
  const sec = Math.max(1, Math.ceil(Number(retryAfterSec) || 5));
  return stripAccents(
    `Limite temporario de uso.\n` +
    `Aguarde cerca de ${sec}s e tente de novo.`
  );
}

function buildIntentMissText(prefix = '.', top = null) {
  const p = prefix || '.';
  if (top?.command) {
    const usageBare = String(top.usage || top.command).replace(/^[.\/!#•]+/, '');
    return stripAccents(
      `Quase: parece ${top.command}.\n` +
      `Tente: ${p}${usageBare}\n` +
      `Menu: ${p}menu`
    );
  }
  return stripAccents(
    `Nao entendi o pedido.\n` +
    `Use ${p}menu ou um comando (ex: ${p}play nome da musica).`
  );
}

/**
 * Vale a pena mandar dica? (caso a: quase comando)
 * Caso b (conversa sem intencao): false → so log, sem chat.
 */
function shouldHintIntentMiss({
  text = '',
  candidates = [],
  topScore = 0,
  hadWrongCommand = false,
  isGroup = false,
  tipMinConfidence = HINT_MIN_SCORE_DEFAULT,
  missReason = ''
} = {}) {
  if (missReason === 'min_level' || missReason === 'no_candidates') return false;
  if (hadWrongCommand) return true;
  const t = String(text || '').trim();
  if (!t) return false;
  // Prefixo tipico de comando digitado errado
  if (/^[.\/!#•][a-z0-9_]{2,}/i.test(t)) return true;

  const top = candidates[0];
  const score = Number(topScore) || Number(top?.score) || 0;
  if (!top || !score) return false;

  const tipMin = typeof tipMinConfidence === 'number' ? tipMinConfidence : HINT_MIN_SCORE_DEFAULT;

  // Grupo: so tip se bem perto + parece pedido (evita conversa → flood)
  if (isGroup) {
    if (score < Math.max(0.72, tipMin)) return false;
    if (t.length < 8) return false;
    const looksLikeAsk = /\b(quero|pode|faz|manda|baixa|toca|abre|liga|desliga|menu|play|nuke|div|consulta|figurinha|sticker)\b/i.test(t);
    if (!looksLikeAsk && score < 0.88) return false;
    return true;
  }

  if (score >= tipMin) return true;
  return false;
}

/**
 * Tip so quando quase acertou um comando.
 * Grupo: throttle 3min/remetente. DM: 60s.
 * Sem candidato util / min_level → false + log (sem mensagem no chat).
 */
async function maybeSendIntentMissHint(conn, chatId, telegramUserId, {
  quoted = null,
  isGroup = false,
  platform = 'whatsapp',
  text = '',
  sender = '',
  candidates = [],
  topScore = 0,
  hadWrongCommand = false,
  missReason = '',
  bot = null
} = {}) {
  if (!conn && !bot) return false;
  if (!chatId) return false;
  if (missReason === 'min_level') {
    logger.logInfo(`[IntentRouter] tip skip — min_level chat=${chatId}`);
    return false;
  }

  const top = candidates[0] || null;
  const score = Number(topScore) || Number(top?.score) || 0;
  let tipMin = HINT_MIN_SCORE_DEFAULT;
  try {
    const cfg = getIntentConfig(telegramUserId);
    if (typeof cfg.tipMinConfidence === 'number') tipMin = cfg.tipMinConfidence;
  } catch (_) {}

  if (!shouldHintIntentMiss({
    text,
    candidates,
    topScore: score,
    hadWrongCommand,
    isGroup,
    tipMinConfidence: tipMin,
    missReason
  })) {
    if (score >= 0.35 || hadWrongCommand || missReason === 'no_candidates') {
      logger.logInfo(
        `[IntentRouter] sem candidato — mensagem ignorada` +
        ` (score=${score || 0} reason=${missReason || 'low'} text="${String(text).slice(0, 40)}")`
      );
    }
    return false;
  }

  const throttleMs = isGroup ? HINT_THROTTLE_GROUP_MS : HINT_THROTTLE_DM_MS;
  const who = isGroup ? (sender || 'anon') : 'dm';
  const key = `${telegramUserId || 'x'}:${chatKey(chatId)}:${who}`;
  const now = Date.now();
  if ((hintThrottle.get(key) || 0) + throttleMs > now) {
    logger.logInfo(`[IntentRouter] tip em cooldown — sem flood chat=${chatId}`);
    return false;
  }
  hintThrottle.set(key, now);

  try {
    const plat = String(platform || 'whatsapp').toLowerCase();
    const p = displayPrefix(telegramUserId, { platform: plat });
    const body = buildIntentMissText(p, top);
    if (bot && typeof bot.sendMessage === 'function') {
      await bot.sendMessage(chatId, body);
    } else if (conn) {
      await conn.sendMessage(chatId, { text: body }, quoted ? { quoted } : undefined);
    }
    logger.logInfo(
      `[IntentRouter] tip enviada cmd~=${top?.command || '?'} score=${score} group=${!!isGroup} p=${p}`
    );
    return true;
  } catch (_) {
    return false;
  }
}

/** Changelog curto opt-in (.novidades) */
const WHATS_NEW = [
  {
    date: '09/08/2026',
    items: [
      'Intent NL so VIP/dono (user usa prefixo+comando)',
      'Tip "nao entendi" so em quase-acerto (grupo com throttle)',
      'WhatsApp: so o prefixo configurado; Telegram: / fixo',
      'Menus mostram o prefixo atual + comando',
      'Dissecar total: metadata grupo/canal/PV via Baileys',
      'Tutorial e novidades sob demanda'
    ]
  },
  {
    date: '08/08/2026',
    items: [
      'Downloads TikTok/IG/YouTube/Spotify e mais',
      'Figurinhas por reply (prefixo+s / prefixo+f)',
      'Menu unificado WA + Telegram',
      'Anti-flood e seguranca de grupo'
    ]
  }
];

function buildWhatsNewText(prefix = '.') {
  const p = prefix || '.';
  const lines = [
    previewText('NOVIDADES HANORK'),
    '',
    stripAccents('O que mudou recentemente (sob demanda — sem spam):'),
    ''
  ];
  for (const block of WHATS_NEW.slice(0, 3)) {
    lines.push(previewText(block.date));
    for (const item of block.items) {
      const line = String(item).split('{p}').join(p);
      lines.push(stripAccents(`- ${line}`));
    }
    lines.push('');
  }
  lines.push(stripAccents(`Menu: ${p}menu  |  Tutorial: ${p}tutorial  |  Lista: ${p}comandos`));
  return lines.join('\n');
}

function friendlyMediaError(err, hint = '') {
  let m = String(err?.message || err || '');
  try {
    m = require('./brandSanitize').sanitizeBrand(m);
  } catch (_) { /* ignore */ }
  if (err && err.code === 'SEARCH_QUERY_TOO_LONG') {
    return m.slice(0, 160);
  }
  if (/invalid\s*url|url\s*invalida/i.test(m)) {
    return stripAccents(hint || 'Link invalido ou expirado. Copie a URL de novo no app e tente.');
  }
  if (/ECONNREFUSED|ENOTFOUND|socket hang|ECONNRESET|offline|timeout of \d+ms/i.test(m)) {
    return stripAccents('Servico temporariamente indisponivel. Tente de novo em instantes.');
  }
  if (/HTML|nao-JSON|path invalido|Endpoint indisponivel/i.test(m)) {
    return stripAccents(hint || 'API de download indisponivel neste momento. Tente outro link ou mais tarde.');
  }
  if (/Nenhum resultado|nao encontrado|sem resultado/i.test(m)) {
    return stripAccents('Nao achei resultado. Tente outro nome ou cole o link.');
  }
  if (/Configure ZEROTWO|NO_API_KEY|apikey/i.test(m)) {
    return stripAccents('Download nao configurado neste bot. Avisa o dono.');
  }
  if (/instagram api off|Instagram indisponivel/i.test(m)) {
    return stripAccents('Instagram temporariamente offline na API. Tente de novo em instantes.');
  }
  if (/link|url|informe|envie/i.test(m) && m.length < 160) {
    return stripAccents(m);
  }
  if (/HTTP\s*[45]\d\d|API sem resultado|Falha ao baixar|invalido/i.test(m)) {
    return stripAccents(hint || 'Nao foi possivel baixar agora. Confira o link e tente de novo.');
  }
  if (/\d+\.\d+\.\d+\.\d+|at\s+\S+\(|Error:/i.test(m) || m.length > 140) {
    return stripAccents(hint || 'Falha no download. Tente outro link ou mais tarde.');
  }
  return stripAccents(m.slice(0, 140));
}

function buildBuyerStartText(prefix = '.') {
  const p = prefix || '.';
  return stripAccents(
    `${previewText('CHECKLIST LOJA')}\n\n` +
    `1) Me coloca admin do grupo\n` +
    `2) No Telegram: Proteger grupo\n` +
    `3) Teste: um membro manda um link (antilink)\n` +
    `4) ${p}gpseguranca se quiser ligar mais\n` +
    `5) Divulgacao (Pro): ${p}divmenu\n\n` +
    `Pagar / renovar: ${p}comprar`
  );
}

module.exports = {
  HINT_MIN_SCORE: HINT_MIN_SCORE_DEFAULT,
  HINT_MIN_SCORE_DEFAULT,
  HINT_THROTTLE_GROUP_MS,
  HINT_THROTTLE_DM_MS,
  buildRestrictedText,
  buildRateLimitText,
  buildIntentMissText,
  shouldHintIntentMiss,
  maybeSendIntentMissHint,
  friendlyMediaError,
  WHATS_NEW,
  buildWhatsNewText,
  buildBuyerStartText
};
