'use strict';
/** Onda3.10: PG dual-write idle sem URL; schema file presente. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const schema = path.join(__dirname, '../sql/pg-schema.sql');
assert.ok(fs.existsSync(schema), 'sql/pg-schema.sql existe');
const sql = fs.readFileSync(schema, 'utf8');
assert.ok(/billing_order/.test(sql) && /billing_payment/.test(sql) && /billing_entitlement/.test(sql));

const pg = require('../services/pgClient');
assert.strictEqual(typeof pg.isConfigured, 'function');
assert.strictEqual(typeof pg.isDualWrite, 'function');
assert.strictEqual(typeof pg.applySchema, 'function');

// Sem URL: dual-write off, upsert no-op seguro
delete process.env.HANORK_PG_URL;
delete process.env.DATABASE_URL;
process.env.HANORK_PG_DUAL_WRITE = '0';
assert.strictEqual(pg.isConfigured(), false);
assert.strictEqual(pg.isDualWrite(), false);

console.log('pg-dualwrite-smoke ok (idle sem URL)');
