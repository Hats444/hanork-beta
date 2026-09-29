'use strict';
/**
 * Status de grupo V2 (bandeja).
 *
 * Caminho certo: sendMessage({ image|video|text, groupStatus: true }).
 * A lib envolve groupStatusMessageV2. Proto live (dissecar): isGroupStatus
 * + statusSourceType 4 (TEXT numerico), sem pairedMediaType no texto.
 *
 * participant sozinho = retry pairwise da lib → bandeja vazia.
 * REVOKE / edit=7 no mesmo id = o servidor tira a bandeja de todo mundo.
 * Modo membros: 1 skmsg no grupo com meta so de membros+bot E sender-key
 * nova (admin nao recebe a chave). Mencoes = membros, ignora admins (igual a DIV).
 * Divulgacao de status/pagamento usa mode=membros (admin fora da cifra).
 *
 * Status de canal (help WA: Channel status 24h): mesmo wrap no JID @newsletter.
 */
const crypto = require('crypto');
const logger = require('../logger');
const {
  generateMessageIDV2,
  generateWAMessage,
  generateWAMessageContent,
  generateWAMessageFromContent,
  downloadMediaMessage,
  jidDecode,
  WAJIDDomains
} = require('@systemzero/baileys');
const { getCachedGroupMetadata, peekGroupMetadata, putGroupMetadata, cloneGroupMeta } = require('./groupMetaCache');

const DIRECTED_GAP_MS = 120;
const META_TIMEOUT_MS = 10000;
/** proto ContextInfo.StatusSourceType.TEXT — dump live veio numero 4, nao string. */
const STATUS_SOURCE_TEXT = 4;
/** @type {Map<string, Promise<unknown>>} */
const metaLocks = new Map();

function directedCap() {
  const n = Number(process.env.HANORK_STATUS_DIRECTED_CAP || 80);
  if (!Number.isFinite(n) || n <= 0) return 80;
  return Math.min(250, Math.floor(n));
}

function parseStatusMode(args) {
  const tokens = (args || []).map((a) => String(a || '').toLowerCase());
  if (tokens.some((t) => t === 'todos' || t === 'all' || t === 'grupo' || t === 'tray')) {
    return 'todos';
  }
  if (tokens.some((t) => t === 'canal' || t === 'channel' || t === 'newsletter')) {
    return 'canal';
  }
  return 'membros';
}

function stripModeArgs(args) {
  return (args || []).filter((a) => !/^(membros|members|todos|all|grupo|tray|canal|channel|newsletter)$/i.test(String(a || '')));
}

function isNewsletterJid(jid) {
  return /^\d{10,}@newsletter$/i.test(String(jid || '').trim());
}

function resolveCanalJid(raw) {
  const s = String(raw || '').trim();
  if (isNewsletterJid(s)) return s;
  try {
    const { getCanalId } = require('./canal');
    const fallback = getCanalId();
    if (isNewsletterJid(fallback)) return fallback;
  } catch (_) { /* */ }
  return '';
}

function mentionCap() {
  const n = Number(process.env.HANORK_DIV_MENTION_CAP || 80);
  if (!Number.isFinite(n) || n <= 0) return 80;
  return Math.min(500, Math.floor(n));
}

function statusContextInfo(extra) {
  const src = extra && typeof extra === 'object' ? extra : {};
  const mentions = Array.isArray(src.mentionedJid)
    ? src.mentionedJid
    : (Array.isArray(src.mentions) ? src.mentions : []);
  const out = {
    isGroupStatus: true,
    statusSourceType: STATUS_SOURCE_TEXT,
    mentionedJid: mentions,
    groupMentions: Array.isArray(src.groupMentions) ? src.groupMentions : [],
    statusAttributions: Array.isArray(src.statusAttributions) ? src.statusAttributions : []
  };
  if (src.pairedMediaType) out.pairedMediaType = src.pairedMediaType;
  if (src.closeFriends || src.statusAudienceMetadata) {
    out.statusAudienceMetadata = src.statusAudienceMetadata || { audienceType: 1 };
  }
  return out;
}

function collectBotIds(conn) {
  const ids = new Set();
  const add = (jid) => {
    if (!jid || typeof jid !== 'string') return;
    ids.add(jid);
    const user = jid.split('@')[0].split(':')[0];
    if (user) {
      ids.add(`${user}@s.whatsapp.net`);
      ids.add(`${user}@lid`);
    }
  };
  const u = conn?.user;
  if (u) {
    add(u.id);
    add(u.lid);
    add(u.jid);
    add(u.phoneNumber);
  }
  return ids;
}

function isGroupAdmin(p) {
  if (!p || typeof p !== 'object') return false;
  const a = p.admin;
  if (a === true || a === 1) return true;
  const s = String(a || '').toLowerCase();
  if (!s || s === 'member' || s === 'participant' || s === 'null' || s === 'false' || s === '0') return false;
  if (s === 'admin' || s === 'superadmin' || s === 'owner' || s === 'super_admin') return true;
  return !!(p.isAdmin || p.isSuperAdmin);
}

function participantIds(p) {
  return [p?.id, p?.jid, p?.lid, p?.phoneNumber].filter(Boolean).map(String);
}

function isBotParticipant(p, botIds) {
  return participantIds(p).some((id) => {
    if (botIds.has(id)) return true;
    const user = id.split('@')[0].split(':')[0];
    return !!(user && (botIds.has(`${user}@s.whatsapp.net`) || botIds.has(`${user}@lid`)));
  });
}

function memberRelayJid(p) {
  const id = String(p?.id || p?.jid || '').trim();
  if (id && !/@g\.us$|@newsletter$/.test(id)) return id;
  const pn = String(p?.phoneNumber || '').replace(/\D/g, '');
  if (pn.length >= 10 && pn.length <= 15) return `${pn}@s.whatsapp.net`;
  return '';
}

function makeStatusId(conn) {
  try {
    if (typeof generateMessageIDV2 === 'function') {
      return generateMessageIDV2(conn?.user?.id);
    }
  } catch (_) { /* fallback */ }
  return '3EB0' + crypto.randomBytes(9).toString('hex').toUpperCase();
}

function sniffTipo(buffer, hinted) {
  const h = String(hinted || '').toLowerCase();
  if (h === 'image' || h === 'video' || h === 'gif') return h;
  if (!buffer || !buffer.length) return '';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'gif';
  if (buffer.length > 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp') return 'video';
  if (buffer[0] === 0x1A && buffer[1] === 0x45) return 'video';
  return 'image';
}

function unwrapMsgNode(node) {
  let msg = node;
  for (let i = 0; i < 8; i++) {
    if (!msg || typeof msg !== 'object') return null;
    if (msg.groupStatusMessageV2?.message) msg = msg.groupStatusMessageV2.message;
    else if (msg.groupStatusMessage?.message) msg = msg.groupStatusMessage.message;
    else if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
    else if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
    else if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
    else if (msg.viewOnceMessageV2Extension?.message) msg = msg.viewOnceMessageV2Extension.message;
    else if (msg.documentWithCaptionMessage?.message) msg = msg.documentWithCaptionMessage.message;
    else break;
  }
  return msg;
}

function mediaKindFromNode(node) {
  const msg = unwrapMsgNode(node) || node;
  if (!msg || typeof msg !== 'object') return { tipo: null, caption: '', node: msg };
  if (msg.imageMessage) {
    return { tipo: 'image', caption: String(msg.imageMessage.caption || ''), node: msg };
  }
  if (msg.videoMessage) {
    const gif = !!msg.videoMessage.gifPlayback;
    return { tipo: gif ? 'gif' : 'video', caption: String(msg.videoMessage.caption || ''), node: msg };
  }
  return { tipo: null, caption: String(msg.conversation || msg.extendedTextMessage?.text || ''), node: msg };
}

async function loadGroupParts(conn, groupId) {
  const started = Date.now();
  let meta;
  try {
    meta = await getCachedGroupMetadata(conn, groupId, { force: true });
  } catch (_) {
    meta = await getCachedGroupMetadata(conn, groupId);
  }
  if (Date.now() - started > META_TIMEOUT_MS) {
    logger.logAviso('[status-v2] meta lenta, segue com cache');
  }
  return {
    parts: meta?.participants || [],
    addressingMode: String(meta?.addressingMode || 'lid').toLowerCase() === 'pn' ? 'pn' : 'lid'
  };
}

async function listEligibleMembers(conn, groupId) {
  const { parts, addressingMode } = await loadGroupParts(conn, groupId);
  const botIds = collectBotIds(conn);
  const adminN = parts.filter(isGroupAdmin).length;
  const members = [];
  const admins = [];
  for (const p of parts) {
    if (!p || isBotParticipant(p, botIds)) continue;
    const relay = memberRelayJid(p);
    if (!relay) continue;
    if (isGroupAdmin(p)) admins.push(relay);
    else members.push(relay);
  }
  if (adminN === 0 && parts.length > 1) {
    logger.logAviso('[status-v2] meta sem flag admin — hide-admin pulado');
  }
  return {
    targets: [...new Set(members)],
    admins: [...new Set(admins)],
    addressingMode,
    adminN,
    total: parts.length
  };
}

function withGroupMetaLock(groupJid, fn) {
  const gid = String(groupJid || '');
  const prev = metaLocks.get(gid) || Promise.resolve();
  const next = prev.then(fn, fn);
  metaLocks.set(gid, next.then(() => undefined, () => undefined));
  return next;
}

function collectMeJids(conn) {
  const u = conn?.user || {};
  const me = conn?.authState?.creds?.me || {};
  return [...new Set(
    [u.id, u.lid, u.jid, u.phoneNumber, me.id, me.lid]
      .filter((jid) => jid && typeof jid === 'string')
      .map(String)
  )];
}

/**
 * ID da sender-key no auth store = SenderKeyName.serialize()
 * = `{group}::{signalUser}::{device}`.
 * LID nao e o user cru: jidToSignalProtocolAddress usa `{user}_{domainType}`
 * (LID=1 → `123_1`). Sem o sufixo o get() volta vazio e a cifra reusa a chave
 * que o admin ja tem — por isso o statuspost ainda aparecia pra adm.
 */
function senderKeyIdForJid(groupJid, meJid) {
  if (!groupJid || !meJid) return '';
  let decoded;
  try {
    decoded = typeof jidDecode === 'function' ? jidDecode(meJid) : null;
  } catch (_) {
    decoded = null;
  }
  if (!decoded || !decoded.user) return '';
  const whatsapp = (WAJIDDomains && WAJIDDomains.WHATSAPP) || 0;
  const domainType = decoded.domainType;
  const signalUser = domainType != null && Number(domainType) !== Number(whatsapp)
    ? `${decoded.user}_${domainType}`
    : decoded.user;
  const device = decoded.device || 0;
  return `${groupJid}::${signalUser}::${device}`;
}

function senderKeyIdFromRepo(conn, groupJid, meJid) {
  try {
    const addr = conn?.signalRepository?.jidToSignalProtocolAddress?.(meJid);
    if (typeof addr !== 'string' || !addr.includes('.')) return '';
    const lastDot = addr.lastIndexOf('.');
    const signalUser = addr.slice(0, lastDot);
    const device = addr.slice(lastDot + 1) || '0';
    if (!signalUser || signalUser === 'undefined') return '';
    return `${groupJid}::${signalUser}::${device}`;
  } catch (_) {
    return '';
  }
}

function senderKeyCandidateIds(conn, groupJid) {
  const out = new Set();
  for (const jid of collectMeJids(conn)) {
    const fromRepo = senderKeyIdFromRepo(conn, groupJid, jid);
    if (fromRepo) out.add(fromRepo);
    const exact = senderKeyIdForJid(groupJid, jid);
    if (exact) out.add(exact);
    let decoded;
    try {
      decoded = typeof jidDecode === 'function' ? jidDecode(jid) : null;
    } catch (_) {
      decoded = null;
    }
    if (!decoded || !decoded.user) continue;
    const variants = [decoded.user, `${decoded.user}_1`, `${decoded.user}_0`];
    if (decoded.domainType != null) variants.push(`${decoded.user}_${decoded.domainType}`);
    const devices = [0];
    if (decoded.device) devices.push(decoded.device);
    for (const id of variants) {
      for (const device of devices) {
        out.add(`${groupJid}::${id}::${device}`);
      }
    }
  }
  return [...out];
}

/**
 * Cifra nova so para a lista filtrada. A sender-key antiga o admin ja tem —
 * filtrar o cache do grupo nao tira a bandeja dele. Gera chave nova, manda,
 * restaura a antiga pra o chat do grupo continuar normal.
 */
async function withRotatedSenderKey(conn, groupJid, fn) {
  const keys = conn?.authState?.keys;
  if (!keys || typeof keys.get !== 'function' || typeof keys.set !== 'function') {
    return fn(false);
  }
  const ids = senderKeyCandidateIds(conn, groupJid);
  let skSnap = null;
  let memSnap = null;
  let found = 0;
  try {
    skSnap = await keys.get('sender-key', ids);
    memSnap = await keys.get('sender-key-memory', [groupJid]);
    if (skSnap && typeof skSnap === 'object') {
      found = Object.values(skSnap).filter((v) => v != null).length;
    }
    const clearSk = {};
    for (const id of ids) clearSk[id] = null;
    await keys.set({
      'sender-key': clearSk,
      'sender-key-memory': { [groupJid]: null }
    });
  } catch (e) {
    logger.logAviso(`[status-v2] rotate skip: ${e.message || e}`);
    return fn(false);
  }
  logger.logInfo(`[status-v2] rotate keys=${found} cands=${ids.length}`);
  try {
    return await fn(true);
  } finally {
    try {
      const restore = {};
      if (skSnap && typeof skSnap === 'object') {
        const sk = {};
        for (const [k, v] of Object.entries(skSnap)) {
          if (v != null) sk[k] = v;
        }
        if (Object.keys(sk).length) restore['sender-key'] = sk;
      }
      if (memSnap && typeof memSnap === 'object') restore['sender-key-memory'] = memSnap;
      if (Object.keys(restore).length) await keys.set(restore);
    } catch (e) {
      logger.logAviso(`[status-v2] rotate restore: ${e.message || e}`);
    }
  }
}

/**
 * 1 skmsg no grupo cifrado so para membros + bot.
 * Admin humano fica de fora da lista de devices — nao recebe a bandeja/pagamento.
 * Bot (mesmo admin) fica na lista senao a sender-key quebra.
 */
async function withMemberOnlyMeta(conn, groupJid, fn) {
  return withGroupMetaLock(groupJid, async () => {
    const orig = peekGroupMetadata(groupJid);
    if (!orig || !Array.isArray(orig.participants) || !orig.participants.length) {
      return fn(false);
    }
    const snapshot = cloneGroupMeta(orig);
    const botIds = collectBotIds(conn);
    const filtered = orig.participants.filter((p) => {
      if (!p) return false;
      if (isBotParticipant(p, botIds)) return true;
      return !isGroupAdmin(p);
    });
    if (filtered.length < 1) return fn(false);
    putGroupMetadata(groupJid, { ...orig, participants: filtered });
    try {
      return await fn(true);
    } finally {
      putGroupMetadata(groupJid, snapshot);
    }
  });
}

function extraCtx(opts) {
  const extra = {};
  if (Array.isArray(opts.mentions) && opts.mentions.length) extra.mentionedJid = opts.mentions;
  if (opts.closeFriends) extra.closeFriends = true;
  return extra;
}

function innerContent(opts = {}) {
  const texto = String(opts.texto || '').trim();
  const buffer = opts.buffer;
  const tipo = sniffTipo(buffer, opts.tipo);
  if (buffer && buffer.length && tipo === 'image') {
    return { kind: 'media', content: { image: buffer, caption: texto, mimetype: opts.mimetype || 'image/jpeg' } };
  }
  if (buffer && buffer.length && tipo === 'gif') {
    return { kind: 'media', content: { video: buffer, gifPlayback: true, caption: texto, mimetype: opts.mimetype || 'video/mp4' } };
  }
  if (buffer && buffer.length && tipo === 'video') {
    return { kind: 'media', content: { video: buffer, caption: texto, mimetype: opts.mimetype || 'video/mp4' } };
  }
  if (texto) {
    return { kind: 'text', content: { text: texto } };
  }
  throw new Error('Status sem texto e sem midia');
}

function attachStatusContext(innerMsg, contextInfo) {
  if (!innerMsg || typeof innerMsg !== 'object') return;
  if (innerMsg.imageMessage) {
    innerMsg.imageMessage.contextInfo = { ...(innerMsg.imageMessage.contextInfo || {}), ...contextInfo };
  } else if (innerMsg.videoMessage) {
    innerMsg.videoMessage.contextInfo = { ...(innerMsg.videoMessage.contextInfo || {}), ...contextInfo };
  } else if (innerMsg.audioMessage) {
    innerMsg.audioMessage.contextInfo = { ...(innerMsg.audioMessage.contextInfo || {}), ...contextInfo };
  } else if (innerMsg.extendedTextMessage) {
    innerMsg.extendedTextMessage.contextInfo = { ...(innerMsg.extendedTextMessage.contextInfo || {}), ...contextInfo };
  } else if (innerMsg.conversation) {
    innerMsg.extendedTextMessage = {
      text: innerMsg.conversation,
      contextInfo
    };
    delete innerMsg.conversation;
  }
}

function hideAdminEnabled() {
  const v = String(process.env.HANORK_STATUS_HIDE_ADMIN || '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function resolveMentions(opts, listed) {
  if (Array.isArray(opts.mentions) && opts.mentions.length) {
    return [...new Set(opts.mentions.filter(Boolean))].slice(0, mentionCap());
  }
  if (opts.mode === 'todos') return [];
  return (listed.targets || []).slice(0, mentionCap());
}

async function sendGroupStatusV2(conn, groupJid, opts = {}) {
  if (isNewsletterJid(groupJid) || opts.mode === 'canal') {
    return sendChannelStatus(conn, groupJid, opts);
  }
  const mode = opts.mode === 'todos' ? 'todos' : 'membros';
  const listed = await listEligibleMembers(conn, groupJid);
  const mentions = resolveMentions({ ...opts, mode }, listed);
  const { kind, content } = innerContent(opts);
  const payload = {
    ...content,
    ...(mentions.length ? { mentions } : {}),
    groupStatus: true,
    contextInfo: statusContextInfo({ ...extraCtx(opts), mentionedJid: mentions })
  };
  const wantHide = mode === 'membros' && opts.hideAdmin !== false && hideAdminEnabled();
  if (mode === 'membros' && !wantHide) {
    logger.logAviso('[status-v2] hide-admin desligado (HANORK_STATUS_HIDE_ADMIN=0)');
  }
  const sendOpts = {
    skipForward: true,
    _hanorkTrusted: true,
    useCachedGroupMetadata: true,
    messageId: String(opts.messageId || '').trim() || makeStatusId(conn)
  };
  const canHide = !!(wantHide && listed.admins.length && listed.targets.length);
  const run = () => conn.sendMessage(groupJid, payload, sendOpts);
  const sent = canHide
    ? await withMemberOnlyMeta(conn, groupJid, async (ok) => {
        if (!ok) return run();
        return withRotatedSenderKey(conn, groupJid, () => run());
      })
    : await run();
  const messageId = sent?.key?.id || sendOpts.messageId || '';
  const hidden = canHide ? listed.admins.length : 0;
  logger.logInfo(
    `[status-v2] groupStatus type=${kind} mode=${mode} id=${String(messageId).slice(0, 12)}` +
    ` members=${listed.targets.length} adminsSkip=${hidden} filter=${canHide ? 1 : 0}`
  );
  return {
    mode,
    sent: 1,
    errors: 0,
    hidden,
    filtered: canHide,
    messageId,
    kind
  };
}

/**
 * Dump live 3EB073F3F7F4B5D75B09C0 (GENGAR): proto TOPO = requestPaymentMessage
 * sozinho (wrappers=-). Sem groupStatusMessageV2, sem statusSourceType/isGroupStatus,
 * sem requestFrom/expiry. Texto em noteMessage; mentionedJid = LIDs do grupo.
 */
function paymentSendPayload(textoPay, mentions) {
  const mentionedJid = Array.isArray(mentions)
    ? [...new Set(mentions.map(String).filter(Boolean))].slice(0, mentionCap())
    : [];
  return {
    requestPaymentMessage: {
      currencyCodeIso4217: 'BRL',
      amount1000: 0,
      noteMessage: {
        extendedTextMessage: {
          text: String(textoPay || ''),
          contextInfo: { mentionedJid }
        }
      }
    }
  };
}

/** @deprecated dump nao usa front; mantido so pra smoke/compat */
function paymentFrontPayload(textoPay) {
  return {
    text: String(textoPay || ''),
    contextInfo: { mentionedJid: [] }
  };
}

/** @deprecated nome antigo — smoke/DIV ainda importam */
function paymentStatusPayload(textoPay, mentions) {
  return paymentSendPayload(textoPay, mentions);
}

function sleep(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

async function buildPaymentWAMessage(conn, groupJid, content) {
  const userJid = conn.user?.id;
  const messageId = makeStatusId(conn);
  const opts = { userJid, messageId, jid: groupJid };
  // Dump: proto ja vem com requestPaymentMessage no topo — FromContent, nao high-level
  // (generateWAMessage injeta requestFrom/expiry/amount e esvazia a note).
  if (content && content.requestPaymentMessage) {
    if (typeof generateWAMessageFromContent !== 'function') {
      throw new Error('generateWAMessageFromContent indisponivel');
    }
    return generateWAMessageFromContent(groupJid, content, opts);
  }
  if (typeof generateWAMessage === 'function') {
    return generateWAMessage(groupJid, content, opts);
  }
  if (typeof generateWAMessageContent !== 'function' || typeof generateWAMessageFromContent !== 'function') {
    throw new Error('generateWAMessage indisponivel');
  }
  const inner = await generateWAMessageContent(content, opts);
  return generateWAMessageFromContent(groupJid, inner, opts);
}

async function relayDirectedCopies(conn, groupJid, proto, messageId, targets, addressing) {
  const { relayDirectedToParticipant } = require('./directedGroupRelay');
  let sent = 0;
  let errors = 0;
  for (let i = 0; i < targets.length; i++) {
    if (i) await sleep(DIRECTED_GAP_MS);
    const r = await relayDirectedToParticipant(conn, {
      groupJid,
      message: proto,
      targetJid: targets[i],
      messageId,
      additionalAttributes: addressing
    });
    if (r && r.ok) sent += 1;
    else errors += 1;
  }
  return { sent, errors };
}

/**
 * Pagamento nativo — dump 3EB073… (requestPaymentMessage TOPO, wrappers=-).
 * SEM wrap V2 / sem front extendedText.
 *
 * Prova live 20/08 21:01: meta+rotate (cipher=member-key, keys=2) NAO esconde
 * requestPaymentMessage do ADM (diferente do statuspost/V2). Hide real = pkmsg
 * dirigido 1x por membro (participant). Chip ADM nao recebe — confere no membro.
 * Opt-out: HANORK_STATUS_HIDE_ADMIN=0 | mode=todos | hideAdmin:false.
 * Experimento cipher (falha): HANORK_PAY_CIPHER=1.
 */
async function sendGroupPaymentMembers(conn, groupJid, opts = {}) {
  const textoPay = String(opts.texto || '').trim();
  if (!textoPay) throw new Error('Texto de pagamento vazio');
  const mode = opts.mode === 'todos' ? 'todos' : 'membros';
  const listed = await listEligibleMembers(conn, groupJid);
  const addressing = listed.addressingMode ? { addressing_mode: listed.addressingMode } : undefined;

  let mentions = Array.isArray(opts.mentions) && opts.mentions.length
    ? opts.mentions.map(String)
    : (mode === 'todos'
      ? [...listed.targets, ...listed.admins]
      : listed.targets.slice());
  mentions = [...new Set(mentions.filter(Boolean))].slice(0, mentionCap());

  const payFull = await buildPaymentWAMessage(conn, groupJid, paymentSendPayload(textoPay, mentions));
  const payMsg = payFull.message;
  const payId = String(payFull.key?.id || '').trim() || makeStatusId(conn);
  const topKeys = Object.keys(payMsg || {}).filter((k) => k !== 'messageContextInfo');
  const rpm = payMsg?.requestPaymentMessage;
  const note = rpm?.noteMessage?.extendedTextMessage;
  const amt = rpm?.amount1000;
  const amountOk = amt === 0 || amt === 0n
    || (amt && Number(amt.low) === 0 && Number(amt.high) === 0)
    || String(amt) === '0';
  const noteMentions = Array.isArray(note?.contextInfo?.mentionedJid)
    ? note.contextInfo.mentionedJid.length
    : 0;
  const dumpMatch = topKeys.length === 1 && topKeys[0] === 'requestPaymentMessage'
    && !payMsg.groupStatusMessageV2
    && !note?.contextInfo?.statusSourceType
    && !note?.contextInfo?.isGroupStatus
    && !rpm?.requestPaymentFrom && !rpm?.requestFrom
    && rpm?.currencyCodeIso4217 === 'BRL'
    && amountOk
    && String(note?.text || '') === textoPay
    && noteMentions > 0;

  const wantHide = mode === 'membros' && opts.hideAdmin !== false && hideAdminEnabled();
  if (mode === 'membros' && !wantHide) {
    logger.logAviso('[status-v2] paypost hide-admin desligado (HANORK_STATUS_HIDE_ADMIN=0)');
  }

  const cipherEnv = String(process.env.HANORK_PAY_CIPHER || '').trim().toLowerCase();
  const useCipher = (cipherEnv === '1' || cipherEnv === 'true' || cipherEnv === 'on')
    && wantHide
    && listed.admins.length
    && listed.targets.length;

  if (useCipher) {
    const run = () => conn.relayMessage(groupJid, payMsg, {
      messageId: payId,
      _hanorkTrusted: true,
      skipForward: true,
      useCachedGroupMetadata: true,
      additionalAttributes: addressing
    });
    await withMemberOnlyMeta(conn, groupJid, async (ok) => {
      if (!ok) return run();
      return withRotatedSenderKey(conn, groupJid, () => run());
    });
    logger.logInfo(
      `[status-v2] paypost dump=${dumpMatch ? 'match' : 'miss'} filter=1 cipher=member-key` +
      ` members=${listed.targets.length} mentions=${mentions.length}` +
      ` adminsSkip=${listed.admins.length} id=${payId.slice(0, 12)}`
    );
    return {
      mode,
      sent: 1,
      errors: 0,
      hidden: listed.admins.length,
      filtered: true,
      messageId: payId,
      kind: 'payment',
      mentions: mentions.length,
      dumpMatch
    };
  }

  if (wantHide) {
    const targets = listed.targets.slice(0, directedCap());
    if (!targets.length) {
      logger.logAviso('[status-v2] paypost sem membros elegiveis (directed)');
      return {
        mode,
        sent: 0,
        errors: 0,
        hidden: listed.admins.length,
        filtered: false,
        messageId: '',
        kind: 'payment',
        mentions: mentions.length,
        dumpMatch
      };
    }
    // ID unico por alvo — mesmo id em N pkmsg pode falhar no client.
    let sent = 0;
    let errors = 0;
    let lastId = payId;
    for (let i = 0; i < targets.length; i++) {
      if (i) await sleep(DIRECTED_GAP_MS);
      const mid = i === 0 ? payId : makeStatusId(conn);
      lastId = mid;
      const r = await relayDirectedCopies(conn, groupJid, payMsg, mid, [targets[i]], addressing);
      sent += r.sent;
      errors += r.errors;
    }
    logger.logInfo(
      `[status-v2] paypost dump=${dumpMatch ? 'match' : 'miss'} filter=1 cipher=directed` +
      ` pay=${sent} err=${errors} members=${targets.length}` +
      ` mentions=${mentions.length} adminsSkip=${listed.admins.length} id=${String(lastId).slice(0, 12)}`
    );
    return {
      mode,
      sent,
      errors,
      hidden: listed.admins.length,
      filtered: true,
      messageId: lastId,
      kind: 'payment',
      mentions: mentions.length,
      dumpMatch
    };
  }

  await conn.relayMessage(groupJid, payMsg, {
    messageId: payId,
    _hanorkTrusted: true,
    skipForward: true,
    useCachedGroupMetadata: true,
    additionalAttributes: addressing
  });
  logger.logInfo(
    `[status-v2] paypost dump=${dumpMatch ? 'match' : 'miss'} filter=0` +
    ` mode=${mode} mentions=${mentions.length} id=${payId.slice(0, 12)}`
  );
  return {
    mode,
    sent: 1,
    errors: 0,
    hidden: 0,
    filtered: false,
    messageId: payId,
    kind: 'payment',
    mentions: mentions.length,
    dumpMatch
  };
}

/**
 * Status de canal (24h, rotulo Channel status no Zap).
 * Mesmo wrap groupStatusMessageV2, destino @newsletter — nao e post do feed.
 */
async function sendChannelStatus(conn, canalJid, opts = {}) {
  const dest = resolveCanalJid(canalJid);
  if (!dest) throw new Error('canal_invalido');
  const { kind, content } = innerContent(opts);
  const payload = {
    ...content,
    groupStatus: true,
    contextInfo: {
      isGroupStatus: true,
      statusSourceType: STATUS_SOURCE_TEXT,
      forwardedNewsletterMessageInfo: {
        newsletterJid: dest,
        ...(String(opts.canalName || '').trim()
          ? { newsletterName: String(opts.canalName).trim() }
          : {})
      }
    }
  };
  const sent = await conn.sendMessage(dest, payload, {
    skipForward: true,
    _hanorkTrusted: true,
    messageId: String(opts.messageId || '').trim() || makeStatusId(conn)
  });
  const messageId = sent?.key?.id || '';
  logger.logInfo(`[status-v2] channelStatus ok type=${kind} id=${String(messageId).slice(0, 12)}`);
  return {
    mode: 'canal',
    sent: 1,
    errors: 0,
    hidden: 0,
    messageId,
    kind,
    canalJid: dest
  };
}

async function captureStatusPayload(conn, ctx) {
  const quotedRaw = ctx.info?.message?.extendedTextMessage?.contextInfo?.quotedMessage
    || ctx.quoted?.message
    || null;
  const selfRaw = ctx.info?.message || null;
  const quotedKind = quotedRaw ? mediaKindFromNode(quotedRaw) : { tipo: null, caption: '', node: null };
  const selfKind = selfRaw ? mediaKindFromNode(selfRaw) : { tipo: null, caption: '', node: null };

  let tipo = null;
  let caption = '';
  let downloadSrc = null;

  if (ctx.hasMedia && (ctx.isImage || ctx.isVideo) && typeof ctx.downloadMedia === 'function') {
    tipo = ctx.isGif ? 'gif' : (ctx.isVideo ? 'video' : 'image');
    caption = selfKind.caption || '';
    try {
      const buffer = await ctx.downloadMedia();
      if (buffer && buffer.length) {
        return { buffer, tipo: sniffTipo(buffer, tipo), caption };
      }
    } catch (e) {
      logger.logAviso(`[status-v2] download ctx: ${e.message}`);
    }
  }

  if (quotedKind.tipo) {
    tipo = quotedKind.tipo;
    caption = quotedKind.caption;
    downloadSrc = quotedKind.node;
  } else if (selfKind.tipo) {
    tipo = selfKind.tipo;
    caption = selfKind.caption;
    downloadSrc = selfKind.node;
  }

  if (downloadSrc && tipo) {
    try {
      const fake = {
        key: {
          remoteJid: ctx.from,
          id: ctx.info?.message?.extendedTextMessage?.contextInfo?.stanzaId || ctx.key?.id,
          fromMe: false,
          participant: ctx.info?.message?.extendedTextMessage?.contextInfo?.participant || ctx.sender
        },
        message: downloadSrc
      };
      const buffer = await downloadMediaMessage(fake, 'buffer', {}, {});
      if (buffer && buffer.length) {
        return { buffer, tipo: sniffTipo(buffer, tipo), caption };
      }
    } catch (e) {
      logger.logErro('statuspost', e.message);
      return { error: true };
    }
  }
  return { buffer: null, tipo: null, caption };
}

function formatSendResult(r) {
  if (!r) return 'Status enviado.';
  const kind = r.kind === 'media' ? 'midia' : 'texto';
  if (r.mode === 'canal') {
    return `Status de canal (${kind}) enviado. Abre a aba Status (rotulo Channel status), nao o feed do canal.`;
  }
  if (r.mode === 'membros' && r.filtered) {
    return `Status (${kind}) na bandeja. Membros veem e sao mencionados; admin nao recebe (${r.hidden} fora). Confere num membro.`;
  }
  if (r.mode === 'membros') {
    return `Status (${kind}) na bandeja. Hide-admin nao rodou (meta sem admin ou HANORK_STATUS_HIDE_ADMIN=0).`;
  }
  return `Status (${kind}) na bandeja do grupo (todos, inclusive admin). Abre a bandeja do grupo, nao a aba Status pessoal.`;
}

function formatPaymentResult(r) {
  if (!r) return 'Pagamento enviado.';
  const dump = r.dumpMatch === false ? ' Proto fora do dump — confere log.' : '';
  if (r.filtered && r.sent > 0) {
    return `Cobranca enviada pra ${r.sent} membro(s); ${r.hidden} admin fora. No chip ADM nao aparece — abre num MEMBRO pra ver.${dump}`;
  }
  if (r.mode === 'membros' && r.sent === 0) {
    return 'Nenhum membro elegivel pra receber a cobranca (so admin/bot no grupo).';
  }
  return `Cobranca nativa no grupo (1 skmsg, ${r.mentions || 0} mencoes; hide-admin off).${dump}`;
}

module.exports = {
  sendGroupStatusV2,
  sendGroupPaymentMembers,
  paymentStatusPayload,
  paymentSendPayload,
  paymentFrontPayload,
  sendChannelStatus,
  captureStatusPayload,
  listEligibleMembers,
  parseStatusMode,
  stripModeArgs,
  statusContextInfo,
  formatSendResult,
  formatPaymentResult,
  directedCap,
  isNewsletterJid,
  resolveCanalJid,
  DIRECTED_GAP_MS,
  sniffTipo,
  STATUS_SOURCE_TEXT,
  senderKeyIdForJid
};
