'use strict';
/**
 * Grupo morto pra DIV: classifica, sai, tira da lista, marca no banco e dispara repor.
 * Unico ponto de saida — ciclo auto, disparo manual, evento nativo, .gruposair.
 */
const logger = require('../logger');
const sql = require('./sqlStore');
const {
  TRANSIENT_FAIL_LIMIT,
  classifyGroupFailure,
  inspectGroupHealth,
  participantsIncludeBot
} = require('./groupFailure');

const FAIL_LIMIT_DEAD = 1;
const busy = new Set();

function nowIso() {
  return new Date().toISOString();
}

function maskGid(gid) {
  try {
    return require('./groupManager/registry').maskJid(gid);
  } catch (_) {
    const s = String(gid || '');
    return s.includes('@') ? `${s.slice(0, 8)}…@g.us` : 'gid?';
  }
}

async function ensureTable() {
  await sql.runAsync(`CREATE TABLE IF NOT EXISTS div_group_health (
    owner_key TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    fail_streak INTEGER NOT NULL DEFAULT 0,
    last_fail_reason TEXT,
    last_fail_at TEXT,
    replaced_at TEXT,
    PRIMARY KEY (owner_key, group_jid)
  )`);
}

async function resetStreak(uid, gid) {
  const owner = String(uid || '');
  const jid = String(gid || '');
  if (!owner || !jid) return;
  try {
    await ensureTable();
    await sql.runAsync(
      `INSERT INTO div_group_health(owner_key, group_jid, fail_streak, last_fail_reason, last_fail_at)
       VALUES(?,?,0,NULL,NULL)
       ON CONFLICT(owner_key, group_jid) DO UPDATE SET fail_streak=0, last_fail_reason=NULL`,
      [owner, jid]
    );
  } catch (e) {
    logger.logAviso(`[DIV-DEAD] reset: ${e.message}`);
  }
}

async function bumpStreak(uid, gid, reason) {
  const owner = String(uid || '');
  const jid = String(gid || '');
  if (!owner || !jid) return 0;
  await ensureTable();
  await sql.runAsync(
    `INSERT INTO div_group_health(owner_key, group_jid, fail_streak, last_fail_reason, last_fail_at)
     VALUES(?,?,1,?,?)
     ON CONFLICT(owner_key, group_jid) DO UPDATE SET
       fail_streak=fail_streak+1,
       last_fail_reason=excluded.last_fail_reason,
       last_fail_at=excluded.last_fail_at`,
    [owner, jid, String(reason || '').slice(0, 160), nowIso()]
  );
  const rows = await sql.allAsync(
    `SELECT fail_streak FROM div_group_health WHERE owner_key=? AND group_jid=?`,
    [owner, jid]
  );
  return Number(rows && rows[0] && rows[0].fail_streak) || 0;
}

function listDivGroups(uid) {
  const { getGruposParaDivulgar } = require('./divulgacao');
  return (getGruposParaDivulgar(uid).grupos) || [];
}

function normalizeGid(jid) {
  try {
    const { officialList } = require('./groupManager/registry');
    void officialList;
  } catch (_) { /* ignore */ }
  const s = String(jid || '').trim();
  if (s.endsWith('@g.us')) {
    const user = s.split('@')[0].split(':')[0];
    return user ? `${user}@g.us` : '';
  }
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length >= 15 && digits.startsWith('120')) return `${digits}@g.us`;
  return s;
}

function liveIo() {
  return {
    async groupLeave(uid, gid) {
      const { listLiveConns } = require('./groupManager/joinService');
      const live = listLiveConns(uid) || [];
      for (const item of live) {
        if (item?.conn && typeof item.conn.groupLeave === 'function') {
          try {
            await item.conn.groupLeave(gid);
            return true;
          } catch (e) {
            const m = String(e.message || e);
            if (/not-participant|item-not-found|forbidden|not-authorized/i.test(m)) return true;
            logger.logAviso(`[META] leave ${maskGid(gid)} ${m.slice(0, 80)}`);
          }
        }
      }
      return true;
    },
    async unlist(uid, gid) {
      const { removerGrupo } = require('./divulgacao');
      removerGrupo(uid, gid);
      try {
        const { unregisterGroup } = require('./groupManager/registry');
        await unregisterGroup(uid, gid);
      } catch (_) { /* ignore */ }
      try {
        const { setGroupSecurityFlag } = require('./moderation');
        await setGroupSecurityFlag(gid, uid, 'grupoDivulgacao', false);
      } catch (_) { /* ignore */ }
    },
    async markInvite(uid, gid, reason) {
      const inviteStore = require('./groupManager/inviteStore');
      const row = await inviteStore.getByGroupJid(uid, gid);
      if (row) {
        await inviteStore.updateInvite(row.id, {
          status: 'left',
          lastError: `dead:${String(reason || '').slice(0, 120)}`
        });
      }
    },
    dropMeta(gid) {
      try {
        const { dropGroupMetadata, invalidateGroupMetadata } = require('./groupMetaCache');
        if (typeof dropGroupMetadata === 'function') dropGroupMetadata(gid);
        else invalidateGroupMetadata(gid);
      } catch (_) { /* cache opcional */ }
    },
    invalidateOcc(uid) {
      try {
        require('./groupManager/joinService').invalidateOccupancyCache(uid);
      } catch (_) { /* ignore */ }
    },
    autoRefillOn(uid) {
      try {
        const lim = require('./groupManager/limits').loadLimits(uid);
        return lim.autoRefill === true;
      } catch (_) {
        return true;
      }
    },
    scheduleRefill(uid) {
      try {
        const js = require('./groupManager/joinService');
        if (typeof js.scheduleOccupancyRefill === 'function') js.scheduleOccupancyRefill(uid);
        else {
          setImmediate(() => {
            js.maintainOccupancy(uid, { fromRetire: true }).catch((e) => {
              logger.logAviso(`[META] repor: ${e.message}`);
            });
          });
        }
      } catch (e) {
        logger.logAviso(`[META] repor schedule: ${e.message}`);
      }
    }
  };
}

async function analyzeDivBase(uid) {
  const owner = String(uid || '');
  if (!owner) return { live: 0, div: 0, pending: 0, sessions: 0 };
  let liveN = 0;
  try {
    const { listLiveConns } = require('./groupManager/joinService');
    const { listParticipatingGroupJids } = require('./divulgacao');
    const live = listLiveConns(owner) || [];
    for (const item of live) {
      const jids = await listParticipatingGroupJids(item.conn);
      liveN = Math.max(liveN, jids.length);
    }
  } catch (e) {
    logger.logAviso(`[META] analise live: ${e.message}`);
  }
  try {
    await require('./groupManager/queue').recoverMissingRegistry(owner);
  } catch (_) { /* heal opcional */ }
  const divN = listDivGroups(owner).length;
  let pending = 0;
  try {
    pending = await require('./groupManager/inviteStore').countByStatus(owner, 'pending');
  } catch (_) { /* ignore */ }
  let teto = 0;
  let joinsToday = 0;
  let maxJoins = 0;
  try {
    const lim = require('./groupManager/limits').loadLimits(owner);
    const st = require('./groupManager/limits').loadState(owner);
    teto = lim.maxTotalGroups;
    maxJoins = lim.maxJoinsPerDay;
    joinsToday = st.joinsToday || 0;
  } catch (_) { /* ignore */ }
  logger.logInfo(
    `[META] analise live=${liveN} div=${divN} pending=${pending} teto=${teto} dia=${joinsToday}/${maxJoins}`
  );
  return { live: liveN, div: divN, pending, teto, joinsToday, maxJoins };
}

/**
 * Sai, tira da lista DIV, marca morto, invalida cache e dispara auto-repor.
 * skipRefill / io so pra teste. autoRefill OFF nao impede a saida.
 */
async function retireDeadGroup(gid, ownerId, reason, opts = {}) {
  const uid = String(ownerId || '');
  const groupJid = normalizeGid(gid);
  const why = String(reason || 'dead').slice(0, 120);
  if (!uid || !groupJid.endsWith('@g.us')) {
    return { ok: false, reason: 'bad-args' };
  }
  const key = `${uid}|${groupJid}`;
  if (busy.has(key)) return { ok: false, reason: 'busy' };
  busy.add(key);
  const io = opts.io || liveIo();
  try {
    logger.logInfo(`[META] grupo=${maskGid(groupJid)} morto motivo=${why} substituindo...`);
    try {
      await io.groupLeave(uid, groupJid);
    } catch (_) { /* ja nao e membro = sucesso silencioso */ }
    try {
      await io.unlist(uid, groupJid);
    } catch (_) { /* lista opcional */ }
    try {
      await io.markInvite(uid, groupJid, why);
    } catch (e) {
      logger.logAviso(`[META] mark invite: ${e.message}`);
    }
    try { await resetStreak(uid, groupJid); } catch (_) { /* sql opcional */ }
    try {
      await ensureTable();
      await sql.runAsync(
        `UPDATE div_group_health SET replaced_at=?, fail_streak=0 WHERE owner_key=? AND group_jid=?`,
        [nowIso(), uid, groupJid]
      );
    } catch (_) { /* tabela pode nao existir */ }
    io.dropMeta(groupJid);
    io.invalidateOcc(uid);
    try {
      await analyzeDivBase(uid);
    } catch (e) {
      logger.logAviso(`[META] analise: ${e.message}`);
    }
    const refillOn = opts.autoRefill != null ? !!opts.autoRefill : io.autoRefillOn(uid);
    let refill = false;
    if (!opts.skipRefill && refillOn) {
      io.scheduleRefill(uid);
      refill = true;
    }
    return { ok: true, jid: groupJid, reason: why, refill };
  } catch (e) {
    logger.logAviso(`[META] retire: ${e.message}`);
    return { ok: false, reason: e.message };
  } finally {
    busy.delete(key);
  }
}

function targetQuota(uid) {
  try {
    const lim = require('./groupManager/limits').loadLimits(uid);
    if (lim && lim.maxTotalGroups > 0) return lim.maxTotalGroups;
  } catch (_) { /* fallback */ }
  const { getConfig, updateConfig } = require('./divulgacao');
  const cfg = getConfig(uid);
  const have = listDivGroups(uid).length;
  const min = Math.max(0, parseInt(cfg.autoCreateMin, 10) || 0);
  const saved = Math.max(0, parseInt(cfg.divGroupQuota, 10) || 0);
  const quota = Math.max(min, saved, have);
  if (quota && quota !== saved) updateConfig(uid, { divGroupQuota: quota });
  return quota;
}

async function replaceDeadGroup(uid, gid, reason) {
  return retireDeadGroup(gid, uid, reason);
}

function onDivGroupResult(uid, gid, opts = {}) {
  const sent = !!opts.sent;
  const fail = !!opts.fail;
  const reason = opts.reason || '';
  const context = opts.context || {};
  if (sent) {
    resetStreak(uid, gid).catch(() => {});
    return { kind: 'ok', reason: 'sent' };
  }
  if (!fail && !context.kind && !context.botRemoved && !context.announce) {
    return { kind: 'ok', reason: 'no-fail' };
  }
  const classified = classifyGroupFailure(reason, context);
  if (classified.kind !== 'dead' && classified.kind !== 'transient') {
    return classified;
  }
  if (classified.kind === 'dead') {
    retireDeadGroup(gid, uid, classified.reason, { io: opts.io, skipRefill: opts.skipRefill }).catch((e) => {
      logger.logAviso(`[META] retire async: ${e.message}`);
    });
    return classified;
  }
  bumpStreak(uid, gid, classified.reason)
    .then((n) => {
      if (n >= TRANSIENT_FAIL_LIMIT) {
        return retireDeadGroup(gid, uid, `transient_x${n}:${classified.reason}`, { io: opts.io, skipRefill: opts.skipRefill });
      }
      return null;
    })
    .catch((e) => logger.logAviso(`[META] streak: ${e.message}`));
  return classified;
}

function ownersForDivGroup(gid) {
  const needle = String(gid || '');
  const out = [];
  if (!needle.endsWith('@g.us')) return out;
  try {
    const { getAllSessions } = require('./sessionRegistry');
    const { officialList } = require('./groupManager/registry');
    const seen = new Set();
    for (const s of getAllSessions() || []) {
      const uid = String(s.telegramUserId || '');
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      if ((officialList(uid) || []).includes(needle)) out.push(uid);
    }
  } catch (_) { /* registry opcional */ }
  return out;
}

async function onIqGroupFailure(gid, error, conn) {
  const classified = classifyGroupFailure(error);
  if (classified.kind !== 'dead') return { ok: false, reason: classified.kind };
  const groupJid = String(gid || '');
  let owners = ownersForDivGroup(groupJid);
  const hint = conn && conn._telegramUserId ? String(conn._telegramUserId) : '';
  if (hint && !owners.includes(hint) && listDivGroups(hint).includes(groupJid)) {
    owners = [hint].concat(owners);
  }
  if (!owners.length) return { ok: false, reason: 'not-div' };
  const results = [];
  for (const uid of owners) {
    results.push(await retireDeadGroup(groupJid, uid, classified.reason));
  }
  return { ok: true, n: results.length, results };
}

async function onParticipantsUpdate(conn, update, telegramUserId) {
  const uid = String(telegramUserId || '');
  const gid = String(update && update.id || '');
  const action = String(update && update.action || '');
  if (!uid || !gid.endsWith('@g.us')) return { ok: false };
  if (action !== 'remove' && action !== 'leave') return { ok: false, reason: 'not-leave' };
  if (!participantsIncludeBot(conn, update)) return { ok: false, reason: 'not-bot' };
  return retireDeadGroup(gid, uid, 'bot_removed');
}

async function onGroupsUpdate(conn, updates, telegramUserId) {
  const uid = String(telegramUserId || '');
  if (!uid || !Array.isArray(updates)) return { ok: false };
  const lista = new Set(listDivGroups(uid));
  const out = [];
  for (const u of updates) {
    const gid = String(u && u.id || '');
    if (!gid.endsWith('@g.us') || !lista.has(gid)) continue;
    if (u.announce == null && u.restrict == null) continue;
    const health = inspectGroupHealth(conn, gid);
    if (health.kind === 'dead') {
      out.push(await retireDeadGroup(gid, uid, health.reason));
    }
  }
  return { ok: true, n: out.length, results: out };
}

module.exports = {
  FAIL_LIMIT: FAIL_LIMIT_DEAD,
  FAIL_LIMIT_DEAD,
  TRANSIENT_FAIL_LIMIT,
  classifyGroupFailure,
  inspectGroupHealth,
  onDivGroupResult,
  retireDeadGroup,
  analyzeDivBase,
  replaceDeadGroup,
  targetQuota,
  onParticipantsUpdate,
  onGroupsUpdate,
  onIqGroupFailure,
  ownersForDivGroup
};
