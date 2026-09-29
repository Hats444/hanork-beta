'use strict';
require('dotenv').config();
const pg = require('../services/pgClient');

(async () => {
  if (!pg.isConfigured()) {
    console.log('HANORK_PG_URL/DATABASE_URL vazio — nao aplica schema. SQLite segue fonte.');
    process.exit(0);
  }
  const r = await pg.applySchema();
  console.log(r.ok ? 'pg-schema ok' : r);
  process.exit(r.ok ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
