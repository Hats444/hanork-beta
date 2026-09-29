'use strict';

const { fetchStatus, evidence } = require('../core/http');

const PLATFORMS = [
  { id: 'github', url: (u) => `https://github.com/${u}` },
  { id: 'gitlab', url: (u) => `https://gitlab.com/${u}` },
  { id: 'reddit', url: (u) => `https://www.reddit.com/user/${u}` },
  { id: 'hackernews', url: (u) => `https://news.ycombinator.com/user?id=${encodeURIComponent(u)}` },
  { id: 'wikipedia', url: (u) => `https://en.wikipedia.org/wiki/User:${encodeURIComponent(u)}` },
  { id: 'keybase', url: (u) => `https://keybase.io/${u}` }
];

function variations(base) {
  const raw = String(base || '').replace(/^@/, '').trim().slice(0, 40);
  if (!raw) return [];
  const out = [raw];
  const add = (s) => {
    const v = String(s || '').trim();
    if (v && v.length >= 2 && v.length <= 40 && !out.includes(v) && out.length < 3) out.push(v);
  };
  if (/[._-]/.test(raw)) {
    add(raw.replace(/[._-]/g, ''));
    add(raw.replace(/[._]/g, '-'));
  }
  return out;
}

async function collect(target) {
  const parsed = target && typeof target === 'object' ? target : { query: String(target || '') };
  const base = String(parsed.username || parsed.query || parsed.raw || '')
    .replace(/^@/, '')
    .trim()
    .split(/\s+/)[0];
  if (!base || base.length < 2) return [];
  const vars = variations(base);
  const jobs = [];
  for (const user of vars) {
    for (const p of PLATFORMS) {
      if (jobs.length >= 18) break;
      jobs.push({ user, p });
    }
  }
  const chunks = await Promise.all(jobs.map(async ({ user, p }) => {
    const url = p.url(user);
    try {
      const st = await fetchStatus(url, { rateKey: `user:${p.id}`, timeoutMs: 4000 });
      const found = !!st.ok;
      return evidence(user, 'username', url, {
        entityType: 'Username',
        confidence: found ? 0.55 : 0.2,
        extra: { platform: p.id, status: found ? 'found' : 'not_found', http: st.status }
      });
    } catch (_) {
      return evidence(user, 'username', url, {
        entityType: 'Username',
        confidence: 0.15,
        extra: { platform: p.id, status: 'error' }
      });
    }
  }));
  return chunks;
}

module.exports = { collect, name: 'username', phase: 2, variations };
