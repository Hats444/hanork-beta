'use strict';

const logger = require('../../logger');
const { inviteUrl } = require('./inviteDetect');

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS group_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,
  invite_code TEXT NOT NULL,
  invite_url TEXT,
  source_jid TEXT,
  source_session TEXT,
  join_session TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  group_jid TEXT,
  group_name TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  joined_at TEXT,
  last_error TEXT,
  seen_count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_key, invite_code)
)`;

let schemaReady = false;

function nowIso() {
  return new Date().toISOString();
}

function sql() {
  return require('../sqlStore');
}

async function ensureSchema() {
  if (schemaReady) return true;
  try {
    await sql().runAsync(TABLE_SQL, []);
    await sql().runAsync(
      `CREATE INDEX IF NOT EXISTS idx_ginv_owner_status ON group_invites(owner_key, status)`,
      []
    );
    schemaReady = true;
    return true;
  } catch (e) {
    logger.logAviso(`[GROUP_INVITE] schema: ${String(e.message || e).slice(0, 120)}`);
    return false;
  }
}

function mapRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    ownerKey: r.owner_key,
    inviteCode: r.invite_code,
    inviteUrl: r.invite_url,
    sourceJid: r.source_jid,
    sourceSession: r.source_session,
    joinSession: r.join_session,
    status: r.status,
    groupJid: r.group_jid,
    groupName: r.group_name,
    attemptCount: Number(r.attempt_count) || 0,
    lastAttemptAt: r.last_attempt_at,
    joinedAt: r.joined_at,
    lastError: r.last_error,
    seenCount: Number(r.seen_count) || 1,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

async function saveInvite({
  ownerKey,
  inviteCode,
  sourceJid,
  sourceSession
}) {
  const ok = await ensureSchema();
  if (!ok) return { ok: false, reason: 'sql' };
  const owner = String(ownerKey || '').slice(0, 80);
  const code = String(inviteCode || '');
  if (!owner || !code) return { ok: false, reason: 'bad-args' };
  const ts = nowIso();
  const url = inviteUrl(code);
  try {
    const existing = await sql().allAsync(
      `SELECT * FROM group_invites WHERE owner_key=? AND invite_code=? LIMIT 1`,
      [owner, code]
    );
    if (existing[0]) {
      const st = String(existing[0].status || '');
      const reopen = !['pending', 'processing', 'joined', 'already_member'].includes(st);
      if (reopen) {
        await sql().runAsync(
          `UPDATE group_invites
           SET status='pending',
               seen_count = seen_count + 1,
               last_seen_at = ?,
               last_error = NULL,
               source_jid = COALESCE(?, source_jid),
               source_session = COALESCE(?, source_session),
               updated_at = ?
           WHERE owner_key=? AND invite_code=?`,
          [ts, sourceJid || null, sourceSession || null, ts, owner, code]
        );
        logger.logInfo('[GROUP_INVITE_SAVED] reopened status=pending');
        return {
          ok: true,
          created: true,
          reopened: true,
          row: mapRow({ ...existing[0], status: 'pending', last_seen_at: ts, updated_at: ts })
        };
      }
      await sql().runAsync(
        `UPDATE group_invites
         SET seen_count = seen_count + 1,
             last_seen_at = ?,
             source_jid = COALESCE(source_jid, ?),
             source_session = COALESCE(source_session, ?),
             updated_at = ?
         WHERE owner_key=? AND invite_code=?`,
        [ts, sourceJid || null, sourceSession || null, ts, owner, code]
      );
      const row = mapRow({
        ...existing[0],
        seen_count: (Number(existing[0].seen_count) || 1) + 1,
        last_seen_at: ts
      });
      return { ok: true, created: false, row };
    }
    await sql().runAsync(
      `INSERT INTO group_invites (
        owner_key, invite_code, invite_url, source_jid, source_session,
        status, seen_count, last_seen_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,1,?,?,?)`,
      [owner, code, url, sourceJid || null, sourceSession || null, 'pending', ts, ts, ts]
    );
    const rows = await sql().allAsync(
      `SELECT * FROM group_invites WHERE owner_key=? AND invite_code=? LIMIT 1`,
      [owner, code]
    );
    const row = mapRow(rows[0]);
    logger.logInfo('[GROUP_INVITE_SAVED] new status=pending');
    return { ok: true, created: true, row };
  } catch (e) {
    const msg = String(e.message || e);
    // Race: dois saves do mesmo invite — trata como update de seen_count
    if (/UNIQUE constraint failed.*group_invites/i.test(msg)) {
      try {
        const ts2 = nowIso();
        await sql().runAsync(
          `UPDATE group_invites
           SET seen_count = seen_count + 1,
               last_seen_at = ?,
               source_jid = COALESCE(source_jid, ?),
               source_session = COALESCE(source_session, ?),
               updated_at = ?
           WHERE owner_key=? AND invite_code=?`,
          [ts2, sourceJid || null, sourceSession || null, ts2, owner, code]
        );
        const rows = await sql().allAsync(
          `SELECT * FROM group_invites WHERE owner_key=? AND invite_code=? LIMIT 1`,
          [owner, code]
        );
        return { ok: true, created: false, raced: true, row: mapRow(rows[0]) };
      } catch (e2) {
        logger.logAviso(`[GROUP_INVITE] save race: ${String(e2.message || e2).slice(0, 140)}`);
        return { ok: false, reason: String(e2.message || e2).slice(0, 80) };
      }
    }
    logger.logAviso(`[GROUP_INVITE] save: ${msg.slice(0, 140)}`);
    return { ok: false, reason: msg.slice(0, 80) };
  }
}

async function countByStatus(ownerKey, status) {
  await ensureSchema();
  const rows = await sql().allAsync(
    `SELECT COUNT(*) AS n FROM group_invites WHERE owner_key=? AND status=?`,
    [String(ownerKey), status]
  );
  return Number(rows[0]?.n) || 0;
}

async function counts(ownerKey) {
  await ensureSchema();
  const rows = await sql().allAsync(
    `SELECT status, COUNT(*) AS n FROM group_invites WHERE owner_key=? GROUP BY status`,
    [String(ownerKey)]
  );
  const out = {
    pending: 0,
    processing: 0,
    joined: 0,
    already_member: 0,
    expired: 0,
    invalid: 0,
    failed: 0,
    blocked: 0,
    left: 0
  };
  for (const r of rows) out[r.status] = Number(r.n) || 0;
  out.active = (out.joined || 0) + (out.already_member || 0);
  return out;
}

async function listByStatus(ownerKey, status, { limit = 40, offset = 0 } = {}) {
  await ensureSchema();
  const rows = await sql().allAsync(
    `SELECT * FROM group_invites WHERE owner_key=? AND status=?
     ORDER BY id ASC LIMIT ? OFFSET ?`,
    [String(ownerKey), status, Math.max(1, Math.min(100, limit)), Math.max(0, offset)]
  );
  return rows.map(mapRow);
}

async function listJoinedGroupJids(ownerKey) {
  await ensureSchema();
  const rows = await sql().allAsync(
    `SELECT DISTINCT group_jid FROM group_invites
     WHERE owner_key=? AND status IN ('joined','already_member')
       AND group_jid IS NOT NULL AND group_jid != ''`,
    [String(ownerKey)]
  );
  return (rows || []).map((r) => r.group_jid).filter(Boolean);
}

async function listJoined(ownerKey, { limit = 20, offset = 0 } = {}) {
  await ensureSchema();
  const rows = await sql().allAsync(
    `SELECT * FROM group_invites
     WHERE owner_key=? AND status IN ('joined','already_member')
     ORDER BY joined_at DESC, id DESC LIMIT ? OFFSET ?`,
    [String(ownerKey), Math.max(1, Math.min(50, limit)), Math.max(0, offset)]
  );
  return rows.map(mapRow);
}

async function claimPending(ownerKey, n) {
  await ensureSchema();
  const want = Math.max(0, Math.min(50, Number(n) || 0));
  if (!want) return [];
  const rows = await sql().allAsync(
    `SELECT * FROM group_invites
     WHERE owner_key=? AND status='pending'
     ORDER BY COALESCE(last_attempt_at, created_at) ASC, id ASC LIMIT ?`,
    [String(ownerKey), want]
  );
  const claimed = [];
  const ts = nowIso();
  for (const r of rows) {
    const res = await sql().runAsync(
      `UPDATE group_invites SET status='processing', updated_at=?
       WHERE id=? AND status='pending'`,
      [ts, r.id]
    );
    if (res && res.changes) claimed.push(mapRow({ ...r, status: 'processing', updated_at: ts }));
  }
  return claimed;
}

async function updateInvite(id, patch) {
  await ensureSchema();
  const ts = nowIso();
  const fields = [];
  const params = [];
  const map = {
    status: 'status',
    groupJid: 'group_jid',
    groupName: 'group_name',
    joinSession: 'join_session',
    lastError: 'last_error',
    attemptCount: 'attempt_count',
    lastAttemptAt: 'last_attempt_at',
    joinedAt: 'joined_at'
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) {
      fields.push(`${col}=?`);
      params.push(patch[k]);
    }
  }
  fields.push('updated_at=?');
  params.push(ts, id);
  await sql().runAsync(
    `UPDATE group_invites SET ${fields.join(', ')} WHERE id=?`,
    params
  );
}

async function getById(id) {
  await ensureSchema();
  const rows = await sql().allAsync(`SELECT * FROM group_invites WHERE id=? LIMIT 1`, [id]);
  return mapRow(rows[0]);
}

async function getByGroupJid(ownerKey, groupJid) {
  await ensureSchema();
  const rows = await sql().allAsync(
    `SELECT * FROM group_invites WHERE owner_key=? AND group_jid=? LIMIT 1`,
    [String(ownerKey), String(groupJid)]
  );
  return mapRow(rows[0]);
}

async function healOrphans() {
  const ok = await ensureSchema();
  if (!ok) return 0;
  const res = await sql().runAsync(
    `UPDATE group_invites SET status='pending', updated_at=?
     WHERE status='processing'`,
    [nowIso()]
  );
  const n = Number(res?.changes) || 0;
  if (n) logger.logInfo(`[GROUP_INVITE] heal processing->pending n=${n}`);
  return n;
}

async function reprocessFailed(ownerKey, maxAttempts) {
  await ensureSchema();
  const cap = Math.max(1, Number(maxAttempts) || 3);
  const res = await sql().runAsync(
    `UPDATE group_invites SET status='pending', last_error=NULL, updated_at=?
     WHERE owner_key=? AND status='failed' AND attempt_count < ?`,
    [nowIso(), String(ownerKey), cap]
  );
  return Number(res?.changes) || 0;
}

async function clearInvalid(ownerKey) {
  await ensureSchema();
  const res = await sql().runAsync(
    `DELETE FROM group_invites
     WHERE owner_key=? AND status IN ('expired','invalid')`,
    [String(ownerKey)]
  );
  return Number(res?.changes) || 0;
}

async function lastJoinedAt(ownerKey) {
  await ensureSchema();
  const rows = await sql().allAsync(
    `SELECT joined_at FROM group_invites
     WHERE owner_key=? AND joined_at IS NOT NULL
     ORDER BY joined_at DESC LIMIT 1`,
    [String(ownerKey)]
  );
  return rows[0]?.joined_at || null;
}

async function countJoinedBySession(ownerKey, sessionId) {
  await ensureSchema();
  const rows = await sql().allAsync(
    `SELECT COUNT(*) AS n FROM group_invites
     WHERE owner_key=? AND join_session=? AND status IN ('joined','already_member')`,
    [String(ownerKey), String(sessionId)]
  );
  return Number(rows[0]?.n) || 0;
}

async function joinedMissingRegistry(ownerKey, officialSet) {
  await ensureSchema();
  const rows = await sql().allAsync(
    `SELECT * FROM group_invites
     WHERE owner_key=? AND status IN ('joined','already_member')
       AND group_jid IS NOT NULL AND group_jid != ''`,
    [String(ownerKey)]
  );
  return rows.map(mapRow).filter((r) => {
    const gid = String(r.groupJid || '').trim();
    if (!gid) return false;
    if (officialSet.has(gid)) return false;
    const user = gid.split('@')[0].split(':')[0];
    const alt = user ? `${user}@g.us` : '';
    return !(alt && officialSet.has(alt));
  });
}

async function pruneStalePending(maxAgeMs) {
  const ok = await ensureSchema();
  if (!ok) return 0;
  const days = Number(process.env.HANORK_INVITE_PENDING_MAX_AGE_DAYS || 14);
  const age = Number(maxAgeMs) > 0 ? Number(maxAgeMs) : Math.max(1, days) * 86400000;
  const cutoff = new Date(Date.now() - age).toISOString();
  const ts = nowIso();
  try {
    const res = await sql().runAsync(
      `UPDATE group_invites SET status='expired', updated_at=?
       WHERE status='pending' AND created_at < ?`,
      [ts, cutoff]
    );
    const n = Number(res?.changes) || 0;
    if (n) logger.logInfo(`[GROUP_INVITE] prune pending expired=${n}`);
    return n;
  } catch (e) {
    logger.logAviso(`[GROUP_INVITE] prune: ${String(e.message || e).slice(0, 120)}`);
    return 0;
  }
}

module.exports = {
  ensureSchema,
  saveInvite,
  pruneStalePending,
  countByStatus,
  counts,
  listByStatus,
  listJoined,
  claimPending,
  updateInvite,
  getById,
  getByGroupJid,
  healOrphans,
  reprocessFailed,
  clearInvalid,
  lastJoinedAt,
  countJoinedBySession,
  joinedMissingRegistry,
  listJoinedGroupJids
};
