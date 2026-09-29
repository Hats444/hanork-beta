'use strict';

const { evidence } = require('../core/http');

const BTC = /\b(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}\b/g;
const ETH = /\b0x[a-fA-F0-9]{40}\b/g;

function scanBlobs(blobs) {
  const out = [];
  const seen = new Set();
  const push = (addr, kind, url) => {
    const v = String(addr);
    if (seen.has(v)) return;
    seen.add(v);
    out.push(evidence(v, 'crypto', url, {
      entityType: 'Wallet',
      confidence: 0.45,
      extra: { chain: kind }
    }));
  };
  for (const blob of blobs || []) {
    const t = String(blob || '');
    for (const m of t.match(BTC) || []) {
      if (m.length < 26) continue;
      push(m, 'btc', `https://www.blockchain.com/explorer/addresses/btc/${encodeURIComponent(m)}`);
    }
    for (const m of t.match(ETH) || []) {
      push(m, 'eth', `https://etherscan.io/address/${m}`);
    }
  }
  return out.slice(0, 12);
}

function collect(target) {
  const parsed = target && typeof target === 'object' ? target : { raw: String(target || '') };
  return scanBlobs([parsed.raw, parsed.query, parsed.label]);
}

function scanEvidence(raw) {
  return scanBlobs((raw || []).map((e) => `${e.value || ''} ${e.url || ''}`));
}

module.exports = { collect, scanEvidence, name: 'crypto', phase: 2 };
