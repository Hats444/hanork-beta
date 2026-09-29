'use strict';
/**
 * Directed / "invisivel" group relay — tecnica ValleyInvisible + participant.
 *
 * Fonte Baileys (@systemzero/baileys MessageRelayOptions):
 *   participant?: { jid: string; count: number }
 *   → "only send to a specific participant"
 *
 * Mecanismos:
 * 1) Valley: espera msg do alvo → captura messageId → relay com mesmo ID + participant
 * 2) Status/grupo dirigido: generateWAMessage + relayMessage(group, msg, { participant })
 *
 * LIMITES REAIS:
 * - Envelope endereca o GRUPO, mas com participant:{jid} so o alvo recebe.
 * - Sem targetJid = fan-out (todos veem) — evitar na divulgacao.
 * - Valley texto only; status dirigido pode ter midia via generateWAMessage.
 */
const logger = require('../logger');

/** Arms ativos: key = `${group}:${sortedTargets}` */
const active = new Map();

const LIMITS = Object.freeze({
  technique: 'messageId_hijack_or_participant',
  media: 'status_directed_yes_valley_text_no',
  adminBlind: true,
  envelope: 'group_directed_participant',
  multiShot: 'one_relay_per_target'
});

/**
 * Entrega qualquer protobuf de grupo SO para um participante.
 * Doc: MessageRelayOptions.participant — only send to a specific participant.
 * Mantem @lid/@s.whatsapp.net do meta (nao forca PN — grupo LID quebra se converter).
 */
async function relayDirectedToParticipant(conn, { groupJid, message, targetJid, messageId } = {}) {
  const group = String(groupJid || '');
  let target = String(targetJid || '').trim();
  if (target.includes(':') && target.includes('@')) {
    const [user, server] = target.split('@');
    target = `${String(user).split(':')[0]}@${server}`;
  }
  if (!group.endsWith('@g.us')) return { ok: false, reason: 'group_invalid' };
  if (!target || (!target.includes('@lid') && !target.includes('@s.whatsapp.net') && !target.includes('@c.us'))) {
    return { ok: false, reason: 'target_invalid' };
  }
  if (!message || typeof message !== 'object') return { ok: false, reason: 'message_missing' };
  if (!conn || typeof conn.relayMessage !== 'function') return { ok: false, reason: 'no_relay' };

  try {
    const id = String(messageId || '').trim() || undefined;
    await conn.relayMessage(group, message, {
      ...(id ? { messageId: id } : {}),
      participant: { jid: target, count: 0 },
      _hanorkTrusted: true
    });
    logger.logInfo(
      `[dirigido] ok group=${group} target=${target.split('@')[0].replace(/\d(?=\d{4})/g, '*')}`
    );
    return { ok: true, target, messageId: id || null };
  } catch (e) {
    const reason = String(e && e.message ? e.message : e);
    logger.logAviso(`[dirigido] fail: ${reason}`);
    return { ok: false, reason };
  }
}

function normalizeUserJid(jid) {
  let s = String(jid || '').trim();
  if (!s) return null;
  if (s.includes('@lid')) {
    try {
      const { getPhoneForLid } = require('../utils');
      const phone = getPhoneForLid(s);
      if (phone) {
        const d = String(phone).replace(/\D/g, '');
        if (d.length >= 8) return `${d}@s.whatsapp.net`;
      }
    } catch (_) { /* ignore */ }
    const dig = s.split('@')[0].replace(/\D/g, '');
    if (dig.length >= 8) return `${dig}@s.whatsapp.net`;
    return s;
  }
  if (!s.includes('@')) {
    const dig = s.replace(/\D/g, '');
    if (dig.length < 8) return null;
    return `${dig}@s.whatsapp.net`;
  }
  const [user, server] = s.split('@');
  const base = String(user || '').split(':')[0];
  return `${base}@${server}`;
}

function sameUser(a, b) {
  const na = normalizeUserJid(a);
  const nb = normalizeUserJid(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const da = na.split('@')[0].replace(/\D/g, '');
  const db = nb.split('@')[0].replace(/\D/g, '');
  return !!(da && db && da === db);
}

function parseTargetList(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  if (/^(todos|all|everyone|\*)$/i.test(s)) return ['__ALL__'];
  return s
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => normalizeUserJid(p))
    .filter(Boolean);
}

/**
 * Relay puro — espelho de Valley executeAttack.
 * NAO usa safeRelay (ele gera messageId novo).
 *
 * Com targetJid: entrega SO pra esse participante (Baileys participant:{jid}),
 * sem fan-out pro resto do grupo (evita msg flutuando pra todos).
 */
async function sendInvisibleMessage(conn, { groupJid, messageId, text, targetJid, mentions } = {}) {
  const group = String(groupJid || '');
  const id = String(messageId || '').trim();
  const body = String(text || '').trim() || 'hanork';
  const target = normalizeUserJid(targetJid);
  const mentionedJid = [...new Set((mentions || []).filter(Boolean))];

  if (!group.endsWith('@g.us')) {
    return { ok: false, reason: 'group_invalid' };
  }
  if (!id) return { ok: false, reason: 'message_id_missing' };
  if (!conn || typeof conn.relayMessage !== 'function') {
    return { ok: false, reason: 'no_relay' };
  }

  try {
    const opts = {
      messageId: id,
      _hanorkTrusted: true
    };
    // Dirige o stanza so ao alvo capturado — demais membros nao recebem
    if (target) {
      opts.participant = { jid: target, count: 0 };
    }
    const proto = {
      extendedTextMessage: {
        text: body,
        ...(mentionedJid.length ? { contextInfo: { mentionedJid } } : {})
      }
    };
    await conn.relayMessage(group, proto, opts);
    // Log sem conteudo da mensagem (futuro item 22)
    logger.logInfo(
      `[invisivel] relay ok group=${group} id=${id.slice(0, 12)}…` +
      (target ? ` target=${target.split('@')[0].replace(/\d(?=\d{4})/g, '*')}` : ' (broadcast)')
    );
    return { ok: true, messageId: id, target: target || null };
  } catch (e) {
    const reason = String(e && e.message ? e.message : e);
    logger.logAviso(`[invisivel] relay fail: ${reason}`);
    return { ok: false, reason };
  }
}

/** Alias semantico */
const relayDirectedGroupText = sendInvisibleMessage;

/**
 * Se a mensagem citada ja e do alvo → relay imediato (mesmo mecanismo).
 */
async function tryRelayFromQuoted(conn, { groupJid, quotedKey, targetJids, text } = {}) {
  if (!quotedKey?.id) return { ok: false, reason: 'no_quote' };
  const participant =
    quotedKey.participantAlt ||
    quotedKey.participant ||
    null;
  if (!participant) return { ok: false, reason: 'quote_no_participant' };

  const targets = (targetJids || []).filter((t) => t && t !== '__ALL__');
  if (targets.length && !targets.some((t) => sameUser(t, participant))) {
    return { ok: false, reason: 'quote_not_target' };
  }

  return sendInvisibleMessage(conn, {
    groupJid,
    messageId: quotedKey.id,
    text,
    targetJid: participant
  });
}

async function resolveAudienceJids(conn, groupJid, targets, { excludeAdmins = false } = {}) {
  const list = Array.isArray(targets) ? targets.slice() : [];
  if (!list.includes('__ALL__')) {
    return [...new Set(list.map(normalizeUserJid).filter(Boolean))];
  }

  if (!conn || typeof conn.groupMetadata !== 'function') {
    return [];
  }
  try {
    const { getCachedGroupMetadata } = require('./groupMetaCache');
    const meta = await getCachedGroupMetadata(conn, groupJid);
    const botId = conn.user?.id || conn.user?.jid || '';
    const out = [];
    for (const p of meta.participants || []) {
      const id = normalizeUserJid(p.phoneNumber || p.id || p.jid);
      if (!id) continue;
      if (botId && sameUser(id, botId)) continue;
      if (excludeAdmins && (p.admin === 'admin' || p.admin === 'superadmin')) continue;
      out.push(id);
    }
    return [...new Set(out)];
  } catch (e) {
    logger.logAviso(`[invisivel] groupMetadata fail: ${e && e.message ? e.message : e}`);
    return [];
  }
}

/**
 * Arma monitoracao Valley-style para 1..N alvos.
 * Cada alvo: 1 relay quando mandar a proxima msg (ou imediato se quoted).
 *
 * @returns {{ key, cancel, promise }}
 */
function armInvisibleAudience(conn, {
  groupJid,
  targets,
  text,
  timeoutMs = 180000,
  excludeAdmins = false,
  onHit = null
} = {}) {
  const group = String(groupJid || '');
  const body = String(text || '').trim() || 'hanork';

  if (!group.endsWith('@g.us')) {
    return {
      key: '',
      cancel: () => {},
      promise: Promise.resolve({ ok: false, reason: 'group_invalid', hits: [] })
    };
  }
  if (!conn || typeof conn.relayMessage !== 'function') {
    return {
      key: '',
      cancel: () => {},
      promise: Promise.resolve({ ok: false, reason: 'no_relay', hits: [] })
    };
  }

  const key = `${group}:${Date.now()}`;
  let settled = false;
  let timer = null;
  let listener = null;
  const pending = new Set();
  const hits = [];

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (listener && conn.ev && typeof conn.ev.off === 'function') {
      try { conn.ev.off('messages.upsert', listener); } catch (_) { /* ignore */ }
    }
    active.delete(key);
  };

  const promise = (async () => {
    const audience = await resolveAudienceJids(conn, group, targets, { excludeAdmins });
    if (!audience.length) {
      return { ok: false, reason: 'no_targets', hits: [] };
    }
    for (const j of audience) pending.add(j);

    return new Promise((resolve) => {
      const finish = (extra = {}) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          ok: hits.length > 0,
          reason: hits.length ? undefined : (extra.reason || 'timeout'),
          hits: hits.slice(),
          pending: [...pending]
        });
      };

      listener = async ({ messages, type }) => {
        if (type && type !== 'notify') return;
        for (const incoming of messages || []) {
          if (!incoming?.key || incoming.key.fromMe) continue;
          if (String(incoming.key.remoteJid) !== group) continue;

          const sender =
            incoming.key.participantAlt ||
            incoming.key.participant ||
            incoming.key.remoteJid;

          let matched = null;
          for (const t of pending) {
            if (sameUser(sender, t)) {
              matched = t;
              break;
            }
          }
          if (!matched) continue;

          const messageId = incoming.key.id;
          if (!messageId) continue;

          pending.delete(matched);
          const result = await sendInvisibleMessage(conn, {
            groupJid: group,
            messageId,
            text: body,
            targetJid: sender || matched
          });
          hits.push({ target: matched, ...result });
          if (typeof onHit === 'function') {
            try { onHit({ target: matched, ...result }); } catch (_) { /* ignore */ }
          }

          if (pending.size === 0) {
            finish();
            return;
          }
        }
      };

      conn.ev.on('messages.upsert', listener);
      timer = setTimeout(() => finish({ reason: 'timeout' }), Math.max(5000, timeoutMs));
    });
  })();

  const entry = {
    cancel: () => {
      if (settled) return;
      settled = true;
      cleanup();
    },
    promise
  };
  active.set(key, entry);
  return { key, cancel: entry.cancel, promise };
}

/** Compat: 1 alvo (API antiga) */
function armDirectedGroupText(conn, opts = {}) {
  const targetJid = opts.targetJid;
  return armInvisibleAudience(conn, {
    ...opts,
    targets: targetJid ? [targetJid] : []
  });
}

module.exports = {
  LIMITS,
  normalizeUserJid,
  sameUser,
  parseTargetList,
  sendInvisibleMessage,
  relayDirectedGroupText,
  relayDirectedToParticipant,
  tryRelayFromQuoted,
  resolveAudienceJids,
  armInvisibleAudience,
  armDirectedGroupText
};
