'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

assert.ok(fs.existsSync(path.join(__dirname, '../utils/opsAlerts.js')));
assert.ok(fs.existsSync(path.join(__dirname, '../utils/waCircuitBreaker.js')));
const ops = fs.readFileSync(path.join(__dirname, '../services/opsJobs.js'), 'utf8');
assert.ok(ops.includes('opsAlerts'), 'opsJobs chama opsAlerts');

const alerts = require('../utils/opsAlerts');
assert.strictEqual(typeof alerts.tick, 'function');
assert.ok(alerts.enabled());

console.log('ops-alerts-smoke ok');
