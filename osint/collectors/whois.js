'use strict';

const net = require('net');
const { sanitizeHostname } = require('../core/guardrails');
const { evidence } = require('../core/http');
const { waitTurn } = require('../core/rateLimit');

function whoisQuery(host, query, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: 43 }, () => {
      sock.write(String(query).replace(/[\r\n]/g, '') + '\r\n');
    });
    const chunks = [];
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error('whois timeout'));
    }, timeoutMs);
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => {
      clearTimeout(t);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    sock.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function pick(text, re) {
  const m = String(text || '').match(re);
  return m ? String(m[1] || m[0]).trim() : '';
}

async function collect(target) {
  const host = sanitizeHostname(target);
  await waitTurn('whois:' + host);
  let text = '';
  try {
    text = await whoisQuery('whois.iana.org', host);
    const refer = pick(text, /refer:\s+(\S+)/i);
    if (refer && /^[a-z0-9.-]+$/i.test(refer) && refer !== 'whois.iana.org') {
      try {
        text += '\n' + (await whoisQuery(refer, host));
      } catch (_) { /* RDAP cobre */ }
    }
  } catch (e) {
    return [
      evidence(`whois indisponivel: ${String(e.message || e).slice(0, 80)}`, 'whois', 'whois://iana', {
        entityType: 'Error',
        confidence: 0.15,
        extra: { host }
      })
    ];
  }
  const out = [];
  const fields = [
    [/Registrar:\s*(.+)/i, 'Organization'],
    [/Registrant Organization:\s*(.+)/i, 'Organization'],
    [/Name Server:\s*(\S+)/gi, 'Domain'],
    [/nserver:\s*(\S+)/gi, 'Domain'],
    [/Creation Date:\s*(\S+)/i, 'Organization'],
    [/Registry Expiry Date:\s*(\S+)/i, 'Organization']
  ];
  for (const [re, entityType] of fields) {
    const global = re.flags.includes('g');
    if (global) {
      let m;
      const r = new RegExp(re.source, re.flags);
      while ((m = r.exec(text))) {
        out.push(evidence(m[1], 'whois', 'whois://iana', { entityType, confidence: 0.55, extra: { host } }));
      }
    } else {
      const v = pick(text, re);
      if (v) out.push(evidence(v, 'whois', 'whois://iana', { entityType, confidence: 0.55, extra: { host } }));
    }
  }
  if (!out.length) {
    out.push(evidence(host, 'whois', 'whois://iana', { entityType: 'Domain', confidence: 0.4, extra: { host, note: 'sem campos parseados' } }));
  }
  return out;
}

module.exports = { collect, name: 'whois' };
