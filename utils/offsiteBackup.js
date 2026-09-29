'use strict';
/**
 * Backup de data/ para pasta externa. Default OFF (HANORK_OFFSITE_BACKUP=0).
 * Sem S3/Backblaze configurado: so copia local se HANORK_BACKUP_DIR existir.
 * Nao loga caminho de usuario nem conteudo.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../logger');

function enabled() {
  return String(process.env.HANORK_OFFSITE_BACKUP || '0').trim() === '1';
}

function retainDays() {
  const n = parseInt(process.env.HANORK_BACKUP_RETAIN_DAYS || '14', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(90, n) : 14;
}

function backupHourBrt() {
  const n = parseInt(process.env.HANORK_BACKUP_HOUR || '4', 10);
  return Number.isFinite(n) ? Math.min(23, Math.max(0, n)) : 4;
}

function brtParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10)
  };
}

async function alreadyRan(day) {
  try {
    const { getKv } = require('./sqlStore');
    const v = await getKv('ops', 'offsite_backup_day');
    return String(v || '') === String(day);
  } catch (_) {
    return false;
  }
}

async function markRan(day) {
  try {
    const { upsertKvAsync } = require('./sqlStore');
    await upsertKvAsync('ops', 'offsite_backup_day', String(day));
  } catch (_) { /* ignore */ }
}

function destDir() {
  return String(process.env.HANORK_BACKUP_DIR || '').trim();
}

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { cwd, windowsHide: true });
    let err = '';
    child.stderr.on('data', (b) => { err += String(b); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.slice(0, 200) || `tar exit ${code}`));
    });
  });
}

function rotateOld(dir, keepDays) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  const cutoff = Date.now() - keepDays * 86400000;
  let n = 0;
  for (const name of names) {
    if (!/^hanork-data-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        n += 1;
      }
    } catch (_) { /* ignore */ }
  }
  return n;
}

async function runOnce() {
  const dest = destDir();
  if (!dest) {
    logger.logAviso('[backup] HANORK_OFFSITE_BACKUP=1 mas HANORK_BACKUP_DIR vazio — skip');
    return false;
  }
  fs.mkdirSync(dest, { recursive: true });
  const root = path.join(__dirname, '..');
  const { day } = brtParts();
  const out = path.join(dest, `hanork-data-${day}.tar.gz`);
  const parts = [];
  for (const rel of ['data/hanork.sqlite', 'data/users', 'data/system']) {
    if (fs.existsSync(path.join(root, rel))) parts.push(rel);
  }
  if (!parts.length) {
    logger.logAviso('[backup] nada em data/ pra empacotar');
    return false;
  }
  await runTar(['-czf', out, ...parts], root);
  const bytes = fs.statSync(out).size;
  const gone = rotateOld(dest, retainDays());
  logger.logInfo(`[backup] ok bytes=${bytes} rotated=${gone}`);
  return true;
}

async function tick() {
  if (!enabled()) return;
  const { day, hour } = brtParts();
  if (hour !== backupHourBrt()) return;
  if (process.uptime() < 12 * 60) return;
  if (await alreadyRan(day)) return;
  try {
    const ok = await runOnce();
    if (ok) await markRan(day);
  } catch (e) {
    logger.logAviso(`[backup] falhou: ${e.message}`);
  }
}

module.exports = { enabled, tick, runOnce };
