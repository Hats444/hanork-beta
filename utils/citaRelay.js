'use strict';
/**
 * .cita — reenvia o conteudo citado (qualquer tipo que o fork consiga mandar)
 * com mentionedJid dos membros do grupo.
 */
const { proto, downloadMediaMessage } = require('@systemzero/baileys');
const { unwrapWaMessage, getQuotedMessage } = require('../contextParser');
const { safeRelayMessage } = require('../safeRelay');
const logger = require('../logger');

const DOWNLOADABLE = [
    'imageMessage',
    'videoMessage',
    'ptvMessage',
    'audioMessage',
    'stickerMessage',
    'documentMessage'
];

const SKIP_ONLY = new Set([
    'protocolMessage',
    'senderKeyDistributionMessage',
    'messageContextInfo',
    'pollUpdateMessage',
    'encReactionMessage',
    'keepInChatMessage'
]);

function mentionCap() {
    const n = Number(process.env.HANORK_CITA_MENTION_CAP || 500);
    if (!Number.isFinite(n) || n <= 0) return 500;
    return Math.min(512, Math.floor(n));
}

function participantToMention(p) {
    if (!p) return null;
    const pn = String(p.phoneNumber || '');
    if (pn.endsWith('@s.whatsapp.net') || pn.endsWith('@c.us')) return pn;
    const digits = pn.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return `${digits}@s.whatsapp.net`;
    const id = String(p.id || p.lid || '');
    return id.includes('@') ? id : null;
}

function isCitaAdmin(p) {
    if (!p || typeof p !== 'object') return false;
    const a = p.admin;
    if (a === true || a === 1) return true;
    const s = String(a || '').toLowerCase();
    if (s === 'admin' || s === 'superadmin' || s === 'owner' || s === 'super_admin') return true;
    return !!(p.isAdmin || p.isSuperAdmin);
}

async function collectCitaMentions(conn, groupJid) {
    const { isSessionSelfIdentity } = require('./moderation');
    const { getCachedGroupMetadata } = require('./groupMetaCache');
    let meta;
    try {
        meta = await getCachedGroupMetadata(conn, groupJid, { force: true });
    } catch (_) {
        meta = await getCachedGroupMetadata(conn, groupJid);
    }
    const parts = meta?.participants || [];
    const adminN = parts.filter(isCitaAdmin).length;
    if (adminN === 0 && parts.length > 1) {
        logger.logAviso('[cita] meta sem flag admin — mencao pulada pra nao marcar ADM');
        return [];
    }
    const out = [];
    const seen = new Set();
    for (const p of parts) {
        if (!p || isCitaAdmin(p)) continue;
        if (
            isSessionSelfIdentity(conn, p.id) ||
            isSessionSelfIdentity(conn, p.phoneNumber) ||
            isSessionSelfIdentity(conn, p.lid)
        ) {
            continue;
        }
        const jid = participantToMention(p);
        if (!jid || seen.has(jid)) continue;
        seen.add(jid);
        out.push(jid);
    }
    return out.slice(0, mentionCap());
}

function cloneProto(msg) {
    return proto.Message.toObject(proto.Message.fromObject(msg), {
        longs: String,
        enums: Number,
        bytes: Buffer,
        defaults: false,
        arrays: true,
        objects: true
    });
}

function isProtoMessageKey(k) {
    return typeof k === 'string' && /Message(V\d+)?$/.test(k);
}

function injectMentions(node, mentions, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 10) return node;
    if (typeof node.conversation === 'string') {
        node.extendedTextMessage = {
            text: node.conversation,
            contextInfo: { mentionedJid: mentions }
        };
        delete node.conversation;
    }
    for (const [k, v] of Object.entries(node)) {
        if (v == null) continue;
        if (k === 'messageContextInfo' || k === 'senderKeyDistributionMessage') {
            delete node[k];
            continue;
        }
        if (k === 'contextInfo' && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)) {
            v.mentionedJid = mentions;
            delete v.isForwarded;
            delete v.forwardingScore;
            continue;
        }
        if (Array.isArray(v)) {
            if (k === 'cards' || k === 'hydratedButtons' || k === 'buttons' || k === 'sections') {
                for (const item of v) {
                    if (item && typeof item === 'object') injectMentions(item, mentions, depth + 1);
                }
            }
            continue;
        }
        if (typeof v !== 'object' || Buffer.isBuffer(v)) continue;
        if (isProtoMessageKey(k)) {
            v.contextInfo = { ...(v.contextInfo || {}), mentionedJid: mentions };
            delete v.contextInfo.isForwarded;
            delete v.contextInfo.forwardingScore;
        }
        if (
            k === 'message' ||
            isProtoMessageKey(k) ||
            k === 'header' ||
            k === 'body' ||
            k === 'footer' ||
            k === 'nativeFlowMessage' ||
            k === 'carouselMessage' ||
            k === 'hydratedTemplate'
        ) {
            injectMentions(v, mentions, depth + 1);
        }
    }
    return node;
}

function overlayExtra(node, extra) {
    if (!extra || !node) return;
    if (node.imageMessage) node.imageMessage.caption = extra;
    else if (node.videoMessage) node.videoMessage.caption = extra;
    else if (node.ptvMessage) node.ptvMessage.caption = extra;
    else if (node.documentMessage) node.documentMessage.caption = extra;
    else if (node.extendedTextMessage) node.extendedTextMessage.text = extra;
    else if (typeof node.conversation === 'string') node.conversation = extra;
    else if (node.interactiveMessage?.body) {
        node.interactiveMessage.body.text = extra;
    }
}

function contentKeys(msg) {
    if (!msg || typeof msg !== 'object') return [];
    return Object.keys(msg).filter((k) => k !== 'messageContextInfo' && msg[k] != null);
}

function isUnsendable(msg) {
    const keys = contentKeys(msg);
    if (!keys.length) return true;
    return keys.every((k) => SKIP_ONLY.has(k));
}

function extractSimpleText(msg) {
    if (!msg) return '';
    const m = unwrapWaMessage(msg) || msg;
    if (typeof m.conversation === 'string' && m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.documentMessage?.caption) return m.documentMessage.caption;
    if (m.reactionMessage?.text) return String(m.reactionMessage.text);
    if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText;
    if (m.listResponseMessage?.title) return m.listResponseMessage.title;
    return '';
}

function pollValues(poll) {
    const opts = poll?.options || poll?.pollOptions || [];
    return opts
        .map((o) => {
            if (!o) return '';
            if (typeof o === 'string') return o;
            return o.optionName || o.name || o.optionNameHash || '';
        })
        .map((s) => String(s || '').trim())
        .filter(Boolean);
}

function sendOpts(ctx, mentions) {
    return {
        quoted: ctx.info,
        skipForward: true,
        _hanorkTrusted: true,
        mentions,
        mentionedJid: mentions
    };
}

async function sendTextWithMentions(conn, ctx, text, mentions) {
    return conn.sendMessage(
        ctx.from,
        { text: text || 'Marcacao', mentions, contextInfo: { mentionedJid: mentions } },
        sendOpts(ctx, mentions)
    );
}

function quotedFromMe(conn, quoted) {
    if (quoted?.key?.fromMe) return true;
    try {
        const { isSessionSelfIdentity } = require('./moderation');
        return !!(
            isSessionSelfIdentity(conn, quoted?.participant) ||
            isSessionSelfIdentity(conn, quoted?.sender) ||
            isSessionSelfIdentity(conn, quoted?.participantPn)
        );
    } catch (_) {
        return false;
    }
}

function unwrapCitaPayload(msg) {
    let raw = unwrapWaMessage(msg) || msg;
    if (raw?.groupStatusMessageV2?.message) {
        raw = unwrapWaMessage(raw.groupStatusMessageV2.message) || raw.groupStatusMessageV2.message;
    } else if (raw?.groupStatusMessage?.message) {
        raw = unwrapWaMessage(raw.groupStatusMessage.message) || raw.groupStatusMessage.message;
    }
    return raw;
}

function hasQuotedBody(msg) {
    if (!msg || typeof msg !== 'object') return false;
    return Object.keys(msg).some((k) => k !== 'messageContextInfo' && msg[k] != null);
}

function lookupCachedQuoted(ctx, stanzaId) {
    if (!stanzaId || !ctx?.sessionId) return null;
    try {
        const { getCache } = require('../cache');
        const cached = getCache(ctx.sessionId).get(String(stanzaId));
        if (cached?.message && hasQuotedBody(cached.message)) return cached;
    } catch (_) { /* cache opcional */ }
    return null;
}

function resolveQuotedPayload(conn, ctx) {
    const fromParser = ctx?.quoted && hasQuotedBody(ctx.quoted.message)
        ? ctx.quoted
        : (getQuotedMessage(ctx?.info) || ctx?.quoted || null);
    const stanzaId = fromParser?.stanzaId || fromParser?.key?.id || null;
    let message = fromParser?.message || null;
    if (!hasQuotedBody(message) && stanzaId) {
        const cached = lookupCachedQuoted(ctx, stanzaId);
        if (cached?.message) message = cached.message;
    }
    if (!hasQuotedBody(message)) return null;
    return {
        message,
        stanzaId,
        participant: fromParser?.participant || fromParser?.sender || null,
        sender: fromParser?.sender || fromParser?.participant || null,
        participantPn: fromParser?.participantPn || null,
        key: fromParser?.key || {
            id: stanzaId,
            remoteJid: ctx.from,
            fromMe: quotedFromMe(conn, fromParser),
            participant: fromParser?.participant || fromParser?.sender || null
        }
    };
}

async function downloadQuotedBuffer(conn, ctx, raw, quotedMeta) {
    const quoted = quotedMeta || ctx.quoted || {};
    const fakeMsg = {
        key: {
            remoteJid: ctx.from,
            id: quoted.stanzaId || quoted.key?.id || ctx.info?.key?.id,
            fromMe: quotedFromMe(conn, quoted),
            participant: quoted.participant || quoted.sender || ctx.sender
        },
        message: raw
    };
    const opts = {};
    if (conn?.updateMediaMessage) {
        opts.reuploadRequest = conn.updateMediaMessage.bind(conn);
    }
    const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, opts);
    if (!buf || !buf.length) throw new Error('download vazio');
    return buf;
}

async function sendMediaReupload(conn, ctx, raw, extra, mentions, quotedMeta) {
    const buf = await downloadQuotedBuffer(conn, ctx, raw, quotedMeta);
    const payload = { mentions, contextInfo: { mentionedJid: mentions } };
    const opts = sendOpts(ctx, mentions);

    if (raw.imageMessage) {
        return conn.sendMessage(ctx.from, {
            image: buf,
            caption: extra || raw.imageMessage.caption || '',
            mimetype: raw.imageMessage.mimetype || 'image/jpeg',
            ...payload
        }, opts);
    }
    const vid = raw.videoMessage || raw.ptvMessage;
    if (vid) {
        return conn.sendMessage(ctx.from, {
            video: buf,
            caption: extra || vid.caption || '',
            mimetype: vid.mimetype || 'video/mp4',
            gifPlayback: !!vid.gifPlayback,
            ptv: !!(raw.ptvMessage || vid.ptv),
            ...payload
        }, opts);
    }
    if (raw.audioMessage) {
        return conn.sendMessage(ctx.from, {
            audio: buf,
            mimetype: raw.audioMessage.mimetype || 'audio/ogg; codecs=opus',
            ptt: !!raw.audioMessage.ptt,
            seconds: raw.audioMessage.seconds || undefined,
            ...payload
        }, opts);
    }
    if (raw.stickerMessage) {
        return conn.sendMessage(ctx.from, {
            sticker: buf,
            isAnimated: !!raw.stickerMessage.isAnimated,
            isAvatar: !!raw.stickerMessage.isAvatar,
            ...payload
        }, opts);
    }
    if (raw.documentMessage) {
        const d = raw.documentMessage;
        return conn.sendMessage(ctx.from, {
            document: buf,
            mimetype: d.mimetype || 'application/octet-stream',
            fileName: d.fileName || 'arquivo',
            caption: extra || d.caption || '',
            ...payload
        }, opts);
    }
    throw new Error('nao midia');
}

function hasDownloadableMedia(msg) {
    return DOWNLOADABLE.some((k) => msg && msg[k]);
}

async function sendStructured(conn, ctx, raw, extra, mentions) {
    const opts = sendOpts(ctx, mentions);
    const payload = { mentions, contextInfo: { mentionedJid: mentions } };

    const ext = raw.extendedTextMessage;
    const simpleText = !ext?.jpegThumbnail && !ext?.matchedText && !ext?.title;
    if (raw.conversation || (ext && simpleText)) {
        const text = extra || raw.conversation || ext?.text || '';
        if (!text) return false;
        return sendTextWithMentions(conn, ctx, text, mentions);
    }

    if (raw.contactMessage) {
        return conn.sendMessage(ctx.from, {
            contacts: {
                displayName: raw.contactMessage.displayName || 'contato',
                contacts: [raw.contactMessage]
            },
            ...payload
        }, opts);
    }
    if (raw.contactsArrayMessage) {
        return conn.sendMessage(ctx.from, {
            contacts: {
                displayName: raw.contactsArrayMessage.displayName || 'contatos',
                contacts: raw.contactsArrayMessage.contacts || []
            },
            ...payload
        }, opts);
    }

    const loc = raw.locationMessage || raw.liveLocationMessage;
    if (loc) {
        return conn.sendMessage(ctx.from, {
            location: {
                degreesLatitude: loc.degreesLatitude,
                degreesLongitude: loc.degreesLongitude,
                name: loc.name,
                address: loc.address
            },
            ...payload
        }, opts);
    }

    const poll = raw.pollCreationMessage || raw.pollCreationMessageV3 || raw.pollCreationMessageV5;
    if (poll) {
        const values = pollValues(poll);
        if (values.length >= 2) {
            return conn.sendMessage(ctx.from, {
                poll: {
                    name: extra || poll.name || 'Enquete',
                    values,
                    selectableCount: poll.selectableOptionsCount || 1
                },
                ...payload
            }, opts);
        }
    }

    if (raw.groupInviteMessage) {
        const g = raw.groupInviteMessage;
        return conn.sendMessage(ctx.from, {
            groupInvite: {
                inviteCode: g.inviteCode,
                inviteExpiration: Number(g.inviteExpiration || 0),
                text: extra || g.caption || '',
                jid: g.groupJid,
                subject: g.groupName || 'grupo'
            },
            ...payload
        }, opts);
    }

    if (raw.reactionMessage) {
        const emoji = String(raw.reactionMessage.text || '').trim();
        if (emoji) return sendTextWithMentions(conn, ctx, emoji, mentions);
    }

    return false;
}

async function sendProtoClone(conn, ctx, raw, extra, mentions) {
    const cloned = cloneProto(raw);
    delete cloned.messageContextInfo;
    delete cloned.senderKeyDistributionMessage;
    overlayExtra(cloned, extra);
    injectMentions(cloned, mentions);
    const keys = contentKeys(cloned);
    if (!keys.length) throw new Error('proto vazio');
    return safeRelayMessage(
        conn,
        ctx.from,
        cloned,
        sendOpts(ctx, mentions),
        'cita'
    );
}

async function sendNativeForward(conn, ctx, quotedMeta, raw, mentions) {
    const fake = {
        key: {
            remoteJid: ctx.from,
            id: quotedMeta.stanzaId || quotedMeta.key?.id,
            fromMe: quotedFromMe(conn, quotedMeta),
            participant: quotedMeta.participant || quotedMeta.sender
        },
        message: raw
    };
    return conn.sendMessage(ctx.from, {
        forward: fake,
        mentions,
        contextInfo: { mentionedJid: mentions }
    }, sendOpts(ctx, mentions));
}

async function sendCita(conn, ctx, extraText) {
    const extra = String(extraText || '').trim();
    const mentions = await collectCitaMentions(conn, ctx.from);
    const quoted = resolveQuotedPayload(conn, ctx);
    if (!quoted) {
        if (extra) return sendTextWithMentions(conn, ctx, extra, mentions);
        return conn.sendMessage(
            ctx.from,
            { text: 'Responda a mensagem que quer repetir.' },
            { quoted: ctx.info, skipForward: true, _hanorkTrusted: true }
        );
    }

    const raw = unwrapCitaPayload(quoted.message);
    if (isUnsendable(raw)) {
        const t = extra || extractSimpleText(raw) || 'Tipo de mensagem nao repetivel.';
        return sendTextWithMentions(conn, ctx, t, mentions);
    }

    const media = hasDownloadableMedia(raw);

    try {
        const structured = await sendStructured(conn, ctx, raw, extra, mentions);
        if (structured !== false) return structured;
    } catch (e) {
        logger.logAviso(`cita structured: ${e.message || e}`);
    }

    if (media && extra) {
        try {
            return await sendMediaReupload(conn, ctx, raw, extra, mentions, quoted);
        } catch (e) {
            logger.logAviso(`cita reupload: ${e.message || e}`);
        }
    }

    try {
        return await sendNativeForward(conn, ctx, quoted, raw, mentions);
    } catch (e) {
        logger.logAviso(`cita forward: ${e.message || e}`);
    }

    if (media) {
        try {
            return await sendMediaReupload(conn, ctx, raw, extra, mentions, quoted);
        } catch (e) {
            logger.logAviso(`cita reupload: ${e.message || e}`);
        }
    }

    try {
        return await sendProtoClone(conn, ctx, raw, extra, mentions);
    } catch (e) {
        logger.logAviso(`cita proto: ${e.message || e}`);
        const t = extra || extractSimpleText(raw) || 'Nao foi possivel repetir este tipo.';
        return sendTextWithMentions(conn, ctx, t, mentions);
    }
}

module.exports = {
    sendCita,
    collectCitaMentions,
    injectMentions,
    cloneProto,
    resolveQuotedPayload
};
