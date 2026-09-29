'use strict';
/**
 * Fonte unica de DECISAO de permissao.
 * Nao substitui resolucao de identidade (LID/PN) — so quem-pode-o-que.
 *
 * Hierarquia:
 *   platform_admin > owner > (vip | adm) > user
 *
 * VIP e ADM sao pares em ALVO (canTarget). Em USO de comando:
 *   vip sozinho = user+vip
 *   vip + admin nativo DESTE grupo = user+vip+adm (nao owner)
 *   adm sozinho = user+adm (nunca vip/owner)
 *
 * Duas perguntas, nunca misturar:
 *   canUseCommand(role, minRole, opts)  — pode USAR o comando?
 *   canTarget(actor, target)            — pode AGIR sobre essa pessoa?
 */
const logger = require('../logger');

const RANK = Object.freeze({
  platform_admin: 4,
  owner: 3,
  vip: 2,
  adm: 2,
  user: 0
});

const ROLE_ORDER = Object.freeze(['platform_admin', 'owner', 'vip', 'adm', 'user']);

function isValidRole(role) {
  return Object.prototype.hasOwnProperty.call(RANK, role);
}

function normalizeRole(role) {
  if (role === 'group_admin') return 'adm';
  if (isValidRole(role)) return role;
  return 'user';
}

/**
 * Pode o papel A usar um comando cujo min_role e B?
 * owner usa tudo menos platform_admin.
 * vip sozinho: user+vip. vip + opts.isGroupAdmin (admin nativo DESTE @g.us): tambem adm.
 * adm: user+adm. Nunca vip, owner nem platform_admin.
 * opts.isGroupAdmin NAO vira dono e NAO muda canTarget.
 */
function canUseCommand(actorRole, commandMinRole, opts = {}) {
  const actor = normalizeRole(actorRole);
  const need = normalizeRole(commandMinRole);
  if (!isValidRole(actor) || !isValidRole(need)) return false;
  if (actor === 'platform_admin') return true;
  if (actor === 'owner') return need !== 'platform_admin';
  if (actor === 'vip') {
    if (need === 'vip' || need === 'user') return true;
    if (need === 'adm' && opts && opts.isGroupAdmin) return true;
    return false;
  }
  if (actor === 'adm') return need === 'adm' || need === 'user';
  if (actor === 'user') return need === 'user';
  return false;
}

/**
 * Imunidade a acao targeted (ban/kick/mute/promote/addvip/nuke em alguem).
 * owner imune a vip/adm; vip imune a adm; adm so afeta user; owner afeta vip e adm.
 */
function canTarget(actorRole, targetRole) {
  const actor = normalizeRole(actorRole);
  const target = normalizeRole(targetRole);
  if (!isValidRole(actor) || !isValidRole(target)) return false;
  if (actor === 'platform_admin') return true;
  if (actor === 'owner') return target !== 'platform_admin' && target !== 'owner';
  if (actor === 'vip') return target === 'user';
  if (actor === 'adm') return target === 'user';
  return false;
}

function logAudit(row) {
  try {
    const sql = require('./sqlStore');
    if (typeof sql.insertCommandAudit === 'function') sql.insertCommandAudit(row);
  } catch (_) { /* sql opcional */ }
}

/**
 * Papel efetivo no momento da acao. Nao confia em ctx.isOwner velho.
 * Fail-closed: erro / identidade ambigua = user.
 */
function actorRoleFromCtx(ctx) {
  if (!ctx) return 'user';
  try {
    const { sessionRole } = require('./commandGate');
    const role = sessionRole(ctx);
    if (role === 'platform_admin' || role === 'owner' || role === 'vip') return role;
  } catch (_) { /* */ }
  try {
    const { isGroupAdminActor } = require('./commandGate');
    if (isGroupAdminActor(ctx)) return 'adm';
  } catch (_) { /* */ }
  const tagged = normalizeRole(ctx.authRole);
  if (tagged === 'adm') return 'adm';
  return 'user';
}

function resolveTargetRole(conn, ctx, targetJid) {
  const jid = String(targetJid || '').trim();
  if (!jid) return 'user';
  try {
    const { checkAuthorization, isConnSelfIdentity } = require('./authorization');
    if (isConnSelfIdentity(jid, [jid], conn || ctx?.conn)) return 'owner';
    const tid = String(ctx?.telegramUserId || conn?._telegramUserId || '');
    if (tid) {
      const auth = checkAuthorization(jid, tid, false, [jid], conn || ctx?.conn);
      if (auth.role === 'platform_admin' || auth.role === 'owner') return 'owner';
      if (auth.role === 'vip') return 'vip';
    }
  } catch (_) { /* fail-closed abaixo */ }
  const groupJid = ctx?.from || ctx?.groupJid || '';
  if (ctx?.isGroup && /@g\.us$/i.test(String(groupJid))) {
    try {
      const { peekGroupMetadata } = require('./groupMetaCache');
      const { isWaAdminInMeta } = require('./protectionStore');
      const meta = peekGroupMetadata(groupJid);
      if (meta && isWaAdminInMeta(meta, jid, [])) return 'adm';
    } catch (_) { /* meta opcional */ }
  }
  return 'user';
}

async function resolveTargetRoleLive(conn, ctx, targetJid) {
  const sync = resolveTargetRole(conn, ctx, targetJid);
  if (sync !== 'user') return sync;
  const jid = String(targetJid || '').trim();
  const groupJid = ctx?.from || ctx?.groupJid || '';
  if (!jid || !ctx?.isGroup || !/@g\.us$/i.test(String(groupJid))) return sync;
  try {
    const { getSecurityGroupMetadata, peekMetaStamp } = require('./groupMetaCache');
    const { isWaAdminInMeta } = require('./protectionStore');
    let meta = null;
    try {
      meta = await getSecurityGroupMetadata(conn, groupJid);
    } catch (_) {
      meta = null;
    }
    if (meta && isWaAdminInMeta(meta, jid, [])) return 'adm';
    const stamp = typeof peekMetaStamp === 'function' ? peekMetaStamp(groupJid) : null;
    if (!stamp || !stamp.fresh) return 'adm';
  } catch (_) {
    return 'adm';
  }
  return 'user';
}

/**
 * Pode o ator agir sobre este JID? Sempre resolve o alvo de novo.
 * Se nao conseguir resolver e o ator nao for owner/platform_admin, nega.
 */
function isActorSelf(ctx, targetJid, conn) {
  if (!targetJid) return false;
  try {
    const { matchesAuthorizedEntry, isConnSelfIdentity, resolveCanonicalIdentity } = require('./authorization');
    const ids = resolveCanonicalIdentity(ctx?.sender, ctx) || [];
    if (ids.some((id) => matchesAuthorizedEntry(id, targetJid))) return true;
    if (matchesAuthorizedEntry(ctx?.sender, targetJid)) return true;
    if (isConnSelfIdentity(targetJid, ids, conn || ctx?.conn)) {
      return isConnSelfIdentity(ctx?.sender, ids, conn || ctx?.conn);
    }
  } catch (_) { /* */ }
  return String(ctx?.sender || '') === String(targetJid);
}

function collectPersonTargets(ctx) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (s.endsWith('@g.us') || s.endsWith('@newsletter') || s.endsWith('@broadcast')) return;
    if (
      !s.includes('@s.whatsapp.net') &&
      !s.includes('@lid') &&
      !s.includes('@c.us')
    ) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  const q = ctx?.quoted || {};
  push(q.sender);
  push(q.participant);
  push(q.participantPn);
  push(q.participantAlt);
  push(q.key?.participant);
  push(q.key?.participantPn);
  push(ctx?.quotedParticipant);
  const mentions = ctx?.mentions || ctx?.mentionedJid || [];
  for (const m of mentions) push(m);
  try {
    const raw = ctx?.info?.message || ctx?.message || ctx?.raw?.message || {};
    const infos = [
      raw.extendedTextMessage?.contextInfo,
      raw.imageMessage?.contextInfo,
      raw.videoMessage?.contextInfo,
      raw.stickerMessage?.contextInfo,
      raw.documentMessage?.contextInfo
    ];
    for (const ci of infos) {
      if (!ci) continue;
      push(ci.participant);
      push(ci.participantPn);
      push(ci.participantAlt);
      for (const m of ci.mentionedJid || []) push(m);
    }
  } catch (_) { /* */ }
  const text = String(ctx?.text || ctx?.q || (ctx?.args || []).join(' ') || '');
  for (const tok of text.split(/\s+/)) {
    if (tok.includes('@')) push(tok.replace(/[<>]/g, ''));
    const d = tok.replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 15 && !/[a-z]/i.test(tok)) {
      push(`${d}@s.whatsapp.net`);
    }
  }
  return out;
}

/**
 * Qualquer comando que aponte pra uma pessoa (mencao, reply, numero).
 * VIP/user/adm nao fazem nada no dono nem no chip — silencioso.
 */
function guardPersonTargets(conn, ctx, commandName) {
  const actor = actorRoleFromCtx(ctx);
  if (actor === 'platform_admin') return { allowed: true, actorRole: actor };
  const targets = collectPersonTargets(ctx);
  if (!targets.length) return { allowed: true, actorRole: actor };
  if (ctx && commandName) ctx.command = ctx.command || commandName;
  for (const jid of targets) {
    if (isActorSelf(ctx, jid, conn)) continue;
    const r = checkTargetAction(conn, ctx, jid);
    if (!r.allowed) {
      if (ctx) ctx._hanorkTargetImmune = true;
      return r;
    }
  }
  return { allowed: true, actorRole: actor };
}

function checkTargetAction(conn, ctx, targetJid) {
  const actorRole = actorRoleFromCtx(ctx);
  const targetRole = resolveTargetRole(conn, ctx, targetJid);
  let allowed = canTarget(actorRole, targetRole);
  if (!targetJid && actorRole !== 'owner' && actorRole !== 'platform_admin') {
    allowed = false;
  }
  logAudit({
    sessionId: ctx?.sessionId || conn?._sessionId || '',
    platform: ctx?.platform || (ctx?.isTelegram ? 'telegram' : 'whatsapp'),
    command: ctx?.command || 'target',
    actorRole,
    targetRole,
    groupJid: ctx?.from || ctx?.groupJid || '',
    allowed,
    denyReason: allowed ? null : 'alvo imune'
  });
  return { allowed, actorRole, targetRole };
}

async function checkTargetActionLive(conn, ctx, targetJid) {
  const actorRole = actorRoleFromCtx(ctx);
  const targetRole = await resolveTargetRoleLive(conn, ctx, targetJid);
  let allowed = canTarget(actorRole, targetRole);
  if (!targetJid && actorRole !== 'owner' && actorRole !== 'platform_admin') {
    allowed = false;
  }
  logAudit({
    sessionId: ctx?.sessionId || conn?._sessionId || '',
    platform: ctx?.platform || (ctx?.isTelegram ? 'telegram' : 'whatsapp'),
    command: ctx?.command || 'target',
    actorRole,
    targetRole,
    groupJid: ctx?.from || ctx?.groupJid || '',
    allowed,
    denyReason: allowed ? null : 'alvo imune'
  });
  return { allowed, actorRole, targetRole };
}

function seedCatalog(entries) {
  try {
    const sql = require('./sqlStore');
    if (typeof sql.upsertCommandRegistry !== 'function') return;
    for (const e of entries || []) {
      sql.upsertCommandRegistry(e.command, e.minRole, {
        category: e.category || '',
        isTargeted: !!e.isTargeted,
        notes: e.notes || ''
      });
    }
  } catch (_) { /* sql opcional */ }
}

module.exports = {
  RANK,
  ROLE_ORDER,
  isValidRole,
  normalizeRole,
  canUseCommand,
  canTarget,
  actorRoleFromCtx,
  resolveTargetRole,
  resolveTargetRoleLive,
  checkTargetAction,
  checkTargetActionLive,
  collectPersonTargets,
  guardPersonTargets,
  logAudit,
  seedCatalog
};
