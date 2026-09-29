// utils/textChunks.js — divide textos longos (menus WA/TG ~3500–3900)
'use strict';

/**
 * Parte texto por linhas, respeitando maxLen.
 * @param {string} full
 * @param {number} [maxLen=3500]
 * @returns {string[]}
 */
function splitTextParts(full, maxLen = 3500) {
  const text = String(full || '');
  const limit = Math.max(500, Number(maxLen) || 3500);
  if (!text) return [''];
  if (text.length <= limit) return [text];

  const parts = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (line.length > limit) {
      if (buf) {
        parts.push(buf);
        buf = '';
      }
      for (let i = 0; i < line.length; i += limit) {
        parts.push(line.slice(i, i + limit));
      }
      continue;
    }
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > limit && buf) {
      parts.push(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) parts.push(buf);

  if (parts.length <= 1) return parts.length ? parts : [text];
  return parts.map((p, i) => `${p}\n\n(${i + 1}/${parts.length})`);
}

module.exports = { splitTextParts };
