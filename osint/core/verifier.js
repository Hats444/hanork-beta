'use strict';

const { families, score } = require('./confidence');

function maybeStale(ent) {
  const times = (ent.evidences || [])
    .map((e) => Date.parse(e.collectedAt))
    .filter(Number.isFinite);
  if (!times.length) return false;
  return Date.now() - Math.max(...times) > 90 * 86400000;
}

function maybeContradicted(ent) {
  const extras = (ent.evidences || []).map((e) => e.extra).filter(Boolean);
  if (extras.length < 2) return false;
  const ips = new Set();
  for (const x of extras) {
    const ip = x.ip || x.address || x.A;
    if (typeof ip === 'string' && ip) ips.add(ip);
  }
  return ips.size >= 2;
}

/**
 * VERIFIED exige 2+ familias independentes no mesmo valor.
 * Uma fonte so nunca confirma.
 */
function verify(entities) {
  return (entities || []).map((ent) => {
    const fam = families(ent.sources);
    const n = fam.size;
    let status = 'UNVERIFIED';
    if (n >= 2) status = 'VERIFIED';
    else if (n === 1 && (ent.evidences || []).length >= 2) status = 'PARTIALLY_VERIFIED';
    else if (n === 1) status = 'UNVERIFIED';
    if (maybeContradicted(ent)) status = 'CONTRADICTED';
    if (maybeStale(ent)) status = 'STALE';
    return {
      ...ent,
      status,
      confidence: score(ent.sources),
      independentSources: n,
      evidencePath: (ent.evidences || []).slice(0, 12).map((e) => ({
        source: e.source,
        url: e.url || '',
        collectedAt: e.collectedAt || ''
      }))
    };
  });
}

function overallConfidence(entities) {
  const list = entities || [];
  if (!list.length) return 0;
  const verified = list.filter((e) => e.status === 'VERIFIED').length;
  return Number((verified / list.length).toFixed(2));
}

module.exports = { verify, overallConfidence };
