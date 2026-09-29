'use strict';

const { delay } = require('../../utils');
const limits = require('./limits');
const { officialList } = require('./registry');
const { withOwnerLock, invalidateOccupancyCache } = require('./joinService');

const pendingLeave = new Map();
const TTL_MS = 2 * 60 * 1000;

function pendingKey(ownerKey) {
  return String(ownerKey);
}

function setPendingLeave(ownerKey, payload) {
  pendingLeave.set(pendingKey(ownerKey), { ...payload, at: Date.now() });
}

function getPendingLeave(ownerKey) {
  const row = pendingLeave.get(pendingKey(ownerKey));
  if (!row) return null;
  if (Date.now() - row.at > TTL_MS) {
    pendingLeave.delete(pendingKey(ownerKey));
    return null;
  }
  return row;
}

function clearPendingLeave(ownerKey) {
  pendingLeave.delete(pendingKey(ownerKey));
}

function pickLeaveTargets(ownerKey, n) {
  const lista = officialList(ownerKey);
  if (!lista.length || n <= 0) return [];
  return lista.slice(-n);
}

async function leaveOne(ownerKey, groupJid, lim) {
  const { retireDeadGroup } = require('../divulgacaoDeadReplace');
  const why = (lim && lim.leaveReason) || 'manual_leave';
  const out = await retireDeadGroup(groupJid, ownerKey, why);
  return { ok: !!(out && out.ok), jid: groupJid, leftWa: true, retired: out };
}

async function prepareLeave(ownerKey, requested) {
  const lim = limits.loadLimits(ownerKey);
  const st = limits.loadState(ownerKey);
  const ativos = officialList(ownerKey);
  const want = requested === 'max' ? lim.maxBatchSize : Number(requested);
  const real = limits.computeLeaveCount({
    requested: want,
    maxBatchSize: lim.maxBatchSize,
    maxLeavesPerDay: lim.maxLeavesPerDay,
    leavesToday: st.leavesToday,
    activeGroups: ativos.length
  });
  const jids = pickLeaveTargets(ownerKey, real);
  setPendingLeave(ownerKey, { n: real, jids, requested: want });
  return { real, jids, requested: want, total: ativos.length };
}

async function confirmLeave(ownerKey, { onProgress } = {}) {
  return withOwnerLock(ownerKey, async () => {
    const pending = getPendingLeave(ownerKey);
    if (!pending || !pending.jids?.length) {
      return { ok: false, reason: 'no-pending', done: 0 };
    }
    clearPendingLeave(ownerKey);
    const lim = limits.loadLimits(ownerKey);
    const results = [];
    for (let i = 0; i < pending.jids.length; i++) {
      if (i > 0) await delay(lim.leaveDelayMs);
      if (onProgress) await onProgress(i + 1, `Saindo ${i + 1}/${pending.jids.length}`);
      const one = await leaveOne(ownerKey, pending.jids[i], lim);
      results.push(one);
    }
    const okN = results.filter((r) => r.ok).length;
    if (okN) {
      limits.bumpLeaves(ownerKey, okN);
      invalidateOccupancyCache(ownerKey);
    }
    return { ok: true, done: okN, results };
  });
}

module.exports = {
  prepareLeave,
  confirmLeave,
  getPendingLeave,
  clearPendingLeave,
  pickLeaveTargets
};
