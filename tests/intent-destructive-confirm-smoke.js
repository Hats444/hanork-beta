'use strict';
/** Onda2.5: NLU destrutivo exige needConfirm; literal nao usa safety. */
const assert = require('assert');
const {
  applyIntentSafety,
  isDestructiveConfirmCommand
} = require('../core/router/intent/safety');

assert.ok(isDestructiveConfirmCommand('nuke'));
assert.ok(isDestructiveConfirmCommand('ban'));
assert.ok(isDestructiveConfirmCommand('apagar'));
assert.ok(!isDestructiveConfirmCommand('menu'));
assert.ok(!isDestructiveConfirmCommand('nukeconfig'));

const safe = applyIntentSafety(
  { command: 'nuke', confidence: 0.99 },
  'apagar o grupo agora nuke',
  { minConfidenceSensitive: 0.93 }
);
assert.strictEqual(safe.needConfirm, true, 'nuke NLU precisa confirmar');
assert.strictEqual(safe.command, 'nuke');
assert.ok(!safe.blocked);

const ban = applyIntentSafety(
  { command: 'ban', confidence: 0.95 },
  'banir esse membro',
  { minConfidenceSensitive: 0.93 }
);
assert.strictEqual(ban.needConfirm, true);

const menu = applyIntentSafety(
  { command: 'menu', confidence: 0.9 },
  'abre o menu',
  {}
);
assert.ok(!menu.needConfirm);

console.log('intent-destructive-confirm-smoke ok');
