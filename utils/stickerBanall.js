'use strict';
/**
 * Banall do dono da sessao:
 *  - reacao 🤠 na msg do alvo
 *  - reply com a figurinha marcada como trigger
 * Admin de grupo NAO dispara. So isFreshSessionOwner.
 */

const logger = require('../logger');
const { unwrapWaMessage } = require('../contextParser');
const fpUtil = require('./stickerFingerprint');
const banned = require('./bannedStickers');

const COWBOY = '🤠';
const COOLDOWN_MS = 8000;
const lastHit = new Map();

function isCowboyEmoji(text) {
  const t = String(text || '').replace(/\uFE0F/g, '').trim();
  return t === COWBOY;
}

function innerMessage(info) {
  return unwrapWaMessage(info?.message) || info?.message || {};
}

function reactionPayload(info) {
  const m = innerMessage(info);
  return m.reactionMessage || null;
}

function cooldownOk(sessionId, target) {
  const k = `${sessionId}:${target}`;
  const now = Date.now();
  const prev = lastHit.get(k) || 0;
  if (now - prev < COOLDOWN_MS) return false;
  lastHit.set(k, now);
  if (lastHit.size > 400) {
    for (const [id, t] of lastHit) {
      if (now - t > 60000) lastHit.delete(id);
    }
  }
  return true;
}

function ownerCtx(conn, info, telegramUserId, sessionId) {
  const remote = String(info?.key?.remoteJid || '');
  const sender = String(
    info?.key?.participant
    || info?.key?.participantAlt
    || conn?.user?.id
    || remote
  );
  return {
    conn,
    info,
    telegramUserId,
    sessionId,
    from: remote,
    sender,
    fromMe: !!info?.key?.fromMe,
    isGroup: remote.endsWith('@g.us'),
    platform: 'whatsapp'
  };
}

function isSessionOwner(conn, info, telegramUserId) {
  try {
    const { isFreshSessionOwner } = require('./authorization');
    return isFreshSessionOwner(ownerCtx(conn, info, telegramUserId));
  } catch (_) {
    return false;
  }
}

function targetFromKey(key) {
  if (!key || key.fromMe) return '';
  return String(
    key.participant
    || key.participantAlt
    || key.participantPn
    || key.remoteJid
    || ''
  );
}

async function runBanAll(conn, ctx, jid, note) {
  const { executeBanAllTarget } = require('../commands/groupsecurity');
  logger.logAviso(
    `[FIGBANALL] dono=${ctx.sender || ctx.fromMe} alvo=${jid} via=${note} chat=${ctx.from}`
  );
  await executeBanAllTarget(conn, ctx, jid);
}

async function handleCowboyReaction(conn, info, telegramUserId, sessionId) {
  const rx = reactionPayload(info);
  if (!rx) return false;
  const emoji = String(rx.text || '');
  if (!emoji) return false;
  if (!isCowboyEmoji(emoji)) return false;
  if (!isSessionOwner(conn, info, telegramUserId)) {
    logger.logAviso('[FIGBANALL] 🤠 ignorado (nao e dono da sessao)');
    return true;
  }
  const reactedKey = rx.key || {};
  const stanzaId = reactedKey.id;
  const looked = fpUtil.lookup(sessionId, stanzaId);
  let target = targetFromKey(reactedKey);
  if (!target && looked) {
    target = looked.fromMe ? '' : (looked.participant || looked.remoteJid);
  }
  if (!target) {
    logger.logAviso('[FIGBANALL] 🤠 sem alvo (msg original nao achada)');
    return true;
  }
  if (!cooldownOk(sessionId, target)) return true;

  if (looked?.fp) {
    banned.addFingerprint(telegramUserId, looked.fp, 'trigger');
    banned.addFingerprint(telegramUserId, looked.fp, 'banned');
  }

  const ctx = ownerCtx(conn, info, telegramUserId, sessionId);
  try {
    await runBanAll(conn, ctx, target, 'react-cowboy');
  } catch (e) {
    logger.logAviso(`[FIGBANALL] react: ${e.message}`);
  }
  return true;
}

async function handleTriggerStickerReply(conn, info, telegramUserId, sessionId) {
  if (!info?.key?.fromMe) return false;
  const fp = fpUtil.fromMessage(info);
  if (!fp) return false;
  if (!banned.isTrigger(telegramUserId, fp)) return false;
  if (!isSessionOwner(conn, info, telegramUserId)) return false;

  const msg = innerMessage(info);
  const ctxInfo = msg.stickerMessage?.contextInfo || {};
  const quotedPart = ctxInfo.participant || ctxInfo.participantAlt || ctxInfo.participantPn || '';
  if (!quotedPart) return false;
  if (!cooldownOk(sessionId, quotedPart)) return true;

  const ctx = ownerCtx(conn, info, telegramUserId, sessionId);
  try {
    await runBanAll(conn, ctx, quotedPart, 'sticker-reply');
  } catch (e) {
    logger.logAviso(`[FIGBANALL] reply: ${e.message}`);
  }
  return true;
}

/**
 * Chamado cedo no messageHandler (antes do skip fromMe).
 * @returns {Promise<boolean>} true = ja tratou, nao segue o pipeline
 */
async function tryOwnerBanallSignals(conn, info, { sessionId, telegramUserId, upsertType }) {
  fpUtil.remember(sessionId, info);
  const live = !upsertType || upsertType === 'notify';
  if (!live) return false;
  if (await handleCowboyReaction(conn, info, telegramUserId, sessionId)) return true;
  if (await handleTriggerStickerReply(conn, info, telegramUserId, sessionId)) return true;
  return false;
}

module.exports = {
  tryOwnerBanallSignals,
  isCowboyEmoji,
  handleCowboyReaction,
  handleTriggerStickerReply
};
