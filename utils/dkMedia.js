'use strict';
/**
 * Download de midia so pro modulo DK (Baileys). Sem divulgacao.
 */
const logger = require('../logger');

function unwrap(msg) {
  let m = msg;
  if (!m || typeof m !== 'object') return m;
  if (m.message && !m.imageMessage && !m.videoMessage) m = m.message;
  for (let i = 0; i < 6; i += 1) {
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m;
}

function kindOf(inner) {
  if (!inner || typeof inner !== 'object') return null;
  if (inner.imageMessage) return 'image';
  if (inner.videoMessage) return inner.videoMessage.gifPlayback ? 'gif' : 'video';
  return null;
}

function nodeOf(inner) {
  if (!inner || typeof inner !== 'object') return {};
  return inner.imageMessage || inner.videoMessage || {};
}

async function captureDkMedia(ctx, want) {
  const wantKind = String(want || 'image');
  const direct = unwrap(ctx.mediaMessage || ctx.message);
  const quoted = unwrap(ctx.quoted?.message);
  const inner = kindOf(direct) ? direct : quoted;
  const got = kindOf(inner) || (ctx.isImage ? 'image' : ctx.isVideo ? 'video' : ctx.isGif ? 'gif' : null);
  if (!inner || !got) return null;
  if (wantKind === 'image' && got !== 'image') return null;
  if (wantKind === 'video' && got !== 'video' && got !== 'gif') return null;

  let buffer = null;
  if (typeof ctx.downloadMedia === 'function') {
    try { buffer = await ctx.downloadMedia(); } catch (e) {
      logger.logAviso(`[dk] download ctx: ${e.message}`);
    }
  }
  if (!buffer || !buffer.length) {
    try {
      const { downloadMediaMessage } = require('@systemzero/baileys');
      const isQuoted = inner === quoted && quoted;
      const fake = {
        key: {
          remoteJid: ctx.from,
          id: isQuoted
            ? (ctx.quoted?.stanzaId || ctx.quoted?.key?.id || ctx.key?.id)
            : ctx.key?.id,
          fromMe: false,
          participant: isQuoted
            ? (ctx.quoted?.participant || ctx.quoted?.sender || ctx.sender)
            : ctx.sender
        },
        message: inner
      };
      const opts = {};
      if (ctx.conn?.updateMediaMessage) opts.reuploadRequest = ctx.conn.updateMediaMessage.bind(ctx.conn);
      buffer = await downloadMediaMessage(fake, 'buffer', {}, opts);
    } catch (e) {
      logger.logErro('dk-media', e.message);
      return null;
    }
  }
  if (!buffer || !buffer.length) return null;
  const node = nodeOf(inner);
  return {
    buffer,
    tipo: got === 'gif' ? 'gif' : got,
    mimetype: node.mimetype || (got === 'image' ? 'image/jpeg' : 'video/mp4')
  };
}

module.exports = { captureDkMedia };
