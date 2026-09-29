'use strict';
const assert = require('assert');
const mod = require('../utils/moderation');
const ad = require('../utils/antiDelete');

const GID = '120363000000000001@g.us';
const SID = 'smoke-antidelete';
const MEMBER = '5511999000001@s.whatsapp.net';
const ADMIN = '5511988880002@s.whatsapp.net';

(async () => {
  const origGet = mod.getGroupSecurity;
  mod.getGroupSecurity = () => ({ antidelete: true });

  assert.strictEqual(ad.isRevokeUpdate({ update: { messageStubType: 1 } }), true);
  assert.strictEqual(ad.isRevokeUpdate({ update: { messageStubType: 132 } }), true);
  assert.strictEqual(ad.isRevokeUpdate({
    message: { protocolMessage: { type: 0, key: { id: 'ABC' } } }
  }), true);
  assert.strictEqual(ad.isRevokeUpdate({ update: { status: 3 } }), false);

  const k = ad.revokeTargetKey({
    key: { remoteJid: GID, id: 'WRAP', participant: ADMIN, fromMe: false },
    message: { protocolMessage: { type: 0, key: { id: 'ORIG', participant: MEMBER } } }
  });
  assert.strictEqual(k.id, 'ORIG');
  assert.strictEqual(k.author, MEMBER);

  const sent = [];
  const conn = {
    user: { id: '5511900000000@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: 'out' } };
    }
  };

  ad.rememberMessage(SID, {
    key: { id: 'M1', remoteJid: GID, fromMe: false, participant: MEMBER },
    message: { conversation: 'oi sumiu' }
  });
  await ad.processRevokeUpdates(conn, [{
    key: { remoteJid: GID, id: 'M1', fromMe: false, participant: MEMBER },
    update: { message: null, messageStubType: 1 }
  }], '111', SID);
  assert.ok(sent.some((s) => String(s.content.text || '').includes('oi sumiu')), 'recupera membro');

  sent.length = 0;
  ad.rememberMessage(SID, {
    key: { id: 'M2', remoteJid: GID, fromMe: true, participant: ADMIN },
    message: { conversation: 'teste dono' }
  });
  await ad.processRevokeUpdates(conn, [{
    key: { remoteJid: GID, id: 'M2', fromMe: true, participant: ADMIN },
    update: { message: null, messageStubType: 1 }
  }], '111', SID);
  assert.ok(sent.some((s) => String(s.content.text || '').includes('teste dono')), 'recupera fromMe/ADM');

  sent.length = 0;
  ad.rememberMessage(SID, {
    key: { id: 'M3', remoteJid: GID, fromMe: false, participant: MEMBER },
    message: { conversation: 'nao devolve' }
  });
  ad.noteBotDeleted('M3');
  await ad.processRevokeUpdates(conn, [{
    key: { remoteJid: GID, id: 'M3', fromMe: true, participant: ADMIN },
    update: { message: null, messageStubType: 1 }
  }], '111', SID);
  assert.strictEqual(sent.length, 0, 'bot apagou ofensor: nao recupera');

  mod.getGroupSecurity = origGet;
  console.log('antiDelete-smoke: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
