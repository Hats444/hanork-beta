
const {
    downloadMediaMessage,
    getDevice,
    isJidGroup,
    isJidNewsletter,
    jidNormalizedUser,
} = require("@systemzero/baileys");

function unwrapWaMessage(message) {
    let msg = message;
    if (!msg || typeof msg !== 'object') return msg;
    for (let i = 0; i < 8; i++) {
        if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
        else if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
        else if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
        else if (msg.viewOnceMessageV2Extension?.message) msg = msg.viewOnceMessageV2Extension.message;
        else if (msg.documentWithCaptionMessage?.message) msg = msg.documentWithCaptionMessage.message;
        else if (msg.editedMessage?.message) msg = msg.editedMessage.message;
        else if (msg.lottieStickerMessage?.message) msg = msg.lottieStickerMessage.message;
        else if (msg.botInvokeMessage?.message) msg = msg.botInvokeMessage.message;
        else if (msg.groupStatusMessage?.message) msg = msg.groupStatusMessage.message;
        else if (msg.groupStatusMessageV2?.message) msg = msg.groupStatusMessageV2.message;
        else if (msg.groupStatusMentionMessage?.message) msg = msg.groupStatusMentionMessage.message;
        else if (msg.associatedChildMessage?.message) msg = msg.associatedChildMessage.message;
        else if (msg.futureProofMessage?.message) msg = msg.futureProofMessage.message;
        else if (msg.deviceSentMessage?.message) msg = msg.deviceSentMessage.message;
        else break;
    }
    return msg;
}

function extractText(message) {
    if (!message) return '';
    message = unwrapWaMessage(message) || message;
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption) return message.documentMessage.caption;
    const interactiveId = extractInteractiveId(message);
    if (interactiveId) return interactiveId;
    if (message.buttonsResponseMessage?.selectedButtonId) return message.buttonsResponseMessage.selectedButtonId;
    if (message.listResponseMessage?.singleSelectReply?.selectedRowId) return message.listResponseMessage.singleSelectReply.selectedRowId;
    if (message.templateButtonReplyMessage?.selectedId) return message.templateButtonReplyMessage.selectedId;
    return '';
}

function detectMediaType(message) {
    if (!message) return null;
    message = unwrapWaMessage(message) || message;
    if (message.imageMessage) return 'image';
    if (message.videoMessage || message.ptvMessage) return 'video';
    if (message.audioMessage) return 'audio';
    if (message.documentMessage) return 'document';
    if (message.stickerMessage || message.lottieStickerMessage) return 'sticker';
    if (message.contactMessage || message.contactsArrayMessage) return 'contact';
    if (message.locationMessage || message.liveLocationMessage) return 'location';
    if (message.pollCreationMessage || message.pollCreationMessageV3 || message.pollCreationMessageV5) return 'poll';
    return null;
}

function contextInfoFrom(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const direct = msg.extendedTextMessage?.contextInfo
        || msg.imageMessage?.contextInfo
        || msg.videoMessage?.contextInfo
        || msg.ptvMessage?.contextInfo
        || msg.documentMessage?.contextInfo
        || msg.audioMessage?.contextInfo
        || msg.stickerMessage?.contextInfo
        || msg.buttonsMessage?.contextInfo
        || msg.listMessage?.contextInfo
        || msg.templateMessage?.contextInfo
        || msg.interactiveMessage?.contextInfo
        || msg.productMessage?.contextInfo
        || msg.eventMessage?.contextInfo
        || msg.albumMessage?.contextInfo
        || msg.groupInviteMessage?.contextInfo
        || msg.pollCreationMessage?.contextInfo
        || msg.pollCreationMessageV3?.contextInfo
        || msg.pollCreationMessageV5?.contextInfo
        || msg.contactMessage?.contextInfo
        || msg.locationMessage?.contextInfo
        || msg.liveLocationMessage?.contextInfo
        || msg.buttonsResponseMessage?.contextInfo
        || msg.listResponseMessage?.contextInfo
        || msg.templateButtonReplyMessage?.contextInfo
        || msg.interactiveResponseMessage?.contextInfo
        || msg.contextInfo
        || null;
    if (direct && (direct.quotedMessage || direct.stanzaId)) return direct;
    for (const v of Object.values(msg)) {
        if (!v || typeof v !== 'object' || Array.isArray(v) || Buffer.isBuffer(v)) continue;
        const ci = v.contextInfo;
        if (ci && typeof ci === 'object' && (ci.quotedMessage || ci.stanzaId)) return ci;
    }
    return direct;
}

function getQuotedMessage(info) {
    if (!info || !info.message) return null;
    const raw = info.message;
    const m = unwrapWaMessage(raw) || raw;
    const ctx = contextInfoFrom(m) || contextInfoFrom(raw) || {};
    const quotedMsg = ctx.quotedMessage || null;
    if (!quotedMsg) return null;
    return {
        message: unwrapWaMessage(quotedMsg) || quotedMsg,
        stanzaId: ctx.stanzaId,
        participant: ctx.participant,
        participantAlt: ctx.participantAlt || ctx.participantPn || ctx.remoteJidAlt || null,
        participantPn: ctx.participantPn || ctx.participantAlt || null,
        sender: ctx.participantPn || ctx.participantAlt || ctx.participant || info.key?.participant,
        // Baileys nao marca fromMe no quoted; participant = bot quando e reply ao bot
        key: {
            id: ctx.stanzaId || null,
            remoteJid: info.key?.remoteJid || null,
            fromMe: false,
            participant: ctx.participant || null,
            participantAlt: ctx.participantAlt || ctx.remoteJidAlt || null
        },
        mentionedJid: Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : []
    };
}

function extractMentionedJid(message) {
    if (!message) return [];
    const msg = unwrapWaMessage(message) || message;
    const infos = [
        msg.extendedTextMessage?.contextInfo,
        msg.imageMessage?.contextInfo,
        msg.videoMessage?.contextInfo,
        msg.documentMessage?.contextInfo,
        msg.audioMessage?.contextInfo,
        msg.stickerMessage?.contextInfo,
        msg.buttonsResponseMessage?.contextInfo,
        msg.listResponseMessage?.contextInfo,
        msg.templateButtonReplyMessage?.contextInfo,
        msg.interactiveResponseMessage?.contextInfo,
        msg.buttonsMessage?.contextInfo,
        msg.templateMessage?.contextInfo,
        msg.interactiveMessage?.contextInfo,
        msg.contextInfo
    ].filter((ci) => ci && typeof ci === 'object');
    const out = [];
    const seen = new Set();
    for (const ci of infos) {
        const arr = ci.mentionedJid;
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
            let s = '';
            if (typeof item === 'string') s = item;
            else if (item && typeof item === 'object') {
                if (item.user && item.server) s = `${item.user}@${item.server}`;
                else if (typeof item.id === 'string') s = item.id;
            }
            s = String(s || '').replace(/:\d+(?=@)/, '');
            if (!s || seen.has(s)) continue;
            seen.add(s);
            out.push(s);
        }
    }
    return out;
}

function isGroupStatusMessage(message) {
    return !!message?.groupStatusMessageV2;
}

function isInteractiveResponse(message) {
    return !!(
        message?.interactiveResponseMessage ||
        message?.buttonsResponseMessage ||
        message?.templateButtonReplyMessage ||
        message?.listResponseMessage
    );
}

/** Extrai id de clique (lista / botao / nativeFlow single_select). */
function extractInteractiveId(message) {
    if (!message) return '';
    if (message.templateButtonReplyMessage?.selectedId) {
        return String(message.templateButtonReplyMessage.selectedId);
    }
    if (message.buttonsResponseMessage?.selectedButtonId) {
        return String(message.buttonsResponseMessage.selectedButtonId);
    }
    if (message.listResponseMessage?.singleSelectReply?.selectedRowId) {
        return String(message.listResponseMessage.singleSelectReply.selectedRowId);
    }
    const nfr = message.interactiveResponseMessage?.nativeFlowResponseMessage;
    if (nfr?.paramsJson) {
        try {
            const params = JSON.parse(nfr.paramsJson || '{}');
            const id =
                params.id ||
                params.selectedId ||
                params.selectedRowId ||
                params.rowId ||
                params.button_id ||
                '';
            if (id) return String(id);
            // Alguns clients mandam o id so no title quando e single_select
            if (params.title && /^(cmd_|div_|menu_|tg_|gm_|osint_|protset_|ps_|info_)/i.test(String(params.title))) {
                return String(params.title);
            }
        } catch (_) { /* ignore */ }
    }
    return '';
}

function isFlowResponse(message) {
    return !!(message?.interactiveResponseMessage?.nativeFlowResponseMessage);
}

function extractFlowData(message) {
    const nfr = message?.interactiveResponseMessage?.nativeFlowResponseMessage;
    if (!nfr) return null;
    try {
        const params = JSON.parse(nfr.paramsJson || '{}');
        return {
            name: nfr.name,
            paramsJson: nfr.paramsJson,
            parsed: params
        };
    } catch {
        return null;
    }
}

const GROUP_META_TTL_MS = 30000; // legado; TTL real em utils/groupMetaCache.js

async function getCachedGroupMetadata(conn, groupJid) {
    const { getCachedGroupMetadata: shared } = require('./utils/groupMetaCache');
    return shared(conn, groupJid);
}

async function parseMessage(conn, info, userPrefix = null) {
    if (!info) {
        console.error('[parseMessage] info é undefined');
        return null;
    }
    
    const rawMessage = info.message || {};
    const message = unwrapWaMessage(rawMessage) || rawMessage;
    const key = info.key || {};
    let from = key.remoteJid || '';
    let sender = key.participant || from;
    // PV fromMe: participant vem vazio e sender virava o OUTRO jid.
    // O dono no proprio chip era tratado como o contato (anti-PV calava).
    if (key.fromMe && !isJidGroup(from) && !isJidNewsletter(from)) {
        const me = conn?.user?.id || conn?.user?.jid || conn?.user?.lid || '';
        if (me) sender = me;
    }
    // Baileys LID mode: participant = @lid, participantAlt = telefone @s.whatsapp.net
    // PN mode: participantAlt pode ser o @lid
    const senderAlt = key.participantAlt || key.remoteJidAlt || key.senderPn || key.participantPn || null;
    const pushName = info.pushName || '';

    const fullText = extractText(message);
    const { parsePrefixedCommand } = require('./utils/commandTextParse');
    const parsed = parsePrefixedCommand(fullText, userPrefix || '', { platform: 'whatsapp' });
    const prefix = parsed.prefix;
    const command = parsed.command;
    const args = parsed.args;
    const text = parsed.text;
    
    const caption = message.imageMessage?.caption || message.videoMessage?.caption || message.documentMessage?.caption || '';

    const mediaType = detectMediaType(message);
    const hasMediaNow = !!mediaType;

    const quoted = getQuotedMessage(info);
    const quotedMediaType = quoted ? detectMediaType(quoted.message) : null;
    const hasQuotedMedia = !!quotedMediaType;

    const effectiveMediaType = hasMediaNow ? mediaType : (hasQuotedMedia ? quotedMediaType : null);
    const effectiveMessage = hasMediaNow ? message : (quoted ? quoted.message : null);
    const hasEffectiveMedia = !!effectiveMediaType;

    async function downloadMedia() {
        if (!hasEffectiveMedia || !effectiveMessage) return null;
        try {
            const quotedDownload = !hasMediaNow && !!quoted;
            const msgToDownload = unwrapWaMessage(
                quotedDownload ? quoted.message : message
            ) || effectiveMessage;
            const fakeKey = {
                remoteJid: from,
                id: quotedDownload
                    ? (quoted.stanzaId || quoted.key?.id || key.id)
                    : key.id,
                fromMe: quotedDownload ? false : (key.fromMe || false),
                participant: quotedDownload
                    ? (quoted.participant || quoted.sender || sender)
                    : sender
            };
            const fakeMsg = { key: fakeKey, message: msgToDownload };
            const opts = {};
            if (conn?.updateMediaMessage) {
                opts.reuploadRequest = conn.updateMediaMessage.bind(conn);
            }
            return await downloadMediaMessage(fakeMsg, 'buffer', {}, opts);
        } catch (e) {
            try { require('./logger').logAviso('downloadMedia: ' + (e.message || e)); } catch (_) { /* */ }
            return null;
        }
    }

    const isImage = effectiveMediaType === 'image';
    const isVideo = effectiveMediaType === 'video';
    const isAudio = effectiveMediaType === 'audio';
    const isDocument = effectiveMediaType === 'document';
    const isSticker = effectiveMediaType === 'sticker';
    const isGif = isVideo && !!(effectiveMessage?.videoMessage?.gifPlayback || message.videoMessage?.gifPlayback);
    const isViewOnce = !!(message.imageMessage?.viewOnce || message.videoMessage?.viewOnce);
    const isAvatarSticker = !!(message.stickerMessage?.isAvatar);
    const isGroupStatus = isGroupStatusMessage(message);
    const isNewsletter = isJidNewsletter(from);
    const isFlow = isFlowResponse(message);
    const isInteractive = isInteractiveResponse(message);
    const isButton = !!(message.buttonsMessage || message.templateButtonReplyMessage);
    const isPoll = !!message.pollCreationMessage || !!message.pollCreationMessageV3;
    const isReply = !!quoted;

    const isGroup = isJidGroup(from);
    if (!isGroup) {
        try {
            const { rememberLidPhonePair, keepInboundChatJid } = require('./utils');
            if (key.remoteJid && key.remoteJidAlt) rememberLidPhonePair(key.remoteJid, key.remoteJidAlt);
            const same = keepInboundChatJid(from, key);
            if (same) from = same;
        } catch (_) { /* mapping opcional */ }
    }
    let isAdmin = false;
    let isBotAdmin = false;
    if (isGroup) {
        const { sameParticipant, logModFailOnce } = require('./utils/moderation');
        try {
            const { peekGroupMetadata } = require('./utils/groupMetaCache');
            // Parse nunca dispara IQ: so cache. Sem meta = nao-admin (gate de comando).
            let meta = peekGroupMetadata(from);
            if (!meta) {
                isAdmin = false;
                isBotAdmin = false;
            } else {
            const adminParts = (meta.participants || []).filter(
                (p) => p.admin === 'admin' || p.admin === 'superadmin'
            );
            isAdmin = adminParts.some((p) => {
                const ids = [p.id, p.phoneNumber, p.jid, p.lid].filter(Boolean);
                const candidates = [sender, senderAlt].filter(Boolean);
                return candidates.some((c) => ids.some((id) => sameParticipant(id, c)));
            });
            const botJid = conn.user?.id || conn.user?.jid || '';
            if (botJid) {
                const botNorm = jidNormalizedUser(botJid);
                isBotAdmin = adminParts.some((p) => {
                    const ids = [p.id, p.phoneNumber, p.jid, p.lid].filter(Boolean);
                    return ids.some(
                        (id) => sameParticipant(id, botJid) || sameParticipant(id, botNorm)
                    );
                });
            }
            }
        } catch (e) {
            try {
                logModFailOnce(from, e && e.message ? e.message : e);
            } catch (_) { /* ignore */ }
            // Sem meta: nao marcar como admin (gate de comando). Protecoes usam isGroupAdminOrBot fail-open.
            isAdmin = false;
            isBotAdmin = false;
        }
    }

    const ctx = {
        conn,
        from,
        sender,
        senderAlt: senderAlt || null,
        pushName,
        key,
        message,
        info,
        conn,
        prefix,
        command,
        args,
        text,
        fullText,
        caption,
        hasMedia: hasEffectiveMedia,
        mediaType: effectiveMediaType,
        mediaMessage: effectiveMessage,
        isImage,
        isVideo,
        isAudio,
        isDocument,
        isSticker,
        isGif,
        isViewOnce,
        isAvatarSticker,
        isAlbum: false,
        isReply,
        quoted,
        mentionedJid: extractMentionedJid(message),
        hasQuotedMedia,
        quotedMediaType,
        isGroupStatus,
        isNewsletter,
        isFlow,
        isInteractive,
        isButton,
        isPoll,
        isGroup,
        isChannel: !!isNewsletter,
        isPrivate: !isGroup && !isNewsletter,
        isAdmin,
        isBotAdmin,
        downloadMedia,
        device: getDevice(key.id || ''),
        isOwner: false,
        isVip: false,
        telegramUserId: conn._telegramUserId || null,
        sessionId: conn._sessionId || null,
        messageId: key.id || null,
        fromMe: !!key.fromMe,
    };

    // Sempre inicializa conversa (steps / "conversacao") — nunca undefined
    try {
        const { getConversationSession } = require('./utils/conversationSession');
        ctx.session = getConversationSession(ctx.sessionId, ctx.sender);
    } catch (_) {
        ctx.session = { step: null, quantidade: null };
    }

    if (isFlow) {
        ctx.flowData = extractFlowData(message);
    }

    if (isInteractive) {
        ctx.buttonId = extractInteractiveId(message) || '';
        if (message.templateButtonReplyMessage) {
            ctx.buttonText = message.templateButtonReplyMessage.selectedDisplayText || '';
        } else if (message.buttonsResponseMessage) {
            ctx.buttonText = message.buttonsResponseMessage.selectedDisplayText || '';
        } else if (message.listResponseMessage) {
            ctx.buttonText =
                message.listResponseMessage.title ||
                message.listResponseMessage.singleSelectReply?.selectedRowId ||
                '';
        } else if (message.interactiveResponseMessage) {
            const nfr = message.interactiveResponseMessage.nativeFlowResponseMessage;
            ctx.buttonText = nfr?.name || '';
            if (!ctx.buttonId && nfr?.paramsJson) {
                try {
                    const params = JSON.parse(nfr.paramsJson || '{}');
                    ctx.buttonText = params.title || params.description || ctx.buttonText;
                } catch (_) { /* ignore */ }
            }
        }
        // Lista/nativeFlow sem id parseado: usa fullText se parecer id de menu
        if (!ctx.buttonId && ctx.fullText && /^(cmd_|div_|menu_|tg_|gm_|osint_|protset_|ps_|info_)/i.test(String(ctx.fullText))) {
            ctx.buttonId = String(ctx.fullText).trim();
        }
    }

    if (!ctx.from || ctx.from === '') {
        ctx.from = key.remoteJid || 'status@broadcast';
    }
    if (!ctx.sender || ctx.sender === '') {
        ctx.sender = key.participant || ctx.from || 'status@broadcast';
    }

    return ctx;
}

module.exports = { parseMessage, unwrapWaMessage, extractText, extractInteractiveId, isInteractiveResponse, getQuotedMessage };