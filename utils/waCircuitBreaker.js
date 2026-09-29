'use strict';
/**
 * Circuit breaker / cooldown unico para automacao WA (JOIN, DIV, send).
 * Reversivel: callers podem continuar usando waSendPatch.waOverHot / markWaOverlimit.
 */
const logger = require('../logger');

let openUntil = 0;
/** @type {Map<string, number>} */
const keyUntil = new Map();

function trip(ms, opts = {}) {
  const win = Number(ms);
  const add = Number.isFinite(win) && win > 0 ? win : 25_000;
  openUntil = Math.max(openUntil, Date.now() + add);
  if (opts.fanoutJoinCooldown !== false) {
    try {
      const limits = require('./groupManager/limits');
      const { getAllSessions } = require('./sessionRegistry');
      const cool = Number(opts.joinCooldownMs);
      const joinMs = Number.isFinite(cool) && cool > 0 ? cool : 10 * 60 * 1000;
      const seen = new Set();
      for (const s of getAllSessions() || []) {
        const uid = String(s?.telegramUserId || '').trim();
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        limits.setRateCooldown(uid, joinMs);
      }
    } catch (_) { /* opcional */ }
  }
  if (opts.log !== false) {
    try {
      logger.logInfo(`[WA_CB] trip ms=${add} until=${new Date(openUntil).toISOString()}`);
    } catch (_) { /* ignore */ }
  }
  return openUntil;
}

function isOpen() {
  return Date.now() < openUntil;
}

function remainingMs() {
  return Math.max(0, openUntil - Date.now());
}

function reset() {
  openUntil = 0;
}

function tripKey(key, ms) {
  const k = String(key || '').trim();
  if (!k) return 0;
  const win = Number(ms);
  const add = Number.isFinite(win) && win > 0 ? win : 60_000;
  const until = Math.max(Number(keyUntil.get(k)) || 0, Date.now() + add);
  keyUntil.set(k, until);
  return until;
}

function isKeyOpen(key) {
  const k = String(key || '').trim();
  if (!k) return false;
  const until = Number(keyUntil.get(k)) || 0;
  if (until <= Date.now()) {
    if (until) keyUntil.delete(k);
    return false;
  }
  return true;
}

function keyRemainingMs(key) {
  const k = String(key || '').trim();
  if (!k) return 0;
  return Math.max(0, (Number(keyUntil.get(k)) || 0) - Date.now());
}

/** Aliases legados (waSendPatch) */
const markWaOverlimit = (ms) => trip(ms, { fanoutJoinCooldown: true, log: false });
const waOverHot = isOpen;
const clearWaOverlimit = reset;

module.exports = {
  trip,
  isOpen,
  remainingMs,
  reset,
  tripKey,
  isKeyOpen,
  keyRemainingMs,
  markWaOverlimit,
  waOverHot,
  clearWaOverlimit
};
