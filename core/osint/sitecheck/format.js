'use strict';
/**
 * core/osint/sitecheck/format.js
 * Monta o relatorio visual do .sitecheck a partir das evidencias.
 *
 * REGRA DO PROJETO: NADA de formatacao ad-hoc. Toda a tipografia vem de
 * utils/typography.js (vant noir, ASCII, sem emoji) — mesma funcao do .osint.
 * O relatorio e paginado em SECOES para nao estourar o limite do WhatsApp e
 * para virar botoes inline no Telegram.
 */

const { formatReportBlock, labelValue } = require('../../../utils/typography');

/** Limite seguro de caracteres por pagina (WhatsApp ~4096, margem ampla). */
const PAGE_CHARS = 2600;
const MAX_SECTIONS = 12;

function uniq(list) {
  return [...new Set((list || []).filter(Boolean))];
}

/** Agrupa as evidencias por bloco logico do relatorio. */
function buildSections(result) {
  const ev = result.evidences || [];
  const sections = [];

  // --- DNS
  const dns = ev.filter((e) => e.source === 'dns');
  if (dns.length) {
    const byType = new Map();
    for (const e of dns) {
      const t = (e.extra && e.extra.rr) || '?';
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(e);
    }
    const linhas = [];
    for (const [t, list] of byType) {
      if (list.every((e) => e.extra && e.extra.empty)) {
        linhas.push(labelValue(t, 'sem registro'));
      } else {
        const vals = uniq(list.map((e) => String(e.value || ''))).slice(0, 4);
        linhas.push(labelValue(t, vals.join(', ') + (list.length > 4 ? ` (+${list.length - 4})` : '')));
      }
    }
    sections.push({ id: 'dns', titulo: 'DNS', linhas });
  }

  // --- HTTP
  const httpEv = ev.filter((e) => e.source === 'http');
  if (httpEv.length) {
    const linhas = [];
    const st = httpEv.find((e) => e.entityType === 'HTTPStatus');
    const perf = httpEv.find((e) => e.entityType === 'Performance');
    const red = httpEv.find((e) => e.entityType === 'Redirect');
    if (st) linhas.push(labelValue('Status', st.value));
    if (perf) linhas.push(labelValue('Resposta', perf.value));
    if (red) linhas.push(labelValue('Redirect', String(red.value).replace(/^redirecionou para /, '')));
    sections.push({ id: 'http', titulo: 'HTTP', linhas });
  }

  // --- Headers de seguranca
  const secEv = ev.filter((e) => e.source === 'http_headers' && e.extra && e.extra.header);
  if (secEv.length) {
    const linhas = secEv.map((e) => {
      const v = String(e.value);
      const label = String(e.extra.label || e.extra.header).toUpperCase();
      const val = v.includes(':') ? v.slice(v.indexOf(':') + 1).trim() : v;
      return labelValue(label, val);
    });
    sections.push({ id: 'headers', titulo: 'HEADERS DE SEGURANCA', linhas });
  }

  // --- Cookies
  const ck = ev.find((e) => e.extra && e.extra.cookies);
  if (ck) {
    const x = ck.extra;
    sections.push({
      id: 'cookies',
      titulo: 'COOKIES',
      linhas: [
        labelValue('Total', x.total),
        labelValue('Sem Secure', x.insecure),
        labelValue('Sem HttpOnly', x.httpOnlyMissing),
        labelValue('Sem SameSite', x.sameSiteMissing)
      ]
    });
  }

  // --- CDN / WAF / hospedagem
  const cdn = ev.find((e) => e.source === 'cdn');
  const waf = ev.find((e) => e.source === 'waf');
  const srv = ev.find((e) => e.source === 'http_headers' && e.entityType === 'Infrastructure');
  if (cdn || waf || srv) {
    const linhas = [];
    if (cdn) linhas.push(labelValue('CDN', String(cdn.value).replace(/^CDN:\s*/, '')));
    if (waf) linhas.push(labelValue('WAF', String(waf.value).replace(/^WAF:\s*/, '')));
    if (srv) linhas.push(labelValue('Servidor', String(srv.value).replace(/^Server:\s*/, '')));
    sections.push({ id: 'cdn', titulo: 'CDN / WAF / HOSPING', linhas });
  }

  return sections;
}

/** TLS / stack / meta / ip / portas / veredito (parte 2 do relatorio). */
function buildSections2(result) {
  const ev = result.evidences || [];
  const sections = [];

  // --- TLS
  const tlsEv = ev.filter((e) => e.source === 'tls');
  if (tlsEv.length) {
    const linhas = tlsEv.map((e) => {
      if (/depreciado/i.test(e.value)) return labelValue('ATENCAO', e.value);
      return labelValue(e.entityType === 'Certificate' ? 'Cert' : 'TLS', e.value);
    });
    sections.push({ id: 'tls', titulo: 'SSL / TLS', linhas });
  }

  // --- Stack
  const stack = ev.find((e) => e.source === 'stack');
  if (stack) {
    const list = uniq((stack.extra && stack.extra.stack) || []);
    sections.push({
      id: 'stack',
      titulo: 'TECNOLOGIAS',
      linhas: [labelValue('Detectado', list.length ? list.join(', ') : 'nenhuma')]
    });
  }

  // --- Meta
  const meta = ev.filter((e) => e.source === 'meta');
  if (meta.length) {
    const linhas = [];
    for (const e of meta) {
      const v = String(e.value);
      const k = v.includes(':') ? v.slice(0, v.indexOf(':')) : 'meta';
      const val = v.includes(':') ? v.slice(v.indexOf(':') + 1).trim() : v;
      linhas.push(labelValue(k.charAt(0).toUpperCase() + k.slice(1), val));
    }
    sections.push({ id: 'meta', titulo: 'CONTEUDO / META', linhas });
  }

  // --- IP / Geo
  const geo = ev.filter((e) => e.entityType === 'GeoIP');
  if (geo.length) {
    const linhas = geo.map((e) => labelValue(
      String((e.extra && e.extra.ip) || 'ip'),
      String(e.value).split('—')[1]?.trim() || e.value
    ));
    sections.push({ id: 'ip', titulo: 'IP / GEO / ASN', linhas });
  } else if (ev.some((e) => e.source === 'ip_geo' && e.entityType === 'Error')) {
    sections.push({ id: 'ip', titulo: 'IP / GEO / ASN', linhas: [labelValue('Status', 'sem IP publico resolvido')] });
  }

  // --- Portas
  const ports = ev.find((e) => e.source === 'ports');
  if (ports) {
    const ex = ports.extra || {};
    sections.push({
      id: 'ports',
      titulo: 'PORTAS COMUNS',
      linhas: [
        labelValue('Escaneadas', (ex.scanned || []).join(', ')),
        labelValue('Abertas', (ex.open || []).length ? ex.open.join(', ') : 'nenhuma')
      ]
    });
  }

  // --- Veredito
  const vd = ev.find((e) => e.source === 'verdict' && e.extra && e.extra.risk);
  if (vd) {
    const linhas = [labelValue('Risco', vd.extra.risk)];
    const warn = (vd.extra.warnings || []).slice(0, 8);
    if (warn.length) {
      linhas.push('', 'Avisos:');
      for (const w of warn) linhas.push(`- ${w}`);
    }
    sections.push({ id: 'verdict', titulo: 'VEREDITO', linhas });
  }

  return sections;
}

/** Cabecalho: alvo + origem (cache SQL ou coleta ao vivo). */
function header(result) {
  return [
    labelValue('Alvo', result.host),
    labelValue('Origem', result.cached ? 'cache SQL' : 'coleta ao vivo'),
    labelValue('Coletado em', String(result.collectedAt || '').replace('T', ' ').replace(/\..*/, ' UTC')),
    labelValue('Evidencias', (result.evidences || []).length)
  ];
}

/**
 * Pagina as secoes respeitando PAGE_CHARS.
 * @returns {Array<{texto, secoes: string[]}>}
 */
function paginate(result) {
  const all = buildSections(result).concat(buildSections2(result)).slice(0, MAX_SECTIONS);
  const head = header(result);
  const headLen = head.join('\n').length + 30;
  const pages = [];
  let atual = [];
  let usado = headLen;

  const flush = () => {
    if (!atual.length) return;
    pages.push({
      texto: formatReportBlock('HANORK SITECHECK', [
        ...head, '', ...atual.flatMap((s) => [s.titulo, ...s.linhas, ''])
      ]),
      secoes: atual.map((s) => s.id)
    });
    atual = [];
    usado = headLen;
  };

  for (const s of all) {
    const bloco = s.linhas.join('\n').length + s.titulo.length + 6;
    if (bloco > PAGE_CHARS) {
      let corte = [];
      let n = 0;
      for (const l of s.linhas) {
        if (n + l.length > PAGE_CHARS) {
          atual.push({ titulo: s.titulo, linhas: corte });
          corte = [];
          n = 0;
        }
        corte.push(l);
        n += l.length + 1;
      }
      if (corte.length) atual.push({ titulo: s.titulo, linhas: corte });
      flush();
      continue;
    }
    if (usado + bloco > PAGE_CHARS) flush();
    atual.push(s);
    usado += bloco;
  }
  flush();

  if (!pages.length) {
    return [{
      texto: formatReportBlock('HANORK SITECHECK', [...head, '', 'sem evidencias coletadas']),
      secoes: []
    }];
  }
  // Numera quando ha mais de uma pagina.
  if (pages.length > 1) {
    return pages.map((p, i) => ({
      texto: `${p.texto}\n(${i + 1}/${pages.length})`,
      secoes: p.secoes
    }));
  }
  return pages;
}

/** Texto corrido (fallback WhatsApp / preview). */
function toSingleText(result) {
  return paginate(result).map((p) => p.texto).join('\n\n');
}

module.exports = {
  buildSections,
  buildSections2,
  paginate,
  toSingleText,
  header,
  uniq,
  PAGE_CHARS,
  MAX_SECTIONS
};
