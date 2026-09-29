'use strict';
/**
 * Canal de referencias — mesmo padrao do Hanork (@hanorkinfos).
 * Quando o PIX confirma, publica um card publico (sem ID interno, sem codigo de afiliado).
 * Telegram: HTML com blockquote. WhatsApp: texto limpo no canal oficial @newsletter.
 */

const logger = require('../../logger');

const DEFAULT_TG_CHANNEL_ID = String(process.env.TELEGRAM_CHANNEL_ID || '').trim();
const DEFAULT_TG_CHANNEL_LINK = 'https://t.me/hanorkinfos';

function envOn(raw, fallback = true) {
  const v = String(raw ?? (fallback ? '1' : '0')).trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

function getTgChannelId() {
  const raw = String(
    process.env.SALES_REF_CHANNEL_ID ||
    process.env.HANORK_REF_CHANNEL_ID ||
    process.env.TELEGRAM_CHANNEL_ID ||
    DEFAULT_TG_CHANNEL_ID
  ).trim();
  if (!raw || raw === '0' || raw === 'false' || raw === 'off') return '';
  return raw;
}

function getTgChannelLink() {
  return String(
    process.env.SALES_REF_CHANNEL_LINK ||
    process.env.HANORK_REF_CHANNEL_LINK ||
    process.env.TELEGRAM_CHANNEL_LINK ||
    DEFAULT_TG_CHANNEL_LINK
  ).trim() || DEFAULT_TG_CHANNEL_LINK;
}

function tgEnabled() {
  return envOn(process.env.SALES_REF_TG, true) && !!getTgChannelId();
}

function waEnabled() {
  return envOn(process.env.SALES_REF_WA, true);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatReais(cents) {
  const n = (Number(cents) || 0) / 100;
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

function formatLocalTime(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch (_) {
    return new Date().toISOString();
  }
}

function shortRef(orderId) {
  const s = String(orderId || '').replace(/-/g, '');
  if (s.length >= 4) return s.slice(-4).toUpperCase();
  return '----';
}

function maskClientTag(platformUser) {
  const digits = String(platformUser || '').replace(/\D/g, '');
  const tail = (digits.slice(-4) || '----').padStart(4, '0');
  return `Cliente #${tail}`;
}

function sectionHtml(title, lines) {
  const body = (lines || []).filter(Boolean).join('\n');
  if (!body) return title;
  return `${title}\n<blockquote>${body}</blockquote>`;
}

function productLabel(order, plan) {
  if (plan && plan.name) return plan.name;
  try {
    const { resolvePlan } = require('./logic');
    const syn = resolvePlan(order.plan_id);
    if (syn && syn.name) return syn.name;
  } catch (_) { /* ignore */ }
  const id = String(order.plan_id || '');
  if (/^vip_(\d+)$/i.test(id)) {
    const d = Number(RegExp.$1);
    if (d === 365) return 'VIP anual';
    if (d === 1) return 'VIP 1 dia';
    return `VIP ${d} dias`;
  }
  if (id === 'bot') return 'Bot completo';
  return id || 'Hanork';
}

function paymentMethod(order) {
  const m = String(order.method || order.payment_method || 'pix').toLowerCase();
  if (m === 'pix') return 'PIX';
  if (m === 'card' || m === 'credit_card') return 'Cartao';
  return m ? m.toUpperCase() : 'PIX';
}

async function loadContext(order) {
  const { getAsync } = require('../../utils/sqlStore');
  const customer = order.customer_id
    ? await getAsync(`SELECT * FROM billing_customer WHERE id=?`, [order.customer_id])
    : null;
  const plan = order.plan_id
    ? await getAsync(`SELECT * FROM billing_plan WHERE id=?`, [order.plan_id]).catch(() => null)
    : null;
  const referral = customer
    ? await getAsync(`SELECT * FROM billing_referral WHERE customer_id=?`, [customer.id])
    : null;
  return { customer, plan, referral };
}

async function resolveTelegramProfile(userId) {
  const uid = String(userId || '').trim();
  if (!/^\d{5,}$/.test(uid)) return null;
  try {
    const { bot } = require('../../telegramBot');
    if (!bot || typeof bot.getChat !== 'function') return null;
    const chat = await bot.getChat(uid);
    if (!chat) return null;
    const first = String(chat.first_name || '').trim();
    const last = String(chat.last_name || '').trim();
    const name = [first, last].filter(Boolean).join(' ') || '';
    const username = String(chat.username || '').replace(/^@/, '').trim();
    return { name, username };
  } catch (_) {
    return null;
  }
}

function buildClientLines(order, customer, referral, profile, html) {
  const uid = String((customer && customer.platform_user) || order.session_owner || '');
  const lines = [];
  const name = (profile && profile.name) || maskClientTag(uid);
  const username = profile && profile.username ? profile.username : '';
  if (html) {
    if (username) {
      lines.push(`<b>${escapeHtml(name)}</b> · @${escapeHtml(username)}`);
      lines.push(`<a href="https://t.me/${escapeHtml(username)}">Perfil</a>`);
    } else {
      lines.push(`<b>${escapeHtml(name)}</b>`);
    }
    if (referral && referral.referrer_code) lines.push('🤝 Afiliado verificado');
  } else {
    if (username) lines.push(`${name} · @${username}`);
    else lines.push(name);
    if (referral && referral.referrer_code) lines.push('Afiliado verificado');
  }
  return lines;
}

function botStartUrl(ctx) {
  try {
    const { telegramStartLink, telegramRefLink } = require('../../utils/productOffer');
    const code = ctx && ctx.referral && ctx.referral.referrer_code;
    return code ? telegramRefLink(code) : telegramStartLink('comprar');
  } catch (_) {
    return 'https://t.me/hanork_bot?start=comprar';
  }
}

function buildHtml(order, ctx, profile) {
  const total = formatReais(order.amount_cents);
  const method = paymentMethod(order);
  const product = productLabel(order, ctx.plan);
  const when = formatLocalTime(order.updated_at || order.created_at);
  const ref = shortRef(order.id);
  const botUrl = botStartUrl(ctx);
  const userBlock = sectionHtml('👤 <b>Cliente</b>', buildClientLines(order, ctx.customer, ctx.referral, profile, true));
  const productBlock = sectionHtml('📦 <b>Produto</b>', [
    `${escapeHtml(product)} × <b>1</b> · ${escapeHtml(total)}`
  ]);
  return (
    `✅ <b>Venda confirmada</b> · <b>${escapeHtml(total)}</b> · ${escapeHtml(method)}\n\n` +
    `${userBlock}\n\n` +
    `${productBlock}\n\n` +
    `#${escapeHtml(ref)} · ${escapeHtml(when)}\n` +
    `<i>Valor desta compra: <b>${escapeHtml(total)}</b></i>\n\n` +
    `<i>Hanork · referencia verificada</i>\n\n` +
    `<a href="${escapeHtml(botUrl)}">Abrir o bot</a>\n${escapeHtml(botUrl)}`
  );
}

function buildWaText(order, ctx, profile) {
  const total = formatReais(order.amount_cents);
  const method = paymentMethod(order);
  const product = productLabel(order, ctx.plan);
  const when = formatLocalTime(order.updated_at || order.created_at);
  const ref = shortRef(order.id);
  const client = buildClientLines(order, ctx.customer, ctx.referral, profile, false).join('\n');
  const botUrl = botStartUrl(ctx);
  return (
    `Venda confirmada · ${total} · ${method}\n\n` +
    `Cliente\n${client}\n\n` +
    `Produto\n${product} × 1 · ${total}\n\n` +
    `#${ref} · ${when}\n` +
    `Hanork · referencia verificada\n\n` +
    `Abrir o bot:\n${botUrl}`
  );
}

async function alreadyPosted(orderId) {
  try {
    const { getKv } = require('../../utils/sqlStore');
    const hit = await getKv('sales_ref', String(orderId));
    return !!hit;
  } catch (_) {
    return false;
  }
}

async function markPosted(orderId) {
  try {
    const { upsertKvAsync } = require('../../utils/sqlStore');
    await upsertKvAsync('sales_ref', String(orderId), { at: Date.now() });
  } catch (_) { /* ignore */ }
}

async function postTelegram(html) {
  const channelId = getTgChannelId();
  if (!channelId) return { ok: false, reason: 'no-channel' };
  const { bot } = require('../../telegramBot');
  if (!bot || typeof bot.sendMessage !== 'function') {
    return { ok: false, reason: 'no-bot' };
  }
  await bot.sendMessage(channelId, html, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  return { ok: true, channelId };
}

function pickAdminConn() {
  try {
    const { ADMIN_IDS } = require('../../utils/userManager');
    const { getLiveConnForUser, activeConnections } = require('../../telegramBot');
    for (const id of ADMIN_IDS || []) {
      const hit = getLiveConnForUser(id);
      if (hit && hit.conn && typeof hit.conn.sendMessage === 'function') return hit.conn;
    }
    if (activeConnections && typeof activeConnections.values === 'function') {
      for (const conn of activeConnections.values()) {
        const uid = String(conn._telegramUserId || '');
        if ((ADMIN_IDS || []).map(String).includes(uid) && typeof conn.sendMessage === 'function') {
          return conn;
        }
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

async function postWhatsApp(text) {
  const { getCanalId } = require('../../utils/canal');
  const jid = getCanalId();
  if (!jid) return { ok: false, reason: 'no-wa-channel' };
  const conn = pickAdminConn();
  if (!conn) return { ok: false, reason: 'no-admin-session' };
  const { postOne } = require('../../utils/channelSend');
  await postOne(conn, jid, { text });
  return { ok: true, jid };
}

/**
 * Publica a venda no canal de referencias (idempotente por pedido).
 */
async function postSaleReference(order) {
  if (!order || !order.id) return { ok: false, reason: 'no-order' };
  if (await alreadyPosted(order.id)) return { ok: true, skipped: true, reason: 'duplicate' };

  const ctx = await loadContext(order);
  const uid = String((ctx.customer && ctx.customer.platform_user) || order.session_owner || '');
  const profile = await resolveTelegramProfile(uid);

  const html = buildHtml(order, ctx, profile);
  const wa = buildWaText(order, ctx, profile);

  let tg = { ok: false, skipped: true, reason: 'off' };
  let waRes = { ok: false, skipped: true, reason: 'off' };

  if (tgEnabled()) {
    try {
      tg = await postTelegram(html);
    } catch (e) {
      logger.logAviso(`[SALES_REF] telegram: ${e.message}`);
      tg = { ok: false, error: e.message };
    }
  }
  if (waEnabled()) {
    try {
      waRes = await postWhatsApp(wa);
    } catch (e) {
      logger.logAviso(`[SALES_REF] whatsapp: ${e.message}`);
      waRes = { ok: false, error: e.message };
    }
  }

  if (tg.ok || waRes.ok) await markPosted(order.id);
  logger.logInfo(
    `[SALES_REF] order=${String(order.id).slice(0, 8)} tg=${tg.ok ? 'ok' : (tg.reason || tg.error || 'fail')} wa=${waRes.ok ? 'ok' : (waRes.reason || waRes.error || 'fail')}`
  );
  return { ok: !!(tg.ok || waRes.ok), tg, wa: waRes };
}

module.exports = {
  postSaleReference,
  getTgChannelId,
  getTgChannelLink,
  buildHtml,
  buildWaText
};
