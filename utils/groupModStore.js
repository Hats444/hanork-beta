'use strict';
/**
 * SQL unico: ban temporario, agenda pontual, cmd bloqueado da sessao,
 * cooldown de autoaceitar, aviso custom do anti-PV.
 * Sem JSON. Isolado por owner_key (telegramUserId).
 */

const logger = require('../logger');

const blockedCache = new Map(); // owner_key -> Set(cmd)
const pvNoticeCache = new Map();
let blockedWarmed = false;

const PROTECTED_CMDS = new Set([
  'bloquearcmd', 'desbloquearcmd', 'listablockcmd',
  'bloquearcomando', 'desbloquearcomando', 'comandosblock',
  'menu', 'ping', 'setprefix', 'addowner', 'removeowner',
  'leave', 'sairgp', 'sairgps', 'msgantipv'
]);

function ownerKey(uid) {
  return String(uid || '').trim();
}

function normCmd(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^[^a-z0-9_]+/i, '')
    .replace(/-/g, '')
    .trim();
}

function parseDurationMs(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return 0;
  const m = t.match(/^(\d+)(s|sec|secs|segundo|segundos|m|min|mins|minuto|minutos|h|hr|hrs|hora|horas|d|dia|dias)?$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const u = String(m[2] || 'm').charAt(0);
  const mul = u === 's' ? 1000 : u === 'h' ? 3600000 : u === 'd' ? 86400000 : 60000;
  const ms = n * mul;
  const max = 7 * 86400000;
  return Math.min(ms, max);
}

function hmAt(ms, tz = 'America/Sao_Paulo') {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const p = Object.fromEntries(
    fmt.formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value])
  );
  return `${p.hour}:${p.minute}`;
}

function nextClockMs(hm) {
  const m = String(hm || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return 0;
  const want = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  const now = Date.now();
  for (let add = 1; add <= 24 * 60 + 1; add++) {
    const t = now + add * 60_000;
    if (hmAt(t) === want) return t;
  }
  return 0;
}

function parseScheduleSpec(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const clock = t.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const fireAt = nextClockMs(t);
    if (!fireAt) return null;
    const hm = `${String(parseInt(clock[1], 10)).padStart(2, '0')}:${clock[2]}`;
    return { kind: 'clock', fireAt, label: hm };
  }
  const ms = parseDurationMs(t);
  if (ms > 0) return { kind: 'delay', fireAt: Date.now() + ms, label: t };
  return null;
}

function formatWhen(fireAt) {
  const n = Number(fireAt) || 0;
  if (!n) return '?';
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    hour12: false
  });
  return fmt.format(new Date(n));
}

async function addTempBan(uid, groupJid, memberJid, restoreAt) {
  const owner = ownerKey(uid);
  const gid = String(groupJid || '');
  const jid = String(memberJid || '');
  const at = Number(restoreAt) || 0;
  if (!owner || !gid.endsWith('@g.us') || !jid || at <= Date.now()) return false;
  const { runAsync } = require('./sqlStore');
  await runAsync(
    `INSERT INTO group_temp_ban (owner_key, group_jid, member_jid, restore_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_key, group_jid, member_jid) DO UPDATE SET restore_at=excluded.restore_at`,
    [owner, gid, jid, at, new Date().toISOString()]
  );
  return true;
}

async function listDueTempBans(now = Date.now()) {
  const { allAsync } = require('./sqlStore');
  return allAsync(
    'SELECT owner_key, group_jid, member_jid, restore_at FROM group_temp_ban WHERE restore_at <= ? LIMIT 80',
    [Number(now) || Date.now()]
  );
}

async function removeTempBan(uid, groupJid, memberJid) {
  const { runAsync } = require('./sqlStore');
  await runAsync(
    'DELETE FROM group_temp_ban WHERE owner_key=? AND group_jid=? AND member_jid=?',
    [ownerKey(uid), String(groupJid || ''), String(memberJid || '')]
  );
}

async function upsertOnceSchedule(uid, groupJid, action, fireAt) {
  const owner = ownerKey(uid);
  const gid = String(groupJid || '');
  const act = action === 'open' ? 'open' : 'close';
  const at = Number(fireAt) || 0;
  if (!owner || !gid.endsWith('@g.us') || at <= Date.now()) return false;
  const { runAsync } = require('./sqlStore');
  await runAsync(
    `INSERT INTO group_once_schedule (owner_key, group_jid, action, fire_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_key, group_jid, action) DO UPDATE SET fire_at=excluded.fire_at, created_at=excluded.created_at`,
    [owner, gid, act, at, new Date().toISOString()]
  );
  return true;
}

async function listDueSchedules(now = Date.now()) {
  const { allAsync } = require('./sqlStore');
  return allAsync(
    'SELECT owner_key, group_jid, action, fire_at FROM group_once_schedule WHERE fire_at <= ? LIMIT 80',
    [Number(now) || Date.now()]
  );
}

async function removeOnceSchedule(uid, groupJid, action) {
  const { runAsync } = require('./sqlStore');
  await runAsync(
    'DELETE FROM group_once_schedule WHERE owner_key=? AND group_jid=? AND action=?',
    [ownerKey(uid), String(groupJid || ''), action === 'open' ? 'open' : 'close']
  );
}

function cacheSet(owner) {
  let s = blockedCache.get(owner);
  if (!s) {
    s = new Set();
    blockedCache.set(owner, s);
  }
  return s;
}

async function warmBlockedCmds() {
  try {
    const { allAsync } = require('./sqlStore');
    const rows = await allAsync('SELECT owner_key, cmd FROM session_blocked_cmds');
    blockedCache.clear();
    for (const r of rows || []) {
      const o = ownerKey(r.owner_key);
      const c = normCmd(r.cmd);
      if (o && c) cacheSet(o).add(c);
    }
    blockedWarmed = true;
  } catch (e) {
    logger.logAviso(`[groupMod] warm blocked: ${e.message}`);
  }
}

function isCmdBlocked(uid, commandName) {
  const owner = ownerKey(uid);
  const cmd = normCmd(commandName);
  if (!owner || !cmd || PROTECTED_CMDS.has(cmd)) return false;
  const s = blockedCache.get(owner);
  if (s) return s.has(cmd);
  return false;
}

function canBlockCmd(commandName) {
  const cmd = normCmd(commandName);
  if (!cmd || cmd.length < 2 || cmd.length > 40) return false;
  if (PROTECTED_CMDS.has(cmd)) return false;
  if (!/^[a-z0-9_]+$/.test(cmd)) return false;
  return true;
}

async function blockCmd(uid, commandName) {
  const owner = ownerKey(uid);
  const cmd = normCmd(commandName);
  if (!owner || !canBlockCmd(cmd)) return { ok: false, reason: 'protegido' };
  if (isCmdBlocked(owner, cmd)) return { ok: false, reason: 'ja' };
  const { runAsync } = require('./sqlStore');
  await runAsync(
    `INSERT OR IGNORE INTO session_blocked_cmds (owner_key, cmd, created_at) VALUES (?, ?, ?)`,
    [owner, cmd, new Date().toISOString()]
  );
  cacheSet(owner).add(cmd);
  return { ok: true, cmd };
}

async function unblockCmd(uid, commandName) {
  const owner = ownerKey(uid);
  const cmd = normCmd(commandName);
  if (!owner || !cmd) return { ok: false, reason: 'invalido' };
  const { runAsync } = require('./sqlStore');
  const r = await runAsync(
    'DELETE FROM session_blocked_cmds WHERE owner_key=? AND cmd=?',
    [owner, cmd]
  );
  cacheSet(owner).delete(cmd);
  return { ok: (r && r.changes) > 0, cmd };
}

async function listBlockedCmds(uid) {
  const owner = ownerKey(uid);
  if (!owner) return [];
  const s = blockedCache.get(owner);
  if (s && blockedWarmed) return [...s].sort();
  const { allAsync } = require('./sqlStore');
  const rows = await allAsync(
    'SELECT cmd FROM session_blocked_cmds WHERE owner_key=? ORDER BY cmd',
    [owner]
  );
  const cmds = (rows || []).map((r) => normCmd(r.cmd)).filter(Boolean);
  const set = cacheSet(owner);
  set.clear();
  for (const c of cmds) set.add(c);
  return cmds;
}

async function getJoinAuto(uid, groupJid) {
  const { getAsync } = require('./sqlStore');
  const row = await getAsync(
    'SELECT cooldown_sec, last_apply FROM group_join_auto WHERE owner_key=? AND group_jid=?',
    [ownerKey(uid), String(groupJid || '')]
  );
  return {
    cooldown_sec: Math.max(0, Number(row && row.cooldown_sec) || 10),
    last_apply: Number(row && row.last_apply) || 0
  };
}

async function setJoinAutoCooldown(uid, groupJid, sec) {
  const owner = ownerKey(uid);
  const gid = String(groupJid || '');
  const n = Math.max(0, Math.min(86400, Number(sec) || 0));
  if (!owner || !gid.endsWith('@g.us')) return 10;
  const { runAsync } = require('./sqlStore');
  const prev = await getJoinAuto(owner, gid);
  await runAsync(
    `INSERT INTO group_join_auto (owner_key, group_jid, cooldown_sec, last_apply)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_key, group_jid) DO UPDATE SET cooldown_sec=excluded.cooldown_sec`,
    [owner, gid, n, prev.last_apply || 0]
  );
  return n;
}

async function canJoinAutoNow(uid, groupJid) {
  const rec = await getJoinAuto(uid, groupJid);
  const wait = rec.cooldown_sec * 1000;
  if (wait > 0 && rec.last_apply && Date.now() - rec.last_apply < wait) return false;
  return true;
}

async function touchJoinAuto(uid, groupJid) {
  const owner = ownerKey(uid);
  const gid = String(groupJid || '');
  if (!owner || !gid) return;
  const { runAsync } = require('./sqlStore');
  const rec = await getJoinAuto(owner, gid);
  await runAsync(
    `INSERT INTO group_join_auto (owner_key, group_jid, cooldown_sec, last_apply)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_key, group_jid) DO UPDATE SET last_apply=excluded.last_apply`,
    [owner, gid, rec.cooldown_sec || 10, Date.now()]
  );
}

async function getPvNotice(uid) {
  const owner = ownerKey(uid);
  if (!owner) return '';
  if (pvNoticeCache.has(owner)) return pvNoticeCache.get(owner) || '';
  try {
    const { getKv } = require('./sqlStore');
    const v = String((await getKv('session', `pv_notice_${owner}`)) || '').trim();
    pvNoticeCache.set(owner, v);
    return v;
  } catch (_) {
    return '';
  }
}

async function setPvNotice(uid, text) {
  const owner = ownerKey(uid);
  if (!owner) return '';
  const v = String(text || '').trim().slice(0, 400);
  const { upsertKvAsync } = require('./sqlStore');
  if (!v) {
    await upsertKvAsync('session', `pv_notice_${owner}`, '');
    pvNoticeCache.set(owner, '');
    return '';
  }
  await upsertKvAsync('session', `pv_notice_${owner}`, v);
  pvNoticeCache.set(owner, v);
  return v;
}

module.exports = {
  PROTECTED_CMDS,
  parseDurationMs,
  parseScheduleSpec,
  formatWhen,
  hmAt,
  nextClockMs,
  addTempBan,
  listDueTempBans,
  removeTempBan,
  upsertOnceSchedule,
  listDueSchedules,
  removeOnceSchedule,
  warmBlockedCmds,
  isCmdBlocked,
  canBlockCmd,
  blockCmd,
  unblockCmd,
  listBlockedCmds,
  getJoinAuto,
  setJoinAutoCooldown,
  canJoinAutoNow,
  touchJoinAuto,
  getPvNotice,
  setPvNotice,
  normCmd
};
