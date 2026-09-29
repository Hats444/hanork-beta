'use strict';

const logger = require('../logger');

function retentionMs() {
  const n = parseInt(process.env.OSINT_RETENTION_MS, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

async function persistRun(payload) {
  const sql = require('../utils/sqlStore');
  const runId = payload.runId;
  const ownerKey = String(payload.ownerKey || 'session').slice(0, 80);
  const now = new Date().toISOString();
  await sql.runAsync(
    `INSERT INTO osint_audit (run_id, owner_key, target, modules, created_at) VALUES (?, ?, ?, ?, ?)`,
    [runId, ownerKey, String(payload.target || '').slice(0, 253), String(payload.modules || ''), now]
  );
  for (const ev of payload.evidence || []) {
    await sql.runAsync(
      `INSERT INTO osint_evidence (run_id, entity_type, value, source, url, collected_at, confidence, status, extra, owner_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        ev.entityType,
        ev.value,
        ev.source,
        ev.url || '',
        ev.collectedAt,
        ev.confidence,
        ev.status || 'UNVERIFIED',
        ev.extra ? JSON.stringify(ev.extra).slice(0, 2000) : null,
        ownerKey
      ]
    );
  }
  for (const ent of payload.entities || []) {
    await sql.runAsync(
      `INSERT OR REPLACE INTO osint_entities (run_id, entity_type, value, status, confidence, sources)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, ent.entityType, ent.value, ent.status, ent.confidence, JSON.stringify(ent.sources || [])]
    );
  }
  for (const rel of payload.relations || []) {
    await sql.runAsync(
      `INSERT INTO osint_relations (run_id, from_type, from_value, rel, to_type, to_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, rel.fromType, rel.fromValue, rel.rel, rel.toType, rel.toValue]
    );
  }
}

async function deleteRun(runId) {
  const sql = require('../utils/sqlStore');
  await sql.runAsync(`DELETE FROM osint_evidence WHERE run_id = ?`, [runId]);
  await sql.runAsync(`DELETE FROM osint_entities WHERE run_id = ?`, [runId]);
  await sql.runAsync(`DELETE FROM osint_relations WHERE run_id = ?`, [runId]);
}

async function applyRetention(runId) {
  const ms = retentionMs();
  if (ms === 0) {
    try {
      await deleteRun(runId);
    } catch (e) {
      logger.logAviso(`[osint] retention delete: ${e.message}`);
    }
    return 'deleted';
  }
  return `keep_${ms}ms`;
}

module.exports = { persistRun, deleteRun, applyRetention, retentionMs };
