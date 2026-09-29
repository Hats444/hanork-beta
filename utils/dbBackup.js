'use strict';
/**
 * Backup agendado do SQLite (hanork.sqlite) para data/backups/db/.
 * Nao altera comportamento do bot. Reversivel: HANORK_DB_BACKUP=0.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const DB_PATH = path.join(__dirname, '..', 'data', 'hanork.sqlite');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups', 'db');

let timer = null;
let lastDay = '';

function enabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.HANORK_DB_BACKUP || '1').trim());
}

function keepDays() {
  const n = Number(process.env.HANORK_DB_BACKUP_KEEP_DAYS || 14);
  return Number.isFinite(n) && n > 0 ? Math.min(90, Math.floor(n)) : 14;
}

function brtDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function pruneOld() {
  const keep = keepDays();
  const cutoff = Date.now() - keep * 86400000;
  try {
    for (const name of fs.readdirSync(BACKUP_DIR)) {
      if (!/\.sqlite(\.bak)?$/i.test(name) && !/\.db$/i.test(name)) continue;
      const p = path.join(BACKUP_DIR, name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
}

/** Copia atomica do DB (+wal se existir) com data no nome. */
function runDbBackup(reason = 'sched') {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  if (!fs.existsSync(DB_PATH)) return { ok: false, reason: 'no_db' };
  try {
    ensureDir();
    const day = brtDay();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `hanork_${day}_${stamp}.sqlite`);
    const tmp = `${dest}.tmp`;
    fs.copyFileSync(DB_PATH, tmp);
    try {
      const wal = `${DB_PATH}-wal`;
      if (fs.existsSync(wal)) fs.copyFileSync(wal, `${dest}-wal`);
    } catch (_) { /* wal opcional */ }
    fs.renameSync(tmp, dest);
    // Mantem tambem o .bak "quente" usado pelo heartbeat
    try {
      fs.copyFileSync(DB_PATH, `${DB_PATH}.bak`);
    } catch (_) { /* ignore */ }
    pruneOld();
    // Opcional: copia fora do host (rclone/scp). Ex: HANORK_DB_BACKUP_HOOK=rclone copy {file} remote:hanork-db/
    const hook = String(process.env.HANORK_DB_BACKUP_HOOK || '').trim();
    if (hook) {
      try {
        const { execSync } = require('child_process');
        const cmd = hook.replace(/\{file\}/g, dest).replace(/\{dir\}/g, BACKUP_DIR);
        execSync(cmd, { stdio: 'ignore', timeout: 120000, windowsHide: true });
        logger.logInfo('[DB_BACKUP] hook ok');
      } catch (he) {
        logger.logAviso(`[DB_BACKUP] hook fail: ${he.message || he}`);
      }
    }
    logger.logInfo(`[DB_BACKUP] ok reason=${reason} day=${day}`);
    return { ok: true, dest: path.basename(dest) };
  } catch (e) {
    logger.logAviso(`[DB_BACKUP] fail: ${e.message || e}`);
    return { ok: false, reason: String(e.message || e) };
  }
}

function tick() {
  if (!enabled()) return;
  const day = brtDay();
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: 'numeric',
      hour12: false
    }).format(new Date())
  );
  const wantHour = Math.min(23, Math.max(0, Number(process.env.HANORK_DB_BACKUP_HOUR || 3) || 3));
  if (hour === wantHour && day !== lastDay) {
    lastDay = day;
    runDbBackup('daily');
  }
}

function startDbBackupScheduler() {
  if (!enabled()) {
    logger.logInfo('[DB_BACKUP] off (HANORK_DB_BACKUP=0)');
    return;
  }
  if (timer) return;
  ensureDir();
  // Boot: 1 copia se ainda nao tem backup de hoje
  try {
    const day = brtDay();
    const hasToday = fs.existsSync(BACKUP_DIR) &&
      fs.readdirSync(BACKUP_DIR).some((n) => n.includes(`hanork_${day}_`));
    if (!hasToday) runDbBackup('boot');
  } catch (_) { /* ignore */ }
  timer = setInterval(tick, 15 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  logger.logInfo('[DB_BACKUP] scheduler on');
}

module.exports = {
  startDbBackupScheduler,
  runDbBackup,
  BACKUP_DIR,
  enabled
};
