'use strict';

const logger = require('../../logger');
const inviteStore = require('./inviteStore');
const limits = require('./limits');
const { registerJoinedGroup, officialList } = require('./registry');

async function listOwnerKeys() {
  try {
    const sql = require('../sqlStore');
    const rows = await sql.allAsync(`SELECT DISTINCT owner_key FROM group_invites`, []);
    return (rows || []).map((r) => r.owner_key).filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function healOnBoot() {
  try {
    const n = await inviteStore.healOrphans();
    if (n) logger.logInfo(`[GROUP_INVITE] orphans healed=${n}`);
    const owners = await listOwnerKeys();
    for (const owner of owners) {
      await recoverMissingRegistry(owner);
    }
  } catch (e) {
    logger.logAviso(`[GROUP_INVITE] heal: ${String(e.message || e).slice(0, 120)}`);
  }
}

async function recoverMissingRegistry(ownerKey) {
  const { normalizeGrupoJid } = require('../divDestinos');
  const lista = new Set((officialList(ownerKey) || []).map(normalizeGrupoJid).filter(Boolean));
  let excluded = null;
  try {
    excluded = require('../divulgacao').isGrupoExcluido;
  } catch (_) { /* ignore */ }
  let rows = [];
  try {
    rows = await inviteStore.joinedMissingRegistry(ownerKey, lista);
  } catch (_) {
    return 0;
  }
  let n = 0;
  for (const row of rows) {
    if (typeof excluded === 'function' && excluded(ownerKey, row.groupJid)) continue;
    const r = await registerJoinedGroup({
      jid: row.groupJid,
      sessionId: row.joinSession,
      inviteCode: row.inviteCode,
      telegramUserId: ownerKey,
      groupName: row.groupName
    });
    if (r.ok) n++;
  }
  if (n) logger.logInfo(`[GROUP_REGISTERED] recover n=${n} owner=${String(ownerKey).slice(0, 8)}`);
  return n;
}

async function reprocess(ownerKey) {
  const lim = limits.loadLimits(ownerKey);
  return inviteStore.reprocessFailed(ownerKey, lim.maxAttemptsPerInvite);
}

async function clearInvalid(ownerKey) {
  return inviteStore.clearInvalid(ownerKey);
}

module.exports = {
  healOnBoot,
  recoverMissingRegistry,
  reprocess,
  clearInvalid
};
