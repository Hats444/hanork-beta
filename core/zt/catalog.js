// core/zt/catalog.js — carrega catalogo Hanork API
'use strict';

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, 'catalog.json');

let _cache = null;

function loadCatalog() {
  if (_cache) return _cache;
  if (!fs.existsSync(CATALOG_PATH)) {
    _cache = { version: 0, count: 0, entries: [], byCategory: {} };
    return _cache;
  }
  _cache = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  return _cache;
}

function allEntries() {
  return loadCatalog().entries || [];
}

function byCmd(name) {
  const n = String(name || '').toLowerCase();
  for (const e of allEntries()) {
    if (e.cmd === n) return e;
    if (Array.isArray(e.aliases) && e.aliases.includes(n)) return e;
  }
  return null;
}

function permissionFor(name) {
  const e = byCmd(name);
  return e?.permission || null;
}

function cmdsByCategory(cat) {
  return allEntries().filter((e) => e.category === cat);
}

function categories() {
  return Object.keys(loadCatalog().byCategory || {});
}

function reload() {
  _cache = null;
  return loadCatalog();
}

module.exports = {
  CATALOG_PATH,
  loadCatalog,
  allEntries,
  byCmd,
  permissionFor,
  cmdsByCategory,
  categories,
  reload
};
