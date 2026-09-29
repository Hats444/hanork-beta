// core/router/intent/confidence.js
const DEFAULTS = {
  minConfidence: 0.85,
  url: 0.95,
  identifier: 0.92,
  search: 0.7
};

function applyConfidence(detection, type, minConfidence) {
  if (!detection) return null;
  const conf = typeof detection.confidence === 'number' ? detection.confidence : DEFAULTS[type] || 0.8;
  const floor = typeof minConfidence === 'number' ? minConfidence : DEFAULTS.minConfidence;
  if (conf < floor) return null;
  return { ...detection, confidence: conf };
}

function maskSensitive(value) {
  const s = String(value || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

module.exports = {
  DEFAULTS,
  applyConfidence,
  maskSensitive
};
