'use strict';
/* Testa deteccao de CDN/WAF + buildVerdict sem sair pra rede. */
const { _internals } = require('../core/osint/sitecheck/service');
const { buildSections, buildSections2, paginate } = require('../core/osint/sitecheck/format');

const cdn = (obj) => _internals.checkCdnWaf(new Headers(obj), 'https://x.test').map((e) => e.value);

const casos = [
  ['cloudflare real', { 'cf-ray': 'abc', 'server': 'cloudflare' }, 'Cloudflare'],
  ['cloudflare SEM fastly', { 'cf-ray': 'abc', 'x-served-by': 'cache-ams', 'server': 'cloudflare' }, 'NÃƒO Fastly'],
  ['fastly real', { server: 'Fastly', via: '1.1 varnish' }, 'Fastly'],
  ['akamai', { 'akamai-grn': 'x', server: 'AkamaiGHost' }, 'Akamai'],
  ['shopify', { server: 'cloudflare', 'x-shopify-stage': '1' }, 'sem CDN extra'],
  ['nginx puro', { server: 'nginx/1.24.0' }, 'nao detectado']
];

let falhas = 0;
for (const [nome, hdr, esperado] of casos) {
  const out = cdn(hdr).join(' | ');
  const ok = esperado === 'NÃƒO Fastly' ? !/Fastly/.test(out)
    : esperado === 'sem CDN extra' ? !/Fastly|Akamai/.test(out)
    : new RegExp(esperado.replace(' NÃƒO Fastly', '')).test(out);
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${nome.padEnd(20)} => ${out}`);
  if (!ok) falhas++;
}

// veredito: caso degenerado (site fora, sem headers)
const ev = [
  { value: 'http: 0', source: 'http', entityType: 'HTTPStatus', extra: { status: 0 } },
  { value: 'tls: timeout', source: 'tls', entityType: 'Error', extra: {} },
  { value: 'HSTS: ausente', source: 'http_headers', entityType: 'Security', extra: { header: 'strict-transport-security', present: false } },
  { value: '10.0.0.1 â€” pais: BR', source: 'ip_geo', entityType: 'GeoIP', extra: { hosting: true } }
];
const v = _internals.buildVerdict(ev).map((e) => e.value);
const riscoAlto = v.some((x) => /risco: ALTO/.test(x));
console.log(`${riscoAlto ? 'OK  ' : 'FALHA'} veredito degenerado => ${v[0]}`);
if (!riscoAlto) falhas++;

// formatacao/paginacao
const secoes = [...buildSections({ evidences: ev, host: 'x.test' }), ...buildSections2({ evidences: ev, host: 'x.test' })];
const paginas = paginate({ evidences: ev, host: 'x.test', cached: false, collectedAt: new Date().toISOString() });
console.log(`${secoes.length > 0 && paginas.length > 0 ? 'OK  ' : 'FALHA'} formatacao: ${secoes.length} secoes, ${paginas.length} pagina(s), ${paginas[0].texto.length} chars`);
if (!(secoes.length > 0 && paginas.length > 0)) falhas++;

console.log(falhas === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);

