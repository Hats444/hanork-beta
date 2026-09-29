// core/router/intent/detectors/urls.js
// Detecta links de plataformas com handler em commands/downloads.js

const PATTERNS = [
  {
    route: 'tiktok',
    priority: 100,
    re: /https?:\/\/(?:www\.|vm\.|vt\.)?(?:tiktok\.com|tiktokv\.com)\/\S+/i
  },
  {
    route: 'instagram',
    priority: 100,
    re: /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv|stories)\/\S+/i
  },
  {
    route: 'play',
    priority: 90,
    re: /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)\S+/i
  }
];

/**
 * @returns {{ route: string, confidence: number, payload: string, priority: number }|null}
 */
function detect(text) {
  const raw = String(text || '').trim();
  if (!raw || !/^https?:\/\//i.test(raw.split(/\s+/)[0]) && !/https?:\/\//i.test(raw)) {
    // still allow URL anywhere in short messages
  }
  if (!/https?:\/\//i.test(raw)) return null;

  let best = null;
  for (const p of PATTERNS) {
    const m = raw.match(p.re);
    if (!m) continue;
    const url = m[0].replace(/[),.;!?]+$/, '');
    const candidate = {
      route: p.route,
      confidence: 0.98,
      payload: url,
      priority: p.priority,
      kind: 'url'
    };
    if (!best || candidate.priority > best.priority) best = candidate;
  }
  return best;
}

module.exports = { detect, PATTERNS };
