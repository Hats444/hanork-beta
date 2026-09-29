'use strict';

const { assertPassiveTarget, sanitizeHostname, isOnionHost, isPrivateIpv4 } = require('./guardrails');

const MODULES = new Set([
  'dns', 'whois', 'certs', 'all', 'github', 'web',
  'search', 'archive', 'username', 'email', 'wiki', 'media', 'pastes'
]);
const GH_USER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const TEXT_MODE = /^(texto|text|geral|normal)\b/i;
const TEXT_MODE_TOKEN = /^(texto|text|geral|normal)$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function stripCommand(raw) {
  return String(raw || '')
    .replace(/^[.\-!$/#]*osint\b/i, '')
    .trim();
}

function stripTextMode(raw) {
  let t = String(raw || '').trim();
  if (TEXT_MODE_TOKEN.test(t)) return '';
  t = t.replace(/^(texto|text|geral|normal)\s+/i, '').trim();
  return t;
}

function extractFlags(raw) {
  const flags = {};
  let t = String(raw || '').trim();
  t = t.replace(/\blang=([a-z]{2})\b/ig, (_, v) => {
    flags.lang = String(v).toLowerCase();
    return ' ';
  });
  t = t.replace(/\bsince=(\d{4})\b/g, (_, v) => {
    flags.since = String(v);
    return ' ';
  });
  return { raw: t.replace(/\s+/g, ' ').trim(), flags };
}

function parseCompare(raw) {
  const t = String(raw || '').trim();
  const m = t.match(/^compare\s+(.+?)\s*\|\s*(.+)$/i);
  if (!m) return null;
  return { a: m[1].trim(), b: m[2].trim() };
}

function hostOf(target) {
  if (target && typeof target === 'object') {
    return String(target.host || target.hostname || '').trim().toLowerCase();
  }
  return String(target || '').trim().toLowerCase();
}

function parseGithubPath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (!parts.length) return { user: '', repo: '' };
  const user = GH_USER.test(parts[0]) ? parts[0] : '';
  let repo = parts[1] || '';
  if (repo) repo = repo.replace(/\.git$/i, '').split(/[?#]/)[0];
  if (repo && !/^[A-Za-z0-9._-]+$/.test(repo)) repo = '';
  return { user, repo };
}

function isGithubHost(hostname) {
  return /(^|\.)github\.com$/i.test(String(hostname || ''));
}

function looksEmail(s) {
  return EMAIL_RE.test(String(s || '').trim());
}

function parseOsintTarget(raw) {
  const extracted = extractFlags(stripTextMode(stripCommand(raw)));
  const stripped = extracted.raw;
  assertPassiveTarget(stripped);
  const original = stripped;
  const urls = [];
  const urlRe = /https?:\/\/[^\s<>"']+/gi;
  let m;
  const copy = original;
  while ((m = urlRe.exec(copy))) {
    urls.push(m[0].replace(/[),.;]+$/, ''));
  }

  let host = '';
  let githubUser = '';
  let githubRepo = '';
  let kind = 'text';
  let onion = false;

  for (const u of urls) {
    try {
      const p = new URL(u);
      const h = p.hostname.replace(/^www\./i, '').toLowerCase();
      if (isOnionHost(h)) {
        onion = true;
        kind = 'onion';
        host = h;
        break;
      }
      if (!host) host = h;
      if (isGithubHost(h)) {
        const gh = parseGithubPath(p.pathname);
        if (gh.user) {
          githubUser = gh.user;
          githubRepo = gh.repo;
          kind = 'github';
        } else if (kind !== 'github') {
          kind = 'url';
        }
      } else if (kind !== 'github' && kind !== 'onion') {
        kind = 'url';
      }
    } catch (_) { /* ignore bad url */ }
  }

  if (/\.onion\b/i.test(original) && kind !== 'github') {
    onion = true;
    kind = 'onion';
  }

  const remainder = original
    .replace(urlRe, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!githubUser) {
    const ghBare = remainder.match(/\bgithub\.com\/([A-Za-z0-9-]+)(?:\/([A-Za-z0-9._-]+))?/i);
    if (ghBare) {
      githubUser = ghBare[1];
      githubRepo = (ghBare[2] || '').replace(/\.git$/i, '');
      kind = 'github';
      if (!host) host = 'github.com';
    }
  }

  if (!onion && !githubUser) {
    const tm = (remainder.match(/\b(?:t(?:elegram)?\.me)\/([A-Za-z0-9_]{4,32})\b/i) || original.match(/\b(?:t(?:elegram)?\.me)\/([A-Za-z0-9_]{4,32})\b/i) || [])[1];
    if (tm && !/^joinchat$/i.test(tm)) {
      kind = 'url';
      host = 't.me';
      if (!urls.some((u) => /t\.me\//i.test(u))) urls.push(`https://t.me/${tm}`);
    }
  }

  if (!onion && !githubUser) {
    const disc = original.match(/\bdiscord\.com\/users\/(\d{5,32})\b/i);
    if (disc) {
      kind = 'url';
      host = 'discord.com';
      const u = `https://discord.com/users/${disc[1]}`;
      if (!urls.includes(u)) urls.push(u);
    }
  }

  if (!onion && !host) {
    const token = remainder.split(/\s+/).find((t) => t.includes('.') && !t.startsWith('@') && !/^github\.com$/i.test(t) && !/^t(?:elegram)?\.me\//i.test(t));
    if (token && !token.includes('@') && !/\bgithub\.com\//i.test(token)) {
      if (isOnionHost(token) || /\.onion\b/i.test(token)) {
        onion = true;
        kind = 'onion';
        host = token.replace(/^https?:\/\//i, '').split('/')[0];
      } else if (IPV4_RE.test(token)) {
        if (isPrivateIpv4(token)) throw new Error('IP privado/reservado nao e alvo publico');
        host = token;
        kind = 'ip';
      } else {
        try {
          host = sanitizeHostname(token);
          if (kind === 'text') kind = 'domain';
        } catch (_) { /* not a host */ }
      }
    }
  } else if (kind === 'url' || kind === 'github') {
    try { if (host && host !== 't.me') host = sanitizeHostname(host); } catch (_) { /* keep */ }
  }

  const query = remainder
    .replace(/^@/, '')
    .replace(/\bgithub\.com\/[^\s]+/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const q0 = (query || original).trim();
  if (!onion && kind === 'text') {
    if (looksEmail(q0)) kind = 'email';
    else if (/^@[\w.-]{2,40}$/.test(original.trim()) || /^@[\w.-]{2,40}$/.test(q0)) kind = 'username';
  }

  return {
    raw: original.slice(0, 400),
    kind,
    host,
    githubUser,
    githubRepo,
    urls: urls.slice(0, 5),
    query: (query || original).slice(0, 400),
    email: kind === 'email' ? q0.toLowerCase() : '',
    username: kind === 'username' ? q0.replace(/^@/, '') : '',
    flags: extracted.flags,
    onion,
    label: kind === 'github' && githubUser
      ? (githubRepo ? `github.com/${githubUser}/${githubRepo}` : `github.com/${githubUser}`)
      : (kind === 'email' ? q0.toLowerCase() : (kind === 'username' ? '@' + q0.replace(/^@/, '') : (host || query || original).slice(0, 80)))
  };
}

function defaultCollectors(parsed) {
  const kind = String(parsed?.kind || '');
  if (kind === 'onion') return [];
  if (kind === 'github') return ['github'];
  if (kind === 'email') return ['email', 'github', 'search', 'pastes'];
  if (kind === 'username') return ['username', 'github', 'search', 'pastes'];
  if (kind === 'ip') return ['rdap', 'search', 'pastes'];
  const extra = [];
  if (parsed && parsed.media && parsed.media.sha256) extra.push('media');
  if (kind === 'url' && (parsed.host === 't.me' || parsed.host === 'discord.com')) {
    return ['web', 'search', 'pastes'].concat(extra);
  }
  if (kind === 'url' && parsed.host) {
    return ['web', 'dns', 'rdap', 'whois', 'certs', 'archive', 'search', 'github', 'pastes'].concat(extra);
  }
  if (kind === 'domain' || (parsed?.host && kind !== 'text')) {
    return ['dns', 'rdap', 'whois', 'certs', 'web', 'github', 'archive', 'search', 'pastes'].concat(extra);
  }
  const textMods = ['search', 'github', 'web', 'pastes'];
  const q = String(parsed?.query || '').trim();
  if (q && !/\s/.test(q) && !q.includes('.') && !looksEmail(q)) textMods.push('username');
  return textMods.concat(extra);
}

function pickModulesFor(mod, parsed) {
  if (parsed && parsed.kind === 'onion') return [];
  const m = String(mod || '').toLowerCase();
  if (m && MODULES.has(m) && m !== 'all') {
    if (m === 'github') return ['github'];
    if (m === 'web') return ['web'];
    if (m === 'dns') return ['dns'];
    if (m === 'whois') return ['rdap', 'whois'];
    if (m === 'certs') return ['certs'];
    if (m === 'search') return ['search'];
    if (m === 'archive') return ['archive'];
    if (m === 'username') return ['username'];
    if (m === 'email') return ['email'];
    if (m === 'wiki') return ['search'];
    if (m === 'media') return ['media'];
    if (m === 'pastes') return ['pastes'];
  }
  return defaultCollectors(parsed);
}

module.exports = {
  stripCommand,
  stripTextMode,
  extractFlags,
  parseCompare,
  hostOf,
  parseOsintTarget,
  pickModulesFor,
  defaultCollectors,
  looksEmail,
  GH_USER,
  TEXT_MODE,
  MODULES
};
