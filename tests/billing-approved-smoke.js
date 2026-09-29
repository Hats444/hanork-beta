'use strict';
/**
 * R1 smoke: VIP so com status approved do Mercado Pago.
 * Nao chama API real — so gates locais.
 */
const assert = require('assert');
const { canDeliver } = require('../services/billing/logic');

assert.strictEqual(
  canDeliver({ status: 'pending', amount_cents: 100 }, { status: 'pending', amount_cents: 100 }).ok,
  false,
  'pending nao entrega'
);
assert.strictEqual(
  canDeliver({ status: 'pending', amount_cents: 100 }, { status: 'approved', amount_cents: 100 }).reason,
  undefined,
  'approved ok gate'
);
assert.ok(
  canDeliver({ status: 'pending', amount_cents: 100 }, { status: 'approved', amount_cents: 100 }).ok,
  'approved entrega'
);
assert.strictEqual(
  canDeliver({ status: 'pending', amount_cents: 100 }, { status: 'authorized', amount_cents: 100 }).ok,
  false,
  'authorized != approved'
);
assert.strictEqual(
  canDeliver({ status: 'pending', amount_cents: 100 }, { status: 'in_process', amount_cents: 100 }).ok,
  false,
  'in_process nao entrega'
);
assert.strictEqual(
  canDeliver({ status: 'delivered', amount_cents: 100 }, { status: 'approved', amount_cents: 100 }).reason,
  'already_delivered'
);
assert.strictEqual(
  canDeliver({ status: 'pending', amount_cents: 100 }, { status: 'approved', amount_cents: 50 }).reason,
  'amount_mismatch'
);

const storeSrc = require('fs').readFileSync(
  require('path').join(__dirname, '../services/billing/store.js'),
  'utf8'
);
assert.ok(storeSrc.includes("!== 'approved'"), 'processApprovedPayment trava status');
assert.ok(storeSrc.includes('canDeliver'), 'deliverOrder usa canDeliver');

const whSrc = require('fs').readFileSync(
  require('path').join(__dirname, '../services/billing/webhookService.js'),
  'utf8'
);
assert.ok(whSrc.includes("!== 'approved'"), 'webhook so approved');

const jobsSrc = require('fs').readFileSync(
  require('path').join(__dirname, '../services/billing/jobs.js'),
  'utf8'
);
assert.ok(/status.*approved|approved.*status/i.test(jobsSrc), 'poll so approved');

console.log('billing-approved-smoke ok');
