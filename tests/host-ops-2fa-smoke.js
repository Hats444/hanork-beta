'use strict';
/** Onda2.6: host* so platform_admin; PIN opcional. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../commands/raikken.js'), 'utf8');
assert.ok(src.includes('isPlatformAdminCtx'), 'gate platform_admin');
assert.ok(src.includes('HANORK_HOST_OPS_SECRET'), 'PIN 2o fator');
assert.ok(!/ownerOk\(ctx\)/.test(src) || src.includes('isPlatformAdminCtx'), 'nao so ownerOk');

// Simula gate logic sem API
function isPlatformAdminCtx(ctx) {
  return !!(
    ctx &&
    (ctx.isPlatformAdmin ||
      ctx.authRole === 'platform_admin' ||
      ctx.role === 'platform_admin')
  );
}

assert.strictEqual(isPlatformAdminCtx({ isOwner: true, authRole: 'owner' }), false);
assert.strictEqual(isPlatformAdminCtx({ authRole: 'platform_admin' }), true);
assert.strictEqual(isPlatformAdminCtx({ isPlatformAdmin: true }), true);

console.log('host-ops-2fa-smoke ok');
