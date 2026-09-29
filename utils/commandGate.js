'use strict';
/**
 * Gate unico de permissao (OS 22/08).
 * Admin nativo do grupo NUNCA vira dono/VIP.
 * Fail-closed: erro / identidade ambigua = user.
 */
const logger = require('../logger');
const {
  isFreshSessionOwner,
  checkAuthorization,
  detectMessageContext,
  resolveCanonicalIdentity
} = require('./authorization');

let canUseCommand;
let logAudit;
try {
  ({ canUseCommand, logAudit } = require('./permissionEngine'));
} catch (e) {
  logger.logAviso(`[CMDGATE] permissionEngine ausente: ${e.message}`);
  canUseCommand = (actorRole, commandMinRole, opts) => {
    const actor = actorRole === 'group_admin' ? 'adm' : actorRole;
    const need = commandMinRole === 'group_admin' ? 'adm' : commandMinRole;
    if (actor === 'platform_admin') return true;
    if (actor === 'owner') return need !== 'platform_admin';
    if (actor === 'vip') {
      if (need === 'vip' || need === 'user') return true;
      if (need === 'adm' && opts && opts.isGroupAdmin) return true;
      return false;
    }
    if (actor === 'adm') return need === 'adm' || need === 'user';
    return need === 'user';
  };
  logAudit = async () => {};
}

const RANK = { user: 1, vip: 2, adm: 2, owner: 3, platform_admin: 4 };

/** Flags e cmds de grupo: admin nativo pode usar SE o bot for admin.
 *  Nunca: nuke, antipv, addowner, DIV, bangp, antiadmin, donogrupo. */
const GROUP_SECURITY_CMDS = new Set([
  'antistatus', 'antiatkstatus', 'antilink', 'antilinkhard', 'antilinkgp', 'antilinkeasy',
  'antifake', 'antiimg', 'antivideo', 'antiaudio', 'antisticker', 'antidoc', 'antiloc',
  'antictt', 'antichannel', 'antipayment', 'anticatalogo', 'antipalavrao', 'soadm', 'onlyadm', 'soadmin',
  'bemvindo', 'saiu', 'welcome', 'bv', 'autodown', 'autodownload', 'autosticker',
  'antiataque', 'protecaototal', 'antiattack', 'presetprotecao', 'presetseg',
  'antiatkinvisivel', 'antiatkpagamento', 'antiatkcrash', 'antiatkpoll', 'antiatkmencao',
  'antiatkreacao', 'antiatkedicao', 'gpseguranca', 'protecoes', 'protecoesativas',
  'protecoeshelp', 'oquestaon', 'protecoeson',
  'modenable', 'moddisable', 'modstatus',
  'mute', 'desmute', 'mutelist', 'ban', 'kick', 'banir', 'fechargp', 'abrirgp', 'limpar',
  'fechargrupo', 'abrirgrupo', 'gpfechar', 'gpabrir', 'groupclose', 'groupopen',
  'listfake', 'banfake', 'promover', 'rebaixar', 'legendabv', 'legendasaiu', 'limitec',
  'limiteflood', 'antifloodsticker', 'autoconvite', 'autoapresentar', 'autoapres',
  'antidelete', 'antidel', 'antistatusatk', 'antiinvisivel',
  'adv', 'rmadv', 'listadv', 'addlistabranca', 'rmlistabranca', 'listabranca',
  'add', 'remove', 'promote', 'demote',
  'groupinvite', 'linkgp', 'linkgrupo', 'grouplink', 'revokeinvite', 'groupname', 'groupdesc', 'setgroupname', 'setgroupdesc', 'setgrouppp',
  'resetlink',
  'aceitar', 'recusar', 'aceitarall', 'recusarall', 'pedidosentrada',
  'autoaceitar', 'autoaceitartempo', 'attacc', 'setattacc',
  'x9config', 'bantmp', 'fecharas', 'convidar',
  'menu_adm', 'menuadm',
  'banghost',
  'cita', 'hidetag', 'totag', 'tagall', 'marcar', 'marcartodos',
  'settabela', 'sorteio', 'atividade', 'inativos', 'horariogrupo',
  'fotobv', 'figbv', 'audiobv', 'fotosaida', 'figsaida', 'audiosaida', 'bvstatus', 'ausente',
  'antiporno', 'antiporn', 'antinotas',
  'antilingp', 'antidocumento', 'anticontato', 'antichannell', 'antimencao',
  'antipagamentoatk', 'anticrash', 'anticrashgp', 'antipollatk', 'antimencaomassa',
  'antireacao', 'antiedicao',
  'blockgp', 'admcmd',
  'protoff', 'desligarprotecoes', 'protecoesoff',
  'surfpayment', 'surfgroupstatus', 'surfforwardspoof', 'surfmetai', 'surfbizfake',
  'surfphishad', 'surfnativeflow', 'surfviewonce', 'surfcapmentions', 'surfcapmedia',
  'surffakepoll', 'surfsettingsflood'
]);

function isGroupAdminActor(ctx) {
  if (!ctx || !ctx.isGroup) return false;
  if (ctx.authRole === 'group_admin' || ctx.authRole === 'adm') return true;
  if (ctx.isAdmin) return true;
  const gid = ctx.from || ctx.groupJid || '';
  if (!gid || !/@g\.us$/i.test(String(gid))) return false;
  const extras = [ctx.senderAlt, ctx.senderPn, ctx.senderLid].filter(Boolean);
  try {
    const { peekGroupMetadata } = require('./groupMetaCache');
    const { botIsGroupAdmin, isWaAdminInMeta } = require('./protectionStore');
    const meta = peekGroupMetadata(gid);
    if (meta && botIsGroupAdmin(meta, ctx.conn) && isWaAdminInMeta(meta, ctx.sender, extras)) {
      return true;
    }
    if (!meta && ctx.isAdmin) return true;
  } catch (_) {
    if (ctx.isAdmin) return true;
  }
  return false;
}

function chatKind(ctx) {
  const jid = ctx?.from || ctx?.chatId || ctx?.chat || '';
  if (ctx?.isChannel) return 'channel';
  if (ctx?.isGroup) return 'group';
  return detectMessageContext(jid);
}

function minLevelFor(commandName) {
  const name = String(commandName || '').toLowerCase().replace(/^[^a-z0-9_]+/i, '');
  try {
    const { getCommandConfig } = require('../core/router/universalRouter');
    const p = getCommandConfig(name)?.permission;
    if (p) return p;
  } catch (_) { /* registry pode nao estar pronto */ }
  try {
    const { classify } = require('../core/router/registeredCommands');
    return classify(name).permission || 'owner';
  } catch (_) {
    return 'owner';
  }
}

function sessionRole(ctx) {
  if (!ctx) return 'user';
  if (ctx.platform === 'telegram' || ctx.isTelegram) {
    try {
      const { isAdmin } = require('./userManager');
      const tid = String(ctx.telegramUserId || ctx.sender || '');
      if (tid && isAdmin(tid)) return 'platform_admin';
    } catch (_) { /* ignore */ }
    try {
      const vipIndex = require('../services/billing/vipIndex');
      const tid = String(ctx.telegramUserId || ctx.sender || '');
      if (tid && vipIndex.tierOf('telegram', tid) !== 'free') return 'vip';
    } catch (_) { /* ignore */ }
  }
  if (isFreshSessionOwner(ctx)) return 'owner';
  const tid = String(ctx.telegramUserId || '');
  if (!tid) return 'user';
  const ids = resolveCanonicalIdentity(ctx.sender, ctx);
  const auth = checkAuthorization(ids[0] || ctx.sender || ctx.from, tid, false, ids, ctx.conn);
  if (auth.role === 'platform_admin') return 'platform_admin';
  if (auth.role === 'owner') return 'owner';
  if (auth.role === 'vip') return 'vip';
  return 'user';
}

function applyRole(ctx, role) {
  if (!ctx) return;
  ctx.authRole = role;
  ctx.isOwner = role === 'owner' || role === 'platform_admin';
  ctx.isVip = ctx.isOwner || role === 'vip';
}

const PERSON_TARGET_CMDS = new Set([
  'ban', 'kick', 'banir', 'mute', 'desmute', 'promover', 'rebaixar', 'promote', 'demote',
  'add', 'remove', 'adv', 'rmadv', 'banfake', 'banghost', 'bna', 'band',
  'bantmp', 'convidar'
]);

/** DK nao mira pessoa. Clique no menu cita a msg do bot (=dono) e o gate engolia o botao. */
const DK_CMDS = new Set([
  'dk', 'entrardk', 'menu_dk', 'dkmenu', 'menudk',
  'msgdk', 'fotodk', 'videodk', 'apagardk', 'qtddk',
  'dkpay', 'msgdkpay', 'dkmidia', 'rmfotodk', 'listfotodk'
]);

function withTargetGuard(ctx, commandName, result) {
  if (!result || !result.ok) return result;
  const raw = String(commandName || '').toLowerCase().replace(/^cmd_/, '');
  if (/^(protset_|ps_)/i.test(raw)) return result;
  if (DK_CMDS.has(raw) || raw.startsWith('menu_')) return result;
  const name = raw.replace(/^(protset_|ps_)/, '').split('_')[0];
  if (GROUP_SECURITY_CMDS.has(name) && !PERSON_TARGET_CMDS.has(name)) return result;
  try {
    const { guardPersonTargets } = require('./permissionEngine');
    const g = guardPersonTargets(ctx?.conn, ctx, commandName);
    if (g && g.allowed === false) {
      logger.logAviso(
        `[CMDGATE] deny cmd=${commandName} reason=alvo_imune actor=${g.actorRole} target=${g.targetRole}`
      );
      return {
        ok: false,
        role: result.role,
        min: result.min,
        kind: result.kind,
        reason: 'alvo_imune',
        silent: true
      };
    }
  } catch (_) { /* motor opcional */ }
  return result;
}

function assertCommand(ctx, commandName) {
  const kind = chatKind(ctx);
  const min = minLevelFor(commandName);
  const role = sessionRole(ctx);
  applyRole(ctx, role);
  try {
    const { isOwnerOnlyMode, allowOwnerOnlyActor } = require('./ownerOnlyMode');
    if (isOwnerOnlyMode() && !allowOwnerOnlyActor(ctx)) {
      logger.logInfo(`[CMDGATE] owner-only deny cmd=${commandName} role=${role} kind=${kind}`);
      return { ok: false, role, min, kind, reason: 'owner_only', silent: true };
    }
  } catch (_) { /* */ }
  if (role !== 'owner' && role !== 'platform_admin') {
    try {
      const { isCmdBlocked } = require('./groupModStore');
      if (isCmdBlocked(ctx.telegramUserId || ctx.conn?._telegramUserId, commandName)) {
        logger.logAviso(`[CMDGATE] cmd_blocked cmd=${commandName}`);
        return {
          ok: false,
          role,
          min,
          kind,
          reason: 'cmd_blocked',
          message: 'Este comando esta desligado nesta sessao.'
        };
      }
    } catch (_) { /* store opcional */ }
  }
  const have = RANK[role] || 0;
  if (kind === 'channel' && have < RANK.owner && !ctx.isChannelAdmin) {
    logger.logAviso(
      `[CMDGATE] deny cmd=${commandName} role=${role} need=${min} kind=channel`
    );
    return { ok: false, role, min, kind, reason: 'canal' };
  }
  const name = String(commandName || '').toLowerCase();
  const adminHere = kind === 'group' && isGroupAdminActor(ctx);
  if (adminHere) ctx.isAdmin = true;
  if (canUseCommand(role, min, { isGroupAdmin: adminHere || !!ctx.isAdmin })) {
    try {
      const paywall = require('./paywall');
      if (paywall.shouldBlock(ctx, commandName)) {
        logger.logAviso(
          `[CMDGATE] paywall cmd=${commandName} role=${role} need=${min}`
        );
        return { ok: false, role, min, kind, reason: 'paywall', message: paywall.denyText(ctx, commandName) };
      }
    } catch (_) { /* modulo opcional */ }
    const allowed = withTargetGuard(ctx, commandName, { ok: true, role, min, kind, isGroupAdmin: adminHere });
    logAudit({
      sessionId: ctx.sessionId || ctx.conn?._sessionId || '',
      platform: ctx.platform || (ctx.isTelegram ? 'telegram' : 'whatsapp'),
      command: name,
      actorRole: role,
      groupJid: ctx.from || '',
      allowed: !!allowed.ok,
      denyReason: allowed.ok ? null : (allowed.reason || null)
    });
    return allowed;
  }
  // Admin nativo (nao VIP/dono): so neste group_jid, comando catalogado como adm.
  // VIP+admin ja entrou no ramo canUseCommand acima e MANTÉM isVip.
  const rawName = String(commandName || '').toLowerCase().replace(/^cmd_/, '');
  const dkAdminOk = rawName === 'dk';
  if (
    role !== 'vip' &&
    role !== 'owner' &&
    role !== 'platform_admin' &&
    kind === 'group' &&
    (min === 'adm' || dkAdminOk) &&
    adminHere
  ) {
    ctx.authRole = 'group_admin';
    ctx.isAdmin = true;
    ctx.isOwner = false;
    ctx.isVip = false;
    try {
      const paywall = require('./paywall');
      if (paywall.shouldBlock(ctx, commandName)) {
        logger.logAviso(`[CMDGATE] paywall cmd=${commandName} role=group_admin`);
        return {
          ok: false,
          role: 'group_admin',
          min,
          kind,
          reason: 'paywall',
          message: paywall.denyText(ctx, commandName)
        };
      }
    } catch (_) { /* ignore */ }
    logAudit({
      sessionId: ctx.sessionId || ctx.conn?._sessionId || '',
      platform: ctx.platform || (ctx.isTelegram ? 'telegram' : 'whatsapp'),
      command: name,
      actorRole: 'adm',
      groupJid: ctx.from || '',
      allowed: true
    });
    return withTargetGuard(ctx, commandName, { ok: true, role: 'group_admin', min, kind });
  }
  logger.logAviso(
    `[CMDGATE] deny cmd=${commandName} role=${role} need=${min} kind=${kind}`
  );
  logAudit({
    sessionId: ctx.sessionId || ctx.conn?._sessionId || '',
    platform: ctx.platform || (ctx.isTelegram ? 'telegram' : 'whatsapp'),
    command: name,
    actorRole: role,
    groupJid: ctx.from || '',
    allowed: false,
    denyReason: 'nivel insuficiente'
  });
  return { ok: false, role, min, kind, reason: 'nivel' };
}

module.exports = {
  chatKind,
  sessionRole,
  minLevelFor,
  applyRole,
  assertCommand,
  isGroupAdminActor,
  GROUP_SECURITY_CMDS,
  RANK,
  DK_CMDS
};
