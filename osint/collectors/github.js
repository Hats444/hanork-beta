'use strict';

const { fetchPublicJson, evidence, UA } = require('../core/http');
const { waitTurn } = require('../core/rateLimit');
const { GH_USER, hostOf } = require('../core/target');

const API = 'https://api.github.com';

function ghHeaders() {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const tok = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (tok) h.Authorization = `Bearer ${tok}`;
  return h;
}

function ghGet(path) {
  return fetchPublicJson(`${API}${path}`, {
    rateKey: 'api.github.com',
    headers: ghHeaders()
  });
}

function pushUser(out, user, url) {
  if (!user || typeof user !== 'object') return;
  const login = String(user.login || '').trim();
  if (login) {
    out.push(evidence(login, 'github', url || user.html_url, {
      entityType: 'Username',
      confidence: 0.8,
      extra: { type: user.type, id: user.id }
    }));
  }
  if (user.name) {
    out.push(evidence(user.name, 'github', user.html_url, {
      entityType: 'Person',
      confidence: 0.55
    }));
  }
  if (user.company) {
    out.push(evidence(String(user.company).replace(/^@/, ''), 'github', user.html_url, {
      entityType: 'Organization',
      confidence: 0.5
    }));
  }
  if (user.blog) {
    out.push(evidence(String(user.blog), 'github', user.html_url, {
      entityType: 'URL',
      confidence: 0.45
    }));
  }
  if (user.email) {
    out.push(evidence(String(user.email), 'github', user.html_url, {
      entityType: 'Email',
      confidence: 0.6
    }));
  }
  if (user.location) {
    out.push(evidence(String(user.location), 'github', user.html_url, {
      entityType: 'Organization',
      confidence: 0.35,
      extra: { field: 'location' }
    }));
  }
}

async function collectUserRepo(user, repo) {
  await waitTurn('github:' + String(user).toLowerCase());
  const out = [];
  const userUrl = `${API}/users/${encodeURIComponent(user)}`;
  const profile = await ghGet(`/users/${encodeURIComponent(user)}`);
  pushUser(out, profile, profile.html_url || `https://github.com/${user}`);

  try {
    const repos = await ghGet(`/users/${encodeURIComponent(user)}/repos?per_page=20&sort=updated`);
    for (const r of Array.isArray(repos) ? repos.slice(0, 20) : []) {
      if (!r || !r.full_name) continue;
      out.push(evidence(r.full_name, 'github', r.html_url, {
        entityType: 'Repository',
        confidence: 0.7,
        extra: { stars: r.stargazers_count, language: r.language }
      }));
    }
  } catch (_) { /* public list opcional */ }

  if (repo) {
    const full = `${user}/${repo}`;
    try {
      const r = await ghGet(`/repos/${encodeURIComponent(user)}/${encodeURIComponent(repo)}`);
      out.push(evidence(r.full_name || full, 'github', r.html_url, {
        entityType: 'Repository',
        confidence: 0.85,
        extra: { description: r.description, language: r.language }
      }));
      if (r.homepage) {
        out.push(evidence(r.homepage, 'github', r.html_url, {
          entityType: 'URL',
          confidence: 0.5
        }));
      }
      if (r.owner) pushUser(out, r.owner, r.owner.html_url);
    } catch (e) {
      out.push(evidence(full, 'github', userUrl, {
        entityType: 'Repository',
        confidence: 0.3,
        extra: { note: String(e.message || e).slice(0, 80) }
      }));
    }
  }

  return out;
}

async function searchPublic(query) {
  const q = encodeURIComponent(String(query || '').trim().slice(0, 120));
  if (!q) return [];
  const out = [];
  await waitTurn('github:search');
  try {
    const users = await ghGet(`/search/users?q=${q}&per_page=15`);
    for (const u of Array.isArray(users?.items) ? users.items.slice(0, 15) : []) {
      pushUser(out, u, u.html_url);
    }
  } catch (_) { /* busca publica opcional */ }
  try {
    const repos = await ghGet(`/search/repositories?q=${q}&per_page=15`);
    for (const r of Array.isArray(repos?.items) ? repos.items.slice(0, 15) : []) {
      if (!r || !r.full_name) continue;
      out.push(evidence(r.full_name, 'github', r.html_url, {
        entityType: 'Repository',
        confidence: 0.55,
        extra: { stars: r.stargazers_count, language: r.language, search: true }
      }));
    }
  } catch (_) { /* busca publica opcional */ }
  try {
    const issues = await ghGet(`/search/issues?q=${q}&per_page=15`);
    for (const it of Array.isArray(issues?.items) ? issues.items.slice(0, 15) : []) {
      const title = String(it.title || '').trim();
      const link = String(it.html_url || '');
      if (!title || !link) continue;
      out.push(evidence(title, 'github', link, {
        entityType: 'URL',
        confidence: 0.45,
        extra: { search: true, kind: 'issue' }
      }));
    }
  } catch (_) { /* issues publicos opcional */ }
  return out;
}

async function collect(target) {
  const parsed = target && typeof target === 'object' ? target : { githubUser: '', query: String(target || ''), host: hostOf(target) };
  const kind = String(parsed.kind || '');
  const query = String(parsed.query || parsed.raw || '').trim();
  const user = String(parsed.githubUser || '').trim();
  const repo = String(parsed.githubRepo || '').trim();

  if (kind === 'github' && user) {
    try {
      return await collectUserRepo(user, repo);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 80);
      if (/http 403|http 429/i.test(msg)) return [];
      throw e;
    }
  }

  const out = [];
  if (query) {
    try {
      out.push(...await searchPublic(query));
    } catch (_) { /* segue fallback */ }
  }
  if (kind === 'email' && query) {
    try {
      out.push(...await searchPublic(`${query} in:email`));
    } catch (_) { /* github email search opcional */ }
  }
  const host = String(parsed.host || '').trim();
  if (host && kind !== 'github' && host !== 'github.com') {
    try {
      out.push(...await searchPublic(host));
    } catch (_) { /* busca por dominio opcional */ }
  }
  if (!out.length && query && !/\s/.test(query) && GH_USER.test(query)) {
    try {
      out.push(...await collectUserRepo(query, ''));
    } catch (e) {
      if (!/http 403|http 429/i.test(String(e.message || e))) {
        /* sem perfil publico */
      }
    }
  }
  return out;
}

module.exports = { collect, name: 'github', phase: 2 };
