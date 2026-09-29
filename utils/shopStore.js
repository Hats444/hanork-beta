'use strict';
/** Persistencia SQL dos cmds migrados (Duda / ZT Beta). Sem JSON. */

const sql = require('./sqlStore');

function now() {
  return new Date().toISOString();
}

function oid(uid) {
  return String(uid || '').trim();
}

function gid(groupId) {
  return String(groupId || '').trim();
}

async function setText(uid, groupId, kind, body) {
  const owner = oid(uid);
  const g = gid(groupId);
  const k = String(kind || '');
  if (!owner || !g || !k) return false;
  await sql.runAsync(
    `INSERT INTO shop_group_text (owner_key, group_jid, kind, body, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(owner_key, group_jid, kind)
     DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`,
    [owner, g, k, String(body || '').slice(0, 4000), now()]
  );
  return true;
}

async function getText(uid, groupId, kind) {
  const row = await sql.getAsync(
    `SELECT body FROM shop_group_text WHERE owner_key=? AND group_jid=? AND kind=?`,
    [oid(uid), gid(groupId), String(kind || '')]
  );
  return row && row.body != null ? String(row.body) : '';
}

async function setSorteioNames(uid, groupId, names) {
  const list = Array.isArray(names) ? names : [];
  const body = list.map((n) => String(n || '').trim()).filter(Boolean).slice(0, 80).join('\n');
  await sql.runAsync(
    `INSERT INTO shop_sorteio (owner_key, group_jid, names, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(owner_key, group_jid)
     DO UPDATE SET names=excluded.names, updated_at=excluded.updated_at`,
    [oid(uid), gid(groupId), body, now()]
  );
}

async function getSorteioNames(uid, groupId) {
  const row = await sql.getAsync(
    `SELECT names FROM shop_sorteio WHERE owner_key=? AND group_jid=?`,
    [oid(uid), gid(groupId)]
  );
  return String(row?.names || '')
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function bumpActivity(uid, groupId, memberJid) {
  const owner = oid(uid);
  const g = gid(groupId);
  const m = String(memberJid || '').trim();
  if (!owner || !g.endsWith('@g.us') || !m) return;
  await sql.runAsync(
    `INSERT INTO shop_activity (owner_key, group_jid, member_jid, n, updated_at)
     VALUES (?,?,?,1,?)
     ON CONFLICT(owner_key, group_jid, member_jid)
     DO UPDATE SET n=n+1, updated_at=excluded.updated_at`,
    [owner, g, m, now()]
  );
}

async function topActivity(uid, groupId, limit = 10) {
  const n = Math.min(20, Math.max(1, Number(limit) || 10));
  return sql.allAsync(
    `SELECT member_jid, n FROM shop_activity
     WHERE owner_key=? AND group_jid=?
     ORDER BY n DESC LIMIT ?`,
    [oid(uid), gid(groupId), n]
  );
}

async function lowActivity(uid, groupId, maxN = 0) {
  const cap = Math.max(0, Number(maxN) || 0);
  return sql.allAsync(
    `SELECT member_jid, n FROM shop_activity
     WHERE owner_key=? AND group_jid=? AND n<=?
     ORDER BY n ASC LIMIT 40`,
    [oid(uid), gid(groupId), cap]
  );
}

async function setHours(uid, groupId, openHm, closeHm, enabled = true) {
  await sql.runAsync(
    `INSERT INTO shop_hours (owner_key, group_jid, open_hm, close_hm, enabled, last_apply, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(owner_key, group_jid)
     DO UPDATE SET open_hm=excluded.open_hm, close_hm=excluded.close_hm,
       enabled=excluded.enabled, updated_at=excluded.updated_at`,
    [oid(uid), gid(groupId), openHm, closeHm, enabled ? 1 : 0, null, now()]
  );
}

async function getHours(uid, groupId) {
  return sql.getAsync(
    `SELECT open_hm, close_hm, enabled, last_apply FROM shop_hours WHERE owner_key=? AND group_jid=?`,
    [oid(uid), gid(groupId)]
  );
}

async function listEnabledHours() {
  return sql.allAsync(
    `SELECT owner_key, group_jid, open_hm, close_hm, last_apply FROM shop_hours WHERE enabled=1`
  );
}

async function markHoursApplied(uid, groupId, stamp) {
  await sql.runAsync(
    `UPDATE shop_hours SET last_apply=? WHERE owner_key=? AND group_jid=?`,
    [String(stamp || ''), oid(uid), gid(groupId)]
  );
}

async function setWelcomeMedia(uid, groupId, kind, buf, mime) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const k = String(kind || 'foto');
  const max = /audio/.test(k) ? 700000 : 450000;
  if (!data.length || data.length > max) return false;
  await sql.runAsync(
    `INSERT INTO shop_welcome_media (owner_key, group_jid, kind, mime, data, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(owner_key, group_jid, kind)
     DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=excluded.updated_at`,
    [oid(uid), gid(groupId), k, String(mime || 'image/jpeg'), data, now()]
  );
  return true;
}

async function deleteWelcomeMedia(uid, groupId, kind) {
  await sql.runAsync(
    `DELETE FROM shop_welcome_media WHERE owner_key=? AND group_jid=? AND kind=?`,
    [oid(uid), gid(groupId), String(kind || '')]
  );
  return true;
}

async function getWelcomeMedia(uid, groupId, kind) {
  const k = String(kind || 'foto');
  const row = await sql.getAsync(
    `SELECT mime, data FROM shop_welcome_media WHERE owner_key=? AND group_jid=? AND kind=?`,
    [oid(uid), gid(groupId), k]
  );
  if (!row || !row.data) return null;
  const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  return { mime: String(row.mime || ''), data };
}

async function setAusente(uid, userJid, reason) {
  await sql.runAsync(
    `INSERT INTO shop_ausente (owner_key, user_jid, reason, since)
     VALUES (?,?,?,?)
     ON CONFLICT(owner_key, user_jid)
     DO UPDATE SET reason=excluded.reason, since=excluded.since`,
    [oid(uid), String(userJid || ''), String(reason || '').slice(0, 200), now()]
  );
}

async function clearAusente(uid, userJid) {
  await sql.runAsync(
    `DELETE FROM shop_ausente WHERE owner_key=? AND user_jid=?`,
    [oid(uid), String(userJid || '')]
  );
}

async function getAusente(uid, userJid) {
  return sql.getAsync(
    `SELECT reason, since FROM shop_ausente WHERE owner_key=? AND user_jid=?`,
    [oid(uid), String(userJid || '')]
  );
}

async function listAusente(uid) {
  return sql.allAsync(
    `SELECT user_jid, reason, since FROM shop_ausente WHERE owner_key=?`,
    [oid(uid)]
  );
}

async function startRaffle(uid, groupId, msgId, winnersN, prompt) {
  await sql.runAsync(
    `INSERT INTO shop_raffle (owner_key, group_jid, msg_id, winners_n, prompt, participants, updated_at)
     VALUES (?,?,?,?,?,'',?)
     ON CONFLICT(owner_key, group_jid)
     DO UPDATE SET msg_id=excluded.msg_id, winners_n=excluded.winners_n,
       prompt=excluded.prompt, participants='', updated_at=excluded.updated_at`,
    [oid(uid), gid(groupId), String(msgId || ''), Math.max(1, Number(winnersN) || 1), String(prompt || '').slice(0, 400), now()]
  );
}

async function getRaffle(uid, groupId) {
  return sql.getAsync(
    `SELECT msg_id, winners_n, prompt, participants FROM shop_raffle WHERE owner_key=? AND group_jid=?`,
    [oid(uid), gid(groupId)]
  );
}

async function addRaffleParticipant(uid, groupId, msgId, userJid) {
  const row = await getRaffle(uid, groupId);
  if (!row || String(row.msg_id) !== String(msgId || '')) return false;
  const jid = String(userJid || '').trim();
  if (!jid) return false;
  const list = String(row.participants || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (list.includes(jid)) return false;
  if (list.length >= 400) return false;
  list.push(jid);
  await sql.runAsync(
    `UPDATE shop_raffle SET participants=?, updated_at=? WHERE owner_key=? AND group_jid=?`,
    [list.join('\n'), now(), oid(uid), gid(groupId)]
  );
  return true;
}

async function clearRaffle(uid, groupId) {
  await sql.runAsync(
    `DELETE FROM shop_raffle WHERE owner_key=? AND group_jid=?`,
    [oid(uid), gid(groupId)]
  );
}

module.exports = {
  setText,
  getText,
  setSorteioNames,
  getSorteioNames,
  bumpActivity,
  topActivity,
  lowActivity,
  setHours,
  getHours,
  listEnabledHours,
  markHoursApplied,
  setWelcomeMedia,
  deleteWelcomeMedia,
  getWelcomeMedia,
  setAusente,
  clearAusente,
  getAusente,
  listAusente,
  startRaffle,
  getRaffle,
  addRaffleParticipant,
  clearRaffle
};
