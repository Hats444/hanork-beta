'use strict';
/**
 * Meta de grupo: classificador unico + retireDeadGroup + fila vazia.
 */
const assert = require('assert');
const {
  classifyGroupFailure,
  inspectGroupHealth,
  TRANSIENT_FAIL_LIMIT
} = require('../utils/groupFailure');
const { retireDeadGroup, onDivGroupResult } = require('../utils/divulgacaoDeadReplace');
const { putGroupMetadata, dropGroupMetadata } = require('../utils/groupMetaCache');

const DEAD_CASES = [
  ['not-authorized', 'no_send_permission'],
  ['forbidden', 'no_send_permission'],
  ['item-not-found', 'group_gone'],
  ['not-participant', 'bot_removed'],
  ['not a participant', 'bot_removed'],
  ['announcement', 'announce_no_admin'],
  ['so admin', 'announce_no_admin'],
  ['only admins can send', 'announce_no_admin'],
  ['sem permissao', 'no_send_permission'],
  ['banned', 'bot_removed'],
  ['group gone', 'group_gone'],
  ['cannot send messages', 'no_send_permission']
];

const TRANSIENT_CASES = [
  ['Timeout: groupMetadata 600ms', 'timeout'],
  ['rate-overlimit', 'rate_overlimit'],
  ['Connection Closed', 'connection'],
  ['groupMetadata backoff', 'meta_backoff'],
  ['GROUP_META_CAP iq-cap', 'meta_backoff'],
  ['ETIMEDOUT', 'timeout']
];

async function testClassifier() {
  for (const [msg, reason] of DEAD_CASES) {
    const r = classifyGroupFailure(new Error(msg));
    assert.strictEqual(r.kind, 'dead', `${msg} deve ser dead (foi ${r.kind}/${r.reason})`);
    assert.strictEqual(r.reason, reason, `${msg} reason=${r.reason} esperado ${reason}`);
  }
  for (const [msg, reason] of TRANSIENT_CASES) {
    const r = classifyGroupFailure(new Error(msg));
    assert.strictEqual(r.kind, 'transient', `${msg} deve ser transient (foi ${r.kind}/${r.reason})`);
    assert.strictEqual(r.reason, reason, `${msg} reason=${r.reason} esperado ${reason}`);
  }
  const closedVsForbidden = classifyGroupFailure(new Error('Connection Closed'));
  assert.strictEqual(closedVsForbidden.kind, 'transient', 'connection closed nao mata o grupo');
  const both = classifyGroupFailure(new Error('forbidden after timeout'));
  assert.strictEqual(both.kind, 'dead', 'forbidden ganha de timeout no mesmo blob');
  const bot = classifyGroupFailure(null, { botRemoved: true });
  assert.strictEqual(bot.kind, 'dead');
  assert.strictEqual(bot.reason, 'bot_removed');
  const ann = classifyGroupFailure(null, { announce: true, botIsAdmin: false });
  assert.strictEqual(ann.kind, 'dead');
  assert.strictEqual(ann.reason, 'announce_no_admin');
  const adminOk = classifyGroupFailure(null, { announce: true, botIsAdmin: true });
  assert.strictEqual(adminOk.kind, 'ok');
  const unk = classifyGroupFailure(new Error('algo estranho do zap'));
  assert.strictEqual(unk.kind, 'transient', 'erro sujo acumula, nao mata na 1a');
  assert.strictEqual(TRANSIENT_FAIL_LIMIT, 5);
}

async function testInspectAnnounce() {
  const gid = '120363999111111111@g.us';
  const conn = { user: { id: '5511999999999:12@s.whatsapp.net', lid: '123456789@lid' } };
  putGroupMetadata(gid, {
    id: gid,
    announce: true,
    participants: [
      { id: '5511888888888@s.whatsapp.net', admin: 'admin' },
      { id: '5511999999999@s.whatsapp.net', admin: null }
    ]
  });
  const dead = inspectGroupHealth(conn, gid);
  assert.strictEqual(dead.kind, 'dead');
  assert.strictEqual(dead.reason, 'announce_no_admin');

  putGroupMetadata(gid, {
    id: gid,
    announce: true,
    participants: [
      { id: '5511999999999@s.whatsapp.net', admin: 'admin' }
    ]
  });
  const ok = inspectGroupHealth(conn, gid);
  assert.strictEqual(ok.kind, 'ok', 'bot admin em anuncio nao e morto');
  dropGroupMetadata(gid);
}

async function testRetireAndRefill() {
  const gid = '120363999222222222@g.us';
  const uid = 'smoke-meta-retire';
  const left = [];
  const unlisted = [];
  const marked = [];
  const dropped = [];
  const occ = [];
  const refill = [];
  const io = {
    async groupLeave(_u, g) { left.push(g); return true; },
    async unlist(_u, g) { unlisted.push(g); },
    async markInvite(_u, g, reason) { marked.push({ g, reason }); },
    dropMeta(g) { dropped.push(g); },
    invalidateOcc(u) { occ.push(u); },
    autoRefillOn() { return true; },
    scheduleRefill(u) { refill.push(u); }
  };

  for (const [msg] of DEAD_CASES) {
    left.length = unlisted.length = marked.length = dropped.length = occ.length = refill.length = 0;
    const classified = classifyGroupFailure(new Error(msg));
    const out = await retireDeadGroup(gid, uid, classified.reason, { io });
    assert.ok(out.ok, `${msg} retire ok`);
    assert.strictEqual(left[0], gid, `${msg} groupLeave`);
    assert.strictEqual(unlisted[0], gid, `${msg} unlist`);
    assert.ok(marked[0] && marked[0].reason, `${msg} marcado`);
    assert.strictEqual(dropped[0], gid, `${msg} drop meta`);
    assert.strictEqual(occ[0], uid, `${msg} invalida ocupacao`);
    assert.strictEqual(refill[0], uid, `${msg} dispara repor sem clique`);
  }

  left.length = refill.length = 0;
  const emptyIo = {
    ...io,
    autoRefillOn() { return true; },
    scheduleRefill(u) { refill.push(u); }
  };
  const outEmpty = await retireDeadGroup(gid, uid, 'group_gone', { io: emptyIo });
  assert.ok(outEmpty.ok, 'morto sai mesmo sem substituto na fila');
  assert.strictEqual(left[0], gid);
  assert.strictEqual(refill[0], uid, 'repor e agendado; joinBatch loga fila vazia');

  refill.length = 0;
  const noRefill = await retireDeadGroup(gid, uid, 'forbidden', {
    io: { ...io, autoRefillOn() { return false; }, scheduleRefill(u) { refill.push(u); } }
  });
  assert.ok(noRefill.ok);
  assert.strictEqual(refill.length, 0, 'autoRefill OFF nao entra, mas sai do grupo');
}

async function testOnDivGroupResultDeadImmediate() {
  const gid = '120363999333333333@g.us';
  const io = {
    async groupLeave() { return true; },
    async unlist() {},
    async markInvite() {},
    dropMeta() {},
    invalidateOcc() {},
    autoRefillOn() { return true; },
    scheduleRefill() {}
  };
  const classified = onDivGroupResult('smoke-meta-note', gid, {
    sent: false,
    fail: true,
    reason: 'not-authorized',
    io,
    skipRefill: true
  });
  assert.strictEqual(classified.kind, 'dead');
  const trans = onDivGroupResult('smoke-meta-note', gid, {
    sent: false,
    fail: true,
    reason: 'rate-overlimit',
    io,
    skipRefill: true
  });
  assert.strictEqual(trans.kind, 'transient');
}

async function testIqDeadOnlyIfDiv() {
  const { onIqGroupFailure } = require('../utils/divulgacaoDeadReplace');
  const miss = await onIqGroupFailure('120363999444444444@g.us', new Error('forbidden'), { _telegramUserId: 'smoke-meta-iq' });
  assert.ok(miss.reason === 'not-div' || miss.ok === false, 'IQ morto fora da lista DIV nao retira');
}

async function testEmptyQueueLog() {
  const { maintainOccupancy } = require('../utils/groupManager/joinService');
  const out = await maintainOccupancy('smoke-meta-empty-queue', { fromRetire: true });
  assert.ok(out);
  assert.ok(
    out.reason === 'empty-queue' || out.reason === 'auto-off' || out.reason === 'paused' || out.reason === 'no-session' || out.reason === 'full',
    `fila vazia ou trava conhecida, veio ${out.reason}`
  );
  if (out.reason === 'empty-queue') {
    assert.strictEqual(out.pending, 0);
  }
}

async function main() {
  await testClassifier();
  await testInspectAnnounce();
  await testRetireAndRefill();
  await testOnDivGroupResultDeadImmediate();
  await testIqDeadOnlyIfDiv();
  await testEmptyQueueLog();
  console.log('meta-dead-group-smoke OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('meta-dead-group-smoke FAIL', e);
  process.exit(1);
});
