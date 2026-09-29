'use strict';
/**
 * Toggle liga → checa → desliga → checa. Fonte unica protectionStore.
 */
const assert = require('assert');
const { getProtection, getAllProtections, setProtection } = require('../utils/protectionStore');

async function testToggleRoundtrip() {
  const uid = 'smoke-prot-uid';
  const gid = '120363999000000001@g.us';
  await setProtection(gid, 'antilink', true, 'actor-smoke', uid);
  assert.strictEqual(!!getProtection(gid, 'antilink', uid), true, 'antilink ON apos ligar');
  const on = getAllProtections(gid, uid);
  assert.strictEqual(!!on.antilink, true);
  await setProtection(gid, 'antilink', false, 'actor-smoke', uid);
  assert.strictEqual(!!getProtection(gid, 'antilink', uid), false, 'antilink OFF apos desligar');
  await setProtection(gid, 'antistatus', true, 'actor-smoke', uid);
  assert.strictEqual(!!getProtection(gid, 'antistatus', uid), true);
  await setProtection(gid, 'antistatus', false, 'actor-smoke', uid);
  assert.strictEqual(!!getProtection(gid, 'antistatus', uid), false);
}

async function testSessionFlagIsolation() {
  const gid = '120363999000000002@g.us';
  await setProtection(gid, 'antilink', true, 'a', 'smoke-prot-A');
  await setProtection(gid, 'antilink', false, 'b', 'smoke-prot-B');
  assert.strictEqual(!!getProtection(gid, 'antilink', 'smoke-prot-A'), true, 'sessao A ON');
  assert.strictEqual(!!getProtection(gid, 'antilink', 'smoke-prot-B'), false, 'sessao B OFF');
}

async function testGetGroupSecurityStoreOnly() {
  const { getGroupSecurity, setGroupSecurityFlag, isModerationActive } = require('../utils/moderation');
  const uid = 'smoke-prot-mod';
  const gid = '120363999000000003@g.us';
  await setGroupSecurityFlag(gid, uid, 'antilink', true, 'actor');
  assert.strictEqual(!!getGroupSecurity(gid, uid).antilink, true, 'getGroupSecurity ON');
  await setGroupSecurityFlag(gid, uid, 'antilink', false, 'actor');
  assert.strictEqual(!!getGroupSecurity(gid, uid).antilink, false, 'getGroupSecurity OFF sem ressuscitar JSON');
  await setGroupSecurityFlag(gid, uid, 'antiflood', true, 'actor');
  assert.strictEqual(!!getGroupSecurity(gid, uid).antiflood, true, 'antiflood ON no store');
  assert.strictEqual(!!isModerationActive(gid, uid), true, 'handler antiflood le o mesmo store');
  await setGroupSecurityFlag(gid, uid, 'antiflood', false, 'actor');
  assert.strictEqual(!!getGroupSecurity(gid, uid).antiflood, false, 'antiflood OFF nao fica preso em enabledGroups');
  assert.strictEqual(!!isModerationActive(gid, uid), false, 'handler antiflood desliga junto');
}

async function testPanelSetIsAbsolute() {
  const { buildSecurityListSections } = require('../utils/securityMenu');
  const uid = 'smoke-prot-panel';
  const gid = '120363999000000004@g.us';
  await setProtection(gid, 'antilink', true, 'actor', uid);
  const onIds = buildSecurityListSections('.', gid, uid).flatMap((s) => (s.rows || []).map((r) => r.id));
  assert.ok(onIds.includes('protset_antilink_0'), 'ON no painel clica pra GRAVAR off (nao inverter)');
  await setProtection(gid, 'antilink', false, 'actor', uid);
  await setProtection(gid, 'antilink', false, 'actor', uid);
  assert.strictEqual(!!getProtection(gid, 'antilink', uid), false, 'SET off duas vezes continua off');
  const offIds = buildSecurityListSections('.', gid, uid).flatMap((s) => (s.rows || []).map((r) => r.id));
  assert.ok(offIds.includes('protset_antilink_1'), 'OFF no painel clica pra GRAVAR on');
}

async function testListGroupsWithFlagIsolated() {
  const { listGroupsWithFlag } = require('../utils/protectionStore');
  const { setGroupSecurityFlag, isModerationActive } = require('../utils/moderation');
  const gid = '120363999000000005@g.us';
  await setGroupSecurityFlag(gid, 'smoke-list-A', 'antiflood', true, 'actor');
  await setGroupSecurityFlag(gid, 'smoke-list-B', 'antiflood', false, 'actor');
  const a = listGroupsWithFlag('smoke-list-A', 'antiflood');
  const b = listGroupsWithFlag('smoke-list-B', 'antiflood');
  assert.ok(a.includes(gid), 'lista A vem do store, nao do JSON legado');
  assert.ok(!b.includes(gid), 'sessao B nao herda antiflood da A');
  assert.strictEqual(!!isModerationActive(gid, 'smoke-list-A'), true);
  assert.strictEqual(!!isModerationActive(gid, 'smoke-list-B'), false);
}

async function testAntideleteAndOdeletePersist() {
  const { getGroupSecurity, setGroupSecurityFlag, getOwnerSecurity, setOwnerSecurityFlag } = require('../utils/moderation');
  const uid = 'smoke-adel';
  const gid = '120363999000000006@g.us';
  await setGroupSecurityFlag(gid, uid, 'antidelete', true, 'actor');
  assert.strictEqual(!!getGroupSecurity(gid, uid).antidelete, true, 'antidelete ON apos ligar');
  await setGroupSecurityFlag(gid, uid, 'antidelete', false, 'actor');
  assert.strictEqual(!!getGroupSecurity(gid, uid).antidelete, false, 'antidelete OFF apos desligar');
  setOwnerSecurityFlag(uid, 'odelete', true);
  assert.strictEqual(!!getOwnerSecurity(uid).odelete, true, 'odelete ON');
  setOwnerSecurityFlag(uid, 'odelete', false);
  assert.strictEqual(!!getOwnerSecurity(uid).odelete, false, 'odelete OFF');
}

function testHyphenAntiDeleteCommand() {
  const { parsePrefixedCommand } = require('../utils/commandTextParse');
  const p = parsePrefixedCommand('.anti-delete on', '.');
  assert.strictEqual(p.command, 'antidelete', 'hifen vira antidelete');
  assert.strictEqual(p.text, 'on');
  const p2 = parsePrefixedCommand('.antidel off', '.');
  assert.strictEqual(p2.command, 'antidel');
  assert.strictEqual(p2.text, 'off');
}

function testPanelRowIdsAndGpsegClicks() {
  const { buildSecurityListSections, protsetRowId } = require('../utils/securityMenu');
  const { isGpsegurancaClick } = require('../utils/interactiveClickGuard');
  const uid = 'smoke-prot-panel-adel';
  const gid = '120363999000000007@g.us';
  const ids = buildSecurityListSections('.', gid, uid).flatMap((s) => (s.rows || []).map((r) => r.id));
  assert.ok(ids.includes('protset_antidelete_1'), 'anti-delete OFF clica pra GRAVAR on');
  for (const id of ids) {
    assert.ok(String(id).length <= 24, `rowId longo: ${id} (${String(id).length})`);
  }
  assert.ok(protsetRowId('antiatkpagamento', '1').length <= 24);
  assert.ok(protsetRowId('surfsettingsflood', '1').length <= 24);
  assert.ok(isGpsegurancaClick('protset_antidelete_1'));
  assert.ok(isGpsegurancaClick('ps_antiatkpagamento_1'));
  assert.ok(isGpsegurancaClick('cmd_antilink'));
  assert.ok(!isGpsegurancaClick('div_config_auto'));
}

function testEveryPanelToggleHasStoreAndShortId() {
  const { SECURITY_ITEMS, buildSecurityListSections, protsetRowId } = require('../utils/securityMenu');
  const { DEFAULT_GROUP_FLAGS, DEFAULT_OWNER_SECURITY } = require('../utils/moderation');
  const { knownFlags, parseOnOff } = require('../utils/protectionStore');
  const known = knownFlags();
  for (const sec of SECURITY_ITEMS) {
    for (const it of sec.items) {
      if (it.flag) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(DEFAULT_GROUP_FLAGS, it.flag) || it.flag === 'antifloodsticker',
          `painel ${it.name} flag ${it.flag} fora do store`
        );
        if (it.flag !== 'antifloodsticker') {
          assert.ok(known.has(it.flag), `knownFlags perde ${it.flag}`);
        }
      }
      if (it.ownerFlag) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(DEFAULT_OWNER_SECURITY, it.ownerFlag),
          `painel ${it.name} ownerFlag ${it.ownerFlag} fora da sessao`
        );
      }
    }
  }
  const ids = buildSecurityListSections('.', '120363999000000008@g.us', 'smoke-all-panel')
    .flatMap((s) => (s.rows || []).map((r) => r.id));
  const toggleIds = ids.filter((id) => /^(protset_|ps_)/.test(id));
  assert.ok(toggleIds.length >= 40, `poucos toggles no painel: ${toggleIds.length}`);
  for (const id of ids) {
    assert.ok(String(id).length <= 24, `rowId longo: ${id}`);
  }
  assert.ok(protsetRowId('surfsettingsflood', '1').length <= 24);
  assert.strictEqual(parseOnOff('On agora'), true);
  assert.strictEqual(parseOnOff('off'), false);
  assert.strictEqual(parseOnOff(''), null);
}

async function testFlagsStayIndependent() {
  const { getProtection, setProtection, applyAttackVectors, ATTACK_VECTORS } = require('../utils/protectionStore');
  const { DEFAULT_GROUP_FLAGS, getGroupSecurity, setGroupSecurityFlag } = require('../utils/moderation');
  const uid = 'smoke-indep';
  const gid = '120363999000000019@g.us';
  const boolFlags = Object.keys(DEFAULT_GROUP_FLAGS).filter((k) => k !== 'antifloodsticker');
  await setProtection(gid, 'antilink', true, 'a', uid);
  await setProtection(gid, 'antidelete', true, 'a', uid);
  await setProtection(gid, 'antiimg', true, 'a', uid);
  await setProtection(gid, 'antivideo', false, 'a', uid);
  const after = getGroupSecurity(gid, uid);
  assert.strictEqual(!!after.antilink, true, 'antilink nao some ao ligar outra');
  assert.strictEqual(!!after.antidelete, true, 'antidelete nao some');
  assert.strictEqual(!!after.antiimg, true, 'antiimg nao some');
  assert.strictEqual(!!after.antivideo, false, 'antivideo fica OFF');
  assert.strictEqual(!!after.surfPayment, false, 'surf default OFF');

  await Promise.all([
    setProtection(gid, 'antiaudio', true, 'a', uid),
    setProtection(gid, 'antisticker', true, 'a', uid),
    setProtection(gid, 'antidoc', true, 'a', uid)
  ]);
  const par = getGroupSecurity(gid, uid);
  assert.strictEqual(!!par.antiaudio, true, 'persist paralelo audio');
  assert.strictEqual(!!par.antisticker, true, 'persist paralelo sticker');
  assert.strictEqual(!!par.antidoc, true, 'persist paralelo doc');
  assert.strictEqual(!!par.antilink, true, 'antilink sobrevive paralelo');

  await setProtection(gid, 'antistatus', false, 'a', uid);
  await setProtection(gid, 'antipayment', false, 'a', uid);
  await applyAttackVectors(gid, true, 'a', uid);
  const atk = getGroupSecurity(gid, uid);
  for (const f of ATTACK_VECTORS) {
    assert.strictEqual(!!atk[f], true, `${f} liga no lote`);
  }
  assert.strictEqual(!!atk.antistatus, false, 'antiataque nao mexe antistatus');
  assert.strictEqual(!!atk.antipayment, false, 'antiataque nao mexe antipayment');
  assert.strictEqual(!!atk.antidelete, true, 'lote antiatk nao apaga antidelete');

  let n = 0;
  for (const flag of boolFlags.slice(0, 12)) {
    await setGroupSecurityFlag(gid, uid, flag, true, 'actor');
    n++;
  }
  const bag = getGroupSecurity(gid, uid);
  for (const flag of boolFlags.slice(0, 12)) {
    assert.strictEqual(!!bag[flag], true, `${flag} ainda ON depois de ligar as 12`);
  }
  assert.ok(n === 12);
}

async function testSoadmDefaultOffAndSticks() {
  const uid = 'smoke-prot-soadm';
  const gid = '120363999000000099@g.us';
  const { getAllProtections, setProtection } = require('../utils/protectionStore');
  const { DEFAULT_GROUP_FLAGS } = require('../utils/moderation');
  assert.strictEqual(!!DEFAULT_GROUP_FLAGS.soadm, false, 'default soadm OFF');
  assert.strictEqual(!!DEFAULT_GROUP_FLAGS.surfPayment, false, 'default surf OFF');
  assert.strictEqual(!!getAllProtections(gid, uid).soadm, false, 'soadm default OFF');
  await setProtection(gid, 'soadm', true, 'a', uid);
  assert.strictEqual(!!getAllProtections(gid, uid).soadm, true, 'soadm liga');
  await setProtection(gid, 'soadm', false, 'a', uid);
  assert.strictEqual(!!getAllProtections(gid, uid).soadm, false, 'soadm OFF grava e nao volta');
}

async function main() {
  await testToggleRoundtrip();
  await testSoadmDefaultOffAndSticks();
  await testSessionFlagIsolation();
  await testGetGroupSecurityStoreOnly();
  await testPanelSetIsAbsolute();
  await testListGroupsWithFlagIsolated();
  await testAntideleteAndOdeletePersist();
  testHyphenAntiDeleteCommand();
  testPanelRowIdsAndGpsegClicks();
  testEveryPanelToggleHasStoreAndShortId();
  await testFlagsStayIndependent();
  console.log('protection-smoke: ok');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
