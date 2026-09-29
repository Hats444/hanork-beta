'use strict';
const assert = require('assert');
const logic = require('../utils/groupTheftLogic');
const { DEFAULT_GROUP_FLAGS } = require('../utils/moderation');
const prot = require('../utils/protectionStore');
const store = require('../utils/groupTheftStore');
const guard = require('../utils/groupTheftGuard');

const bot = '5511999000001@s.whatsapp.net';
const registered = '5511988880002@s.whatsapp.net';
const native = '5511977770003@s.whatsapp.net';
const other = '5511966660004@s.whatsapp.net';

const botRole = logic.resolveActorRole({
  actor: bot,
  actorIsBotOwner: true,
  registeredOwner: registered,
  nativeOwner: native
});
assert.strictEqual(botRole, logic.ROLES.BOT_OWNER);

const regRole = logic.resolveActorRole({
  actor: registered,
  actorIsBotOwner: false,
  registeredOwner: registered,
  nativeOwner: native
});
assert.strictEqual(regRole, logic.ROLES.REGISTERED_OWNER);

const nativeRole = logic.resolveActorRole({
  actor: native,
  actorIsBotOwner: false,
  registeredOwner: registered,
  nativeOwner: native
});
assert.strictEqual(nativeRole, logic.ROLES.NATIVE_OWNER);

assert.strictEqual(logic.isTrustedAuthority(logic.ROLES.BOT_OWNER), true);
assert.strictEqual(logic.isTrustedAuthority(logic.ROLES.REGISTERED_OWNER), true);
assert.strictEqual(logic.isTrustedAuthority(logic.ROLES.NATIVE_OWNER), false);
assert.strictEqual(logic.isTrustedAuthority(logic.ROLES.WA_ADMIN), false);

const member = logic.resolveActorRole({
  actor: other,
  actorIsBotOwner: false,
  registeredOwner: registered,
  nativeOwner: native,
  actorIsWaAdmin: true
});
assert.strictEqual(member, logic.ROLES.WA_ADMIN);

assert.strictEqual(DEFAULT_GROUP_FLAGS.antiadmin, false);
assert.strictEqual(DEFAULT_GROUP_FLAGS.antiadminAlert, false);
assert.strictEqual(DEFAULT_GROUP_FLAGS.antiadminRevert, true);

const flags = prot.getAllProtections('120363000000000000@g.us', 'smoke-uid-no-sql');
assert.strictEqual(flags.antiadmin, false);
assert.strictEqual(flags.antiadminAlert, false);
assert.strictEqual(flags.antiadminRevert, true);

const rec = store.emptyRecord('120363000000000000@g.us');
assert.strictEqual(Number(rec.protection_enabled), 0);
assert.strictEqual(Number(rec.alert_enabled), 0);
assert.strictEqual(rec.alert_dest, 'silent');
assert.strictEqual(Number(rec.revert_enabled), 1);

const live = guard.flagsFromGroup(flags, rec);
assert.strictEqual(live.protection, false);
assert.strictEqual(live.alert, false);
assert.strictEqual(live.silent, true);
assert.strictEqual(live.dest, 'silent');

const leftover = {
  protection_enabled: 1,
  audit_enabled: 1,
  alert_enabled: 1,
  alert_dest: 'group',
  revert_enabled: 1
};
const leftoverLive = guard.flagsFromGroup(
  { antiadmin: false, antiadminAlert: false, antiadminAudit: false, antiadminRevert: true },
  leftover
);
assert.strictEqual(leftoverLive.protection, false, 'SQL legado protection=1 nao liga sozinho');
assert.strictEqual(leftoverLive.alert, false, 'SQL legado alert=1 nao posta sozinho');
assert.strictEqual(leftoverLive.audit, false);

const opted = guard.flagsFromGroup(
  { antiadmin: true, antiadminAlert: true, antiadminAudit: false, antiadminRevert: true },
  { alert_dest: 'group', alert_enabled: 1, protection_enabled: 1 }
);
assert.strictEqual(opted.protection, true);
assert.strictEqual(opted.alert, true);
assert.strictEqual(opted.dest, 'group');

const demoteMember = logic.decide({
  action: 'demote',
  actor: other,
  actorRole: logic.ROLES.WA_ADMIN,
  targetRole: logic.ROLES.MEMBER,
  targetWasAdmin: false,
  flags: { protection: true, alert: true, silent: false, audit: true, revert: true, detect: true }
});
assert.strictEqual(demoteMember.alert, false, 'demote de membro comum nao alerta');
assert.notStrictEqual(demoteMember.policy, 'APPLY');

const demoteAdmin = logic.decide({
  action: 'demote',
  actor: other,
  actorRole: logic.ROLES.WA_ADMIN,
  targetRole: logic.ROLES.WA_ADMIN,
  targetWasAdmin: true,
  flags: { protection: true, alert: true, silent: false, audit: false, revert: true, detect: true }
});
assert.strictEqual(demoteAdmin.alert, true);
assert.strictEqual(demoteAdmin.policy, 'APPLY');

assert.strictEqual(logic.ALERT_DESTS[0], 'silent');

console.log('groupTheft-smoke: ok');
