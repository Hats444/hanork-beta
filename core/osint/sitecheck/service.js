'use strict';
/**
 * core/osint/sitecheck/service.js
 * Checagem tecnica de site/dominio — ".sitecheck <dominio|url>".
 *
 * POR QUE UM SERVICE E NAO MAIS UM COMANDO SOLTO
 * O projeto ja tem um OSINT maduro (core/osint + osint/collectors). Este
 * modulo NAO duplica: reaproveita dns/whois/certificates/reputation e
 * preenche as lacunas reais que ainda nao existiam:
 *   status+tempo, redirect, headers de seguranca, CDN/WAF, TLS ao vivo,
 *   fingerprint de stack, meta/favicon, IP+ASN, geo do IP, portas e veredito.
 *
 * PADROES SEGUIDOS
 *  - guardrails de osint/core/guardrails.js (SSRF, IP privado, .onion)
 *  - rateLimit/waitTurn por host (osint/core/rateLimit.js)
 *  - cache com TTL (core/osint/cache.js) + espelho em SQL
 *  - evidencia {value,source,confidence,entityType,extra}
 *  - TODO check em paralelo (Promise.allSettled) com timeout individual:
 *    uma falha NUNCA derruba as outras.
 */

const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const { sanitizeHostname, isPrivateIpv4 } = require('../../../osint/core/guardrails');
const { waitTurn } = require('../../../osint/core/rateLimit');
const cache = require('../cache');

const UA = 'Hanork-SiteCheck/1.0 (passive public site audit)';

const T_DEFAULT = Number(process.env.SITECHECK_TIMEOUT_MS) || 8000;
const T_PORT = Number(process.env.SITECHECK_PORT_TIMEOUT_MS) || 1600;
const T_TLS = Number(process.env.SITECHECK_TLS_TIMEOUT_MS) || 6000;

/** Limite de HTML lido (evita DoS de pagina gigante). */
const MAX_HTML_BYTES = 512 * 1024;

/** Promise + timeout duro. Nao deixa check travado segurar o relatorio. */
function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`timeout ${ms}ms`);
      e.code = 'SITECHECK_TIMEOUT';
      e.label = label;
      reject(e);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function evidence(value, source, url, extra = {}) {
  return {
    value: String(value == null ? '' : value).slice(0, 400),
    source,
    url: url || '',
    collectedAt: new Date().toISOString(),
    confidence: extra.confidence == null ? 0.5 : extra.confidence,
    status: extra.status || 'UNVERIFIED',
    entityType: extra.entityType || 'Unknown',
    extra: extra.extra || null
  };
}

function errorEvidence(label, e) {
  const msg = String((e && e.message) || e || '').slice(0, 140);
  return evidence(`${label}: ${msg || 'falhou'}`, label, '', {
    entityType: 'Error',
    confidence: 0.1,
    extra: { provider: label, status: 'error', code: (e && e.code) || null }
  });
}

/** Aceita "exemplo.com", "www.x.com", "https://x.com/p". */
function normalizeTarget(raw) {
  const host = sanitizeHostname(raw);
  let url = `https://${host}/`;
  if (/^https?:\/\//i.test(String(raw || '').trim())) {
    try {
      url = new URL(String(raw).trim()).toString();
    } catch (_) {
      url = `https://${host}/`;
    }
  }
  return { host, url };
}

// ---------------------------------------------------------------- 1. DNS
async function checkDns(host) {
  const types = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'SOA', 'CNAME'];
  const results = await Promise.allSettled(
    types.map(async (t) => {
      try {
        const recs = await withTimeout(dns.resolve(host, t), T_DEFAULT / 2, `dns:${t}`);
        const list = Array.isArray(recs) ? recs : [recs];
        return list.slice(0, 8).map((r) => {
          const v = typeof r === 'string'
            ? r
            : (r.address || r.exchange || r.nsname || r.data || JSON.stringify(r));
          return evidence(String(v), 'dns', `dns:${t}:${host}`, {
            entityType: t === 'A' || t === 'AAAA' ? 'IP' : t === 'MX' || t === 'NS' ? 'Domain' : 'Record',
            confidence: 0.7,
            extra: { rr: t, host }
          });
        });
      } catch (e) {
        // NXDOMAIN/ENODATA = "nao existe registro", nao e erro.
        if (/ENODATA|ENOTFOUND|NXDOMAIN/i.test(String(e.code || e.message || ''))) {
          return [evidence(`sem registro ${t}`, 'dns', `dns:${t}:${host}`, {
            entityType: 'Record', confidence: 0.7, extra: { rr: t, host, empty: true }
          })];
        }
        return [errorEvidence(`dns:${t}`, e)];
      }
    })
  );
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [errorEvidence('dns', r.reason)]));
}

// ------------------------------------------------- 2. HTTP: status+redirect
async function checkHttp(url) {
  await waitTurn(`sitecheck:${new URL(url).hostname}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), T_DEFAULT);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: ac.signal
    });
    const ms = Date.now() - started;
    const finalUrl = res.url || url;
    const out = [
      evidence(`${res.status} ${res.statusText || ''}`.trim(), 'http', finalUrl, {
        entityType: 'HTTPStatus', confidence: 0.95, extra: { status: res.status, ms, url: finalUrl }
      }),
      evidence(`${ms} ms`, 'http', finalUrl, {
        entityType: 'Performance', confidence: 0.9, extra: { ms }
      })
    ];
    if (finalUrl.replace(/\/$/, '') !== url.replace(/\/$/, '')) {
      out.push(evidence(`redirecionou para ${finalUrl}`, 'http', finalUrl, {
        entityType: 'Redirect', confidence: 0.9, extra: { finalUrl, redirected: true }
      }));
    }
    return { evidences: out, status: res.status, headers: res.headers, finalUrl, ms, res };
  } catch (e) {
    return {
      evidences: [errorEvidence('http', e)], status: 0,
      headers: null, finalUrl: url, ms: Date.now() - started, res: null
    };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------- 3. Headers de seguranca
const SECURITY_HEADERS = [
  { key: 'strict-transport-security', label: 'HSTS' },
  { key: 'content-security-policy', label: 'CSP' },
  { key: 'x-frame-options', label: 'X-Frame-Options' },
  { key: 'x-content-type-options', label: 'X-Content-Type-Options' },
  { key: 'referrer-policy', label: 'Referrer-Policy' },
  { key: 'permissions-policy', label: 'Permissions-Policy' }
];

function checkSecurityHeaders(headers, finalUrl) {
  if (!headers) {
    return [evidence('sem resposta HTTP para ler headers', 'http_headers', finalUrl, {
      entityType: 'Error', confidence: 0.1, extra: { status: 'sem_headers' }
    })];
  }
  const out = [];
  for (const h of SECURITY_HEADERS) {
    const v = headers.get ? headers.get(h.key) : null;
    out.push(evidence(`${h.label}: ${v ? String(v).slice(0, 90) : 'ausente'}`, 'http_headers', finalUrl, {
      entityType: 'Security', confidence: 0.9, extra: { header: h.key, present: !!v }
    }));
  }
  const setCookie = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  if (setCookie && setCookie.length) {
    const insecure = setCookie.filter((c) => !/;\s*secure/i.test(c)).length;
    const noHttpOnly = setCookie.filter((c) => !/;\s*httponly/i.test(c)).length;
    const noSameSite = setCookie.filter((c) => !/;\s*samesite=/i.test(c)).length;
    out.push(evidence(
      `${setCookie.length} cookie(s) · sem Secure: ${insecure} · sem HttpOnly: ${noHttpOnly} · sem SameSite: ${noSameSite}`,
      'http_headers', finalUrl, {
        entityType: 'Security', confidence: 0.8,
        extra: { cookies: true, total: setCookie.length, insecure, httpOnlyMissing: noHttpOnly, sameSiteMissing: noSameSite }
      }
    ));
  }
  return out;
}

// --------------------------------------- 4. CDN / WAF (header + heuristic)
const CDN_SIGNATURES = [
  { name: 'Cloudflare', test: (h) => !!h.get('cf-ray') || !!h.get('cf-cache-status') || /cloudflare/i.test(h.get('server') || '') },
  { name: 'Amazon CloudFront', test: (h) => !!h.get('x-amz-cf-id') || !!h.get('x-amz-cf-pop') || /cloudfront/i.test(h.get('via') || '') },
  { name: 'Amazon S3', test: (h) => /amz|aws/i.test(h.get('server') || '') },
  { name: 'Akamai', test: (h) => !!h.get('akamai-grn') || /akamai|ghost/i.test(h.get('server') || '') },
  // NAO usar x-served-by sozinho: a Cloudflare tambem o envia e gerava falso
  // positivo de Fastly. Exigimos OUTRO header de Fastly junto.
  { name: 'Fastly', test: (h) => /fastly/i.test(`${h.get('server') || ''}${h.get('via') || ''}${h.get('x-fastly-request-id') || ''}${h.get('fastly-io-info') || ''}`) },
  { name: 'Sucuri', test: (h) => /sucuri/i.test(h.get('server') || '') },
  { name: 'Imperva/Incapsula', test: (h) => /incapsula|incap_ses|imperva/i.test(`${h.get('x-iinfo') || ''}${h.get('server') || ''}`) },
  { name: 'Vercel', test: (h) => !!h.get('x-vercel-id') || /vercel/i.test(h.get('server') || '') },
  { name: 'Netlify', test: (h) => !!h.get('x-nf-request-id') || /netlify/i.test(h.get('server') || '') },
  { name: 'Bunny CDN', test: (h) => /bunnycdn|bunny/i.test(h.get('server') || '') },
  { name: 'KeyCDN', test: (h) => !!h.get('x-edge-location') },
  { name: 'CacheFly', test: (h) => /cachefly/i.test(h.get('server') || '') },
  { name: 'Aruba', test: (h) => /aruba/i.test(h.get('server') || '') }
];

const WAF_SIGNATURES = [
  { name: 'Cloudflare WAF', test: (h) => !!h.get('cf-ray') },
  { name: 'Sucuri CloudProxy', test: (h) => /sucuri/i.test(h.get('server') || '') },
  { name: 'Wordfence', test: (h) => /wordfence/i.test(h.get('server') || '') },
  { name: 'Imperva', test: (h) => /incapsula|incap_ses/i.test(`${h.get('x-iinfo') || ''}${h.get('server') || ''}`) },
  { name: 'ModSecurity', test: (h) => /mod_security|modsecurity/i.test(h.get('server') || '') }
];

const matchAll = (list, headers) =>
  list.filter((c) => { try { return c.test(headers); } catch (_) { return false; } }).map((c) => c.name);

function checkCdnWaf(headers, finalUrl) {
  if (!headers) return [];
  const get = (k) => (headers.get ? (headers.get(k) || '') : '');
  const cdns = matchAll(CDN_SIGNATURES, headers);
  const wafs = matchAll(WAF_SIGNATURES, headers);
  const out = [
    evidence(`CDN: ${cdns.length ? cdns.join(', ') : 'nao detectado por header'}`, 'cdn', finalUrl, {
      entityType: 'Infrastructure', confidence: cdns.length ? 0.85 : 0.45, extra: { cdn: cdns }
    })
  ];
  if (wafs.length) {
    out.push(evidence(`WAF: ${wafs.join(', ')}`, 'waf', finalUrl, {
      entityType: 'Security', confidence: 0.8, extra: { waf: wafs }
    }));
  }
  const server = get('server');
  const powered = get('x-powered-by');
  if (server || powered) {
    out.push(evidence(
      `Server: ${server || '-'}${powered ? ` | X-Powered-By: ${powered}` : ''}`,
      'http_headers', finalUrl, {
        entityType: 'Infrastructure', confidence: 0.8,
        extra: { server, poweredBy: powered, via: get('via') || null }
      }
    ));
  }
  return out;
}

// --------------------------------------------- 5. TLS ao vivo (nativo)
function checkTls(host) {
  return withTimeout(new Promise((resolve) => {
    const sock = tls.connect(
      { host, port: 443, servername: host, rejectUnauthorized: false, timeout: T_TLS },
      () => {
        const cert = sock.getPeerCertificate(false) || {};
        const proto = sock.getProtocol ? sock.getProtocol() : '';
        sock.end();
        const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
        const daysLeft = validTo ? Math.floor((validTo.getTime() - Date.now()) / 86400000) : null;
        const link = `tls://${host}:443`;
        const out = [evidence(`protocolo: ${proto || '?'}`, 'tls', link, {
          entityType: 'Security', confidence: 0.95, extra: { protocol: proto }
        })];
        if (cert.subject && cert.subject.CN) {
          out.push(evidence(`CN: ${cert.subject.CN}`, 'tls', link, {
            entityType: 'Certificate', confidence: 0.9, extra: { cn: cert.subject.CN }
          }));
        }
        const issuer = cert.issuer && (cert.issuer.O || cert.issuer.CN);
        if (issuer) {
          out.push(evidence(`emissor: ${issuer}`, 'tls', link, {
            entityType: 'Certificate', confidence: 0.9, extra: { issuer }
          }));
        }
        if (daysLeft != null) {
          out.push(evidence(
            `validade: ${cert.valid_from || '?'} -> ${cert.valid_to} (${daysLeft} dia(s))`,
            'tls', link, {
              entityType: 'Certificate', confidence: 0.9,
              extra: { validFrom: cert.valid_from, validTo: cert.valid_to, daysLeft }
            }
          ));
        }
        const alt = (cert.subjectaltname || '').split(',').map((s) => s.trim().replace(/^DNS:/i, '')).filter(Boolean);
        if (alt.length) {
          out.push(evidence(`SAN (${alt.length}): ${alt.slice(0, 8).join(', ')}`, 'tls', link, {
            entityType: 'Certificate', confidence: 0.85, extra: { san: alt.slice(0, 40), sanTotal: alt.length }
          }));
        }
        if (/TLSv1(\.0|\.1)$/.test(String(proto))) {
          out.push(evidence('ATENCAO: protocolo TLS 1.0/1.1 depreciado', 'tls', link, {
            entityType: 'Security', confidence: 0.95, extra: { deprecated: true, protocol: proto }
          }));
        }
        resolve(out);
      }
    );
    sock.on('error', (e) => resolve([errorEvidence('tls', e)]));
    sock.on('timeout', () => {
      sock.destroy();
      resolve([evidence('tls: timeout', 'tls', `tls://${host}:443`, {
        entityType: 'Error', confidence: 0.1, extra: { status: 'timeout' }
      })]);
    });
  }), T_TLS + 500, 'tls');
}

// ------------------------------------- 6. Fingerprint de stack (Wappalyzer-like)
const STACK_RULES = [
  { name: 'WordPress', re: /wp-content|wp-includes|wordpress/i },
  { name: 'WooCommerce', re: /woocommerce|wc-ajax/i },
  { name: 'Shopify', re: /cdn\.shopify|shopify/i },
  { name: 'Magento', re: /magento|\/static\/version\d/i },
  { name: 'Drupal', re: /drupal|x-generator:\s*drupal/i },
  { name: 'Joomla', re: /joomla|media\/jui/i },
  { name: 'PHP', re: /\.php\b|php\/|x-powered-by:\s*php/i },
  { name: 'Laravel', re: /laravel_session|x-powered-by:\s*laravel/i },
  { name: 'Django', re: /csrftoken|__admin_media_prefix__|x-powered-by:\s*django/i },
  { name: 'Ruby on Rails', re: /x-runtime:|passenger/i },
  { name: 'ASP.NET', re: /asp\.net|aspnet|__viewstate/i },
  { name: 'Node.js/Express', re: /x-powered-by:\s*express/i },
  { name: 'jQuery', re: /jquery[-\.]/i },
  { name: 'React', re: /data-reactroot|__react|react-dom/i },
  { name: 'Next.js', re: /__NEXT_DATA__|_next\/static/i },
  { name: 'Vue.js', re: /data-v-[0-9a-f]{8}|vue\.runtime/i },
  { name: 'Nuxt', re: /__NUXT__|nuxt-link/i },
  { name: 'Angular', re: /ng-version|angular\.min\.js/i },
  { name: 'Svelte/SvelteKit', re: /svelte-|__sveltekit/i },
  { name: 'Google Analytics', re: /googletagmanager\.com|google-analytics\.com|gtag\(/i },
  { name: 'Google Tag Manager', re: /googletagmanager\.com\/gtm/i },
  { name: 'Facebook Pixel', re: /connect\.facebook\.net|fbq\(/i },
  { name: 'Cloudflare Turnstile', re: /challenges\.cloudflare\.com\/turnstile/i },
  { name: 'reCAPTCHA', re: /google\.com\/recaptcha|g-recaptcha/i },
  { name: 'Tailwind CSS', re: /tailwindcss|cdn\.tailwindcss/i },
  { name: 'Bootstrap', re: /bootstrap(\.min)?\.(css|js)|getbootstrap/i },
  { name: 'Font Awesome', re: /font-?awesome/i },
  { name: 'Vercel Analytics', re: /vercel\/insights|_vercel\/speed-insights/i },
  { name: 'Hotjar', re: /static\.hotjar\.com|hjSetting/i },
  { name: 'Intercom', re: /widget\.intercom\.io|intercomSettings/i }
];

function detectStack(headers, html) {
  const h = (k) => (headers && headers.get ? (headers.get(k) || '') : '');
  const hay = `${h('server')} ${h('x-powered-by')} ${String(html || '').slice(0, 200000)}`;
  const uniq = [...new Set(STACK_RULES.filter((r) => r.re.test(hay)).map((r) => r.name))];
  if (!uniq.length) {
    return [evidence('nenhuma tecnologia detectada (ou site muito minimo)', 'stack', '', {
      entityType: 'Technology', confidence: 0.4, extra: { stack: [] }
    })];
  }
  return [evidence(uniq.join(', '), 'stack', '', {
    entityType: 'Technology', confidence: 0.75, extra: { stack: uniq, total: uniq.length }
  })];
}

// ------------------------------------ 7. Meta do site (title/desc/og/favicon)
function checkMeta(html, finalUrl) {
  const out = [];
  if (!html) return out;
  const pick = (re) => {
    const m = String(html).match(re);
    return m ? String(m[1] || '').trim() : '';
  };
  const title = pick(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})["']/i)
    || pick(/<meta[^>]+content=["']([^"']{0,300})["'][^>]+name=["']description["']/i);
  const ogImage = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  const generator = pick(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);

  if (title) {
    out.push(evidence(`titulo: ${title.slice(0, 120)}`, 'meta', finalUrl, {
      entityType: 'Metadata', confidence: 0.9, extra: { title: title.slice(0, 200) }
    }));
  }
  if (desc) {
    out.push(evidence(`descricao: ${desc.slice(0, 140)}`, 'meta', finalUrl, {
      entityType: 'Metadata', confidence: 0.85, extra: { description: desc.slice(0, 300) }
    }));
  }
  if (generator) {
    out.push(evidence(`generator: ${generator}`, 'meta', finalUrl, {
      entityType: 'Metadata', confidence: 0.8, extra: { generator }
    }));
  }
  if (ogImage) {
    let abs = ogImage;
    try { abs = new URL(ogImage, finalUrl).toString(); } catch (_) { /* keep */ }
    out.push(evidence(`og:image: ${abs.slice(0, 150)}`, 'meta', finalUrl, {
      entityType: 'Metadata', confidence: 0.8, extra: { ogImage: abs }
    }));
  }
  const favMatch = String(html).match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i)
    || String(html).match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i);
  let favAbs = favMatch ? favMatch[1] : '/favicon.ico';
  try { favAbs = new URL(favAbs, finalUrl).toString(); } catch (_) { /* keep */ }
  out.push(evidence(`favicon: ${favAbs.slice(0, 140)}`, 'meta', finalUrl, {
    entityType: 'Metadata', confidence: 0.6, extra: { favicon: favAbs }
  }));
  return out;
}

// ------------------------------------------------ 8. IP + ASN + geo
async function fetchIpInfo(ip) {
  await waitTurn('ip-api.com');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 4000);
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,isp,org,as,proxy,hosting,query`,
      { headers: { 'User-Agent': UA }, signal: ac.signal }
    );
    if (!res.ok) throw new Error(`http ${res.status}`);
    const d = await res.json();
    if (d.status !== 'success') throw new Error(d.message || 'ip-api falhou');
    return d;
  } finally {
    clearTimeout(t);
  }
}

async function checkIpGeo(ips) {
  const unique = [...new Set((ips || []).filter((ip) => ip && !isPrivateIpv4(ip)))].slice(0, 3);
  if (!unique.length) {
    return [evidence('nenhum IP publico resolvido', 'ip_geo', '', {
      entityType: 'Error', confidence: 0.1, extra: { reason: 'sem_ip_publico' }
    })];
  }
  const out = [];
  await Promise.allSettled(unique.map(async (ip) => {
    try {
      const d = await fetchIpInfo(ip);
      const bits = [
        `pais: ${d.country || '?'} (${d.countryCode || '?'})`,
        d.regionName ? `regiao: ${d.regionName}` : null,
        d.city ? `cidade: ${d.city}` : null,
        d.isp ? `isp: ${d.isp}` : null,
        d.org ? `org: ${d.org}` : null,
        d.as ? `asn: ${d.as}` : null,
        d.hosting ? 'hosting: sim' : null,
        d.proxy ? 'proxy: sim' : null
      ].filter(Boolean);
      out.push(evidence(`${ip} — ${bits.join(' · ')}`, 'ip_geo', `http://ip-api.com/json/${ip}`, {
        entityType: 'GeoIP', confidence: 0.8,
        extra: {
          ip, country: d.country, countryCode: d.countryCode, region: d.regionName,
          city: d.city, isp: d.isp, org: d.org, asn: d.as, hosting: !!d.hosting, proxy: !!d.proxy
        }
      }));
    } catch (e) {
      out.push(errorEvidence(`ip_geo:${ip}`, e));
    }
  }));
  return out;
}

// --------------------------------------------------- 9. Portas comuns
const COMMON_PORTS = [21, 22, 25, 80, 443, 3306, 5432, 6379, 8080, 8443];

function portOpen(host, port) {
  return withTimeout(new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* noop */ }
      resolve(v);
    };
    sock.setTimeout(T_PORT);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch (_) { finish(false); }
  }), T_PORT + 400, `port:${port}`);
}

async function checkPorts(host) {
  await waitTurn(`sitecheck-ports:${host}`);
  const results = await Promise.allSettled(COMMON_PORTS.map((p) => portOpen(host, p)));
  const open = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) open.push(COMMON_PORTS[i]);
  });
  if (!open.length) {
    return [evidence('nenhuma porta comum aberta (fechadas ou filtradas)', 'ports', host, {
      entityType: 'Network', confidence: 0.7, extra: { scanned: COMMON_PORTS, open: [] }
    })];
  }
  return [evidence(`portas abertas: ${open.join(', ')}`, 'ports', host, {
    entityType: 'Network', confidence: 0.8, extra: { scanned: COMMON_PORTS, open }
  })];
}

// ------------------------------------------- 10. Veredito de risco
function buildVerdict(evidences) {
  const warnings = [];
  const has = (re) => evidences.some((e) => re.test(String(e.value || '')));

  if (has(/ATENCAO: protocolo TLS/i)) warnings.push('TLS 1.0/1.1 depreciado');
  if (has(/^tls: (timeout|.*(ECONN|handshake))/i)) warnings.push('handshake TLS instavel');
  if (!evidences.some((e) => e.source === 'tls' && e.entityType === 'Certificate')) {
    warnings.push('certificado nao confirmado');
  }
  for (const h of SECURITY_HEADERS) {
    const ev = evidences.find((e) => e.extra && e.extra.header === h.key);
    if (ev && ev.extra.present === false) warnings.push(`${h.label} ausente`);
  }
  const ck = evidences.find((e) => e.source === 'http_headers' && e.extra && e.extra.cookies);
  if (ck && ck.extra.insecure > 0) warnings.push(`${ck.extra.insecure} cookie(s) sem Secure`);
  if (evidences.some((e) => e.entityType === 'HTTPStatus' && Number(e.extra?.status) >= 500)) {
    warnings.push('servidor devolvendo erro 5xx');
  }
  if (evidences.some((e) => e.entityType === 'HTTPStatus' && Number(e.extra?.status) === 0)) {
    warnings.push('site nao respondeu');
  }
  if (evidences.some((e) => e.entityType === 'GeoIP' && e.extra?.hosting)) {
    warnings.push('IP em datacenter/hosting');
  }

  const risk = warnings.length === 0 ? 'BAIXO' : warnings.length <= 3 ? 'MEDIO' : 'ALTO';
  const out = [evidence(`risco: ${risk} (${warnings.length} aviso(s))`, 'verdict', '', {
    entityType: 'Verdict', confidence: 0.7, extra: { risk, warningCount: warnings.length, warnings }
  })];
  if (warnings.length) {
    out.push(evidence(`avisos: ${warnings.slice(0, 8).join('; ')}`, 'verdict', '', {
      entityType: 'Verdict', confidence: 0.7, extra: { warnings: warnings.slice(0, 20) }
    }));
  }
  return out;
}

// ---------------------------------------------------------------- Orquestrador
/**
 * Roda TODOS os checks em paralelo (Promise.allSettled), cada um com timeout
 * individual. Falha de um NUNCA impede os outros.
 * @returns {Promise<{host,url,evidences,cached,ms,ok}>}
 */
async function runSiteCheck(rawTarget, opts = {}) {
  const started = Date.now();
  const { host, url } = normalizeTarget(rawTarget);

  // Cache por host (core/osint/cache: memoria + espelho SQL, TTL por provedor).
  if (!opts.skipCache) {
    const hit = cache.get('sitecheck', host);
    if (hit && Array.isArray(hit.value?.evidences) && hit.value.evidences.length) {
      return {
        host, url, cached: true, ms: Date.now() - started, ok: true,
        evidences: hit.value.evidences,
        collectedAt: hit.value.collectedAt || new Date().toISOString()
      };
    }
  }

  // DNS e HTTP saem primeiro: headers/HTML/IP dependem deles.
  const [dnsRes, httpRes] = await Promise.allSettled([checkDns(host), checkHttp(url)]);
  const dnsEv = dnsRes.status === 'fulfilled' ? dnsRes.value : [errorEvidence('dns', dnsRes.reason)];
  const http = httpRes.status === 'fulfilled' ? httpRes.value : {
    evidences: [errorEvidence('http', httpRes.reason)],
    status: 0, headers: null, finalUrl: url, ms: 0, res: null
  };

  const ips = dnsEv
    .filter((e) => e.entityType === 'IP' && e.extra?.rr === 'A')
    .map((e) => String(e.value || '').trim())
    .filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  const ipv6 = dnsEv
    .filter((e) => e.entityType === 'IP' && e.extra?.rr === 'AAAA')
    .map((e) => String(e.value || '').trim())
    .filter((ip) => ip.includes(':'));

  // HTML limitado: alimenta meta + fingerprint (nunca baixa a pagina inteira).
  let html = '';
  if (http.res && typeof http.res.text === 'function') {
    try {
      html = (await withTimeout(http.res.text(), T_DEFAULT, 'html')).slice(0, MAX_HTML_BYTES);
    } catch (_) { /* meta/stack degradam; o resto continua */ }
  }

  // Restante: 100% paralelo.
  const rest = await Promise.allSettled([
    checkSecurityHeaders(http.headers, http.finalUrl),
    checkCdnWaf(http.headers, http.finalUrl),
    checkTls(host),
    Promise.resolve(detectStack(http.headers, html)),
    Promise.resolve(checkMeta(html, http.finalUrl)),
    checkIpGeo(ips.concat(ipv6)),
    checkPorts(host)
  ]);

  const evidences = []
    .concat(dnsEv)
    .concat(http.evidences || [])
    .concat(...rest.map((r) => (r.status === 'fulfilled' ? r.value : [errorEvidence('check', r.reason)])));

  // Veredito depende de tudo: calcula por ultimo.
  evidences.push(...buildVerdict(evidences));

  const payload = { host, url, collectedAt: new Date().toISOString(), evidences };
  try {
    cache.set('sitecheck', host, payload);
  } catch (_) { /* cache e otimizacao, nunca erro */ }

  return {
    host, url, cached: false, ms: Date.now() - started,
    evidences, ok: true, collectedAt: payload.collectedAt
  };
}

module.exports = {
  runSiteCheck,
  normalizeTarget,
  withTimeout,
  evidence,
  errorEvidence,
  UA,
  T_DEFAULT,
  T_PORT,
  T_TLS,
  MAX_HTML_BYTES,
  // internos expostos p/ teste
  _internals: {
    checkDns, checkHttp, checkSecurityHeaders, checkCdnWaf, checkTls,
    detectStack, checkMeta, checkIpGeo, checkPorts, buildVerdict,
    COMMON_PORTS, SECURITY_HEADERS, CDN_SIGNATURES, WAF_SIGNATURES
  }
};

