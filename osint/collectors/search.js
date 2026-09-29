'use strict';

const { fetchPublicJson, evidence, UA, fetchPublicText } = require('../core/http');
const { waitTurn } = require('../core/rateLimit');
const { assertPublicUrl } = require('../core/guardrails');
const { braveKey } = require('../core/plan');

const LEAK_HOST = /(haveibeenpwned|dehashed|snusbase|leakcheck|intelx\.io|raidforums|breachforums)/i;
const DUMP_HINT = /\b(combo\s*list|password\s*dump|hash.?dump|leak(ed)?\s*(db|database|sql)|stealer\s*log|full\s*z?ip\s*dump)\b/i;

function isLeakDumpHit(title, url) {
  const t = `${title || ''} ${url || ''}`;
  if (DUMP_HINT.test(t)) return true;
  try {
    const h = new URL(String(url || '')).hostname;
    if (LEAK_HOST.test(h)) return true;
  } catch (_) { /* ignore */ }
  return false;
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function decodeDdgHref(href) {
  const s = String(href || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s, 'https://html.duckduckgo.com/');
    const uddg = u.searchParams.get('uddg');
    if (uddg) {
      try {
        const decoded = decodeURIComponent(uddg);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch (_) { /* ignore */ }
    }
    if (u.hostname && !/(^|\.)duckduckgo\.com$/i.test(u.hostname)) return u.toString();
  } catch (_) { /* ignore */ }
  const m = s.match(/[?&]uddg=([^&]+)/i);
  if (m) {
    try {
      const decoded = decodeURIComponent(m[1]);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch (_) { /* ignore */ }
  }
  return '';
}

function parseDdgHtml(html, opts = {}) {
  const out = [];
  const seen = new Set();
  const limit = Math.min(10, Number(opts.limit) || 10);
  const source = opts.source || 'search';
  const q = String(opts.q || '').slice(0, 80);
  const text = String(html || '');

  function push(href, title) {
    if (out.length >= limit) return;
    const url = decodeDdgHref(href);
    if (!url || seen.has(url)) return;
    if (isLeakDumpHit(title, url)) return;
    try { assertPublicUrl(url); } catch (_) { return; }
    const label = stripHtml(title) || (() => {
      try { return new URL(url).hostname; } catch (_) { return url.slice(0, 80); }
    })();
    if (!label) return;
    seen.add(url);
    out.push(evidence(label.slice(0, 160), source, url, {
      entityType: 'URL',
      confidence: 0.32,
      extra: { search: true, q }
    }));
  }

  const patterns = [
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]*href="([^"]*[?&]uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && out.length < limit) {
      push(m[1], m[2]);
    }
  }
  if (out.length < limit) {
    const uddgRe = /[?&]uddg=([^&"'<>\s]+)/gi;
    let m;
    while ((m = uddgRe.exec(text)) && out.length < limit) {
      try {
        push(decodeURIComponent(m[1]), '');
      } catch (_) { /* ignore */ }
    }
  }
  return out;
}

function looksLikePlace(q) {
  const s = String(q || '');
  if (/\b(joao|jose|maria|silva|souza|pessoa|cpf)\b/i.test(s)) return false;
  return /\b(cidade|munic[ií]pio|pa[ií]s|country|avenida|pra[cç]a|latitude|nominatim)\b/i.test(s)
    || /,\s*[A-Za-zÀ-ú]{3,}$/.test(s.trim());
}

function buildSearchQueries(parsed) {
  let q = String(parsed.query || parsed.raw || parsed.label || '').trim();
  if (parsed.host && (parsed.kind === 'domain' || parsed.kind === 'url' || parsed.kind === 'ip')) {
    q = q && q !== parsed.host ? `${q} ${parsed.host}` : parsed.host;
  }
  q = q.slice(0, 120);
  if (!q) return [];
  const out = [q];
  if (/\s/.test(q)) out.push(`"${q}"`);
  out.push(`${q} filetype:pdf`);
  if (parsed.host && (parsed.kind === 'domain' || parsed.kind === 'url' || parsed.kind === 'ip')) {
    out.push(`"${parsed.host}" (site:pastebin.com OR site:gist.github.com OR site:paste.ee)`);
    out.push(`${parsed.host} site:reddit.com`);
  }
  if (parsed.flags && parsed.flags.since) out.push(`${q} ${parsed.flags.since}`);
  return [...new Set(out)].slice(0, 4);
}

async function wikiHits(query, lang) {
  const out = [];
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return out;
  const wikiHost = lang === 'en' ? 'en.wikipedia.org' : 'pt.wikipedia.org';
  try {
    const url = `https://${wikiHost}/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=8&namespace=0&format=json`;
    const data = await fetchPublicJson(url, { rateKey: wikiHost });
    const titles = Array.isArray(data?.[1]) ? data[1] : [];
    const descs = Array.isArray(data?.[2]) ? data[2] : [];
    const links = Array.isArray(data?.[3]) ? data[3] : [];
    for (let i = 0; i < titles.length && i < 8; i++) {
      const title = String(titles[i] || '').trim();
      if (!title) continue;
      const desc = String(descs[i] || '');
      const link = String(links[i] || '');
      if (isLeakDumpHit(title, link)) continue;
      out.push(evidence(title, 'search', link, {
        entityType: 'URL',
        confidence: 0.35,
        extra: { desc: desc.slice(0, 200), search: true, lang, qid: false }
      }));
    }
  } catch (_) { /* wiki opcional */ }
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=${lang === 'en' ? 'en' : 'pt'}&limit=8&format=json`;
    const data = await fetchPublicJson(url, { rateKey: 'www.wikidata.org' });
    for (const hit of Array.isArray(data?.search) ? data.search.slice(0, 8) : []) {
      const label = String(hit.label || '').trim();
      const id = String(hit.id || '');
      if (!label || !id) continue;
      const desc = String(hit.description || '');
      const human = /\b(human|pessoa|politician|writer|player|actor)\b/i.test(desc);
      const link = String(hit.concepturi || hit.url || `https://www.wikidata.org/wiki/${id}`);
      out.push(evidence(label, 'search', link, {
        entityType: human ? 'Person' : 'Organization',
        confidence: 0.42,
        extra: { desc: desc.slice(0, 200), qid: id, search: true, lang }
      }));
    }
  } catch (_) { /* wikidata opcional */ }
  return out;
}

async function ddgHits(query, opts = {}) {
  const q = String(query || '').trim().slice(0, 160);
  if (!q) return [];
  const source = opts.source || 'search';
  const limit = Math.min(10, Number(opts.limit) || 10);
  const endpoints = [
    { url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, rateKey: 'lite.duckduckgo.com' },
    { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, rateKey: 'html.duckduckgo.com' }
  ];
  for (const ep of endpoints) {
    try {
      const url = assertPublicUrl(ep.url);
      await waitTurn(ep.rateKey);
      const res = await fetchPublicText(url, {
        rateKey: ep.rateKey,
        skipRate: true,
        accept: 'text/html',
        timeoutMs: 6000
      });
      if (!res.ok) continue;
      const hits = parseDdgHtml(res.text, { source, limit, q: q.slice(0, 80) });
      if (hits.length) return hits;
    } catch (_) { /* tenta o outro endpoint */ }
  }
  return [];
}

async function braveHits(query) {
  const key = braveKey();
  if (!key) return [];
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return [];
  const out = [];
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8`;
    const data = await fetchPublicJson(url, {
      rateKey: 'api.search.brave.com',
      headers: { 'X-Subscription-Token': key, Accept: 'application/json', 'User-Agent': UA }
    });
    const web = data && data.web && Array.isArray(data.web.results) ? data.web.results : [];
    for (const hit of web.slice(0, 8)) {
      const title = String(hit.title || '').trim();
      const link = String(hit.url || '');
      if (!title || !link) continue;
      if (isLeakDumpHit(title, link)) continue;
      out.push(evidence(title, 'search', link, {
        entityType: 'URL',
        confidence: 0.4,
        extra: { search: true, via: 'brave' }
      }));
    }
  } catch (_) { /* brave opcional */ }
  return out;
}

async function nominatimHits(query) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q || !looksLikePlace(q)) return [];
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=3`;
    const data = await fetchPublicJson(url, { rateKey: 'nominatim.openstreetmap.org' });
    const out = [];
    for (const hit of Array.isArray(data) ? data.slice(0, 3) : []) {
      const label = String(hit.display_name || '').trim();
      const osm = hit.osm_id ? `https://www.openstreetmap.org/${hit.osm_type || 'node'}/${hit.osm_id}` : '';
      if (!label) continue;
      out.push(evidence(label, 'search', osm, {
        entityType: 'Organization',
        confidence: 0.4,
        extra: { place: true, lat: hit.lat, lon: hit.lon }
      }));
    }
    return out;
  } catch (_) {
    return [];
  }
}

async function ddgInstant(query) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return [];
  const out = [];
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
    const data = await fetchPublicJson(url, { rateKey: 'api.duckduckgo.com', timeoutMs: 6000 });
    const push = (title, link) => {
      if (!title || !link || isLeakDumpHit(title, link)) return;
      try { assertPublicUrl(link); } catch (_) { return; }
      out.push(evidence(String(title).slice(0, 160), 'search', link, {
        entityType: 'URL',
        confidence: 0.38,
        extra: { search: true, via: 'ddg_instant' }
      }));
    };
    if (data && data.AbstractURL) push(data.Heading || data.AbstractText || q, data.AbstractURL);
    const rel = Array.isArray(data && data.RelatedTopics) ? data.RelatedTopics : [];
    for (const t of rel.slice(0, 8)) {
      if (t && t.FirstURL) push(t.Text || t.FirstURL, t.FirstURL);
      if (t && Array.isArray(t.Topics)) {
        for (const s of t.Topics.slice(0, 4)) {
          if (s && s.FirstURL) push(s.Text || s.FirstURL, s.FirstURL);
        }
      }
    }
    const res = Array.isArray(data && data.Results) ? data.Results : [];
    for (const r of res.slice(0, 6)) {
      if (r && r.FirstURL) push(r.Text || r.FirstURL, r.FirstURL);
    }
  } catch (_) { /* instant answer opcional */ }
  return out.slice(0, 10);
}

async function urlscanHits(parsed) {
  const host = String((parsed && parsed.host) || '').trim().toLowerCase();
  if (!host || host === 't.me' || host === 'github.com' || host === 'discord.com') return [];
  if (!/^[a-z0-9.-]+$/.test(host) && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return [];
  const out = [];
  try {
    const q = encodeURIComponent(
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) ? `ip:${host}` : `domain:${host}`
    );
    const url = `https://urlscan.io/api/v1/search/?q=${q}&size=15`;
    const data = await fetchPublicJson(url, { rateKey: 'urlscan.io', timeoutMs: 7000 });
    const rows = Array.isArray(data && data.results) ? data.results : [];
    for (const row of rows.slice(0, 15)) {
      const page = row && row.page ? row.page : {};
      const link = String(page.url || (row.task && row.task.url) || '').trim();
      const title = String(page.domain || page.title || link).slice(0, 160);
      if (!link || isLeakDumpHit(title, link)) continue;
      try { assertPublicUrl(link); } catch (_) { continue; }
      out.push(evidence(title, 'search', link, {
        entityType: 'URL',
        confidence: 0.4,
        extra: { search: true, via: 'urlscan', country: page.country || '' }
      }));
    }
  } catch (_) { /* urlscan opcional; 429 nao mata o job */ }
  return out;
}

async function collect(target) {
  const parsed = target && typeof target === 'object' ? target : { query: String(target || '') };
  const queries = buildSearchQueries(parsed);
  if (!queries.length) return [];
  const lang = (parsed.flags && parsed.flags.lang) || 'pt';
  const alt = lang === 'en' ? 'pt' : 'en';
  const parts = await Promise.all([
    wikiHits(queries[0], lang),
    wikiHits(queries[0], alt),
    ddgInstant(queries[0]),
    ...queries.map((q) => ddgHits(q)),
    braveHits(queries[0]),
    nominatimHits(queries[0]),
    urlscanHits(parsed)
  ]);
  const out = [];
  for (const chunk of parts) out.push(...(chunk || []));
  return out;
}

module.exports = {
  collect,
  name: 'search',
  phase: 2,
  wikiHits,
  ddgHits,
  parseDdgHtml,
  decodeDdgHref,
  isLeakDumpHit,
  buildSearchQueries,
  looksLikePlace,
  ddgInstant,
  urlscanHits
};
