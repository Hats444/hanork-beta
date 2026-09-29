'use strict';
/**
 * Smoke: dono/VIP/user + admin nativo nao e dono. Isolamento CTA1/CTA2.
 */
const assert = require('assert');
const { sessionRole, chatKind, RANK } = require('../utils/commandGate');
const { parseTipoSlot, modoKey } = require('../utils/divulgacao');

function fakeCtx(over = {}) {
  return {
    from: '120363000000000000@g.us',
    sender: '5511999999999@s.whatsapp.net',
    telegramUserId: '111',
    isGroup: true,
    isAdmin: true,
    fromMe: false,
    conn: null,
    ...over
  };
}

function testChatKind() {
  assert.strictEqual(chatKind({ from: 'x@g.us', isGroup: true }), 'group');
  assert.strictEqual(chatKind({ from: 'x@s.whatsapp.net', isGroup: false }), 'dm');
  assert.strictEqual(chatKind({ from: 'x@newsletter', isChannel: true }), 'channel');
}

function testNativeAdminIsUser() {
  const ctx = fakeCtx();
  const role = sessionRole(ctx);
  assert.notStrictEqual(role, 'owner');
  assert.notStrictEqual(role, 'vip');
  assert.ok(RANK[role] < RANK.owner);
}

function testSlotKeysIndependent() {
  assert.strictEqual(modoKey('cta', 1), 'cta');
  assert.strictEqual(modoKey('cta', 2), 'cta:2');
  assert.strictEqual(parseTipoSlot('cta:2').slot, 2);
  assert.strictEqual(parseTipoSlot('cta').slot, 1);
  assert.notStrictEqual(modoKey('cta', 1), modoKey('cta', 2));
}

function testIntervalIsolation() {
  const { intervalForTipo } = require('../utils/divulgacaoAuto');
  const cfg = {
    autoIntervalMin: 30,
    autoIntervalByTipo: { cta: 120, 'cta:2': 45, status: 60 }
  };
  assert.strictEqual(intervalForTipo(cfg, 'cta'), 120);
  assert.strictEqual(intervalForTipo(cfg, 'cta:2'), 45);
  assert.notStrictEqual(intervalForTipo(cfg, 'cta'), intervalForTipo(cfg, 'cta:2'));
}

function testAssertNukeDeniedForUser() {
  const { assertCommand } = require('../utils/commandGate');
  const r = assertCommand(fakeCtx(), 'nuke');
  assert.strictEqual(r.ok, false);
  assert.ok(r.kind === 'group' || r.kind === 'dm');
}

/** Incidente: comum + LID sem match + PN sem match + fromMe/conn → deny. */
function testNukeDeniedLidPnNoMatch() {
  const { assertCommand } = require('../utils/commandGate');
  const { sessionRole } = require('../utils/commandGate');
  const ctx = fakeCtx({
    telegramUserId: 'smoke-anon-no-owners',
    sender: '999888777666555@lid',
    senderAlt: '5511988880000@s.whatsapp.net',
    fromMe: true,
    isAdmin: true,
    isOwner: true,
    conn: { user: { id: '5511000000000:11@s.whatsapp.net', lid: '111222333444@lid' } },
    info: {
      key: {
        fromMe: true,
        remoteJid: '120363000000000000@g.us',
        participant: '999888777666555@lid',
        participantPn: '5511988880000@s.whatsapp.net',
        participantAlt: '5511988880000@s.whatsapp.net'
      }
    }
  });
  assert.notStrictEqual(sessionRole(ctx), 'owner', 'LID/PN sem match nao e dono');
  const r = assertCommand(ctx, 'nuke');
  assert.strictEqual(r.ok, false, 'nuke deny user LID+PN sem match');
  assert.strictEqual(assertCommand(ctx, 'banall').ok, false);
  assert.strictEqual(ctx.isOwner, false, 'group_admin/fromMe nao promove a dono em nuke');
}

function testSessionIsolationDirs() {
  const { getUserDir, normalizeTenantUid } = require('../utils/userManager');
  assert.strictEqual(normalizeTenantUid(undefined), null);
  assert.strictEqual(normalizeTenantUid('undefined'), null);
  const a = getUserDir('smoke-sess-A');
  const b = getUserDir('smoke-sess-B');
  assert.notStrictEqual(a, b);
  assert.ok(a.includes('smoke-sess-A'));
  assert.ok(b.includes('smoke-sess-B'));
  assert.ok(!a.includes(`${require('path').sep}undefined`));
}

function testAntipvKeyedBySession() {
  const {
    getOwnerSecurity,
    setOwnerSecurityFlag,
    setAntipvAll,
    isPrivatePersonChat,
    isPvAntiExempt,
    pvAntiWouldBlock
  } = require('../utils/moderation');
  const { getModerationConfig, setModerationConfig } = require('../utils/configManager');
  const empty = getOwnerSecurity('');
  assert.strictEqual(empty.antipv, true, 'uid vazio usa default ON (fail-closed)');
  setOwnerSecurityFlag('smoke-antipv-A', 'antipv2', true);
  setOwnerSecurityFlag('smoke-antipv-A', 'antipv3', true);
  setOwnerSecurityFlag('smoke-antipv-A', 'antipv', false);
  assert.strictEqual(getOwnerSecurity('smoke-antipv-A').antipv, false);
  const b = getOwnerSecurity('smoke-antipv-B');
  assert.strictEqual(b.antipv, true, 'sessao B mantem default proprio, nao herda OFF de A');

  assert.strictEqual(isPrivatePersonChat({ from: '1234567890@lid', isGroup: true }), true, 'LID 1:1 nao e grupo');
  assert.strictEqual(isPrivatePersonChat({ from: '120363999000000008@g.us', isGroup: true }), false);
  assert.strictEqual(isPvAntiExempt(null), false, 'ctx vazio nao isenta');

  const cfg = getModerationConfig('smoke-antipv-legacy') || { enabledGroups: [] };
  cfg.ownerSecurity = { antipv: false, antipv2: false, antipv3: false, antipvChosen: true };
  setModerationConfig('smoke-antipv-legacy', cfg);
  assert.strictEqual(getOwnerSecurity('smoke-antipv-legacy').antipv, true, 'legado 3-off volta ON');

  setAntipvAll('smoke-antipv-legacy', false);
  assert.strictEqual(getOwnerSecurity('smoke-antipv-legacy').antipv, false, 'master off desliga');
  setAntipvAll('smoke-antipv-legacy', true);

  const userCtx = {
    from: '5511999887766@s.whatsapp.net',
    sender: '5511999887766@s.whatsapp.net',
    isGroup: false,
    fromMe: false,
    telegramUserId: 'smoke-antipv-B'
  };
  assert.ok(pvAntiWouldBlock(userCtx, 'smoke-antipv-B'), 'user comum no PV deve bloquear');
}

function testUserCanPingEverywhere() {
  const { assertCommand } = require('../utils/commandGate');
  const group = assertCommand(fakeCtx({ from: 'x@g.us', isGroup: true }), 'ping');
  assert.strictEqual(group.ok, true, 'ping deve passar em grupo');
  const dm = assertCommand(fakeCtx({
    from: '5511999@s.whatsapp.net',
    isGroup: false,
    isAdmin: false
  }), 'ping');
  assert.strictEqual(dm.ok, true, 'ping deve passar no PV');
  const ch = assertCommand(fakeCtx({
    from: 'x@newsletter',
    isChannel: true,
    isGroup: false
  }), 'ping');
  assert.strictEqual(ch.ok, false, 'canal: user comum fail-closed');
  const chFromMe = assertCommand(fakeCtx({
    from: 'x@newsletter',
    isChannel: true,
    isGroup: false,
    fromMe: true,
    isOwner: true
  }), 'ping');
  assert.strictEqual(chFromMe.ok, false, 'canal: fromMe nao fura o gate');
}

function testBanallAddownerDenied() {
  const { assertCommand } = require('../utils/commandGate');
  const ctx = fakeCtx({ isAdmin: true });
  assert.strictEqual(assertCommand(ctx, 'banall').ok, false);
  assert.strictEqual(assertCommand(ctx, 'addowner').ok, false);
  assert.strictEqual(assertCommand(ctx, 'addvip').ok, false);
}

function testSetAuthorizationFlagsIgnoresFromMe() {
  const { setAuthorizationFlags } = require('../utils/authorization');
  const ctx = fakeCtx({
    telegramUserId: 'smoke-anon-no-owners',
    fromMe: true,
    isOwner: true,
    conn: { user: { id: '5511000000000:11@s.whatsapp.net', lid: '111222333444@lid' } }
  });
  setAuthorizationFlags(ctx, 'smoke-anon-no-owners');
  assert.strictEqual(ctx.isOwner, false, 'fromMe nao grava isOwner');
  assert.notStrictEqual(ctx.authRole, 'owner');
}

function testMenuListsSlot2() {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../commands/divulgar/div.js'), 'utf8');
  assert.ok(src.includes('Confirmar CTA #2'));
  assert.ok(src.includes('Confirmar Status #2'));
}

function testDivulgacaoSessionIsolation() {
  const div = require('../utils/divulgacao');
  div.updateConfig('smoke-div-A', { texto: 'AAA-only' });
  div.updateConfig('smoke-div-B', { texto: 'BBB-only' });
  assert.strictEqual(div.getConfig('smoke-div-A').texto, 'AAA-only', 'sessao A nao le texto de B');
  assert.strictEqual(div.getConfig('smoke-div-B').texto, 'BBB-only', 'sessao B nao le texto de A');
  div.updateSlotPatch('smoke-div-A', 'cta', 1, { texto: 'CTA-A' });
  div.updateSlotPatch('smoke-div-B', 'cta', 1, { texto: 'CTA-B' });
  const aCta = div.getConfig('smoke-div-A').cta || {};
  const bCta = div.getConfig('smoke-div-B').cta || {};
  assert.strictEqual(aCta.texto, 'CTA-A', 'CTA da sessao A isolado');
  assert.strictEqual(bCta.texto, 'CTA-B', 'CTA da sessao B isolado');
}

function testDetectMessageContextSafe() {
  const { detectMessageContext } = require('../utils/authorization');
  assert.strictEqual(detectMessageContext('x@g.us'), 'group');
  assert.doesNotThrow(() => detectMessageContext({ foo: 1 }));
  assert.doesNotThrow(() => detectMessageContext(null));
  assert.strictEqual(detectMessageContext({ id: 'x@g.us' }), 'group');
}

function testModenableIsGroupSecurityNotOwnerOnly() {
  const { GROUP_SECURITY_CMDS } = require('../utils/commandGate');
  assert.ok(GROUP_SECURITY_CMDS.has('modenable'), 'admin nativo liga antiflood');
  assert.ok(GROUP_SECURITY_CMDS.has('moddisable'));
  assert.ok(GROUP_SECURITY_CMDS.has('modstatus'));
  assert.ok(!GROUP_SECURITY_CMDS.has('modlist'), 'modlist continua so dono da sessao');
  assert.ok(!GROUP_SECURITY_CMDS.has('nuke'));
  assert.ok(GROUP_SECURITY_CMDS.has('cita'), 'cita e comando de admin do grupo');
  assert.ok(GROUP_SECURITY_CMDS.has('totag'));
}

function testVipPeerCannotUseAdmCommand() {
  const { canUseCommand } = require('../utils/permissionEngine');
  assert.strictEqual(canUseCommand('vip', 'adm'), false);
  assert.strictEqual(canUseCommand('vip', 'adm', { isGroupAdmin: true }), true);
  assert.strictEqual(canUseCommand('vip', 'owner', { isGroupAdmin: true }), false);
  assert.strictEqual(canUseCommand('adm', 'vip'), false);
  assert.strictEqual(canUseCommand('adm', 'owner'), false);
}

function testSpotifuAlias() {
  const { resolveKnownCommand, parsePrefixedCommand } = require('../utils/commandTextParse');
  assert.strictEqual(resolveKnownCommand('spotifu'), 'spotify');
  assert.strictEqual(resolveKnownCommand('spotfy'), 'spotify');
  const p = parsePrefixedCommand('.spotifu beliver', '.');
  assert.strictEqual(p.command, 'spotify');
  assert.ok(String(p.text).includes('beliver'));
}

function testRequireSessionOwnerNeverRedirectsToOwnerPv() {
  return (async () => {
    const { requireSessionOwner } = require('../utils/authorization');
    const sent = [];
    const conn = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, content });
        return {};
      }
    };

    const groupCtx = {
      isGroup: true,
      from: '120363111111111111@g.us',
      sender: '5511888888888@s.whatsapp.net',
      telegramUserId: '',
      fromMe: false
    };
    assert.strictEqual(await requireSessionOwner(conn, groupCtx), false);
    assert.strictEqual(sent.length, 0, 'grupo nao DM o dono');

    sent.length = 0;
    const fromMeCtx = {
      isGroup: false,
      from: '5511999999999@s.whatsapp.net',
      sender: '5511999999999@s.whatsapp.net',
      telegramUserId: '',
      fromMe: true,
      info: { key: { fromMe: true } }
    };
    assert.strictEqual(await requireSessionOwner(conn, fromMeCtx), false);
    assert.strictEqual(sent.length, 0, 'fromMe nao avisa no PV');

    sent.length = 0;
    const pvCtx = {
      isGroup: false,
      from: '5511777777777@s.whatsapp.net',
      sender: '5511777777777@s.whatsapp.net',
      telegramUserId: '',
      fromMe: false
    };
    assert.strictEqual(await requireSessionOwner(conn, pvCtx, 'Apenas o dono da sessao.'), false);
    assert.strictEqual(sent.length, 1, 'PV comum recebe a recusa no mesmo chat');
    assert.strictEqual(sent[0].jid, pvCtx.from);
  })();
}

testChatKind();
testNativeAdminIsUser();
testSlotKeysIndependent();
testIntervalIsolation();
testAssertNukeDeniedForUser();
testNukeDeniedLidPnNoMatch();
testUserCanPingEverywhere();
testBanallAddownerDenied();
testSetAuthorizationFlagsIgnoresFromMe();
testMenuListsSlot2();
testDivulgacaoSessionIsolation();
testSessionIsolationDirs();
testAntipvKeyedBySession();
testModenableIsGroupSecurityNotOwnerOnly();
testVipPeerCannotUseAdmCommand();
testDetectMessageContextSafe();
testSpotifuAlias();
testRequireSessionOwnerNeverRedirectsToOwnerPv()
  .then(() => {
    console.log('commandGate-smoke: ok');
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

