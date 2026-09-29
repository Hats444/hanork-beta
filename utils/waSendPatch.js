// utils/waSendPatch.js
// T1 + regra sem-emoji + auth silent + marca IDs enviados (anti-loop P0)
// + SCRUB: nunca vaza erro tecnico pro WhatsApp do cliente

const { stripEmojis } = require('./noEmoji');
const { swallowAuthDenial } = require('./authSilence');
const { rememberBotSentId, rememberBotSentText } = require('./selfMessageGuard');
const { scrubUserFacingText } = require('../core/router/errorHandler');
const logger = require('../logger');
const {
  markWaOverlimit,
  waOverHot,
  clearWaOverlimit
} = require('./waCircuitBreaker');

function isOverlimitErr(err) {
  return /rate-overlimit|overlimit/i.test(String(err?.message || err || ''));
}

function stripChannelStamp(payload) {
  if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload)) return payload;
  const next = { ...payload };
  const scrubCi = (node) => {
    if (!node || typeof node !== 'object' || Buffer.isBuffer(node)) return;
    if (node.contextInfo && typeof node.contextInfo === 'object') {
      const ci = { ...node.contextInfo };
      delete ci.isForwarded;
      delete ci.forwardingScore;
      delete ci.forwardedNewsletterMessageInfo;
      node.contextInfo = Object.keys(ci).length ? ci : undefined;
      if (!node.contextInfo) delete node.contextInfo;
    }
  };
  scrubCi(next);
  for (const [k, v] of Object.entries(next)) {
    if (v && typeof v === 'object' && !Buffer.isBuffer(v) && !Array.isArray(v) && /Message(V\d+)?$/.test(k)) {
      next[k] = { ...v };
      scrubCi(next[k]);
    }
  }
  return next;
}

function canBareRetry(payload, options) {
  if (options && options._hanorkOverRetry) return false;
  if (payload && typeof payload === 'object' && (payload.delete || payload.react)) return false;
  return true;
}

function stripContentEmojis(content) {
  if (!content || typeof content !== 'object') return content;
  const next = { ...content };
  for (const key of ['text', 'caption', 'conversation']) {
    if (typeof next[key] === 'string') next[key] = stripEmojis(next[key]);
  }
  if (next.extendedTextMessage && typeof next.extendedTextMessage.text === 'string') {
    next.extendedTextMessage = {
      ...next.extendedTextMessage,
      text: stripEmojis(next.extendedTextMessage.text)
    };
  }
  if (Array.isArray(next.buttons)) {
    next.buttons = next.buttons.map((b) => {
      if (!b || typeof b !== 'object') return b;
      const btn = { ...b };
      if (typeof btn.buttonText === 'string') btn.buttonText = stripEmojis(btn.buttonText);
      if (btn.buttonText?.displayText) {
        btn.buttonText = { ...btn.buttonText, displayText: stripEmojis(btn.buttonText.displayText) };
      }
      return btn;
    });
  }
  return next;
}

function scrubPayloadErrors(payload, sessionId) {
  if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload)) return payload;
  const next = { ...payload };
  const meta = { sessionId: sessionId || 'na', channel: 'whatsapp' };

  for (const key of ['text', 'caption', 'conversation']) {
    if (typeof next[key] === 'string') {
      next[key] = scrubUserFacingText(next[key], meta);
    }
  }
  if (next.extendedTextMessage && typeof next.extendedTextMessage.text === 'string') {
    next.extendedTextMessage = {
      ...next.extendedTextMessage,
      text: scrubUserFacingText(next.extendedTextMessage.text, meta)
    };
  }
  if (next.interactiveMessage?.body?.text) {
    next.interactiveMessage = {
      ...next.interactiveMessage,
      body: {
        ...next.interactiveMessage.body,
        text: scrubUserFacingText(next.interactiveMessage.body.text, meta)
      }
    };
  }
  return next;
}

function sanitizeSendOptions(options) {
  if (!options || typeof options !== 'object') return options || {};
  const q = options.quoted;
  if (!q) return options;
  const key = q.key || q;
  if (!key || typeof key !== 'object' || !key.id) {
    const next = { ...options };
    delete next.quoted;
    return next;
  }
  return options;
}

function patchConnSendMessage(conn) {
  if (!conn || conn._hanorkSendPatched) return conn;
  const original = typeof conn.sendMessage === 'function' ? conn.sendMessage.bind(conn) : null;
  if (!original) return conn;

  conn.sendMessage = async (jid, content, options = {}) => {
    options = sanitizeSendOptions(options);
    let dest = jid;
    try {
      const { keepInboundChatJid, ensureJidString, resolvePeerJid } = require('../utils');
      const raw = ensureJidString(jid, '');
      if (
        raw.endsWith('@g.us') ||
        raw.endsWith('@newsletter') ||
        raw.endsWith('@broadcast') ||
        raw === 'status@broadcast'
      ) {
        dest = raw;
      } else {
        const key = options?.quoted?.key || options?.key;
        dest = keepInboundChatJid(raw, key) || raw;
      }
    } catch (_) { /* mapping opcional */ }

    if (swallowAuthDenial(dest, content, { sessionId: conn._sessionId })) {
      return { key: { id: `silent-auth-${Date.now()}`, remoteJid: dest, fromMe: true }, message: {} };
    }

    try {
      const { assertSendableSticker } = require('./bannedStickers');
      assertSendableSticker(conn._telegramUserId, content, options);
    } catch (banErr) {
      if (banErr && banErr.code === 'BANNED_STICKER') {
        logger.logAviso(`[stickerban] bloqueou envio: ${String(banErr.message)}`);
        throw banErr;
      }
    }

    let payload = content;
    if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
      payload = stripContentEmojis(payload);
      payload = scrubPayloadErrors(payload, conn._sessionId || options.sessionId || null);
      if (payload.delete && payload.delete.remoteJid) {
        try {
          const { resolvePeerJid } = require('../utils');
          payload = {
            ...payload,
            delete: {
              ...payload.delete,
              remoteJid: resolvePeerJid(payload.delete.remoteJid, null, conn)
            }
          };
        } catch (_) { /* ignore */ }
      }
      if (
        !options.skipForward &&
        !payload.delete &&
        !payload.react &&
        !payload.interactiveMessage
      ) {
        try {
          const { applyForwardMode, shouldForwardAsChannel } = require('./channelForward');
          const sid = conn._sessionId;
          const tid = conn._telegramUserId;
          let off = shouldForwardAsChannel(sid);
          if (!off && tid != null && tid !== '') {
            const { areButtonsOn } = require('./sessionRegistry');
            off = areButtonsOn(sid, tid) === false;
          }
          if (off) payload = applyForwardMode(payload, sid, { force: true });
        } catch (_) { /* canal opcional */ }
      }
    }
    if (waOverHot() && canBareRetry(payload, options)) {
      payload = stripChannelStamp(payload);
    }
    let result;
    try {
      result = await original(dest, payload, options);
    } catch (sendErr) {
      const raw = String(dest || '');
      const over = isOverlimitErr(sendErr);
      if (raw.includes('@lid')) {
        try {
          const { resolvePeerJid } = require('../utils');
          const pn = resolvePeerJid(raw, options?.quoted?.key || options?.key, conn);
          if (pn && pn !== dest && !String(pn).includes('@lid')) {
            result = await original(pn, payload, options);
          } else {
            throw sendErr;
          }
        } catch (e2) {
          if (!over) throw sendErr;
        }
      }
      if (!result && over && canBareRetry(payload, options)) {
        markWaOverlimit();
        const retryOpts = { ...options, skipForward: true, _hanorkOverRetry: true };
        delete retryOpts.quoted;
        try {
          result = await original(dest, stripChannelStamp(payload), retryOpts);
          logger.logAviso('[SEND] overlimit: reenviou sem selo/quoted');
        } catch (_) {
          throw sendErr;
        }
      } else if (!result && over) {
        markWaOverlimit();
        throw sendErr;
      } else if (!result) {
        throw sendErr;
      }
    }
    try {
      const id = result?.key?.id || result?.message?.key?.id;
      if (id) {
        rememberBotSentId(id);
        try { require('./interactiveClickGuard').rememberMenuId(id, conn); } catch (_) {}
      }
      const txt =
        (payload && (payload.text || payload.caption || payload.conversation)) ||
        payload?.extendedTextMessage?.text ||
        '';
      if (txt) rememberBotSentText(txt);
    } catch (_) {}
    return result;
  };

  conn._hanorkSendPatched = true;

  // Relays (listas/menus) tambem podem carregar texto de erro
  if (typeof conn.relayMessage === 'function' && !conn._hanorkRelayScrubbed) {
    const origRelay = conn.relayMessage.bind(conn);
    conn.relayMessage = async (jid, message, options = {}) => {
      let dest = jid;
      try {
        const { keepInboundChatJid, ensureJidString, resolvePeerJid } = require('../utils');
        const raw = ensureJidString(jid, '');
        if (
          raw.endsWith('@g.us') ||
          raw.endsWith('@newsletter') ||
          raw.endsWith('@broadcast') ||
          raw === 'status@broadcast'
        ) {
          dest = raw;
        } else {
          const key = options?.quoted?.key || options?.key;
          dest = keepInboundChatJid(raw, key) || raw;
        }
      } catch (_) { /* mapping opcional */ }
      // Fluxo interno (div/invisivel/safeRelay): nao clona o protobuf inteiro.
      // JSON.parse(JSON.stringify) em mencoes/midia explodia RAM na host 1536MB.
      if (options && options._hanorkTrusted) {
        try {
          const result = await origRelay(dest, message, options);
          try {
            const id = options.messageId || (typeof result === 'string' ? result : result?.key?.id);
            if (id) {
              rememberBotSentId(id);
              try { require('./interactiveClickGuard').rememberMenuId(id, conn); } catch (_) {}
            }
          } catch (_) {}
          return result;
        } catch (relErr) {
          const over = isOverlimitErr(relErr);
          if (over) markWaOverlimit();
          if (over && canBareRetry(message, options)) {
            const retryOpts = { ...options, skipForward: true, _hanorkOverRetry: true };
            delete retryOpts.quoted;
            try {
              const result = await origRelay(dest, stripChannelStamp(message), retryOpts);
              logger.logAviso('[RELAY] overlimit: reenviou sem selo/quoted');
              try {
                const id = retryOpts.messageId || (typeof result === 'string' ? result : result?.key?.id);
                if (id) rememberBotSentId(id);
              } catch (_) {}
              return result;
            } catch (_) { /* cai no throw */ }
          }
          throw relErr;
        }
      }
      let msg = message;
      try {
        if (msg && typeof msg === 'object') {
          const meta = { sessionId: conn._sessionId || 'na', channel: 'whatsapp-relay' };
          const walk = (node, depth) => {
            if (!node || typeof node !== 'object' || depth > 8) return;
            if (Buffer.isBuffer(node) || ArrayBuffer.isView(node)) return;
            if (typeof node.text === 'string') node.text = scrubUserFacingText(node.text, meta);
            if (typeof node.conversation === 'string') {
              node.conversation = scrubUserFacingText(node.conversation, meta);
            }
            if (node.extendedTextMessage?.text) {
              node.extendedTextMessage.text = scrubUserFacingText(
                node.extendedTextMessage.text,
                meta
              );
            }
            if (node.interactiveMessage?.body?.text) {
              node.interactiveMessage.body.text = scrubUserFacingText(
                node.interactiveMessage.body.text,
                meta
              );
            }
            for (const v of Object.values(node)) {
              if (v && typeof v === 'object') walk(v, depth + 1);
            }
          };
          walk(msg, 0);
        }
      } catch (_) {
        msg = message;
      }
      let result;
      try {
        result = await origRelay(dest, msg, options);
      } catch (relErr) {
        const over = isOverlimitErr(relErr);
        if (over) markWaOverlimit();
        if (over && canBareRetry(msg, options)) {
          const retryOpts = { ...options, skipForward: true, _hanorkOverRetry: true };
          delete retryOpts.quoted;
          try {
            result = await origRelay(dest, stripChannelStamp(msg), retryOpts);
            logger.logAviso('[RELAY] overlimit: reenviou sem selo/quoted');
          } catch (_) {
            throw relErr;
          }
        } else {
          throw relErr;
        }
      }
      try {
        const id = options.messageId || (typeof result === 'string' ? result : result?.key?.id);
        if (id) {
          rememberBotSentId(id);
          try { require('./interactiveClickGuard').rememberMenuId(id, conn); } catch (_) {}
        }
      } catch (_) {}
      return result;
    };
    conn._hanorkRelayScrubbed = true;
  }

  return conn;
}

module.exports = {
  patchConnSendMessage,
  stripContentEmojis,
  scrubPayloadErrors,
  stripChannelStamp,
  markWaOverlimit,
  clearWaOverlimit,
  waOverHot
};
