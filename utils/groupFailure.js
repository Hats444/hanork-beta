'use strict';
/**
 * Fonte unica: grupo de divulgacao morreu ou a falha e so transitória.
 * dead = 1 ocorrencia ja retira. transient = acumula ate TRANSIENT_FAIL_LIMIT.
 */

const TRANSIENT_FAIL_LIMIT = 5;

const TRANSIENT_RE =
  /rate-overlimit|\boverlimit\b|timeout:\s*groupmetadata|timed?\s*out|etimedout|econnreset|econnrefused|connection closed|socket hang|backoff|iq-cap|group_meta_backoff|group_meta_cap|group_meta_stale|\b428\b/i;

const DEAD_RE =
  /not-authorized|forbidden|item-not-found|not-participant|not-in-group|not a participant|anunci[oa]|announcement|only.?admins?|so.?admin|sem permissao|banid|banned|locked.?group|group.?gone|no longer|\bgone\b|\b404\b|\b403\b|restricted|can'?t send|cannot send|not allowed to send|permission.?denied|nao (pode|consegue) envi/i;

function blobOf(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  const msg = error.message || error.msg || '';
  const code = error.code || error.output?.statusCode || error.status || '';
  const data = error.data || error.output?.payload || '';
  return `${msg} ${code} ${data}`;
}

function pickDeadReason(blob) {
  const s = String(blob || '').toLowerCase();
  if (/anunci|announcement|only.?admins?|so.?admin/.test(s)) return 'announce_no_admin';
  if (/not-participant|not-in-group|not a participant|banid|banned/.test(s)) return 'bot_removed';
  if (/item-not-found|group.?gone|no longer|\bgone\b|\b404\b/.test(s)) return 'group_gone';
  if (/not-authorized|forbidden|\b403\b|restricted|sem permissao|permission|can'?t send|cannot send|not allowed/.test(s)) {
    return 'no_send_permission';
  }
  if (/locked.?group/.test(s)) return 'group_locked';
  return 'dead';
}

function pickTransientReason(blob, code) {
  const s = `${blob || ''} ${code || ''}`.toLowerCase();
  if (/rate-overlimit|\boverlimit\b/.test(s)) return 'rate_overlimit';
  if (/timeout|timed?\s*out|etimedout/.test(s)) return 'timeout';
  if (/connection closed|econnreset|socket/.test(s)) return 'connection';
  if (/backoff|iq-cap|group_meta_/.test(s)) return 'meta_backoff';
  return 'transient';
}

function isAnnounceOn(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const a = meta.announce;
  if (a === true || a === 1) return true;
  const s = String(a == null ? '' : a).toLowerCase();
  return s === 'true' || s === 'announcement' || s === 'on' || s === 'admins';
}

function collectBotIds(conn) {
  const ids = new Set();
  const add = (jid) => {
    if (!jid || typeof jid !== 'string') return;
    ids.add(jid);
    const user = jid.split('@')[0].split(':')[0];
    if (user) {
      ids.add(`${user}@s.whatsapp.net`);
      ids.add(`${user}@lid`);
    }
  };
  const u = conn && conn.user;
  if (u) {
    add(u.id);
    add(u.lid);
    add(u.jid);
    add(u.phoneNumber);
  }
  return ids;
}

function participantIds(p) {
  if (p == null) return [];
  if (typeof p === 'string') return [p];
  return [p.id, p.jid, p.lid, p.phoneNumber, p.participant].filter(Boolean).map(String);
}

function isBotParticipant(p, botIds) {
  const set = botIds instanceof Set ? botIds : new Set(botIds || []);
  return participantIds(p).some((id) => {
    if (set.has(id)) return true;
    const user = String(id).split('@')[0].split(':')[0];
    return !!(user && (set.has(`${user}@s.whatsapp.net`) || set.has(`${user}@lid`)));
  });
}

function isGroupAdminPart(p) {
  if (!p || typeof p !== 'object') return false;
  const a = p.admin;
  if (a === true || a === 1) return true;
  const s = String(a || '').toLowerCase();
  if (!s || s === 'member' || s === 'participant' || s === 'null' || s === 'false' || s === '0') return false;
  if (s === 'admin' || s === 'superadmin' || s === 'owner' || s === 'super_admin') return true;
  return !!(p.isAdmin || p.isSuperAdmin);
}

function isBotAdminInMeta(conn, meta) {
  const parts = (meta && meta.participants) || [];
  const botIds = collectBotIds(conn);
  if (!botIds.size) return false;
  return parts.some((p) => isBotParticipant(p, botIds) && isGroupAdminPart(p));
}

function botListedInMeta(conn, meta) {
  const parts = (meta && meta.participants) || [];
  const botIds = collectBotIds(conn);
  if (!botIds.size) return false;
  return parts.some((p) => isBotParticipant(p, botIds));
}

/**
 * @param {Error|string|null} error
 * @param {{ kind?: string, botRemoved?: boolean, announce?: boolean, botIsAdmin?: boolean }} [context]
 * @returns {{ kind: 'dead'|'transient'|'ok', reason: string }}
 */
function classifyGroupFailure(error, context) {
  const ctx = context && typeof context === 'object' ? context : {};
  if (ctx.botRemoved || ctx.kind === 'bot_removed') {
    return { kind: 'dead', reason: 'bot_removed' };
  }
  if (ctx.kind === 'announce_no_admin' || (ctx.announce && ctx.botIsAdmin === false)) {
    return { kind: 'dead', reason: 'announce_no_admin' };
  }
  if (ctx.kind === 'manual_leave') {
    return { kind: 'dead', reason: 'manual_leave' };
  }
  const raw = blobOf(error);
  const code = error && typeof error === 'object' ? String(error.code || '') : '';
  const blob = `${raw} ${code}`.trim();
  if (!blob) return { kind: 'ok', reason: 'empty' };

  const deadHit = DEAD_RE.test(blob);
  const transHit = TRANSIENT_RE.test(blob) || /GROUP_META_BACKOFF|GROUP_META_CAP|GROUP_META_STALE/i.test(code);

  if (deadHit) return { kind: 'dead', reason: pickDeadReason(blob) };
  if (transHit) return { kind: 'transient', reason: pickTransientReason(blob, code) };
  return { kind: 'transient', reason: 'unknown' };
}

function inspectGroupHealth(conn, groupJid, meta) {
  let peeked = null;
  try {
    peeked = require('./groupMetaCache').peekGroupMetadata(groupJid);
  } catch (_) {
    peeked = null;
  }
  const m = meta
    ? { ...peeked, ...meta, participants: (peeked && peeked.participants) || meta.participants }
    : peeked;
  if (!m) return { kind: 'ok', reason: 'no-meta' };
  if (!isAnnounceOn(m)) return { kind: 'ok', reason: 'open' };
  if (isBotAdminInMeta(conn, m)) return { kind: 'ok', reason: 'announce_bot_admin' };
  const parts = Array.isArray(m.participants) ? m.participants : [];
  if (!parts.length) return { kind: 'ok', reason: 'announce_unknown_role' };
  if (!botListedInMeta(conn, m)) return { kind: 'ok', reason: 'announce_bot_missing' };
  return { kind: 'dead', reason: 'announce_no_admin' };
}

function participantsIncludeBot(conn, update) {
  const people = (update && update.participants) || [];
  const botIds = collectBotIds(conn);
  if (!botIds.size) return false;
  return people.some((p) => isBotParticipant(p, botIds));
}

module.exports = {
  TRANSIENT_FAIL_LIMIT,
  classifyGroupFailure,
  inspectGroupHealth,
  isAnnounceOn,
  collectBotIds,
  isBotParticipant,
  isBotAdminInMeta,
  botListedInMeta,
  participantsIncludeBot,
  isGroupAdminPart
};
