'use strict';

const { sanitizeHostname } = require('../core/guardrails');
const { fetchPublicJson, evidence } = require('../core/http');

async function collect(target) {
  const parsed = target && typeof target === 'object' ? target : { host: String(target || '') };
  const host = sanitizeHostname(parsed.host || parsed.label || target);
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(host)}&output=json&limit=25&fl=timestamp,original,statuscode,mimetype`;
  const data = await fetchPublicJson(url, { rateKey: 'web.archive.org', timeoutMs: 8000 });
  const rows = Array.isArray(data) ? data.slice(1, 26) : [];
  const out = [];
  for (const row of rows) {
    const ts = Array.isArray(row) ? row[0] : '';
    const original = Array.isArray(row) ? row[1] : '';
    if (!original) continue;
    const snap = ts
      ? `https://web.archive.org/web/${ts}/${original}`
      : original;
    out.push(evidence(original, 'archive', snap, {
      entityType: 'URL',
      confidence: 0.5,
      extra: { timestamp: ts, status: Array.isArray(row) ? row[2] : '' }
    }));
  }
  return out;
}

module.exports = { collect, name: 'archive', phase: 2 };
