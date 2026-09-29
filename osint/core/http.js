'use strict';

const { assertPublicUrl } = require('./guardrails');
const { waitTurn } = require('./rateLimit');

const UA = 'Hanork-OSINT/1.0 (passive public lookup; owner-only)';

async function fetchPublicJson(url, opts = {}) {
  const safe = assertPublicUrl(url);
  if (!opts.skipRate) await waitTurn(opts.rateKey || new URL(safe).hostname);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs || 7000);
  try {
    const res = await fetch(safe, {
      method: 'GET',
      headers: {
        Accept: opts.accept || 'application/json',
        'User-Agent': UA,
        ...(opts.headers && typeof opts.headers === 'object' ? opts.headers : {})
      },
      signal: ac.signal,
      redirect: 'follow'
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`http ${res.status}`);
    if (opts.raw) return text;
    const cleaned = String(text || '').replace(/^\uFEFF/, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch (_) {
      throw new Error('resposta nao e JSON');
    }
  } finally {
    clearTimeout(t);
  }
}

function evidence(value, source, url, extra = {}) {
  return {
    value: String(value || '').slice(0, 500),
    source,
    url: url || '',
    collectedAt: new Date().toISOString(),
    confidence: extra.confidence == null ? 0.5 : extra.confidence,
    status: extra.status || 'UNVERIFIED',
    entityType: extra.entityType || 'Unknown',
    extra: extra.extra || null
  };
}

async function fetchPublicText(url, opts = {}) {
  const safe = assertPublicUrl(url);
  if (!opts.skipRate) await waitTurn(opts.rateKey || new URL(safe).hostname);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs || 7000);
  try {
    const res = await fetch(safe, {
      method: opts.method || 'GET',
      headers: {
        Accept: opts.accept || 'text/html,application/json;q=0.9,*/*;q=0.8',
        'User-Agent': UA,
        ...(opts.headers && typeof opts.headers === 'object' ? opts.headers : {})
      },
      signal: ac.signal,
      redirect: opts.redirect || 'follow'
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, url: safe };
  } finally {
    clearTimeout(t);
  }
}

async function fetchStatus(url, opts = {}) {
  const safe = assertPublicUrl(url);
  if (!opts.skipRate) await waitTurn(opts.rateKey || new URL(safe).hostname);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs || 4000);
  try {
    let res = await fetch(safe, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      signal: ac.signal,
      redirect: 'manual'
    });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(safe, {
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: ac.signal,
        redirect: 'manual'
      });
    }
    return { ok: res.status >= 200 && res.status < 400, status: res.status, url: safe };
  } catch (e) {
    return { ok: false, status: 0, url: safe, error: String(e.message || e).slice(0, 80) };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchPublicJson, fetchPublicText, fetchStatus, evidence, UA };
