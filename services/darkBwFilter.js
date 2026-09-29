'use strict';
/**
 * Filtro P&B dark (estilo Instagram: grayscale + contraste alto + brilho baixo).
 * Nao e um filtro oficial (Inkwell / Stark II). Mesmos fatores da foto de referencia.
 */
let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[darkBwFilter] sharp indisponivel:', String(e.message || e).split('\n')[0]);
}

const DEFAULTS = { contrast: 1.35, brightness: 0.92 };

/**
 * @param {string|Buffer} input
 * @param {{ contrast?: number, brightness?: number, quality?: number }} [opts]
 * @returns {Promise<Buffer>} JPEG
 */
async function applyDarkBwFilter(input, opts = {}) {
  if (!sharp) throw new Error('sharp indisponivel');
  const contrast = Number(opts.contrast > 0 ? opts.contrast : DEFAULTS.contrast);
  const brightness = Number(opts.brightness > 0 ? opts.brightness : DEFAULTS.brightness);
  const quality = Math.min(100, Math.max(40, Number(opts.quality) || 95));
  const a = contrast;
  const b = 128 * (1 - contrast) * brightness;
  return sharp(input, { failOn: 'none' })
    .rotate()
    .grayscale()
    .linear(a * brightness, b)
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}

const applyDarkBWFilter = applyDarkBwFilter;
module.exports = { applyDarkBWFilter, applyDarkBwFilter, DEFAULTS };
