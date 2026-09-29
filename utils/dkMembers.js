'use strict';
/**
 * Membros live do grupo pra mencao do DK.
 * Meta via Baileys (groupMetadata), sem peek/cache.
 * Admin: flag live + isGroupAdminStrict (fail-closed). NUNCA isGroupAdminOrBot (fail-open esvazia a lista).
 */
const logger = require('../logger');

function partIds(p) {
  return [p?.id, p?.jid, p?.lid, p?.phoneNumber].filter(Boolean).map(String);
}

function isAdminFlag(p) {
  if (!p || typeof p !== 'object') return false;
  const a = p.admin;
  if (a === true || a === 1) return true;
  const s = String(a || '').toLowerCase();
  return s === 'admin' || s === 'superadmin' || s === 'owner' || s === 'super_admin';
}

function botIdSet(conn) {
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
  const u = conn?.user || {};
  add(u.id);
  add(u.lid);
  add(u.jid);
  add(u.phoneNumber);
  return ids;
}

function isBotPart(p, botIds) {
  return partIds(p).some((id) => {
    if (botIds.has(id)) return true;
    const user = String(id).split('@')[0].split(':')[0];
    return !!(user && (botIds.has(`${user}@s.whatsapp.net`) || botIds.has(`${user}@lid`)));
  });
}

function mentionOf(p) {
  const id = String(p?.id || p?.jid || '').trim();
  if (id && !/@g\.us$|@newsletter$/.test(id)) return id;
  const d = String(p?.phoneNumber || '').replace(/\D/g, '');
  if (d.length >= 10 && d.length <= 15) return `${d}@s.whatsapp.net`;
  return '';
}

/**
 * Filtro sincrono so pela flag live (teste / fallback).
 * Nao usa cache. Admin flag = fora da mencao.
 */
function classifyFromParts(parts, botIds) {
  const list = Array.isArray(parts) ? parts : [];
  let adminN = 0;
  let skippedBot = 0;
  const mentions = [];
  for (const p of list) {
    if (!p) continue;
    if (isBotPart(p, botIds || new Set())) {
      skippedBot += 1;
      continue;
    }
    if (isAdminFlag(p)) {
      adminN += 1;
      continue;
    }
    const m = mentionOf(p);
    if (m) mentions.push(m);
  }
  return {
    mentions: [...new Set(mentions)],
    adminN,
    total: list.length,
    skippedBot
  };
}

async function liveGroupMeta(conn, groupJid) {
  if (!conn || typeof conn.groupMetadata !== 'function') {
    throw new Error('groupMetadata indisponivel');
  }
  return conn.groupMetadata(groupJid);
}

/**
 * @returns {{ mentions: string[], adminN: number, total: number, skippedBot: number }}
 */
async function listNonAdminMentions(conn, groupJid) {
  const meta = await liveGroupMeta(conn, groupJid);
  const parts = Array.isArray(meta?.participants) ? meta.participants : [];
  const botIds = botIdSet(conn);
  let adminN = 0;
  let skippedBot = 0;
  const mentions = [];
  const { isGroupAdminStrict } = require('./moderation');

  for (const p of parts) {
    if (!p) continue;
    if (isBotPart(p, botIds)) {
      skippedBot += 1;
      continue;
    }
    const ids = partIds(p);
    let adm = isAdminFlag(p);
    if (!adm) {
      try {
        adm = await isGroupAdminStrict(conn, groupJid, ids[0], ids.slice(1));
      } catch (e) {
        logger.logAviso(`[dk] admin-strict: ${e.message}`);
        adm = false;
      }
    }
    if (adm) {
      adminN += 1;
      continue;
    }
    const m = mentionOf(p);
    if (m) mentions.push(m);
  }

  const uniq = [...new Set(mentions)];
  logger.logInfo(
    `[dk] mencoes group total=${parts.length} members=${uniq.length} adminSkip=${adminN} botSkip=${skippedBot}`
  );
  if (!uniq.length) {
    logger.logAviso(
      `[dk] lista de mencao vazia total=${parts.length} adminSkip=${adminN} — pagamento segue sem marcar ninguem`
    );
  }
  return { mentions: uniq, adminN, total: parts.length, skippedBot };
}

module.exports = {
  listNonAdminMentions,
  liveGroupMeta,
  isAdminFlag,
  mentionOf,
  classifyFromParts
};
