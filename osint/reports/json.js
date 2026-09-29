'use strict';

const SCHEMA = 'hanork.osint.v1';

function toJson(report) {
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    target: report.target,
    modules: report.modules,
    summary: report.summary,
    overallConfidence: report.overallConfidence,
    ai: report.ai || { enabled: false, note: 'fase 1: ollama so apos collectors base' },
    entities: (report.entities || []).map((e) => ({
      entityType: e.entityType,
      value: e.value,
      status: e.status,
      confidence: e.confidence,
      sources: e.sources,
      independentSources: e.independentSources,
      evidencePath: e.evidencePath || []
    })),
    evidence: (report.evidence || []).map((ev, i) => ({
      n: i + 1,
      value: ev.value,
      source: ev.source,
      url: ev.url,
      collectedAt: ev.collectedAt,
      confidence: ev.confidence,
      status: ev.status,
      entityType: ev.entityType,
      runId: ev.runId || report.runId || '',
      ownerKey: ev.ownerKey || report.ownerKey || ''
    })),
    skipped: report.skipped || [],
    plan: report.plan || null,
    facts: report.facts || null,
    relations: report.relations || [],
    chronology: report.chronology || [],
    compare: report.compare || null,
    uncertainties: report.uncertainties || [],
    retention: report.retention
  };
}

module.exports = { toJson, SCHEMA };
