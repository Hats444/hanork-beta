'use strict';

const assert = require('assert');
const { extractInviteCodes, normalizeInviteCode } = require('./inviteDetect');
const { computeJoinCount, computeLeaveCount } = require('./limits');

function run() {
  const text = [
    'olha https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv',
    'e outro chat.whatsapp.com/invite/XyZ12345_abcDEFGHij',
    'canal https://whatsapp.com/channel/0029VbCWxxxx nao conta',
    'https://wa.me/g/AbCdEfGhIjKlMnOpQrStUv',
    'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv repetido'
  ].join('\n');
  const codes = extractInviteCodes(text);
  assert.strictEqual(codes.length, 2, 'dois convites unicos');
  const waMe = extractInviteCodes('entra https://wa.me/g/AbCdEfGhIjKlMnOpQrStUv agora');
  assert.strictEqual(waMe.length, 1, 'wa.me/g extrai codigo');
  const proto = extractInviteCodes('', { groupInviteMessage: { inviteCode: 'AbCdEfGhIjKlMnOpQrStUv' } });
  assert.strictEqual(proto.length, 1, 'cartao nativo');
  const wrapped = extractInviteCodes('entra https://chat.whatsapp.com/\nAbCdEfGhIjKlMnOpQrStUv fim');
  assert.strictEqual(wrapped.length, 1, 'link quebrado em linha');
  const many = [];
  for (let i = 0; i < 40; i++) many.push(`https://chat.whatsapp.com/Abcdefghij${String(i).padStart(12, '0')}`);
  const bulk = extractInviteCodes(many.join('\n'));
  assert.strictEqual(bulk.length, 40, 'salva todos os unicos sem teto');
  assert.strictEqual(normalizeInviteCode('bad'), '');
  assert.strictEqual(normalizeInviteCode('invite'), '');

  const real = computeJoinCount({
    requested: 10,
    maxBatchSize: 25,
    maxTotalGroups: 100,
    activeGroups: 96,
    maxGroupsPerSession: 100,
    sessionGroups: 2,
    maxJoinsPerDay: 30,
    joinsToday: 8,
    pending: 73
  });
  assert.strictEqual(real, 4, 'MIN(10, 4 global, 98 sessao, 22 dia, 73 pend, 25 lote)');

  const zero = computeJoinCount({
    requested: 10,
    maxBatchSize: 25,
    maxTotalGroups: 100,
    activeGroups: 100,
    maxGroupsPerSession: 100,
    sessionGroups: 0,
    maxJoinsPerDay: 30,
    joinsToday: 0,
    pending: 5
  });
  assert.strictEqual(zero, 0);

  const leftover = computeJoinCount({
    requested: 25,
    maxBatchSize: 25,
    maxTotalGroups: 50,
    activeGroups: 47,
    maxGroupsPerSession: 100,
    sessionGroups: 0,
    maxJoinsPerDay: 30,
    joinsToday: 0,
    pending: 80
  });
  assert.strictEqual(leftover, 3, 'lote 25 com 3 vagas = 3');

  const leave = computeLeaveCount({
    requested: 10,
    maxBatchSize: 25,
    maxLeavesPerDay: 20,
    leavesToday: 18,
    activeGroups: 50
  });
  assert.strictEqual(leave, 2);

  console.log('group-manager-smoke OK');
}

run();
