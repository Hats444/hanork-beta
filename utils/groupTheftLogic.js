'use strict';
/**
 * Regras puras de autoridade / risco / politica anti-roubo.
 * Sem Baileys, sem SQL — testavel no smoke.
 */

const DEFAULT_THRESHOLD = Number(process.env.HANORK_ANTIADMIN_THRESHOLD || 5);
const DEFAULT_WINDOW_MS = Number(process.env.HANORK_ANTIADMIN_WINDOW_MS || 10000);
const SELF_OP_TTL_MS = Number(process.env.HANORK_ANTIADMIN_SELF_TTL_MS || 8000);
const DEDUPE_TTL_MS = Number(process.env.HANORK_ANTIADMIN_DEDUPE_MS || 8000);

const ROLES = {
  BOT: 'BOT',
  BOT_OWNER: 'BOT_OWNER',
  REGISTERED_OWNER: 'REGISTERED_OWNER',
  OWNER_TRUSTED: 'OWNER_TRUSTED',
  SECURITY_ADMIN: 'SECURITY_ADMIN',
  MODERATOR: 'MODERATOR',
  NATIVE_OWNER: 'NATIVE_OWNER',
  WA_ADMIN: 'WA_ADMIN',
  MEMBER: 'MEMBER',
  UNKNOWN: 'UNKNOWN'
};

const WEIGHTS = {
  unauthDemote: 20,
  adminRemove: 30,
  burst: 40,
  mass: 50,
  botTarget: 75
};

function classifyRisk(score) {
  const n = Number(score) || 0;
  if (n >= 71) return 'CRITICAL';
  if (n >= 41) return 'HIGH';
  if (n >= 21) return 'SUSPEITO';
  return 'NORMAL';
}

function jidHost(s) {
  const i = String(s || '').lastIndexOf('@');
  return i >= 0 ? String(s).slice(i + 1).toLowerCase() : '';
}

function isLidHost(h) {
  return String(h || '').startsWith('lid');
}

function sameId(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y) return false;
  if (x === y) return true;
  const nx = x.replace(/:\d+@/, '@').toLowerCase();
  const ny = y.replace(/:\d+@/, '@').toLowerCase();
  if (nx === ny) return true;
  const hx = jidHost(nx);
  const hy = jidHost(ny);
  if (hx && hy && isLidHost(hx) !== isLidHost(hy)) return false;
  const ux = nx.split('@')[0];
  const uy = ny.split('@')[0];
  return ux.length > 4 && ux === uy;
}

function isTrustedAuthority(role) {
  return (
    role === ROLES.BOT_OWNER ||
    role === ROLES.REGISTERED_OWNER ||
    role === ROLES.OWNER_TRUSTED ||
    role === ROLES.SECURITY_ADMIN ||
    role === ROLES.MODERATOR
  );
}

function canTransferRole(role) {
  return role === ROLES.BOT_OWNER || role === ROLES.REGISTERED_OWNER;
}

function canManageProtection(role) {
  return canTransferRole(role) || role === ROLES.SECURITY_ADMIN;
}

function findTrusted(list, jid, extraIds = []) {
  if (!Array.isArray(list) || !list.length) return null;
  const ids = [jid, ...(Array.isArray(extraIds) ? extraIds : extraIds ? [extraIds] : [])].filter(Boolean);
  if (!ids.length) return null;
  return list.find((t) => t && ids.some((id) => sameId(t.jid, id))) || null;
}

/**
 * Native owner so vira autoridade se ainda nao ha owner registrado
 * (grupo nao vendido). Se houver registrado diferente, native = NATIVE_OWNER.
 */
function resolveActorRole(input) {
  const actor = input.actor || '';
  const registered = input.registeredOwner || input.registeredOwner;
  const native = input.nativeOwner || input.nativeOwner;
  if (input.actorIsBot || input.actorIsBot) return ROLES.BOT;
  if (!actor) return ROLES.UNKNOWN;
  if (input.actorIsBotOwner || input.actorIsBotOwner) return ROLES.BOT_OWNER;
  if (registered && sameId(actor, registered)) {
    return ROLES.REGISTERED_OWNER;
  }
  const trusted = findTrusted(input.trusted, actor, input.actorAliases);
  if (trusted) {
    const r = String(trusted.role || ROLES.OWNER_TRUSTED).toUpperCase();
    if (r === ROLES.SECURITY_ADMIN) return ROLES.SECURITY_ADMIN;
    if (r === ROLES.MODERATOR) return ROLES.MODERATOR;
    return ROLES.OWNER_TRUSTED;
  }
  if (native && sameId(actor, native)) {
    if (!registered) return ROLES.REGISTERED_OWNER;
    return ROLES.NATIVE_OWNER;
  }
  if (input.actorIsWaAdmin || input.actorIsWaAdmin) return ROLES.WA_ADMIN;
  return ROLES.MEMBER;
}

function resolveTargetRole(input) {
  const target = input.target || '';
  if (input.targetIsBot) return ROLES.BOT;
  if (!target) return ROLES.UNKNOWN;
  if (input.targetIsBotOwner) return ROLES.BOT_OWNER;
  if (input.registeredOwner && sameId(target, input.registeredOwner)) {
    return ROLES.REGISTERED_OWNER;
  }
  const trusted = findTrusted(input.trusted, target, input.targetAliases);
  if (trusted) {
    const r = String(trusted.role || ROLES.OWNER_TRUSTED).toUpperCase();
    if (r === ROLES.SECURITY_ADMIN) return ROLES.SECURITY_ADMIN;
    if (r === ROLES.MODERATOR) return ROLES.MODERATOR;
    return ROLES.OWNER_TRUSTED;
  }
  if (input.nativeOwner && sameId(target, input.nativeOwner)) {
    if (!input.registeredOwner) return ROLES.REGISTERED_OWNER;
    return ROLES.NATIVE_OWNER;
  }
  if (input.targetWasAdmin) return ROLES.WA_ADMIN;
  return ROLES.MEMBER;
}

function scoreEvent({ unauthorizedDemote, adminRemove, burst, mass, botTarget }) {
  let risk = 0;
  if (unauthorizedDemote) risk += WEIGHTS.unauthDemote;
  if (adminRemove) risk += WEIGHTS.adminRemove;
  if (burst) risk += WEIGHTS.burst;
  if (mass) risk += WEIGHTS.mass;
  if (botTarget) risk += WEIGHTS.botTarget;
  return risk;
}

function defaultFlags() {
  return {
    protection: false,
    audit: false,
    revert: true,
    alert: false,
    silent: false,
    detect: true,
    threshold: DEFAULT_THRESHOLD,
    windowMs: DEFAULT_WINDOW_MS
  };
}

/**
 * Politica:
 * - BOT / self: IGNORE
 * - autoridade confiavel: ALLOW (AUDIT se auditoria ON)
 * - sem actor: so AUDIT, nunca revert
 * - admin comum rebaixa/remove admin: APPLY se protection+revert
 * - rajada/massa: DETECT + APPLY (demote actor) se detect+protection+revert
 * - alvo bot: CRITICAL; revert demote se possivel; remove nao tenta rejoin
 */
function decide(ctx) {
  const flags = { ...defaultFlags(), ...(ctx.flags || {}) };
  const action = String(ctx.action || '');
  const actorRole = ctx.actorRole || ROLES.UNKNOWN;
  const targetRole = ctx.targetRole || ROLES.UNKNOWN;
  const targetWasAdmin = !!ctx.targetWasAdmin || isTrustedAuthority(targetRole) || targetRole === ROLES.NATIVE_OWNER || targetRole === ROLES.WA_ADMIN;
  const targetIsBot = !!ctx.targetIsBot || targetRole === ROLES.BOT;
  const threshold = Number(flags.threshold || DEFAULT_THRESHOLD);
  const burstCount = Number(ctx.burstCount || 0);
  const burst = burstCount >= threshold;
  const mass = !!ctx.mass || (burst && action === 'remove');
  const actorMissing = actorRole === ROLES.UNKNOWN && !ctx.actor;

  if (actorRole === ROLES.BOT) {
    return {
      policy: 'IGNORE',
      reason: 'self_op',
      risk: 0,
      class: 'NORMAL',
      revert: false,
      demoteActor: false,
      restoreTarget: false,
      alert: false
    };
  }

  const authorized = isTrustedAuthority(actorRole);
  const unauthDemote = !authorized && action === 'demote' && targetWasAdmin;
  const adminRemove = !authorized && action === 'remove' && targetWasAdmin;
  const botTarget = targetIsBot && (action === 'remove' || action === 'demote');

  const risk = scoreEvent({
    unauthorizedDemote: unauthDemote,
    adminRemove,
    burst: burst && flags.detect,
    mass: mass && flags.detect,
    botTarget
  });
  const klass = classifyRisk(risk);

  const auditOn = !!flags.audit || !!flags.protection;
  const wantAlert = !flags.silent && !!flags.alert && (unauthDemote || adminRemove || burst || botTarget);

  if (actorMissing) {
    return {
      policy: auditOn ? 'AUDIT' : 'ALLOW',
      reason: 'no_actor',
      risk,
      class: klass,
      revert: false,
      demoteActor: false,
      restoreTarget: false,
      alert: wantAlert && auditOn
    };
  }

  if (authorized) {
    return {
      policy: 'ALLOW',
      reason: 'authorized',
      risk: Math.min(risk, 20),
      class: 'NORMAL',
      revert: false,
      demoteActor: false,
      restoreTarget: false,
      alert: false,
      audit: !!flags.audit
    };
  }

  const attackLike = unauthDemote || adminRemove || (flags.detect && (burst || mass)) || botTarget;
  const apply = !!flags.protection && attackLike;
  const canRevert = apply && !!flags.revert && action !== 'add';
  const restoreTarget = canRevert && (unauthDemote || adminRemove) && action !== 'remove' && !botTarget;
  const restoreBotAdmin = canRevert && botTarget && action === 'demote';
  const demoteActor = canRevert && !(botTarget && action === 'remove');

  let policy = 'ALLOW';
  let reason = 'untrusted_ok';
  if (apply) {
    policy = 'APPLY';
    if (botTarget) reason = action === 'remove' ? 'bot_remove' : 'bot_demote';
    else if (unauthDemote) reason = 'unauth_demote';
    else if (adminRemove) reason = 'unauth_admin_remove';
    else if (mass) reason = 'mass_remove';
    else if (burst) reason = 'burst';
    else reason = 'policy';
  } else if (auditOn && (unauthDemote || adminRemove || burst || botTarget || action === 'promote' || action === 'demote')) {
    policy = 'AUDIT';
    reason = botTarget ? 'bot_target' : (unauthDemote ? 'unauth_demote' : 'audit');
  }

  return {
    policy,
    reason,
    risk,
    class: klass,
    revert: canRevert,
    demoteActor: !!demoteActor,
    restoreTarget: !!(restoreTarget || restoreBotAdmin),
    restoreMember: false,
    alert: wantAlert && (apply || policy === 'AUDIT'),
    skipRejoin: botTarget && action === 'remove'
  };
}

function eventDedupeKey({ groupJid, action, actor, targets }) {
  const t = (Array.isArray(targets) ? targets : [targets])
    .map((x) => String(x || ''))
    .filter(Boolean)
    .sort()
    .join(',');
  return `${groupJid || ''}|${action || ''}|${actor || ''}|${t}`;
}

function classifySettingsUpdate(update) {
  if (!update || typeof update !== 'object') return { risk: 0, class: 'NORMAL', kind: 'none' };
  if (update.announce != null || update.restrict != null) {
    return { risk: 25, class: 'SUSPEITO', kind: 'permissions' };
  }
  if (update.revoke || update.inviteCode || update.invite) {
    return { risk: 35, class: 'SUSPEITO', kind: 'invite' };
  }
  if (update.subject != null) return { risk: 15, class: 'NORMAL', kind: 'name' };
  if (update.desc != null) return { risk: 10, class: 'NORMAL', kind: 'desc' };
  if (update.icon || update.picture || update.author === 'picture') {
    return { risk: 10, class: 'NORMAL', kind: 'photo' };
  }
  return { risk: 5, class: 'NORMAL', kind: 'other' };
}

/**
 * Payload real do @systemzero/baileys (process-message.js):
 * participants = JSON.parse(stub) → Contact { id?, lid?, phoneNumber? }
 * author = message.key.participant (muitas vezes @lid)
 * authorPn = message.key.participantAlt
 */
function extractJidsFromParticipant(p) {
  if (p == null || p === '') return { id: '', lid: '', pn: '' };
  if (typeof p === 'string') {
    const s = String(p);
    if (s.endsWith('@lid')) return { id: s, lid: s, pn: '' };
    return { id: s, lid: '', pn: s };
  }
  if (typeof p !== 'object') return { id: '', lid: '', pn: '' };
  const id = String(p.id || p.jid || '');
  const lid = String(p.lid || (id.endsWith('@lid') ? id : '') || '');
  let pn = String(p.phoneNumber || p.pn || p.jidPn || p.participantPn || '');
  if (!pn && (id.endsWith('@s.whatsapp.net') || id.endsWith('@c.us'))) pn = id;
  return { id: pn || id || lid, lid, pn };
}

function participantRecords(update) {
  const raw = (update && update.participants) || [];
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    const j = extractJidsFromParticipant(p);
    const primary = j.pn || j.id || j.lid;
    if (!primary || seen.has(primary)) continue;
    seen.add(primary);
    out.push({ ...j, id: primary });
  }
  return out;
}

function participantIds(update) {
  return participantRecords(update).map((j) => j.id);
}

function pickActorPair(update) {
  const u = update || {};
  const pn = String(u.authorPn || u.participantPn || u.author_pn || '');
  const raw = String(u.author || u.actor || u.participant || '');
  const lid = raw.endsWith('@lid') ? raw : '';
  const actor = (pn && (pn.includes('whatsapp.net') || pn.endsWith('@c.us')))
    ? pn
    : (raw || pn);
  return { actor, actorPn: pn || (actor.includes('whatsapp.net') ? actor : ''), actorLid: lid };
}

function pickActor(update) {
  return pickActorPair(update).actor;
}

function wasAdminInSnapshot(snapshot, jid, aliases) {
  const parts = (snapshot && snapshot.participants) || [];
  const candidates = [jid].concat(aliases || []).filter(Boolean);
  for (const p of parts) {
    if (!p) continue;
    const rec = extractJidsFromParticipant(p);
    const ids = [rec.id, rec.lid, rec.pn, typeof p === 'string' ? p : p.id].filter(Boolean);
    if (!ids.some((id) => candidates.some((c) => sameId(id, c)))) continue;
    if (typeof p === 'object' && (p.admin || p.isAdmin || p.isSuperAdmin)) return true;
    if (typeof p === 'object') return !!p.admin;
  }
  return false;
}

function nativeOwnerFromMeta(meta) {
  if (!meta) return '';
  if (meta.ownerPn) return String(meta.ownerPn);
  if (meta.owner) return String(meta.owner);
  const parts = meta.participants || [];
  for (const p of parts) {
    if (!p || (p.admin !== 'superadmin' && !p.isSuperAdmin)) continue;
    const rec = extractJidsFromParticipant(p);
    return rec.pn || rec.id || rec.lid;
  }
  return '';
}

function isAdminNow(meta, jid) {
  return wasAdminInSnapshot(meta, jid);
}

const ALERT_DESTS = ['silent', 'dm', 'owner', 'group', 'both'];
const ALERT_DEST_LABEL = {
  group: 'GRUPO',
  dm: 'PV',
  both: 'AMBOS',
  owner: 'SESSAO',
  silent: 'SILENC'
};
const THRESHOLD_PRESETS = [3, 5, 8, 10, 15];
const WINDOW_PRESETS_S = [5, 10, 15, 30, 60];

function nextPreset(list, current, eq) {
  const arr = list || [];
  if (!arr.length) return current;
  const i = arr.findIndex((x) => (eq ? eq(x, current) : x === current));
  return arr[(i >= 0 ? i + 1 : 0) % arr.length];
}

function destLabelShort(d) {
  return ALERT_DEST_LABEL[String(d || 'silent')] || 'SILENC';
}

module.exports = {
  ROLES,
  WEIGHTS,
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW_MS,
  SELF_OP_TTL_MS,
  DEDUPE_TTL_MS,
  classifyRisk,
  isTrustedAuthority,
  canTransferRole,
  sameId,
  canManageProtection,
  findTrusted,
  resolveActorRole,
  resolveTargetRole,
  scoreEvent,
  defaultFlags,
  decide,
  eventDedupeKey,
  classifySettingsUpdate,
  participantIds,
  participantRecords,
  extractJidsFromParticipant,
  pickActor,
  pickActorPair,
  wasAdminInSnapshot,
  nativeOwnerFromMeta,
  isAdminNow,
  ALERT_DESTS,
  ALERT_DEST_LABEL,
  THRESHOLD_PRESETS,
  WINDOW_PRESETS_S,
  nextPreset,
  destLabelShort
};
