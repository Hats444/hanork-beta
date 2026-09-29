'use strict';

const lastHit = new Map();
const chain = new Map();

function gapMs() {
  const n = parseInt(process.env.OSINT_COLLECTOR_GAP_MS, 10);
  if (Number.isFinite(n) && n >= 0) return Math.min(60000, n);
  return 400;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fila por host: gap curto entre hits no mesmo destino.
 * Coletores diferentes (dns vs github vs wiki) andam em paralelo.
 */
async function waitTurn(key) {
  const k = String(key || 'default');
  const prev = chain.get(k) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  chain.set(k, prev.then(() => next, () => next));
  try {
    await prev;
    const wait = gapMs() - (Date.now() - (lastHit.get(k) || 0));
    if (wait > 0) await sleep(wait);
    lastHit.set(k, Date.now());
  } finally {
    release();
  }
}

module.exports = { waitTurn, gapMs };
