'use strict';
/** Cutover gradual PG: dual-write kv + driver flag + schema. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const schema = fs.readFileSync(path.join(__dirname, '../sql/pg-schema.sql'), 'utf8');
assert.ok(/kv_store/.test(schema) && /group_flags/.test(schema));

const pg = require('../services/pgClient');
assert.strictEqual(typeof pg.isReadFromPg, 'function');
assert.strictEqual(typeof pg.health, 'function');
assert.strictEqual(typeof pg.getKv, 'function');

delete process.env.HANORK_PG_URL;
delete process.env.DATABASE_URL;
process.env.HANORK_PG_DUAL_WRITE = '0';
process.env.HANORK_DB_DRIVER = 'sqlite';
assert.strictEqual(pg.isConfigured(), false);
assert.strictEqual(pg.isDualWrite(), false);
assert.strictEqual(pg.isReadFromPg(), false);
assert.strictEqual(pg.health().readDriver, 'sqlite');

const storeSrc = fs.readFileSync(path.join(__dirname, '../utils/sqlStore.js'), 'utf8');
assert.ok(storeSrc.includes("pg.upsert('kv_store'"), 'kv dual-write');
assert.ok(storeSrc.includes("'group_flags'") && storeSrc.includes('isDualWrite'), 'flags dual-write');
assert.ok(storeSrc.includes('isReadFromPg'), 'read path pg');

const healthSrc = fs.readFileSync(path.join(__dirname, '../services/healthServer.js'), 'utf8');
assert.ok(healthSrc.includes('postgres:'), 'health expoe postgres');

console.log('pg-cutover-smoke ok');
