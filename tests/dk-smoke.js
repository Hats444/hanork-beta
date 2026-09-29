'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseDkArgs,
  parseEntrardkArgs,
  DK_MAX_N,
  DK_BATCH,
  inviteRequiresApproval,
  extractInviteCode,
  paymentPayload
} = require('../commands/dk');
const { classifyFromParts, isAdminFlag } = require('../utils/dkMembers');

assert.strictEqual(DK_MAX_N, 12);
assert.strictEqual(DK_BATCH, 5);
assert.deepStrictEqual(parseDkArgs([]), { mode: 1 });
assert.strictEqual(parseDkArgs(['promo']).mode, 'usage');
const n9 = parseDkArgs(['9', 'promocao', 'hoje']);
assert.strictEqual(n9.mode, 2);
assert.strictEqual(n9.n, 9);
assert.strictEqual(n9.text, 'promocao hoje');
assert.strictEqual(parseDkArgs(['9']).text, '');
assert.strictEqual(parseDkArgs(['0', 'x']).n, 0);
assert.ok(parseDkArgs(['13', 'x']).n > DK_MAX_N);

const e1 = parseEntrardkArgs(['7', 'https://chat.whatsapp.com/AbCdEfGhIj']);
assert.strictEqual(e1.n, 7);
assert.ok(e1.restText.includes('AbCdEfGhIj'));
const e2 = parseEntrardkArgs(['https://chat.whatsapp.com/AbCdEfGhIj']);
assert.strictEqual(e2.n, null);

assert.strictEqual(inviteRequiresApproval({ joinApprovalMode: true }), true);
assert.strictEqual(inviteRequiresApproval({ joinApprovalMode: false }), false);
assert.strictEqual(inviteRequiresApproval({}), false);
assert.strictEqual(inviteRequiresApproval({ membershipApprovalMode: true }), true);
assert.ok(extractInviteCode('entra https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv agora'));

const parts = [
  { id: '111@s.whatsapp.net', admin: null },
  { id: '222@s.whatsapp.net', admin: 'admin' },
  { id: '333@s.whatsapp.net', admin: 'superadmin' },
  { id: '444@s.whatsapp.net', admin: false },
  { id: '555@lid', phoneNumber: '5511999999999', admin: undefined }
];
assert.strictEqual(isAdminFlag(parts[1]), true);
assert.strictEqual(isAdminFlag(parts[2]), true);
assert.strictEqual(isAdminFlag(parts[0]), false);
const botIds = new Set(['999@s.whatsapp.net']);
const classified = classifyFromParts(
  [...parts, { id: '999@s.whatsapp.net', admin: null }],
  botIds
);
assert.strictEqual(classified.adminN, 2);
assert.strictEqual(classified.skippedBot, 1);
assert.ok(classified.mentions.includes('111@s.whatsapp.net'));
assert.ok(classified.mentions.includes('444@s.whatsapp.net'));
assert.ok(!classified.mentions.includes('222@s.whatsapp.net'));
assert.ok(!classified.mentions.includes('333@s.whatsapp.net'));
assert.ok(!classified.mentions.includes('999@s.whatsapp.net'));

const pay = paymentPayload('pix agora', ['111@s.whatsapp.net', '444@s.whatsapp.net']);
assert.strictEqual(pay.requestPaymentMessage.currencyCodeIso4217, 'BRL');
assert.strictEqual(pay.requestPaymentMessage.amount1000, '0');
assert.strictEqual(pay.requestPaymentMessage.expiryTimestamp, '0');
assert.strictEqual(pay.requestPaymentMessage.amount.value, '0');
assert.strictEqual(pay.requestPaymentMessage.amount.currencyCode, 'BRL');
assert.strictEqual(pay.requestPaymentMessage.noteMessage.extendedTextMessage.text, 'pix agora');
assert.strictEqual(pay.requestPaymentMessage.noteMessage.extendedTextMessage.contextInfo.mentionedJid.length, 2);

const dkSrc = fs.readFileSync(path.join(__dirname, '../commands/dk.js'), 'utf8');
assert.ok(!dkSrc.includes('generateWAMessageFromContent'), 'pay nao usa FromContent');
assert.ok(!dkSrc.includes('preparePaymentRelay'), 'pay nao recorta FromContent');
assert.ok(dkSrc.includes('relayMessage(groupJid, payload'), 'pay relaying proto Duda');
assert.ok(!/pay fallback text/.test(dkSrc), 'pay nao cai em texto de conversa');
assert.ok(dkSrc.includes('groupStatus: true'), 'status usa groupStatus');
const forbiddenReq = /require\(['"][^'"]*(?:divulgacao|groupStatusV2|joinService|statuspost)[^'"]*['"]\)/;
for (const rel of ['commands/dk.js', 'utils/dkStore.js', 'utils/dkMedia.js', 'utils/dkMembers.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.ok(!forbiddenReq.test(src), `${rel} nao pode importar divulgacao`);
}

const { GROUP_SECURITY_CMDS, DK_CMDS } = require('../utils/commandGate');
assert.ok(!GROUP_SECURITY_CMDS.has('dk'), 'dk nao entra no GROUP_SECURITY_CMDS');
assert.ok(DK_CMDS.has('menu_dk') && DK_CMDS.has('dk') && DK_CMDS.has('dkpay'));
const gateSrc = fs.readFileSync(path.join(__dirname, '../utils/commandGate.js'), 'utf8');
assert.ok(gateSrc.includes('DK_CMDS.has(raw)'), 'gate ignora alvo_imune no DK');
const clickSrc = fs.readFileSync(path.join(__dirname, '../utils/interactiveClickGuard.js'), 'utf8');
assert.ok(clickSrc.includes('cmd_(menu_dk'), 'clique DK e fail-open');
const rcSrc = fs.readFileSync(path.join(__dirname, '../core/router/registeredCommands.js'), 'utf8');
const vipBlock = rcSrc.slice(rcSrc.indexOf('const VIP_OK'), rcSrc.indexOf('const OWNER_ONLY'));
const ownerBlock = rcSrc.slice(rcSrc.indexOf('const OWNER_ONLY'), rcSrc.indexOf('const PLATFORM_ADMIN_ONLY'));
assert.ok(/^\s*'dk',?\s*$/m.test(vipBlock), 'dk em VIP_OK');
assert.ok(!/^\s*'dk',?\s*$/m.test(ownerBlock), 'dk fora de OWNER_ONLY');

console.log('dk-smoke ok');
