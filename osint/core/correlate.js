'use strict';

function foldName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function sameHost(a, b) {
  const x = String(a || '').replace(/^www\./i, '').toLowerCase().replace(/\.$/, '');
  const y = String(b || '').replace(/^www\./i, '').toLowerCase().replace(/\.$/, '');
  return !!x && x === y;
}

function sameUsername(a, b) {
  return foldName(a).replace(/^@/, '') === foldName(b).replace(/^@/, '') && !!foldName(a);
}

function classifyFacts(entities) {
  const facts = { confirmed: [], probable: [], conflict: [], unverified: [], stale: [] };
  for (const e of entities || []) {
    if (e.status === 'VERIFIED') facts.confirmed.push(e);
    else if (e.status === 'CONTRADICTED') facts.conflict.push(e);
    else if (e.status === 'STALE') facts.stale.push(e);
    else if (e.status === 'PARTIALLY_VERIFIED' || (Number(e.independentSources) === 1 && Number(e.confidence) >= 0.5)) {
      facts.probable.push(e);
    } else facts.unverified.push(e);
  }
  return facts;
}

function extraRelations(parsed, entities, evidence) {
  const rels = [];
  const host = String((parsed && (parsed.host || parsed.label)) || '').toLowerCase();
  const domainsByIp = new Map();
  for (const ev of evidence || []) {
    const h = ev.extra && ev.extra.host ? String(ev.extra.host).toLowerCase() : host;
    if (ev.entityType === 'IP' && h) {
      const list = domainsByIp.get(ev.value) || [];
      if (!list.includes(h)) list.push(h);
      domainsByIp.set(ev.value, list);
    }
  }
  for (const [ip, hosts] of domainsByIp) {
    if (hosts.length < 2) continue;
    rels.push({
      fromType: 'Domain',
      fromValue: hosts[0],
      rel: 'SHARES_INFRA',
      toType: 'Domain',
      toValue: hosts[1],
      extra: { ip }
    });
  }
  const byFold = new Map();
  for (const e of entities || []) {
    if (!['Person', 'Organization', 'Username'].includes(e.entityType)) continue;
    const f = foldName(e.value);
    if (!f || f.length < 3) continue;
    const prev = byFold.get(f);
    if (prev && prev.value !== e.value) {
      const n = Number(prev.independentSources || 0) + Number(e.independentSources || 0);
      if (n >= 2) {
        rels.push({
          fromType: prev.entityType,
          fromValue: prev.value,
          rel: 'SAME_AS',
          toType: e.entityType,
          toValue: e.value
        });
      }
    } else if (!prev) byFold.set(f, e);
  }
  const sans = (entities || []).filter((e) => e.entityType === 'Subdomain' || e.entityType === 'Certificate');
  for (const s of sans.slice(0, 12)) {
    if (host && !sameHost(host, s.value)) {
      rels.push({
        fromType: 'Domain',
        fromValue: host,
        rel: 'HAS_SAN',
        toType: s.entityType,
        toValue: s.value
      });
    }
  }
  const users = (entities || []).filter((e) => e.entityType === 'Username');
  for (const u of users.slice(0, 8)) {
    if (host) {
      rels.push({
        fromType: 'Domain',
        fromValue: host,
        rel: 'MENTIONS',
        toType: 'Username',
        toValue: u.value
      });
    }
  }
  for (const ev of evidence || []) {
    if (ev.extra && ev.extra.rel === 'LINKS_TO' && ev.url) {
      rels.push({
        fromType: 'Page',
        fromValue: host || 'page',
        rel: 'LINKS_TO',
        toType: 'Url',
        toValue: ev.url
      });
    }
  }
  return rels;
}

function chronology(evidence) {
  return (evidence || [])
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a.collectedAt || '') || 0;
      const tb = Date.parse(b.collectedAt || '') || 0;
      return ta - tb;
    })
    .slice(0, 80)
    .map((ev) => ({
      at: (ev.extra && (ev.extra.notBefore || ev.extra.timestamp)) || ev.collectedAt,
      source: ev.source,
      value: String(ev.value || '').slice(0, 80),
      url: ev.url || ''
    }));
}

function correlate({ parsed, entities, evidence, relations }) {
  const extra = extraRelations(parsed, entities, evidence);
  const facts = classifyFacts(entities);
  return {
    relations: [...(relations || []), ...extra],
    chronology: chronology(evidence),
    facts,
    foldName,
    sameHost,
    sameUsername
  };
}

module.exports = { correlate, foldName, sameHost, sameUsername, classifyFacts };
