'use strict';
/**
 * Contadores leves pro relatorio diario / health (sem PII).
 * Janela: dia UTC (YYYY-MM-DD).
 */

const dayMap = new Map(); // day -> metrics

function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function bag(day) {
  const k = day || dayKey();
  if (!dayMap.has(k)) {
    dayMap.set(k, {
      kicks: 0,
      kickReasons: {},
      joins: 0,
      leaves: 0,
      divOk: 0,
      divFail: 0,
      sales: 0,
      daypassPaid: 0,
      proPaid: 0,
      entPaid: 0,
      funnelHome: 0,
      daypassCheckout: 0,
      proCheckout: 0,
      sessionDead: 0,
      antirouboApply: 0,
      antirouboGpuOk: 0,
      antirouboGpuFail: 0
    });
  }
  // poda dias antigos
  if (dayMap.size > 4) {
    const keys = [...dayMap.keys()].sort();
    while (keys.length > 3) dayMap.delete(keys.shift());
  }
  return dayMap.get(k);
}

function bump(field, n = 1) {
  const b = bag();
  if (typeof b[field] === 'number') b[field] += n;
  return b;
}

function bumpKick(reason) {
  const b = bag();
  b.kicks += 1;
  const r = String(reason || 'other').slice(0, 40);
  b.kickReasons[r] = (b.kickReasons[r] || 0) + 1;
  return b;
}

/** Streak de falha DIV por telegramUserId — alerta TG a cada N. */
const divFailStreak = new Map();
const lastDivAlert = new Map();

function isExpectedDivFail(reason) {
  return /forbidden|not-authorized|backoff|item-not-found|GROUP_META_|rate-overlimit|not-found/i.test(
    String(reason || '')
  );
}

function noteDivGroupResult(telegramUserId, { ok = false, fail = false, reason = '' } = {}) {
  const uid = String(telegramUserId || '');
  if (!uid) return;
  if (ok) {
    divFailStreak.set(uid, 0);
    return;
  }
  if (!fail) return;
  // Sem detalhe ou forbidden/backoff = ruído. Só alerta erro inesperado (socket, bug).
  if (!reason || isExpectedDivFail(reason)) return;
  const n = (divFailStreak.get(uid) || 0) + 1;
  divFailStreak.set(uid, n);
  const thr = parseInt(process.env.HANORK_DIV_FAIL_ALERT || '8', 10) || 8;
  if (n < thr) return;
  if (n % thr !== 0) return;
  const now = Date.now();
  if ((lastDivAlert.get(uid) || 0) + 60 * 60 * 1000 > now) return;
  lastDivAlert.set(uid, now);
  try {
    const { notifyAdmins } = require('../services/billing/notify');
    notifyAdmins(
      `DIV falha inesperada uid=..${uid.slice(-4)} streak=${n}\n` +
        `Motivo: ${String(reason || 'sem detalhe').slice(0, 80)}\n` +
        `Health no painel Admin.`
    ).catch(() => {});
  } catch (_) { /* ignore */ }
}

function snapshot(day) {
  const b = { ...bag(day) };
  b.kickReasons = { ...(b.kickReasons || {}) };
  b.day = day || dayKey();
  return b;
}

function formatDayReport(day) {
  const s = snapshot(day);
  const bits = [];
  if (s.joins) bits.push(s.joins + ' pessoas entraram');
  if (s.leaves) bits.push(s.leaves + ' sairam');
  if (s.kicks) bits.push(s.kicks + ' removidos');
  if (s.divOk || s.divFail) bits.push('divulgacao ' + s.divOk + ' ok / ' + s.divFail + ' falhou');
  if (s.sales) bits.push(s.sales + ' venda');
  if (s.daypassPaid) bits.push(s.daypassPaid + ' plano de 1 dia');
  if (s.proPaid) bits.push(s.proPaid + ' plano de 30 dias');
  if (s.funnelHome) bits.push(s.funnelHome + ' viram os planos');
  if (s.daypassCheckout) bits.push(s.daypassCheckout + ' PIX de 1 dia');
  if (s.proCheckout) bits.push(s.proCheckout + ' PIX de 30 dias');
  if (s.sessionDead) bits.push(s.sessionDead + ' conta caiu');
  if (s.antirouboApply) bits.push('anti-roubo ' + s.antirouboApply);
  if (!bits.length) return '';
  return bits.join(' · ');
}

module.exports = {
  dayKey,
  bump,
  bumpKick,
  noteDivGroupResult,
  snapshot,
  formatDayReport
};
