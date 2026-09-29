'use strict';
/**
 * Fase 2: tier/upsell + changelog publico sem vazamento.
 */
const assert = require('assert');
const { minTierFor } = require('../services/billing/tiers');
const logic = require('../services/billing/logic');
const paywall = require('../utils/paywall');
const vipIndex = require('../services/billing/vipIndex');
const pub = require('../utils/publicChangelog');

function testMinTier() {
  assert.strictEqual(minTierFor('comprar'), 'free');
  assert.strictEqual(minTierFor('novidades'), 'free');
  assert.strictEqual(minTierFor('play'), 'starter');
  assert.strictEqual(minTierFor('cpf'), 'starter');
  assert.strictEqual(minTierFor('divulgar'), 'pro');
  assert.strictEqual(minTierFor('antilink'), 'pro');
  assert.strictEqual(minTierFor('intentrouter'), 'pro');
  assert.strictEqual(minTierFor('autodivbot'), 'enterprise');
}

function testUpsellDeny() {
  vipIndex.clear();
  const ctx = {
    telegramUserId: 'smoke-unpaid',
    sender: '5511999000111@s.whatsapp.net',
    platform: 'whatsapp'
  };
  const orig = process.env.HANORK_PAYWALL;
  const origAt = process.env.HANORK_PAYWALL_AT;
  process.env.HANORK_PAYWALL = '1';
  process.env.HANORK_PAYWALL_AT = '2020-01-01T00:00:00.000Z';
  assert.strictEqual(paywall.shouldBlock(ctx, 'comprar'), false);
  assert.strictEqual(paywall.shouldBlock(ctx, 'play'), true);
  assert.strictEqual(paywall.shouldBlock(ctx, 'divulgar'), true);
  const msg = paywall.denyText(ctx, 'divulgar');
  assert.ok(/Pro/i.test(msg), 'upsell nomeia o Pro');
  assert.ok(/comprar/i.test(msg));
  assert.ok(!/error/i.test(msg));
  assert.ok(!/nivel insuficiente/i.test(msg));
  vipIndex.remember('telegram', 'smoke-unpaid', 'starter');
  assert.strictEqual(paywall.shouldBlock(ctx, 'play'), false);
  assert.strictEqual(paywall.shouldBlock(ctx, 'divulgar'), true);
  assert.strictEqual(paywall.shouldBlock(ctx, 'cpf'), false);
  vipIndex.remember('telegram', 'smoke-unpaid', 'starter', { daypass: true });
  assert.strictEqual(paywall.shouldBlock(ctx, 'antilink'), false);
  assert.strictEqual(paywall.shouldBlock(ctx, 'presetprotecao'), false);
  assert.strictEqual(paywall.shouldBlock(ctx, 'divulgar'), true);
  vipIndex.remember('telegram', 'smoke-unpaid', 'pro');
  assert.strictEqual(paywall.shouldBlock(ctx, 'divulgar'), false);
  assert.strictEqual(paywall.shouldBlock(ctx, 'autodivbot'), true);
  vipIndex.remember('telegram', 'smoke-unpaid', 'enterprise');
  assert.strictEqual(paywall.shouldBlock(ctx, 'autodivbot'), false);
  vipIndex.clear();
  if (orig == null) delete process.env.HANORK_PAYWALL;
  else process.env.HANORK_PAYWALL = orig;
  if (origAt == null) delete process.env.HANORK_PAYWALL_AT;
  else process.env.HANORK_PAYWALL_AT = origAt;
}

function testGrandfatherVip() {
  assert.strictEqual(logic.productTierFromEntitlement({ kind: 'vip', quota_tier: 'recommended' }), 'pro');
  assert.strictEqual(logic.productTierFromEntitlement({ kind: 'bot_license' }), 'enterprise');
  assert.strictEqual(logic.productTierFromEntitlement({ kind: 'vip', product_tier: 'starter' }), 'starter');
}

function testPublicChangelog() {
  const dirty = '| 30/08 13:35 | Fix `sqlStore.js` host errors_2026-08-30 JID 120363412971004933@newsletter HANORK_PAYWALL | `a.js` | ok |';
  const rows = pub.parseChangelogRows(`## Changelog\n\n| Quando | Mudanca | Arquivos | Impacto |\n|--------|---------|----------|---------|\n${dirty}\n`);
  assert.ok(rows.length >= 1);
  const text = `${rows[0].change} ${rows[0].impact}`;
  assert.strictEqual(pub.containsSensitive(text), false, 'changelog publico sem arquivo/JID/env');
  const live = pub.formatPublicChangelog('.');
  assert.ok(!pub.containsSensitive(live), 'AUDITORIA sanitizada');
  assert.ok(/HANORK/i.test(live));
}

function testPaidTelegramIsVip() {
  vipIndex.clear();
  vipIndex.remember('telegram', '7001', 'enterprise');
  const { sessionRole, assertCommand } = require('../utils/commandGate');
  const ctx = {
    platform: 'telegram',
    isTelegram: true,
    telegramUserId: '7001',
    sender: '7001',
    from: '7001'
  };
  assert.strictEqual(sessionRole(ctx), 'vip');
  assert.strictEqual(assertCommand(ctx, 'cpf').ok, true);
  assert.strictEqual(assertCommand(ctx, 'divulgar').ok, true);
  assert.strictEqual(assertCommand(ctx, 'nuke').ok, false);
  vipIndex.clear();
}

testMinTier();
testUpsellDeny();
testGrandfatherVip();
testPaidTelegramIsVip();
testPublicChangelog();
console.log('tier-smoke: ok');
process.exit(0);
