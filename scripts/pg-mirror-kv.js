'use strict';
/**
 * Espelha kv_store SQLite → Postgres (preparacao de cutover).
 * So roda com HANORK_PG_URL + HANORK_PG_DUAL_WRITE=1.
 * Uso: node scripts/pg-mirror-kv.js
 */
require('dotenv').config({ quiet: true });

async function main() {
  const pg = require('../services/pgClient');
  if (!pg.isConfigured()) {
    console.log('skip: sem HANORK_PG_URL');
    return;
  }
  if (!pg.isDualWrite()) {
    console.log('skip: HANORK_PG_DUAL_WRITE=0 (ligue pra espelhar)');
    return;
  }
  const schema = await pg.applySchema();
  console.log('schema', schema);
  const sql = require('../utils/sqlStore');
  sql.initSqlStore();
  const rows = await sql.allAsync('SELECT scope, key, value, updated_at FROM kv_store');
  let ok = 0;
  let fail = 0;
  for (const r of rows || []) {
    const done = await pg.upsert(
      'kv_store',
      {
        scope: r.scope,
        key: r.key,
        value: r.value,
        updated_at: r.updated_at || new Date().toISOString()
      },
      ['scope', 'key']
    );
    if (done) ok += 1;
    else fail += 1;
  }
  console.log(`mirror kv ok=${ok} fail=${fail} total=${(rows || []).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
