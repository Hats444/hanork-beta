'use strict';
/**
 * Postgres opcional. Sem HANORK_PG_URL (ou DATABASE_URL) nao conecta.
 * Dual-write: HANORK_PG_DUAL_WRITE=1 (escrita espelha; SQLite primario).
 * Leitura PG: HANORK_DB_DRIVER=pg (com fallback SQLite no sqlStore).
 * Falha no PG nunca quebra o bot.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

let pool = null;
let missingDriverLogged = false;
let failLoggedAt = 0;

function pgUrl() {
  return String(process.env.HANORK_PG_URL || process.env.DATABASE_URL || '').trim();
}

function isConfigured() {
  return !!pgUrl();
}

function isDualWrite() {
  const v = String(process.env.HANORK_PG_DUAL_WRITE || '0').trim().toLowerCase();
  return isConfigured() && v !== '0' && v !== 'false' && v !== 'off';
}

/** Leitura preferencial no PG (cutover). Default sqlite. */
function isReadFromPg() {
  const d = String(process.env.HANORK_DB_DRIVER || 'sqlite').trim().toLowerCase();
  return isConfigured() && (d === 'pg' || d === 'postgres' || d === 'postgresql');
}

function getPool() {
  if (!isConfigured()) return null;
  if (pool) return pool;
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (_) {
    if (!missingDriverLogged) {
      missingDriverLogged = true;
      logger.logAviso('[pg] driver `pg` ausente. npm i pg quando HANORK_PG_URL existir.');
    }
    return null;
  }
  pool = new Pool({
    connectionString: pgUrl(),
    max: Math.min(10, Math.max(2, Number(process.env.HANORK_PG_POOL || 4))),
    idleTimeoutMillis: 15000
  });
  pool.on('error', (e) => {
    logger.logAviso(`[pg] pool: ${e.message}`);
  });
  return pool;
}

async function query(text, params = []) {
  const p = getPool();
  if (!p) return null;
  return p.query(text, params);
}

async function upsert(table, row, pkCols) {
  if (!isDualWrite() || !row || !table) return false;
  const cols = Object.keys(row);
  if (!cols.length) return false;
  const pks = Array.isArray(pkCols) ? pkCols : [pkCols];
  const values = cols.map((_, i) => `$${i + 1}`);
  const updates = cols.filter((c) => !pks.includes(c)).map((c) => `${c}=EXCLUDED.${c}`);
  const sql =
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${values.join(',')})` +
    (updates.length ? ` ON CONFLICT (${pks.join(',')}) DO UPDATE SET ${updates.join(',')}` : ` ON CONFLICT (${pks.join(',')}) DO NOTHING`);
  try {
    await query(sql, cols.map((c) => row[c]));
    return true;
  } catch (e) {
    const now = Date.now();
    if (now - failLoggedAt > 60000) {
      failLoggedAt = now;
      logger.logAviso(`[pg] dual-write ${table}: ${e.message}`);
    }
    return false;
  }
}

async function getKv(scope, key) {
  if (!isConfigured()) return null;
  try {
    const res = await query(
      'SELECT value FROM kv_store WHERE scope=$1 AND key=$2 LIMIT 1',
      [String(scope), String(key)]
    );
    if (!res || !res.rows || !res.rows[0]) return null;
    return res.rows[0].value;
  } catch (e) {
    const now = Date.now();
    if (now - failLoggedAt > 60000) {
      failLoggedAt = now;
      logger.logAviso(`[pg] getKv: ${e.message}`);
    }
    return null;
  }
}

async function applySchema() {
  if (!isConfigured()) return { ok: false, reason: 'no-url' };
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'pg-schema.sql'), 'utf8');
  await query(sql);
  return { ok: true };
}

function health() {
  return {
    configured: isConfigured(),
    dualWrite: isDualWrite(),
    readDriver: isReadFromPg() ? 'pg' : 'sqlite',
    pool: !!pool
  };
}

module.exports = {
  pgUrl,
  isConfigured,
  isDualWrite,
  isReadFromPg,
  getPool,
  query,
  upsert,
  getKv,
  applySchema,
  health
};
