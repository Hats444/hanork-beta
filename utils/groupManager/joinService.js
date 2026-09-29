'use strict';

const logger = require('../../logger');
const { delay } = require('../../utils');
const inviteStore = require('./inviteStore');
const limits = require('./limits');
const { registerJoinedGroup, officialList, maskJid } = require('./registry');

const ownerLocks = new Map();
const occCache = new Map();
const lastGoodOcc = new Map();
const OCC_TTL_MS = 30000;
const FETCH_MS = 8000;

function invalidateOccupancyCache(ownerKey) {
  if (ownerKey) occCache.delete(String(ownerKey));
  else occCache.clear();
}

function participatingJidsFromFetch(all) {
  const out = new Set();
  if (all == null) return [];
  const add = (k, meta) => {
    const id = String(k || (meta && (meta.id || meta.jid)) || '');
    if (id.endsWith('@g.us')) out.add(id);
    if (meta && String(meta.id || '').endsWith('@g.us')) out.add(String(meta.id));
  };
  if (typeof all.forEach === 'function' && typeof all.get === 'function' && typeof all.keys === 'function') {
    for (const [k, v] of all.entries()) add(k, v);
  } else if (Array.isArray(all)) {
    for (const item of all) {
      if (typeof item === 'string') add(item);
      else add(item && (item.id || item.jid), item);
    }
  } else if (typeof all === 'object') {
    for (const [k, v] of Object.entries(all)) add(k, v);
  }
  return [...out];
}

function countFromFetch(all) {
  return participatingJidsFromFetch(all).length;
}

function countGroupsFromConnMemory(conn) {
  const src = (conn && conn.store && conn.store.chats) || (conn && conn.chats);
  if (!src) return 0;
  return participatingJidsFromFetch(src).length;
}

/** Fetch vazio/raso vs lista/convites/ultima boa = nao confiavel (nao e "0 grupos"). */
function trustLiveCount(fetched, floor) {
  const n = fetched == null ? null : Number(fetched);
  const f = Math.max(0, Number(floor) || 0);
  if (n == null || !Number.isFinite(n) || n < 0) return false;
  if (f <= 2) return true;
  if (n === 0) return false;
  if (n < Math.ceil(f * 0.5)) return false;
  return true;
}

function occupancyHave({ live, trusted, floor }) {
  const f = Math.max(0, Number(floor) || 0);
  if (trusted && live != null && Number.isFinite(Number(live))) return Number(live);
  return Math.max(Number(live) || 0, f);
}

function rememberGoodOccupancy(ownerKey, n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return;
  lastGoodOcc.set(String(ownerKey), { n: v, at: Date.now() });
}

async function occupancyFloor(ownerKey) {
  const uid = String(ownerKey || '');
  const registry = officialList(uid).length;
  let joined = 0;
  try {
    joined = (await inviteStore.listJoinedGroupJids(uid) || []).length;
  } catch (_) {
    joined = 0;
  }
  const last = lastGoodOcc.get(uid);
  const lastN = last && Number(last.n) > 0 ? last.n : 0;
  let mem = 0;
  for (const item of listLiveConns(uid)) {
    mem = Math.max(mem, countGroupsFromConnMemory(item.conn));
  }
  return Math.max(registry, joined, lastN, mem);
}

async function fetchParticipating(conn) {
  if (!conn || typeof conn.groupFetchAllParticipating !== 'function') {
    return { jids: [], ok: false, error: 'no-fn' };
  }
  try {
    const all = await withTimeout(conn.groupFetchAllParticipating(), FETCH_MS, 'groupFetch');
    try { require('../groupMetaCache').seedFromParticipating(all); } catch (_) { /* ignore */ }
    return { jids: participatingJidsFromFetch(all), ok: true, error: null };
  } catch (e) {
    return { jids: [], ok: false, error: String(e.message || e).slice(0, 80) };
  }
}

async function computeOccupancy(ownerKey) {
  const key = String(ownerKey || '');
  const floor = await occupancyFloor(key);
  const liveConns = listLiveConns(key);
  const unique = new Set();
  const bySession = {};
  let fetchedOk = 0;
  for (const item of liveConns) {
    const r = await fetchParticipating(item.conn);
    if (r.ok) {
      fetchedOk += 1;
      bySession[item.sessionId] = r.jids.length;
      for (const j of r.jids) unique.add(j);
    }
  }
  const fetched = unique.size;
  const allOk = liveConns.length > 0 && fetchedOk === liveConns.length;
  const live = allOk ? fetched : null;
  const trusted = allOk && trustLiveCount(fetched, floor);
  if (trusted) rememberGoodOccupancy(key, fetched);
  const have = occupancyHave({ live, trusted, floor });
  const registry = officialList(key).length;
  const data = {
    current: have,
    live,
    registry,
    floor,
    trusted,
    approximate: !trusted,
    sessions: liveConns.length,
    bySession
  };
  occCache.set(key, { at: Date.now(), data });
  return data;
}

/**
 * Ocupacao = grupos em que o bot ESTA (live), nao so a lista de divulgacao.
 * Painel usa cache / peek / registry na hora — NAO dispara groupFetchAllParticipating
 * (isso enfileira IQ e atrasa sendMessage de comando/botao).
 * Join (ttlMs=0) espera o fetch curto.
 */
async function occupancy(ownerKey, { ttlMs = OCC_TTL_MS } = {}) {
  const key = String(ownerKey || '');
  const hit = occCache.get(key);
  if (ttlMs === 0) return computeOccupancy(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const registry = officialList(key).length;
  const data = {
    current: registry,
    live: null,
    registry,
    approximate: true,
    sessions: listLiveConns(key).length,
    bySession: {}
  };
  occCache.set(key, { at: Date.now(), data });
  return data;
}

function bumpOccupancyCache(ownerKey, delta, sessionId) {
  const hit = occCache.get(String(ownerKey || ''));
  if (!hit || !hit.data) return;
  const n = Number(delta) || 0;
  hit.data.current = Math.max(0, (Number(hit.data.current) || 0) + n);
  if (hit.data.live != null) hit.data.live = Math.max(0, hit.data.live + n);
  if (sessionId && hit.data.bySession && hit.data.bySession[sessionId] != null) {
    hit.data.bySession[sessionId] = Math.max(0, hit.data.bySession[sessionId] + n);
  }
}

function kvReady() {
  try {
    return require('../sqlStore').isKvWarmed() !== false;
  } catch (_) {
    return true;
  }
}

/**
 * Auto-repor so entra com flag ON, KV quente e ocupacao LIVE.
 * Clique Entrar passa manual=true.
 */
function autoJoinAllowed({ manual, autoRefillOn, liveCount, kvReady: readyKv, trusted, have, max }) {
  const cap = max != null ? Number(max) : null;
  const n = have != null ? Number(have) : (liveCount != null ? Number(liveCount) : null);
  if (n != null && cap != null && Number.isFinite(n) && Number.isFinite(cap) && n >= cap) {
    return { ok: false, reason: 'at-cap' };
  }
  if (manual) {
    if (trusted === false) return { ok: false, reason: 'occupancy-unknown' };
    return { ok: true };
  }
  if (readyKv === false) return { ok: false, reason: 'kv-cold' };
  if (!autoRefillOn) return { ok: false, reason: 'auto-off' };
  if (trusted === false) return { ok: false, reason: 'occupancy-unknown' };
  if (n == null || !Number.isFinite(n)) return { ok: false, reason: 'occupancy-unknown' };
  return { ok: true };
}

function withOwnerLock(ownerKey, fn) {
  const key = String(ownerKey);
  const prev = ownerLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  ownerLocks.set(key, next.catch(() => {}));
  return next;
}

function listLiveConns(telegramUserId) {
  let activeConnections = null;
  try {
    activeConnections = require('../../telegramBot').activeConnections;
  } catch (_) { /* ignore */ }
  const { getUserSessions } = require('../sessionRegistry');
  const uid = String(telegramUserId || '');
  const out = [];
  const seen = new Set();
  for (const s of getUserSessions(uid) || []) {
    const conn = activeConnections && activeConnections.get(s.sessionId);
    if (conn && conn.user) {
      out.push({ conn, sessionId: s.sessionId });
      seen.add(s.sessionId);
    }
  }
  if (activeConnections) {
    for (const [sessionId, conn] of activeConnections.entries()) {
      if (seen.has(sessionId)) continue;
      if (conn && conn.user && String(conn._telegramUserId || '') === uid) {
        out.push({ conn, sessionId });
      }
    }
  }
  return out;
}

async function sessionGroupCount(ownerKey, sessionId, occ) {
  if (occ && occ.bySession && occ.bySession[sessionId] != null) {
    return occ.bySession[sessionId];
  }
  try {
    return await inviteStore.countJoinedBySession(ownerKey, sessionId);
  } catch (_) {
    return 0;
  }
}

async function pickSession(telegramUserId, preferredSessionId, lim, occ) {
  const live = listLiveConns(telegramUserId);
  if (!live.length) return null;
  const snap = occ || await occupancy(telegramUserId);
  if (preferredSessionId) {
    const hit = live.find((x) => x.sessionId === preferredSessionId);
    if (hit) {
      const n = await sessionGroupCount(telegramUserId, hit.sessionId, snap);
      if (n < lim.maxGroupsPerSession) return hit;
    }
  }
  let best = null;
  let bestN = Infinity;
  for (const item of live) {
    const n = await sessionGroupCount(telegramUserId, item.sessionId, snap);
    if (n >= lim.maxGroupsPerSession) continue;
    if (n < bestN) {
      best = item;
      bestN = n;
    }
  }
  return best;
}

function classifyJoinError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  if (/already|is-participant|already-participant|conflict/.test(m)) return 'already_member';
  if (/gone|no-longer|expired|item-not-found|not-found/.test(m)) return 'expired';
  if (/locked|forbidden|not-authorized|blocked/.test(m)) return 'blocked';
  if (/invalid|not-acceptable|bad-request/.test(m)) return 'invalid';
  if (/rate-overlimit|overlimit|429/.test(m)) return 'rate';
  if (/timeout|connection closed|428|terminated/.test(m)) return 'retry';
  return 'failed';
}

function asGroupJid(raw) {
  try {
    const { normalizeGrupoJid, isCanalDestino } = require('../divDestinos');
    if (isCanalDestino(raw)) return '';
    const n = normalizeGrupoJid(raw);
    if (n) return n;
  } catch (_) { /* fallback abaixo */ }
  const s = String(raw || '').trim();
  if (!s || s.endsWith('@newsletter')) return '';
  if (s.endsWith('@g.us')) return s;
  const digits = s.replace(/[^\d]/g, '');
  if (/^\d{10,24}$/.test(digits) && !s.includes('@')) return `${digits}@g.us`;
  return '';
}

function extractJid(result) {
  if (!result) return '';
  if (typeof result === 'string') return asGroupJid(result);
  if (typeof result !== 'object') return '';
  const attrs = result.attrs && typeof result.attrs === 'object' ? result.attrs : {};
  const direct = asGroupJid(
    result.id || result.gid || result.jid || result.groupJid || attrs.jid || attrs.gid || attrs.id
  );
  if (direct) return direct;
  const kids = Array.isArray(result.content) ? result.content : [];
  for (const child of kids) {
    const j = extractJid(child);
    if (j) return j;
  }
  return '';
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function queryAccept(conn, code) {
  if (typeof conn.query !== 'function') {
    throw new Error('groupAcceptInvite indisponivel');
  }
  return conn.query({
    tag: 'iq',
    attrs: { type: 'set', xmlns: 'w:g2', to: '@g.us' },
    content: [{ tag: 'invite', attrs: { code } }]
  });
}

async function acceptInvite(conn, code) {
  const c = String(code || '').trim();
  const run = () => {
    if (typeof conn.groupAcceptInvite === 'function') return conn.groupAcceptInvite(c);
    return queryAccept(conn, c);
  };
  let last = null;
  for (let i = 0; i < 2; i++) {
    try {
      return await withTimeout(run(), 30000, 'join');
    } catch (e) {
      last = e;
      const kind = classifyJoinError(e);
      if (kind !== 'retry' && kind !== 'rate') throw e;
      if (i === 0) await delay(kind === 'rate' ? 8000 : 2500);
    }
  }
  throw last;
}

async function inviteInfo(conn, code) {
  if (typeof conn.groupGetInviteInfo !== 'function') return null;
  try {
    return await withTimeout(conn.groupGetInviteInfo(code), 12000, 'inviteInfo');
  } catch (_) {
    return null;
  }
}

async function groupNameOf(conn, jid) {
  if (!jid) return '';
  try {
    const { peekGroupMetadata } = require('../groupMetaCache');
    const hit = peekGroupMetadata(jid);
    if (hit && (hit.subject || hit.name)) return String(hit.subject || hit.name).slice(0, 80);
  } catch (_) { /* cache opcional */ }
  return '';
}

async function joinOne(ownerKey, row, session, lim) {
  const code = row.inviteCode;
  logger.logInfo(`[GROUP_JOIN_STARTED] code=${code.slice(0, 8)}… session=${session.sessionId}`);
  await inviteStore.updateInvite(row.id, {
    lastAttemptAt: new Date().toISOString(),
    attemptCount: (row.attemptCount || 0) + 1
  });

  let jid = '';
  let name = '';
  let status = 'joined';
  const infoBefore = await inviteInfo(session.conn, code);
  if (infoBefore) {
    jid = extractJid(infoBefore) || asGroupJid(infoBefore.id);
    name = String(infoBefore.subject || infoBefore.name || '');
  }

  try {
    const result = await acceptInvite(session.conn, code);
    jid = extractJid(result) || jid;
    if (!jid) {
      const info = await inviteInfo(session.conn, code);
      jid = extractJid(info) || asGroupJid(info?.id) || jid;
      name = name || String(info?.subject || info?.name || '');
    }
  } catch (e) {
    const kind = classifyJoinError(e);
    const errTxt = String(e.message || e).slice(0, 120);
    if (kind === 'already_member') {
      const info = infoBefore || await inviteInfo(session.conn, code);
      jid = extractJid(info) || asGroupJid(info?.id) || jid;
      name = name || String(info?.subject || info?.name || '');
      status = 'already_member';
      logger.logInfo(`[GROUP_ALREADY_MEMBER] code=${code.slice(0, 8)}… jid=${maskJid(jid)}`);
    } else {
      const retryable = kind === 'failed' || kind === 'rate' || kind === 'retry';
      const terminal = kind === 'rate' || kind === 'retry' ? 'failed' : kind;
      const nextStatus = (row.attemptCount + 1) >= lim.maxAttemptsPerInvite || !retryable
        ? terminal
        : 'pending';
      await inviteStore.updateInvite(row.id, {
        status: nextStatus === 'pending' ? 'pending' : nextStatus,
        lastError: errTxt
      });
      logger.logAviso(`[GROUP_JOIN_FAILED] code=${code.slice(0, 8)}… ${kind} ${errTxt}`);
      return { ok: false, status: kind, error: errTxt };
    }
  }

  jid = asGroupJid(jid) || asGroupJid(String(jid || '').replace(/:.*@/, '@'));
  if (!jid || !String(jid).endsWith('@g.us')) {
    await inviteStore.updateInvite(row.id, {
      status: 'failed',
      lastError: 'join_sem_jid'
    });
    logger.logAviso(`[GROUP_JOIN_FAILED] code=${code.slice(0, 8)}… sem JID`);
    return { ok: false, status: 'failed', error: 'sem JID' };
  }

  if (!name) name = await groupNameOf(session.conn, jid);

  await inviteStore.updateInvite(row.id, {
    status,
    groupJid: jid,
    groupName: name || null,
    joinSession: session.sessionId,
    joinedAt: new Date().toISOString(),
    lastError: null
  });

  let registered = await registerJoinedGroup({
    jid,
    sessionId: session.sessionId,
    inviteCode: code,
    telegramUserId: ownerKey,
    groupName: name
  });
  if (!registered.ok && registered.reason !== 'excluded') {
    await delay(800);
    registered = await registerJoinedGroup({
      jid,
      sessionId: session.sessionId,
      inviteCode: code,
      telegramUserId: ownerKey,
      groupName: name
    });
  }
  if (registered.reason === 'excluded') {
    logger.logInfo(`[GROUP_JOIN] lista DIV skip excluded jid=${maskJid(jid)}`);
  } else if (!registered.ok || !registered.inList) {
    try {
      const div = require('../divulgacao');
      const { normalizeGrupoJid } = require('../divDestinos');
      div.mergeGruposLista(ownerKey, [jid]);
      const gid = normalizeGrupoJid(jid);
      const listed = !!(gid && (div.getGruposParaDivulgar(ownerKey).grupos || []).includes(gid));
      registered = { ...registered, ok: listed, inList: listed };
    } catch (_) { /* lista opcional */ }
  }
  if (!registered.inList) {
    logger.logAviso(`[GROUP_JOIN_WARN] jid=${maskJid(jid)} entrou no Zap mas lista DIV pendente`);
  }

  logger.logInfo(`[GROUP_JOIN_SUCCESS] jid=${maskJid(jid)} status=${status} listed=${registered.inList ? 1 : 0}`);
  return { ok: true, status, jid, name };
}

async function joinBatch(ownerKey, requested, { preferredSessionId, onProgress, manual } = {}) {
  return withOwnerLock(ownerKey, async () => {
    const lim = limits.loadLimits(ownerKey);
    const st = limits.loadState(ownerKey);
    if (st.paused) {
      logJoinSkip(ownerKey, 'paused', { requested });
      return { ok: false, reason: 'paused', done: 0, requested: 0, real: 0 };
    }
    if (limits.isRateCooling(ownerKey)) {
      const rem = Math.round(limits.rateCooldownRemainingMs(ownerKey) / 1000);
      logJoinSkip(ownerKey, 'rate-cooldown', { rem, requested });
      return { ok: false, reason: 'rate-cooldown', done: 0, requested: 0, real: 0, cooldownSec: rem };
    }
    const live = listLiveConns(ownerKey);
    if (!live.length) {
      logJoinSkip(ownerKey, 'no-session', { requested });
      return { ok: false, reason: 'no-session', done: 0, requested: 0, real: 0 };
    }
    const occ = await occupancy(ownerKey, { ttlMs: 0 });
    const have = Number(occ.current);
    const liveCount = occ.live;
    const gate = autoJoinAllowed({
      manual: !!manual,
      autoRefillOn: limits.isAutoRefillOn(ownerKey),
      liveCount,
      kvReady: kvReady(),
      trusted: occ.trusted === true,
      have,
      max: lim.maxTotalGroups
    });
    if (!gate.ok) {
      logJoinSkip(ownerKey, gate.reason, {
        occ: have,
        max: lim.maxTotalGroups,
        requested
      });
      return {
        ok: false,
        reason: gate.reason,
        done: 0,
        requested: requested === 'max' ? lim.maxBatchSize : Number(requested) || 0,
        real: 0,
        activeGroups: have,
        maxTotal: lim.maxTotalGroups,
        approximate: occ.approximate,
        trusted: occ.trusted
      };
    }
    if (have >= lim.maxTotalGroups) {
      const pendingAtCap = await inviteStore.countByStatus(ownerKey, 'pending');
      logJoinSkip(ownerKey, 'at-cap', {
        occ: have,
        max: lim.maxTotalGroups,
        pending: pendingAtCap,
        joinsToday: st.joinsToday
      });
      return {
        ok: false,
        reason: 'at-cap',
        done: 0,
        requested: requested === 'max' ? lim.maxBatchSize : Number(requested) || 0,
        real: 0,
        pending: pendingAtCap,
        activeGroups: have,
        maxTotal: lim.maxTotalGroups,
        approximate: occ.approximate,
        trusted: occ.trusted
      };
    }
    const session = await pickSession(ownerKey, preferredSessionId, lim, occ);
    if (!session) {
      logJoinSkip(ownerKey, 'no-capacity-session', {
        occ: have,
        max: lim.maxTotalGroups,
        joinsToday: st.joinsToday
      });
      return {
        ok: false,
        reason: 'no-capacity-session',
        done: 0,
        requested: 0,
        real: 0,
        activeGroups: have,
        maxTotal: lim.maxTotalGroups
      };
    }
    const pending = await inviteStore.countByStatus(ownerKey, 'pending');
    const activeGroups = have;
    const sessionGroups = await sessionGroupCount(ownerKey, session.sessionId, occ);
    const want = requested === 'max' ? lim.maxBatchSize : Number(requested);
    const real = limits.computeJoinCount({
      requested: want,
      maxBatchSize: lim.maxBatchSize,
      maxTotalGroups: lim.maxTotalGroups,
      activeGroups,
      maxGroupsPerSession: lim.maxGroupsPerSession,
      sessionGroups,
      maxJoinsPerDay: lim.maxJoinsPerDay,
      joinsToday: st.joinsToday,
      pending: pending || 0
    });
    if (real <= 0) {
      const capDia = Math.max(0, lim.maxJoinsPerDay - (st.joinsToday || 0));
      const why = have >= lim.maxTotalGroups
        ? 'at-cap'
        : (capDia < 1 ? 'day-cap' : 'no-capacity');
      logJoinSkip(ownerKey, why, {
        occ: have,
        max: lim.maxTotalGroups,
        pending,
        joinsToday: st.joinsToday,
        maxJoins: lim.maxJoinsPerDay
      });
      return {
        ok: false,
        reason: activeGroups >= lim.maxTotalGroups ? 'at-cap' : 'no-capacity',
        done: 0,
        requested: want,
        real: 0,
        pending,
        activeGroups,
        maxTotal: lim.maxTotalGroups,
        approximate: occ.approximate
      };
    }

    logger.logInfo(`[GROUP_JOIN_BATCH_STARTED] n=${real} session=${session.sessionId} pending=${pending} have=${have}/${lim.maxTotalGroups} trusted=1`);
    if (onProgress) await onProgress('inicio', `Entrando em ${real} (pula link morto)...`);

    const results = [];
    let occupied = activeGroups;
    let sessionOccupied = sessionGroups;
    let skipped = 0;
    let tries = 0;
    const maxTries = Math.min(Math.max(pending, real), Math.max(real * 8, real + 25));
    while (results.filter((r) => r.ok && (r.status === 'joined' || r.status === 'already_member')).length < real && tries < maxTries) {
      if (!manual && !limits.isAutoRefillOn(ownerKey)) {
        logJoinSkip(ownerKey, 'auto-off-midbatch', { occ: occupied, max: lim.maxTotalGroups });
        break;
      }
      if (occupied >= lim.maxTotalGroups || sessionOccupied >= lim.maxGroupsPerSession) break;
      const pausedNow = limits.loadState(ownerKey).paused;
      if (pausedNow) break;
      const claimed = await inviteStore.claimPending(ownerKey, 1);
      if (!claimed.length) break;
      if (tries > 0) await delay(lim.joinDelayMs);
      tries += 1;
      const got = results.filter((r) => r.ok && (r.status === 'joined' || r.status === 'already_member')).length;
      if (onProgress) await onProgress(got + 1, `Grupo ${got + 1}/${real} (tentativa ${tries})`);
      const one = await joinOne(ownerKey, claimed[0], session, lim);
      results.push(one);
      if (one.ok && (one.status === 'joined' || one.status === 'already_member')) {
        occupied += 1;
        sessionOccupied += 1;
        bumpOccupancyCache(ownerKey, 1, session.sessionId);
        rememberGoodOccupancy(ownerKey, occupied);
      } else {
        skipped += 1;
        logger.logInfo(`[GROUP_JOIN_SKIP] status=${one.status || 'fail'} next_invite`);
        if (/connection closed|terminated|428/i.test(String(one.error || one.status || ''))) {
          logger.logAviso('[GROUP_JOIN_BATCH] socket morto — para o lote (nao queima a fila)');
          break;
        }
        // rate-overlimit: para o lote e esfria 10min (senão menu/cmds somem)
        if (one.status === 'rate' || /rate-overlimit|overlimit/i.test(String(one.error || ''))) {
          try {
            limits.setRateCooldown(ownerKey, 30 * 60 * 1000);
          } catch (_) { /* ignore */ }
          try {
            require('../waCircuitBreaker').trip(25_000, {
              fanoutJoinCooldown: false,
              log: true
            });
          } catch (_) { /* ignore */ }
          logger.logAviso('[GROUP_JOIN_BATCH] rate-overlimit — cooldown 30min (protege envio de cmds)');
          break;
        }
      }
    }

    const newlyJoined = results.filter((r) => r.ok && r.status === 'joined').length;
    const seatedN = results.filter((r) => r.ok && (r.status === 'joined' || r.status === 'already_member')).length;
    if (newlyJoined) limits.bumpJoins(ownerKey, newlyJoined);
    let recovered = 0;
    try {
      recovered = await require('./queue').recoverMissingRegistry(ownerKey);
    } catch (_) { /* heal opcional */ }
    const divN = officialList(ownerKey).length;
    const registryFailed = results.filter((r) => r.registryFailed).length;
    logger.logInfo(
      `[GROUP_JOIN_BATCH_FINISHED] ok=${newlyJoined}/${real} seated=${seatedN} tried=${tries} skipped=${skipped} occ=${occupied}/${lim.maxTotalGroups} div=${divN} recovered=${recovered || 0}`
    );
    return {
      ok: true,
      done: newlyJoined,
      requested: want,
      real,
      skipped,
      tried: tries,
      results,
      sessionId: session.sessionId,
      activeGroups: occupied,
      maxTotal: lim.maxTotalGroups,
      approximate: occ.approximate,
      divList: divN,
      registryFailed,
      recovered: recovered || 0
    };
  });
}

const refillTimers = new Map();
const emptyQueueLogAt = new Map();
const EMPTY_QUEUE_LOG_MS = 5 * 60 * 1000;
const REFILL_COALESCE_MS = 400;
const joinSkipLogAt = new Map();
const JOIN_SKIP_LOG_MS = 3 * 60 * 1000;

function logJoinSkip(uid, reason, extra = {}) {
  const key = `${uid}:${reason}`;
  const now = Date.now();
  if (now - (joinSkipLogAt.get(key) || 0) < JOIN_SKIP_LOG_MS) return;
  joinSkipLogAt.set(key, now);
  const bits = [`reason=${reason}`];
  if (extra.occ != null) bits.push(`occ=${extra.occ}/${extra.max || '?'}`);
  if (extra.pending != null) bits.push(`pending=${extra.pending}`);
  if (extra.joinsToday != null) bits.push(`dia=${extra.joinsToday}/${extra.maxJoins || '?'}`);
  if (extra.requested != null) bits.push(`want=${extra.requested}`);
  logger.logAviso(`[GROUP_JOIN_BATCH_SKIP] uid=${String(uid).slice(0, 8)} ${bits.join(' ')}`);
}

function logEmptyQueue(uid, have, max, force) {
  const now = Date.now();
  if (!force && now - (emptyQueueLogAt.get(uid) || 0) < EMPTY_QUEUE_LOG_MS) return;
  emptyQueueLogAt.set(uid, now);
  logger.logAviso(`[META] fila vazia, ocupacao ${have}/${max}, aguardando novos convites`);
}

/**
 * Completa a meta sozinho. Trava: autoRefill, pausa, teto, sessao, dia, fila, delay.
 * fromRetire: dispara na saida (nao espera clique nem o job de 60s).
 */
function pickTrimTargets(liveJids, official, maxTotal) {
  const live = [...new Set((liveJids || []).map(String).filter((j) => j.endsWith('@g.us')))];
  const listed = [...new Set((official || []).map(String).filter((j) => j.endsWith('@g.us')))];
  const liveSet = new Set(live);
  const listedSet = new Set(listed);
  const prune = listed.filter((j) => !liveSet.has(j));
  const adopt = live.filter((j) => !listedSet.has(j));
  const extra = Math.max(0, live.length - Math.max(0, Number(maxTotal) || 0));
  // Teto so impede JOIN. Nunca auto-sair — grupo manual (ghost) ia embora primeiro.
  return { leave: [], prune, adopt, extra };
}

async function adoptLiveGhosts(ownerKey, liveJids) {
  const uid = String(ownerKey || '');
  const listed = new Set(officialList(uid));
  let n = 0;
  for (const jid of liveJids || []) {
    if (!String(jid).endsWith('@g.us') || listed.has(jid)) continue;
    try {
      const r = await registerJoinedGroup({
        jid,
        sessionId: '',
        inviteCode: null,
        telegramUserId: uid,
        groupName: ''
      });
      if (r && (r.ok || r.inList)) {
        n += 1;
        listed.add(jid);
      }
    } catch (_) { /* lista opcional */ }
  }
  if (n) {
    logger.logInfo(`[META] adotou ${n} grupo(s) live na lista DIV (uid=${uid.slice(0, 8)})`);
    invalidateOccupancyCache(uid);
  }
  return n;
}

async function collectLiveGroupJids(ownerKey) {
  const live = listLiveConns(ownerKey);
  const bySession = {};
  const all = new Set();
  let fetchedOk = 0;
  for (const item of live) {
    const r = await fetchParticipating(item.conn);
    if (!r.ok) {
      bySession[item.sessionId] = [];
      continue;
    }
    bySession[item.sessionId] = r.jids;
    for (const j of r.jids) all.add(j);
    fetchedOk += 1;
  }
  return { jids: [...all], bySession, sessions: live.length, fetchedOk };
}

async function pruneOfficialVsLive(ownerKey, liveJids) {
  const liveSet = new Set(liveJids || []);
  const listed = officialList(ownerKey);
  let n = 0;
  const { removerGrupo } = require('../divulgacao');
  for (const gid of listed) {
    if (!liveSet.has(gid)) {
      try {
        removerGrupo(ownerKey, gid);
        n += 1;
      } catch (_) { /* ignore */ }
    }
  }
  if (n) {
    logger.logAviso(`[META] lista DIV: removeu ${n} jid(s) que o bot nao esta (uid=${String(ownerKey).slice(0, 8)})`);
    invalidateOccupancyCache(ownerKey);
  }
  return n;
}

async function enforceOccupancyCap(ownerKey) {
  const uid = String(ownerKey || '');
  if (!uid) return { ok: false, reason: 'no-uid' };
  const lim = limits.loadLimits(uid);
  const floor = await occupancyFloor(uid);
  const snap = await collectLiveGroupJids(uid);
  const allOk = snap.sessions > 0 && snap.fetchedOk === snap.sessions;
  const fetchedN = snap.jids.length;
  const trusted = allOk && trustLiveCount(fetchedN, floor);
  const have = occupancyHave({ live: allOk ? fetchedN : null, trusted, floor });
  if (!trusted) {
    logger.logAviso(
      `[META] occ raso uid=${uid.slice(0, 8)} live=${allOk ? fetchedN : 'fail'} floor=${floor} have=${have} max=${lim.maxTotalGroups} — nao entra nem poda`
    );
    return {
      ok: false,
      reason: 'incomplete-live-fetch',
      have,
      max: lim.maxTotalGroups,
      trusted: false,
      floor,
      left: 0,
      pruned: 0
    };
  }
  rememberGoodOccupancy(uid, fetchedN);
  const adopted = await adoptLiveGhosts(uid, snap.jids);
  if (adopted) rememberGoodOccupancy(uid, fetchedN);
  logger.logInfo(`[META] teto uid=${uid.slice(0, 8)} have=${fetchedN} max=${lim.maxTotalGroups} adopted=${adopted} (sem auto-sair)`);
  return {
    ok: true,
    have: fetchedN,
    max: lim.maxTotalGroups,
    left: 0,
    pruned: 0,
    adopted,
    trusted: true,
    floor
  };
}

async function maintainOccupancy(ownerKey, opts = {}) {
  const uid = String(ownerKey || '');
  if (!uid) return { ok: false, reason: 'no-uid' };
  const lim = limits.loadLimits(uid);
  if (!limits.isAutoRefillOn(uid)) {
    logJoinSkip(uid, 'auto-off', { max: lim.maxTotalGroups });
    return { ok: false, reason: 'auto-off' };
  }
  if (opts.fromRetire) invalidateOccupancyCache(uid);
  const cap = await enforceOccupancyCap(uid);
  const have = Number(cap && cap.have) || 0;
  const trusted = !!(cap && cap.trusted);
  if (!kvReady()) {
    logJoinSkip(uid, 'kv-cold', { max: lim.maxTotalGroups });
    return { ok: false, reason: 'kv-cold', cap };
  }
  const st = limits.loadState(uid);
  if (st.paused) return { ok: false, reason: 'paused', cap };
  if (limits.isRateCooling(uid)) {
    const rem = Math.round(limits.rateCooldownRemainingMs(uid) / 1000);
    logJoinSkip(uid, 'rate-cooldown', { rem, max: lim.maxTotalGroups });
    return { ok: false, reason: 'rate-cooldown', cap, cooldownSec: rem };
  }

  if (!trusted) {
    logJoinSkip(uid, 'occupancy-unknown', { occ: have, max: lim.maxTotalGroups });
    return { ok: false, reason: 'occupancy-unknown', cap, have, max: lim.maxTotalGroups };
  }
  if (have >= lim.maxTotalGroups) {
    return { ok: true, reason: 'full', have, max: lim.maxTotalGroups };
  }

  let pending = 0;
  try {
    pending = await inviteStore.countByStatus(uid, 'pending');
  } catch (_) {
    pending = 0;
  }

  const need = Math.max(0, lim.maxTotalGroups - have);
  if (need < 1) {
    return { ok: true, reason: 'full', have, max: lim.maxTotalGroups, pending };
  }

  if (pending < 1) {
    logEmptyQueue(uid, have, lim.maxTotalGroups, !!opts.fromRetire);
    return { ok: false, reason: 'empty-queue', have, max: lim.maxTotalGroups, pending: 0 };
  }

  const want = opts.requested != null ? opts.requested : (opts.fromRetire ? 'max' : need);
  logger.logInfo(`[GM] repor uid=${uid} have=${have} max=${lim.maxTotalGroups} need=${need} want=${want} auto=on trusted=1`);
  return joinBatch(uid, want, { manual: false });
}

function scheduleOccupancyRefill(ownerKey) {
  const uid = String(ownerKey || '');
  if (!uid) return;
  const prev = refillTimers.get(uid);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    refillTimers.delete(uid);
    maintainOccupancy(uid, { fromRetire: true }).catch((e) => {
      logger.logAviso(`[META] repor: ${e.message}`);
    });
  }, REFILL_COALESCE_MS);
  if (typeof t.unref === 'function') t.unref();
  refillTimers.set(uid, t);
}

module.exports = {
  joinBatch,
  listLiveConns,
  pickSession,
  occupancy,
  invalidateOccupancyCache,
  bumpOccupancyCache,
  withOwnerLock,
  classifyJoinError,
  acceptInvite,
  inviteInfo,
  extractJid,
  asGroupJid,
  computeJoinCount: limits.computeJoinCount,
  autoJoinAllowed,
  participatingJidsFromFetch,
  trustLiveCount,
  occupancyHave,
  maintainOccupancy,
  scheduleOccupancyRefill,
  pickTrimTargets,
  enforceOccupancyCap
};
