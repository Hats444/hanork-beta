'use strict';
/**
 * Canal WhatsApp (@newsletter) nao e PV.
 * Comandos no canal so pra admin/dono do canal (e dono da sessao).
 */

function isChannelJid(jid) {
  const s = String(jid || '');
  return s.endsWith('@newsletter');
}

function isPrivateJid(jid) {
  const s = String(jid || '');
  if (!s) return false;
  if (s.endsWith('@g.us') || isChannelJid(s)) return false;
  if (s.endsWith('@broadcast') || s === 'status@broadcast') return false;
  return true;
}

function collectSenderIds(ctx) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  push(ctx?.sender);
  push(ctx?.senderAlt);
  const k = ctx?.info?.key || ctx?.key || {};
  push(k.participant);
  push(k.participantAlt);
  push(k.participantPn);
  push(k.senderPn);
  return out;
}

function idsOverlap(a, b) {
  const A = String(a || '').replace(/:\d+(?=@)/, '').toLowerCase();
  const B = String(b || '').replace(/:\d+(?=@)/, '').toLowerCase();
  if (!A || !B) return false;
  if (A === B) return true;
  const ua = A.split('@')[0];
  const ub = B.split('@')[0];
  return ua.length > 6 && ua === ub;
}

async function senderIsChannelAdmin(conn, ctx) {
  if (!ctx || !isChannelJid(ctx.from)) return false;
  if (ctx.isOwner || ctx.fromMe) return true;
  const key = ctx.info?.key || ctx.key || {};
  const role = String(key.participantRole || key.newsletterAdminRole || key.role || '').toLowerCase();
  if (['admin', 'owner', 'superadmin', 'admin_role', 'administrator'].includes(role)) return true;
  if (key.newsletterAdmin === true || key.isNewsletterAdmin === true) return true;

  const senders = collectSenderIds(ctx);
  try {
    if (conn && typeof conn.newsletterMetadata === 'function') {
      const meta = await conn.newsletterMetadata('jid', ctx.from);
      const viewer = String(
        meta?.viewer_metadata?.role || meta?.viewer_metadata?.role || ''
      ).toUpperCase();
      // viewer = papel do BOT no canal, nao do remetente
      const bag = meta?.thread_metadata || meta?.thread_metadata || meta || {};
      const admins = []
        .concat(bag.admins || [])
        .concat(meta?.admins || [])
        .concat(bag.adminJids || []);
      for (const a of admins) {
        const id = typeof a === 'string' ? a : (a?.id || a?.jid || a?.phoneNumber || '');
        if (senders.some((s) => idsOverlap(s, id))) return true;
      }
      // No canal so admin posta. Se o bot e admin/dono, quem mandou msg e admin.
      if (viewer === 'ADMIN' || viewer === 'OWNER' || viewer === 'ADMINISTRATOR') {
        return true;
      }
    }
  } catch (_) { /* meta opcional */ }
  return false;
}

function isWaChannel(ctx) {
  if (!ctx) return false;
  if (ctx.isChannel) return true;
  return isChannelJid(ctx.from) || isChannelJid(ctx.inboundJid);
}

module.exports = {
  isChannelJid,
  isPrivateJid,
  senderIsChannelAdmin,
  collectSenderIds,
  isWaChannel
};
