'use strict';
/**
 * Cache de groupMetadata.
 * IQ no WhatsApp e serial: 1 groupMetadata pendente atrasa sendMessage
 * (rate-overlimit). Caminho quente so peek. Aquecimento 1x no open.
 */
const logger = require('../logger');

const FRESH_TTL_MS = Number(process.env.HANORK_GROUP_META_TTL_MS) || 5 * 60_000;
const SECURITY_TTL_MS = Number(process.env.HANORK_GROUP_META_SECURITY_TTL_MS) || 20_000;
const STALE_TTL_MS = Number(process.env.HANORK_GROUP_META_STALE_MS) || 30 * 60_000;
const FETCH_TIMEOUT_MS = Number(process.env.HANORK_GROUP_META_TIMEOUT_MS) || 600;
const FAIL_BACKOFF_MS = Number(process.env.HANORK_GROUP_META_BACKOFF_MS) || 45_000;
const MIN_IQ_GAP_MS = Number(process.env.HANORK_GROUP_META_IQ_GAP_MS) || 60_000;
const MAX_IQ = Math.max(1, Number(process.env.HANORK_GROUP_META_MAX_IQ) || 1);
const WARM_TIMEOUT_MS = Number(process.env.HANORK_GROUP_META_WARM_MS) || 8000;

/** @type {Map<string, { meta: object, ts: number, soft?: boolean }>} */
const cache = new Map();
/** @type {Map<string, Promise<object>>} */
const inflight = new Map();
const lastFailLog = new Map();
/** @type {Map<string, number>} */
const lastFailAt = new Map();
/** @type {Map<string, number>} */
const lastIqAt = new Map();
const lastDeadIqAt = new Map();
const warmedSockets = new WeakSet();
let lastWarmLogAt = 0;
let lastFailSummaryAt = 0;
let failSummaryN = 0;

function backoffError(code, msg) {
  const err = new Error(msg);
  err.code = code;
  return err;
}

function isExpectedMetaFail(err) {
  const msg = err && err.message ? err.message : String(err || '');
  return /Timeout: groupMetadata|iq-cap|GROUP_META_|rate-overlimit|Connection Closed|not-authorized|forbidden|backoff|item-not-found/i.test(msg);
}

function logFailOnce(groupJid, err) {
  const now = Date.now();
  lastFailAt.set(groupJid, now);
  if (isExpectedMetaFail(err)) {
    failSummaryN++;
    if (now - lastFailSummaryAt < 120_000) return;
    lastFailSummaryAt = now;
    try {
      logger.logAviso(`[groupMeta] IQ recusado n=${failSummaryN} (cache/peek; send nao espera)`);
    } catch (_) { /* ignore */ }
    failSummaryN = 0;
    return;
  }
  const prev = lastFailLog.get(groupJid) || 0;
  if (now - prev < 60_000) return;
  lastFailLog.set(groupJid, now);
  const msg = err && err.message ? err.message : String(err);
  try {
    logger.logAviso(`[groupMeta] falha ${groupJid}: ${msg}`);
  } catch (_) { /* ignore */ }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout: ${label} ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function rawFetch(conn, gid) {
  const fn = conn._rawGroupMetadata || (typeof conn.groupMetadata === 'function'
    ? conn.groupMetadata.bind(conn)
    : null);
  if (!fn) return Promise.reject(new Error('no groupMetadata'));
  return fn(gid);
}

function canStartIq(gid, force) {
  if (inflight.has(gid)) return false;
  if (inflight.size >= MAX_IQ) return false;
  const now = Date.now();
  if (!force && (lastFailAt.get(gid) || 0) + FAIL_BACKOFF_MS > now) return false;
  if (!force && (lastIqAt.get(gid) || 0) + MIN_IQ_GAP_MS > now) return false;
  return true;
}

function startFetch(conn, gid, hit, force = false) {
  if (inflight.has(gid)) return inflight.get(gid);
  if (!force && inflight.size >= MAX_IQ) {
    return Promise.reject(backoffError('GROUP_META_CAP', 'groupMetadata iq-cap'));
  }
  if (!force && !canStartIq(gid, force)) {
    if (hit && hit.meta && Date.now() - hit.ts < STALE_TTL_MS) {
      return Promise.resolve(hit.meta);
    }
    return Promise.reject(backoffError('GROUP_META_BACKOFF', 'groupMetadata backoff'));
  }
  lastIqAt.set(gid, Date.now());
  const job = (async () => {
    try {
      const meta = await withTimeout(rawFetch(conn, gid), FETCH_TIMEOUT_MS, 'groupMetadata');
      cache.set(gid, { meta, ts: Date.now(), soft: false });
      lastFailAt.delete(gid);
      return meta;
    } catch (e) {
      logFailOnce(gid, e);
      try {
        const { classifyGroupFailure } = require('./groupFailure');
        if (classifyGroupFailure(e).kind === 'dead') {
          const now = Date.now();
          if (now - (lastDeadIqAt.get(gid) || 0) > 30_000) {
            lastDeadIqAt.set(gid, now);
            const dead = require('./divulgacaoDeadReplace');
            if (typeof dead.onIqGroupFailure === 'function') {
              dead.onIqGroupFailure(gid, e, conn).catch(() => {});
            }
          }
        }
      } catch (_) { /* meta→DIV opcional */ }
      if (hit && hit.meta && Date.now() - hit.ts < STALE_TTL_MS) return hit.meta;
      const err = e instanceof Error ? e : new Error(String(e));
      err.code = err.code || 'GROUP_META_FAIL';
      throw err;
    } finally {
      inflight.delete(gid);
    }
  })();
  inflight.set(gid, job);
  return job;
}

/**
 * @param {object} conn
 * @param {string} groupJid
 * @param {{ force?: boolean, wait?: boolean }} [opts]
 * @returns {Promise<object>}
 */
async function getCachedGroupMetadata(conn, groupJid, opts = {}) {
  const gid = String(groupJid || '');
  if (!gid.endsWith('@g.us')) {
    throw new Error('not a group jid');
  }
  if (!conn || typeof conn.groupMetadata !== 'function') {
    throw new Error('no groupMetadata');
  }

  const now = Date.now();
  const hit = cache.get(gid);
  const usable = !!(hit && hit.meta && now - hit.ts < STALE_TTL_MS);
  const fresh = !!(hit && hit.meta && !hit.soft && now - hit.ts < FRESH_TTL_MS);
  const wait = opts.wait !== false;

  if (!opts.force && fresh) return hit.meta;

  if (!opts.force && usable) {
    if (canStartIq(gid, false)) {
      startFetch(conn, gid, hit, false).catch(() => {});
    }
    return hit.meta;
  }

  if (!opts.force && !wait) {
    if (canStartIq(gid, false)) {
      startFetch(conn, gid, hit || null, false).catch(() => {});
    }
    throw backoffError('GROUP_META_BACKOFF', 'groupMetadata peek-only');
  }

  if (!opts.force && (lastFailAt.get(gid) || 0) + FAIL_BACKOFF_MS > now) {
    throw backoffError('GROUP_META_BACKOFF', 'groupMetadata backoff');
  }

  if (!opts.force && inflight.has(gid)) {
    return inflight.get(gid);
  }

  return startFetch(conn, gid, hit, !!opts.force);
}

async function getSecurityGroupMetadata(conn, groupJid) {
  const gid = String(groupJid || '');
  if (!gid.endsWith('@g.us')) {
    throw new Error('not a group jid');
  }
  const now = Date.now();
  const hit = cache.get(gid);
  const fresh = !!(hit && hit.meta && !hit.soft && now - hit.ts < SECURITY_TTL_MS);
  if (fresh) return hit.meta;
  if (conn && typeof conn.groupMetadata === 'function' && canStartIq(gid, false)) {
    try {
      return await startFetch(conn, gid, hit, false);
    } catch (_) { /* usa peek abaixo */ }
  }
  if (hit && hit.meta && now - hit.ts < STALE_TTL_MS) return hit.meta;
  throw backoffError('GROUP_META_STALE', 'groupMetadata security peek-only');
}

function peekGroupMetadata(groupJid) {
  const gid = String(groupJid || '');
  const hit = cache.get(gid);
  if (hit && hit.meta && Date.now() - hit.ts < STALE_TTL_MS) return hit.meta;
  return null;
}

function peekMetaStamp(groupJid) {
  const gid = String(groupJid || '');
  const hit = cache.get(gid);
  if (!hit || !hit.meta) {
    return { meta: null, ageMs: Infinity, soft: true, fresh: false };
  }
  const ageMs = Date.now() - hit.ts;
  const soft = !!hit.soft;
  return {
    meta: hit.meta,
    ageMs,
    soft,
    fresh: !soft && ageMs < SECURITY_TTL_MS
  };
}

function cloneGroupMeta(meta) {
  if (!meta) return null;
  const parts = Array.isArray(meta.participants)
    ? meta.participants.map((p) => (p && typeof p === 'object' ? { ...p } : p))
    : [];
  return { ...meta, participants: parts };
}

function putGroupMetadata(groupJid, meta) {
  const gid = String(groupJid || '');
  if (!gid || !meta) return;
  cache.set(gid, { meta, ts: Date.now(), soft: false });
}

function mergeGroupUpdate(update) {
  const gid = String(update && update.id || '');
  if (!gid.endsWith('@g.us')) return;
  const hit = cache.get(gid);
  if (!hit || !hit.meta) {
    if (update && (update.subject || update.participants)) {
      cache.set(gid, { meta: { ...update, id: gid }, ts: Date.now(), soft: true });
    }
    return;
  }
  const next = { ...hit.meta };
  if (update.subject != null) next.subject = update.subject;
  if (update.desc != null) next.desc = update.desc;
  if (update.announce != null) next.announce = update.announce;
  if (update.restrict != null) next.restrict = update.restrict;
  if (Array.isArray(update.participants) && update.participants.length) {
    next.participants = update.participants;
  }
  cache.set(gid, { meta: next, ts: Date.now(), soft: hit.soft });
}

function samePartId(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y) return false;
  if (x === y) return true;
  const nx = x.replace(/:\d+@/, '@');
  const ny = y.replace(/:\d+@/, '@');
  return nx === ny;
}

function applyParticipantUpdate(update) {
  const gid = String(update && update.id || '');
  if (!gid.endsWith('@g.us')) return;
  const people = Array.isArray(update.participants) ? update.participants : [];
  if (!people.length) return;
  const hit = cache.get(gid);
  if (!hit || !hit.meta) return;
  const action = String(update.action || '');
  const parts = Array.isArray(hit.meta.participants) ? [...hit.meta.participants] : [];

  const ids = people.map((p) => {
    try {
      return require('./groupTheftLogic').extractJidsFromParticipant(p);
    } catch (_) {
      const id = typeof p === 'string' ? p : p && p.id;
      return { id, lid: '', pn: id };
    }
  }).filter((j) => j && (j.id || j.lid || j.pn));

  const matchesPart = (p, rec) => {
    const pid = typeof p === 'string' ? p : (p && (p.id || p.phoneNumber || p.lid));
    const cand = [rec.id, rec.lid, rec.pn].filter(Boolean);
    return cand.some((id) => samePartId(pid, id))
      || (typeof p === 'object' && cand.some((id) => samePartId(p.lid, id) || samePartId(p.phoneNumber, id)));
  };

  if (action === 'add') {
    for (const rec of ids) {
      const id = rec.pn || rec.id || rec.lid;
      if (!parts.some((p) => matchesPart(p, rec))) {
        parts.push({ id, lid: rec.lid || undefined, phoneNumber: rec.pn || undefined, admin: null });
      }
    }
  } else if (action === 'remove' || action === 'leave') {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (ids.some((rec) => matchesPart(parts[i], rec))) parts.splice(i, 1);
    }
  } else if (action === 'promote') {
    for (const p of parts) {
      if (ids.some((rec) => matchesPart(p, rec))) p.admin = 'admin';
    }
  } else if (action === 'demote') {
    for (const p of parts) {
      if (ids.some((rec) => matchesPart(p, rec))) p.admin = null;
    }
  } else {
    cache.set(gid, { meta: hit.meta, ts: hit.ts, soft: true });
    return;
  }

  cache.set(gid, { meta: { ...hit.meta, participants: parts }, ts: Date.now(), soft: false });
}

function invalidateGroupMetadata(groupJid) {
  const gid = String(groupJid || '');
  if (!gid) return;
  const hit = cache.get(gid);
  if (hit && hit.meta) {
    cache.set(gid, { meta: hit.meta, ts: hit.ts, soft: true });
  } else {
    cache.delete(gid);
  }
}

/** Remove do cache de verdade — ocupacao/peek deixam de contar o grupo morto. */
function dropGroupMetadata(groupJid) {
  const gid = String(groupJid || '');
  if (!gid) return;
  cache.delete(gid);
  inflight.delete(gid);
  lastFailAt.delete(gid);
  lastIqAt.delete(gid);
  lastFailLog.delete(gid);
}

function clearGroupMetaCache() {
  cache.clear();
  inflight.clear();
}

function pruneGroupMetaCache(keep = 40) {
  if (cache.size <= keep) return 0;
  const ranked = [...cache.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
  const extra = ranked.length - keep;
  let n = 0;
  for (let i = 0; i < extra; i++) {
    cache.delete(ranked[i][0]);
    n++;
  }
  return n;
}

function peekAllGroupMetas() {
  const out = [];
  for (const [gid, hit] of cache.entries()) {
    if (hit && hit.meta && Date.now() - hit.ts < STALE_TTL_MS) {
      out.push(hit.meta.id ? hit.meta : { ...hit.meta, id: gid });
    }
  }
  return out;
}

function seedFromParticipating(all) {
  const obj = all && typeof all === 'object' ? all : {};
  let n = 0;
  for (const [jid, meta] of Object.entries(obj)) {
    if (!String(jid).endsWith('@g.us') || !meta) continue;
    cache.set(jid, { meta: { ...meta, id: meta.id || jid }, ts: Date.now(), soft: false });
    n++;
  }
  return n;
}

async function warmFromParticipating(conn) {
  if (!conn || typeof conn.groupFetchAllParticipating !== 'function') return 0;
  if (warmedSockets.has(conn)) return cache.size;
  try {
    const mem = require('./memoryWatch');
    if (typeof mem.isPressure === 'function' && mem.isPressure()) {
      try { logger.logAviso('[groupMeta] warm skip ram'); } catch (_) { /* ignore */ }
      return 0;
    }
  } catch (_) { /* memoryWatch opcional */ }
  warmedSockets.add(conn);
  try {
    const all = await withTimeout(conn.groupFetchAllParticipating(), WARM_TIMEOUT_MS, 'groupFetchAll');
    const n = seedFromParticipating(all);
    const now = Date.now();
    if (now - lastWarmLogAt > 15_000) {
      lastWarmLogAt = now;
      try { logger.logInfo(`[groupMeta] warm ${n} grupos (cache=${cache.size})`); } catch (_) { /* ignore */ }
    }
    return n;
  } catch (e) {
    logFailOnce('warm', e);
    return 0;
  }
}

function scheduleWarm(conn, delayMs = 1800) {
  if (!conn) return;
  setTimeout(() => {
    warmFromParticipating(conn).catch(() => {});
  }, Math.max(400, Number(delayMs) || 1800));
}

function stubMeta(gid) {
  return { id: gid, subject: '', participants: [], addressingMode: 'lid' };
}

function attachToConn(conn) {
  if (!conn || conn._hanorkMetaPatched) return conn;
  if (typeof conn.groupMetadata !== 'function') return conn;
  const orig = conn.groupMetadata.bind(conn);
  conn._rawGroupMetadata = orig;
  conn.groupMetadata = async (jid) => peekGroupMetadata(jid) || stubMeta(String(jid || ''));
  conn._hanorkMetaPatched = true;
  return conn;
}

function cachedGroupMetadataFn(jid) {
  return peekGroupMetadata(jid) || undefined;
}

module.exports = {
  getCachedGroupMetadata,
  getSecurityGroupMetadata,
  peekGroupMetadata,
  peekMetaStamp,
  cloneGroupMeta,
  peekAllGroupMetas,
  putGroupMetadata,
  mergeGroupUpdate,
  applyParticipantUpdate,
  invalidateGroupMetadata,
  dropGroupMetadata,
  clearGroupMetaCache,
  pruneGroupMetaCache,
  warmFromParticipating,
  scheduleWarm,
  seedFromParticipating,
  attachToConn,
  cachedGroupMetadataFn,
  FRESH_TTL_MS,
  SECURITY_TTL_MS,
  STALE_TTL_MS
};
