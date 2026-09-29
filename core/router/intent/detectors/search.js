// core/router/intent/detectors/search.js
// Texto livre → google (DESATIVADO por padrão — muitos falsos positivos)

function detect(text, opts = {}) {
  if (opts.allowSearch !== true) return null;
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/https?:\/\//i.test(raw)) return null;
  if (/^\d+$/.test(raw.replace(/\D/g, '')) && raw.replace(/\D/g, '').length >= 8) return null;

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 12) return null;
  if (raw.length < 6 || raw.length > 120) return null;

  return {
    route: 'google',
    confidence: 0.72,
    payload: raw,
    priority: 10,
    kind: 'search'
  };
}

module.exports = { detect };
