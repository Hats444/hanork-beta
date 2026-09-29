'use strict';
/**
 * Onda1.4: user comum NUNCA vira owner por telegramUserId da sessao admin.
 * nuke / ban / div* devem ser recusados. fromMe em grupo sem chip nao eleva.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const authSrc = fs.readFileSync(path.join(__dirname, '../utils/authorization.js'), 'utf8');
assert.ok(
  authSrc.includes('TELEGRAM_ADMIN_IDS e da CONTA da sessao, nao do remetente'),
  'checkAuthorization nao promove por sessao admin'
);
assert.ok(
  /fromMe em grupo: so eleva se identidade casar/.test(authSrc),
  'isFreshSessionOwner nao fail-open fromMe em grupo'
);

const permSrc = fs.readFileSync(path.join(__dirname, '../core/router/permissionManager.js'), 'utf8');
assert.ok(
  /platform_admin[\s\S]*actorIsAdmin/.test(permSrc),
  'platform_admin no TG usa remetente (actorIsAdmin), nao so sessao'
);

process.env.HANORK_SKIP_DOTENV = '1';
const { assertCommand, minLevelFor } = require('../utils/commandGate');
const { checkAuthorization, isFreshSessionOwner } = require('../utils/authorization');

for (const cmd of ['nuke', 'ban', 'div', 'divulgar', 'bangp']) {
  const min = minLevelFor(cmd);
  assert.ok(
    min === 'owner' || min === 'platform_admin' || min === 'adm' || min === 'vip',
    `minLevel ${cmd}=${min}`
  );
}

// Sessao admin + sender comum: role user (nao owner por telegramUserId)
const auth = checkAuthorization(
  '5511999999999@s.whatsapp.net',
  '8115302402',
  false,
  null,
  null
);
assert.strictEqual(auth.role, 'user', 'checkAuthorization nao promove por sessao admin');

const fakeUserCtx = {
  from: '120363@g.us',
  isGroup: true,
  fromMe: false,
  sender: '5511999999999@s.whatsapp.net',
  telegramUserId: '8115302402',
  authRole: 'user',
  isOwner: false,
  isVip: false,
  isAdmin: false,
  conn: null
};

assert.strictEqual(isFreshSessionOwner(fakeUserCtx), false, 'user comum nao e fresh owner');

// fromMe spoofed em grupo SEM conn/chip match → nao dono
const spoofFromMe = { ...fakeUserCtx, fromMe: true };
assert.strictEqual(
  isFreshSessionOwner(spoofFromMe),
  false,
  'fromMe em grupo sem identidade do chip nao eleva'
);

for (const cmd of ['nuke', 'ban', 'div']) {
  const g = assertCommand({ ...fakeUserCtx }, cmd);
  assert.strictEqual(g.ok, false, `${cmd} deve recusar user comum (ok=${g.ok} role=${g.role} reason=${g.reason})`);
}

console.log('auth-identity-smoke ok');
