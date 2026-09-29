'use strict';

const { pickModulesFor } = require('./target');

const POLICY_SKIPS = [
  { name: 'tor/onion', reason: 'policy_public_web' },
  { name: 'reverse_image', reason: 'no_api' },
  { name: 'hibp_dehashed', reason: 'leak_blocked' },
  { name: 'paste_raw', reason: 'no_dump_body' },
  { name: 'telefone_vazamento', reason: 'use_consulta_paga_ou_bloqueado' },
  { name: 'geo_pessoa', reason: 'no_geo_pessoa' },
  { name: 'stilometria', reason: 'unreliable' },
  { name: 's3_scan', reason: 'no_scan' },
  { name: 'ip_cloudflare', reason: 'no_bypass' },
  { name: 'dump_social', reason: 'no_scrape_social' },
  { name: 'stt', reason: 'no_stt' },
  { name: 'biometric', reason: 'no_biometric' },
  { name: 'mapa_visual', reason: 'no_map_wa' },
  { name: 'alertas', reason: 'fase_posterior' },
  { name: 'voz', reason: 'no_voice' },
  { name: 'stealth_ua', reason: 'ua_declarado' },
  { name: 'wordlist', reason: 'no_wordlist' },
  { name: 'pdf_csv', reason: 'fase_posterior' }
];

function braveKey() {
  return String(process.env.HANORK_SEARCH_KEY || process.env.BRAVE_SEARCH_KEY || '').trim();
}

function buildPlan(parsed, moduleName) {
  const kind = String(parsed && parsed.kind || '');
  const skipped = POLICY_SKIPS.map((s) => ({ ...s }));
  if (!braveKey()) skipped.push({ name: 'brave_search', reason: 'no_key' });
  skipped.push({ name: 'nominatim', reason: 'so_lugar' });
  skipped.push({ name: 'ocr', reason: 'no_ocr' });
  if (kind === 'onion') {
    return {
      kind: 'onion',
      collectors: [],
      skipped: [{ name: 'collect', reason: 'onion_nao_coletado' }, ...skipped],
      estimatedMs: 0
    };
  }
  const collectors = pickModulesFor(moduleName, parsed);
  return {
    kind,
    collectors,
    skipped,
    estimatedMs: Math.max(4000, Math.min(25000, collectors.length * 2500)),
    lang: parsed && parsed.flags && parsed.flags.lang,
    since: parsed && parsed.flags && parsed.flags.since
  };
}

module.exports = { buildPlan, POLICY_SKIPS, braveKey };
