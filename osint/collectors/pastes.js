'use strict';
/**
 * Indice PUBLICO de pastes via DDG site:. Titulo + URL.
 * Nao baixa /raw/, nao consulta HIBP/Dehashed, nao extrai senha/combo.
 */

const { ddgHits, isLeakDumpHit } = require('./search');
const { isRawPasteUrl } = require('../core/guardrails');

const PASTE_SITES = [
  'pastebin.com',
  'gist.github.com',
  'paste.ee',
  'rentry.co',
  'justpaste.it',
  'controlc.com',
  'dpaste.org',
  'paste.debian.net'
];

function pasteQueries(parsed) {
  const q = String(
    (parsed && (parsed.host || parsed.query || parsed.raw || parsed.label)) || ''
  ).trim().slice(0, 80);
  if (!q || q.length < 3) return [];
  const extra = PASTE_SITES.map((s) => `site:${s}`).join(' OR ');
  return [`(${extra}) ${q}`];
}

function keepPasteHit(ev) {
  const url = String(ev.url || '');
  if (!url) return false;
  if (isRawPasteUrl(url)) return false;
  if (isLeakDumpHit(ev.value, url)) return false;
  return true;
}

async function collect(target) {
  const parsed = target && typeof target === 'object' ? target : { query: String(target || '') };
  const out = [];
  const seen = new Set();
  for (const q of pasteQueries(parsed)) {
    const hits = await ddgHits(q, { source: 'pastes', limit: 8 });
    for (const ev of hits) {
      const url = String(ev.url || '');
      if (!url || seen.has(url)) continue;
      if (!keepPasteHit(ev)) continue;
      seen.add(url);
      out.push({
        ...ev,
        source: 'pastes',
        extra: Object.assign({}, ev.extra || {}, { public_paste: true, no_raw: true })
      });
    }
  }
  return out.slice(0, 30);
}

module.exports = { collect, name: 'pastes', phase: 2, pasteQueries, PASTE_SITES };
