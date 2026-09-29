'use strict';
const assert = require('assert');
const cb = require('../utils/waCircuitBreaker');

cb.reset();
assert.strictEqual(cb.isOpen(), false);
cb.trip(500, { fanoutJoinCooldown: false, log: false });
assert.strictEqual(cb.isOpen(), true);
assert.ok(cb.remainingMs() > 0);
cb.reset();
assert.strictEqual(cb.isOpen(), false);

cb.tripKey('u1', 1000);
assert.strictEqual(cb.isKeyOpen('u1'), true);
assert.strictEqual(cb.isKeyOpen('u2'), false);

const patch = require('../utils/waSendPatch');
assert.strictEqual(typeof patch.waOverHot, 'function');
assert.strictEqual(typeof patch.markWaOverlimit, 'function');
patch.clearWaOverlimit();
assert.strictEqual(patch.waOverHot(), false);

console.log('wa-circuit-breaker-smoke ok');
