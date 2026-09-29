// helpers.js
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { prepareWAMessageMedia } = require("@systemzero/baileys");
const { safeRelayMessage, getUserJid } = require("./safeRelay");
const { getButtonsEnabled, getWhatsAppChannelId, displayPrefix } = require("./utils/configManager");
const { getSessionButtonMode, areButtonsOn } = require("./utils/sessionRegistry");
const { applyForwardMode } = require("./utils/channelForward");
const { waSectionsForMain, textMenuCompact } = require("./utils/menuCatalog");
const { ensureJidString, keepInboundChatJid } = require("./utils");

const ASSETS_PATH = path.join(__dirname, "assets");

function resolveOutboundChatId(conn, chatId, quoted) {
    const raw = ensureJidString(chatId, '');
    if (!raw) return '';
    if (
        raw.endsWith('@g.us') ||
        raw.endsWith('@newsletter') ||
        raw.endsWith('@broadcast') ||
        raw === 'status@broadcast'
    ) {
        return raw;
    }
    const key = quoted && (quoted.key || quoted);
    const same = keepInboundChatJid(raw, key);
    if (same) return same;
    return raw;
}

function isUsableChatId(chatId) {
    const s = String(chatId || '');
    return !!(s && s.includes('@'));
}

function isNativeSendDead(err) {
    return /not-acceptable|not-authorized|forbidden|item-not-found|not-found|connection closed|timed?\s*out/i.test(String(err?.message || err || ''));
}

async function relayWithBudget(conn, chatId, content, caller, ms = 15000, options = {}) {
    const send = safeRelayMessage(conn, chatId, content, options, caller);
    let t;
    const timed = new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error('timeout')), ms);
    });
    try {
        return await Promise.race([send, timed]);
    } finally {
        clearTimeout(t);
    }
}

function loadImageBuffer(filename) {
    try {
        const imagePath = path.join(ASSETS_PATH, filename);
        if (fs.existsSync(imagePath)) return fs.readFileSync(imagePath);
        return null;
    } catch (e) {
        logger.logErro("IMG", `Erro ao carregar ${filename}: ${e.message}`);
        return null;
    }
}

async function loadImageFromUrl(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    } catch (e) {
        logger.logErro("IMG", `Erro ao baixar ${url}: ${e.message}`);
        return null;
    }
}

async function getImageBuffer(source) {
    if (!source) return null;
    if (source.startsWith('http://') || source.startsWith('https://')) {
        return await loadImageFromUrl(source);
    }
    return loadImageBuffer(source);
}

/** Reusa upload do menu.jpg. Cache miss nao espera — menu sai na hora; foto entra no proximo. */
const preparedImageCache = new WeakMap();
const PREPARED_IMAGE_TTL_MS = 10 * 60 * 1000;
const PREPARE_TIMEOUT_MS = 8000;
const preparedImageInflight = new WeakMap();

function cacheBucket(conn) {
    let map = preparedImageCache.get(conn);
    if (!map) {
        map = new Map();
        preparedImageCache.set(conn, map);
    }
    return map;
}

function inflightBucket(conn) {
    let map = preparedImageInflight.get(conn);
    if (!map) {
        map = new Map();
        preparedImageInflight.set(conn, map);
    }
    return map;
}

async function uploadImageHeader(conn, imageBuffer) {
    const prep = await prepareWAMessageMedia({ image: imageBuffer }, { upload: conn.waUploadToServer });
    if (!prep?.imageMessage) throw new Error('prepareWAMessageMedia sem imageMessage');
    return prep.imageMessage;
}

async function prepareImageHeader(conn, imageSource) {
    if (!imageSource) return {};
    let imageBuffer = Buffer.isBuffer(imageSource) ? imageSource : await getImageBuffer(imageSource);
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
        try { logger.logAviso(`prepareImageHeader: arquivo ausente (${String(imageSource).slice(0, 48)})`); } catch (_) {}
        return {};
    }

    const cacheKey = Buffer.isBuffer(imageSource) ? null : String(imageSource);
    if (cacheKey && conn) {
        const map = cacheBucket(conn);
        const hit = map.get(cacheKey);
        if (hit && hit.imageMessage && Date.now() - hit.ts < PREPARED_IMAGE_TTL_MS) {
            return { hasMediaAttachment: true, imageMessage: hit.imageMessage };
        }
        const inflight = inflightBucket(conn);
        let pending = inflight.get(cacheKey);
        if (!pending) {
            pending = uploadImageHeader(conn, imageBuffer)
                .then((imageMessage) => {
                    map.set(cacheKey, { imageMessage, ts: Date.now() });
                    return imageMessage;
                })
                .catch((e) => {
                    try { logger.logAviso(`prepareImageHeader: ${e.message}`); } catch (_) {}
                    return null;
                })
                .finally(() => inflight.delete(cacheKey));
            inflight.set(cacheKey, pending);
        }
        // Nao espera upload: menu sai na hora; foto entra no cache pro proximo.
        return {};
    }

    try {
        const imageMessage = await uploadImageHeader(conn, imageBuffer);
        return { hasMediaAttachment: true, imageMessage };
    } catch (e) {
        try { logger.logAviso(`prepareImageHeader: ${e.message}`); } catch (_) {}
        return {};
    }
}

// ========== FUNÇÕES COM IMAGEM ==========

async function sendButtonlessFallback(conn, chatId, { text, quoted, imageSource, telegramUserId = null, sections = null, sessionId = null, mentions = null, useChannel = null }) {
    chatId = resolveOutboundChatId(conn, chatId, quoted);
    if (!isUsableChatId(chatId)) {
        logger.logAviso('sendButtonlessFallback skip chatId vazio');
        return null;
    }
    if (!sessionId && conn && conn._sessionId) {
        sessionId = conn._sessionId;
    }

    const { normalizeNewsletterJid, CHANNEL_JID: DEF_CH, CHANNEL_NAME: DEF_NAME } = require("./utils/channelForward");
    const { textFromSections } = require("./utils/menuCatalog");
    const { splitTextParts } = require("./utils/textChunks");
    let channelId = null;
    let channelName = DEF_NAME;
    if (conn && conn._channelJid) {
        channelId = conn._channelJid;
    } else if (telegramUserId) {
        channelId = getWhatsAppChannelId(telegramUserId);
    }
    channelId = normalizeNewsletterJid(channelId || DEF_CH);

    const prefix = conn?._isTelegramShim
        ? '/'
        : (telegramUserId ? displayPrefix(telegramUserId) : '.');
    let finalText = text || '';

    // Botoes OFF: sections → texto compacto
    if (sections && sections.length > 0) {
        finalText = textFromSections(finalText, sections, prefix);
    }

    const isGroup = String(chatId).endsWith('@g.us');
    const buttonsOn = areButtonsOn(sessionId, telegramUserId);
    // Canal so no modo OFF, em grupo. Nunca no PV (@lid quebra jidDecode) e nunca depois de menu nativo.
    const wantChannel = useChannel === true
        || (useChannel !== false && !buttonsOn && isGroup && !conn?._isTelegramShim);

    const parts = splitTextParts(finalText, 60000);
    let last = null;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        let messageContent = { text: part };
        if (mentions && mentions.length > 0) {
            messageContent.mentions = mentions;
        }

        if (i === 0 && imageSource && part.length <= 900 && parts.length === 1) {
            const imageBuffer = Buffer.isBuffer(imageSource) ? imageSource : await getImageBuffer(imageSource);
            if (imageBuffer && Buffer.isBuffer(imageBuffer)) {
                messageContent = { image: imageBuffer, caption: part };
                if (mentions && mentions.length > 0) {
                    messageContent.mentions = mentions;
                }
            }
        }

        if (conn?._isTelegramShim || !wantChannel) {
            last = await conn.sendMessage(chatId, messageContent, { quoted, skipForward: true });
            continue;
        }

        const withForward = applyForwardMode(messageContent, sessionId, {
            force: true,
            newsletterJid: channelId,
            newsletterName: channelName
        });

        try {
            if (i === 0) {
                logger.logInfo(`[BUTTONS OFF] Canal Hanork-style ${channelId} | session=${sessionId || 'n/a'} | ${parts.length}msg`);
            }
            last = await conn.sendMessage(chatId, withForward, { quoted, skipForward: true });
        } catch (e) {
            logger.logAviso(`[BUTTONS OFF] canal falhou (${e.message}) — texto simples`);
            last = await conn.sendMessage(chatId, messageContent, { quoted, skipForward: true });
        }
    }
    return last;
}

function isQuickReplyButton(b) {
    return !!(b && !b.url && !b.copy);
}

function appendUrlButtonsToText(text, buttons) {
    let out = text || '';
    const urls = (buttons || []).filter((b) => b && b.url);
    if (urls.length) {
        out += `\n\n${urls.map((b) => `${b.label || 'Link'}: ${b.url}`).join('\n')}`;
    }
    const copies = (buttons || []).filter((b) => b && b.copy);
    if (copies.length) {
        out += `\n\n${copies.map((b) => `${b.label || 'PIX'}:\n${b.copy}`).join('\n\n')}`;
    }
    return out;
}

function toNativeFlowButton(b, { rawLabels = false } = {}) {
    const { buttonLabel, nativeButtonLabel } = require("./utils/typography");
    const lab = (fallback) => rawLabels
        ? nativeButtonLabel(b.label, fallback)
        : buttonLabel(b.label, fallback);
    if (b.copy) {
        return {
            name: "cta_copy",
            buttonParamsJson: JSON.stringify({
                display_text: lab("Copiar"),
                copy_code: String(b.copy)
            })
        };
    }
    if (b.url) {
        const url = String(b.url);
        return {
            name: "cta_url",
            buttonParamsJson: JSON.stringify({
                display_text: lab("Abrir"),
                url,
                merchant_url: url
            })
        };
    }
    return {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
            display_text: lab("Opcao"),
            id: b.id || `btn_${Date.now()}`
        })
    };
}

async function sendButtonsWithImage(conn, chatId, text, buttons, footer, quoted, imageSource, imageName, imageAddress, telegramUserId = null, mentions = null, sessionId = null, options = null) {
    chatId = resolveOutboundChatId(conn, chatId, quoted);
    if (!isUsableChatId(chatId)) {
        logger.logAviso('sendButtonsWithImage skip chatId vazio');
        return null;
    }
    // CORREÇÃO: Tentar extrair sessionId do objeto de conexão se não fornecido
    if (!sessionId && conn && conn._sessionId) {
        sessionId = conn._sessionId;
    }
    if (telegramUserId == null && conn?._telegramUserId) {
        telegramUserId = conn._telegramUserId;
    }
    const forceNative = !!(options && options.forceNative);
    const rawLabels = forceNative || !!(options && options.rawLabels);
    const skipForward = !!(options && options.skipForward);
    const trusted = !!(options && (options._hanorkTrusted || options.skipForward));
    const sendFlags = {
        ...(skipForward ? { skipForward: true } : {}),
        ...(trusted ? { _hanorkTrusted: true } : {})
    };

    // Telegram shim: sem nativeFlow/Baileys — texto (+ midia se houver)
    if (conn?._isTelegramShim) {
        return await sendButtonlessFallback(conn, chatId, {
            text: appendUrlButtonsToText(text, buttons),
            quoted, imageSource, telegramUserId, mentions, sessionId
        });
    }
    
    // Modo botoes OFF → texto (divulgacao CTA força nativo no Zap)
    if (!forceNative && !areButtonsOn(sessionId, telegramUserId)) {
        return await sendButtonlessFallback(conn, chatId, {
            text: appendUrlButtonsToText(text, buttons),
            quoted, imageSource, telegramUserId, mentions, sessionId
        });
    }

    if (!buttons || buttons.length === 0) {
        return await conn.sendMessage(chatId, { text, mentions }, { quoted, ...sendFlags });
    }

    const replyBtns = buttons.filter(isQuickReplyButton);
    // WA nativo mostra ~3 chips; o resto vira lista com titulo cortado e igual.
    if (!forceNative && replyBtns.length > 3) {
        const { buttonTitle } = require("./utils/typography");
        const rows = replyBtns.map((b) => ({
            id: b.id,
            title: buttonTitle(b.short || b.label || 'Opcao', 'Opcao', 24),
            description: b.desc || ''
        }));
        const head = rows.slice(0, 10);
        const overflow = rows.slice(10, 12);
        return sendInteractiveList(
            conn,
            chatId,
            text,
            [{ title: 'Opcoes', rows: head }],
            footer,
            quoted,
            imageSource,
            telegramUserId,
            sessionId,
            {
                listTitle: 'Ver opcoes',
                extraButtons: overflow.map((r) => ({ id: r.id, label: r.title }))
            }
        );
    }

    let header = {};
    if (imageSource) {
        header = await prepareImageHeader(conn, imageSource);
    }
    const { nativeFlowBody } = require("./utils/typography");
    const interactiveMsg = {
        interactiveMessage: {
            body: { text: forceNative ? String(text || '') : nativeFlowBody(text) },
            footer: { text: footer || "" },
            ...(header.imageMessage ? { header } : {}),
            contextInfo: mentions && mentions.length > 0 ? { mentionedJid: mentions } : undefined,
            nativeFlowMessage: {
                buttons: buttons.map((b) => toNativeFlowButton(b, { rawLabels }))
            }
        }
    };
    try {
        return await relayWithBudget(
            conn,
            chatId,
            interactiveMsg,
            'helpers.js:sendButtonsWithImage',
            15000,
            {
                mentionedJid: mentions && mentions.length ? mentions : undefined,
                ...sendFlags
            }
        );
    } catch (e) {
        const msg = String(e?.message || e);
        if (/item-not-found|not-found/i.test(msg)) {
            logger.logAviso(`sendButtonsWithImage skip: ${msg}`);
            return null;
        }
        if (/forbidden|not-authorized/i.test(msg)) {
            logger.logAviso(`sendButtonsWithImage forbidden: ${msg}`);
            throw e;
        }
        logger.logAviso(`sendButtonsWithImage native falhou: ${msg}`);
        throw e;
    }
}

async function sendCarouselWithImage(conn, chatId, title, cards, footer, quoted, imageSource) {
    if (!cards || cards.length === 0) {
        return await conn.sendMessage(chatId, { text: title }, { quoted });
    }
    let header = {};
    if (imageSource) {
        header = await prepareImageHeader(conn, imageSource);
    }
    const { nativeFlowBody } = require("./utils/typography");
    const carouselMsg = {
        interactiveMessage: {
            body: { text: nativeFlowBody(title) },
            footer: { text: footer || "" },
            ...(header.imageMessage ? { header } : {}),
            carouselMessage: {
                cards: cards.map(card => {
                    const cardButtons = (card.buttons || []).map((b) => toNativeFlowButton(b));
                    return {
                        cardContent: {
                            interactiveMessage: {
                                body: { text: card.body || "" },
                                footer: { text: card.footer || "" },
                                nativeFlowMessage: { buttons: cardButtons }
                            }
                        }
                    };
                })
            }
        }
    };
    return await safeRelayMessage(conn, chatId, carouselMsg, {}, 'helpers.js:sendCarouselWithImage');
}

// ========== FUNÇÕES INTERATIVAS COM IMAGEM ==========

async function sendInteractiveButtons(conn, chatId, text, buttons, footer, quoted, imageSource, telegramUserId = null, sessionId = null, options = null) {
    chatId = resolveOutboundChatId(conn, chatId, quoted);
    if (!isUsableChatId(chatId)) {
        logger.logAviso('sendInteractiveButtons skip chatId vazio');
        return null;
    }
    // Extrair sessionId do conn se não fornecido
    if (!sessionId && conn && conn._sessionId) {
        sessionId = conn._sessionId;
    }
    if (telegramUserId == null && conn?._telegramUserId) {
        telegramUserId = conn._telegramUserId;
    }
    const forceNative = !!(options && options.forceNative);
    if (conn?._isTelegramShim) {
        return await sendButtonlessFallback(conn, chatId, {
            text: appendUrlButtonsToText(text, buttons),
            quoted, imageSource, telegramUserId, sessionId
        });
    }

    if (!forceNative && !areButtonsOn(sessionId, telegramUserId)) {
        return await sendButtonlessFallback(conn, chatId, {
            text: appendUrlButtonsToText(text, buttons),
            quoted, imageSource, telegramUserId, sessionId
        });
    }

    if (!buttons || buttons.length === 0) {
        return await conn.sendMessage(chatId, { text }, { quoted });
    }
    const replyBtns = buttons.filter(isQuickReplyButton);
    if (replyBtns.length > 3) {
        return sendInteractiveList(
            conn,
            chatId,
            text,
            [{
                title: 'Opcoes',
                rows: replyBtns.slice(0, 10).map((b) => ({
                    id: b.id,
                    title: b.short || b.label || 'Opcao',
                    description: b.desc || ''
                }))
            }],
            footer,
            quoted,
            imageSource,
            telegramUserId,
            sessionId,
            { listTitle: 'Ver opcoes' }
        );
    }
    let header = {};
    if (imageSource) {
        header = await prepareImageHeader(conn, imageSource);
    }
    const { nativeFlowBody } = require("./utils/typography");
    const interactiveMsg = {
        interactiveMessage: {
            body: { text: nativeFlowBody(text) },
            footer: { text: footer || "" },
            ...(header.imageMessage ? { header } : {}),
            nativeFlowMessage: {
                buttons: buttons.map((b) => toNativeFlowButton(b, { rawLabels: forceNative }))
            }
        }
    };
    try {
        const hasCta = (buttons || []).some((b) => b && (b.url || b.copy));
        const budgetMs = imageSource ? 15000 : 10000;
        return await relayWithBudget(conn, chatId, interactiveMsg, 'helpers.js:sendInteractiveButtons', budgetMs);
    } catch (e) {
        const msg = String(e?.message || e);
        logger.logAviso(`[BTN] native falhou (${msg}) — botoes ON, sem fallback texto`);
        throw e;
    }
}

async function sendInteractiveList(conn, chatId, title, sections, footer, quoted, imageSource, telegramUserId = null, sessionId = null, options = null) {
    chatId = resolveOutboundChatId(conn, chatId, quoted);
    if (!isUsableChatId(chatId)) {
        logger.logAviso('sendInteractiveList skip chatId vazio');
        return null;
    }
    // Extrair sessionId do conn se não fornecido
    if (!sessionId && conn && conn._sessionId) {
        sessionId = conn._sessionId;
    }
    if (telegramUserId == null && conn?._telegramUserId) {
        telegramUserId = conn._telegramUserId;
    }
    const extraButtons = Array.isArray(options?.extraButtons)
        ? options.extraButtons.filter((b) => b && (b.id || b.label)).slice(0, 2)
        : [];
    const sectionsForFallback = extraButtons.length
        ? [{
            title: 'Atalhos',
            rows: extraButtons.map((b) => ({
                id: b.id,
                title: b.label || 'Opcao',
                description: ''
            }))
        }, ...(sections || [])]
        : sections;

    if (String(chatId).includes('@lid') && !String(chatId).endsWith('@g.us')) {
        logger.logAviso('[PV] lid-unresolved — tenta native mesmo assim');
    }

    if (conn?._isTelegramShim) {
        return await sendButtonlessFallback(conn, chatId, { text: title, quoted, imageSource, telegramUserId, sections: sectionsForFallback, sessionId });
    }

    if (!areButtonsOn(sessionId, telegramUserId) || options?.forceChannel) {
        return await sendButtonlessFallback(conn, chatId, {
            text: title,
            quoted,
            imageSource,
            telegramUserId,
            sections: sectionsForFallback,
            sessionId,
            useChannel: options?.forceChannel ? true : null
        });
    }

    if (!sections || sections.length === 0) {
        return await conn.sendMessage(chatId, { text: title }, { quoted });
    }

    const { buttonLabel, buttonTitle, nativeFlowBody, stripAccents } = require("./utils/typography");
    const mappedSections = sections.map((s) => ({
        title: buttonTitle(s.title || "Opcoes", "Opcoes", 24),
        rows: (s.rows || []).map((r) => ({
            title: buttonTitle(r.title || r.label || "Opcao", "Opcao", 24),
            description: nativeFlowBody(r.description || '').slice(0, 72),
            rowId: String(r.id || r.rowId || `row_${Date.now()}`),
            id: String(r.id || r.rowId || `row_${Date.now()}`),
            header: r.header || ""
        }))
    }));

    // Path GitHub/proven: nativeFlow single_select (1 msg multi-section).
    // Ate 2 quick_reply extras (WA costuma capar em 3 botoes nativos no total).
    let header = {};
    if (imageSource) {
        header = await prepareImageHeader(conn, imageSource);
    }
    const flowButtons = extraButtons.map((b) => ({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
            display_text: buttonLabel(b.label, "Opcao"),
            id: String(b.id || `btn_${Date.now()}`)
        })
    }));
    flowButtons.push({
        name: "single_select",
        buttonParamsJson: JSON.stringify({
            title: stripAccents(options?.listTitle || "Ver opcoes"),
            sections: mappedSections.map((s) => ({
                title: s.title,
                rows: s.rows.map((r) => ({
                    header: r.header || "",
                    title: r.title,
                    description: r.description,
                    id: r.id
                }))
            }))
        })
    });
    const interactiveMsg = {
        interactiveMessage: {
            body: { text: nativeFlowBody(typeof title === 'string' ? title : String(title || '')) },
            footer: { text: footer || "" },
            ...(header.imageMessage ? { header } : {}),
            nativeFlowMessage: {
                buttons: flowButtons
            }
        }
    };
    try {
        const budgetMs = imageSource ? 15000 : 12000;
        const sent = await relayWithBudget(conn, chatId, interactiveMsg, 'helpers.js:sendInteractiveList', budgetMs);
        logger.logInfo(`[LIST] single_select sections=${mappedSections.length} rows=${mappedSections.reduce((n, s) => n + s.rows.length, 0)} extra=${extraButtons.length}`);
        return sent;
    } catch (e) {
        const msg = String(e?.message || e);
        logger.logAviso(`[LIST] ${msg} — retry native sem foto (botoes ON, sem texto)`);
        if (header.imageMessage) {
            try {
                const retryMsg = {
                    interactiveMessage: {
                        ...interactiveMsg.interactiveMessage,
                        header: undefined
                    }
                };
                delete retryMsg.interactiveMessage.header;
                return await relayWithBudget(conn, chatId, retryMsg, 'helpers.js:sendInteractiveList:retry', 12000);
            } catch (e2) {
                logger.logAviso(`[LIST] retry native falhou (${e2.message}) — botoes ON, sem fallback texto`);
                throw e2;
            }
        }
        throw e;
    }
}

// ========== MENU PRINCIPAL ==========

async function sendMainMenu(conn, chatId, quoted, telegramUserId = null, sessionId = null, viewerRole = null) {
    chatId = resolveOutboundChatId(conn, chatId, quoted);
    if (!isUsableChatId(chatId)) {
        logger.logAviso('sendMainMenu skip chatId vazio');
        return null;
    }
    if (!sessionId && conn && conn._sessionId) {
        sessionId = conn._sessionId;
    }
    if (telegramUserId == null && conn?._telegramUserId) {
        telegramUserId = conn._telegramUserId;
    }

    const { previewText, stripAccents } = require("./utils/typography");
    const { resolveMenuViewerRole, roleCanSee, viewerAccessOpts } = require("./utils/menuCatalog");
    const { formatCanalPublicText, getCanalName } = require("./utils/canal");
    const buttonsOn = areButtonsOn(sessionId, telegramUserId);
    const platform = conn?._isTelegramShim ? 'telegram' : 'whatsapp';
    const prefix = platform === 'telegram' ? '/' : displayPrefix(telegramUserId);
    const role = resolveMenuViewerRole(
      { authRole: viewerRole, isOwner: viewerRole === 'owner' || viewerRole === 'platform_admin', isVip: viewerRole === 'vip' },
      telegramUserId
    );
    const accessOpts = viewerAccessOpts({
      isGroup: String(chatId || '').endsWith('@g.us'),
      from: chatId,
      sender: quoted?.key?.participant || quoted?.participant,
      senderAlt: quoted?.key?.participantAlt,
      conn,
      authRole: role,
      isAdmin: role === 'adm' || role === 'group_admin'
    });

    if (conn?._isTelegramShim || !buttonsOn) {
        const body =
            `${textMenuCompact(platform, prefix, role, accessOpts)}\n\n` +
            `${previewText('Canal')}: ${formatCanalPublicText()}`;
        logger.logInfo(`[MENU] Modo texto OFF — compacto, prefix=${prefix} role=${role || 'all'}`);
        return await sendButtonlessFallback(conn, chatId, {
            text: body,
            quoted,
            telegramUserId,
            sessionId
        });
    }

    // ON: 1 mensagem multi-section (estilo GitHub) — sem Categorias 1/N
    const sections = waSectionsForMain(prefix, role, accessOpts) || [];
    const atalhoRows = [
        { title: `${prefix}comandos`, description: `${prefix}comandos — Lista`, id: "menu_comandos" },
        { title: "Canal", description: getCanalName(), id: "channel_link" }
    ];
    if (!role || roleCanSee(role, 'adm', accessOpts)) {
        atalhoRows.unshift({
            title: `${prefix}menu_adm`.slice(0, 24),
            description: "Tudo que o admin do grupo usa",
            id: "cmd_menu_adm"
        });
    }
    if (!role || roleCanSee(role, 'owner')) {
        atalhoRows.unshift({
            title: `${prefix}menu_dk`.slice(0, 24),
            description: "Texto e midia do DK",
            id: "cmd_menu_dk"
        });
        atalhoRows.unshift({
            title: `${prefix}menu_dono`.slice(0, 24),
            description: "Tudo que o dono da sessao usa",
            id: "cmd_menu_dono"
        });
    }
    // Sem atalho "Seguranca" aqui — categoria menu_cat_antiflood ja e o unico menu
    if (!role || roleCanSee(role, 'owner')) {
        atalhoRows.unshift(
            { title: `${prefix}grupos`, description: "Gerenciar grupos", id: "gm_home" },
            { title: `${prefix}buttonmode`, description: "Botoes ON/OFF", id: "menu_botoes" },
            { title: `${prefix}nuke`, description: "Nuke", id: "menu_nuke" }
        );
    }
    sections.push({
        title: "Atalhos",
        rows: atalhoRows.slice(0, 10)
    });

    const totalRows = sections.reduce((n, s) => n + (s.rows || []).length, 0);
    logger.logInfo(`[MENU] Modo botoes ON — 1 msg sections=${sections.length} rows=${totalRows}`);
    return await sendInteractiveList(
        conn,
        chatId,
        `Hanork\nPrefixo: ${prefix}\n\nEscolha uma categoria ou digite o comando`,
        sections,
        "Hanork Bot",
        quoted,
        "menu.jpg",
        telegramUserId,
        sessionId
    );
}

module.exports = {
    sendButtonsWithImage,
    sendCarouselWithImage,
    sendInteractiveButtons,
    sendInteractiveList,
    getImageBuffer,
    loadImageBuffer,
    loadImageFromUrl,
    sendMainMenu,
    sendButtonlessFallback,
    getUserJid,
};