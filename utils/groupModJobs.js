'use strict';
/**
 * Tick 1/min via opsJobs: reentra ban temporario e aplica abrir/fechar pontual.
 * Sem setTimeout por ban — sobrevive restart.
 */

const logger = require('../logger');
const store = require('./groupModStore');

function liveConn(uid) {
  try {
    const gm = require('./groupManager');
    const live = gm.listLiveConns(String(uid || '')) || [];
    const item = live[0];
    return item && item.conn ? item.conn : null;
  } catch (_) {
    return null;
  }
}

async function tickTempBans() {
  let rows = [];
  try {
    rows = await store.listDueTempBans();
  } catch (_) {
    return;
  }
  for (const row of rows || []) {
    const uid = String(row.owner_key || '');
    const gid = String(row.group_jid || '');
    const jid = String(row.member_jid || '');
    if (!uid || !gid.endsWith('@g.us') || !jid) {
      await store.removeTempBan(uid, gid, jid).catch(() => {});
      continue;
    }
    const conn = liveConn(uid);
    if (!conn || typeof conn.groupParticipantsUpdate !== 'function') continue;
    try {
      await conn.groupParticipantsUpdate(gid, [jid], 'add');
      await store.removeTempBan(uid, gid, jid);
      logger.logInfo(`[bantmp] readd grupo=${gid.slice(0, 18)} uid=${uid.slice(0, 8)}`);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (/not-authorized|forbidden|401|403/i.test(msg)) {
        await store.removeTempBan(uid, gid, jid).catch(() => {});
        logger.logAviso(`[bantmp] sem permissao, drop ${gid.slice(0, 18)}`);
        continue;
      }
      const overdue = Date.now() - Number(row.restore_at || 0);
      if (overdue > 24 * 3600000) {
        await store.removeTempBan(uid, gid, jid).catch(() => {});
      }
      logger.logAviso(`[bantmp] readd: ${msg}`);
    }
  }
}

async function tickOnceSchedule() {
  let rows = [];
  try {
    rows = await store.listDueSchedules();
  } catch (_) {
    return;
  }
  for (const row of rows || []) {
    const uid = String(row.owner_key || '');
    const gid = String(row.group_jid || '');
    const action = row.action === 'open' ? 'open' : 'close';
    if (!uid || !gid.endsWith('@g.us')) {
      await store.removeOnceSchedule(uid, gid, action).catch(() => {});
      continue;
    }
    const conn = liveConn(uid);
    if (!conn || typeof conn.groupSettingUpdate !== 'function') continue;
    try {
      await conn.groupSettingUpdate(gid, action === 'close' ? 'announcement' : 'not_announcement');
      await store.removeOnceSchedule(uid, gid, action);
      const txt = action === 'close'
        ? 'Grupo FECHADO no horario marcado. So admin fala.'
        : 'Grupo ABERTO no horario marcado. Todos falam.';
      await conn.sendMessage(gid, { text: txt }).catch(() => {});
      logger.logInfo(`[agenda] ${action} grupo=${gid.slice(0, 18)} uid=${uid.slice(0, 8)}`);
    } catch (e) {
      logger.logAviso(`[agenda] ${e.message}`);
      const overdue = Date.now() - Number(row.fire_at || 0);
      if (overdue > 2 * 3600000) {
        await store.removeOnceSchedule(uid, gid, action).catch(() => {});
      }
    }
  }
}

async function tick() {
  await tickTempBans();
  await tickOnceSchedule();
}

module.exports = { tick, tickTempBans, tickOnceSchedule };
