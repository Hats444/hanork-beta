'use strict';
/** boton/botoff por sessao (telegram_user_id). SQL kv_store scope botgate. */

const ram = new Map();

function keyOf(uid) {
  return String(uid || '').trim();
}

function isBotOff(uid) {
  const k = keyOf(uid);
  if (!k) return false;
  if (ram.has(k)) return ram.get(k) === true;
  try {
    const { getCachedKv } = require('./sqlStore');
    const v = getCachedKv('botgate', k);
    const off = v === 'off' || v === 1 || v === true;
    ram.set(k, off);
    return off;
  } catch (_) {
    return false;
  }
}

async function setBotOff(uid, off) {
  const k = keyOf(uid);
  if (!k) return false;
  const want = !!off;
  ram.set(k, want);
  const { upsertKvAsync } = require('./sqlStore');
  await upsertKvAsync('botgate', k, want ? 'off' : 'on');
  return want;
}

async function warm() {
  try {
    const { allAsync, isReady } = require('./sqlStore');
    if (!isReady()) return;
    const rows = await allAsync(`SELECT key, value FROM kv_store WHERE scope=?`, ['botgate']);
    for (const r of rows || []) {
      ram.set(String(r.key || ''), String(r.value || '') === 'off');
    }
  } catch (_) { /* sql frio */ }
}

module.exports = { isBotOff, setBotOff, warm };
