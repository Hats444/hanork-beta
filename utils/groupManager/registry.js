'use strict';

const logger = require('../../logger');
const { normalizeGrupoJid } = require('../divDestinos');

function maskJid(jid) {
  const s = String(jid || '');
  if (!s.includes('@')) return 'jid?';
  const [user, server] = s.split('@');
  const head = user.slice(0, 8);
  return `${head}…@${server}`;
}

/**
 * Mesmo caminho do addgrupo: lista oficial + flag grupoDivulgacao.
 * JID passa por normalizeGrupoJid (canal / newsletter recusados).
 */
async function registerJoinedGroup({ jid, sessionId, inviteCode, telegramUserId, groupName }) {
  const uid = String(telegramUserId || '');
  const normalized = normalizeGrupoJid(jid);
  if (!normalized) return { ok: false, reason: 'bad-jid' };
  if (!uid) return { ok: false, reason: 'no-owner' };

  const { adicionarGrupo, setModoGrupos, getGruposParaDivulgar, isGrupoExcluido } = require('../divulgacao');
  const { setGroupSecurityFlag } = require('../moderation');

  if (typeof isGrupoExcluido === 'function' && isGrupoExcluido(uid, normalized)) {
    logger.logInfo(`[GROUP_REGISTERED] jid=${maskJid(normalized)} skip excluded`);
    return { ok: false, reason: 'excluded', added: false, jid: normalized, inList: false };
  }

  setModoGrupos(uid, 'especificos');
  const added = adicionarGrupo(uid, normalized);
  try {
    await setGroupSecurityFlag(normalized, uid, 'grupoDivulgacao', true);
  } catch (e) {
    logger.logAviso(`[GROUP_REGISTERED] flag: ${String(e.message || e).slice(0, 100)}`);
  }

  const lista = getGruposParaDivulgar(uid).grupos || [];
  const inList = lista.includes(normalized);
  logger.logInfo(
    `[GROUP_REGISTERED] jid=${maskJid(normalized)} session=${sessionId || '-'} new=${!!added} name=${String(groupName || '').slice(0, 40)}`
  );
  if (!inList) {
    logger.logAviso(`[GROUP_REGISTERED] jid=${maskJid(normalized)} fora da lista apos gravar`);
  }
  return { ok: inList, added: !!added, jid: normalized, inList };
}

async function unregisterGroup(telegramUserId, groupJid) {
  const uid = String(telegramUserId || '');
  const gid = normalizeGrupoJid(groupJid);
  if (!uid || !gid) return { ok: false };
  const { removerGrupo } = require('../divulgacao');
  const { setGroupSecurityFlag } = require('../moderation');
  const removed = removerGrupo(uid, gid);
  try {
    await setGroupSecurityFlag(gid, uid, 'grupoDivulgacao', false);
  } catch (_) { /* ignore */ }
  return { ok: true, removed: !!removed };
}

function officialList(telegramUserId) {
  const { getGruposParaDivulgar } = require('../divulgacao');
  return getGruposParaDivulgar(telegramUserId).grupos || [];
}

module.exports = {
  registerJoinedGroup,
  unregisterGroup,
  officialList,
  maskJid
};
