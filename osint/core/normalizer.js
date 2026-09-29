'use strict';

const { stripForbiddenPii, looksLikeBrCpf } = require('./guardrails');

const ALLOWED_TYPES = new Set([
  'Domain', 'IP', 'ASN', 'Certificate', 'Organization',
  'Username', 'Repository', 'URL', 'Email', 'Person',
  'Subdomain', 'Technology', 'Wallet', 'FileHash'
]);

function normValue(raw, entityType) {
  let v = stripForbiddenPii(String(raw || '').trim());
  if (!v || v === '[redacted-br-id]' || v === '[redacted-phone]') return '';
  if (looksLikeBrCpf(v)) return '';
  if (entityType === 'Domain' || entityType === 'Certificate') {
    v = v.replace(/\.$/, '').toLowerCase();
    v = v.replace(/^["']|["']$/g, '');
  }
  if (!v || v === '.' || v === '@') return '';
  if (/\b(ghp_|sk_live|AKIA)[A-Za-z0-9]/i.test(v)) return '[redacted-possible-secret]';
  if (entityType === 'IP') v = v.trim();
  return v.slice(0, 400);
}

function normalizeEvidence(rawList) {
  const out = [];
  for (const item of rawList || []) {
    const entityType = ALLOWED_TYPES.has(item.entityType) ? item.entityType : null;
    if (!entityType) continue;
    let value = normValue(item.value, entityType);
    const secretHit = /\b(ghp_|sk_live|AKIA)[A-Za-z0-9]/i.test(String(item.value || ''));
    if (secretHit) {
      out.push({
        value: '[redacted-possible-secret]',
        source: String(item.source || 'unknown'),
        url: String(item.url || ''),
        collectedAt: item.collectedAt || new Date().toISOString(),
        confidence: 0.2,
        status: 'UNVERIFIED',
        entityType: 'URL',
        extra: { kind: 'possible_secret', note: 'valor omitido; nao usar' }
      });
      continue;
    }
    if (!value) continue;
    if (/\[redacted-br-id\]|\[redacted-phone\]/i.test(value)) continue;
    out.push({
      value,
      source: String(item.source || 'unknown'),
      url: String(item.url || ''),
      collectedAt: item.collectedAt || new Date().toISOString(),
      confidence: Number(item.confidence) || 0.5,
      status: 'UNVERIFIED',
      entityType,
      extra: item.extra || null
    });
  }
  return out;
}

module.exports = { normalizeEvidence, ALLOWED_TYPES, normValue };
