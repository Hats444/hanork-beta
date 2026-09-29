'use strict';
/**
 * Corte pago + gate de tier. Fonte do plano: SQL via vipIndex (cache).
 * Sessao Zap NAO e apagada. Admin e quem ja pagou (tier suficiente) passam.
 */

const logger = require('../logger');

/** 30/08/2026 00:00 BRT = 03:00 UTC */
const DEFAULT_CUTOFF_ISO = '2026-08-30T03:00:00.000Z';

function envOn(raw, fallback = true) {
  const v = String(raw ?? (fallback ? '1' : '0')).trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

function getCutoffDate() {
  const raw = String(process.env.HANORK_PAYWALL_AT || '').trim();
  const d = Date.parse(raw || DEFAULT_CUTOFF_ISO);
  if (Number.isFinite(d)) return new Date(d);
  return new Date(DEFAULT_CUTOFF_ISO);
}

function formatCutoffBr() {
  try {
    return getCutoffDate().toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  } catch (_) {
    return '30/08/2026';
  }
}

function isPaywallEnabled() {
  return envOn(process.env.HANORK_PAYWALL, true);
}

function isPaywallActive() {
  if (!isPaywallEnabled()) return false;
  return Date.now() >= getCutoffDate().getTime();
}

function daysUntilCutoff() {
  const ms = getCutoffDate().getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

function buyUrl(payload = 'comprar') {
  try {
    return require('./productOffer').telegramStartLink(payload);
  } catch (_) {
    return 'https://t.me/hanork_bot?start=comprar';
  }
}

function isPaidFeature(commandName) {
  try {
    const { minTierFor } = require('../services/billing/tiers');
    return minTierFor(commandName) !== 'free';
  } catch (_) {
    const n = String(commandName || '').toLowerCase();
    if (!n) return false;
    if (/^(comprar|minhaconta|menu|start|help|ajuda|ping|conectar|afiliado|baixarbot|sobre|planos|novidades|status)$/.test(n)) {
      return false;
    }
    return true;
  }
}

function isExempt(ctx) {
  const tid = String((ctx && ctx.telegramUserId) || '');
  try {
    const { isAdmin } = require('./userManager');
    if (tid && isAdmin(tid)) return true;
  } catch (_) { /* ignore */ }
  try {
    const { isFreshSessionOwner } = require('./authorization');
    if (ctx && isFreshSessionOwner(ctx)) return true;
  } catch (_) { /* ignore */ }
  return false;
}

function daypassGroupOk(ctx) {
  if (!ctx || !ctx.isGroup) return true;
  const tid = String(ctx.telegramUserId || '');
  const gid = String(ctx.from || '');
  if (!tid || !gid) return true;
  try {
    const sql = require('./sqlStore');
    const key = `dpg|${tid}`;
    const locked = sql.getKv('billing', key);
    if (!locked) {
      sql.upsertKv('billing', key, gid);
      return true;
    }
    return String(locked) === gid;
  } catch (_) {
    return true;
  }
}

function shouldBlock(ctx, commandName) {
  if (!isPaywallActive()) return false;
  if (isExempt(ctx)) return false;
  let need = 'starter';
  let have = 'free';
  try {
    const {
      minTierFor,
      sessionProductTier,
      hasTier,
      looksProtection,
      sessionHasDaypass
    } = require('../services/billing/tiers');
    need = minTierFor(commandName);
    if (need === 'free') return false;
    have = sessionProductTier(ctx);
    if (hasTier(have, need)) return false;
    if (need === 'pro' && looksProtection(commandName) && sessionHasDaypass(ctx)) {
      return !daypassGroupOk(ctx);
    }
    return true;
  } catch (_) {
    if (!isPaidFeature(commandName)) return false;
    try {
      const vipIndex = require('../services/billing/vipIndex');
      if (vipIndex.has('telegram', ctx?.telegramUserId)) return false;
      const { collectAuthIdentities } = require('./authorization');
      const ids = collectAuthIdentities(ctx) || [];
      if (vipIndex.hasAny('whatsapp', ids)) return false;
    } catch (_) { /* ignore */ }
    return true;
  }
}

function noticeText(platform, kind = 'notice') {
  const day = formatCutoffBr();
  const url = buyUrl();
  const buy = String(platform || '').toLowerCase() === 'telegram' ? '/comprar' : '.comprar';
  const head = kind === 'remind'
    ? `Amanha (${day}) os recursos pagos passam a exigir plano.`
    : `A partir de ${day}, recursos pagos exigem plano.`;
  let labels = { day: 'R$1', month: 'R$30', year: 'R$200', zip: 'R$250' };
  try { labels = require('./productOffer').livePlanLabels(); } catch (_) { /* */ }
  return (
    `Hanork — recado\n\n` +
    `${head}\n` +
    `A sessao do WhatsApp continua ligada. Nao precisa conectar de novo.\n\n` +
    `1 dia ${labels.day} · 30 dias ${labels.month || labels.pro} · 1 ano ${labels.year || labels.ent} · zip ${labels.zip || 'R$250'}.\n\n` +
    `Pagar: ${buy}\n${url}`
  );
}

function denyText(ctx, commandName) {
  const plat = ctx && (ctx.platform === 'telegram' || ctx.isTelegram) ? 'telegram' : 'whatsapp';
  let buy = plat === 'telegram' ? '/comprar' : '.comprar';
  if (plat !== 'telegram') {
    try {
      const { prefixFromCtx } = require('./configManager');
      buy = `${prefixFromCtx(ctx) || '.'}comprar`;
    } catch (_) { /* */ }
  }
  let labels = { day: 'R$1', month: 'R$30', pro: 'R$30' };
  try { labels = require('./productOffer').livePlanLabels(); } catch (_) { /* */ }
  const month = labels.month || labels.pro;
  try {
    const { minTierFor, sessionProductTier, looksProtection, looksDiv, sessionHasDaypass } = require('../services/billing/tiers');
    const need = minTierFor(commandName);
    const have = sessionProductTier(ctx);
    if (need === 'pro' && looksProtection(commandName) && sessionHasDaypass(ctx) && !daypassGroupOk(ctx)) {
      return (
        `O teste de 1 dia vale em um grupo so. Este nao e o grupo do teste.\n` +
        `Plano de 30 dias (qualquer grupo): ${month}\n` +
        `${buy}\n${buyUrl('comprar')}`
      );
    }
    if (need === 'pro' && looksProtection(commandName)) {
      return (
        `Protecao do grupo pede o plano de 30 dias (${month}).\n` +
        `Pra testar 1 dia: ${labels.day}.\n` +
        `${buy}\n${buyUrl('comprar')}`
      );
    }
    if (need === 'pro' && looksDiv(commandName)) {
      return (
        `Divulgacao pede o plano de 30 dias (${month}).\n` +
        `${buy}\n${buyUrl('comprar')}`
      );
    }
    const names = { starter: '1 dia ou 30 dias', pro: '30 dias', enterprise: '1 ano ou zip', free: 'nenhum' };
    return (
      `Este comando pede ${names[need] || 'um plano pago'} (agora: ${names[have] || 'nenhum'}).\n` +
      `${buy}\n${buyUrl('comprar')}`
    );
  } catch (_) {
    return (
      `Este comando faz parte de um plano pago.\n` +
      `Pagar: ${buy}\n${buyUrl()}`
    );
  }
}

async function maybeReplyDeny(conn, ctx, gated) {
  if (!gated || gated.ok || gated.reason !== 'paywall') return;
  const text = gated.message || denyText(ctx);
  const jid = ctx && ctx.from;
  if (!conn || !jid || typeof conn.sendMessage !== 'function') return;
  try {
    const { sendInteractiveButtons } = require('../helpers');
    const url = buyUrl('comprar');
    await sendInteractiveButtons(
      conn,
      jid,
      text,
      [
        { url, label: 'Assinar Pro' },
        { id: 'bill_home', label: 'Ver planos', short: 'Planos' }
      ],
      'Hanork',
      ctx.info,
      'menu.jpg',
      ctx.telegramUserId
    );
    return;
  } catch (e) {
    logger.logAviso(`[paywall] buttons: ${e.message}`);
  }
  try {
    await conn.sendMessage(jid, { text }, { quoted: ctx.info || undefined });
  } catch (e) {
    logger.logAviso(`[paywall] reply: ${e.message}`);
  }
}

module.exports = {
  getCutoffDate,
  formatCutoffBr,
  isPaywallEnabled,
  isPaywallActive,
  daysUntilCutoff,
  isPaidFeature,
  isExempt,
  shouldBlock,
  noticeText,
  denyText,
  maybeReplyDeny,
  buyUrl
};
