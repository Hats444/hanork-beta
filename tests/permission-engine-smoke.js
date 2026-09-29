'use strict';
/**
 * Hierarquia 5 niveis: platform_admin > owner > (vip | adm; vip+admin usa adm neste grupo) > user
 */
const assert = require('assert');
const {
  canUseCommand,
  canTarget,
  normalizeRole
} = require('../utils/permissionEngine');

function testCanUseCommandMatrix() {
  assert.strictEqual(canUseCommand('user', 'user'), true);
  assert.strictEqual(canUseCommand('user', 'vip'), false);
  assert.strictEqual(canUseCommand('user', 'adm'), false);
  assert.strictEqual(canUseCommand('user', 'owner'), false);
  assert.strictEqual(canUseCommand('user', 'platform_admin'), false);

  assert.strictEqual(canUseCommand('vip', 'user'), true);
  assert.strictEqual(canUseCommand('vip', 'vip'), true);
  assert.strictEqual(canUseCommand('vip', 'adm'), false, 'vip sozinho nao usa comando adm');
  assert.strictEqual(canUseCommand('vip', 'adm', { isGroupAdmin: true }), true, 'vip+admin deste grupo usa adm');
  assert.strictEqual(canUseCommand('vip', 'owner', { isGroupAdmin: true }), false, 'vip+admin nao vira dono');
  assert.strictEqual(canUseCommand('vip', 'platform_admin', { isGroupAdmin: true }), false);
  assert.strictEqual(canUseCommand('vip', 'owner'), false);
  assert.strictEqual(canUseCommand('vip', 'platform_admin'), false);

  assert.strictEqual(canUseCommand('adm', 'user'), true);
  assert.strictEqual(canUseCommand('adm', 'adm'), true);
  assert.strictEqual(canUseCommand('adm', 'vip'), false, 'adm nunca usa comando vip');
  assert.strictEqual(canUseCommand('adm', 'owner'), false, 'adm nunca usa comando dono');
  assert.strictEqual(canUseCommand('adm', 'platform_admin'), false);

  assert.strictEqual(canUseCommand('owner', 'user'), true);
  assert.strictEqual(canUseCommand('owner', 'vip'), true);
  assert.strictEqual(canUseCommand('owner', 'adm'), true);
  assert.strictEqual(canUseCommand('owner', 'owner'), true);
  assert.strictEqual(canUseCommand('owner', 'platform_admin'), false);

  assert.strictEqual(canUseCommand('platform_admin', 'platform_admin'), true);
  assert.strictEqual(canUseCommand('platform_admin', 'owner'), true);
  assert.strictEqual(canUseCommand('group_admin', 'adm'), true);
  assert.strictEqual(canUseCommand('group_admin', 'owner'), false);
}

function testCanTargetImmunity() {
  assert.strictEqual(canTarget('adm', 'owner'), false, 'dono imune a adm');
  assert.strictEqual(canTarget('vip', 'owner'), false, 'dono imune a vip');
  assert.strictEqual(canTarget('adm', 'vip'), false, 'vip imune a adm');
  assert.strictEqual(canTarget('vip', 'adm'), false, 'vip nao manda em adm');
  assert.strictEqual(canTarget('adm', 'adm'), false);
  assert.strictEqual(canTarget('vip', 'vip'), false);
  assert.strictEqual(canTarget('adm', 'user'), true);
  assert.strictEqual(canTarget('vip', 'user'), true);
  assert.strictEqual(canTarget('owner', 'vip'), true);
  assert.strictEqual(canTarget('owner', 'adm'), true);
  assert.strictEqual(canTarget('owner', 'user'), true);
  assert.strictEqual(canTarget('owner', 'owner'), false);
  assert.strictEqual(canTarget('owner', 'platform_admin'), false);
  assert.strictEqual(canTarget('user', 'owner'), false, 'user nao age no dono');
  assert.strictEqual(canTarget('user', 'vip'), false);
  assert.strictEqual(canTarget('platform_admin', 'owner'), true);
}

function testCollectPersonTargetsFromQuote() {
  const { collectPersonTargets } = require('../utils/permissionEngine');
  const hits = collectPersonTargets({
    quoted: { sender: '5511999000000@s.whatsapp.net' },
    mentionedJid: ['5511888000000@lid'],
    text: 'oi'
  });
  assert.ok(hits.includes('5511999000000@s.whatsapp.net'));
  assert.ok(hits.includes('5511888000000@lid'));
}

function testNormalize() {
  assert.strictEqual(normalizeRole('group_admin'), 'adm');
  assert.strictEqual(normalizeRole('nope'), 'user');
}

function testClassifyAdmNotOwner() {
  const { classify } = require('../core/router/registeredCommands');
  assert.strictEqual(classify('ban').permission, 'adm');
  assert.strictEqual(classify('antilink').permission, 'adm');
  assert.strictEqual(classify('kick').permission, 'adm');
  assert.strictEqual(classify('nuke').permission, 'owner');
  assert.strictEqual(classify('addvip').permission, 'owner');
  assert.strictEqual(classify('div').permission, 'vip');
  assert.strictEqual(classify('ping').permission, 'user');
  assert.strictEqual(classify('cita').permission, 'adm');
  assert.strictEqual(classify('modlist').permission, 'owner');
  assert.strictEqual(classify('crash').permission, 'platform_admin');
}

function testGateAdmBypassNotNuke() {
  const { assertCommand } = require('../utils/commandGate');
  const ctx = {
    from: '120363000000000000@g.us',
    sender: '5511999999999@s.whatsapp.net',
    telegramUserId: 'perm-engine-smoke-user',
    isGroup: true,
    isAdmin: true,
    fromMe: false,
    conn: null
  };
  assert.strictEqual(assertCommand(ctx, 'nuke').ok, false);
  assert.strictEqual(assertCommand(ctx, 'addvip').ok, false);
  assert.strictEqual(assertCommand(ctx, 'div').ok, false);
  const ping = assertCommand(ctx, 'ping');
  assert.strictEqual(ping.ok, true);
  assert.notStrictEqual(ping.role, 'owner');
}

function testPlatformAdminNotAutoOwnerOnClientSession() {
  const { checkAuthorization } = require('../utils/authorization');
  const r = checkAuthorization(
    '5511888888888@s.whatsapp.net',
    'perm-engine-client-session',
    false,
    [],
    { user: { id: '5511000000000:11@s.whatsapp.net', lid: '111@lid' } }
  );
  assert.notStrictEqual(r.role, 'owner', 'TG admin da sessao nao promove membro a owner');
  assert.notStrictEqual(r.role, 'platform_admin');
}

testCanUseCommandMatrix();
testCanTargetImmunity();
testCollectPersonTargetsFromQuote();
testNormalize();
testClassifyAdmNotOwner();
testGateAdmBypassNotNuke();
testPlatformAdminNotAutoOwnerOnClientSession();
console.log('permission-engine-smoke: ok');
