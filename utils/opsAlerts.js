'use strict';
/**
 * Alertas minimos no TG dos TELEGRAM_ADMIN_IDS:
 * - sessao admin caiu e nao voltou em X min
 * - fila de jobs inchada
 * - taxa de erro de cmds acima do normal
 * Reversivel: HANORK_OPS_ALERTS=0
 */
const logger = require('../logger');

const lastAlert = new Map();
/** sessionId -> sinceMs when first seen down while expected up */
const downSince = new Map();
let sawConnected = new Set();

function enabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.HANORK_OPS_ALERTS || '1').trim());
}

function cooldownMs() {
  const n = Number(process.env.HANORK_OPS_ALERT_COOLDOWN_MS || 15 * 60 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
}

function canAlert(key) {
  const prev = Number(lastAlert.get(key)) || 0;
  if (Date.now() - prev < cooldownMs()) return false;
  lastAlert.set(key, Date.now());
  return true;
}

async function notifyAdmins(text) {
  const body = String(text || '').slice(0, 3500);
  if (!body) return;
  let ids = [];
  try {
    const { ADMIN_IDS } = require('./userManager');
    ids = (ADMIN_IDS || []).map(String).filter(Boolean);
  } catch (_) { /* ignore */ }
  if (!ids.length) {
    ids = String(process.env.TELEGRAM_ADMIN_IDS || '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  let bot = null;
  try {
    bot = require('../telegramBot').bot;
  } catch (_) {
    bot = null;
  }
  if (!bot || typeof bot.sendMessage !== 'function') {
    logger.logAviso(`[OPS_ALERT] (sem bot TG) ${body.slice(0, 120)}`);
    return;
  }
  for (const id of ids) {
    try {
      await bot.sendMessage(id, body);
    } catch (e) {
      logger.logAviso(`[OPS_ALERT] tg ${id}: ${e.message}`);
    }
  }
}

function listLiveSessionIds() {
  const out = new Set();
  try {
    const { getAllSessions } = require('./sessionRegistry');
    for (const s of getAllSessions() || []) {
      if (s?.sessionId) out.add(String(s.sessionId));
    }
  } catch (_) { /* ignore */ }
  try {
    const gm = require('./groupManager');
    const { ADMIN_IDS } = require('./userManager');
    for (const uid of ADMIN_IDS || []) {
      for (const c of gm.listLiveConns(String(uid)) || []) {
        const sid = c?._sessionId || c?.sessionId;
        if (sid) out.add(String(sid));
      }
    }
  } catch (_) { /* ignore */ }
  return out;
}

async function checkSessionsDown() {
  const graceMin = Math.max(2, Number(process.env.HANORK_OPS_SESSION_DOWN_MIN || 5) || 5);
  const graceMs = graceMin * 60 * 1000;
  let adminSessions = [];
  try {
    const { getAllSessions } = require('./sessionRegistry');
    const { isAdmin } = require('./userManager');
    adminSessions = (getAllSessions() || []).filter((s) => isAdmin(String(s.telegramUserId || '')));
  } catch (_) {
    return;
  }
  const live = listLiveSessionIds();
  for (const s of adminSessions) {
    const sid = String(s.sessionId || '');
    if (!sid) continue;
    const up = live.has(sid) || String(s.status || '') === 'connected';
    if (up) {
      sawConnected.add(sid);
      downSince.delete(sid);
      continue;
    }
    if (!sawConnected.has(sid) && String(s.status || '') !== 'connected') continue;
    if (!downSince.has(sid)) downSince.set(sid, Date.now());
    const since = downSince.get(sid);
    if (Date.now() - since < graceMs) continue;
    if (!canAlert(`sess_down:${sid}`)) continue;
    await notifyAdmins(
      `[Hanork] Sessao admin OFF ha ~${graceMin}+ min\nsid=${sid.slice(0, 12)}\nstatus=${s.status || '?'}`
    );
  }
}

async function checkQueueStuck() {
  let stats = { localPending: 0, localRunning: 0 };
  try {
    stats = require('../services/jobQueue').getQueueStats() || stats;
  } catch (_) {
    return;
  }
  const maxPending = Math.max(20, Number(process.env.HANORK_OPS_QUEUE_ALERT || 80) || 80);
  if (Number(stats.localPending) < maxPending) return;
  if (!canAlert('queue_stuck')) return;
  await notifyAdmins(
    `[Hanork] Fila de jobs inchada\npending=${stats.localPending} running=${stats.localRunning} mode=${stats.mode}`
  );
}

async function checkErrorRate() {
  let st = { ok: 0, err: 0, windowMin: 60 };
  try {
    st = require('../core/router/cmdStats').getCmdStats() || st;
  } catch (_) {
    return;
  }
  const total = Number(st.ok || 0) + Number(st.err || 0);
  if (total < 20) return;
  const rate = Number(st.err || 0) / total;
  const maxRate = Math.min(0.9, Math.max(0.2, Number(process.env.HANORK_OPS_ERR_RATE || 0.4) || 0.4));
  if (rate < maxRate) return;
  if (!canAlert('err_rate')) return;
  const top = (st.topErr || [])
    .slice(0, 3)
    .map((t) => `${t.cmd}:${t.err}`)
    .join(' ');
  await notifyAdmins(
    `[Hanork] Taxa de erro alta (~${Math.round(rate * 100)}% em ${st.windowMin}min)\nok=${st.ok} err=${st.err}\n${top}`
  );
}

async function tick() {
  if (!enabled()) return;
  if (process.uptime() < 180) return;
  try {
    await checkSessionsDown();
  } catch (e) {
    logger.logAviso(`[OPS_ALERT] sess: ${e.message}`);
  }
  try {
    await checkQueueStuck();
  } catch (e) {
    logger.logAviso(`[OPS_ALERT] queue: ${e.message}`);
  }
  try {
    await checkErrorRate();
  } catch (e) {
    logger.logAviso(`[OPS_ALERT] err: ${e.message}`);
  }
}

module.exports = {
  tick,
  notifyAdmins,
  enabled,
  checkSessionsDown,
  checkQueueStuck,
  checkErrorRate
};
