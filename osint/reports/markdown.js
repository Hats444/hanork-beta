'use strict';

const { formatReportBlock, labelValue } = require('../../utils/typography');
const { stripForbiddenPii } = require('../core/guardrails');

const MAX = 60000;

function factLine(e) {
  const extra = e.extra && e.extra.platform ? ` ${e.extra.platform}` : '';
  return labelValue(
    String(e.value || '').slice(0, 140),
    `${e.status || ''} src=${e.independentSources || 0} c=${e.confidence}${extra}`
  );
}

function toMarkdown(report) {
  const facts = report.facts || { confirmed: [], probable: [], conflict: [], unverified: [], stale: [] };
  const rows = [
    labelValue('Alvo', report.target),
    labelValue('Modulos', (report.modules || []).join(', ') || '-'),
    labelValue('Confianca geral', String(report.overallConfidence)),
    labelValue('Coletado', report.collectedAt || ''),
    labelValue('Run', report.runId || '-'),
    labelValue('IA', report.ai && report.ai.enabled && !report.ai.skipped
      ? `ON (${report.ai.via || 'ollama'})`
      : (report.ai && report.ai.note) || 'sem IA'),
    ''
  ];
  if (report.plan && report.plan.collectors) {
    rows.push('METODO');
    rows.push(`Coletores: ${(report.plan.collectors || []).join(', ') || '-'}`);
    if (report.plan.lang) rows.push(`lang=${report.plan.lang}`);
    if (report.plan.since) rows.push(`since=${report.plan.since}`);
    rows.push('');
  }
  if (report.summary) {
    rows.push('RESUMO');
    rows.push(report.summary);
    rows.push('');
  }
  if (report.ai && report.ai.text) {
    rows.push('INTERPRETACAO (local, nao e fato extra)');
    rows.push(String(report.ai.text).slice(0, 2500));
    rows.push('');
  }

  const pushFact = (title, list) => {
    rows.push(title);
    const arr = list || [];
    if (!arr.length) {
      rows.push('(nenhum)');
      rows.push('');
      return;
    }
    for (const e of arr) rows.push(factLine(e));
    rows.push('');
  };
  pushFact('CONFIRMADO (2+ fontes)', facts.confirmed);
  pushFact('PROVAVEL', facts.probable);
  pushFact('CONFLITO', facts.conflict);
  pushFact('NAO VERIFICADO', facts.unverified);
  if ((facts.stale || []).length) pushFact('STALE', facts.stale);

  rows.push('ENTIDADES');
  const byType = new Map();
  for (const e of report.entities || []) {
    const list = byType.get(e.entityType) || [];
    list.push(e);
    byType.set(e.entityType, list);
  }
  for (const [type, list] of byType) {
    rows.push(type.toUpperCase());
    for (const e of list) {
      rows.push(factLine(e));
      const path = e.evidencePath || [];
      for (const p of path) {
        if (p && p.url) rows.push(`   ${String(p.source || '')} ${String(p.url).slice(0, 180)}`);
      }
    }
    rows.push('');
  }

  const evidence = report.evidence || [];
  rows.push(`EVIDENCIAS (${evidence.length})`);
  evidence.forEach((ev, i) => {
    rows.push(`${i + 1}. [${ev.source}] ${String(ev.value || '').slice(0, 240)}`);
    if (ev.url) rows.push(`   ${String(ev.url).slice(0, 240)}`);
    if (ev.collectedAt) rows.push(`   ${String(ev.collectedAt)}`);
    if (ev.extra && ev.extra.desc) rows.push(`   ${String(ev.extra.desc).slice(0, 200)}`);
    if (ev.extra && ev.extra.platform) {
      rows.push(`   ${ev.extra.platform} ${ev.extra.status || ''}`.trim());
    }
  });
  rows.push('');

  const rels = report.relations || [];
  if (rels.length) {
    rows.push(`RELACOES (${rels.length})`);
    for (const r of rels) {
      rows.push(`${r.fromType}:${String(r.fromValue).slice(0, 80)} ${r.rel} ${r.toType}:${String(r.toValue).slice(0, 80)}`);
    }
    rows.push('');
  }

  const chrono = report.chronology || [];
  if (chrono.length) {
    rows.push(`CRONOLOGIA (${chrono.length})`);
    for (const c of chrono) {
      rows.push(`${String(c.at || '').slice(0, 24)} [${c.source}] ${String(c.value || '').slice(0, 120)}`);
      if (c.url) rows.push(`   ${String(c.url).slice(0, 200)}`);
    }
    rows.push('');
  }

  const skipped = report.skipped || [];
  if (skipped.length) {
    rows.push('PULADO (nao fingido)');
    const seen = new Set();
    for (const s of skipped) {
      const line = `${s.name}: ${s.reason}`;
      if (seen.has(line)) continue;
      seen.add(line);
      rows.push(`- ${line}`);
    }
    rows.push('Export PDF/CSV: ainda nao. Alertas: nao nesta versao.');
    rows.push('');
  }

  if (report.uncertainties && report.uncertainties.length) {
    rows.push('NAO VERIFICAVEL');
    for (const u of report.uncertainties) rows.push(`- ${u}`);
  }

  let text = formatReportBlock('OSINT', rows);
  text = stripForbiddenPii(text);
  if (text.length > MAX) {
    text = text.slice(0, MAX - 70) + '\n(…teto WhatsApp 60k; JSON interno tem o resto)';
  }
  return text;
}

module.exports = { toMarkdown };
