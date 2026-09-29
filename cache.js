// cache.js — cache de msgs por sessao (cap + slim). Host tem 1536MB.
const NodeCache = require('node-cache');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const caches = new Map();
const stats = new Map();

const CACHE_TTL = Number(process.env.HANORK_MSG_CACHE_TTL || 7200); // 2h
const CACHE_MAX_KEYS = Number(process.env.HANORK_MSG_CACHE_MAX || 1200);
const CHECK_PERIOD = 120;
const PERSIST_MAX = 300;
const PERSIST_MAX_BYTES = 1.5 * 1024 * 1024;
const PERSIST_DIR = path.join(__dirname, 'data', 'cache');

function getCache(sessionId) {
  if (!caches.has(sessionId)) {
    caches.set(sessionId, new NodeCache({
      stdTTL: CACHE_TTL,
      checkperiod: CHECK_PERIOD,
      useClones: false,
      maxKeys: CACHE_MAX_KEYS
    }));
  }
  return caches.get(sessionId);
}

function getStats(sessionId) {
  if (!stats.has(sessionId)) {
    stats.set(sessionId, { messages: 0, commands: 0, started: Date.now() });
  }
  return stats.get(sessionId);
}

const PAYMENT_SLIM_KEYS = [
  'requestPaymentMessage',
  'sendPaymentMessage',
  'declinePaymentRequestMessage',
  'cancelPaymentRequestMessage',
  'paymentInviteMessage',
  'invoiceMessage'
];

function walkLooksLike(node, test, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return false;
  if (test(node)) return true;
  const next =
    node.ephemeralMessage?.message ||
    node.viewOnceMessage?.message ||
    node.viewOnceMessageV2?.message ||
    node.viewOnceMessageV2Extension?.message ||
    node.documentWithCaptionMessage?.message ||
    node.editedMessage?.message ||
    node.message;
  return next ? walkLooksLike(next, test, depth + 1) : false;
}

function unwrapSlimRoot(m) {
  let root = m;
  for (let i = 0; i < 8; i++) {
    if (root?.ephemeralMessage?.message) root = root.ephemeralMessage.message;
    else if (root?.viewOnceMessage?.message) root = root.viewOnceMessage.message;
    else if (root?.viewOnceMessageV2?.message) root = root.viewOnceMessageV2.message;
    else if (root?.viewOnceMessageV2Extension?.message) root = root.viewOnceMessageV2Extension.message;
    else if (root?.documentWithCaptionMessage?.message) root = root.documentWithCaptionMessage.message;
    else if (root?.editedMessage?.message) root = root.editedMessage.message;
    else break;
  }
  return root || m;
}

function looksLikePayment(m) {
  return walkLooksLike(m, (n) => PAYMENT_SLIM_KEYS.some((k) => n[k]));
}

function looksLikeGroupStatus(m) {
  return walkLooksLike(m, (n) => !!(
    n.groupStatusMessage || n.groupStatusMessageV2 || n.groupStatusMentionMessage
    || n.contextInfo?.isGroupStatus
    || Number(n.contextInfo?.statusSourceType) === 4
    || n.isGroupStatus === true
    || Number(n.statusSourceType) === 4
  ));
}

function slimContextInfo(ctx) {
  if (!ctx || typeof ctx !== 'object') return {};
  const out = {};
  if (ctx.isGroupStatus) out.isGroupStatus = true;
  if (ctx.statusSourceType != null) out.statusSourceType = ctx.statusSourceType;
  if (ctx.pairedMediaType) out.pairedMediaType = ctx.pairedMediaType;
  if (Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length) {
    out.mentionedJid = ctx.mentionedJid.slice(0, 40);
  }
  if (Array.isArray(ctx.groupMentions) && ctx.groupMentions.length) {
    out.groupMentions = ctx.groupMentions.slice(0, 10);
  }
  if (Array.isArray(ctx.statusAttributions) && ctx.statusAttributions.length) {
    out.statusAttributions = ctx.statusAttributions.slice(0, 10);
  }
  if (ctx.statusAudienceMetadata) out.statusAudienceMetadata = ctx.statusAudienceMetadata;
  return out;
}

function slimStickerNode(s) {
  if (!s || typeof s !== 'object') return { _kept: 1 };
  const hex = (v) => {
    if (!v) return '';
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('hex');
    if (typeof v === 'string' && /^[0-9a-fA-F]{32,}$/.test(v)) return v.toLowerCase();
    return '';
  };
  return {
    mimetype: s.mimetype || 'image/webp',
    fileLength: s.fileLength || 0,
    height: s.height || 0,
    width: s.width || 0,
    isAnimated: !!s.isAnimated,
    fileSha256: hex(s.fileSha256),
    fileEncSha256: hex(s.fileEncSha256)
  };
}

function slimInnerContent(m) {
  if (!m || typeof m !== 'object') return { _hanork: 1 };
  if (m.extendedTextMessage) {
    return {
      extendedTextMessage: {
        text: String(m.extendedTextMessage.text || '').slice(0, 800),
        contextInfo: slimContextInfo(m.extendedTextMessage.contextInfo)
      }
    };
  }
  if (m.imageMessage) {
    return {
      imageMessage: {
        mimetype: m.imageMessage.mimetype || '',
        caption: String(m.imageMessage.caption || '').slice(0, 400),
        contextInfo: slimContextInfo(m.imageMessage.contextInfo)
      }
    };
  }
  if (m.videoMessage) {
    return {
      videoMessage: {
        mimetype: m.videoMessage.mimetype || '',
        caption: String(m.videoMessage.caption || '').slice(0, 400),
        gifPlayback: !!m.videoMessage.gifPlayback,
        contextInfo: slimContextInfo(m.videoMessage.contextInfo)
      }
    };
  }
  if (m.conversation) {
    return { conversation: String(m.conversation).slice(0, 800) };
  }
  const keys = Object.keys(m).filter((k) => k !== 'messageContextInfo');
  return keys[0] ? { [keys[0]]: { _kept: 1 } } : { _hanork: 1 };
}

function slimPaymentNode(m) {
  const pay = m?.requestPaymentMessage || m;
  const note = pay?.noteMessage?.extendedTextMessage;
  return {
    requestPaymentMessage: {
      currencyCodeIso4217: pay?.currencyCodeIso4217 || '',
      amount1000: pay?.amount1000 || '0',
      noteMessage: note
        ? {
            extendedTextMessage: {
              text: String(note.text || '').slice(0, 400),
              contextInfo: slimContextInfo(note.contextInfo)
            }
          }
        : undefined
    }
  };
}

function slimMessage(info) {
  if (!info || !info.key || !info.key.id) return null;
  const k = info.key;
  const slim = {
    key: {
      id: k.id,
      remoteJid: k.remoteJid,
      remoteJidAlt: k.remoteJidAlt,
      fromMe: k.fromMe,
      participant: k.participant,
      participantAlt: k.participantAlt,
      participantPn: k.participantPn,
      addressingMode: k.addressingMode
    },
    messageTimestamp: info.messageTimestamp || 0
  };
  const m = info.message;
  if (info._hanorkPayment || looksLikePayment(m) || looksLikePayment(info)) {
    slim._hanorkPayment = true;
    const inner = unwrapSlimRoot(m);
    slim.message = slimPaymentNode(inner);
    return slim;
  }
  if (info._hanorkGroupStatus || looksLikeGroupStatus(m) || looksLikeGroupStatus(info)) {
    slim._hanorkGroupStatus = true;
    const root = unwrapSlimRoot(m);
    const wrap = root?.groupStatusMessageV2
      ? 'groupStatusMessageV2'
      : (root?.groupStatusMessage
        ? 'groupStatusMessage'
        : (root?.groupStatusMentionMessage ? 'groupStatusMentionMessage' : ''));
    if (wrap && root[wrap]) {
      const inner = root[wrap].message || root[wrap];
      slim.message = { [wrap]: { message: slimInnerContent(inner) } };
    } else {
      slim.message = slimInnerContent(root);
    }
    return slim;
  }
  if (m && typeof m === 'object') {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
    const sticker = inner?.stickerMessage
      || inner?.lottieStickerMessage?.message?.stickerMessage
      || null;
    if (sticker) {
      slim.message = { stickerMessage: slimStickerNode(sticker) };
      return slim;
    }
    const text =
      (typeof m.conversation === 'string' && m.conversation) ||
      (typeof m.extendedTextMessage?.text === 'string' && m.extendedTextMessage.text) ||
      (typeof m.imageMessage?.caption === 'string' && m.imageMessage.caption) ||
      '';
    const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo;
    slim.message = {
      conversation: String(text).slice(0, 400)
    };
    if (ctx && (ctx.isGroupStatus || ctx.statusSourceType != null)) {
      slim.message = {
        extendedTextMessage: {
          text: String(text).slice(0, 800),
          contextInfo: slimContextInfo(ctx)
        }
      };
    }
  }
  return slim;
}

function pruneCache(sessionId, keep = 700) {
  const cache = caches.get(sessionId);
  if (!cache) return 0;
  const keys = cache.keys();
  if (keys.length <= keep) return 0;
  const extra = keys.length - keep;
  let n = 0;
  for (const k of keys) {
    if (n >= extra) break;
    cache.del(k);
    n++;
  }
  return n;
}

function pruneAllCaches(keep = 500) {
  let n = 0;
  for (const sid of caches.keys()) n += pruneCache(sid, keep);
  return n;
}

function putMessage(sessionId, key, info) {
  if (!sessionId || !key) return;
  const cache = getCache(sessionId);
  const slim = slimMessage(info) || info;
  try {
    const n = cache.keys().length;
    if (n >= CACHE_MAX_KEYS - 20) pruneCache(sessionId, Math.floor(CACHE_MAX_KEYS * 0.65));
    cache.set(String(key), slim, CACHE_TTL);
  } catch (_) {
    pruneCache(sessionId, 400);
    try { cache.set(String(key), slim, CACHE_TTL); } catch (_) { /* ignore */ }
  }
}

function getPersistPath(sessionId) {
  return path.join(PERSIST_DIR, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function persistCache(sessionId) {
  try {
    const cache = getCache(sessionId);
    const keys = cache.keys().slice(-PERSIST_MAX);
    const data = {};
    for (const key of keys) {
      const value = slimMessage(cache.get(key));
      if (value && value.key && value.key.id) data[key] = value;
    }
    if (Object.keys(data).length === 0) return;
    if (!fs.existsSync(PERSIST_DIR)) fs.mkdirSync(PERSIST_DIR, { recursive: true });
    fs.writeFileSync(getPersistPath(sessionId), JSON.stringify(data));
  } catch (_) { /* best-effort */ }
}

function loadPersistedCache(sessionId) {
  try {
    const persistPath = getPersistPath(sessionId);
    if (!fs.existsSync(persistPath)) return;
    const st = fs.statSync(persistPath);
    if (st.size > PERSIST_MAX_BYTES) {
      logger.logAviso(
        `[CACHE] persist grande ${Math.round(st.size / 1048576)}MB — ignorado e apagado (${sessionId})`
      );
      try { fs.unlinkSync(persistPath); } catch (_) { /* ignore */ }
      return;
    }
    const data = JSON.parse(fs.readFileSync(persistPath, 'utf-8'));
    const entries = Object.entries(data);
    const slice = entries.length > PERSIST_MAX ? entries.slice(-PERSIST_MAX) : entries;
    const cache = getCache(sessionId);
    let n = 0;
    for (const [key, value] of slice) {
      const slim = slimMessage(value);
      if (!slim) continue;
      try {
        cache.set(key, slim, CACHE_TTL);
        n++;
      } catch (_) {
        break;
      }
    }
    logger.logInfo(`[CACHE] ${n} mensagens restauradas (slim) para ${sessionId}`);
  } catch (e) {
    logger.logAviso(`[CACHE] load fail ${sessionId}: ${e.message}`);
  }
}

function purgeOversizedPersistFiles() {
  try {
    if (!fs.existsSync(PERSIST_DIR)) return 0;
    let n = 0;
    for (const name of fs.readdirSync(PERSIST_DIR)) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(PERSIST_DIR, name);
      try {
        const st = fs.statSync(p);
        if (st.size > PERSIST_MAX_BYTES) {
          fs.unlinkSync(p);
          n++;
        }
      } catch (_) { /* ignore */ }
    }
    if (n) logger.logAviso(`[CACHE] apagados ${n} persist oversized`);
    return n;
  } catch (_) {
    return 0;
  }
}

setInterval(() => {
  for (const sessionId of caches.keys()) persistCache(sessionId);
}, 300000);

purgeOversizedPersistFiles();

module.exports = {
  getCache,
  getStats,
  persistCache,
  loadPersistedCache,
  putMessage,
  pruneCache,
  pruneAllCaches,
  purgeOversizedPersistFiles,
  slimMessage
};
