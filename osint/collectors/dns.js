'use strict';

const dns = require('dns').promises;
const { sanitizeHostname } = require('../core/guardrails');
const { evidence, fetchPublicJson } = require('../core/http');
const { waitTurn } = require('../core/rateLimit');

const TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'SOA'];
const DOH_TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28 };

function asList(recs) {
  return Array.isArray(recs) ? recs : recs == null ? [] : [recs];
}

function toEvidence(host, type, rec) {
  let value = rec;
  let entityType = 'Domain';
  if (type === 'A' || type === 'AAAA') {
    value = typeof rec === 'string' ? rec : rec.address || rec.data;
    entityType = 'IP';
  } else if (type === 'MX') {
    if (typeof rec === 'string') value = rec.replace(/^\d+\s+/, '');
    else value = rec.exchange || rec.data;
    entityType = 'Domain';
  } else if (type === 'SOA') {
    value = rec.nsname ? `${rec.nsname} ${rec.hostmaster}` : String(rec.data || rec);
    entityType = 'Organization';
  } else if (type === 'TXT') {
    value = Array.isArray(rec) ? rec.join(' ') : rec.data || rec;
  } else if (type === 'NS' || type === 'CNAME') {
    value = typeof rec === 'string' ? rec : rec.data || rec;
    entityType = 'Domain';
  }
  return evidence(value, 'dns', `dns:${type}:${host}`, {
    entityType,
    confidence: 0.7,
    extra: { rr: type, host }
  });
}

async function resolveNative(host, type) {
  const recs = await dns.resolve(host, type);
  return asList(recs).map((rec) => toEvidence(host, type, rec));
}

async function resolveDoh(host, type) {
  const qtype = DOH_TYPE[type];
  if (!qtype) return [];
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${qtype}`;
  const data = await fetchPublicJson(url, {
    rateKey: 'cloudflare-dns.com',
    accept: 'application/dns-json',
    skipRate: true
  });
  const answers = Array.isArray(data.Answer) ? data.Answer : [];
  return answers
    .filter((a) => Number(a.type) === qtype && a.data)
    .map((a) => toEvidence(host, type, a.data));
}

function isEmptyDns(e) {
  return /ENODATA|ENOTFOUND|SERVFAIL|NOTFOUND|NXDOMAIN/i.test(String(e.code || e.message));
}

function isResolverDown(e) {
  return /ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timeout/i.test(String(e.code || e.message));
}

async function collect(target) {
  const host = sanitizeHostname(target);
  await waitTurn('dns:' + host);
  const out = [];
  let resolverDown = false;
  const native = await Promise.all(TYPES.map(async (type) => {
    try {
      return await resolveNative(host, type);
    } catch (e) {
      if (isEmptyDns(e)) return [];
      if (isResolverDown(e)) {
        resolverDown = true;
        return [];
      }
      return [
        evidence(String(e.message || e).slice(0, 120), 'dns', `dns:${type}:${host}`, {
          entityType: 'Error',
          confidence: 0.1,
          extra: { rr: type, host }
        })
      ];
    }
  }));
  for (const chunk of native) out.push(...chunk);
  if (resolverDown) {
    await waitTurn('cloudflare-dns.com');
    const chunks = await Promise.all(
      TYPES.map(async (type) => {
        try {
          return await resolveDoh(host, type);
        } catch (e2) {
          if (isEmptyDns(e2)) return [];
          return [
            evidence(String(e2.message || e2).slice(0, 120), 'dns', `dns:${type}:${host}`, {
              entityType: 'Error',
              confidence: 0.1,
              extra: { rr: type, host, via: 'doh' }
            })
          ];
        }
      })
    );
    for (const chunk of chunks) out.push(...chunk);
  }
  return out;
}

module.exports = { collect, name: 'dns' };
