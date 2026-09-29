'use strict';
/**
 * core/osint/cache.js — Cache com TTL do Hanork OSINT Intelligence.
 *
 * Objetivo: nao bater de novo no mesmo provedor para o mesmo alvo dentro da
 * janela de validade (protege contra 429/rate-limit das APIs pagas e gratis).
 *
 * Camadas:
 *  1. memoria do processo (instantaneo);
 *  2. SQLite kv via utils/ttlStore (sobrevive a restart) — opcional, falha muda.
 *
 * Regra dura: NUNCA cacheia alvo diferente nem a resposta crua de provedor de
 * vazamento com segredo — so o que o provedor ja devolveu mascarado.
 */

const crypto = require('crypto');
const logger = require('../../logger');

/** TTL default por familia de provedor (ms). OSINT_CACHE_TTL_MS sobrescreve tudo. */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

const TTL_BY_PROVIDER = {
  whois: 6 * 60 * 60 * 1000,
  crtsh: 60 * 60 * 1000,
  dnsdumpster: 6 * 60 * 60 * 1000,
  shodan: 30 * 60 * 1000,
  censys: 30 * 60 * 1000,
  virustotal: 30 * 60 * 1000,
  otx: 60 * 60 * 1000,
  abuseipdb: 30 * 60 * 1000,
  urlscan: 60 * 60 * 1000,
  sherlock: 24 * 60 * 60 * 1000,
  whatsmyname: 24 * 60 * 60 * 1000,
  epieos: 12 * 60 * 60 * 1000,
  hibp: 24 * 60 * 60 * 1000,
  dehashed: 12 * 60 * 60 * 1000,
  leakcheck: 12 * 60 * 60 * 1000,
  intelx: 12 * 60 * 60 * 1000,
  tineye: 24 * 60 * 60 * 1000,
  yandex: 6 * 60 * 60 * 1000,
  picarta: 24 * 60 * 60 * 1000,
  exif: 7 * 24 * 60 * 60 * 1000
};

const memory = new Map();
const MAX_ENTRIES = 500;

function envTtl() {
  const n = Number(process.env.OSINT_CACHE_TTL_MS);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.max(n, 0), 24 * 60 * 60 * 1000);
  return DEFAULT_TTL_MS;
}

function cacheEnabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.OSINT_CACHE ?? '1').trim());
}

function ttlFor(provider) {
  const env = envTtl();
  const specific = TTL_BY_PROVIDER[String(provider || '').toLowerCase()];
  // OSINT_CACHE_TTL_MS=0 desliga de vez; senao o TTL especifico vence o default.
  if (env === 0) return 0;
  return specific && specific > env ? specific : env;
}

function hashKey(provider, target) {
  return crypto
    .createHash('sha256')
    .update(`${String(provider || 'x').toLowerCase()}|${String(target || '').toLowerCase().trim()}`)
    .digest('hex')
    .slice(0, 32);
}

function sqlStore() {
  try {
    return require('../../utils/ttlStore');
  } catch (_) {
    return null;
  }
}

function prune() {
  if (memory.size <= MAX_ENTRIES) return;
  const entries = [...memory.entries()].sort((a, b) => (a[1]?.exp || 0) - (b[1]?.exp || 0));
  for (const [k] of entries.slice(0, memory.size - MAX_ENTRIES)) memory.delete(k);
}

/** Le das duas camadas. Devolve null quando ausente/expirado. */
function get(provider, target) {
  if (!cacheEnabled()) return null;
  const key = hashKey(provider, target);
  const hit = memory.get(key);
  if (hit && Number(hit.exp) > Date.now()) {
    return { value: hit.value, cached: true, via: 'memory', ageMs: Date.now() - Number(hit.at || 0) };
  }
  if (hit) memory.delete(key);
  const store = sqlStore();
  if (store) {
    try {
      const persisted = store.get(`osint_cache:${provider}`, key);
      if (persisted != null) {
        const ttl = ttlFor(provider);
        memory.set(key, { value: persisted, exp: Date.now() + Math.min(ttl, 60 * 1000), at: Date.now() });
        prune();
        return { value: persisted, cached: true, via: 'disk', ageMs: 0 };
      }
    } catch (_) { /* cache e otimizacao, nunca erro */ }
  }
  return null;
}

function set(provider, target, value) {
  if (!cacheEnabled()) return false;
  const ttl = ttlFor(provider);
  if (ttl <= 0) return false;
  const key = hashKey(provider, target);
  memory.set(key, { value, exp: Date.now() + ttl, at: Date.now() });
  prune();
  const store = sqlStore();
  if (store) {
    try {
      store.set(`osint_cache:${provider}`, key, value, ttl);
    } catch (_) { /* ignore */ }
  }
  return true;
}

/**
 * Wrapper padrão dos provedores:
 *   const rows = await cached('shodan', ip, () => lookup(ip));
 * O loader so roda em miss. Erro do loader NUNCA entra no cache.
 */
async function getOrSet(provider, target, loader) {
  const hit = get(provider, target);
  if (hit) return hit.value;
  const fresh = await loader();
  if (fresh != null) set(provider, target, fresh);
  return fresh;
}

function clear(provider) {
  if (provider) {
    for (const k of [...memory.keys()]) {
      if (String(k).includes(String(provider))) memory.delete(k);
    }
    return;
  }
  memory.clear();
}

function stats() {
  let live = 0;
  const now = Date.now();
  for (const v of memory.values()) if (Number(v?.exp) > now) live++;
  return { entries: memory.size, live, ttlMs: envTtl(), enabled: cacheEnabled() };
}

module.exports = {
  get,
  set,
  getOrSet,
  clear,
  stats,
  ttlFor,
  cacheEnabled,
  hashKey,
  logger
};