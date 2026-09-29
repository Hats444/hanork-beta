// utils/antiDelete.js — recupera msg apagada (estilo Duda antidelete)
// Quote fake do remetente original. Figurinha sem midia: so @mencao. Sem PII no log.
'use strict';

const crypto = require('crypto');
const logger = require('../logger');
const { ensureJidString } = require('../utils');
const { unwrapWaMessage, extractText } = require('../contextParser');

const STORE = new Map(); // key -> { at, groupId, participant, participantAlt, fromMe, payload }
const BOT_DELETED = new Map(); // msgId -> ts
const RECOVERED = new Map();
const MAX_KEYS = 800;
const TTL_MS = 12 * 60 * 1000;
const BOT_DEL_MS = 25_000;
const RECOVER_DEDUP_MS = 15_000;

function storeKey(sessionId, id) {
  return `${String(sessionId || '')}:${String(id || '')}`;
}

function prune(now = Date.now()) {
  if (STORE.size <= MAX_KEYS) {
    for (const [k, v] of STORE) {
      if (!v || now - v.at > TTL_MS) STORE.delete(k);
    }
    return;
  }
  const entries = [...STORE.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  const drop = Math.max(0, entries.length - Math.floor(MAX_KEYS * 0.7));
  for (let i = 0; i < drop; i++) STORE.delete(entries[i][0]);
}

function senderInfo(participant, participantAlt) {
  const { mentionTag } = require('./groupTheftGuard');
  const a = ensureJidString(participant, '');
  const b = ensureJidString(participantAlt, '');
  const mentions = [];
  const tags = [];
  for (const j of [b, a]) {
    if (!j) continue;
    const m = mentionTag(j);
    if (m.jid && !mentions.includes(m.jid)) mentions.push(m.jid);
    if (m.tag && m.tag !== '-' && !tags.includes(m.tag)) tags.push(m.tag);
  }
  return {
    participant: a || b,
    participantAlt: b && b !== a ? b : '',
    tag: tags[0] || 'alguem',
    mentions
  };
}

function detectKind(message) {
  const m = unwrapWaMessage(message) || message || {};
  if (m.stickerMessage || m.lottieStickerMessage) return 'sticker';
  if (m.imageMessage) return 'image';
  if (m.videoMessage || m.ptvMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.documentMessage) return 'document';
  return '';
}

function stubLabel(kind, text) {
  if (kind === 'sticker') return 'figurinha apagada';
  if (kind === 'image') return 'foto apagada';
  if (kind === 'video') return 'video apagado';
  if (kind === 'audio') return 'audio apagado';
  if (kind === 'document') return 'arquivo apagado';
  const t = String(text || '').trim();
  if (t) return t.slice(0, 80);
  return 'mensagem apagada';
}

function buildFakeQuoted(groupId, sender, stubText) {
  const mentioned = ensureJidString(sender.participant, sender.participant);
  const quoted = {
    key: {
      fromMe: false,
      remoteJid: groupId,
      participant: mentioned,
      id: 'BAE5' + crypto.randomBytes(13).toString('hex').toUpperCase()
    },
    message: { conversation: String(stubText || 'mensagem apagada') }
  };
  if (sender.participantAlt) {
    quoted.key.participantAlt = ensureJidString(sender.participantAlt, sender.participantAlt);
  }
  return quoted;
}

function pruneMaps(now = Date.now()) {
  for (const [k, ts] of BOT_DELETED) {
    if (now - ts > BOT_DEL_MS) BOT_DELETED.delete(k);
  }
  for (const [k, ts] of RECOVERED) {
    if (now - ts > RECOVER_DEDUP_MS) RECOVERED.delete(k);
  }
}

function noteBotDeleted(messageId) {
  const id = String(messageId || '');
  if (!id) return;
  BOT_DELETED.set(id, Date.now());
}

function samePerson(a, b) {
  try {
    return require('./groupTheftLogic').sameId(a, b);
  } catch (_) {
    const x = String(a || '');
    const y = String(b || '');
    return !!x && x === y;
  }
}

function isProtocolStub(message) {
  const inner = unwrapWaMessage(message) || message || {};
  if (!inner.protocolMessage) return false;
  const hasBody = !!(
    inner.conversation ||
    inner.extendedTextMessage ||
    inner.imageMessage ||
    inner.videoMessage ||
    inner.stickerMessage ||
    inner.audioMessage ||
    inner.documentMessage
  );
  return !hasBody;
}

function sendOpts(quoted) {
  return { quoted, _hanorkTrusted: true, skipForward: true };
}

function rememberMessage(sessionId, info) {
  try {
    const id = info?.key?.id;
    const groupId = String(info?.key?.remoteJid || '');
    if (!sessionId || !id || !groupId.endsWith('@g.us')) return;
    if (!info.message || isProtocolStub(info.message)) return;
    prune();
    pruneMaps();
    const key = info.key || {};
    STORE.set(storeKey(sessionId, id), {
      at: Date.now(),
      groupId,
      fromMe: !!key.fromMe,
      participant: key.participant || key.participantAlt || '',
      participantAlt: key.participantAlt || key.participantPn || '',
      payload: {
        key,
        message: info.message
      }
    });
  } catch (_) { /* ignore */ }
}

function isRevokeUpdate(entry) {
  const stub = Number(entry?.update?.messageStubType ?? entry?.messageStubType);
  if (stub === 1 || stub === 132) return true;
  const proto =
    entry?.update?.message?.protocolMessage ||
    entry?.message?.protocolMessage;
  const t = proto?.type;
  return t === 0 || t === 'REVOKE' || t === 132 || String(t).toUpperCase() === 'REVOKE' ||
    String(t).toUpperCase() === 'ADMIN_REVOKE';
}

function revokeTargetKey(entry) {
  const proto =
    entry?.update?.message?.protocolMessage ||
    entry?.message?.protocolMessage;
  const orig = proto && proto.key ? proto.key : null;
  const key = { ...(entry.key || {}) };
  if (orig && orig.id) key.id = orig.id;
  if (orig && orig.participant) key.author = orig.participant;
  return key;
}

function looksLikeCommandText(text) {
  const t = String(text || '').trim();
  return /^[.$\/!#][a-zA-Z]/.test(t) || /^(del|d|deletar|cita)\b/i.test(t);
}

function lookupStored(sessionId, id, key) {
  const k = storeKey(sessionId, id);
  const stored = STORE.get(k);
  STORE.delete(k);
  if (stored?.payload?.message) return stored;
  try {
    const { getCache } = require('../cache');
    const cached = getCache(sessionId).get(String(id));
    if (cached?.message) {
      return {
        payload: { key: cached.key || key, message: cached.message },
        fromMe: !!cached.key?.fromMe,
        participant: cached.key?.participant || key.participant || '',
        participantAlt: cached.key?.participantAlt || key.participantAlt || ''
      };
    }
  } catch (_) { /* cache opcional */ }
  return null;
}

async function downloadStored(conn, stored) {
  const { downloadMediaMessage } = require('@systemzero/baileys');
  const fakeMsg = {
    key: stored.payload.key,
    message: stored.payload.message
  };
  const opts = {};
  if (conn?.updateMediaMessage) {
    opts.reuploadRequest = conn.updateMediaMessage.bind(conn);
  }
  const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, opts);
  if (!buf || !buf.length) throw new Error('download vazio');
  return buf;
}

function mediaContent(raw, kind, buf) {
  if (kind === 'sticker') {
    const s = raw.stickerMessage || raw.lottieStickerMessage || {};
    return {
      sticker: buf,
      isAnimated: !!s.isAnimated,
      isAvatar: !!s.isAvatar
    };
  }
  if (kind === 'image') {
    return {
      image: buf,
      caption: raw.imageMessage?.caption || '',
      mimetype: raw.imageMessage?.mimetype || 'image/jpeg'
    };
  }
  if (kind === 'video') {
    const vid = raw.videoMessage || raw.ptvMessage || {};
    return {
      video: buf,
      caption: vid.caption || '',
      mimetype: vid.mimetype || 'video/mp4',
      gifPlayback: !!vid.gifPlayback,
      ptv: !!(raw.ptvMessage || vid.ptv)
    };
  }
  if (kind === 'audio') {
    return {
      audio: buf,
      mimetype: raw.audioMessage?.mimetype || 'audio/ogg; codecs=opus',
      ptt: !!raw.audioMessage?.ptt
    };
  }
  if (kind === 'document') {
    const d = raw.documentMessage || {};
    return {
      document: buf,
      mimetype: d.mimetype || 'application/octet-stream',
      fileName: d.fileName || 'arquivo',
      caption: d.caption || ''
    };
  }
  throw new Error('nao midia');
}

async function sendStickerFallback(conn, groupId, sender, opts) {
  const mentions = sender.mentions || [];
  await conn.sendMessage(groupId, {
    text: `Figurinha apagada de ${sender.tag}`,
    mentions
  }, opts);
}

async function recoverDeleted(conn, groupId, stored, sender) {
  const msg = stored.payload.message;
  const raw = unwrapWaMessage(msg) || msg;
  const kind = detectKind(msg);
  const text = extractText(msg);
  const quoted = buildFakeQuoted(groupId, sender, stubLabel(kind, text));
  const opts = sendOpts(quoted);
  const mentions = sender.mentions || [];

  if (kind === 'sticker') {
    try {
      const buf = await downloadStored(conn, stored);
      await conn.sendMessage(groupId, mediaContent(raw, 'sticker', buf), opts);
      return 'sticker';
    } catch (_) {
      await sendStickerFallback(conn, groupId, sender, opts);
      return 'sticker_fallback';
    }
  }

  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'document') {
    try {
      const buf = await downloadStored(conn, stored);
      await conn.sendMessage(groupId, mediaContent(raw, kind, buf), opts);
      return kind;
    } catch (_) {
      await conn.sendMessage(groupId, {
        text: text
          ? String(text).slice(0, 800)
          : `Mensagem apagada de ${sender.tag}`,
        mentions
      }, opts);
      return `${kind}_text`;
    }
  }

  const body = String(text || '').trim();
  if (body) {
    await conn.sendMessage(groupId, { text: body.slice(0, 4000) }, opts);
    return 'text';
  }

  await conn.sendMessage(groupId, {
    text: `Mensagem apagada de ${sender.tag}`,
    mentions
  }, opts);
  return 'mention';
}

async function processRevokeUpdates(conn, updates, telegramUserId, sessionId) {
  if (!conn || !Array.isArray(updates) || !updates.length) return;
  const { getGroupSecurity } = require('./moderation');

  for (const entry of updates) {
    if (!isRevokeUpdate(entry)) continue;
    const key = revokeTargetKey(entry);
    const groupId = String(key.remoteJid || (entry.key && entry.key.remoteJid) || '');
    const id = String(key.id || '');
    if (!groupId.endsWith('@g.us') || !id) continue;

    pruneMaps();
    if (BOT_DELETED.has(id)) {
      logger.logInfo('[antidelete] skip bot_delete');
      continue;
    }

    const flags = getGroupSecurity(groupId, telegramUserId);
    if (!flags.antidelete) {
      logger.logInfo('[antidelete] skip flag_off');
      continue;
    }

    const recKey = storeKey(sessionId, id);
    const prevRec = RECOVERED.get(recKey);
    if (prevRec && Date.now() - prevRec < RECOVER_DEDUP_MS) continue;
    RECOVERED.set(recKey, Date.now());

    const stored = lookupStored(sessionId, id, key);
    if (!stored?.payload?.message) {
      RECOVERED.delete(recKey);
      logger.logInfo('[antidelete] skip no_store');
      continue;
    }

    const storedFromMe = !!(stored.fromMe || stored.payload.key?.fromMe);
    const revokeFromMe = !!key.fromMe;
    if (revokeFromMe && !storedFromMe) {
      logger.logInfo('[antidelete] skip bot_revoked_other');
      continue;
    }

    const deleter = String(key.participant || key.participantAlt || '');
    const author = String(
      key.author ||
      stored.participant ||
      stored.payload.key?.participant ||
      ''
    );
    if (deleter && author && !samePerson(deleter, author) && !storedFromMe) {
      logger.logInfo('[antidelete] skip other_deleted');
      continue;
    }

    const text = extractText(stored.payload.message);
    if (looksLikeCommandText(text)) continue;

    const sender = senderInfo(
      stored.participant || stored.payload.key?.participant || author || deleter,
      stored.participantAlt || stored.payload.key?.participantAlt || key.participantAlt
    );

    RECOVERED.set(recKey, Date.now());
    try {
      const how = await recoverDeleted(conn, groupId, stored, sender);
      logger.logInfo(`[antidelete] recuperou ${how}`);
    } catch (e) {
      try {
        const quoted = buildFakeQuoted(groupId, sender, 'mensagem apagada');
        const kind = detectKind(stored.payload.message);
        if (kind === 'sticker') {
          await sendStickerFallback(conn, groupId, sender, sendOpts(quoted));
          logger.logInfo('[antidelete] recuperou sticker_fallback');
        } else {
          await conn.sendMessage(groupId, {
            text: `Mensagem apagada de ${sender.tag}`,
            mentions: sender.mentions
          }, sendOpts(quoted));
          logger.logInfo('[antidelete] recuperou mention');
        }
      } catch (e2) {
        RECOVERED.delete(recKey);
        logger.logAviso(`[antidelete] ${e2.message || e.message}`);
      }
    }
  }
}

module.exports = {
  rememberMessage,
  processRevokeUpdates,
  isRevokeUpdate,
  noteBotDeleted,
  revokeTargetKey
};
