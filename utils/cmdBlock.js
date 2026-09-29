'use strict';
/**
 * Bloqueio de COMANDOS do bot (nao e block do WhatsApp).
 * Guarda LID + JID + digitos pra casar a mesma pessoa nos dois modos.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { ensureJidString } = require('../utils');
const { parsePhoneAndQty } = require('./phoneTarget');
const { sameParticipant, participantKeys } = require('./moderation');
const { getOwners } = require('./configManager');
const { matchesAuthorizedEntry } = require('./authorization');
const { getUserDir } = require('./userManager');

function jsonPath(telegramUserId) {
  return path.join(getUserDir(telegramUserId), 'config', 'cmdblock.json');
}

function loadList(telegramUserId) {
  const uid = String(telegramUserId || '');
  if (!uid) return [];
  try {
    const store = require('./sqlStore');
    if (store.isReady()) {
      const hit = store.getCachedKv('cmdblock', uid);
      if (Array.isArray(hit)) return hit;
    }
  } catch (_) { /* JSON */ }
  try {
    const p = jsonPath(uid);
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const list = Array.isArray(parsed) ? parsed : [];
      try { require('./sqlStore').upsertKv('cmdblock', uid, list); } catch (_) { /* */ }
      return list;
    }
  } catch (e) {
    logger.logAviso(`[CMDBLOCK] load: ${e.message}`);
  }
  return [];
}

function saveList(telegramUserId, list) {
  const uid = String(telegramUserId || '');
  const arr = Array.isArray(list) ? list : [];
  try { require('./sqlStore').upsertKv('cmdblock', uid, arr); } catch (_) { /* */ }
  try {
    const p = jsonPath(uid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (e) {
    logger.logAviso(`[CMDBLOCK] save json: ${e.message}`);
  }
  return true;
}

function pushId(out, seen, raw) {
  const s = ensureJidString(raw, String(raw || '').trim());
  if (!s || seen.has(s)) return;
  if (s.endsWith('@g.us') || s.endsWith('@newsletter') || s === 'status@broadcast') return;
  seen.add(s);
  out.push(s);
}

function expandIdentities(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids || []) {
    pushId(out, seen, raw);
  }
  const extra = [];
  for (const s of out) {
    try {
      for (const k of participantKeys(s)) pushId(extra, seen, k);
    } catch (_) { /* */ }
  }
  return out.concat(extra);
}

function collectTargetIdentities(ctx) {
  const raw = [];
  const info = ctx?.info || ctx?.raw || null;
  const msg = info?.message || ctx?.message || {};
  const cinfo =
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.stickerMessage?.contextInfo ||
    {};

  for (const m of cinfo.mentionedJid || []) raw.push(m);
  for (const m of ctx?.mentionedJid || []) raw.push(m);
  raw.push(cinfo.participant, cinfo.participantAlt);
  raw.push(ctx?.quoted?.participant, ctx?.quoted?.participantAlt, ctx?.quoted?.sender);
  raw.push(ctx?.quoted?.key?.participant, ctx?.quoted?.key?.participantAlt);

  const text = String(ctx?.text || ctx?.args?.[0] || '').trim();
  if (text) {
    const jidHit = text.match(/(\S+@(?:s\.whatsapp\.net|lid|c\.us))/i);
    if (jidHit) raw.push(jidHit[1]);
    try {
      const parsed = parsePhoneAndQty(text);
      if (parsed?.jid) raw.push(parsed.jid);
      if (parsed?.digits && String(parsed.digits).length >= 8) {
        raw.push(`${parsed.digits}@s.whatsapp.net`);
        raw.push(parsed.digits);
      }
    } catch (_) { /* */ }
    const at = text.match(/@(\d{8,})/);
    if (at) raw.push(`${at[1]}@s.whatsapp.net`);
  }
  return expandIdentities(raw);
}

function collectSenderIdentities(ctx) {
  return expandIdentities([
    ctx?.sender,
    ctx?.senderAlt,
    ctx?.key?.participant,
    ctx?.key?.participantAlt,
    ctx?.info?.key?.participant,
    ctx?.info?.key?.participantAlt,
    ctx?.info?.key?.remoteJidAlt
  ]);
}

function identitiesMatch(aList, bList) {
  for (const a of aList || []) {
    for (const b of bList || []) {
      if (!a || !b) continue;
      if (String(a) === String(b)) return true;
      try {
        if (sameParticipant(a, b)) return true;
      } catch (_) { /* */ }
    }
  }
  return false;
}

function isOwnerIdentity(telegramUserId, ids) {
  const owners = getOwners(telegramUserId) || [];
  if (!owners.length) return false;
  return (ids || []).some((id) =>
    owners.some((o) => {
      try {
        return matchesAuthorizedEntry(id, o) || sameParticipant(id, o);
      } catch (_) {
        return String(id) === String(o);
      }
    })
  );
}

function isCmdBlocked(telegramUserId, ctxOrIds) {
  const list = loadList(telegramUserId);
  if (!list.length) return false;
  const ids = Array.isArray(ctxOrIds) ? expandIdentities(ctxOrIds) : collectSenderIdentities(ctxOrIds);
  if (!ids.length) return false;
  if (isOwnerIdentity(telegramUserId, ids)) return false;
  for (const entry of list) {
    const stored = Array.isArray(entry?.ids) ? entry.ids : [];
    if (identitiesMatch(ids, stored)) return true;
  }
  return false;
}

function blockUser(telegramUserId, ids) {
  const norm = expandIdentities(ids);
  if (!norm.length) return { ok: false, reason: 'alvo_invalido' };
  if (isOwnerIdentity(telegramUserId, norm)) return { ok: false, reason: 'nao_bloqueia_dono' };
  const list = loadList(telegramUserId);
  const hit = list.findIndex((e) => identitiesMatch(norm, e.ids || []));
  if (hit >= 0) {
    const merged = expandIdentities([...(list[hit].ids || []), ...norm]);
    list[hit] = { ids: merged, at: list[hit].at || Date.now() };
    saveList(telegramUserId, list);
    return { ok: true, already: true, ids: merged };
  }
  const entry = { ids: norm, at: Date.now() };
  list.push(entry);
  saveList(telegramUserId, list);
  logger.logInfo(`[CMDBLOCK] +${norm[0]} total=${list.length}`);
  return { ok: true, already: false, ids: norm };
}

function unblockUser(telegramUserId, ids) {
  const norm = expandIdentities(ids);
  if (!norm.length) return { ok: false, reason: 'alvo_invalido' };
  const list = loadList(telegramUserId);
  const next = list.filter((e) => !identitiesMatch(norm, e.ids || []));
  if (next.length === list.length) return { ok: false, reason: 'nao_estava' };
  saveList(telegramUserId, next);
  logger.logInfo(`[CMDBLOCK] -${norm[0]} total=${next.length}`);
  return { ok: true, ids: norm };
}

function unblockByIndex(telegramUserId, index1) {
  const list = loadList(telegramUserId);
  const i = Number(index1) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= list.length) {
    return { ok: false, reason: 'indice' };
  }
  const removed = list[i];
  const next = list.filter((_, j) => j !== i);
  saveList(telegramUserId, next);
  logger.logInfo(`[CMDBLOCK] -idx${index1} total=${next.length}`);
  return { ok: true, ids: removed?.ids || [] };
}

function unblockAll(telegramUserId) {
  const list = loadList(telegramUserId);
  if (!list.length) return { ok: false, reason: 'vazio' };
  saveList(telegramUserId, []);
  logger.logInfo(`[CMDBLOCK] clear n=${list.length}`);
  return { ok: true, count: list.length };
}

function listBlocked(telegramUserId) {
  return loadList(telegramUserId);
}

function maskId(id) {
  const s = String(id || '');
  if (s.includes('@lid')) return `lid…${s.slice(-8)}`;
  const d = s.replace(/\D/g, '');
  if (d.length >= 6) return `…${d.slice(-4)}`;
  return s.slice(0, 18);
}

async function enrichFromGroup(conn, groupId, ids) {
  if (!conn || !groupId || !String(groupId).endsWith('@g.us') || !ids?.length) return ids;
  try {
    const { getCachedGroupMetadata } = require('./groupMetaCache');
    const meta = await getCachedGroupMetadata(conn, groupId);
    const extra = [...ids];
    for (const p of meta.participants || []) {
      const pids = [p.id, p.phoneNumber, p.jid, p.lid].filter(Boolean);
      if (identitiesMatch(ids, pids)) extra.push(...pids);
    }
    return expandIdentities(extra);
  } catch (_) {
    return ids;
  }
}

module.exports = {
  collectTargetIdentities,
  collectSenderIdentities,
  isCmdBlocked,
  blockUser,
  unblockUser,
  unblockByIndex,
  unblockAll,
  listBlocked,
  maskId,
  enrichFromGroup,
  expandIdentities
};
