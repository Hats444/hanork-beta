'use strict';

const logger = require('../../logger');
const { extractInviteCodes, harvestMessageText } = require('./inviteDetect');
const inviteStore = require('./inviteStore');
const { healOnBoot, recoverMissingRegistry, reprocess, clearInvalid } = require('./queue');
const { occupancy, invalidateOccupancyCache, maintainOccupancy } = require('./joinService');
const { prepareLeave, confirmLeave, getPendingLeave, clearPendingLeave } = require('./leaveService');
const { snapshot, panelText, limitsText, queueText, activePage } = require('./status');
const { registerJoinedGroup, officialList } = require('./registry');
const limits = require('./limits');

const ackCooldown = new Map();

async function ingestText({
  ownerKey,
  text,
  sourceJid,
  sourceSession,
  notifyOwner
}) {
  const codes = extractInviteCodes(text);
  if (!codes.length) return { saved: 0, dup: 0, codes: [] };
  let saved = 0;
  let dup = 0;
  for (const code of codes) {
    const r = await inviteStore.saveInvite({
      ownerKey,
      inviteCode: code,
      sourceJid,
      sourceSession
    });
    if (r.ok && r.created) saved++;
    else if (r.ok) dup++;
  }
  if (saved) {
    logger.logInfo(`[GROUP_INVITE_DETECTED] n=${codes.length} saved=${saved} session=${sourceSession || '-'}`);
    try {
      const pending = await inviteStore.countByStatus(ownerKey, 'pending');
      logger.logInfo(`[GROUP_INVITE_SAVED] n=${saved} dup=${dup} pending=${pending} session=${sourceSession || '-'}`);
    } catch (_) {
      logger.logInfo(`[GROUP_INVITE_SAVED] n=${saved} dup=${dup} session=${sourceSession || '-'}`);
    }
  }
  // notifyOwner e so log — nunca manda "Convite salvo" no grupo/PV.
  if (saved && typeof notifyOwner === 'function') {
    const key = String(ownerKey);
    const now = Date.now();
    if (now - (ackCooldown.get(key) || 0) > 8000) {
      ackCooldown.set(key, now);
      try {
        const pending = await inviteStore.countByStatus(ownerKey, 'pending');
        await notifyOwner(saved, pending);
      } catch (_) { /* ignore */ }
    }
  }
  return { saved, dup, codes };
}

async function ingestFromCtx(ctx) {
  const ownerKey = String(ctx.telegramUserId || '');
  if (!ownerKey) return { saved: 0 };
  const text = harvestMessageText(ctx, ctx.info);
  const codes = extractInviteCodes(text, ctx.info?.message);
  if (!codes.length) return { saved: 0 };
  return ingestText({
    ownerKey,
    text: codes.map((c) => `https://chat.whatsapp.com/${c}`).join('\n'),
    sourceJid: ctx.from,
    sourceSession: ctx.sessionId,
    notifyOwner: null
  });
}

module.exports = {
  ingestText,
  ingestFromCtx,
  extractInviteCodes: require('./inviteDetect').extractInviteCodes,
  healOnBoot,
  recoverMissingRegistry,
  reprocess,
  clearInvalid,
  joinBatch: require('./joinService').joinBatch,
  listLiveConns: require('./joinService').listLiveConns,
  occupancy,
  invalidateOccupancyCache,
  scheduleOccupancyRefill: require('./joinService').scheduleOccupancyRefill,
  prepareLeave,
  confirmLeave: async (ownerKey, opts) => {
    const out = await confirmLeave(ownerKey, opts);
    if (out && out.ok && out.done) {
      setImmediate(() => {
        maintainOccupancy(ownerKey).catch((e) => {
          logger.logAviso(`[GM] repor pos-saida: ${e.message}`);
        });
      });
    }
    return out;
  },
  getPendingLeave,
  clearPendingLeave,
  snapshot,
  panelText,
  limitsText,
  queueText,
  activePage,
  registerJoinedGroup,
  officialList,
  loadLimits: limits.loadLimits,
  saveLimits: limits.saveLimits,
  isAutoRefillOn: limits.isAutoRefillOn,
  OCCUPANCY_PRESETS: limits.OCCUPANCY_PRESETS,
  setPaused: limits.setPaused,
  computeJoinCount: limits.computeJoinCount,
  maintainOccupancy
};
