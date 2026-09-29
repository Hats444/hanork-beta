'use strict';
/** Abre/fecha grupo no horario (SQL). 1 tick/min via opsJobs — sem setInterval extra. */

const logger = require('../logger');

function hmNow() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}

function dayStamp() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

async function tick() {
  let rows = [];
  try {
    rows = await require('./shopStore').listEnabledHours();
  } catch (_) {
    return;
  }
  if (!rows.length) return;
  const hm = hmNow();
  const day = dayStamp();
  const gm = require('./groupManager');
  for (const row of rows) {
    const uid = String(row.owner_key || '');
    const g = String(row.group_jid || '');
    if (!uid || !g.endsWith('@g.us')) continue;
    let action = null;
    if (String(row.open_hm) === hm) action = 'open';
    else if (String(row.close_hm) === hm) action = 'close';
    if (!action) continue;
    const stamp = `${day}:${action}:${hm}`;
    if (String(row.last_apply || '') === stamp) continue;
    const live = gm.listLiveConns(uid) || [];
    const conn = live[0] && live[0].conn;
    if (!conn || typeof conn.groupSettingUpdate !== 'function') continue;
    try {
      await conn.groupSettingUpdate(g, action === 'close' ? 'announcement' : 'not_announcement');
      await require('./shopStore').markHoursApplied(uid, g, stamp);
      logger.logInfo(`[shopHours] ${action} grupo=${g.slice(0, 18)} uid=${uid.slice(0, 8)}`);
    } catch (e) {
      logger.logAviso(`[shopHours] ${e.message}`);
    }
  }
}

module.exports = { tick, hmNow };
