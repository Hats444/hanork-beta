'use strict';

const { assertPublicUrl } = require('../core/guardrails');
const { evidence } = require('../core/http');

const B64 = /\b(?:[A-Za-z0-9+/]{16,}={0,2})\b/g;
const HEX = /\b(?:[0-9a-fA-F]{24,})\b/g;

function tryUtf8(buf) {
  try {
    const s = Buffer.from(buf).toString('utf8');
    if (!s || /[\u0000-\u0008]/.test(s)) return '';
    return s.slice(0, 2000);
  } catch (_) {
    return '';
  }
}

function scanBlobs(blobs) {
  const out = [];
  const seen = new Set();
  for (const blob of blobs || []) {
    const t = String(blob || '');
    const b64 = t.match(B64) || [];
    for (const tok of b64.slice(0, 8)) {
      if (tok.length > 800) continue;
      let decoded = '';
      try { decoded = tryUtf8(Buffer.from(tok, 'base64')); } catch (_) { continue; }
      const url = (decoded.match(/https?:\/\/[^\s<>"']+/i) || [])[0];
      if (!url) continue;
      try {
        const safe = assertPublicUrl(url);
        if (seen.has(safe)) continue;
        seen.add(safe);
        out.push(evidence(safe, 'decode', safe, {
          entityType: 'URL',
          confidence: 0.35,
          extra: { via: 'base64', derived: true }
        }));
      } catch (_) { /* nao publico */ }
    }
    const hexes = t.match(HEX) || [];
    for (const tok of hexes.slice(0, 4)) {
      if (tok.length % 2) continue;
      const decoded = tryUtf8(Buffer.from(tok, 'hex'));
      const url = (decoded.match(/https?:\/\/[^\s<>"']+/i) || [])[0];
      if (!url) continue;
      try {
        const safe = assertPublicUrl(url);
        if (seen.has(safe)) continue;
        seen.add(safe);
        out.push(evidence(safe, 'decode', safe, {
          entityType: 'URL',
          confidence: 0.3,
          extra: { via: 'hex', derived: true }
        }));
      } catch (_) { /* ignore */ }
    }
  }
  return out;
}

function collect(target) {
  const parsed = target && typeof target === 'object' ? target : { raw: String(target || '') };
  const blobs = [parsed.raw, parsed.query, parsed.label];
  return scanBlobs(blobs);
}

module.exports = { collect, scanBlobs, name: 'decode', phase: 2 };
