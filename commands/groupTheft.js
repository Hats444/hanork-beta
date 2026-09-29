'use strict';

const logger = require('../logger');
const { prefixFromCtx } = require('../utils/configManager');
const {
  getGroupSecurity,
  setGroupSecurityFlag,
  resolveTargetJid,
  sameParticipant,
  isGroupAdminStrict,
  collectMessageSenderIds
} = require('../utils/moderation');
const logic = require('../utils/groupTheftLogic');
const store = require('../utils/groupTheftStore');
const guard = require('../utils/groupTheftGuard');

const commands = {};

function parseOnOff(text) {
  try {
    return require('../utils/protectionStore').parseOnOff(text);
  } catch (_) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    const first = t.split(/\s+/)[0];
    if (/^(on|1|true|ativar|liga|ligar|sim|yes)$/.test(first)) return true;
    if (/^(off|0|false|desativar|desliga|desligar|nao|não|no)$/.test(first)) return false;
    return null;
  }
}

function parseAlertDest(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  if (/^(grupo|group|gp)$/.test(t)) return 'group';
  if (/^(pv|dm|privado|particular)$/.test(t)) return 'dm';
  if (/^(ambos|both|os dois)$/.test(t)) return 'both';
  if (/^(dono|owner)$/.test(t)) return 'owner';
  if (/^(silencioso|silent|log)$/.test(t)) return 'silent';
  return null;
}

function destLabel(d) {
  switch (String(d || 'silent')) {
    case 'dm': return 'pv do dono GP';
    case 'both': return 'grupo+pv GP';
    case 'owner': return 'pv da sessao';
    case 'silent': return 'so log';
    case 'group': return 'grupo';
    default: return 'so log';
  }
}

function preferredPersonJid(ctx) {
  const alt = ctx.senderAlt || ctx.senderPn || ctx.info?.key?.participantAlt || ctx.info?.key?.participantPn;
  const a = String(alt || '');
  if (a.endsWith('@s.whatsapp.net') || a.endsWith('@c.us')) return a;
  const s = String(ctx.sender || '');
  if (s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us')) return s;
  return guard.preferPhoneJid(s || a) || s || a;
}

function persistablePersonJid(jid, ctx) {
  const mapped = guard.preferPhoneJid(jid);
  if (mapped && (mapped.endsWith('@s.whatsapp.net') || mapped.endsWith('@c.us'))) return mapped;
  if (ctx) {
    const fromCtx = preferredPersonJid(ctx);
    if (fromCtx && (fromCtx.endsWith('@s.whatsapp.net') || fromCtx.endsWith('@c.us'))) {
      if (!jid || guard.idsMatch(jid, ctx.sender) || guard.idsMatch(jid, fromCtx)) return fromCtx;
    }
  }
  return mapped || String(jid || '');
}

function ctxAliases(ctx) {
  return [
    ctx.sender,
    ctx.senderAlt,
    ctx.senderPn,
    ctx.info?.key?.participantAlt,
    ctx.info?.key?.participantPn
  ].filter(Boolean);
}

function peekNative(gid) {
  try {
    return logic.nativeOwnerFromMeta(require('../utils/groupMetaCache').peekGroupMetadata(gid));
  } catch (_) {
    return '';
  }
}

function send(conn, ctx, text, mentions) {
  const list = [...new Set((mentions || []).filter(Boolean))];
  return conn.sendMessage(
    ctx.from,
    {
      text,
      mentions: list,
      ...(list.length ? { contextInfo: { mentionedJid: list } } : {})
    },
    { quoted: ctx.info, skipForward: true, _hanorkTrusted: true }
  );
}

function reopenPanel(conn, ctx) {
  const { sendSecurityPanel } = require('../utils/securityMenu');
  return sendSecurityPanel(conn, {
    chatId: ctx.from,
    quoted: ctx.info,
    telegramUserId: ctx.telegramUserId,
    sessionId: ctx.sessionId || conn?._sessionId,
    isGroup: true,
    groupId: ctx.from,
    skipIntroStatus: true
  });
}

function targetHowTo(ctx, cmd) {
  const p = prefixFromCtx(ctx);
  return [
    `Como usar ${p}${cmd}:`,
    'Responda a mensagem da pessoa e digite o comando.',
    `Ou marque: ${p}${cmd} @user`,
    'No painel o toque sozinho nao escolhe a pessoa.'
  ].join('\n');
}

async function senderRole(conn, ctx) {
  if (ctx.isOwner) return logic.ROLES.BOT_OWNER;
  const rec = await store.load(ctx.from, ctx.telegramUserId);
  const aliases = ctxAliases(ctx);
  try {
    const { rememberLidPhonePair } = require('../utils');
    rememberLidPhonePair(ctx.sender, ctx.senderAlt || preferredPersonJid(ctx));
  } catch (_) { /* cache opcional */ }
  const actor = guard.canonicalAgainst(aliases, rec) || aliases[0] || ctx.sender;
  return logic.resolveActorRole({
    actor,
    actorIsBot: false,
    actorIsBotOwner: aliases.some((t) => guard.isBotOwnerId(conn, ctx.telegramUserId, t)),
    registeredOwner: rec.registered_owner_jid,
    nativeOwner: rec.native_owner_jid,
    trusted: rec.trusted,
    actorIsWaAdmin: !!ctx.isAdmin
  });
}

async function requireManage(conn, ctx, { transfer = false } = {}) {
  if (!ctx.isGroup) {
    await send(conn, ctx, 'Use este comando DENTRO do grupo.');
    return null;
  }
  if (!transfer) {
    const { canTogglePolicy, denyToggleText } = require('../utils/protectionStore');
    if (!canTogglePolicy(ctx.sender, ctx.from, ctx)) {
      await send(conn, ctx, denyToggleText());
      return null;
    }
    return (await senderRole(conn, ctx)) || 'ALLOWED';
  }
  const role = await senderRole(conn, ctx);
  const ok = logic.canTransferRole(role);
  if (!ok) {
    await send(conn, ctx, 'So o dono registrado (ou dono da sessao) pode isso.');
    return null;
  }
  return role;
}

function onOff(v) {
  return v ? 'ON' : 'OFF';
}

async function buildStatus(conn, ctx) {
  const gid = ctx.from;
  const rec = await store.load(gid, ctx.telegramUserId);
  const flags = getGroupSecurity(gid, ctx.telegramUserId);
  const f = guard.flagsFromGroup(flags, rec);
  const native = rec.native_owner_jid || peekNative(gid);
  const mentions = [];
  const tag = (jid, fallback) => {
    const m = guard.mentionTag(jid);
    if (!m.jid) return fallback || '-';
    mentions.push(m.jid);
    return m.tag;
  };
  const trustedLines = (rec.trusted || []).length
    ? rec.trusted.map((t) => `- ${tag(t.jid)} (${t.role})`).join('\n')
    : '-';
  let botOwnerLines = '-';
  try {
    const { getEffectiveOwners } = require('../utils/configManager');
    const owners = getEffectiveOwners(ctx.telegramUserId) || [];
    const uniq = [];
    for (const o of owners) {
      const id = String(o || '');
      if (!id || uniq.some((x) => logic.sameId(x, id))) continue;
      uniq.push(id);
    }
    if (uniq.length) botOwnerLines = uniq.map((id) => `- ${tag(id)}`).join('\n');
  } catch (_) { /* lista opcional */ }
  const m = guard.getMetrics();
  const p = prefixFromCtx(ctx);
  return {
    mentions,
    text: [
      'DONO DO GRUPO',
      'Donos do bot (sempre, em todos os grupos):',
      botOwnerLines,
      `Owner nativo: ${tag(native)}`,
      `Owner registrado (deste grupo): ${tag(rec.registered_owner_jid)}`,
      'Owners confiaveis (deste grupo):',
      trustedLines,
      '',
      'ANTI-ADMIN',
      `Protecao: ${onOff(f.protection)}`,
      `Auditoria: ${onOff(f.audit)}`,
      `Reversao: ${onOff(f.revert)}`,
      `Alertas: ${onOff(f.alert)} (${destLabel(f.dest || rec.alert_dest)})`,
      `Silencioso: ${onOff(f.silent)}`,
      `Deteccao ataque: ${onOff(f.detect)}`,
      `Limite: ${f.threshold} acoes / ${Math.round(f.windowMs / 1000)}s`,
      '',
      `Destino alerta: ${p}antiadmindest grupo|pv|ambos|dono|silencioso`,
      `Historico: ${p}historicoadmin`,
      `Transferir: ${p}transferirdono @user`,
      `Confiavel: ${p}addgpowner @user`,
      'Teste real: admin COMUM rebaixando outro admin (dono da sessao e permitido).',
      m.events ? `Obs: ${m.events} eventos, media ${m.avgMs}ms` : ''
    ].filter((line, i, arr) => line !== '' || arr[i - 1] !== '').join('\n')
  };
}

async function toggleNamed(conn, ctx, flag, sqlPatch, label) {
  if (!ctx.isGroup) {
    await send(conn, ctx, 'Use este comando DENTRO do grupo.');
    return;
  }
  const parsed = parseOnOff(ctx.text) ?? parseOnOff((ctx.args || [])[0]);
  if (parsed === null && ctx.command === 'antiadmin' && !ctx.isInteractive) {
    const st = await buildStatus(conn, ctx);
    return send(conn, ctx, st.text, st.mentions);
  }
  const role = await requireManage(conn, ctx);
  if (!role) return;
  const fromPanel = !!(ctx.isInteractive || (parsed === null && !String(ctx.text || '').trim()));
  let enabled;
  if (parsed === null) {
    enabled = !getGroupSecurity(ctx.from, ctx.telegramUserId)[flag];
  } else {
    enabled = parsed;
  }
  const saved = await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, flag, enabled, ctx.sender);
  const rec = await store.load(ctx.from, ctx.telegramUserId);
  const patch = { ...(sqlPatch ? sqlPatch(!!saved[flag]) : {}) };
  if (flag === 'antiadmin' && saved[flag]) {
    const native = rec.native_owner_jid || peekNative(ctx.from);
    if (native && !rec.native_owner_jid) patch.native_owner_jid = native;
    if (!rec.registered_owner_jid) {
      patch.registered_owner_jid = persistablePersonJid(native || preferredPersonJid(ctx), ctx);
    }
    try {
      const { rememberLidPhonePair } = require('../utils');
      rememberLidPhonePair(ctx.sender, ctx.senderAlt || preferredPersonJid(ctx));
    } catch (_) { /* cache opcional */ }
  }
  if (flag === 'antiadminAlert') {
    if (saved[flag]) {
      if (rec.alert_dest === 'silent') patch.alert_dest = 'dm';
      patch.alert_enabled = 1;
      await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, 'antiadminSilent', false);
    } else {
      patch.alert_enabled = 0;
    }
  }
  if (flag === 'antiadminSilent') {
    if (saved[flag]) {
      patch.alert_dest = 'silent';
      patch.alert_enabled = 0;
      await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, 'antiadminAlert', false);
    } else {
      if (rec.alert_dest === 'silent') patch.alert_dest = 'dm';
      patch.alert_enabled = 1;
      await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, 'antiadminAlert', true);
    }
  }
  if (Object.keys(patch).length) {
    await store.upsert(ctx.from, ctx.telegramUserId, patch);
  }
  const recAfter = await store.load(ctx.from, ctx.telegramUserId);
  const flagsNow = getGroupSecurity(ctx.from, ctx.telegramUserId);
  const live = guard.flagsFromGroup(flagsNow, recAfter);
  if (flag === 'antiadmin') {
    const flagOn = !!flagsNow.antiadmin;
    const sqlOn = !!recAfter.protection_enabled;
    if (flagOn !== sqlOn) {
      logger.logAviso(`[GROUP-SECURITY] persist mismatch flag=${flagOn} sql=${sqlOn}`);
    }
    logger.logInfo(
      `[GROUP-SECURITY] persist protection=${live.protection} flag=${flagOn} sql=${sqlOn}`
    );
  }
  if (fromPanel) return reopenPanel(conn, ctx);
  const p = prefixFromCtx(ctx);
  return send(
    conn,
    ctx,
    [
      `${label}: ${saved[flag] ? 'ON' : 'OFF'}`,
      `Persistido: protecao ${live.protection ? 'ON' : 'OFF'} | x9 ${live.audit ? 'ON' : 'OFF'} | revert ${live.revert ? 'ON' : 'OFF'}`,
      `Status: ${p}antiadmin`
    ].join('\n')
  );
}

commands.antiadmin = {
  useCtx: true,
  description: 'Painel anti-roubo de grupo (X9 + reversao)',
  usage: 'antiadmin [on|off]',
  execute: async (conn, ctx) =>
    toggleNamed(conn, ctx, 'antiadmin', (on) => ({ protection_enabled: on ? 1 : 0 }), 'Protecao anti-admin')
};
commands.antiroubo = commands.antiadmin;

commands.antiadminaudit = {
  useCtx: true,
  description: 'Auditoria X9 de promote/demote',
  usage: 'antiadminaudit on|off',
  execute: async (conn, ctx) =>
    toggleNamed(conn, ctx, 'antiadminAudit', (on) => ({ audit_enabled: on ? 1 : 0 }), 'Auditoria')
};

commands.antiadminrevert = {
  useCtx: true,
  description: 'Reversao automatica de rebaixamento nao autorizado',
  usage: 'antiadminrevert on|off',
  execute: async (conn, ctx) =>
    toggleNamed(conn, ctx, 'antiadminRevert', (on) => ({ revert_enabled: on ? 1 : 0 }), 'Reversao')
};

async function applyAlertDest(conn, ctx, dest, { fromPanel = false } = {}) {
  if (dest === 'silent') {
    await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, 'antiadminSilent', true);
    await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, 'antiadminAlert', false);
    await store.upsert(ctx.from, ctx.telegramUserId, { alert_dest: 'silent', alert_enabled: 0 });
    if (fromPanel) return;
    return send(conn, ctx, 'Alertas: so log/SQL (silencioso).');
  }
  await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, 'antiadminSilent', false);
  await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, 'antiadminAlert', true);
  await store.upsert(ctx.from, ctx.telegramUserId, { alert_dest: dest, alert_enabled: 1 });
  if (fromPanel) return;
  return send(conn, ctx, `Alertas: ON — destino ${destLabel(dest)}.`);
}

commands.antiadminalert = {
  useCtx: true,
  description: 'Alertas de seguranca do grupo (on/off ou destino)',
  usage: 'antiadminalert on|off|grupo|pv|ambos|dono',
  execute: async (conn, ctx) => {
    const dest = parseAlertDest(ctx.text);
    if (dest) {
      if (!(await requireManage(conn, ctx))) return;
      const fromPanel = !!ctx.isInteractive;
      await applyAlertDest(conn, ctx, dest, { fromPanel });
      if (fromPanel) return reopenPanel(conn, ctx);
      return;
    }
    return toggleNamed(conn, ctx, 'antiadminAlert', (on) => ({ alert_enabled: on ? 1 : 0 }), 'Alertas');
  }
};

commands.antiadmindest = {
  useCtx: true,
  description: 'Destino do alerta X9: grupo, pv, ambos, dono ou silencioso',
  usage: 'antiadmindest grupo|pv|ambos|dono|silencioso',
  execute: async (conn, ctx) => {
    if (!(await requireManage(conn, ctx))) return;
    const fromPanel = !!ctx.isInteractive;
    const empty = !String(ctx.text || '').trim();
    let dest = parseAlertDest(ctx.text);
    if (!dest && (fromPanel || empty)) {
      const rec = await store.load(ctx.from, ctx.telegramUserId);
      dest = logic.nextPreset(logic.ALERT_DESTS, rec.alert_dest || 'silent');
    }
    if (!dest) {
      return send(conn, ctx, 'Use: antiadmindest grupo | pv | ambos | dono | silencioso');
    }
    await applyAlertDest(conn, ctx, dest, { fromPanel });
    if (fromPanel) return reopenPanel(conn, ctx);
  }
};

commands.antiadminsilent = {
  useCtx: true,
  description: 'Modo silencioso (so log/SQL, sem alerta)',
  usage: 'antiadminsilent on|off',
  execute: async (conn, ctx) =>
    toggleNamed(
      conn,
      ctx,
      'antiadminSilent',
      (on) => (on ? { alert_dest: 'silent', alert_enabled: 0 } : { alert_dest: 'dm', alert_enabled: 1 }),
      'Modo silencioso'
    )
};

commands.antiadmindetect = {
  useCtx: true,
  description: 'Deteccao de rajada/ataque',
  usage: 'antiadmindetect on|off',
  execute: async (conn, ctx) =>
    toggleNamed(conn, ctx, 'antiadminDetect', (on) => ({ attack_detect: on ? 1 : 0 }), 'Deteccao de ataque')
};

commands.antiadminlimite = {
  useCtx: true,
  description: 'Limite de acoes na janela (ataque)',
  usage: 'antiadminlimite <n>',
  execute: async (conn, ctx) => {
    if (!(await requireManage(conn, ctx))) return;
    const fromPanel = !!ctx.isInteractive;
    const raw = String(ctx.text || '').trim();
    const n = parseInt(raw, 10);
    let next;
    if (Number.isFinite(n) && n >= 2 && n <= 50) {
      next = n;
    } else if (fromPanel || !raw) {
      const rec = await store.load(ctx.from, ctx.telegramUserId);
      next = logic.nextPreset(
        logic.THRESHOLD_PRESETS,
        Number(rec.threshold),
        (a, b) => Number(a) === Number(b)
      );
    } else {
      return send(conn, ctx, 'Use um numero de 2 a 50. Ex: antiadminlimite 5');
    }
    await store.upsert(ctx.from, ctx.telegramUserId, { threshold: next });
    if (fromPanel) return reopenPanel(conn, ctx);
    return send(conn, ctx, `Limite de ataque: ${next} acoes na janela.`);
  }
};

commands.antiadminjanela = {
  useCtx: true,
  description: 'Janela em segundos para detectar ataque',
  usage: 'antiadminjanela <segundos>',
  execute: async (conn, ctx) => {
    if (!(await requireManage(conn, ctx))) return;
    const fromPanel = !!ctx.isInteractive;
    const raw = String(ctx.text || '').trim();
    const n = parseInt(raw, 10);
    let next;
    if (Number.isFinite(n) && n >= 3 && n <= 120) {
      next = n;
    } else if (fromPanel || !raw) {
      const rec = await store.load(ctx.from, ctx.telegramUserId);
      const curS = Math.max(1, Math.round(Number(rec.window_ms || logic.DEFAULT_WINDOW_MS) / 1000));
      next = logic.nextPreset(
        logic.WINDOW_PRESETS_S,
        curS,
        (a, b) => Number(a) === Number(b)
      );
    } else {
      return send(conn, ctx, 'Use 3 a 120 segundos. Ex: antiadminjanela 10');
    }
    await store.upsert(ctx.from, ctx.telegramUserId, { window_ms: next * 1000 });
    if (fromPanel) return reopenPanel(conn, ctx);
    return send(conn, ctx, `Janela de ataque: ${next}s.`);
  }
};

commands.donogrupo = {
  useCtx: true,
  description: 'Mostra dono nativo/registrado e protecao',
  usage: 'donogrupo [@user]',
  execute: async (conn, ctx) => {
    if (!ctx.isGroup) return send(conn, ctx, 'Use dentro do grupo.');
    if (!ctx.isInteractive) {
      const target = await resolveTargetJid(ctx, conn);
      if (ctx._hanorkTargetImmune) return;
      if (target) {
        if (!(await requireManage(conn, ctx, { transfer: true }))) return;
        return transferOwner(conn, ctx, target);
      }
    }
    const st = await buildStatus(conn, ctx);
    return send(conn, ctx, st.text, st.mentions);
  }
};

async function transferOwner(conn, ctx, newOwner) {
  const rec = await store.load(ctx.from, ctx.telegramUserId);
  const prev = rec.registered_owner_jid || '';
  const saved = persistablePersonJid(newOwner, ctx);
  if (prev && (sameParticipant(prev, saved) || guard.idsMatch(prev, saved))) {
    return send(conn, ctx, 'Esse ja e o owner registrado.');
  }
  try {
    const { rememberLidPhonePair } = require('../utils');
    rememberLidPhonePair(newOwner, saved);
    rememberLidPhonePair(ctx.sender, preferredPersonJid(ctx));
  } catch (_) { /* cache opcional */ }
  await store.upsert(ctx.from, ctx.telegramUserId, { registered_owner_jid: saved });
  await store.insertTransfer({
    telegramUserId: ctx.telegramUserId,
    group_jid: ctx.from,
    previous_owner: prev,
    new_owner: saved,
    transferred_by: persistablePersonJid(ctx.sender, ctx),
    reason: 'transferirdono'
  });
  await store.insertEvent({
    telegramUserId: ctx.telegramUserId,
    group_jid: ctx.from,
    actor_jid: persistablePersonJid(ctx.sender, ctx),
    target_jid: saved,
    action: 'transfer_owner',
    actor_role: logic.ROLES.REGISTERED_OWNER,
    target_role: logic.ROLES.REGISTERED_OWNER,
    detected: 1,
    reverted: 0,
    reason: 'transfer',
    risk: 0,
    risk_class: 'NORMAL'
  });
  const prevM = guard.mentionTag(prev);
  const newM = guard.mentionTag(saved);
  const byM = guard.mentionTag(preferredPersonJid(ctx) || ctx.sender);
  return send(
    conn,
    ctx,
    [
      'TRANSFERENCIA DE DONO',
      `Anterior: ${prevM.tag}`,
      `Novo: ${newM.tag}`,
      `Quem transferiu: ${byM.tag}`,
      'O numero registrado passa a ser dono DESTE grupo.',
      'Os donos do bot continuam donos neste e em todos os grupos (independente).'
    ].join('\n'),
    [prevM.jid, newM.jid, byM.jid].filter(Boolean)
  );
}

commands.transferirdono = {
  useCtx: true,
  description: 'Transfere o owner registrado do grupo',
  usage: 'transferirdono @user',
  execute: async (conn, ctx) => {
    if (!(await requireManage(conn, ctx, { transfer: true }))) return;
    const target = await resolveTargetJid(ctx, conn);
    if (!target) return send(conn, ctx, targetHowTo(ctx, 'transferirdono'));
    return transferOwner(conn, ctx, target);
  }
};

commands.addgpowner = {
  useCtx: true,
  description: 'Adiciona owner confiavel do grupo',
  usage: 'addgpowner @user',
  execute: async (conn, ctx) => {
    if (!(await requireManage(conn, ctx, { transfer: true }))) return;
    const target = await resolveTargetJid(ctx, conn);
    if (!target) return send(conn, ctx, targetHowTo(ctx, 'addgpowner'));
    const rec = await store.load(ctx.from, ctx.telegramUserId);
    if (rec.registered_owner_jid && sameParticipant(rec.registered_owner_jid, target)) {
      return send(conn, ctx, 'Esse ja e o owner principal.');
    }
    const saved = persistablePersonJid(target, ctx);
    const ok = await store.addTrusted(ctx.from, ctx.telegramUserId, saved, 'OWNER_TRUSTED', persistablePersonJid(ctx.sender, ctx));
    const m = guard.mentionTag(saved);
    return send(conn, ctx, ok ? `Owner confiavel adicionado: ${m.tag}` : `Ja estava na lista: ${m.tag}`, [m.jid].filter(Boolean));
  }
};

commands.removegpowner = {
  useCtx: true,
  description: 'Remove owner confiavel do grupo',
  usage: 'removegpowner @user',
  execute: async (conn, ctx) => {
    if (!(await requireManage(conn, ctx, { transfer: true }))) return;
    const target = await resolveTargetJid(ctx, conn);
    if (!target) return send(conn, ctx, targetHowTo(ctx, 'removegpowner'));
    const saved = persistablePersonJid(target, ctx);
    const ok = await store.removeTrusted(ctx.from, ctx.telegramUserId, saved) ||
      await store.removeTrusted(ctx.from, ctx.telegramUserId, target);
    const m = guard.mentionTag(saved || target);
    return send(conn, ctx, ok ? `Removido da lista confiavel: ${m.tag}` : `Nao estava na lista: ${m.tag}`, [m.jid].filter(Boolean));
  }
};

commands.listgpowner = {
  useCtx: true,
  description: 'Lista owners confiaveis do grupo',
  usage: 'listgpowner',
  execute: async (conn, ctx) => {
    if (!ctx.isGroup) return send(conn, ctx, 'Use dentro do grupo.');
    const st = await buildStatus(conn, ctx);
    return send(conn, ctx, st.text, st.mentions);
  }
};

commands.historicoadmin = {
  useCtx: true,
  description: 'Historico paginado de alteracoes admin',
  usage: 'historicoadmin [pagina]',
  execute: async (conn, ctx) => {
    if (!ctx.isGroup) return send(conn, ctx, 'Use dentro do grupo.');
    const role = await senderRole(conn, ctx);
    if (!logic.isTrustedAuthority(role)) {
      const extra = collectMessageSenderIds(ctx.info, [ctx.senderAlt, ctx.sender]);
      const adminOk = await isGroupAdminStrict(conn, ctx.from, ctx.sender, extra);
      if (!adminOk) {
        return send(conn, ctx, 'So dono/confiavel/admin ve o historico.');
      }
    }
    const page = Math.max(1, parseInt(String(ctx.text || '').trim(), 10) || 1);
    const { rows, total, pageSize } = await store.listEvents(ctx.from, ctx.telegramUserId, { page, pageSize: 8 });
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (!rows.length) {
      return send(conn, ctx, 'Nenhum evento de admin neste grupo ainda.');
    }
    const lines = [
      `HISTORICO ADMIN (${page}/${pages}) — ${total} evento(s)`,
      ''
    ];
    const mentions = [];
    for (const r of rows) {
      const when = String(r.created_at || '').replace('T', ' ').slice(0, 19);
      const actorM = guard.mentionTag(r.actor_jid);
      const targetM = guard.mentionTag(r.target_jid);
      if (actorM.jid) mentions.push(actorM.jid);
      if (targetM.jid) mentions.push(targetM.jid);
      lines.push(
        `${when} ${String(r.action || '').toUpperCase()} ` +
        `${r.actor_role || '?'} -> ${r.target_role || '?'} ` +
        `${r.reverted ? 'REVERTIDO' : (r.detected ? r.risk_class || '' : 'ok')}`
      );
      lines.push(`Autor ${actorM.tag} | Alvo ${targetM.tag} | ${r.reason || '-'}`);
      lines.push('');
    }
    const p = prefixFromCtx(ctx);
    if (page < pages) lines.push(`Proxima: ${p}historicoadmin ${page + 1}`);
    return send(conn, ctx, lines.join('\n').trim(), mentions);
  }
};

commands.gpowner = commands.donogrupo;
commands.adddonogp = commands.addgpowner;
commands.add_perm = commands.addgpowner;
commands.add_dono_gp = commands.addgpowner;
commands.removedonogp = commands.removegpowner;

commands.antiroubodiag = {
  useCtx: true,
  description: 'Diagnostico anti-roubo (metricas + como testar)',
  usage: 'antiroubodiag',
  execute: async (conn, ctx) => {
    if (!ctx.isGroup) {
      return conn.sendMessage(ctx.from, { text: 'Use no grupo (bot admin).' }, { quoted: ctx.info });
    }
    const flags = getGroupSecurity(ctx.from, ctx.telegramUserId);
    let rec = {};
    try {
      rec = (await store.load(ctx.from, ctx.telegramUserId)) || {};
    } catch (_) { /* ignore */ }
    const gf = guard.flagsFromGroup ? guard.flagsFromGroup(flags, rec) : {};
    let snap = {};
    try {
      snap = require('../utils/opsMetrics').snapshot();
    } catch (_) { /* ignore */ }
    const p = prefixFromCtx(ctx);
    const text =
      `ANTI-ROUBO DIAG\n` +
      `antiadmin=${flags.antiadmin ? 'ON' : 'OFF'} revertFlag=${flags.antiadminRevert ? 'ON' : 'OFF'}\n` +
      `SQL prot=${rec.protection_enabled ? 1 : 0} revert=${rec.revert_enabled == null ? 1 : Number(rec.revert_enabled)}\n` +
      `efetivo prot=${gf.protection ? 1 : 0} revert=${gf.revert ? 1 : 0}\n` +
      `Hoje APPLY=${snap.antirouboApply || 0} gpuOk=${snap.antirouboGpuOk || 0} gpuFail=${snap.antirouboGpuFail || 0}\n\n` +
      `Teste live: bot ADMIN, antiadmin ON, admin COMUM demote outro admin.\n` +
      `Log esperado: pol=APPLY revert=1 + gpu ok\n` +
      `Preset: ${p}presetprotecao loja`;
    return conn.sendMessage(ctx.from, { text }, { quoted: ctx.info });
  }
};
commands.antiroubostatus = commands.antiroubodiag;

module.exports = { commands };
