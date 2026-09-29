'use strict';
/**
 * Indice sincrono de VIP pago + product_tier (SQL e a fonte; isto e cache).
 */

const keys = new Set();
const tiers = new Map();
const daypassKeys = new Set();

function norm(platform, user) {
  const p = String(platform || '').toLowerCase();
  let u = String(user || '').trim().toLowerCase().replace(/:\d+(?=@)/, '');
  if (!p || !u) return '';
  return `${p}|${u}`;
}

function remember(platform, user, tier, opts = {}) {
  const k = norm(platform, user);
  if (!k) return;
  keys.add(k);
  const t = String(tier || '').toLowerCase();
  if (t === 'starter' || t === 'pro' || t === 'enterprise') tiers.set(k, t);
  else if (!tiers.has(k)) tiers.set(k, 'pro');
  if (opts && opts.daypass) daypassKeys.add(k);
  else if (opts && opts.daypass === false) daypassKeys.delete(k);
}

function forget(platform, user) {
  const k = norm(platform, user);
  if (k) {
    keys.delete(k);
    tiers.delete(k);
    daypassKeys.delete(k);
  }
}

function has(platform, user) {
  const k = norm(platform, user);
  return !!(k && keys.has(k));
}

function hasAny(platform, users) {
  return (users || []).some((u) => has(platform, u));
}

function tierOf(platform, user) {
  const k = norm(platform, user);
  if (!k || !keys.has(k)) return 'free';
  return tiers.get(k) || 'pro';
}

function tierOfAny(platform, users) {
  let best = 'free';
  const { rankOfTier } = require('./logic');
  for (const u of users || []) {
    const t = tierOf(platform, u);
    if (rankOfTier(t) > rankOfTier(best)) best = t;
  }
  return best;
}

function isDaypass(platform, user) {
  const k = norm(platform, user);
  return !!(k && daypassKeys.has(k));
}

function isDaypassAny(platform, users) {
  return (users || []).some((u) => isDaypass(platform, u));
}

function clear() {
  keys.clear();
  tiers.clear();
  daypassKeys.clear();
}

function size() {
  return keys.size;
}

module.exports = { remember, forget, has, hasAny, tierOf, tierOfAny, isDaypass, isDaypassAny, clear, size, norm };
