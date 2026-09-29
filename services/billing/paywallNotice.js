'use strict';

const logger = require('../../logger');
const paywall = require('../../utils/paywall');

async function alreadySent(key) {
  try {
    const { getKv } = require('../../utils/sqlStore');
    return !!(await getKv('billing', key));
  } catch (_) {
    return false;
  }
}

async function markSent(key) {
  try {
    const { upsertKvAsync } = require('../../utils/sqlStore');
    await upsertKvAsync('billing', key, { at: Date.now(), cutoff: paywall.formatCutoffBr() });
  } catch (_) { /* ignore */ }
}

function uniqueSessionOwners() {
  const { getAllSessions } = require('../../utils/sessionRegistry');
  const { isAdmin } = require('../../utils/userManager');
  const seen = new Set();
  const list = [];
  for (const s of getAllSessions() || []) {
    const tid = String(s.telegramUserId || '').trim();
    if (!tid || seen.has(tid) || isAdmin(tid)) continue;
    seen.add(tid);
    list.push({ telegramUserId: tid, sessionId: s.sessionId });
  }
  return list;
}

async function sendOneTelegram(tid, text) {
  const { bot } = require('../../telegramBot');
  if (!bot || typeof bot.sendMessage !== 'function') return false;
  await bot.sendMessage(tid, text);
  return true;
}

async function sendOneWhatsApp(tid, text) {
  try {
    const { getLiveConnForUser } = require('../../telegramBot');
    const hit = getLiveConnForUser(tid);
    const conn = hit && hit.conn;
    if (!conn || typeof conn.sendMessage !== 'function' || !conn.user) return false;
    const me = conn.user.id || conn.user.jid;
    if (!me) return false;
    await conn.sendMessage(me, { text }, { _hanorkTrusted: true });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Recado 1x (ou lembrete D-1). Nao manda pra TELEGRAM_ADMIN_IDS.
 */
async function sendPaywallNotice(kind = 'notice') {
  if (!paywall.isPaywallEnabled()) return { ok: false, skipped: true, reason: 'off' };
  const key = kind === 'remind' ? 'paywall_remind_d1' : 'paywall_notice_sent';
  if (await alreadySent(key)) return { ok: true, skipped: true, reason: 'already' };

  const owners = uniqueSessionOwners();
  const tgText = paywall.noticeText('telegram', kind);
  const waText = paywall.noticeText('whatsapp', kind);
  let tg = 0;
  let wa = 0;
  for (const row of owners) {
    try {
      if (await sendOneTelegram(row.telegramUserId, tgText)) tg += 1;
    } catch (e) {
      logger.logAviso(`[paywall] tg ${row.telegramUserId}: ${e.message}`);
    }
    try {
      if (await sendOneWhatsApp(row.telegramUserId, waText)) wa += 1;
    } catch (_) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  await markSent(key);
  logger.logInfo(`[paywall] ${kind} tg=${tg} wa=${wa} cutoff=${paywall.formatCutoffBr()}`);
  try {
    const { notifyAdmins } = require('./notify');
    await notifyAdmins(
      `Paywall ${kind}: aviso em ${tg} Telegram / ${wa} Zap. Corte ${paywall.formatCutoffBr()}. Sessoes intactas.`
    );
  } catch (_) { /* ignore */ }
  return { ok: true, tg, wa, total: owners.length };
}

async function sendNoticeIfNeeded() {
  return sendPaywallNotice('notice');
}

async function sendReminderIfDue() {
  if (!paywall.isPaywallEnabled() || paywall.isPaywallActive()) return { ok: true, skipped: true };
  const days = paywall.daysUntilCutoff();
  if (days !== 1) return { ok: true, skipped: true, reason: 'not-d1' };
  const hour = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false });
  const h = parseInt(hour, 10);
  if (h !== 10) return { ok: true, skipped: true, reason: 'hour' };
  return sendPaywallNotice('remind');
}

module.exports = {
  sendPaywallNotice,
  sendNoticeIfNeeded,
  sendReminderIfDue
};
