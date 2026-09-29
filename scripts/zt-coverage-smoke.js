#!/usr/bin/env node
'use strict';
/**
 * Smoke: catalogo ZT carregado + todos cmds registrados no commands/index
 */
const assert = require('assert');
const { loadCatalog, allEntries, byCmd } = require('../core/zt/catalog');
const { listCommands, getCommand } = require('../commands/index');

const cat = loadCatalog();
assert.ok(cat.count >= 700, `catalogo pequeno: ${cat.count}`);
assert.ok(Array.isArray(cat.entries) && cat.entries.length === cat.count);

const registered = new Set(listCommands());
let missing = 0;
const missSamples = [];
const { ztCategoryAllowed } = require('../utils/contentGates');
for (const e of allEntries()) {
  if (String(e.category || '') === 'consultas') continue;
  if (!ztCategoryAllowed(e.category, e)) continue;
  if (!registered.has(e.cmd)) {
    missing++;
    if (missSamples.length < 15) missSamples.push(e.cmd);
  }
  assert.ok(byCmd(e.cmd), e.cmd);
}

assert.strictEqual(missing, 0, `cmds ausentes: ${missing} ex: ${missSamples.join(', ')}`);

// menus
for (const m of ['hanork', 'hanorkinfo', 'menu_hanorkdownloads', 'zt', 'menu_ztdownloads']) {
  assert.ok(getCommand(m), `falta ${m}`);
}
assert.ok(getCommand('hanorkia') || getCommand('zerotwoia'), 'falta hanorkia/zerotwoia');

// client
const zt = require('../services/zerotwoClient');
assert.ok(typeof zt.getJson === 'function');
assert.ok(typeof zt.apiUrl === 'function');

console.log(`OK zt-coverage: ${cat.count} endpoints, ${registered.size} cmds no bot`);
console.log('byCategory', JSON.stringify(cat.byCategory));
process.exit(0);
