'use strict';

const crypto = require('crypto');
const logger = require('../../logger');
const { assertPassiveTarget } = require('./guardrails');
const { parseOsintTarget, pickModulesFor, hostOf } = require('./target');
const { buildPlan } = require('./plan');
const { normalizeEvidence } = require('./normalizer');
const { dedupe } = require('./deduplicator');
const { verify, overallConfidence } = require('./verifier');
const { correlate } = require('./correlate');
const { persistRun, applyRetention } = require('../store');
const { toMarkdown } = require('../reports/markdown');
const { toJson } = require('../reports/json');
const ollama = require('../ai/ollama');
const decode = require('../collectors/decode');
const cryptoCol = require('../collectors/crypto');

const COLLECTORS = {
  dns: () => require('../collectors/dns'),
  rdap: () => require('../collectors/rdap'),
  whois: () => require('../collectors/whois'),
  certs: () => require('../collectors/certificates'),
  github: () => require('../collectors/github'),
  web: () => require('../collectors/web'),
  search: () => require('../collectors/search'),
  archive: () => require('../collectors/archive'),
  username: () => require('../collectors/username'),
  email: () => require('../collectors/email'),
  pastes: () => require('../collectors/pastes'),
  media: () => require('../collectors/media')
};

function pickModules(mod, parsed) {
  return pickModulesFor(mod, parsed);
}

function collectorArg(name, parsed) {
  if (['github', 'web', 'search', 'username', 'email', 'media', 'archive', 'pastes'].includes(name)) return parsed;
  return parsed.host || parsed.label || parsed.raw;
}

function buildRelations(parsed, entities) {
  const rels = [];
  const host = String(parsed.host || parsed.label || '').toLowerCase();
  const ips = entities.filter((e) => e.entityType === 'IP');
  const certs = entities.filter((e) => e.entityType === 'Certificate' || e.entityType === 'Subdomain');
  const orgs = entities.filter((e) => e.entityType === 'Organization');
  const users = entities.filter((e) => e.entityType === 'Username');
  const repos = entities.filter((e) => e.entityType === 'Repository');
  for (const ip of ips) {
    rels.push({ fromType: 'Domain', fromValue: host, rel: 'RESOLVES_TO', toType: 'IP', toValue: ip.value });
  }
  for (const c of certs) {
    rels.push({ fromType: 'Domain', fromValue: host, rel: 'HAS_CERT', toType: c.entityType, toValue: c.value });
  }
  for (const o of orgs.slice(0, 20)) {
    rels.push({ fromType: 'Domain', fromValue: host, rel: 'RELATED_ORG', toType: 'Organization', toValue: o.value });
  }
  for (const u of users.slice(0, 4)) {
    for (const r of repos.slice(0, 8)) {
      rels.push({ fromType: 'Username', fromValue: u.value, rel: 'OWNS_REPO', toType: 'Repository', toValue: r.value });
    }
  }
  return rels;
}

async function runCollector(name, parsed) {
  const col = COLLECTORS[name]();
  return col.collect(collectorArg(name, parsed));
}

function withTimeout(promise, ms, name) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${name} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

function onionReport(parsed, ownerKey) {
  const plan = buildPlan(parsed, 'all');
  const report = {
    runId: crypto.randomBytes(8).toString('hex'),
    target: parsed.label || parsed.raw,
    modules: [],
    collectedAt: new Date().toISOString(),
    summary: 'Alvo .onion nao e coletado neste bot (so http/https publico).',
    overallConfidence: 0,
    entities: [],
    evidence: [],
    relations: [],
    uncertainties: ['Alvo .onion nao e coletado neste bot (so http/https publico).'],
    skipped: plan.skipped,
    plan,
    facts: { confirmed: [], probable: [], conflict: [], unverified: [], stale: [] },
    chronology: [],
    ai: { enabled: false, skipped: true, note: 'onion_skip', text: 'nao coletado' },
    retention: null,
    ownerKey
  };
  return {
    report,
    markdown: toMarkdown(report),
    json: toJson(report)
  };
}

/**
 * Pipeline: plan -> collectors -> decode/crypto scan -> normalize -> dedupe -> verify -> correlate -> ollama -> report.
 */
async function run({ target, moduleName, ownerKey, onProgress }) {
  assertPassiveTarget(typeof target === 'object' ? (target.raw || target.label) : target);
  const parsed = typeof target === 'object' && target.kind ? target : parseOsintTarget(target);
  if (parsed.kind === 'onion') {
    if (onProgress) await onProgress('plano', 'onion recusado');
    return onionReport(parsed, ownerKey);
  }

  const plan = buildPlan(parsed, moduleName);
  const modules = plan.collectors;
  const runId = crypto.randomBytes(8).toString('hex');
  const collectedAt = new Date().toISOString();
  const raw = [];
  const errors = [];
  const skipped = [...(plan.skipped || [])];

  if (onProgress) {
    await onProgress(
      'plano',
      `${modules.join(', ') || 'nenhum'} (~${Math.round(plan.estimatedMs / 1000)}s)`
    );
  }

  const COLLECTOR_MS = 18000;
  const pool = Math.min(5, Math.max(2, modules.length));
  await mapPool(modules, pool, async (name) => {
    if (!['github', 'web', 'search', 'username', 'email', 'media', 'pastes'].includes(name) && !hostOf(parsed) && !parsed.host) {
      return;
    }
    if (onProgress) await onProgress(name, 'coletando');
    try {
      const chunk = await withTimeout(runCollector(name, parsed), COLLECTOR_MS, name);
      raw.push(...(chunk || []));
    } catch (e) {
      const msg = String(e.message || e).slice(0, 160);
      logger.logAviso(`[osint] ${name}: ${msg}`);
      errors.push(`${name}: ${msg}`);
      skipped.push({ name, reason: /timeout/i.test(msg) ? 'timeout' : 'collector_error' });
    }
  });

  try {
    raw.push(...decode.scanBlobs([parsed.raw, parsed.query, ...raw.map((e) => e.value)]));
    raw.push(...cryptoCol.scanEvidence(raw));
    raw.push(...require('../collectors/email').huntInBlobs(raw.map((e) => `${e.value || ''} ${e.extra && e.extra.desc || ''}`)));
  } catch (_) { /* pos-scan opcional */ }

  let evidence = normalizeEvidence(raw);
  try {
    const sql = require('../../utils/sqlStore');
    const last = sql.getCachedKv(`osint:${ownerKey || '0'}`, 'last_run');
    const tgt = parsed.label || parsed.host || parsed.raw;
    if (last && last.target === tgt && Array.isArray(last.urls) && last.urls.length) {
      const prev = new Set(last.urls.filter(Boolean));
      const repeatSrc = new Set(['web', 'search', 'archive']);
      evidence = evidence.filter((e) => !repeatSrc.has(e.source) || !e.url || !prev.has(e.url));
    }
  } catch (_) { /* incremental opcional */ }
  evidence = evidence.map((e) => ({ ...e, runId, ownerKey }));
  const entities = verify(dedupe(evidence));
  const baseRels = buildRelations(parsed, entities);
  const corr = correlate({ parsed, entities, evidence, relations: baseRels });
  const conf = overallConfidence(entities);
  const unverified = entities.filter((e) => e.status === 'UNVERIFIED').map((e) => `${e.entityType} ${e.value}`);
  const uncertainties = [
    ...unverified.slice(0, 40),
    ...errors,
    'VERIFIED exige 2 fontes independentes; uma fonte so nao confirma.',
    ...skipped.slice(0, 40).map((s) => `pulado ${s.name}: ${s.reason}`)
  ];

  if (onProgress) await onProgress('verify', 'cruzando fontes');
  if (onProgress) await onProgress('ia', 'interpretando');
  const ai = await ollama.analyze({ entities, evidence, skipped, facts: corr.facts });

  const report = {
    runId,
    target: parsed.label || parsed.host || parsed.raw,
    modules,
    collectedAt,
    summary: `${entities.length} entidades / ${evidence.length} evidencias / ${entities.filter((e) => e.status === 'VERIFIED').length} verificadas`,
    overallConfidence: conf,
    entities,
    evidence,
    relations: corr.relations,
    chronology: corr.chronology,
    facts: corr.facts,
    skipped,
    plan,
    uncertainties,
    ai,
    retention: null,
    ownerKey
  };

  try {
    await persistRun({
      runId,
      ownerKey,
      target: String(report.target).slice(0, 200),
      modules: modules.join(','),
      evidence,
      entities,
      relations: corr.relations
    });
    report.retention = await applyRetention(runId);
    try {
      const sql = require('../../utils/sqlStore');
      sql.upsertKv(`osint:${ownerKey || '0'}`, 'last_run', {
        runId,
        target: report.target,
        at: collectedAt,
        urls: evidence.map((e) => e.url).filter(Boolean).slice(0, 80)
      });
    } catch (_) { /* kv opcional */ }
  } catch (e) {
    logger.logAviso(`[osint] sql: ${e.message}`);
    report.retention = 'sql_skip';
  }

  if (String(process.env.HANORK_OSINT_DUMP || '') === '1') {
    logger.logInfo(`[osint] dump run=${runId} n=${evidence.length}`);
  }

  return {
    report,
    markdown: toMarkdown(report),
    json: toJson(report)
  };
}

async function runCompare({ a, b, ownerKey, onProgress }) {
  if (onProgress) await onProgress('compare', 'alvo A');
  const left = await run({ target: a, moduleName: 'all', ownerKey, onProgress });
  if (onProgress) await onProgress('compare', 'alvo B');
  const right = await run({ target: b, moduleName: 'all', ownerKey, onProgress });
  const key = (e) => `${e.entityType}|${String(e.value || '').toLowerCase()}`;
  const setB = new Set((right.report.entities || []).map(key));
  const common = (left.report.entities || []).filter((e) => setB.has(key(e)));
  const report = {
    runId: crypto.randomBytes(8).toString('hex'),
    target: `compare ${left.report.target} | ${right.report.target}`,
    modules: ['compare'],
    collectedAt: new Date().toISOString(),
    summary: `${common.length} entidades em comum`,
    overallConfidence: 0,
    entities: common,
    evidence: [],
    relations: [],
    chronology: [],
    facts: correlate({ parsed: {}, entities: common, evidence: [], relations: [] }).facts,
    skipped: [...(left.report.skipped || []), ...(right.report.skipped || [])],
    uncertainties: [`A: ${left.report.target}`, `B: ${right.report.target}`],
    ai: { enabled: false, skipped: true, note: 'compare', text: 'intersecao de entidades ja coletadas; nao e identidade civil.' },
    retention: null,
    compare: {
      a: left.report.target,
      b: right.report.target,
      common: common.map((e) => ({ type: e.entityType, value: e.value, status: e.status }))
    }
  };
  return { report, markdown: toMarkdown(report), json: toJson(report) };
}

module.exports = { run, runCompare, pickModules, buildPlan };
