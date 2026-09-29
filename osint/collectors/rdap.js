'use strict';

const { sanitizeHostname } = require('../core/guardrails');
const { fetchPublicJson, evidence } = require('../core/http');

function pushEntity(out, value, entityType, url, extra) {
  if (!value) return;
  out.push(
    evidence(value, 'rdap', url, {
      entityType,
      confidence: 0.65,
      extra
    })
  );
}

async function collect(target) {
  const host = sanitizeHostname(target);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const url = isIp
    ? `https://rdap.org/ip/${encodeURIComponent(host)}`
    : `https://rdap.org/domain/${encodeURIComponent(host)}`;
  const data = await fetchPublicJson(url, { rateKey: 'rdap.org' });
  const out = [];
  const selfUrl = url;
  pushEntity(out, data.ldhName || data.handle || host, isIp ? 'IP' : 'Domain', selfUrl, { kind: 'handle' });
  if (data.name) pushEntity(out, data.name, 'Organization', selfUrl, { kind: 'name' });
  const ns = data.nameservers || [];
  for (const n of ns) {
    pushEntity(out, n.ldhName || n, 'Domain', selfUrl, { kind: 'ns' });
  }
  const ents = data.entities || [];
  for (const e of ents) {
    const vcard = e.vcardArray && e.vcardArray[1];
    if (Array.isArray(vcard)) {
      for (const row of vcard) {
        if (!Array.isArray(row)) continue;
        const key = String(row[0] || '');
        const val = row[3];
        if (key === 'fn' && val) pushEntity(out, val, 'Organization', selfUrl, { kind: 'fn' });
        if (key === 'org' && val) pushEntity(out, Array.isArray(val) ? val[0] : val, 'Organization', selfUrl, { kind: 'org' });
      }
    }
    if (e.handle) pushEntity(out, e.handle, 'Organization', selfUrl, { kind: 'entity' });
  }
  const events = data.events || [];
  for (const ev of events) {
    if (ev.eventAction && ev.eventDate) {
      pushEntity(out, `${ev.eventAction}:${ev.eventDate}`, 'Organization', selfUrl, { kind: 'event' });
    }
  }
  if (data.network && data.network.name) {
    pushEntity(out, data.network.name, 'ASN', selfUrl, { kind: 'net' });
  }
  return out;
}

module.exports = { collect, name: 'rdap' };
