'use strict';
/**
 * Flags de categoria (default OFF).
 * 1/true/yes liga. Qualquer outro valor (incluindo ausente) = desligado.
 */

function envOn(name) {
  const v = String(process.env[name] || '0').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function nsfwEnabled() {
  return envOn('HANORK_NSFW_ENABLED');
}

function cassinoEnabled() {
  return envOn('HANORK_CASSINO_ENABLED');
}

function ztCategoryAllowed(category, entry) {
  const c = String(category || entry?.category || '').toLowerCase();
  if (c === 'nsfw' || entry?.nsfw === true) return nsfwEnabled();
  if (c === 'cassino') return cassinoEnabled();
  return true;
}

module.exports = { envOn, nsfwEnabled, cassinoEnabled, ztCategoryAllowed };
