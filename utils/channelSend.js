'use strict';
/**
 * Envio para canal WhatsApp (@newsletter).
 * Baileys: sock.sendMessage(jid@newsletter, { text | image | video }).
 */
const baileys = require('@systemzero/baileys');
const logger = require('../logger');

const downloadFn = baileys.downloadMediaMessage || baileys.downloadMediaMessage;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function inviteCodeFrom(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{16,}$/.test(s) && !s.includes('@')) return s;
  return '';
}

function metaName(meta) {
  if (!meta || typeof meta !== 'object') return '';
  return String(
    (meta.thread_metadata && meta.thread_metadata.name && meta.thread_metadata.name.text) ||
    (meta.thread_metadata && meta.thread_metadata.name) ||
    (meta.name && meta.name.text) ||
    meta.name ||
    meta.subject ||
    ''
  ).trim();
}

function metaJid(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const id = meta.id || meta.jid || (meta.thread_metadata && meta.thread_metadata.id) || '';
  const s = String(id || '');
  if (/@newsletter$/i.test(s)) return s;
  if (/^\d{10,}$/.test(s)) return s + '@newsletter';
  return '';
}

async function resolveJid(conn, input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, reason: 'alvo vazio' };
  if (/^\d{10,}@newsletter$/i.test(raw)) return { ok: true, jid: raw };
  if (/^\d{10,}$/.test(raw)) return { ok: true, jid: raw + '@newsletter' };

  const code = inviteCodeFrom(raw);
  if (code && conn && typeof conn.newsletterMetadata === 'function') {
    try {
      const meta = await conn.newsletterMetadata('invite', code);
      const jid = metaJid(meta);
      if (jid) return { ok: true, jid: jid, invite: code, name: metaName(meta), meta: meta };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || 'invite_fail', invite: code };
    }
    return { ok: false, reason: 'invite sem jid', invite: code };
  }
  if (conn && typeof conn.newsletterMetadata === 'function' && /@newsletter$/i.test(raw)) {
    try {
      const meta = await conn.newsletterMetadata('jid', raw);
      return { ok: true, jid: metaJid(meta) || raw, name: metaName(meta), meta: meta };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || 'meta_fail' };
    }
  }
  return { ok: false, reason: 'jid/link de canal invalido' };
}

async function liveName(conn, jid, fallback) {
  const fb = fallback || '';
  if (!conn || typeof conn.newsletterMetadata !== 'function' || !jid) return fb;
  try {
    const meta = await conn.newsletterMetadata('jid', jid);
    return metaName(meta) || fb;
  } catch (_) {
    return fb;
  }
}

function quotedContext(info) {
  const msg = (info && info.message) || {};
  return (
    (msg.extendedTextMessage && msg.extendedTextMessage.contextInfo) ||
    (msg.imageMessage && msg.imageMessage.contextInfo) ||
    (msg.videoMessage && msg.videoMessage.contextInfo) ||
    (msg.documentMessage && msg.documentMessage.contextInfo) ||
    (msg.buttonsResponseMessage && msg.buttonsResponseMessage.contextInfo) ||
    (msg.listResponseMessage && msg.listResponseMessage.contextInfo) ||
    (msg.templateButtonReplyMessage && msg.templateButtonReplyMessage.contextInfo) ||
    (msg.interactiveResponseMessage && msg.interactiveResponseMessage.contextInfo) ||
    {}
  );
}

function unwrapNode(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const inner =
    (msg.ephemeralMessage && msg.ephemeralMessage.message) ||
    (msg.viewOnceMessage && msg.viewOnceMessage.message) ||
    (msg.viewOnceMessageV2 && msg.viewOnceMessageV2.message) ||
    (msg.viewOnceMessageV2Extension && msg.viewOnceMessageV2Extension.message) ||
    (msg.documentWithCaptionMessage && msg.documentWithCaptionMessage.message) ||
    (msg.editedMessage && msg.editedMessage.message);
  return inner ? unwrapNode(inner) : msg;
}

function quotedEnvelope(info) {
  const cinfo = quotedContext(info);
  const raw = cinfo.quotedMessage || null;
  if (!raw) return null;
  const node = unwrapNode(raw);
  return {
    key: {
      remoteJid: (info.key && info.key.remoteJid) || '',
      id: cinfo.stanzaId || (info.key && info.key.id) || '',
      fromMe: false,
      participant: cinfo.participant || undefined
    },
    message: node,
    contextInfo: cinfo
  };
}

function parseNativeButtons(native) {
  const out = [];
  const buttons = (native && native.buttons) || [];
  for (const b of buttons) {
    let params = {};
    try { params = JSON.parse(b.buttonParamsJson || '{}'); } catch (_) { params = {}; }
    const name = String(b.name || '');
    const label = String(params.display_text || params.title || params.copy_code || '').trim();
    const url = String(params.url || params.merchant_url || '').trim();
    const copy = String(params.copy_code || '').trim();
    if (name === 'cta_url' || url) out.push({ label: label || 'Link', url });
    else if (name === 'cta_copy' || copy) out.push({ label: label || 'PIX', copy });
    else if (label) out.push({ label });
  }
  return out;
}

function flattenMenu(node) {
  if (!node) return null;
  const n = unwrapNode(node);
  if (n.interactiveMessage) {
    const im = n.interactiveMessage;
    const body = String((im.body && im.body.text) || (im.header && im.header.title) || '').trim();
    const footer = String((im.footer && im.footer.text) || '').trim();
    let buttons = parseNativeButtons(im.nativeFlowMessage || im.nativeFlowMessage);
    const cards = (im.carouselMessage && im.carouselMessage.cards) || [];
    for (const card of cards) {
      const cim = card.cardContent && card.cardContent.interactiveMessage;
      if (!cim) continue;
      const cbody = String((cim.body && cim.body.text) || '').trim();
      if (cbody) buttons.push({ label: cbody });
      buttons = buttons.concat(parseNativeButtons(cim.nativeFlowMessage));
    }
    return {
      body,
      footer,
      buttons,
      imageMessage: (im.header && im.header.imageMessage) || null,
      videoMessage: (im.header && im.header.videoMessage) || null,
      jpegThumbnail: (im.header && im.header.jpegThumbnail) || null
    };
  }
  if (n.buttonsMessage) {
    const bm = n.buttonsMessage;
    const buttons = (bm.buttons || []).map((b) => {
      const label = String((b.buttonText && b.buttonText.displayText) || '').trim();
      const url = String((b.urlButton && b.buttonId) || b.url || '').trim();
      return url ? { label, url } : { label };
    }).filter((b) => b.label || b.url);
    return {
      body: String(bm.contentText || bm.hydratedContentText || '').trim(),
      footer: String(bm.footerText || '').trim(),
      buttons,
      imageMessage: bm.imageMessage || null,
      videoMessage: bm.videoMessage || null
    };
  }
  if (n.listMessage) {
    const lm = n.listMessage;
    const rows = [];
    for (const sec of lm.sections || []) {
      for (const r of sec.rows || []) {
        const t = String(r.title || r.rowId || '').trim();
        if (t) rows.push({ label: t });
      }
    }
    return {
      body: [lm.title, lm.description].filter(Boolean).join('\n').trim(),
      footer: String(lm.footerText || '').trim(),
      buttons: rows,
      imageMessage: null,
      videoMessage: null
    };
  }
  if (n.templateMessage && n.templateMessage.hydratedTemplate) {
    const ht = n.templateMessage.hydratedTemplate;
    const buttons = (ht.hydratedButtons || []).map((b) => {
      if (b.urlButton) {
        return { label: String(b.urlButton.displayText || 'Link'), url: String(b.urlButton.url || '') };
      }
      if (b.quickReplyButton) return { label: String(b.quickReplyButton.displayText || '') };
      return null;
    }).filter(Boolean);
    return {
      body: String(ht.hydratedContentText || '').trim(),
      footer: String(ht.hydratedFooterText || '').trim(),
      buttons,
      imageMessage: ht.imageMessage || null,
      videoMessage: ht.videoMessage || null
    };
  }
  return null;
}

function menuToCaption(flat, extraCaption) {
  const chunks = [];
  if (extraCaption) chunks.push(String(extraCaption).trim());
  if (flat.body) chunks.push(flat.body);
  if (flat.footer) chunks.push(flat.footer);
  const urls = (flat.buttons || []).filter((b) => b.url);
  if (urls.length) {
    chunks.push(urls.map((b) => `${b.label || 'Link'}: ${b.url}`).join('\n'));
  }
  const copies = (flat.buttons || []).filter((b) => b.copy);
  if (copies.length) {
    chunks.push(copies.map((b) => `${b.label || 'PIX'}:\n${b.copy}`).join('\n\n'));
  }
  const labels = (flat.buttons || []).filter((b) => b.label && !b.url && !b.copy);
  if (labels.length && !urls.length) {
    chunks.push(labels.map((b) => `• ${b.label}`).join('\n'));
  }
  return chunks.filter(Boolean).join('\n\n').trim();
}

function quotedMsg(info) {
  const env = quotedEnvelope(info);
  return env ? env.message : null;
}

async function downloadNodeMedia(conn, envelope, mediaNode, kind) {
  if (!mediaNode) return null;
  const fake = {
    key: (envelope && envelope.key) || {},
    message: kind === 'video' ? { videoMessage: mediaNode } : { imageMessage: mediaNode }
  };
  const opts = {};
  if (conn && conn.updateMediaMessage) opts.reuploadRequest = conn.updateMediaMessage.bind(conn);
  return downloadFn(fake, 'buffer', {}, opts);
}

async function downloadQuoted(conn, info, ctx) {
  let env = quotedEnvelope(info);
  if (ctx && ctx.quoted && ctx.quoted.message) {
    const node = unwrapNode(ctx.quoted.message);
    if (node && (flattenMenu(node) || node.imageMessage || node.videoMessage || node.conversation || node.extendedTextMessage)) {
      env = {
        key: (env && env.key) || {
          remoteJid: (info.key && info.key.remoteJid) || '',
          id: ctx.quoted.stanzaId || '',
          fromMe: false,
          participant: ctx.quoted.participant || ctx.quoted.sender
        },
        message: node,
        contextInfo: env && env.contextInfo
      };
    }
  }
  if (!env || !env.message) return null;
  const quoted = env.message;
  const type = quoted.imageMessage ? 'image'
    : quoted.videoMessage ? 'video'
    : quoted.stickerMessage ? 'sticker'
    : quoted.documentMessage ? 'document'
    : '';
  if (!type) {
    const menu = flattenMenu(quoted);
    if (menu) {
      let buffer = null;
      let mediaKind = '';
      try {
        if (menu.videoMessage) {
          buffer = await downloadNodeMedia(conn, env, menu.videoMessage, 'video');
          mediaKind = 'video';
        } else if (menu.imageMessage) {
          buffer = await downloadNodeMedia(conn, env, menu.imageMessage, 'image');
          mediaKind = 'image';
        } else if (menu.jpegThumbnail) {
          buffer = Buffer.isBuffer(menu.jpegThumbnail)
            ? menu.jpegThumbnail
            : Buffer.from(menu.jpegThumbnail);
          mediaKind = 'image';
        }
      } catch (e) {
        logger.logAviso(`[channelSend] midia do menu citado: ${e.message}`);
      }
      return {
        type: buffer ? mediaKind : 'menu',
        buffer,
        menu
      };
    }
    return {
      type: 'text',
      text: quoted.conversation || (quoted.extendedTextMessage && quoted.extendedTextMessage.text) || ''
    };
  }
  const opts = {};
  if (conn && conn.updateMediaMessage) opts.reuploadRequest = conn.updateMediaMessage.bind(conn);
  const buf = await downloadFn({ key: env.key, message: quoted }, 'buffer', {}, opts);
  return { type: type, buffer: buf };
}

async function extractPayload(conn, ctx, captionText) {
  const caption = String(captionText || '').trim();
  if (ctx && typeof ctx.downloadMedia === 'function' && (ctx.hasMedia || ctx.isImage || ctx.isVideo)) {
    const buf = await ctx.downloadMedia();
    if (buf) {
      if (ctx.isVideo) return { video: buf, caption: caption };
      return { image: buf, caption: caption };
    }
  }
  if (ctx && ctx.info) {
    let info = ctx.info;
    try {
      const stanzaId = (ctx.quoted && ctx.quoted.stanzaId) || quotedContext(ctx.info).stanzaId;
      if (stanzaId) {
        const { getCache } = require('../cache');
        const sid = ctx.sessionId || (conn && conn._sessionId) || 'default';
        const cached = getCache(sid).get(stanzaId);
        if (cached && cached.message && flattenMenu(unwrapNode(cached.message))) {
          info = { key: cached.key || ctx.info.key, message: { extendedTextMessage: { contextInfo: { stanzaId, quotedMessage: cached.message } } } };
        }
      }
    } catch (_) { /* cache slim — usa o cite */ }
    const q = await downloadQuoted(conn, info, ctx);
    if (q && q.menu) {
      const text = menuToCaption(q.menu, caption);
      if (q.buffer && q.type === 'video') return { video: q.buffer, caption: text };
      if (q.buffer) return { image: q.buffer, caption: text };
      if (text) return { text };
    }
    if (q && q.buffer) {
      if (q.type === 'video') return { video: q.buffer, caption: caption };
      return { image: q.buffer, caption: caption };
    }
    if (q && q.type === 'text' && q.text && !caption) return { text: q.text };
  }
  if (caption) return { text: caption };
  return null;
}

async function postOne(conn, jid, payload) {
  if (!jid || !/@newsletter$/i.test(jid)) throw new Error('jid de canal invalido');
  const opts = { _hanorkTrusted: true };
  if (payload.image) {
    return conn.sendMessage(jid, { image: payload.image, caption: payload.caption || '' }, opts);
  }
  if (payload.video) {
    return conn.sendMessage(jid, { video: payload.video, caption: payload.caption || '' }, opts);
  }
  const text = String(payload.text || '').trim();
  if (!text) throw new Error('sem texto nem midia');
  return conn.sendMessage(jid, { text: text }, opts);
}

async function postMany(conn, jids, payload, delayMs, onEach) {
  const wait = delayMs == null ? 1400 : delayMs;
  const results = [];
  for (let i = 0; i < jids.length; i++) {
    const jid = jids[i];
    try {
      await postOne(conn, jid, payload);
      results.push({ jid: jid, ok: true });
      if (onEach) onEach({ jid: jid, ok: true });
    } catch (e) {
      const reason = String((e && e.message) || e).slice(0, 80);
      logger.logAviso('[channelSend] ' + jid + ': ' + reason);
      results.push({ jid: jid, ok: false, reason: reason });
      if (onEach) onEach({ jid: jid, ok: false, reason: reason });
    }
    if (wait) await sleep(wait);
  }
  return results;
}

const exported = {
  sleep: sleep,
  inviteCodeFrom: inviteCodeFrom,
  metaName: metaName,
  metaJid: metaJid,
  resolveJid: resolveJid,
  liveName: liveName,
  extractPayload: extractPayload,
  postOne: postOne,
  postMany: postMany
};
exported['sleep'] = sleep;
exported['inviteCodeFrom'] = inviteCodeFrom;
exported['metaName'] = metaName;
exported['metaJid'] = metaJid;
exported['resolveJid'] = resolveJid;
exported['liveName'] = liveName;
exported['extractPayload'] = extractPayload;
exported['postOne'] = postOne;
exported['postMany'] = postMany;
exported['resolveJid'] = resolveJid;
exported['extractPayload'] = extractPayload;
exported['postOne'] = postOne;
module.exports = exported;
