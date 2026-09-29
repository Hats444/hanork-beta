'use strict';

const { sanitizeHostname } = require('../core/guardrails');
const { fetchPublicJson, evidence } = require('../core/http');

async function collect(target) {
  const host = sanitizeHostname(target);
  const url = `https://crt.sh/?q=${encodeURIComponent(host)}&output=json`;
  const data = await fetchPublicJson(url, { rateKey: 'crt.sh', timeoutMs: 10000 });
  const rows = Array.isArray(data) ? data.slice(0, 80) : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const names = String(row.name_value || row.common_name || '')
      .split(/[\n,]/)
      .map((s) => s.trim().replace(/^\*\./, ''))
      .filter(Boolean);
    for (const n of names) {
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const isSub = host && key !== host.toLowerCase() && key.endsWith('.' + host.toLowerCase());
      out.push(
        evidence(n, 'certificate_transparency', url, {
          entityType: isSub ? 'Subdomain' : 'Certificate',
          confidence: 0.6,
          extra: {
            issuer: row.issuer_name || '',
            notBefore: row.not_before || '',
            notAfter: row.not_after || '',
            id: row.id || null,
            host
          }
        })
      );
    }
  }
  return out;
}

module.exports = { collect, name: 'certs' };
