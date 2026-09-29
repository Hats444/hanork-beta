'use strict';
/**
 * Quota diaria de consultas (VIP). Contador em RAM + dia UTC.
 * Dono/admin = limite alto ou ilimitado.
 */

const { dayKey } = require('./opsMetrics');

const bag = new Map(); // day|uid -> count

function dailyLimitFor(role, telegramUserId) {
  const r = String(role || '').toLowerCase();
  try {
    const { ADMIN_IDS } = require('./userManager');
    if (ADMIN_IDS && ADMIN_IDS.map(String).includes(String(telegramUserId || ''))) {
      return 0; // ilimitado
    }
  } catch (_) { /* ignore */ }
  if (r === 'owner' || r === 'dono') {
    const n = parseInt(process.env.HANORK_CONSULTA_OWNER_DAILY || '500', 10);
    return Number.isFinite(n) ? Math.max(0, n) : 500;
  }
  if (r === 'vip') {
    const n = parseInt(process.env.HANORK_CONSULTA_VIP_DAILY || '40', 10);
    return Number.isFinite(n) ? Math.max(0, n) : 40;
  }
  // user comum nao deveria chegar aqui (gate role)
  return parseInt(process.env.HANORK_CONSULTA_USER_DAILY || '5', 10) || 5;
}

function key(uid) {
  return `${dayKey()}|${String(uid || 'anon')}`;
}

function usedToday(uid) {
  return bag.get(key(uid)) || 0;
}

function bump(uid) {
  const k = key(uid);
  const n = (bag.get(k) || 0) + 1;
  bag.set(k, n);
  if (bag.size > 5000) {
    const today = dayKey();
    for (const kk of [...bag.keys()]) {
      if (!kk.startsWith(today)) bag.delete(kk);
    }
  }
  return n;
}

/**
 * @returns {{ ok: boolean, used: number, limit: number, message?: string }}
 */
function checkAndConsume(uid, role, platform) {
  const limit = dailyLimitFor(role, uid);
  if (limit <= 0) return { ok: true, used: usedToday(uid), limit: 0 };
  const used = usedToday(uid);
  if (used >= limit) {
    const tg = String(platform || '').toLowerCase() === 'telegram';
    return {
      ok: false,
      used,
      limit,
      message:
        `Limite diario de consultas (${limit}).\n` +
        (tg
          ? `Renove/amplie: /comprar  |  /minhaconta\nOu aguarde amanha.`
          : `Renove/amplie: .comprar  |  .minhaconta\nOu aguarde amanha.`)
    };
  }
  const next = bump(uid);
  return { ok: true, used: next, limit };
}

module.exports = {
  dailyLimitFor,
  usedToday,
  checkAndConsume
};
