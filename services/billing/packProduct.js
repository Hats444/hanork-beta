'use strict';
/**
 * Zip do codigo atual sem segredos, sessoes Baileys nem banco.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const logger = require('../../logger');

const ROOT = path.resolve(__dirname, '..', '..');

const SKIP_DIR = new Set([
  'node_modules', '.git', 'data', 'logs', '.cursor',
  'agent-transcripts', 'terminals', 'coverage', 'test', 'tests',
  'Mobile Devices', 'auth_info', 'sessions', 'baileys_auth'
]);

function skipRel(rel) {
  const n = String(rel || '').replace(/\\/g, '/');
  if (!n) return true;
  const base = n.split('/').pop();
  if (base === '.env') return true;
  if (/(^|\/)(data|sessions|logs|auth_info|baileys_auth)\//i.test(n)) return true;
  if (/^\.env\./i.test(base) && !/\.example$/i.test(base)) return true;
  if (/\.sqlite3?$/i.test(n)) return true;
  if (/(credential|secret|\.pem$|\.key$)/i.test(n) && !/\.example$/i.test(n)) return true;
  if (/auth_info|baileys|creds\.json/i.test(n)) return true;
  if (n.startsWith('scripts/_') && /sync-mp|check-mp/i.test(n)) return true;
  return false;
}

function walk(abs, rel, out) {
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.example' && e.name !== '.gitignore') continue;
    const nextRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(path.join(abs, e.name), nextRel, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (skipRel(nextRel)) continue;
    out.push(nextRel);
  }
}

function collect() {
  const out = [];
  walk(ROOT, '', out);
  return out;
}

async function packProduct() {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const files = collect();
  let n = 0;
  for (const rel of files) {
    try {
      const abs = path.join(ROOT, rel);
      const st = fs.statSync(abs);
      if (st.size > 8 * 1024 * 1024) continue;
      zip.addLocalFile(abs, path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), path.basename(rel));
      n++;
    } catch (_) { /* skip unreadable */ }
  }
  const buf = zip.toBuffer();
  logger.logInfo(`[billing] zip produto files=${n} bytes=${buf.length}`);
  const fileName = `hanork-bot-${new Date().toISOString().slice(0, 10)}.zip`;
  const tmp = path.join(os.tmpdir(), `hanork-pack-${crypto.randomBytes(4).toString('hex')}.zip`);
  fs.writeFileSync(tmp, buf);
  return { buffer: buf, fileName, tmpPath: tmp, fileCount: n };
}

function zipHasSecrets(buf) {
  const AdmZip = require('adm-zip');
  const z = new AdmZip(buf);
  return z.getEntries().some((e) => skipRel(e.entryName) && !/\.example$/i.test(e.entryName));
}

module.exports = { packProduct, collect, skipRel, zipHasSecrets };
