'use strict';
/**
 * Corta pico de RAM antes do limite da host (1536 MiB).
 * Nao mata o processo — so poda caches e tenta GC.
 */
const logger = require('../logger');

const RSS_SOFT_MB = Number(process.env.HANORK_RSS_SOFT_MB || 980);
const RSS_HARD_MB = Number(process.env.HANORK_RSS_HARD_MB || 1180);
const INTERVAL_MS = Number(process.env.HANORK_MEM_WATCH_MS || 20000);

let started = false;
let lastLog = 0;

function rssMb() {
  return Math.round(process.memoryUsage().rss / 1048576);
}

function heapMb() {
  return Math.round(process.memoryUsage().heapUsed / 1048576);
}

function rssLimitMb() {
  const n = Number(process.env.HANORK_RSS_LIMIT_MB || 1536);
  return Number.isFinite(n) && n > 256 ? n : 1536;
}

function rssPairMaxMb() {
  const pct = Number(process.env.HANORK_RSS_PAIR_PCT || 70);
  const p = Number.isFinite(pct) && pct >= 40 && pct <= 95 ? pct : 70;
  return Math.round(rssLimitMb() * p / 100);
}

function isRssHigh() {
  return rssMb() >= rssPairMaxMb();
}

/** Soft: poda + pula groupFetchAll / auto-div neste tick (host 1536MB). */
function isPressure() {
  return rssMb() >= RSS_SOFT_MB;
}

function isHardPressure() {
  return rssMb() >= RSS_HARD_MB;
}

/** Texto ASCII pro user. null = pode parear. Nao inclui ids. */
function pairBlockReason() {
  if (!isRssHigh()) return null;
  return `RAM alta (${rssMb()}MB). Nao da pra parear agora. Apague uma sessao ou aguarde.`;
}

function pruneNow(keep) {
  let n = 0;
  try {
    n += require('../cache').pruneAllCaches(keep) || 0;
  } catch (_) { /* ignore */ }
  try {
    const meta = require('./groupMetaCache');
    if (typeof meta.pruneGroupMetaCache === 'function') {
      n += meta.pruneGroupMetaCache(250) || 0;
    }
  } catch (_) { /* ignore */ }
  try {
    if (typeof global.gc === 'function') global.gc();
  } catch (_) { /* ignore */ }
  return n;
}

function tick() {
  const rss = rssMb();
  const heap = heapMb();
  if (rss < RSS_SOFT_MB && heap < 420) return;

  const hard = rss >= RSS_HARD_MB;
  const n = pruneNow(hard ? 180 : 500);
  const now = Date.now();
  if (now - lastLog > 25000) {
    lastLog = now;
    logger.logAviso(
      `[MEM] rss=${rss}MB heap=${heap}MB prune=${n} alvo<${RSS_SOFT_MB} (host 1536MB)`
    );
  }
}

function startMemoryWatch() {
  if (started) return;
  started = true;
  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 8000);
}

module.exports = {
  startMemoryWatch,
  pruneNow,
  rssMb,
  rssLimitMb,
  rssPairMaxMb,
  isRssHigh,
  isPressure,
  isHardPressure,
  pairBlockReason
};
