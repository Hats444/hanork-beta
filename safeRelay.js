const { generateWAMessageFromContent } = require("@systemzero/baileys");
const logger = require("./logger");

function getUserJid(conn) {
    if (!conn) return undefined;
    if (conn.user?.id && typeof conn.user.id === 'string' && conn.user.id.includes('@')) {
        return conn.user.id;
    }
    if (conn.user?.jid && typeof conn.user.jid === 'string' && conn.user.jid.includes('@')) {
        return conn.user.jid;
    }
    if (conn.authState?.creds?.me?.id && typeof conn.authState.creds.me.id === 'string' && conn.authState.creds.me.id.includes('@')) {
        return conn.authState.creds.me.id;
    }
    return undefined;
}

async function safeRelayMessage(conn, chatId, content, options = {}, caller = 'desconhecido') {
    const attempt = async () => {
        try {
            const { keepInboundChatJid, ensureJidString } = require('./utils');
            const raw = ensureJidString(chatId, '');
            if (
                raw.endsWith('@g.us') ||
                raw.endsWith('@newsletter') ||
                raw.endsWith('@broadcast') ||
                raw === 'status@broadcast'
            ) {
                chatId = raw;
            } else {
                chatId = keepInboundChatJid(raw, options?.quoted?.key || options?.key) || raw;
            }
        } catch (_) { /* mapping opcional */ }
        if (!chatId || typeof chatId !== 'string' || !chatId.includes('@')) {
            logger.logAviso(`safeRelay (${caller}): skip chatId vazio`);
            return null;
        }
        try {
            const { assertSendableSticker } = require('./utils/bannedStickers');
            assertSendableSticker(conn._telegramUserId, content, options);
        } catch (banErr) {
            if (banErr && banErr.code === 'BANNED_STICKER') {
                logger.logAviso(`safeRelay (${caller}): figurinha bloqueada`);
                throw banErr;
            }
        }
        // Socket morto: evita stack enorme de groupMetadata/Connection Closed
        const wsState = conn?.ws?.socket?.readyState ?? conn?.ws?.readyState;
        if (wsState === 2 || wsState === 3) {
            const err = new Error('Connection Closed');
            err.code = 'CONNECTION_CLOSED';
            throw err;
        }
        const userJid = options.userJid || getUserJid(conn);
        const msgOptions = { ...options };
        if (userJid) {
            msgOptions.userJid = userJid;
        }
        const mentionList = [
            ...(Array.isArray(options.mentionedJid) ? options.mentionedJid : []),
            ...(Array.isArray(options.mentions) ? options.mentions : [])
        ].filter(Boolean);
        if (mentionList.length && content && typeof content === 'object') {
            if (typeof content.conversation === 'string') {
                content.extendedTextMessage = {
                    text: content.conversation,
                    contextInfo: { mentionedJid: mentionList }
                };
                delete content.conversation;
            }
            for (const [k, v] of Object.entries(content)) {
                if (!v || typeof v !== 'object' || Array.isArray(v) || Buffer.isBuffer(v)) continue;
                if (k === 'messageContextInfo' || k === 'senderKeyDistributionMessage') continue;
                if (!/Message(V\d+)?$/.test(k)) continue;
                v.contextInfo = {
                    ...(v.contextInfo || {}),
                    mentionedJid: [...new Set([
                        ...(v.contextInfo?.mentionedJid || []),
                        ...mentionList
                    ])]
                };
            }
            msgOptions.mentionedJid = mentionList;
        }
        const msg = generateWAMessageFromContent(chatId, content, msgOptions);
        const result = await conn.relayMessage(chatId, msg.message, {
            messageId: msg.key.id,
            ...options,
            _hanorkTrusted: true
        });
        return result;
    };

    try {
        return await attempt();
    } catch (err) {
        const short = String(err?.message || err);
        if (/rate-overlimit/i.test(short)) {
            const n = Number(options._hanorkRateAttempt) || 0;
            let alreadyHot = false;
            try {
                const { waOverHot, markWaOverlimit } = require('./utils/waSendPatch');
                alreadyHot = waOverHot();
                markWaOverlimit();
            } catch (_) { /* patch opcional */ }
            if (!alreadyHot && n < 1) {
                logger.logAviso(`safeRelay (${caller}): rate-overlimit — retry 4000ms`);
                await new Promise((r) => setTimeout(r, 4000));
                return await safeRelayMessage(
                    conn,
                    chatId,
                    content,
                    { ...options, _hanorkRateAttempt: n + 1 },
                    caller
                );
            }
            logger.logAviso(`safeRelay (${caller}): ${short}`);
            throw err;
        }
        if (/item-not-found|not-found/i.test(short)) {
            logger.logAviso(`safeRelay (${caller}): ${short} — skip (grupo/chat sumiu)`);
            return null;
        }
        if (/forbidden|not-authorized/i.test(short)) {
            logger.logAviso(`safeRelay (${caller}): ${short}`);
            throw err;
        }
        logger.logErro(`safeRelay (${caller})`, short);
        if (!/connection closed/i.test(short)) {
            console.error(`[${caller}] ${err.stack || short}`);
        } else {
            console.error(`[${caller}] Connection Closed (socket)`);
        }
        throw err;
    }
}

module.exports = { safeRelayMessage, getUserJid };