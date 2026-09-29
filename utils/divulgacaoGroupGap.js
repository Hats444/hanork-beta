'use strict';
/**
 * Espaco curto entre envios de TIPOS DIFERENTES no MESMO grupo.
 * Nao e fila compartilhada: outros grupos seguem no horario.
 */
const { delay } = require('../utils');

const GAP_MS = Number(process.env.HANORK_DIV_GROUP_GAP_MS || 1800);
const tails = new Map();
const lastClaim = new Map();

async function waitGroupGap(groupJid, gapMs = GAP_MS) {
  const g = String(groupJid || '');
  if (!g) return;
  const waitMs = Number.isFinite(Number(gapMs)) ? Math.max(400, Number(gapMs)) : GAP_MS;
  const prev = tails.get(g) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => {
    release = resolve;
  });
  tails.set(g, prev.then(() => mine, () => mine));
  try {
    await prev.catch(() => {});
    const last = lastClaim.get(g) || 0;
    const wait = waitMs - (Date.now() - last);
    if (wait > 0) await delay(wait);
    lastClaim.set(g, Date.now());
  } finally {
    release();
  }
}

module.exports = { waitGroupGap, GAP_MS };
