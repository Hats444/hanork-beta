'use strict';
/**
 * Camada rapida: peek cache → autoridade → decide → revert 1-2 pessoas.
 * Nao espera groupMetadata IQ. Nao entra em loop promote/demote.
 */

const logger = require('../logger');
const logic = require('./groupTheftLogic');
const store = require('./groupTheftStore');

const metrics = {
  n: 0,
  decideMs: 0,
  revertMs: 0,
  totalMs: 0,
  ignored: 0,
  applied: 0,
  dupes: 0
};

const locks = new Map();
const selfOps = new Map();
const seen = new Map();
const bursts = new Map();

const LOCK_TIMEOUT_MS = Number(process.env.HANORK_ANTIADMIN_LOCK_MS || 8000);

function gsDebug(fields) {
  const on = process.env.GROUP_SECURITY_DEBUG === '1' || process.env.GROUP_SECURITY_DEBUG === 'true';
  if (!on) return;
  const parts = Object.entries(fields || {}).map(([k, v]) => `${k}=${v == null ? '-' : String(v)}`);
  logger.logInfo(`[GROUP-SECURITY] ${parts.join(' ')}`);
}

function gsError(fields, err) {
  const em = err && err.message ? err.message : String(err || 'unknown');
  logger.logErro('GROUP-SECURITY ERROR', `${fields && fields.action ? fields.action : '?'} ${em}`);
  gsDebug({ ...(fields || {}), error: em });
  if (process.env.GROUP_SECURITY_DEBUG === '1' || process.env.GROUP_SECURITY_DEBUG === 'true') {
    if (err && err.stack) logger.logErro('GROUP-SECURITY ERROR', String(err.stack).slice(0, 800));
  }
}

function isLiveConn(conn) {
  if (!conn || !conn._sessionId) return true;
  try {
    const { isLiveConnection } = require('../connection');
    return isLiveConnection(conn);
  } catch (_) {
    return true;
  }
}

function rememberPair(lid, pn) {
  if (!lid || !pn) return;
  try {
    require('../utils').rememberLidPhonePair(lid, pn);
  } catch (_) { /* cache opcional */ }
}

function jidUserPart(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function preferPhoneJid(jid) {
  const s = String(jid || '').replace(/:\d+(?=@)/, '');
  if (!s) return '';
  if (s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us')) return s;
  if (s.endsWith('@lid')) {
    try {
      const { getPhoneForLid } = require('../utils');
      const pn = getPhoneForLid(s);
      const d = String(pn || '').replace(/\D/g, '');
      if (d.length >= 10 && d.length <= 15) return `${d}@s.whatsapp.net`;
    } catch (_) { /* mapping opcional */ }
  }
  return s;
}

function mappedPhoneJid(jid) {
  const preferred = preferPhoneJid(jid);
  if (preferred.endsWith('@s.whatsapp.net') || preferred.endsWith('@c.us')) return preferred;
  return '';
}

function mentionTag(jid) {
  const id = preferPhoneJid(jid) || String(jid || '');
  const user = jidUserPart(id);
  if (!user) return { tag: '-', jid: '' };
  return { tag: `@${user}`, jid: id };
}

function idsMatch(a, b) {
  if (!a || !b) return false;
  try {
    const { identitiesEqualStrict } = require('./moderation');
    if (identitiesEqualStrict(a, b)) return true;
    const pa = mappedPhoneJid(a);
    const pb = mappedPhoneJid(b);
    if (pa && pb && identitiesEqualStrict(pa, pb)) return true;
    const { getLidForPhone } = require('../utils');
    if (pa && String(b).endsWith('@lid')) {
      const lid = getLidForPhone(pa);
      if (lid && identitiesEqualStrict(lid, b)) return true;
    }
    if (pb && String(a).endsWith('@lid')) {
      const lid = getLidForPhone(pb);
      if (lid && identitiesEqualStrict(lid, a)) return true;
    }
  } catch (_) {
    return logic.sameId(a, b);
  }
  return false;
}

function pruneMap(map, now) {
  if (map.size < 200) return;
  for (const [k, v] of map) {
    const exp = typeof v === 'number' ? v : v && v.until;
    if (exp && exp < now) map.delete(k);
  }
}

function rememberSelfOp(gid, action, jids) {
  const until = Date.now() + logic.SELF_OP_TTL_MS;
  for (const j of jids || []) {
    selfOps.set(`${gid}|${action}|${j}`, until);
  }
}

function isSelfOp(gid, action, jid) {
  const until = selfOps.get(`${gid}|${action}|${jid}`);
  return !!(until && until > Date.now());
}

function isDupe(key) {
  const now = Date.now();
  pruneMap(seen, now);
  const until = seen.get(key);
  if (until && until > now) return true;
  seen.set(key, now + logic.DEDUPE_TTL_MS);
  return false;
}

function noteBurst(gid, actor, windowMs) {
  const now = Date.now();
  const k = `${gid}|${actor || '?'}`;
  let arr = bursts.get(k);
  if (!arr) arr = [];
  arr.push(now);
  const win = Number(windowMs) || logic.DEFAULT_WINDOW_MS;
  arr = arr.filter((t) => now - t <= win);
  bursts.set(k, arr);
  return arr.length;
}

function withLock(gid, fn) {
  const prev = locks.get(gid) || Promise.resolve();
  const run = async () => {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('security_lock_timeout')), LOCK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([Promise.resolve().then(fn), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const next = prev.then(run, run);
  locks.set(gid, next.catch((e) => {
    gsError({ action: 'lock', group: gid }, e);
  }));
  return next;
}

function canonicalAgainst(aliases, rec) {
  const list = (aliases || []).filter(Boolean);
  if (!list.length) return '';
  if (list.some((t) => idsMatch(t, rec.registered_owner_jid))) return rec.registered_owner_jid;
  if (list.some((t) => idsMatch(t, rec.native_owner_jid))) return rec.native_owner_jid;
  for (const t of rec.trusted || []) {
    if (t && list.some((a) => idsMatch(a, t.jid))) return t.jid;
  }
  return list[0];
}

function orderGpuJids(meta, pn, lid) {
  const mode = String((meta && meta.addressingMode) || '').toLowerCase();
  if (mode === 'lid') return [...new Set([lid, pn].filter(Boolean))];
  return [...new Set([pn, lid].filter(Boolean))];
}

/** Zero/Baileys pode devolver {status} sem throw. So 200/201 conta. */
function gpuIqOk(res) {
  if (res == null) return true;
  const items = Array.isArray(res) ? res : [res];
  const statuses = items
    .map((it) => (it && typeof it === 'object' ? Number(it.status) : Number(it)))
    .filter((st) => Number.isFinite(st));
  if (!statuses.length) return true;
  return statuses.every((st) => st === 200 || st === 201);
}

function flagsFromGroup(flags, rec) {
  const f = flags || {};
  const destRaw = String((rec && rec.alert_dest) || 'silent');
  const silent = destRaw === 'silent' || !!f.antiadminSilent;
  const dest = silent ? 'silent' : destRaw;
  const recDetectOn = rec ? Number(rec.attack_detect) !== 0 : f.antiadminDetect !== false;
  const th = Number(rec && rec.threshold);
  const win = Number(rec && rec.window_ms);
  // Fonte da verdade: flag do painel. SQL vazio/legado com protection=1 nao liga sozinho.
  const protection = !!f.antiadmin;
  const recRevertOff = rec && Number(rec.revert_enabled) === 0;
  const flagRevertOff = f.antiadminRevert === false;
  const flagRevertOn = f.antiadminRevert === true;
  let revert = true;
  if (flagRevertOff || (recRevertOff && !flagRevertOn)) revert = false;
  if (protection && String(process.env.HANORK_ANTIROUBO_AUTO_REVERT || '1') !== '0') {
    if (!flagRevertOff && !recRevertOff) revert = true;
  }
  return {
    protection,
    audit: !!f.antiadminAudit,
    revert,
    alert: silent ? false : f.antiadminAlert === true,
    silent,
    detect: f.antiadminDetect === false ? false : recDetectOn,
    dest,
    threshold: th > 0 ? th : logic.DEFAULT_THRESHOLD,
    windowMs: win > 0 ? win : logic.DEFAULT_WINDOW_MS
  };
}

function maskJid(jid) {
  const s = String(jid || '');
  if (!s) return '-';
  const [user, host] = s.split('@');
  const tail = (user || '').slice(-4);
  return `***${tail}@${host || '?'}`;
}

function isBotId(conn, jid) {
  try {
    const { isSessionSelfIdentity } = require('./moderation');
    return isSessionSelfIdentity(conn, jid);
  } catch (_) {
    return false;
  }
}

function isBotOwnerId(conn, telegramUserId, jid) {
  if (!jid) return false;
  try {
    const { isBotSessionOwner } = require('./authorization');
    if (isBotSessionOwner(telegramUserId, jid, [], conn)) return true;
  } catch (_) { /* ignore */ }
  try {
    const { getEffectiveOwners } = require('./configManager');
    const owners = getEffectiveOwners(telegramUserId) || [];
    if (owners.some((o) => idsMatch(o, jid))) return true;
  } catch (_) { /* ignore */ }
  return false;
}

function mentionSafe(jid) {
  const m = mentionTag(jid);
  return { text: m.tag, jid: m.jid };
}

async function gpu(conn, gid, jids, action) {
  const list = [...new Set((jids || []).filter(Boolean))];
  if (!list.length) return;
  rememberSelfOp(gid, action, list);
  const prev = !!conn._hanorkBanallSweep;
  conn._hanorkBanallSweep = true;
  let lastErr = null;
  try {
    for (let i = 0; i < list.length; i++) {
      try {
        const res = await conn.groupParticipantsUpdate(gid, [list[i]], action);
        if (!gpuIqOk(res)) {
          lastErr = new Error('gpu status nao-2xx');
          gsDebug({
            action: 'gpu_status',
            group: maskJid(gid),
            op: action,
            try: maskJid(list[i])
          });
          continue;
        }
        lastErr = null;
        logger.logInfo(`[antiadmin] gpu ok op=${action} gid=${maskJid(gid)}`);
        try { require('./opsMetrics').bump('antirouboGpuOk'); } catch (_) { /* ignore */ }
        return;
      } catch (e) {
        lastErr = e;
        gsDebug({
          action: 'gpu_retry',
          group: maskJid(gid),
          op: action,
          try: maskJid(list[i]),
          err: e && e.message ? e.message : e
        });
      }
    }
    if (lastErr) {
      logger.logAviso(
        `[antiadmin] gpu fail op=${action} gid=${maskJid(gid)} err=${lastErr && lastErr.message ? lastErr.message : lastErr}`
      );
      try { require('./opsMetrics').bump('antirouboGpuFail'); } catch (_) { /* ignore */ }
      throw lastErr;
    }
    logger.logInfo(`[antiadmin] gpu ok op=${action} gid=${maskJid(gid)}`);
  } finally {
    conn._hanorkBanallSweep = prev;
  }
}

function sessionOwnerJids(telegramUserId) {
  try {
    const { getOwners } = require('./configManager');
    return (getOwners(telegramUserId) || []).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function botIsAdminHere(conn, gid) {
  const meta = peekMeta(gid);
  if (!meta || !conn?.user) return false;
  try {
    return require('./protectionStore').botIsGroupAdmin(meta, conn);
  } catch (_) {
    const ids = [conn.user.id, conn.user.lid, conn.user.jid].filter(Boolean);
    return (meta.participants || []).some((p) => {
      const adm = p.admin === 'admin' || p.admin === 'superadmin' || p.admin === true;
      if (!adm) return false;
      const pids = [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean);
      return ids.some((id) => pids.some((pid) => idsMatch(id, pid)));
    });
  }
}

async function sendAlert(conn, gid, rec, flags, body, mentions, telegramUserId) {
  if (!flags.alert || flags.silent) return;
  const dest = String(flags.dest || (rec && rec.alert_dest) || 'silent');
  if (dest === 'silent') return;
  const opts = { skipForward: true, _hanorkTrusted: true };
  const payload = { text: body, mentions: (mentions || []).filter(Boolean) };
  const sent = new Set();
  const sendTo = async (jid) => {
    const id = String(jid || '');
    if (!id || sent.has(id)) return;
    sent.add(id);
    try {
      await conn.sendMessage(id, payload, opts);
    } catch (e) {
      if (id.endsWith('@g.us')) logger.logAviso(`[antiadmin] alerta grupo: ${e.message}`);
    }
  };
  const wantGroup = dest === 'group' || dest === 'both';
  if (wantGroup && botIsAdminHere(conn, gid)) await sendTo(gid);
  if (dest === 'dm' || dest === 'both' || (wantGroup && sent.size === 0)) {
    if (rec && rec.registered_owner_jid) await sendTo(rec.registered_owner_jid);
    else {
      for (const o of sessionOwnerJids(telegramUserId)) await sendTo(o);
    }
  }
  if (dest === 'owner') {
    for (const o of sessionOwnerJids(telegramUserId)) await sendTo(o);
    if (sent.size === 0 && rec && rec.registered_owner_jid) await sendTo(rec.registered_owner_jid);
  }
}

function peekMeta(gid) {
  try {
    const { peekGroupMetadata } = require('./groupMetaCache');
    return peekGroupMetadata(gid);
  } catch (_) {
    return null;
  }
}

async function processParticipantsUpdate(conn, update, telegramUserId, snapshot) {
  const t0 = Date.now();
  const gid = String((update && update.id) || '');
  if (!gid.endsWith('@g.us')) return null;
  if (!isLiveConn(conn)) {
    gsDebug({ event: 'group-participants.update', group: maskJid(gid), skipped: 'stale_socket' });
    return { skipped: 'stale_socket' };
  }
  return withLock(gid, async () => {
    const tLock = Date.now();
    const action = String((update && update.action) || '');
    gsDebug({
      event: 'group-participants.update',
      group: maskJid(gid),
      action,
      author: maskJid(update && update.author),
      authorPn: maskJid(update && update.authorPn),
      n: Array.isArray(update && update.participants) ? update.participants.length : 0
    });
    if (!action) {
      metrics.n += 1;
      metrics.totalMs += Date.now() - t0;
      return { skipped: 'empty_action' };
    }

    const records = logic.participantRecords(update);
    const targets = records.map((r) => r.id);
    const pair = logic.pickActorPair(update);
    rememberPair(pair.actorLid, pair.actorPn || pair.actor);
    for (const r of records) rememberPair(r.lid, r.pn || r.id);
    const actor = pair.actor;
    const actorAliases = [pair.actor, pair.actorPn, pair.actorLid].filter(Boolean);

    if (actor && targets.some((t) => idsMatch(t, actor) && action === 'leave')) {
      return { skipped: 'self_leave' };
    }

    if (!targets.length) {
      gsDebug({ group: maskJid(gid), action, skipped: 'no_targets' });
      logger.logAviso(`[GROUP-SECURITY] evento sem alvo parseavel action=${action} gid=${maskJid(gid)}`);
      metrics.n += 1;
      metrics.totalMs += Date.now() - t0;
      return { skipped: 'no_targets' };
    }

    const flagsMod = (() => {
      try {
        const { getGroupSecurity } = require('./moderation');
        return getGroupSecurity(gid, telegramUserId);
      } catch (_) {
        return {};
      }
    })();

    const rec = await store.load(gid, telegramUserId);
    const flags = flagsFromGroup(flagsMod, rec);
    gsDebug({
      group: maskJid(gid),
      protection: flags.protection,
      audit: flags.audit,
      revert: flags.revert,
      dest: flags.dest
    });
    if (!flags.protection && !flags.audit) {
      metrics.n += 1;
      metrics.totalMs += Date.now() - t0;
      return { skipped: 'off' };
    }

    const metaNow = peekMeta(gid) || snapshot || null;
    if (!rec.native_owner_jid) {
      const native = logic.nativeOwnerFromMeta(snapshot || metaNow);
      if (native) {
        rec.native_owner_jid = native;
        store.upsert(gid, telegramUserId, { native_owner_jid: native }).catch((e) => {
          gsError({ action: 'native_upsert', group: maskJid(gid) }, e);
        });
      }
    }

    const corr = store.newId();
    const results = [];

    for (const recT of records) {
      const target = recT.id;
      const targetAliases = [recT.id, recT.pn, recT.lid].filter(Boolean);
      if (targetAliases.some((t) => isSelfOp(gid, action, t))) {
        metrics.ignored += 1;
        results.push({ target, policy: 'IGNORE', reason: 'self_op' });
        continue;
      }
      const dkey = logic.eventDedupeKey({ groupJid: gid, action, actor, targets: [target] });
      if (isDupe(dkey)) {
        metrics.dupes += 1;
        results.push({ target, policy: 'IGNORE', reason: 'dupe' });
        continue;
      }

      const targetIsBot = targetAliases.some((t) => isBotId(conn, t));
      const actorIsBot = actorAliases.some((t) => isBotId(conn, t));
      let targetWasAdmin = logic.wasAdminInSnapshot(snapshot, target, targetAliases);
      if (!targetWasAdmin && action === 'demote' && flags.protection && !snapshot) {
        targetWasAdmin = true;
      }

      const actorForRole = canonicalAgainst(actorAliases, rec) || actor;
      const targetForRole = canonicalAgainst(targetAliases, rec) || target;
      const actorRole = logic.resolveActorRole({
        actor: actorForRole,
        actorAliases,
        actorIsBot,
        actorIsBotOwner: actorAliases.some((t) => isBotOwnerId(conn, telegramUserId, t)),
        registeredOwner: rec.registered_owner_jid,
        nativeOwner: rec.native_owner_jid || logic.nativeOwnerFromMeta(snapshot),
        trusted: rec.trusted,
        actorIsWaAdmin:
          logic.wasAdminInSnapshot(snapshot, actor, actorAliases) ||
          logic.isAdminNow(metaNow, actor)
      });
      const targetRole = logic.resolveTargetRole({
        target: targetForRole,
        targetAliases,
        targetIsBot,
        targetIsBotOwner: targetAliases.some((t) => isBotOwnerId(conn, telegramUserId, t)),
        registeredOwner: rec.registered_owner_jid,
        nativeOwner: rec.native_owner_jid,
        trusted: rec.trusted,
        targetWasAdmin
      });

      const burstCount = noteBurst(gid, actor, flags.windowMs);
      const tDec = Date.now();
      const decision = logic.decide({
        action,
        actor,
        actorRole,
        targetRole,
        targetWasAdmin,
        targetIsBot,
        flags,
        burstCount,
        mass: action === 'remove' && burstCount >= flags.threshold
      });
      metrics.decideMs += Date.now() - tDec;

      logger.logInfo(
        `[antiadmin] gid=${maskJid(gid)} act=${action} actor=${maskJid(actor)} ` +
        `role=${actorRole} tgt=${maskJid(target)} tRole=${targetRole} ` +
        `pol=${decision.policy} risk=${decision.risk} class=${decision.class} ` +
        `revert=${decision.revert ? 1 : 0} corr=${corr}`
      );
      if (decision.policy === 'APPLY') {
        try { require('./opsMetrics').bump('antirouboApply'); } catch (_) { /* ignore */ }
      }
      gsDebug({
        group: maskJid(gid),
        actor: maskJid(actor),
        target: maskJid(target),
        action,
        authority: actorRole,
        authorized: logic.isTrustedAuthority(actorRole),
        risk: decision.class,
        decision: decision.policy,
        reason: decision.reason,
        corr
      });

      let reverted = false;
      let actionResult = 'none';
      if (decision.policy === 'APPLY' && decision.revert) {
        const tRev = Date.now();
        try {
          const live = peekMeta(gid) || metaNow;
          if (decision.restoreTarget) {
            const already = logic.wasAdminInSnapshot(live, target, targetAliases);
            if (!already) {
              await gpu(conn, gid, orderGpuJids(live, recT.pn || recT.id, recT.lid), 'promote');
              actionResult = 'promote_target';
            } else {
              actionResult = 'target_already_admin';
            }
          }
          const actorIsOwner = actorAliases.some((t) => isBotOwnerId(conn, telegramUserId, t)) ||
            actorAliases.some((t) => isBotId(conn, t));
          if (decision.demoteActor && actor && !actorIsOwner) {
            const liveNow = peekMeta(gid) || live;
            const known = !!(liveNow && Array.isArray(liveNow.participants) && liveNow.participants.length);
            const stillAdmin = !known || logic.wasAdminInSnapshot(liveNow, actor, actorAliases);
            if (stillAdmin) {
              await gpu(conn, gid, orderGpuJids(liveNow || live, pair.actorPn || pair.actor, pair.actorLid), 'demote');
              actionResult = actionResult === 'none' ? 'demote_actor' : `${actionResult}+demote_actor`;
            }
          }
          reverted = actionResult !== 'none' && actionResult !== 'target_already_admin'
            ? true
            : (decision.restoreTarget ? actionResult === 'target_already_admin' : false);
          if (decision.restoreTarget || decision.demoteActor) {
            reverted = true;
            metrics.applied += 1;
          }
        } catch (e) {
          gsError({ action: 'revert', group: maskJid(gid), actor: maskJid(actor), target: maskJid(target) }, e);
          actionResult = 'error';
        }
        metrics.revertMs += Date.now() - tRev;
      } else if (decision.skipRejoin) {
        actionResult = 'not_recoverable';
      }
      gsDebug({ corr, action_exec: actionResult, reverted, latency_ms: Date.now() - t0 });

      store.insertEvent({
        telegramUserId,
        group_jid: gid,
        actor_jid: actor,
        target_jid: target,
        action,
        actor_role: actorRole,
        target_role: targetRole,
        detected: decision.policy !== 'ALLOW' || !!flags.audit,
        reverted,
        reason: decision.reason,
        risk: decision.risk,
        risk_class: decision.class
      }).catch((e) => {
        gsError({ action: 'insert_event', group: maskJid(gid) }, e);
      });

      if (decision.alert) {
        const groupName = String((snapshot && snapshot.subject) || (metaNow && metaNow.subject) || 'grupo');
        const actorM = mentionTag(actor);
        const targetM = mentionTag(target);
        const mentions = [actorM.jid, targetM.jid].filter(Boolean);
        const lines = [
          `Anti-roubo: ${String(action)}`,
          `${actorM.tag} → ${targetM.tag}`,
          decision.restoreTarget ? 'Alvo restaurado.' : '',
          decision.demoteActor ? 'Autor rebaixado.' : ''
        ].filter(Boolean);
        sendAlert(conn, gid, rec, flags, lines.join('\n'), mentions, telegramUserId).catch((e) => {
          gsError({ action: 'alert', group: maskJid(gid) }, e);
        });
      }

      results.push({ target, ...decision, reverted, corr });
    }

    metrics.n += 1;
    metrics.totalMs += Date.now() - t0;
    metrics.lockWait = (metrics.lockWait || 0) + (tLock - t0);
    return { corr, results, ms: Date.now() - t0 };
  });
}

async function processGroupsUpdate(conn, updates, telegramUserId) {
  for (const u of updates || []) {
    const gid = u && u.id;
    if (!gid || !String(gid).endsWith('@g.us')) continue;
    let flagsMod = {};
    try {
      const { getGroupSecurity } = require('./moderation');
      flagsMod = getGroupSecurity(gid, telegramUserId);
    } catch (_) { /* ignore */ }
    const rec = await store.load(gid, telegramUserId);
    const flags = flagsFromGroup(flagsMod, rec);
    if (flagsMod.x9config) {
      try {
        await notifyX9Config(conn, gid, u);
      } catch (e) {
        gsError({ action: 'x9config', group: maskJid(gid) }, e);
      }
    }
    if (!flags.protection && !flags.audit) continue;
    const cls = logic.classifySettingsUpdate(u);
    logger.logInfo(`[antiadmin] settings gid=${maskJid(gid)} kind=${cls.kind} class=${cls.class}`);
    if (flags.audit || cls.class !== 'NORMAL') {
      store.insertEvent({
        telegramUserId,
        group_jid: gid,
        actor_jid: u.author || u.actor || '',
        target_jid: '',
        action: `settings:${cls.kind}`,
        actor_role: '',
        target_role: '',
        detected: 1,
        reverted: 0,
        reason: 'settings',
        risk: cls.risk,
        risk_class: cls.class
      }).catch((e) => {
        gsError({ action: 'insert_settings', group: maskJid(gid) }, e);
      });
    }
  }
}

function x9Lines(update) {
  const u = update || {};
  const lines = [];
  if (u.subject != null) lines.push(`Nome: ${String(u.subject).slice(0, 80)}`);
  if (u.desc != null) {
    const d = typeof u.desc === 'string' ? u.desc : (u.desc && u.desc.toString ? u.desc.toString() : '');
    if (d) lines.push(`Descricao: ${String(d).slice(0, 120)}`);
  }
  if (u.announce != null) lines.push(u.announce ? 'Grupo fechado (so admin fala).' : 'Grupo aberto (todos falam).');
  if (u.restrict != null) lines.push(u.restrict ? 'Edicao restrita a admin.' : 'Edicao liberada.');
  if (u.icon || u.picture) lines.push('Foto do grupo alterada.');
  return lines;
}

async function notifyX9Config(conn, gid, update) {
  const lines = x9Lines(update);
  if (!lines.length) return;
  const { previewText } = require('./typography');
  await conn.sendMessage(gid, {
    text: previewText(`Alteracao no grupo:\n${lines.join('\n')}`)
  });
}

function getMetrics() {
  const n = metrics.n || 0;
  return {
    events: n,
    avgMs: n ? Math.round(metrics.totalMs / n) : 0,
    avgDecideMs: n ? Math.round(metrics.decideMs / n) : 0,
    avgRevertMs: metrics.applied ? Math.round(metrics.revertMs / metrics.applied) : 0,
    applied: metrics.applied,
    ignored: metrics.ignored,
    dupes: metrics.dupes
  };
}

module.exports = {
  processParticipantsUpdate,
  processGroupsUpdate,
  getMetrics,
  flagsFromGroup,
  flagsFromGroup: flagsFromGroup,
  maskJid,
  mentionSafe,
  mentionTag,
  mentionTag: mentionTag,
  preferPhoneJid,
  idsMatch,
  isBotOwnerId,
  isBotOwnerId: isBotOwnerId,
  canonicalAgainst,
  canonicalAgainst: canonicalAgainst,
  rememberSelfOp,
  isSelfOp,
  withLock
};
