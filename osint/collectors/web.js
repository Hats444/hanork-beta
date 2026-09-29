'use strict';

const { assertPublicUrl } = require('../core/guardrails');
const { waitTurn } = require('../core/rateLimit');
const { evidence, UA } = require('../core/http');

function stripHtml(html) {
  let s = String(html || '');
  const title = (s.match(/<title[^>]*>([^<]{1,200})/i) || [])[1] || '';
  const desc = (s.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})/i) || [])[1]
    || (s.match(/<meta[^>]+content=["']([^"']{1,300})["'][^>]+name=["']description["']/i) || [])[1]
    || '';
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
  return { title: String(title).trim().slice(0, 160), desc: String(desc).trim().slice(0, 240), text: s };
}

function techFrom(res, html) {
  const out = [];
  const push = (name) => {
    const n = String(name || '').trim().slice(0, 80);
    if (n) out.push(n);
  };
  const h = res && res.headers;
  if (h && typeof h.get === 'function') {
    push(h.get('server'));
    push(h.get('x-powered-by'));
  }
  const gen = (html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i) || [])[1];
  push(gen);
  if (/wp-content|wordpress/i.test(html)) push('WordPress');
  if (/\/static\/js\/|react/i.test(html)) push('React');
  const srcs = html.match(/<script[^>]+src=["']([^"']+)/gi) || [];
  for (const s of srcs.slice(0, 10)) {
    if (/jquery/i.test(s)) push('jQuery');
    if (/googletagmanager|gtm\.js/i.test(s)) push('Google Tag Manager');
    if (/cloudflareinsights|cdn-cgi/i.test(s)) push('Cloudflare');
    if (/wp-includes|wp-content/i.test(s)) push('WordPress');
  }
  const srv = h && typeof h.get === 'function' ? String(h.get('server') || '') : '';
  if (/cloudflare/i.test(srv)) push('Cloudflare');
  return [...new Set(out)];
}

function publicEmails(text, pageUrl) {
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const found = [...new Set((String(text || '').match(re) || []).map((s) => s.toLowerCase()))];
  if (found.length > 15) return [];
  const { looksEmail } = require('../core/target');
  const out = [];
  for (const e of found) {
    if (!looksEmail(e)) continue;
    if (/noreply|no-reply|example\.com|wixpress|sentry\.io/.test(e)) continue;
    out.push(evidence(e, 'web', pageUrl, {
      entityType: 'Email',
      confidence: 0.4,
      extra: { from: 'html_publico' }
    }));
    if (out.length >= 12) break;
  }
  return out;
}

function extraDocLinks(html, pageUrl) {
  const out = [];
  try {
    const base = new URL(pageUrl);
    const re = /href=["']([^"']*(?:robots\.txt|sitemap[^"']*\.xml|web\.archive\.org)[^"']*)["']/gi;
    let m;
    while ((m = re.exec(html || '')) && out.length < 6) {
      let href = m[1];
      if (href.startsWith('/')) href = `${base.origin}${href}`;
      try {
        const u = assertPublicUrl(href);
        if (u !== pageUrl) out.push(u);
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
  return out;
}

function publicHrefs(html, pageUrl) {
  const out = [];
  const re = /href=["'](https?:\/\/[^"'>\s]+)["']/gi;
  let m;
    while ((m = re.exec(html || '')) && out.length < 20) {
    try {
      const u = assertPublicUrl(m[1]);
      if (u !== pageUrl) out.push(u);
    } catch (_) { /* ignore */ }
  }
  return out;
}

async function collect(target) {
  const urls = [];
  let query = '';
  const kind = target && typeof target === 'object' ? String(target.kind || '') : '';
  if (target && typeof target === 'object') {
    for (const u of target.urls || []) urls.push(u);
    if (!urls.length && target.host && kind !== 'text' && kind !== 'email' && kind !== 'username') {
      urls.push(`https://${target.host}/`);
    }
    query = String(target.query || target.raw || '').trim();
  } else if (target) {
    urls.push(String(target));
  }
  if (!urls.length && query) {
    return require('./search').collect(target);
  }
  const out = [];
  for (const raw of urls.slice(0, 2)) {
    const url = assertPublicUrl(raw.startsWith('http') ? raw : `https://${raw}`);
    await waitTurn('web:' + new URL(url).hostname);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': UA },
        signal: ac.signal,
        redirect: 'follow'
      });
      const html = await res.text();
      if (!res.ok) throw new Error(`http ${res.status}`);
      const page = stripHtml(html);
      if (page.title) {
        out.push(evidence(page.title, 'web', url, { entityType: 'Organization', confidence: 0.4 }));
      }
      out.push(evidence((page.desc || page.text).slice(0, 400) || url, 'web', url, {
        entityType: 'URL',
        confidence: 0.35,
        extra: { title: page.title }
      }));
      for (const tech of techFrom(res, html)) {
        out.push(evidence(tech, 'web', url, {
          entityType: 'Technology',
          confidence: 0.35,
          extra: { from: 'header_or_html' }
        }));
      }
      for (const href of publicHrefs(html, url).concat(extraDocLinks(html, url))) {
        out.push(evidence(href, 'web', href, {
          entityType: 'URL',
          confidence: 0.3,
          extra: { rel: 'LINKS_TO' }
        }));
      }
      out.push(...publicEmails(`${page.text} ${html.slice(0, 4000)}`, url));
    } finally {
      clearTimeout(t);
    }
  }
  if (!out.length) throw new Error('web: sem pagina publica');
  return out;
}

module.exports = { collect, name: 'web', phase: 2 };
