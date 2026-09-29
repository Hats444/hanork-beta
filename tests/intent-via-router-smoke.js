'use strict';
/** Onda3.11+Parte2: Intent WA via Universal Router; catalog puxa registry. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const intentSrc = fs.readFileSync(path.join(__dirname, '../core/router/intent/index.js'), 'utf8');
assert.ok(intentSrc.includes('dispatchViaUniversalRouter'), 'dispatch via router');
assert.ok(intentSrc.includes('HANORK_INTENT_VIA_ROUTER'), 'flag reversivel');
assert.ok(intentSrc.includes('via_router'), 'log distinguivel');
assert.ok(intentSrc.includes('via_legacy'), 'legado preservado');

const catalogSrc = fs.readFileSync(path.join(__dirname, '../core/router/intent/catalog.js'), 'utf8');
assert.ok(catalogSrc.includes('listRegisteredCommands'), 'catalog puxa registry');

assert.ok(fs.existsSync(path.join(__dirname, '../core/intent/liveSchema.js')), 'liveSchema');
assert.ok(fs.existsSync(path.join(__dirname, '../sql/pg-schema.sql')), 'pg schema');

const { isDestructiveConfirmCommand } = require('../core/router/intent/safety');
assert.ok(isDestructiveConfirmCommand('nuke'));

console.log('intent-via-router-smoke ok');
