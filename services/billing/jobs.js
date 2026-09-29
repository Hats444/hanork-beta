'use strict';

const logger = require('../../logger');
const store = require('./store');
const mp = require('./mercadoPagoService');
const { handleApproved } = require('./webhookService');

let pollTimer = null;
let expireTimer = null;
let warnTimer = null;
let lastWarnDay = '';

function brtDay() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

function brtHour() {
  try {
    const h = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false
    }).format(new Date());
    return parseInt(h, 10);
  } catch (_) {
    return new Date().getUTCHours() - 3;
  }
}

async function pollOnce() {
  if (!mp.isConfigured() || String(process.env.PIX_AUTO_POLL || '1') === '0') return 0;
  const orders = await store.pendingPixOrders();
  let n = 0;
  for (const order of orders) {
    try {
      let hits = [];
      if (order.mp_payment_id) {
        const one = await mp.getStatus(order.mp_payment_id);
        hits = [one];
      } else {
        hits = await mp.findByReference(order.id);
      }
      const approved = hits.find((h) => String(h.status).toLowerCase() === 'approved');
      await store.updateOrder(order.id, {
        status: order.status,
        mp_payment_id: approved?.id || order.mp_payment_id,
        mp_preference_id: order.mp_preference_id,
        poll_count: Number(order.poll_count || 0) + 1
      });
      if (approved) {
        await handleApproved(approved);
        n++;
      }
    } catch (e) {
      logger.logAviso(`[billing] poll order=${String(order.id).slice(0, 8)}: ${e.message}`);
    }
  }
  return n;
}

async function reconcileBoot() {
  try {
    await store.seedPlans();
    await store.warmVipIndex();
    await store.expireDue();
    if (mp.isConfigured()) await pollOnce();
  } catch (e) {
    logger.logAviso(`[billing] reconcile: ${e.message}`);
  }
}

async function warnVipIfDue() {
  const hour = parseInt(process.env.HANORK_VIP_WARN_HOUR || '10', 10);
  const day = brtDay();
  if (brtHour() !== (Number.isFinite(hour) ? hour : 10)) return;
  if (lastWarnDay === day) return;
  lastWarnDay = day;
  await store.warnVipExpiring();
}

function startJobs() {
  try {
    const { isOwnerOnlyMode } = require('../../utils/ownerOnlyMode');
    if (isOwnerOnlyMode()) {
      logger.logInfo('[billing] jobs off (HANORK_OWNER_ONLY)');
      return;
    }
  } catch (_) { /* */ }
  reconcileBoot().catch(() => {});
  setTimeout(() => {
    const pn = require('./paywallNotice');
    const fn = pn.sendNoticeIfNeeded || pn.sendNoticeIfNeeded;
    Promise.resolve(fn && fn()).catch((e) => {
      logger.logAviso(`[paywall] notice: ${e.message}`);
    });
  }, 20000);
  if (pollTimer) clearInterval(pollTimer);
  if (expireTimer) clearInterval(expireTimer);
  if (warnTimer) clearInterval(warnTimer);
  const pollMs = Math.max(15000, parseInt(process.env.PIX_AUTO_POLL_INTERVAL_MS || '30000', 10));
  pollTimer = setInterval(() => {
    pollOnce().catch((e) => logger.logAviso(`[billing] poll: ${e.message}`));
  }, pollMs);
  pollTimer.unref?.();
  expireTimer = setInterval(() => {
    store.expireDue().catch((e) => logger.logAviso(`[billing] expire: ${e.message}`));
  }, 10 * 60 * 1000);
  expireTimer.unref?.();
  warnTimer = setInterval(() => {
    warnVipIfDue().catch((e) => logger.logAviso(`[billing] vip-warn: ${e.message}`));
    store.remindStaleCheckouts().catch((e) => logger.logAviso(`[billing] cart-remind: ${e.message}`));
    require('./paywallNotice').sendReminderIfDue().catch((e) => logger.logAviso(`[paywall] remind: ${e.message}`));
  }, 60 * 1000);
  warnTimer.unref?.();
}

function stopJobs() {
  if (pollTimer) clearInterval(pollTimer);
  if (expireTimer) clearInterval(expireTimer);
  if (warnTimer) clearInterval(warnTimer);
  pollTimer = null;
  expireTimer = null;
  warnTimer = null;
}

module.exports = { startJobs, startJobs, stopJobs, pollOnce, reconcileBoot, warnVipIfDue };
