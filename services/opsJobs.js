'use strict';
/**
 * Jobs operacionais: recado diario no Telegram so pra TELEGRAM_ADMIN_IDS.
 * Nunca vai pra cliente.
 */

const logger = require('../logger');

let timer = null;

function reportHourBrt() {
  const n = parseInt(process.env.HANORK_DAILY_REPORT_HOUR || '9', 10);
  return Number.isFinite(n) ? Math.min(23, Math.max(0, n)) : 9;
}

function brtParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10)
  };
}

async function alreadySent(day) {
  try {
    const { getKv } = require('../utils/sqlStore');
    const v = await getKv('ops', 'daily_report_day');
    return String(v || '') === String(day);
  } catch (_) {
    return false;
  }
}

async function markSent(day) {
  try {
    const { upsertKvAsync } = require('../utils/sqlStore');
    await upsertKvAsync('ops', 'daily_report_day', String(day));
  } catch (_) { /* ignore */ }
}

async function sendDailyIfDue(force = false) {
  if (String(process.env.HANORK_DAILY_REPORT || '1') === '0' && !force) return;
  const { day, hour } = brtParts();
  const want = reportHourBrt();
  if (!force) {
    if (hour !== want) return;
    // Restart as 09h disparava de novo (uptime 1 min). Espera o processo firmar.
    if (process.uptime() < 12 * 60) return;
    if (await alreadySent(day)) return;
  }
  try {
    const { formatOpsHealthText } = require('../utils/opsHealth');
    const { ADMIN_IDS } = require('../utils/userManager');
    const adminId = String((ADMIN_IDS && ADMIN_IDS[0]) || '');
    const extra = {};
    try {
      const store = require('./billing/store');
      const w = await store.weekSales();
      const reais = (Number(w.cents || 0) / 100).toFixed(0);
      extra.weekLine =
        `Essa semana: ${w.count} venda(s), R$${reais}` +
        ` (sendo ${w.vip} de VIP e ${w.bot} de bot)`;
      if (w.lastPaidAt) {
        const days = Math.floor((Date.now() - Date.parse(w.lastPaidAt)) / 86400000);
        const lim = Math.max(2, Number(process.env.HANORK_SALE_SILENCE_DAYS || 5));
        if (Number.isFinite(days) && days >= lim) {
          extra.silenceLine = `Sem venda nova ha ${days} dias.`;
        }
      } else {
        extra.silenceLine = 'Nenhuma venda registrada ainda.';
      }
    } catch (_) { /* billing opcional */ }
    const body = formatOpsHealthText(adminId, extra);
    if (!body || !String(body).trim()) return;
    await markSent(day);
    const { upsertStickyPhoto } = require('../utils/tgStickyNotice');
    for (const id of ADMIN_IDS || []) {
      await upsertStickyPhoto({
        chatId: id,
        kvKey: `daily_report_${day}_${id}`,
        caption: body
      });
    }
    logger.logInfo(`[ops] recado diario enviado day=${day} admins=${(ADMIN_IDS || []).length}`);
  } catch (e) {
    logger.logAviso(`[ops] relatorio: ${e.message}`);
  }
}

function startJobs() {
  if (timer) return;
  timer = setInterval(() => {
    sendDailyIfDue(false).catch(() => {});
    try { require('./autoDivBot').tick().catch(() => {}); } catch (_) { /* opcional */ }
    try { require('../utils/offsiteBackup').tick().catch(() => {}); } catch (_) { /* flag OFF */ }
    try { require('../utils/shopHours').tick().catch(() => {}); } catch (_) { /* */ }
    try { require('../utils/groupModJobs').tick().catch(() => {}); } catch (_) { /* */ }
    try { require('../utils/opsAlerts').tick().catch(() => {}); } catch (_) { /* */ }
    try {
      const { getAllSessions } = require('../utils/sessionRegistry');
      const gm = require('../utils/groupManager');
      const seen = new Set();
      for (const s of getAllSessions() || []) {
        const uid = String(s.telegramUserId || '');
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        try {
          if (!gm.listLiveConns(uid).length) continue;
        } catch (_) { continue; }
        gm.maintainOccupancy(uid).catch(() => {});
      }
    } catch (_) { /* repor ocupacao opcional */ }
  }, 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  logger.logInfo(`[ops] recado diario hour=BRT ${reportHourBrt()} so TELEGRAM_ADMIN_IDS`);
  try { require('../utils/botGate').warm().catch(() => {}); } catch (_) { /* */ }
  scheduleCompVipOnce(0);
}

const COMP_VIP_TG = '6357465155';
const COMP_VIP_KV = 'comp_vip_6357465155_20260904';
const COMP_VIP_TEXT = [
  'VIP Pro de 30 dias ja esta ativo na sua conta (cortesia).',
  '',
  'Sua sessao do WhatsApp caiu hoje — o Zap recusou o bot. Reconecta com /conectar e deixa ligado.',
  '',
  'Desculpa a bagunca nos grupos. Qualquer coisa: /suporte'
].join('\n');

function scheduleCompVipOnce(attempt) {
  const delay = attempt <= 0 ? 8000 : 20000;
  const t = setTimeout(() => {
    runCompVipOnce(attempt).catch((e) => {
      logger.logAviso(`[ops] comp vip: ${e.message}`);
    });
  }, delay);
  if (typeof t.unref === 'function') t.unref();
}

async function runCompVipOnce(attempt) {
  const n = Number(attempt) || 0;
  try {
    const { getKv, upsertKvAsync } = require('../utils/sqlStore');
    const prev = String(await getKv('ops', COMP_VIP_KV) || '');
    if (prev === '1') return;
    if (prev !== 'granted') {
      const store = require('./billing/store');
      const granted = await store.grantComplimentaryVip(COMP_VIP_TG, 30, { planId: 'pro_m' });
      if (!granted || !granted.ok) {
        if (granted && granted.reason === 'sql-cold' && n < 8) {
          scheduleCompVipOnce(n + 1);
          return;
        }
        logger.logAviso(`[ops] comp vip skip reason=${granted && granted.reason}`);
        return;
      }
      try {
        const gm = require('../utils/groupManager');
        gm.saveLimits(COMP_VIP_TG, { autoRefill: true });
        gm.setPaused(COMP_VIP_TG, false);
      } catch (_) { /* limites opcional */ }
      await upsertKvAsync('ops', COMP_VIP_KV, 'granted');
    }
    let bot = null;
    try { bot = require('../telegramBot').bot; } catch (_) { bot = null; }
    if (!bot) {
      if (n < 8) scheduleCompVipOnce(n + 1);
      return;
    }
    await bot.sendMessage(COMP_VIP_TG, COMP_VIP_TEXT);
    await upsertKvAsync('ops', COMP_VIP_KV, '1');
    logger.logInfo('[ops] comp vip 30d ok + aviso tg');
  } catch (e) {
    logger.logAviso(`[ops] comp vip: ${e.message}`);
    if (n < 8) scheduleCompVipOnce(n + 1);
  }
}

function stopJobs() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startJobs, stopJobs, sendDailyIfDue };
