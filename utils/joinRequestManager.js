'use strict';
/**
 * Solicitacoes de entrada em grupo.
 * @systemzero/baileys 1.1.0 NAO exporta groupRequestParticipantsList/Update —
 * listamos/aprovamos via IQ w:g2 (mesmo protocolo WhiskeySockets).
 * Alerta: evento group.join-request + fallback no stub (JSON.parse da lib explode).
 */
const logger = require('../logger');
const { sendInteractiveButtons } = require('../helpers');
const { getGroupSecurity } = require('./moderation');
const { previewText } = require('./typography');

/** @type {Map<string, { key: object, updatedAt: number }>} groupJid -> ultima msg de alerta */
const alertByGroup = new Map();
const locks = new Map();
/** debounce refresh por grupo (evento + stub no mesmo segundo) */
const lastRefreshAt = new Map();

let joinStubTypeCache = null;

function lockKey(groupJid, action) {
  return `${groupJid}|${action}`;
}

function tryLock(groupJid, action, ttlMs = 15000) {
  const k = lockKey(groupJid, action);
  const now = Date.now();
  const cur = locks.get(k);
  if (cur && now - cur < ttlMs) return false;
  locks.set(k, now);
  return true;
}

function unlock(groupJid, action) {
  locks.delete(lockKey(groupJid, action));
}

function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us');
}

function resolveGroupJid(input) {
  if (!input) return '';
  if (typeof input === 'string') return isGroupJid(input) ? input : '';
  const from = String(input.from || input.id || input.info?.key?.remoteJid || '');
  const alt = String(input.info?.key?.remoteJidAlt || input.remoteJidAlt || '');
  if (isGroupJid(from)) return from;
  if (isGroupJid(alt)) return alt;
  return '';
}

function isAutoconviteOn(groupJid, telegramUserId) {
  const gid = resolveGroupJid(groupJid) || (isGroupJid(groupJid) ? String(groupJid) : '');
  if (!gid) return false;
  const flags = getGroupSecurity(gid, telegramUserId);
  return !!flags.autoconvite;
}

function participantId(p) {
  if (!p) return '';
  if (typeof p === 'string') return normalizeParticipantJid(p);
  const attrs = p.attrs && typeof p.attrs === 'object' ? p.attrs : p;
  const raw = attrs.jid || attrs.requestor || attrs.id || attrs.participant
    || attrs.phoneNumber || attrs.lid || attrs.pn || '';
  return normalizeParticipantJid(raw);
}

function normalizeParticipantJid(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.includes('@')) return s;
  if (/^\d{8,20}$/.test(s)) return `${s}@s.whatsapp.net`;
  return s;
}

function shortId(jid) {
  const s = String(jid || '');
  const base = s.split('@')[0].split(':')[0];
  return base || s.slice(0, 24);
}

function nodeChildren(node, tag) {
  const c = node?.content;
  if (!Array.isArray(c)) return [];
  if (!tag) return c.filter((x) => x && x.tag);
  return c.filter((x) => x && x.tag === tag);
}

function nodeChild(node, tag) {
  return nodeChildren(node, tag)[0];
}

function collectApprovalNodes(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.tag === 'membership_approval_request') acc.push(node);
  if (Array.isArray(node.content)) {
    for (const c of node.content) collectApprovalNodes(c, acc);
  }
  return acc;
}

async function groupIq(conn, jid, type, content) {
  if (typeof conn.query !== 'function') {
    throw new Error('conn.query indisponivel');
  }
  return conn.query({
    tag: 'iq',
    attrs: { type, xmlns: 'w:g2', to: jid },
    content
  });
}

function attachJoinRequestApi(conn) {
  if (!conn || typeof conn !== 'object') return;
  if (typeof conn.groupRequestParticipantsList !== 'function') {
    conn.groupRequestParticipantsList = (jid) => iqListPending(conn, jid);
  }
  if (typeof conn.groupRequestParticipantsUpdate !== 'function') {
    conn.groupRequestParticipantsUpdate = (jid, participants, action) =>
      iqUpdatePending(conn, jid, participants, action);
  }
}

async function iqListPending(conn, groupJid) {
  const result = await groupIq(conn, groupJid, 'get', [
    { tag: 'membership_approval_requests', attrs: {} }
  ]);
  const nodes = collectApprovalNodes(result);
  return nodes.map((n) => (n.attrs && typeof n.attrs === 'object' ? n.attrs : {})).filter((a) => a.jid || a.requestor);
}

async function iqUpdatePending(conn, groupJid, participants, action) {
  const ids = (participants || []).map(participantId).filter(Boolean);
  if (!ids.length) return [];
  const act = action === 'approve' ? 'approve' : 'reject';
  const result = await groupIq(conn, groupJid, 'set', [
    {
      tag: 'membership_requests_action',
      attrs: {},
      content: [
        {
          tag: act,
          attrs: {},
          content: ids.map((jid) => ({
            tag: 'participant',
            attrs: { jid }
          }))
        }
      ]
    }
  ]);
  const actionNode = nodeChild(result, 'membership_requests_action') || result;
  const inner = nodeChild(actionNode, act) || actionNode;
  return nodeChildren(inner, 'participant').map(({ attrs }) => attrs || {});
}

async function listPending(conn, groupJid) {
  attachJoinRequestApi(conn);
  const raw = await conn.groupRequestParticipantsList(groupJid);
  const list = Array.isArray(raw) ? raw : [];
  const ids = [];
  const seen = new Set();
  for (const p of list) {
    const id = participantId(p);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function updateParticipants(conn, groupJid, participants, action) {
  attachJoinRequestApi(conn);
  const ids = (participants || []).map(participantId).filter(Boolean);
  if (!ids.length) return { ok: false, reason: 'vazio' };
  const act = action === 'approve' ? 'approve' : 'reject';
  try {
    const res = await conn.groupRequestParticipantsUpdate(groupJid, ids, act);
    return { ok: true, res, ids, action: act };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/not-authorized|forbidden|401|403/i.test(msg)) {
      return { ok: false, reason: 'sem_permissao', error: msg };
    }
    if (/not-found|404|no longer|already|inexist/i.test(msg)) {
      return { ok: false, reason: 'ja_processada', error: msg };
    }
    return { ok: false, reason: 'erro', error: msg };
  }
}

async function deleteAlertMessage(conn, groupJid) {
  const prev = alertByGroup.get(groupJid);
  if (!prev?.key) return;
  try {
    await conn.sendMessage(groupJid, { delete: prev.key });
  } catch (_) { /* ignore */ }
  alertByGroup.delete(groupJid);
}

function buildAlertContent(pending) {
  const n = pending.length;
  if (n <= 0) {
    return {
      text: previewText('Nenhuma solicitacao de entrada pendente.'),
      buttons: []
    };
  }
  if (n === 1) {
    const who = shortId(pending[0]);
    return {
      text: previewText(
        `Solicitacao de entrada\n\nNumero: ${who}\n\nAceitar ou recusar?`
      ),
      buttons: [
        { id: 'join_accept', label: 'Aceitar' },
        { id: 'join_reject', label: 'Recusar' }
      ]
    };
  }
  const lines = pending.slice(0, 30).map((j, i) => `${i + 1}. ${shortId(j)}`);
  const extra = pending.length > 30 ? `\n… +${pending.length - 30}` : '';
  return {
    text: previewText(
      `Solicitacoes pendentes: ${n}\n\n${lines.join('\n')}${extra}\n\nAceitar todos ou recusar todos?`
    ),
    buttons: [
      { id: 'join_accept_all', label: 'Aceitar todos' },
      { id: 'join_reject_all', label: 'Recusar todos' }
    ]
  };
}

async function refreshJoinAlert(conn, groupJid, opts = {}) {
  const gid = resolveGroupJid(groupJid) || (isGroupJid(groupJid) ? groupJid : '');
  if (!gid) return { ok: false, error: 'grupo invalido' };

  const now = Date.now();
  if (!opts.force && lastRefreshAt.has(gid) && now - lastRefreshAt.get(gid) < 1800) {
    return { ok: true, pending: null, sent: false, debounced: true };
  }
  lastRefreshAt.set(gid, now);

  const telegramUserId = opts.telegramUserId ?? conn?._telegramUserId ?? null;
  const sessionId = opts.sessionId || conn?._sessionId || null;

  let pending;
  try {
    pending = await listPending(conn, gid);
  } catch (e) {
    logger.logAviso(`[joinReq] list fail ${gid}: ${e.message}`);
    return { ok: false, error: e.message };
  }

  await deleteAlertMessage(conn, gid);

  if (!pending.length) {
    if (opts.notifyEmpty) {
      try {
        await conn.sendMessage(gid, {
          text: previewText('Nenhuma solicitacao pendente.')
        });
      } catch (_) { /* ignore */ }
    }
    return { ok: true, pending: [], sent: false };
  }

  const { text, buttons } = buildAlertContent(pending);
  try {
    const sent = await sendInteractiveButtons(
      conn,
      gid,
      text,
      buttons,
      'Hanork · entrada',
      null,
      null,
      telegramUserId,
      sessionId
    );
    const key = sent?.key || null;
    if (key) {
      alertByGroup.set(gid, { key, updatedAt: Date.now() });
      try {
        const { rememberMenuId, rememberJoinAlert } = require('./interactiveClickGuard');
        if (key.id) rememberMenuId(key.id, conn);
        rememberJoinAlert(conn, gid);
      } catch (_) { /* ignore */ }
    }
    return { ok: true, pending, sent: true };
  } catch (e) {
    logger.logAviso(`[joinReq] send alert fail: ${e.message}`);
    try {
      await conn.sendMessage(gid, { text });
    } catch (_) { /* ignore */ }
    return { ok: true, pending, sent: false };
  }
}

function joinStubTypes() {
  if (joinStubTypeCache) return joinStubTypeCache;
  const set = new Set();
  try {
    const { WAMessageStubType } = require('@systemzero/baileys');
    const v = WAMessageStubType?.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD;
    if (v != null) set.add(Number(v));
  } catch (_) { /* */ }
  if (!set.size) {
    set.add(145);
    set.add(172);
  }
  joinStubTypeCache = set;
  return set;
}

function isJoinRequestStub(msg) {
  const t = msg?.messageStubType;
  if (t == null) return false;
  return joinStubTypes().has(t) || joinStubTypes().has(Number(t));
}

async function maybeAlertGroup(conn, groupJid, telegramUserId, source) {
  const gid = resolveGroupJid(groupJid) || (isGroupJid(groupJid) ? String(groupJid) : '');
  if (!gid) {
    logger.logAviso(`[joinReq] skip not-group source=${source} id=${String(groupJid || '').slice(0, 48)}`);
    return;
  }
  try {
    const flags = getGroupSecurity(gid, telegramUserId);
    if (flags && flags.autoaceitar) {
      const { canJoinAutoNow, touchJoinAuto } = require('./groupModStore');
      if (!(await canJoinAutoNow(telegramUserId, gid))) {
        logger.logInfo(`[joinReq] autoaceitar cooldown ${gid}`);
        return;
      }
      const res = await approveAll(conn, gid);
      if (res && res.ok) await touchJoinAuto(telegramUserId, gid);
      logger.logInfo(`[joinReq] autoaceitar ${res && res.ok ? 'ok' : (res && res.reason) || 'fail'} ${gid}`);
      return;
    }
  } catch (e) {
    logger.logAviso(`[joinReq] autoaceitar: ${e && e.message ? e.message : e}`);
  }
  if (!isAutoconviteOn(gid, telegramUserId)) {
    logger.logInfo(`[joinReq] autoconvite off — ignora alerta ${gid}`);
    return;
  }
  logger.logInfo(`[joinReq] alerta via ${source} ${gid}`);
  await refreshJoinAlert(conn, gid, { telegramUserId });
}

async function onJoinRequestEvent(conn, update, telegramUserId) {
  const groupJid = String(update?.id || update?.jid || '').trim();
  const action = String(update?.action || 'created');
  await maybeAlertGroup(conn, groupJid, telegramUserId, `event:${action}`);
}

async function onJoinRequestStubMessage(conn, msg, telegramUserId) {
  if (!isJoinRequestStub(msg)) return false;
  const gid = msg.key?.remoteJid || msg.key?.remoteJidAlt || '';
  logger.logInfo(`[joinReq] stub type=${msg.messageStubType} gid=${gid}`);
  await maybeAlertGroup(conn, gid, telegramUserId, 'stub');
  return true;
}

async function approveLatest(conn, groupJid) {
  const gid = resolveGroupJid(groupJid) || groupJid;
  const pending = await listPending(conn, gid);
  if (!pending.length) return { ok: false, reason: 'nenhuma' };
  const target = pending[pending.length - 1];
  if (!tryLock(gid, `one:${target}`)) {
    return { ok: false, reason: 'concorrencia' };
  }
  try {
    const still = await listPending(conn, gid);
    if (!still.includes(target)) {
      return { ok: false, reason: 'ja_processada' };
    }
    const res = await updateParticipants(conn, gid, [target], 'approve');
    if (!res.ok) return res;
    await refreshJoinAlert(conn, gid, { force: true });
    return { ok: true, ids: [target], action: 'approve' };
  } finally {
    unlock(gid, `one:${target}`);
  }
}

async function rejectLatest(conn, groupJid) {
  const gid = resolveGroupJid(groupJid) || groupJid;
  const pending = await listPending(conn, gid);
  if (!pending.length) return { ok: false, reason: 'nenhuma' };
  const target = pending[pending.length - 1];
  if (!tryLock(gid, `one:${target}`)) {
    return { ok: false, reason: 'concorrencia' };
  }
  try {
    const still = await listPending(conn, gid);
    if (!still.includes(target)) {
      return { ok: false, reason: 'ja_processada' };
    }
    const res = await updateParticipants(conn, gid, [target], 'reject');
    if (!res.ok) return res;
    await refreshJoinAlert(conn, gid, { force: true });
    return { ok: true, ids: [target], action: 'reject' };
  } finally {
    unlock(gid, `one:${target}`);
  }
}

async function approveAll(conn, groupJid) {
  const gid = resolveGroupJid(groupJid) || groupJid;
  if (!tryLock(gid, 'all')) {
    return { ok: false, reason: 'concorrencia' };
  }
  try {
    const pending = await listPending(conn, gid);
    if (!pending.length) return { ok: false, reason: 'nenhuma' };
    const res = await updateParticipants(conn, gid, pending, 'approve');
    if (!res.ok) return res;
    await refreshJoinAlert(conn, gid, { force: true });
    return { ok: true, ids: pending, action: 'approve', count: pending.length };
  } finally {
    unlock(gid, 'all');
  }
}

async function rejectAll(conn, groupJid) {
  const gid = resolveGroupJid(groupJid) || groupJid;
  if (!tryLock(gid, 'all')) {
    return { ok: false, reason: 'concorrencia' };
  }
  try {
    const pending = await listPending(conn, gid);
    if (!pending.length) return { ok: false, reason: 'nenhuma' };
    const res = await updateParticipants(conn, gid, pending, 'reject');
    if (!res.ok) return res;
    await refreshJoinAlert(conn, gid, { force: true });
    return { ok: true, ids: pending, action: 'reject', count: pending.length };
  } finally {
    unlock(gid, 'all');
  }
}

function formatResult(res) {
  if (!res) return 'Falha desconhecida.';
  if (res.ok) {
    const n = res.count || res.ids?.length || 1;
    const verb = res.action === 'approve' ? 'Aceita' : 'Recusada';
    return n === 1 ? `${verb} 1 solicitacao.` : `${verb}s ${n} solicitacoes.`;
  }
  if (res.reason === 'nenhuma') return 'Nenhuma solicitacao pendente.';
  if (res.reason === 'ja_processada') return 'Solicitacao ja processada.';
  if (res.reason === 'concorrencia') return 'Outra acao em andamento. Tente de novo.';
  if (res.reason === 'sem_permissao') return 'Bot sem permissao de admin pra isso.';
  return `Falha: ${res.error || res.reason || '?'}`;
}

module.exports = {
  listPending,
  refreshJoinAlert,
  onJoinRequestEvent,
  onJoinRequestStubMessage,
  approveLatest,
  rejectLatest,
  approveAll,
  rejectAll,
  isAutoconviteOn,
  formatResult,
  resolveGroupJid,
  isGroupJid,
  attachJoinRequestApi,
  alertByGroup
};
