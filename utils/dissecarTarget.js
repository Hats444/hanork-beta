// utils/dissecarTarget.js — extracao total de metadata via Baileys (owner)
'use strict';

const logger = require('../logger');
const { ensureJidString } = require('../utils');
const { previewText, stripAccents, labelValue, formatReportBlock } = require('./typography');

const UNAVAIL = 'indisponivel';
const PRIVACY = 'indisponivel (privacidade)';

function maskJid(jid) {
  const s = String(jid || '');
  const [user, domain] = s.split('@');
  if (!user || !domain) return '***';
  if (user.length <= 4) return `***@${domain}`;
  return `${user.slice(0, 3)}…${user.slice(-2)}@${domain}`;
}

function classifyJid(jid) {
  const j = ensureJidString(jid, '');
  if (!j) return { type: 'unknown', jid: '' };
  if (j.endsWith('@g.us')) return { type: 'group', jid: j };
  if (j.endsWith('@newsletter')) return { type: 'newsletter', jid: j };
  if (j.endsWith('@lid') || j.endsWith('@s.whatsapp.net') || j.endsWith('@c.us')) {
    return { type: 'pv', jid: j };
  }
  return { type: 'unknown', jid: j };
}

async function safeCall(label, fn) {
  try {
    const value = await fn();
    if (value === undefined || value === null || value === '') {
      return { ok: false, value: UNAVAIL, label };
    }
    return { ok: true, value, label };
  } catch (e) {
    const msg = String(e?.message || e || '');
    const privacy = /privacy|forbidden|401|403|not.?authorized|denied|item-not-found/i.test(msg);
    logger.logInfo(`[dissecar] campo=${label} falhou: ${msg.slice(0, 120)}`);
    return { ok: false, value: privacy ? PRIVACY : UNAVAIL, label, error: msg.slice(0, 120) };
  }
}

function fmtTs(ts) {
  if (ts == null || ts === '') return UNAVAIL;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return String(ts);
  const ms = n > 1e12 ? n : n * 1000;
  try {
    return new Date(ms).toISOString();
  } catch (_) {
    return String(ts);
  }
}

/** Extrai texto util de valores aninhados do Baileys (name/text objects) */
function unwrap(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (typeof v.name === 'string') return v.name;
    if (typeof v.id === 'string') return v.id;
    if (typeof v.url === 'string') return v.url;
  }
  return v;
}

function pick(obj, paths, fallback = UNAVAIL) {
  for (const path of paths) {
    let cur = obj;
    for (const key of String(path).split('.')) {
      if (cur == null) { cur = undefined; break; }
      cur = cur[key];
    }
    const u = unwrap(cur);
    if (u !== undefined && u !== null && u !== '') return u;
  }
  return fallback;
}

/** Serializa objeto Baileys para JSON seguro (Buffer → base64 curto) */
function jsonSafe(value, depth = 0) {
  if (value == null) return value;
  if (depth > 12) return '[max_depth]';
  if (Buffer.isBuffer(value)) return `<buffer ${value.length}b>`;
  if (value instanceof Uint8Array) return `<uint8 ${value.length}b>`;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'object' && typeof value.toNumber === 'function' && value.low != null) {
    try { return Number(value); } catch (_) { /* Long */ }
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((x) => jsonSafe(x, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'function') continue;
      out[k] = jsonSafe(v, depth + 1);
    }
    return out;
  }
  return value;
}

function parseLooseTargets(text) {
  const s = String(text || '').trim();
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const v = String(t || '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  if (!s) return out;
  for (const m of s.matchAll(/https?:\/\/[^\s<>]+/gi)) push(m[0].replace(/[),.;]+$/, ''));
  for (const m of s.matchAll(/[\w.-]+@(?:s\.whatsapp\.net|g\.us|lid|newsletter|c\.us)/gi)) push(m[0]);
  for (const m of s.matchAll(/(?:whatsapp\.com\/channel\/|chat\.whatsapp\.com\/)([A-Za-z0-9_-]+)/gi)) {
    push(m[0]);
  }
  for (const m of s.matchAll(/(?:^|[\s,;])(\+?\d{10,18})(?=$|[\s,;])/g)) {
    push(m[1].replace(/\D/g, ''));
  }
  if (!out.length && /^[A-Za-z0-9_-]{8,}$/.test(s) && !s.includes('.')) push(s);
  return out;
}

function mediaSummary(node) {
  if (!node || typeof node !== 'object') return null;
  const keys = [
    'mimetype', 'fileLength', 'seconds', 'height', 'width', 'caption',
    'fileName', 'title', 'pageCount', 'isPtv', 'gifPlayback', 'viewOnce',
    'directPath', 'url', 'mediaKeyTimestamp', 'jpegThumbnail'
  ];
  const out = {};
  for (const k of keys) {
    if (node[k] == null) continue;
    if (k === 'jpegThumbnail' && (Buffer.isBuffer(node[k]) || node[k] instanceof Uint8Array)) {
      out.jpegThumbnailBytes = node[k].length;
    } else if (Buffer.isBuffer(node[k]) || node[k] instanceof Uint8Array) {
      out[k] = `<bin ${node[k].length}b>`;
    } else {
      out[k] = node[k];
    }
  }
  if (node.mediaKey) out.mediaKey = `<bin ${Buffer.isBuffer(node.mediaKey) ? node.mediaKey.length : '?'}b>`;
  if (node.fileSha256) out.fileSha256 = Buffer.isBuffer(node.fileSha256) ? node.fileSha256.toString('hex') : jsonSafe(node.fileSha256);
  if (node.fileEncSha256) out.fileEncSha256 = Buffer.isBuffer(node.fileEncSha256) ? node.fileEncSha256.toString('hex') : jsonSafe(node.fileEncSha256);
  return Object.keys(out).length ? out : null;
}

function protoText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  return msg.conversation
    || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || msg.videoMessage?.caption
    || msg.documentMessage?.caption
    || msg.audioMessage?.caption
    || '';
}

function listProtoTypes(msg) {
  if (!msg || typeof msg !== 'object') return [];
  return Object.keys(msg).filter((k) => msg[k] != null && k !== 'messageContextInfo');
}

async function usyncPeek(conn, jid) {
  if (!conn || typeof conn.executeUSyncQuery !== 'function') return { ok: false, value: UNAVAIL };
  try {
    const { USyncQuery, USyncUser } = require('@systemzero/baileys');
    const user = new USyncUser();
    if (String(jid).includes('@lid')) user.withLid(jid);
    else if (String(jid).includes('@s.whatsapp.net') || String(jid).includes('@c.us')) user.withId(jid).withPhone(String(jid).split('@')[0]);
    else user.withId(jid);
    const q = new USyncQuery()
      .withLIDProtocol()
      .withDeviceProtocol()
      .withStatusProtocol()
      .withContactProtocol()
      .withDisappearingModeProtocol()
      .withUser(user);
    return await safeCall('executeUSyncQuery', () => Promise.race([
      conn.executeUSyncQuery(q),
      new Promise((_, rej) => setTimeout(() => rej(new Error('usync timeout')), 4000))
    ]));
  } catch (e) {
    return { ok: false, value: UNAVAIL, error: String(e && e.message ? e.message : e).slice(0, 120) };
  }
}

/**
 * Disseca envelope WA (key + proto + contextInfo + midia) via APIs do fork System Zero.
 */
function dissectWaMessage(info, opts = {}) {
  const { getContentType, extractMessageContent, getDevice } = require('@systemzero/baileys');
  const { unwrapWaMessage } = require('../contextParser');
  const envelope = info || {};
  const key = envelope.key || {};
  const raw = envelope.message || {};
  const inner = unwrapWaMessage(raw) || extractMessageContent(raw) || raw;
  const contentType = getContentType(inner) || getContentType(raw) || listProtoTypes(inner)[0] || 'unknown';
  const payload = inner && inner[contentType] && typeof inner[contentType] === 'object'
    ? inner[contentType]
    : inner;
  const ctxInfo = payload && payload.contextInfo ? payload.contextInfo : {};
  const quotedRaw = ctxInfo.quotedMessage || null;
  const quotedInner = quotedRaw ? (unwrapWaMessage(quotedRaw) || quotedRaw) : null;

  return {
    key: {
      id: key.id || null,
      remoteJid: key.remoteJid || null,
      remoteJidAlt: key.remoteJidAlt || null,
      fromMe: !!key.fromMe,
      participant: key.participant || null,
      participantAlt: key.participantAlt || null,
      participantPn: key.participantPn || key.participantAlt || null,
      addressingMode: key.addressingMode || null,
      server_id: key.server_id || null
    },
    device: key.id ? getDevice(String(key.id)) : UNAVAIL,
    pushName: envelope.pushName || envelope.verifiedBizName || UNAVAIL,
    messageTimestamp: envelope.messageTimestamp || null,
    messageTimestampIso: fmtTs(envelope.messageTimestamp),
    status: envelope.status != null ? envelope.status : UNAVAIL,
    broadcast: envelope.broadcast != null ? !!envelope.broadcast : UNAVAIL,
    multicast: envelope.multicast != null ? !!envelope.multicast : UNAVAIL,
    messageStubType: envelope.messageStubType != null ? envelope.messageStubType : UNAVAIL,
    messageStubParameters: envelope.messageStubParameters || UNAVAIL,
    labels: envelope.labels || UNAVAIL,
    userReceipt: jsonSafe(envelope.userReceipt),
    reactions: jsonSafe(envelope.reactions),
    pollUpdates: jsonSafe(envelope.pollUpdates),
    eventResponses: jsonSafe(envelope.eventResponses),
    contentType,
    protoTypes: listProtoTypes(inner),
    wrapperTypes: listProtoTypes(raw).filter((k) => k !== contentType),
    text: protoText(inner) || protoText(raw) || protoText(payload) || '',
    media: mediaSummary(payload) || mediaSummary(inner?.imageMessage) || mediaSummary(inner?.videoMessage)
      || mediaSummary(inner?.audioMessage) || mediaSummary(inner?.documentMessage) || mediaSummary(inner?.stickerMessage),
    payment: !!(inner?.requestPaymentMessage || inner?.sendPaymentMessage || inner?.paymentInviteMessage
      || inner?.invoiceMessage || inner?.declinePaymentRequestMessage || inner?.cancelPaymentRequestMessage),
    viewOnce: !!(raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension || payload?.viewOnce),
    ephemeral: !!(raw.ephemeralMessage || ctxInfo.expiration || ctxInfo.ephemeralSettingTimestamp),
    edited: !!(raw.editedMessage || raw.protocolMessage?.editedMessage),
    contextInfo: jsonSafe(ctxInfo),
    mentionedJid: Array.isArray(ctxInfo.mentionedJid) ? ctxInfo.mentionedJid : [],
    mentionedHidden: (() => {
      const n = Array.isArray(ctxInfo.mentionedJid) ? ctxInfo.mentionedJid.length : 0;
      const body = String(protoText(inner) || protoText(raw) || protoText(payload) || '');
      const visible = body.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u00a0]/g, '').trim();
      const atCount = (visible.match(/@/g) || []).length;
      return n > 0 && (visible.length === 0 || atCount === 0);
    })(),
    groupMentions: jsonSafe(ctxInfo.groupMentions),
    groupStatusContext: !!(
      ctxInfo.isGroupStatus ||
      ctxInfo.statusSourceType != null ||
      ctxInfo.statusAttributionType != null ||
      ctxInfo.statusMentionMessage ||
      (Array.isArray(ctxInfo.statusMentioned) && ctxInfo.statusMentioned.length)
    ),
    forwardingScore: ctxInfo.forwardingScore ?? 0,
    isForwarded: !!ctxInfo.isForwarded,
    quoted: quotedRaw ? {
      stanzaId: ctxInfo.stanzaId || null,
      participant: ctxInfo.participant || null,
      participantPn: ctxInfo.participantPn || ctxInfo.participantAlt || null,
      participantAlt: ctxInfo.participantAlt || null,
      remoteJid: ctxInfo.remoteJid || null,
      types: [...new Set([...listProtoTypes(quotedRaw), ...listProtoTypes(quotedInner)])],
      contentType: getContentType(quotedInner) || getContentType(quotedRaw) || listProtoTypes(quotedRaw)[0] || 'unknown',
      text: protoText(quotedInner) || protoText(quotedRaw),
      payment: !!(quotedInner?.requestPaymentMessage || quotedRaw?.requestPaymentMessage
        || quotedInner?.sendPaymentMessage || quotedRaw?.sendPaymentMessage
        || quotedInner?.paymentInviteMessage || quotedRaw?.paymentInviteMessage),
      media: mediaSummary((quotedInner && quotedInner[getContentType(quotedInner)]) || quotedInner),
      raw: jsonSafe(quotedRaw),
      rawInner: quotedInner && quotedInner !== quotedRaw ? jsonSafe(quotedInner) : undefined
    } : null,
    rawInner: jsonSafe(inner),
    rawEnvelope: opts.includeRawEnvelope === false ? undefined : jsonSafe(envelope)
  };
}

/**
 * Resolve entrada livre → { type, jid, inviteCode?, resolvedVia }
 * Aceita: jid completo, so digitos, link channel/, link chat.whatsapp.com/, invite 0029...
 */
async function resolveTargetInput(conn, rawInput) {
  let raw = String(rawInput || '').trim();
  if (!raw) return { type: 'unknown', jid: '', resolvedVia: 'empty' };

  // Remove mencao markup / <> 
  raw = raw.replace(/^<|>$/g, '').replace(/^@/, '');

  // Link canal: https://whatsapp.com/channel/CODE ou www.whatsapp.com/channel/CODE
  const chLink = raw.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
  if (chLink) {
    const code = chLink[1];
    const metaR = await safeCall('newsletterMetadata(invite)', () =>
      conn.newsletterMetadata('invite', code)
    );
    const meta = metaR.ok ? metaR.value : null;
    const jid = pick(meta, ['id', 'jid', 'thread_metadata.id'], '') || '';
    if (jid) {
      return {
        type: 'newsletter',
        jid: ensureJidString(jid, jid),
        inviteCode: code,
        resolvedVia: 'channel_link',
        seedMeta: meta
      };
    }
    return {
      type: 'newsletter',
      jid: '',
      inviteCode: code,
      resolvedVia: 'channel_link_unresolved',
      seedMeta: meta,
      error: metaR.error || 'nao resolveu jid do invite'
    };
  }

  // Link grupo: chat.whatsapp.com/CODE
  const gLink = raw.match(/(?:https?:\/\/)?(?:www\.)?chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
  if (gLink) {
    const code = gLink[1];
    if (typeof conn.groupGetInviteInfo === 'function') {
      const infoR = await safeCall('groupGetInviteInfo', () => conn.groupGetInviteInfo(code));
      if (infoR.ok && infoR.value?.id) {
        return {
          type: 'group',
          jid: ensureJidString(infoR.value.id, infoR.value.id),
          inviteCode: code,
          resolvedVia: 'group_link',
          seedMeta: infoR.value
        };
      }
    }
    return { type: 'group', jid: '', inviteCode: code, resolvedVia: 'group_link_unresolved' };
  }

  // JID completo
  if (raw.includes('@')) {
    const c = classifyJid(raw);
    if (c.type !== 'unknown') return { ...c, resolvedVia: 'jid' };
  }

  // So digitos: canal (@newsletter) se longo; PV se parece telefone
  if (/^\d{10,}$/.test(raw)) {
    // Canais WA costumam ser 15+ digitos (120363...)
    if (raw.length >= 15 || raw.startsWith('120363')) {
      const jid = `${raw}@newsletter`;
      return { type: 'newsletter', jid, resolvedVia: 'digits_newsletter' };
    }
    const jid = `${raw}@s.whatsapp.net`;
    return { type: 'pv', jid, resolvedVia: 'digits_phone' };
  }

  // Invite code canal (0029... ou alfanumerico sem @)
  if (/^[A-Za-z0-9_-]{8,}$/.test(raw) && !raw.includes('.')) {
    const metaR = await safeCall('newsletterMetadata(invite)', () =>
      conn.newsletterMetadata('invite', raw)
    );
    const meta = metaR.ok ? metaR.value : null;
    const jid = pick(meta, ['id', 'jid', 'thread_metadata.id'], '') || '';
    if (jid) {
      return {
        type: 'newsletter',
        jid: ensureJidString(jid, jid),
        inviteCode: raw,
        resolvedVia: 'invite_code',
        seedMeta: meta
      };
    }
    // Tenta como invite de grupo
    if (typeof conn.groupGetInviteInfo === 'function') {
      const infoR = await safeCall('groupGetInviteInfo', () => conn.groupGetInviteInfo(raw));
      if (infoR.ok && infoR.value?.id) {
        return {
          type: 'group',
          jid: ensureJidString(infoR.value.id, infoR.value.id),
          inviteCode: raw,
          resolvedVia: 'group_invite_code',
          seedMeta: infoR.value
        };
      }
    }
    return {
      type: 'newsletter',
      jid: '',
      inviteCode: raw,
      resolvedVia: 'invite_unresolved',
      error: metaR.error || 'invite nao resolveu'
    };
  }

  return { type: 'unknown', jid: '', resolvedVia: 'unrecognized', raw };
}

function flattenMetaKeys(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const flat = {};
  const walk = (obj, prefix = '') => {
    if (!obj || typeof obj !== 'object' || Buffer.isBuffer(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v == null) {
        flat[key] = null;
      } else if (typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)) {
        const u = unwrap(v);
        if (u !== v && (typeof u === 'string' || typeof u === 'number')) {
          flat[key] = u;
        }
        walk(v, key);
      } else if (Array.isArray(v)) {
        flat[key] = `array(${v.length})`;
      } else if (typeof v !== 'function') {
        flat[key] = v;
      }
    }
  };
  walk(meta);
  return flat;
}

async function dissectGroup(conn, jid, seedMeta = null) {
  const fields = { rawMeta: null, flatKeys: {} };
  const metaR = seedMeta
    ? { ok: true, value: seedMeta }
    : await safeCall('groupMetadata', async () => {
        const { getCachedGroupMetadata } = require('./groupMetaCache');
        return getCachedGroupMetadata(conn, jid);
      });
  const meta = metaR.ok ? metaR.value : null;
  fields.metadata = metaR.ok ? 'ok' : metaR.value;
  fields.rawMeta = meta ? jsonSafe(meta) : null;
  fields.flatKeys = flattenMetaKeys(meta);

  if (meta) {
    fields.id = meta.id || jid;
    fields.subject = meta.subject || UNAVAIL;
    fields.subjectOwner = meta.subjectOwner || UNAVAIL;
    fields.subjectTime = fmtTs(meta.subjectTime);
    fields.desc = meta.desc || UNAVAIL;
    fields.descOwner = meta.descOwner || UNAVAIL;
    fields.descId = meta.descId || UNAVAIL;
    fields.creation = fmtTs(meta.creation);
    fields.owner = meta.owner || meta.ownerJid || UNAVAIL;
    fields.ownerPn = meta.ownerPn || UNAVAIL;
    fields.ownerCountry = meta.owner_country_code || UNAVAIL;
    fields.size = meta.size ?? (meta.participants || []).length;
    fields.announce = meta.announce != null ? !!meta.announce : UNAVAIL;
    fields.restrict = meta.restrict != null ? !!meta.restrict : UNAVAIL;
    fields.joinApprovalMode = meta.joinApprovalMode != null ? !!meta.joinApprovalMode : UNAVAIL;
    fields.memberAddMode = meta.memberAddMode != null ? String(meta.memberAddMode) : UNAVAIL;
    fields.ephemeralDuration = meta.ephemeralDuration ?? UNAVAIL;
    fields.isCommunity = meta.isCommunity != null ? !!meta.isCommunity : UNAVAIL;
    fields.isCommunityAnnounce = meta.isCommunityAnnounce != null ? !!meta.isCommunityAnnounce : UNAVAIL;
    fields.linkedParent = meta.linkedParent || UNAVAIL;
    fields.addressingMode = meta.addressingMode || UNAVAIL;
    fields.author = meta.author || UNAVAIL;
    fields.authorPn = meta.authorPn || UNAVAIL;
    fields.subjectOwnerPn = meta.subjectOwnerPn || UNAVAIL;
    fields.descOwnerPn = meta.descOwnerPn || UNAVAIL;
    fields.descTime = fmtTs(meta.descTime);
    const parts = meta.participants || [];
    fields.participantsCount = parts.length;
    fields.admins = parts
      .filter((p) => p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin || p.isSuperAdmin)
      .map((p) => `${p.id}${p.admin === 'superadmin' || p.isSuperAdmin ? ' (super)' : ''}`);
    fields.participants = parts.map((p) => ({
      id: p.id,
      lid: p.lid || null,
      phoneNumber: p.phoneNumber || p.jid || null,
      admin: p.admin || (p.isSuperAdmin ? 'superadmin' : p.isAdmin ? 'admin' : null)
    }));
  }

  const pic = await safeCall('profilePictureUrl', () =>
    conn.profilePictureUrl(jid, 'image').catch(() => conn.profilePictureUrl(jid, 'preview'))
  );
  fields.picture = pic.ok ? pic.value : pic.value;

  const invite = await safeCall('groupInviteCode', () => conn.groupInviteCode(jid));
  fields.inviteCode = invite.ok ? invite.value : invite.value;
  if (invite.ok && invite.value) {
    fields.inviteLink = `https://chat.whatsapp.com/${invite.value}`;
  } else {
    fields.inviteLink = invite.value;
  }

  try {
    const { listPending, attachJoinRequestApi } = require('./joinRequestManager');
    attachJoinRequestApi(conn);
    const req = await safeCall('joinRequests', () => listPending(conn, jid));
    fields.joinRequests = req.ok ? jsonSafe(req.value) : req.value;
  } catch (_) {
    fields.joinRequests = UNAVAIL;
  }

  if (fields.isCommunity && typeof conn.communityFetchLinkedGroups === 'function') {
    const linked = await safeCall('communityFetchLinkedGroups', () => conn.communityFetchLinkedGroups(jid));
    fields.linkedGroups = linked.ok ? jsonSafe(linked.value) : linked.value;
  } else {
    fields.linkedGroups = UNAVAIL;
  }

  return fields;
}

async function dissectNewsletter(conn, jid, opts = {}) {
  const { inviteCode = null, seedMeta = null } = opts;
  const fields = {
    id: jid || UNAVAIL,
    inviteCodeTried: inviteCode || null,
    rawMeta: null,
    flatKeys: {}
  };

  let meta = seedMeta;
  let metaSource = seedMeta ? 'seed' : null;

  // 1) Por JID
  if (!meta && jid) {
    const byJid = await safeCall('newsletterMetadata(jid)', () =>
      conn.newsletterMetadata('jid', jid)
    );
    if (byJid.ok) {
      meta = byJid.value;
      metaSource = 'jid';
    } else {
      fields.metadataJidError = byJid.error || byJid.value;
    }
  }

  // 2) Por invite (se tiver codigo)
  if (inviteCode) {
    const byInv = await safeCall('newsletterMetadata(invite)', () =>
      conn.newsletterMetadata('invite', inviteCode)
    );
    if (byInv.ok && byInv.value) {
      // Prefer invite meta se jid falhou; senao merge
      if (!meta) {
        meta = byInv.value;
        metaSource = 'invite';
      } else {
        fields.metaViaInvite = jsonSafe(byInv.value);
      }
      const resolvedId = pick(byInv.value, ['id', 'jid', 'thread_metadata.id'], '');
      if (resolvedId) {
        fields.id = ensureJidString(resolvedId, resolvedId);
        if (!jid) jid = fields.id;
      }
    } else {
      fields.metadataInviteError = byInv.error || byInv.value;
    }
  }

  // 3) Se ainda sem meta e jid parece numerico, tenta de novo
  if (!meta && jid && /^\d+@newsletter$/i.test(jid)) {
    const retry = await safeCall('newsletterMetadata(jid-retry)', () =>
      conn.newsletterMetadata('jid', jid)
    );
    if (retry.ok) {
      meta = retry.value;
      metaSource = 'jid-retry';
    }
  }

  fields.metadata = meta ? 'ok' : UNAVAIL;
  fields.metaSource = metaSource || UNAVAIL;
  fields.rawMeta = meta ? jsonSafe(meta) : null;
  fields.flatKeys = flattenMetaKeys(meta);

  if (meta) {
    const tm = meta.thread_metadata || meta.threadMetadata || {};
    fields.id = pick(meta, ['id', 'jid'], jid || UNAVAIL);
    fields.name = pick(meta, ['name', 'thread_metadata.name', 'threadMetadata.name'], UNAVAIL);
    fields.description = pick(meta, ['description', 'thread_metadata.description', 'threadMetadata.description'], UNAVAIL);
    fields.subscribers =
      meta.subscribers_count ??
      meta.subscribers ??
      tm.subscribers_count ??
      tm.subscribersCount ??
      UNAVAIL;
    fields.verification = pick(meta, ['verification', 'thread_metadata.verification'], UNAVAIL);
    fields.invite = pick(meta, ['invite', 'thread_metadata.invite', 'invite_code'], UNAVAIL);
    if (fields.invite && fields.invite !== UNAVAIL) {
      fields.inviteLink = `https://whatsapp.com/channel/${fields.invite}`;
    } else if (inviteCode) {
      fields.invite = inviteCode;
      fields.inviteLink = `https://whatsapp.com/channel/${inviteCode}`;
    } else {
      fields.inviteLink = UNAVAIL;
    }
    fields.creation = fmtTs(
      meta.creation_time || meta.creationTime || tm.creation_time || tm.creationTime
    );
    fields.pictureMeta = pick(meta, ['picture', 'thread_metadata.picture', 'preview'], UNAVAIL);
    fields.viewerMetadata = meta.viewer_metadata || meta.viewerMetadata || UNAVAIL;
    const vm = fields.viewerMetadata !== UNAVAIL ? fields.viewerMetadata : {};
    fields.mute = vm?.mute ?? UNAVAIL;
    fields.role = vm?.role ?? UNAVAIL;
    fields.state = pick(meta, ['state', 'thread_metadata.state'], UNAVAIL);
    fields.handle = pick(meta, ['handle', 'thread_metadata.handle'], UNAVAIL);
    fields.newsletter_type = pick(meta, ['newsletter_type', 'type', 'thread_metadata.newsletter_type'], UNAVAIL);
  } else {
    [
      'name', 'description', 'subscribers', 'verification', 'invite', 'inviteLink',
      'creation', 'pictureMeta', 'mute', 'role', 'state', 'handle', 'newsletter_type'
    ].forEach((k) => { if (fields[k] == null) fields[k] = UNAVAIL; });
    if (inviteCode) {
      fields.invite = inviteCode;
      fields.inviteLink = `https://whatsapp.com/channel/${inviteCode}`;
    }
  }

  const resolvedJid = (fields.id && String(fields.id).includes('@')) ? fields.id : jid;

  if (resolvedJid && typeof conn.newsletterSubscribers === 'function') {
    const subs = await safeCall('newsletterSubscribers', () => conn.newsletterSubscribers(resolvedJid));
    if (subs.ok) {
      fields.subscribersApi = subs.value?.subscribers ?? subs.value;
      if (fields.subscribers === UNAVAIL) fields.subscribers = fields.subscribersApi;
    } else {
      fields.subscribersApi = subs.value;
    }
  } else {
    fields.subscribersApi = UNAVAIL;
  }

  if (resolvedJid && typeof conn.newsletterAdminCount === 'function') {
    const adm = await safeCall('newsletterAdminCount', () => conn.newsletterAdminCount(resolvedJid));
    fields.adminCount = adm.ok ? adm.value : adm.value;
  } else {
    fields.adminCount = UNAVAIL;
  }

  if (resolvedJid && typeof conn.subscribeNewsletterUpdates === 'function') {
    const sub = await safeCall('subscribeNewsletterUpdates', () =>
      conn.subscribeNewsletterUpdates(resolvedJid)
    );
    fields.subscribeUpdates = sub.ok ? jsonSafe(sub.value) : sub.value;
  } else {
    fields.subscribeUpdates = UNAVAIL;
  }

  if (resolvedJid && typeof conn.newsletterFetchMessages === 'function') {
    const msgs = await safeCall('newsletterFetchMessages', () =>
      conn.newsletterFetchMessages(resolvedJid, 5, 0, 0)
    );
    if (msgs.ok) {
      const list = Array.isArray(msgs.value) ? msgs.value : (msgs.value?.messages || msgs.value);
      fields.recentMessagesCount = Array.isArray(list) ? list.length : UNAVAIL;
      fields.recentMessages = Array.isArray(list)
        ? list.slice(0, 5).map((m) => ({
          id: m?.message?.key?.id || m?.key?.id || m?.serverId || m?.id || '?',
          ts: m?.messageTimestamp || m?.timestamp || null
        }))
        : jsonSafe(msgs.value);
    } else {
      fields.recentMessages = msgs.value;
      fields.recentMessagesCount = UNAVAIL;
    }
  } else {
    fields.recentMessages = UNAVAIL;
    fields.recentMessagesCount = UNAVAIL;
  }

  if (resolvedJid) {
    const pic = await safeCall('profilePictureUrl', () =>
      conn.profilePictureUrl(resolvedJid, 'image').catch(() =>
        conn.profilePictureUrl(resolvedJid, 'preview')
      )
    );
    fields.picture = pic.ok ? pic.value : pic.value;
  } else {
    fields.picture = UNAVAIL;
  }

  return { fields, jid: resolvedJid || jid || '' };
}

async function dissectPv(conn, jid) {
  const fields = { rawMeta: {}, flatKeys: {} };

  if (typeof conn.onWhatsApp === 'function') {
    const phone = jid.split('@')[0].split(':')[0];
    const ow = await safeCall('onWhatsApp', () => conn.onWhatsApp(phone).catch(() => conn.onWhatsApp(jid)));
    if (ow.ok && Array.isArray(ow.value) && ow.value[0]) {
      fields.exists = !!ow.value[0].exists;
      fields.jid = ow.value[0].jid || jid;
      fields.lid = ow.value[0].lid || UNAVAIL;
      fields.notify = ow.value[0].notify || UNAVAIL;
      fields.onWhatsAppRaw = jsonSafe(ow.value[0]);
    } else {
      fields.exists = ow.value;
      fields.jid = jid;
      fields.notify = UNAVAIL;
      fields.lid = UNAVAIL;
    }
  } else {
    fields.exists = UNAVAIL;
    fields.jid = jid;
    fields.notify = UNAVAIL;
    fields.lid = UNAVAIL;
  }

  try {
    const { getPhoneForLid, getLidForPhone } = require('../utils');
    if (String(jid).includes('@lid')) {
      const pn = getPhoneForLid(jid);
      if (pn) fields.mappedPn = pn;
      if (fields.lid === UNAVAIL) fields.lid = jid;
    } else {
      const digits = String(jid).split('@')[0].replace(/\D/g, '');
      const lid = digits ? getLidForPhone(digits) : '';
      if (lid) fields.mappedLid = lid;
      if (fields.lid === UNAVAIL && lid) fields.lid = lid;
    }
  } catch (_) { /* mapping opcional */ }

  const usync = await usyncPeek(conn, fields.jid || jid);
  fields.usync = usync.ok ? jsonSafe(usync.value) : usync.value;

  if (typeof conn.getUSyncDevices === 'function') {
    const dev = await safeCall('getUSyncDevices', () =>
      Promise.race([
        conn.getUSyncDevices([fields.jid || jid], true, false),
        new Promise((_, rej) => setTimeout(() => rej(new Error('devices timeout')), 3500))
      ])
    );
    fields.devices = dev.ok ? jsonSafe(dev.value) : dev.value;
  } else {
    fields.devices = UNAVAIL;
  }

  const pic = await safeCall('profilePictureUrl', () =>
    conn.profilePictureUrl(jid, 'image').catch(() => conn.profilePictureUrl(jid, 'preview'))
  );
  fields.picture = pic.ok ? pic.value : pic.value;

  if (typeof conn.fetchStatus === 'function') {
    const st = await safeCall('fetchStatus', () => conn.fetchStatus(jid));
    if (st.ok) {
      const row = Array.isArray(st.value) ? st.value[0] : st.value;
      fields.status = row?.status || row?.statusMsg || JSON.stringify(jsonSafe(row)).slice(0, 300) || UNAVAIL;
      fields.statusRaw = jsonSafe(row);
    } else {
      fields.status = st.value;
    }
  } else {
    fields.status = UNAVAIL;
  }

  if (typeof conn.fetchDisappearingDuration === 'function') {
    const ep = await safeCall('fetchDisappearingDuration', () => conn.fetchDisappearingDuration(jid));
    fields.disappearing = ep.ok ? jsonSafe(ep.value) : ep.value;
  } else {
    fields.disappearing = UNAVAIL;
  }

  if (typeof conn.getBusinessProfile === 'function') {
    const bp = await safeCall('getBusinessProfile', () => conn.getBusinessProfile(jid));
    if (bp.ok && bp.value) {
      fields.business = jsonSafe(bp.value);
      fields.businessSummary = {
        description: bp.value.description || UNAVAIL,
        category: bp.value.category || bp.value.business_category || UNAVAIL,
        email: bp.value.email || UNAVAIL,
        website: bp.value.website || UNAVAIL,
        address: bp.value.address || UNAVAIL,
        wid: bp.value.wid || UNAVAIL
      };
    } else {
      fields.business = bp.value;
      fields.businessSummary = bp.value;
    }
  } else {
    fields.business = UNAVAIL;
    fields.businessSummary = UNAVAIL;
  }

  if (typeof conn.getCatalog === 'function' && process.env.DISSECAR_CATALOG === '1') {
    const cat = await safeCall('getCatalog', () =>
      Promise.race([
        conn.getCatalog({ jid: fields.jid || jid, limit: 8 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('catalog timeout')), 1500))
      ])
    );
    fields.catalog = cat.ok ? jsonSafe(cat.value) : cat.value;
  } else {
    fields.catalog = UNAVAIL;
  }

  if (typeof conn.getCollections === 'function' && process.env.DISSECAR_CATALOG === '1') {
    const col = await safeCall('getCollections', () =>
      Promise.race([
        conn.getCollections(fields.jid || jid, 8),
        new Promise((_, rej) => setTimeout(() => rej(new Error('collections timeout')), 1500))
      ])
    );
    fields.collections = col.ok ? jsonSafe(col.value) : col.value;
  } else {
    fields.collections = UNAVAIL;
  }

  if (typeof conn.fetchBlocklist === 'function') {
    const bl = await safeCall('fetchBlocklist', () => conn.fetchBlocklist());
    if (bl.ok && Array.isArray(bl.value)) {
      const base = jid.split('@')[0];
      fields.blocked = bl.value.some((x) => String(x) === jid || String(x).includes(base));
      fields.blocklistSize = bl.value.length;
    } else {
      fields.blocked = bl.value;
    }
  } else {
    fields.blocked = UNAVAIL;
  }

  try {
    const { peekAllGroupMetas } = require('./groupMetaCache');
    const common = [];
    const ids = [jid, fields.jid, fields.lid, fields.mappedLid, fields.mappedPn].filter(Boolean).map(String);
    const base = String(jid).split('@')[0];
    for (const g of peekAllGroupMetas() || []) {
      const parts = g.participants || [];
      const hit = parts.some((p) => {
        const cand = [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(String);
        return cand.some((c) => ids.includes(c) || c.startsWith(base));
      });
      if (hit) common.push({ id: g.id, subject: g.subject || '?' });
    }
    fields.commonGroups = common.slice(0, 40);
    fields.commonGroupsCount = common.length;
  } catch (_) {
    fields.commonGroups = UNAVAIL;
    fields.commonGroupsCount = UNAVAIL;
  }

  return fields;
}

/**
 * Extrai metadata completa do alvo (aceita jid, link, invite, digitos).
 */
async function dissectTarget(conn, rawInput) {
  const resolved = await resolveTargetInput(conn, rawInput);
  let { type, jid, inviteCode, seedMeta, resolvedVia, error } = resolved;

  if (type === 'unknown' || (!jid && !inviteCode)) {
    return {
      type: 'unknown',
      jid: String(rawInput || ''),
      fields: { resolvedVia, error: error || 'entrada nao reconhecida' },
      reportText: stripAccents(
        `Entrada invalida: ${String(rawInput || '').slice(0, 80)}\n\n` +
        `Use:\n` +
        `- Canal: jid@newsletter OU link whatsapp.com/channel/CODIGO OU so o codigo\n` +
        `- Grupo: jid@g.us OU link chat.whatsapp.com/CODIGO\n` +
        `- PV: numero@s.whatsapp.net OU so digitos`
      ),
      resolved
    };
  }

  // Canal so com invite (sem jid ainda): disseca mesmo assim
  if (type === 'newsletter' && !jid && inviteCode) {
    const { fields, jid: resolvedJid } = await dissectNewsletter(conn, '', { inviteCode, seedMeta });
    jid = resolvedJid || '';
    fields.resolvedVia = resolvedVia;
    if (!jid) {
      fields.note = 'Invite nao retornou JID — campos parciais abaixo';
    }
    return {
      type: 'newsletter',
      jid: jid || `(invite:${inviteCode})`,
      fields,
      reportText: formatDissectReport('newsletter', jid || inviteCode, fields),
      resolved
    };
  }

  let fields;
  if (type === 'group') {
    fields = await dissectGroup(conn, jid, seedMeta);
  } else if (type === 'newsletter') {
    const out = await dissectNewsletter(conn, jid, { inviteCode, seedMeta });
    fields = out.fields;
    jid = out.jid || jid;
  } else {
    fields = await dissectPv(conn, jid);
  }
  fields.resolvedVia = resolvedVia;
  if (inviteCode) fields.inviteCodeInput = inviteCode;

  return {
    type,
    jid,
    fields,
    reportText: formatDissectReport(type, jid, fields),
    resolved
  };
}

function formatDissectReport(type, jid, fields) {
  const title = type === 'group' ? 'DISSECAR GRUPO'
    : type === 'newsletter' ? 'DISSECAR CANAL'
      : 'DISSECAR PV';

  const rows = [
    labelValue('Tipo', type),
    labelValue('JID / ID', jid),
    labelValue('Via', fields.resolvedVia || UNAVAIL),
    ''
  ];

  if (type === 'group') {
    rows.push(previewText('IDENTIFICACAO'));
    rows.push(labelValue('Nome', fields.subject));
    rows.push(labelValue('ID', fields.id || jid));
    rows.push(labelValue('Dono assunto', fields.subjectOwner));
    rows.push(labelValue('Criacao', fields.creation));
    rows.push(labelValue('Owner', fields.owner));
    rows.push('');
    rows.push(previewText('METADATA'));
    rows.push(labelValue('Desc', String(fields.desc || '').slice(0, 240)));
    rows.push(labelValue('Desc owner', fields.descOwner));
    rows.push(labelValue('Tamanho', fields.size));
    rows.push(labelValue('Announce', fields.announce));
    rows.push(labelValue('Restrict', fields.restrict));
    rows.push(labelValue('Join approval', fields.joinApprovalMode));
    rows.push(labelValue('Member add', fields.memberAddMode));
    rows.push(labelValue('Efemera', fields.ephemeralDuration));
    rows.push(labelValue('Comunidade', fields.isCommunity));
    rows.push(labelValue('Linked parent', fields.linkedParent));
    rows.push(labelValue('Addressing', fields.addressingMode));
    rows.push(labelValue('Owner PN', fields.ownerPn));
    rows.push(labelValue('Author PN', fields.authorPn));
    rows.push(labelValue('Linked groups', typeof fields.linkedGroups === 'object'
      ? JSON.stringify(fields.linkedGroups).slice(0, 80)
      : fields.linkedGroups));
    rows.push('');
    rows.push(previewText('MIDIA / CONVITE'));
    rows.push(labelValue('Foto', fields.picture));
    rows.push(labelValue('Invite code', fields.inviteCode));
    rows.push(labelValue('Invite link', fields.inviteLink));
    rows.push(labelValue('Pedidos entrada', Array.isArray(fields.joinRequests)
      ? fields.joinRequests.length
      : fields.joinRequests));
    rows.push('');
    rows.push(previewText('PARTICIPANTES'));
    rows.push(labelValue('Total', fields.participantsCount));
    const admins = Array.isArray(fields.admins) ? fields.admins.slice(0, 20).join('\n') : fields.admins;
    rows.push(labelValue('Admins', admins));
  } else if (type === 'newsletter') {
    rows.push(previewText('IDENTIFICACAO — COPIE O ID'));
    rows.push(labelValue('ID canal', fields.id || jid));
    rows.push(labelValue('Nome', fields.name));
    rows.push(labelValue('Handle', fields.handle));
    rows.push(labelValue('Desc', String(fields.description || '').slice(0, 240)));
    rows.push(labelValue('Criacao', fields.creation));
    rows.push(labelValue('Estado', fields.state));
    rows.push(labelValue('Tipo', fields.newsletter_type));
    rows.push('');
    rows.push(previewText('CONVITE / LINKS'));
    rows.push(labelValue('Invite code', fields.invite));
    rows.push(labelValue('Invite link', fields.inviteLink));
    rows.push(labelValue('Codigo usado', fields.inviteCodeTried || fields.inviteCodeInput || UNAVAIL));
    rows.push('');
    rows.push(previewText('METADATA'));
    rows.push(labelValue('Inscritos', fields.subscribers));
    rows.push(labelValue('Inscritos API', fields.subscribersApi));
    rows.push(labelValue('Verificacao', fields.verification));
    rows.push(labelValue('Mute', fields.mute));
    rows.push(labelValue('Papel', fields.role));
    rows.push(labelValue('Admin count', fields.adminCount));
    rows.push(labelValue('Meta source', fields.metaSource));
    rows.push(labelValue('Updates sub', typeof fields.subscribeUpdates === 'object'
      ? JSON.stringify(fields.subscribeUpdates).slice(0, 80)
      : fields.subscribeUpdates));
    rows.push('');
    rows.push(previewText('MIDIA / MSGS'));
    rows.push(labelValue('Foto URL', fields.picture));
    rows.push(labelValue('Foto meta', typeof fields.pictureMeta === 'object'
      ? JSON.stringify(fields.pictureMeta).slice(0, 80)
      : fields.pictureMeta));
    rows.push(labelValue('Msgs recentes', fields.recentMessagesCount));
    if (Array.isArray(fields.recentMessages)) {
      for (const m of fields.recentMessages.slice(0, 5)) {
        rows.push(`- id=${m.id} ts=${m.ts || '?'}`);
      }
    }
    if (fields.note) {
      rows.push('');
      rows.push(labelValue('Nota', fields.note));
    }
    // Chaves extras achatadas (tudo que a lib devolveu)
    const flat = fields.flatKeys || {};
    const extraKeys = Object.keys(flat).filter((k) =>
      !/^(id|name|description|invite)$/i.test(k)
    ).slice(0, 40);
    if (extraKeys.length) {
      rows.push('');
      rows.push(previewText('CAMPOS BRUTOS (sample)'));
      for (const k of extraKeys) {
        const v = flat[k];
        rows.push(labelValue(k.slice(0, 40), String(v).slice(0, 80)));
      }
    }
  } else {
    rows.push(previewText('IDENTIFICACAO'));
    rows.push(labelValue('JID', fields.jid || jid));
    rows.push(labelValue('LID', fields.lid));
    rows.push(labelValue('LID map', fields.mappedLid || UNAVAIL));
    rows.push(labelValue('PN map', fields.mappedPn || UNAVAIL));
    rows.push(labelValue('Existe', fields.exists));
    rows.push(labelValue('Notify', fields.notify));
    rows.push(labelValue('Devices', Array.isArray(fields.devices) ? fields.devices.length : typeof fields.devices === 'object' ? 'ok' : fields.devices));
    rows.push('');
    rows.push(previewText('PERFIL'));
    rows.push(labelValue('Status', String(fields.status || '').slice(0, 200)));
    rows.push(labelValue('Foto', fields.picture));
    rows.push(labelValue('Bloqueado', fields.blocked));
    rows.push(labelValue('Efemera', typeof fields.disappearing === 'object'
      ? JSON.stringify(fields.disappearing).slice(0, 100)
      : fields.disappearing));
    rows.push('');
    rows.push(previewText('BUSINESS'));
    const bs = fields.businessSummary;
    if (bs && typeof bs === 'object') {
      rows.push(labelValue('Desc', String(bs.description || '').slice(0, 160)));
      rows.push(labelValue('Categoria', bs.category));
      rows.push(labelValue('Email', bs.email));
      rows.push(labelValue('Site', bs.website));
      rows.push(labelValue('Endereco', bs.address));
    } else {
      rows.push(labelValue('Business', bs));
    }
    rows.push('');
    rows.push(previewText('GRUPOS EM COMUM'));
    rows.push(labelValue('Total', fields.commonGroupsCount));
    if (Array.isArray(fields.commonGroups) && fields.commonGroups.length) {
      for (const g of fields.commonGroups.slice(0, 12)) {
        rows.push(`- ${String(g.subject || '').slice(0, 40)} (${g.id})`);
      }
    }
  }

  return formatReportBlock(title, rows.map((r) => (typeof r === 'string' ? stripAccents(r) : r)));
}

function formatMessageReport(dump) {
  const rows = [
    labelValue('Tipo proto', dump.contentType),
    labelValue('Wrappers', (dump.wrapperTypes || []).join(', ') || '-'),
    labelValue('Device', dump.device),
    labelValue('ID', dump.key?.id),
    labelValue('Chat', dump.key?.remoteJid),
    labelValue('Chat alt', dump.key?.remoteJidAlt),
    labelValue('FromMe', dump.key?.fromMe),
    labelValue('Participant', dump.key?.participant),
    labelValue('Participant alt', dump.key?.participantAlt),
    labelValue('Addressing', dump.key?.addressingMode),
    labelValue('Push name', dump.pushName),
    labelValue('Quando', dump.messageTimestampIso),
    labelValue('Texto', String(dump.text || '').slice(0, 280)),
    labelValue('Forward', `${dump.isForwarded ? 'sim' : 'nao'} score=${dump.forwardingScore}`),
    labelValue('ViewOnce', dump.viewOnce),
    labelValue('Ephemeral', dump.ephemeral),
    labelValue('Edited', dump.edited),
    labelValue('Pagamento', dump.payment),
    labelValue('Mencoes', Array.isArray(dump.mentionedJid) ? dump.mentionedJid.length : 0),
    labelValue('Mencao invisivel', dump.mentionedHidden),
    labelValue('Status GP ctx', dump.groupStatusContext)
  ];
  if (dump.media) {
    rows.push(labelValue('Midia', dump.media.mimetype || 'sim'));
    rows.push(labelValue('Tamanho', dump.media.fileLength));
    rows.push(labelValue('Nome', dump.media.fileName));
  }
  if (dump.quoted) {
    rows.push('');
    rows.push(previewText('CITADA'));
    rows.push(labelValue('Tipo', dump.quoted.contentType));
    rows.push(labelValue('Tipos proto', (dump.quoted.types || []).join(', ') || '-'));
    rows.push(labelValue('Autor', dump.quoted.participant));
    rows.push(labelValue('Autor PN', dump.quoted.participantPn));
    rows.push(labelValue('Stanza', dump.quoted.stanzaId));
    rows.push(labelValue('Pagamento', dump.quoted.payment));
    rows.push(labelValue('Texto', String(dump.quoted.text || '').slice(0, 200)));
  }
  return formatReportBlock('DISSECAR MENSAGEM', rows.map((r) => (typeof r === 'string' ? stripAccents(r) : r)));
}

module.exports = {
  classifyJid,
  resolveTargetInput,
  parseLooseTargets,
  dissectTarget,
  dissectWaMessage,
  formatDissectReport,
  formatMessageReport,
  maskJid,
  jsonSafe,
  UNAVAIL,
  PRIVACY
};
