'use strict';

const crypto = require('crypto');
const { fetchStatus, evidence } = require('../core/http');
const { looksEmail } = require('../core/target');

function huntInBlobs(blobs) {
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const blob of blobs || []) {
    const ms = String(blob || '').match(re) || [];
    total += ms.length;
    if (total > 20) return [];
    for (const raw of ms) {
      const email = String(raw).toLowerCase();
      if (seen.has(email) || !looksEmail(email)) continue;
      if (/noreply|no-reply|example\.com|wixpress|sentry\.io|cloudflare/.test(email)) continue;
      seen.add(email);
      out.push(evidence(email, 'email', '', {
        entityType: 'Email',
        confidence: 0.4,
        extra: { from: 'page_mention', note: 'mencao publica; sem leak db' }
      }));
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function gravatarHash(email) {
  return crypto.createHash('md5').update(String(email).trim().toLowerCase()).digest('hex');
}

async function collect(target) {
  const parsed = target && typeof target === 'object' ? target : { raw: String(target || '') };
  const email = String(parsed.email || parsed.query || parsed.raw || '').trim().toLowerCase();
  if (!looksEmail(email)) return [];
  const hash = gravatarHash(email);
  const url = `https://www.gravatar.com/avatar/${hash}?d=404`;
  const out = [
    evidence(email, 'email', '', {
      entityType: 'Email',
      confidence: 0.5,
      extra: { note: 'formato; sem consulta a vazamento' }
    })
  ];
  try {
    const st = await fetchStatus(url, { rateKey: 'www.gravatar.com', timeoutMs: 8000 });
    out.push(evidence(email, 'gravatar', url, {
      entityType: 'Email',
      confidence: st.ok ? 0.55 : 0.3,
      extra: { gravatar: st.ok ? 'perfil_publico' : 'sem_avatar', http: st.status }
    }));
  } catch (_) { /* gravatar opcional */ }
  return out;
}

module.exports = { collect, name: 'email', phase: 2, gravatarHash, huntInBlobs };
