// services/searchCache.js
// Cache de busca com TTL (T9)

const DEFAULT_TTL = 5 * 60 * 1000;
const cache = new Map();

function get(key) {
  const k = String(key || '').toLowerCase().trim();
  if (!k) return null;
  const entry = cache.get(k);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(k);
    return null;
  }
  return entry.value;
}

function set(key, value, ttl = DEFAULT_TTL) {
  const k = String(key || '').toLowerCase().trim();
  if (!k) return;
  cache.set(k, { value, expiresAt: Date.now() + ttl, createdAt: Date.now() });
}

function remove(key) {
  cache.delete(String(key || '').toLowerCase().trim());
}

function clear() {
  cache.clear();
}

function cleanup() {
  const now = Date.now();
  for (const [k, entry] of cache.entries()) {
    if (now > entry.expiresAt) cache.delete(k);
  }
}

setInterval(cleanup, 60 * 1000).unref?.();

module.exports = {
  get,
  set,
  remove,
  clear,
  cleanup,
  DEFAULT_TTL
};
