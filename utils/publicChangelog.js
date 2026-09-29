'use strict';
/**
 * Changelog publico a partir da AUDITORIA-VIVA (sem arquivo, infra, JID, token).
 */

const fs = require('fs');
const path = require('path');

const AUDIT_PATH = path.join(__dirname, '../docs/AUDITORIA-VIVA.md');

const SECRETISH = [
  /`[^`]+`/g,
  /\b[\w./\\-]+\.(js|json|mdc?|sqlite|sql|env|tsx?|py)\b/gi,
  /120363\d{6,}/g,
  /[\w.+-]+@(?:g\.us|s\.whatsapp\.net|lid|newsletter|c\.us|broadcast)/gi,
  /@(?:g\.us|s\.whatsapp\.net|lid|newsletter|c\.us|broadcast)\b/gi,
  /https?:\/\/whatsapp\.com\/channel\/\S+/gi,
  /\bHANORK_[A-Z0-9_]+\b/g,
  /\bTELEGRAM_[A-Z0-9_]+\b/g,
  /\bMIND7_[A-Z0-9_]+\b/g,
  /\berrors_\d{4}-\d{2}-\d{2}\b/g,
  /\b(sqlite3?|group_protections|billing_\w+|protBlobCache|sqlStore|vipIndex)\b/gi,
  /\b(Raikken|Pterodactyl|VPS|egg)\b/gi,
  /\bdata\/users\/\S+/gi,
  /\b[A-Za-z0-9+/]{24,}={0,2}\b/g,
  /\b[0-9a-f]{40}\b/gi,
  /\b[0-9a-f]{7,10}\b/g
];

function scrub(text) {
  let t = String(text || '');
  for (const re of SECRETISH) t = t.replace(re, '');
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
  t = t.replace(/^[,.;:\-–—]\s*/, '').trim();
  return t;
}

function parseChangelogRows(md) {
  const src = String(md || '');
  const start = src.indexOf('## Changelog');
  if (start < 0) return [];
  const slice = src.slice(start, start + 80000);
  const rows = [];
  for (const line of slice.split('\n')) {
    if (!/^\|/.test(line) || /^\|\s*-+/.test(line) || /^\|\s*Quando\s*\|/.test(line)) continue;
    const cols = line.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
    if (cols.length < 3) continue;
    const quando = scrub(cols[0]);
    const mudanca = scrub(cols[1]);
    const impacto = scrub(cols[3] || '');
    if (!quando || !mudanca) continue;
    if (/PoC|oi\.json|mencao invisivel|silent tag/i.test(mudanca)) continue;
    rows.push({ date: quando, change: mudanca, impact: impacto });
    if (rows.length >= 18) break;
  }
  return rows;
}

function loadAuditMarkdown() {
  try {
    return fs.readFileSync(AUDIT_PATH, 'utf8');
  } catch (_) {
    return '';
  }
}

function buildPublicChangelog(limit = 8) {
  const rows = parseChangelogRows(loadAuditMarkdown()).slice(0, Math.max(3, Number(limit) || 8));
  return rows;
}

function formatPublicChangelog(prefix = '.') {
  const p = prefix || '.';
  const buy = String(p).startsWith('/') ? '/comprar' : `${p}comprar`;
  const rows = buildPublicChangelog(8);
  const lines = ['HANORK — o que mudou', ''];
  if (!rows.length) {
    lines.push('Sem notas publicas no momento.');
  } else {
    for (const r of rows) {
      lines.push(r.date);
      lines.push(`- ${r.change}`);
      if (r.impact) lines.push(`  ${r.impact}`);
      lines.push('');
    }
  }
  lines.push(`Planos: ${buy}`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function containsSensitive(text) {
  const s = String(text || '');
  if (/@g\.us|@s\.whatsapp|@lid|@newsletter/i.test(s)) return true;
  if (/HANORK_[A-Z0-9_]+|TELEGRAM_[A-Z0-9_]+/.test(s)) return true;
  if (/120363\d{8,}/.test(s)) return true;
  if (/\.js\b|\.sqlite\b|group_protections|sqlStore/i.test(s)) return true;
  if (/errors_\d{4}/.test(s)) return true;
  if (/\b(Pterodactyl|Raikken|sqlite3?)\b/i.test(s)) return true;
  return false;
}

module.exports = {
  scrub,
  parseChangelogRows,
  buildPublicChangelog,
  formatPublicChangelog,
  containsSensitive,
  AUDIT_PATH
};
