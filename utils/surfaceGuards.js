'use strict';
/**
 * Protecoes inbound por superficie Baileys — toggles individuais (default OFF).
 * Usa deteccoes da lib quando existirem (hasPaymentMessage, hasGroupStatusMessage).
 * Inventario: docs/AUDITORIA-VIVA.md (secao Baileys Zero §3/§5/§11).
 *
 * NAO bloqueia fromMe (fluxos legitimos do bot: menus, midia, div).
 */
const logger = require('../logger');

/** Flags novas — default OFF (adm/VIP/dono liga) */
const SURFACE_DEFAULTS = Object.freeze({
  surfPayment: false,
  surfGroupStatus: false,
  surfForwardSpoof: false,
  surfMetaAi: false,
  surfBizFake: false,
  surfPhishAd: false,
  surfNativeFlow: false,
  surfViewOnce: false,
  surfCapMentions: false,
  surfCapMedia: false,
  surfFakePoll: false,
  surfSettingsFlood: false
});

const SURFACE_LABELS = Object.freeze({
  surfPayment: 'Anti-pay scam',
  surfGroupStatus: 'Anti-status GP',
  surfForwardSpoof: 'Anti-fwd spoof',
  surfMetaAi: 'Anti-Meta AI',
  surfBizFake: 'Anti-biz fake',
  surfPhishAd: 'Anti-phish ad',
  surfNativeFlow: 'Deny nativeFlow',
  surfViewOnce: 'Anti-viewOnce',
  surfCapMentions: 'Cap mentions',
  surfCapMedia: 'Cap midia/react',
  surfFakePoll: 'Anti-fake poll',
  surfSettingsFlood: 'Sensor settings'
});

/** NativeFlow names que o Hanork usa de verdade nos menus */
const NATIVE_FLOW_ALLOW = new Set([
  'single_select',
  'quick_reply',
  'cta_url',
  'cta_copy',
  'cta_call'
]);

const NATIVE_FLOW_DENY = new Set([
  'payment_info',
  'payment_method',
  'payment_status',
  'review_and_pay',
  'review_order',
  'order_details',
  'order_status',
  'clear_chat',
  'voice_call',
  'video_call_button',
  'call_permission_request',
  'otp_button',
  'mpm',
  'catalog_message'
]);

const SUSPICIOUS_NEWSLETTER_NAMES = /^(whatsapp|wa\.me|meta|oficial|official)$/i;
const SUSPICIOUS_NEWSLETTER_JID = /^(0|1203630{0,})@newsletter$/i;

let _hasPaymentMessage = null;
let _hasGroupStatusMessage = null;
let _hasGroupStatusFlag = null;

function loadBaileysDetectors() {
  if (_hasPaymentMessage !== null) return;
  try {
    const b = require('@systemzero/baileys');
    _hasPaymentMessage = typeof b.hasPaymentMessage === 'function' ? b.hasPaymentMessage : () => false;
    _hasGroupStatusMessage = typeof b.hasGroupStatusMessage === 'function' ? b.hasGroupStatusMessage : () => false;
    _hasGroupStatusFlag = typeof b.hasGroupStatusFlag === 'function' ? b.hasGroupStatusFlag : () => false;
  } catch (_) {
    _hasPaymentMessage = () => false;
    _hasGroupStatusMessage = () => false;
    _hasGroupStatusFlag = () => false;
  }
}

const SKIP_NESTED = new Set([
  'quotedMessage',
  'quotedAd',
  'hydratedQuotedMessage',
  'noteMessage'
]);

function walk(node, fn, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  fn(node);
  if (Array.isArray(node)) {
    for (const x of node) walk(x, fn, depth + 1);
    return;
  }
  for (const k of Object.keys(node)) {
    if (SKIP_NESTED.has(k)) continue;
    const v = node[k];
    if (v && typeof v === 'object') walk(v, fn, depth + 1);
  }
}

function collectNativeFlowNames(message) {
  const names = [];
  walk(message, (n) => {
    if (Array.isArray(n?.nativeFlowMessage?.buttons)) {
      for (const b of n.nativeFlowMessage.buttons) {
        if (b?.name) names.push(String(b.name));
      }
    }
    if (n?.nativeFlowResponseMessage?.name) {
      names.push(String(n.nativeFlowResponseMessage.name));
    }
  });
  return names;
}

function findForwardSpoof(message) {
  let hit = null;
  walk(message, (n) => {
    if (hit) return;
    const info = n.forwardedNewsletterMessageInfo || n.contextInfo?.forwardedNewsletterMessageInfo;
    if (!info) return;
    const name = String(info.newsletterName || '');
    const jid = String(info.newsletterJid || '');
    if (SUSPICIOUS_NEWSLETTER_NAMES.test(name.trim()) || /@newsletter$/i.test(jid) && (/^0@/.test(jid) || name.toLowerCase() === 'whatsapp')) {
      hit = { name, jid };
    }
  });
  return hit;
}

function findMetaAiSpoof(message) {
  let hit = null;
  walk(message, (n) => {
    if (hit) return;
    if (n.botForwardedMessage || n.botInvokeMessage) {
      hit = 'botForwarded/botInvoke';
      return;
    }
    if (n.richResponseMessage || n.messageContextInfo?.supportPayload) {
      try {
        const sp = n.messageContextInfo?.supportPayload;
        if (typeof sp === 'string' && /is_ai_message/i.test(sp)) hit = 'supportPayload AI';
      } catch (_) { /* ignore */ }
    }
  });
  return hit;
}

function findBizFake(message) {
  let hit = false;
  walk(message, (n) => {
    if (hit) return;
    const owner =
      n.productMessage?.businessOwnerJid ||
      n.productMessage?.product?.businessOwnerJid ||
      n.interactiveMessage?.header?.productMessage?.businessOwnerJid;
    if (owner && /^0@/.test(String(owner))) hit = true;
  });
  return hit;
}

function findPhishAd(message) {
  let url = null;
  walk(message, (n) => {
    if (url) return;
    const ad = n.externalAdReply || n.contextInfo?.externalAdReply;
    if (!ad) return;
    const u = String(ad.sourceUrl || '');
    if (!u) return;
    // So esquema malicioso — nao o link/titulo da divulgacao
    if (/^(javascript:|data:)/i.test(u)) {
      url = u.slice(0, 120);
    }
  });
  return url;
}

function countMentions(message) {
  let max = 0;
  walk(message, (n) => {
    const m = n.contextInfo?.mentionedJid || n.mentionedJid;
    if (Array.isArray(m)) max = Math.max(max, m.length);
  });
  return max;
}

function isViewOnce(message) {
  if (!message) return false;
  return !!(
    message.viewOnceMessage ||
    message.viewOnceMessageV2 ||
    message.viewOnceMessageV2Extension ||
    message.ephemeralMessage?.message?.viewOnceMessage ||
    message.ephemeralMessage?.message?.viewOnceMessageV2
  );
}

function isFakePollSnapshot(message) {
  if (!message) return false;
  if (message.pollResultSnapshotMessage || message.pollResultMessage) return true;
  let hit = false;
  walk(message, (n) => {
    if (n.pollResultSnapshotMessage || n.pollResultMessage) hit = true;
  });
  return hit;
}

function mediaCapHit(message) {
  let stickers = 0;
  let albumExpected = 0;
  walk(message, (n) => {
    if (n.stickerPackMessage) {
      const c = Number(n.stickerPackMessage.stickers?.length || n.stickerPackMessage.size || 0);
      if (c > 60) stickers = Math.max(stickers, c);
    }
    if (n.albumMessage) {
      albumExpected = Math.max(
        albumExpected,
        Number(n.albumMessage.expectedImageCount || 0) + Number(n.albumMessage.expectedVideoCount || 0)
      );
    }
  });
  if (stickers > 60) return `stickerPack=${stickers}`;
  if (albumExpected > 30) return `album=${albumExpected}`;
  return null;
}

/**
 * Detecta violacao de superficie.
 * @returns {{ flag: string, reason: string, detail?: string, action: 'delete'|'log'|'ban' } | null}
 */
function detectSurfaceHit(waMessage, flags) {
  loadBaileysDetectors();
  if (!waMessage?.message) return null;
  const msg = waMessage.message;
  const f = flags || {};

  if (f.surfPayment) {
    try {
      const { isPaymentMessage } = require('./moderation');
      if (isPaymentMessage(waMessage)) {
        return { flag: 'surfPayment', reason: 'surf_payment', detail: 'native_payment', action: 'delete' };
      }
    } catch (_) { /* fallthrough */ }
  }

  if (f.surfGroupStatus) {
    try {
      let hitStatus = false;
      try {
        hitStatus = _hasGroupStatusMessage(waMessage) || _hasGroupStatusFlag(msg);
      } catch (_) { /* ignore */ }
      if (!hitStatus) {
        const { unwrapMessage } = require('./moderation');
        const inner = unwrapMessage(waMessage);
        hitStatus = !!(
          msg.groupStatusMessageV2 ||
          msg.groupStatusMessage ||
          msg.groupStatusMentionMessage ||
          inner?.groupStatusMessageV2 ||
          inner?.groupStatusMessage ||
          inner?.groupStatusMentionMessage
        );
      }
      if (hitStatus) {
        return { flag: 'surfGroupStatus', reason: 'surf_group_status', detail: 'groupStatus', action: 'delete' };
      }
    } catch (_) { /* fallthrough */ }
  }

  if (f.surfForwardSpoof) {
    const spoof = findForwardSpoof(msg);
    if (spoof) {
      return { flag: 'surfForwardSpoof', reason: 'surf_forward_spoof', detail: `${spoof.name}|${spoof.jid}`, action: 'delete' };
    }
  }

  if (f.surfMetaAi) {
    const meta = findMetaAiSpoof(msg);
    if (meta) {
      return { flag: 'surfMetaAi', reason: 'surf_meta_ai', detail: meta, action: 'delete' };
    }
  }

  if (f.surfBizFake && findBizFake(msg)) {
    return { flag: 'surfBizFake', reason: 'surf_biz_fake', detail: '0@s.whatsapp.net', action: 'delete' };
  }

  if (f.surfPhishAd) {
    const u = findPhishAd(msg);
    if (u) {
      return { flag: 'surfPhishAd', reason: 'surf_phish_ad', detail: u, action: 'delete' };
    }
  }

  if (f.surfNativeFlow) {
    const names = collectNativeFlowNames(msg);
    for (const name of names) {
      const n = String(name || '').toLowerCase();
      if (NATIVE_FLOW_DENY.has(n)) {
        return { flag: 'surfNativeFlow', reason: 'surf_native_flow', detail: n, action: 'delete' };
      }
    }
  }

  if (f.surfViewOnce && isViewOnce(msg)) {
    // So log — nao auto-abrir; delete so se antiatkinvisivel (outro pipeline)
    return { flag: 'surfViewOnce', reason: 'surf_view_once', detail: 'viewOnce', action: 'log' };
  }

  if (f.surfCapMentions) {
    const m = countMentions(msg);
    if (m >= 25) {
      return { flag: 'surfCapMentions', reason: 'surf_cap_mentions', detail: `mentions=${m}`, action: 'delete' };
    }
  }

  if (f.surfCapMedia) {
    const cap = mediaCapHit(msg);
    if (cap) {
      return { flag: 'surfCapMedia', reason: 'surf_cap_media', detail: cap, action: 'delete' };
    }
  }

  if (f.surfFakePoll && isFakePollSnapshot(msg)) {
    return { flag: 'surfFakePoll', reason: 'surf_fake_poll', detail: 'pollResultSnapshot', action: 'delete' };
  }

  return null;
}

/** Sensor promote/remove/settings flood — estado por grupo */
const settingsFloodState = new Map();

function noteGroupMutation(groupId, kind) {
  const gid = String(groupId || '');
  if (!gid.endsWith('@g.us')) return null;
  const key = `${gid}:${kind}`;
  const now = Date.now();
  let s = settingsFloodState.get(key);
  if (!s || now - s.t0 > 20_000) s = { n: 0, t0: now };
  s.n += 1;
  settingsFloodState.set(key, s);
  if (s.n >= 8) {
    return { flag: 'surfSettingsFlood', reason: 'surf_settings_flood', detail: `${kind}x${s.n}`, action: 'log' };
  }
  return null;
}

/**
 * Pipeline inbound — apaga msg se action=delete; log se log.
 * Reusa deleteMessage / execute paths de moderation via callbacks.
 */
async function processSurfaceGuards(conn, message, telegramUserId, sessionId, {
  getFlags,
  isAdmin,
  deleteMsg,
  isWhitelisted
} = {}) {
  try {
    if (!message?.key || message.key.fromMe) return null;
    const groupId = String(message.key.remoteJid || '');
    if (!groupId.endsWith('@g.us')) return null;

    const flags = typeof getFlags === 'function' ? getFlags() : {};
    const sender = String(
        message.key.participant ||
        message.key.participantAlt ||
        ''
    );
    if (typeof isWhitelisted === 'function' && sender && isWhitelisted(sender)) return null;

    // Detecta ANTES de isAdmin — msgs normais nao disparam groupMetadata
    const hit = detectSurfaceHit(message, flags);
    if (!hit) return null;
    if (!flags[hit.flag]) return null;

    // Nunca usar remoteJid do grupo como remetente — ADM de status/midia ficava "membro"
    if (typeof isAdmin === 'function' && (await isAdmin(sender))) return null;

    logger.logAviso(
      `[SURF] flag=${hit.flag} action=${hit.action} detail=${hit.detail || '-'} ` +
      `grupo=${groupId.slice(0, 22)}…`
    );

    if (hit.action === 'log') {
      return { handled: true, reason: hit.reason, surface: hit.flag, logged: true };
    }

    if (hit.action === 'delete' && typeof deleteMsg === 'function') {
      await deleteMsg(message);
      return { handled: true, reason: hit.reason, surface: hit.flag, deleted: true };
    }

    return { handled: true, reason: hit.reason, surface: hit.flag };
  } catch (e) {
    logger.logErro(`[SURF] abort: ${e.message}`);
    return null;
  }
}

module.exports = {
  SURFACE_DEFAULTS,
  SURFACE_LABELS,
  NATIVE_FLOW_ALLOW,
  detectSurfaceHit,
  processSurfaceGuards,
  noteGroupMutation,
  loadBaileysDetectors
};
