'use strict';

const crypto = require('crypto');
const { runAsync, getAsync, allAsync, isReady } = require('./sqlStore');
const logic = require('./groupTheftLogic');

const mem = new Map();

function ownerKey(telegramUserId) {
  return String(telegramUserId || '0');
}

function cacheKey(gid, telegramUserId) {
  return `${ownerKey(telegramUserId)}|${gid}`;
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function emptyRecord(groupJid) {
  return {
    group_jid: groupJid,
    native_owner_jid: '',
    registered_owner_jid: '',
    protection_enabled: 0,
    audit_enabled: 0,
    revert_enabled: 1,
    alert_enabled: 0,
    alert_dest: 'silent',
    attack_detect: 1,
    threshold: logic.DEFAULT_THRESHOLD,
    window_ms: logic.DEFAULT_WINDOW_MS,
    trusted: []
  };
}

function fromRow(row, trusted) {
  if (!row) return null;
  return {
    group_jid: row.group_jid,
    native_owner_jid: row.native_owner_jid || '',
    registered_owner_jid: row.registered_owner_jid || '',
    protection_enabled: Number(row.protection_enabled) || 0,
    audit_enabled: Number(row.audit_enabled) || 0,
    revert_enabled: row.revert_enabled == null ? 1 : Number(row.revert_enabled),
    alert_enabled: Number(row.alert_enabled) || 0,
    alert_dest: row.alert_dest || 'silent',
    attack_detect: row.attack_detect == null ? 1 : Number(row.attack_detect),
    threshold: Number(row.threshold) || logic.DEFAULT_THRESHOLD,
    window_ms: Number(row.window_ms) || logic.DEFAULT_WINDOW_MS,
    trusted: Array.isArray(trusted) ? trusted : []
  };
}

function peek(groupJid, telegramUserId) {
  const hit = mem.get(cacheKey(groupJid, telegramUserId));
  if (!hit) return null;
  const age = Date.now() - Number(hit._loadedAt || 0);
  if (age > 15000) {
    mem.delete(cacheKey(groupJid, telegramUserId));
    return null;
  }
  return hit;
}

function put(groupJid, telegramUserId, rec) {
  const next = { ...(rec || {}), _loadedAt: Date.now() };
  mem.set(cacheKey(groupJid, telegramUserId), next);
  return next;
}

function invalidate(groupJid, telegramUserId) {
  mem.delete(cacheKey(groupJid, telegramUserId));
}

async function load(groupJid, telegramUserId) {
  const gid = String(groupJid || '');
  if (!gid) return emptyRecord(gid);
  const hit = peek(gid, telegramUserId);
  if (hit) return hit;
  if (!isReady()) {
    return put(gid, telegramUserId, emptyRecord(gid));
  }
  const ok = ownerKey(telegramUserId);
  const row = await getAsync(
    'SELECT * FROM group_security WHERE group_jid=? AND owner_key=?',
    [gid, ok]
  );
  const trusted = await allAsync(
    'SELECT jid, role, added_by, created_at FROM group_trusted_admins WHERE group_jid=? AND owner_key=?',
    [gid, ok]
  );
  const rec = row ? fromRow(row, trusted || []) : emptyRecord(gid);
  rec.trusted = trusted || [];
  return put(gid, telegramUserId, rec);
}

async function upsert(groupJid, telegramUserId, patch) {
  const gid = String(groupJid || '');
  const ok = ownerKey(telegramUserId);
  const cur = await load(gid, telegramUserId);
  const next = { ...cur, ...(patch || {}) };
  if (Array.isArray(patch && patch.trusted)) next.trusted = patch.trusted;
  delete next._loadedAt;
  const ts = nowIso();
  if (!isReady()) {
    return put(gid, telegramUserId, next);
  }
  await runAsync(
    `INSERT INTO group_security (
      group_jid, owner_key, native_owner_jid, registered_owner_jid,
      protection_enabled, audit_enabled, revert_enabled, alert_enabled,
      alert_dest, attack_detect, threshold, window_ms, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(group_jid, owner_key) DO UPDATE SET
      native_owner_jid=excluded.native_owner_jid,
      registered_owner_jid=excluded.registered_owner_jid,
      protection_enabled=excluded.protection_enabled,
      audit_enabled=excluded.audit_enabled,
      revert_enabled=excluded.revert_enabled,
      alert_enabled=excluded.alert_enabled,
      alert_dest=excluded.alert_dest,
      attack_detect=excluded.attack_detect,
      threshold=excluded.threshold,
      window_ms=excluded.window_ms,
      updated_at=excluded.updated_at`,
    [
      gid,
      ok,
      next.native_owner_jid || '',
      next.registered_owner_jid || '',
      next.protection_enabled ? 1 : 0,
      next.audit_enabled ? 1 : 0,
      next.revert_enabled ? 1 : 0,
      next.alert_enabled ? 1 : 0,
      next.alert_dest || 'silent',
      next.attack_detect ? 1 : 0,
      Number(next.threshold) || logic.DEFAULT_THRESHOLD,
      Number(next.window_ms) || logic.DEFAULT_WINDOW_MS,
      ts,
      ts
    ]
  );
  return put(gid, telegramUserId, next);
}

async function addTrusted(groupJid, telegramUserId, jid, role, addedBy) {
  const gid = String(groupJid || '');
  const id = String(jid || '');
  if (!gid || !id) return false;
  const rec = await load(gid, telegramUserId);
  if (rec.trusted.some((t) => logic.sameId(t.jid, id))) return false;
  const row = {
    jid: id,
    role: String(role || 'OWNER_TRUSTED').toUpperCase(),
    added_by: addedBy || '',
    created_at: nowIso()
  };
  rec.trusted.push(row);
  put(gid, telegramUserId, rec);
  if (isReady()) {
    await runAsync(
      `INSERT OR IGNORE INTO group_trusted_admins (group_jid, owner_key, jid, role, added_by, created_at)
       VALUES (?,?,?,?,?,?)`,
      [gid, ownerKey(telegramUserId), id, row.role, row.added_by, row.created_at]
    );
  }
  return true;
}

async function removeTrusted(groupJid, telegramUserId, jid) {
  const gid = String(groupJid || '');
  const rec = await load(gid, telegramUserId);
  const gone = rec.trusted.filter((t) => logic.sameId(t.jid, jid));
  rec.trusted = rec.trusted.filter((t) => !logic.sameId(t.jid, jid));
  put(gid, telegramUserId, rec);
  if (isReady() && gone.length) {
    const ok = ownerKey(telegramUserId);
    for (const t of gone) {
      await runAsync(
        'DELETE FROM group_trusted_admins WHERE group_jid=? AND owner_key=? AND jid=?',
        [gid, ok, String(t.jid || '')]
      );
    }
  }
  return gone.length > 0;
}

async function insertEvent(evt) {
  const id = evt.id || newId();
  const row = {
    id,
    group_jid: evt.group_jid,
    owner_key: ownerKey(evt.telegramUserId),
    actor_jid: evt.actor_jid || '',
    target_jid: evt.target_jid || '',
    action: evt.action || '',
    actor_role: evt.actor_role || '',
    target_role: evt.target_role || '',
    detected: evt.detected ? 1 : 0,
    reverted: evt.reverted ? 1 : 0,
    reason: evt.reason || '',
    risk: Number(evt.risk) || 0,
    risk_class: evt.risk_class || evt.class || '',
    created_at: evt.created_at || nowIso()
  };
  if (isReady()) {
    await runAsync(
      `INSERT INTO group_security_events (
        id, group_jid, owner_key, actor_jid, target_jid, action,
        actor_role, target_role, detected, reverted, reason, risk, risk_class, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.group_jid, row.owner_key, row.actor_jid, row.target_jid, row.action,
        row.actor_role, row.target_role, row.detected, row.reverted, row.reason,
        row.risk, row.risk_class, row.created_at
      ]
    );
  }
  return row;
}

async function listEvents(groupJid, telegramUserId, { page = 1, pageSize = 8 } = {}) {
  const gid = String(groupJid || '');
  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(20, Math.max(1, Number(pageSize) || 8));
  if (!isReady()) return { page: p, pageSize: size, rows: [], total: 0 };
  const totalRow = await getAsync(
    'SELECT COUNT(*) AS n FROM group_security_events WHERE group_jid=? AND owner_key=?',
    [gid, ownerKey(telegramUserId)]
  );
  const rows = await allAsync(
    `SELECT id, actor_jid, target_jid, action, actor_role, target_role,
            detected, reverted, reason, risk, risk_class, created_at
     FROM group_security_events
     WHERE group_jid=? AND owner_key=?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [gid, ownerKey(telegramUserId), size, (p - 1) * size]
  );
  return { page: p, pageSize: size, rows: rows || [], total: Number(totalRow && totalRow.n) || 0 };
}

async function insertTransfer(row) {
  const id = row.id || newId();
  const rec = {
    id,
    group_jid: row.group_jid,
    owner_key: ownerKey(row.telegramUserId),
    previous_owner: row.previous_owner || '',
    new_owner: row.new_owner || '',
    transferred_by: row.transferred_by || '',
    reason: row.reason || 'transfer',
    created_at: nowIso()
  };
  if (isReady()) {
    await runAsync(
      `INSERT INTO group_owner_transfers (
        id, group_jid, owner_key, previous_owner, new_owner, transferred_by, reason, created_at
      ) VALUES (?,?,?,?,?,?,?,?)`,
      [
        rec.id, rec.group_jid, rec.owner_key, rec.previous_owner,
        rec.new_owner, rec.transferred_by, rec.reason, rec.created_at
      ]
    );
  }
  return rec;
}

async function pruneOldEvents(maxAgeMs) {
  if (!isReady()) return 0;
  const days = Number(process.env.HANORK_SECURITY_EVENTS_MAX_AGE_DAYS || 30);
  const age = Number(maxAgeMs) > 0 ? Number(maxAgeMs) : Math.max(1, days) * 86400000;
  const cutoff = new Date(Date.now() - age).toISOString();
  try {
    const res = await runAsync(
      'DELETE FROM group_security_events WHERE created_at < ?',
      [cutoff]
    );
    return Number(res?.changes) || 0;
  } catch (_) {
    return 0;
  }
}

module.exports = {
  ownerKey,
  peek,
  load,
  upsert,
  invalidate,
  addTrusted,
  removeTrusted,
  insertEvent,
  listEvents,
  insertTransfer,
  pruneOldEvents,
  emptyRecord,
  newId
};
