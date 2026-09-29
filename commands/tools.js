// commands/tools.js
const logger = require("../logger");
const { getCache, persistCache } = require("../cache");
const { jsonReplacer, findFields, normalizeJid, ensureJidString } = require("../utils");
const { sendInteractiveButtons } = require("../helpers");
const { getWhatsAppChannelId } = require("../utils/configManager");
const { deleteMessageAsAdmin, deleteMessageSmart, isDivulgacaoPaymentPayload, sameParticipant, isKickableJid, expandBanTargetIds, cacheMessageMatchesTarget, isGroupAdminStrict, collectMessageSenderIds } = require("../utils/moderation");

const commands = {};

function getSessionCache(ctx, conn) {
    const sid = ctx.sessionId || conn?._sessionId || 'default';
    return getCache(sid);
}

// ===== BUSCA DE HISTÓRICO DO GRUPO =====
// Cache local (messages.upsert notify/append). Match LID ↔ telefone via sameParticipant.
const HISTORY_SEARCH_LIMIT = 50;
const DELETE_DELAY_MS = 120;

function resolveQuotedFullMessage(ctx, conn) {
    const stanzaId = ctx.quoted?.stanzaId;
    if (!stanzaId) return null;
    try {
        const cache = getSessionCache(ctx, conn);
        const cached = cache.get(stanzaId);
        if (cached?.message) return cached;
    } catch (_) { /* ignore */ }
    // Fallback: so o quotedMessage do contextInfo
    const q =
        ctx.quoted?.message ||
        ctx.info?.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
        null;
    if (q) {
        const ctxInfo =
            ctx.info?.message?.extendedTextMessage?.contextInfo ||
            ctx.info?.message?.imageMessage?.contextInfo ||
            ctx.info?.message?.videoMessage?.contextInfo ||
            {};
        const payload = (q && typeof q === 'object' && (q.groupStatusMessageV2 || q.groupStatusMessage || q.groupStatusMentionMessage || q.conversation || q.extendedTextMessage || q.imageMessage || q.videoMessage))
            ? q
            : {
                extendedTextMessage: {
                    text: '',
                    contextInfo: { ...ctxInfo, stanzaId, participant: ctx.quoted?.sender || ctx.quoted?.participant }
                }
            };
        return {
            key: {
                remoteJid: ctx.from,
                id: stanzaId,
                fromMe: false,
                participant: ctx.quoted?.sender || ctx.quoted?.participant,
                participantAlt: ctx.quoted?.participantAlt || ctx.quoted?.participantPn || undefined,
                addressingMode: ctx.quoted?.key?.addressingMode
            },
            message: payload,
            _hanorkPayment: !!(payload && payload.requestPaymentMessage),
            _hanorkGroupStatus: !!(
                payload && (
                    payload.groupStatusMessageV2 ||
                    payload.groupStatusMessage ||
                    payload.groupStatusMentionMessage ||
                    payload.extendedTextMessage?.contextInfo?.isGroupStatus ||
                    Number(payload.extendedTextMessage?.contextInfo?.statusSourceType) === 4
                )
            )
        };
    }
    return null;
}

async function deleteMessagesSmartBulk(conn, groupId, messages, targetUser) {
    let deletedCount = 0;
    let failedCount = 0;
    const list = messages.slice(0, HISTORY_SEARCH_LIMIT);
    const targetIds = expandBanTargetIds(conn, groupId, targetUser);
    logger.logInfo(`[deletar] bulk n=${list.length}`);
    for (const msg of list) {
        try {
            const full = msg.full || msg.raw || {
                key: {
                    id: msg.id,
                    remoteJid: groupId,
                    fromMe: !!msg.fromMe,
                    participant: msg.participant,
                    participantAlt: msg.participantAlt,
                    addressingMode: msg.addressingMode
                }
            };
            if (!msg.fromMe) {
                const matched = cacheMessageMatchesTarget(full, targetIds)
                    || sameParticipant(msg.participant, targetUser);
                if (!matched) {
                    logger.logAviso(`[deletar] skip mismatch id=${String(msg.id || '').slice(0, 24)}`);
                    continue;
                }
            }
            const result = await deleteMessageSmart(
                conn,
                groupId,
                msg.id,
                msg.fromMe,
                msg.participant || targetUser,
                full
            );
            logger.logInfo(`[deletar] id=${String(msg.id || '').slice(0, 24)} ok=${!!result.success} via=${result.via || '?'}`);
            if (result.success) deletedCount++;
            else failedCount++;
        } catch (e) {
            failedCount++;
            logger.logErro(`[SMART_DELETE] ${msg.id}: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, DELETE_DELAY_MS));
    }
    logger.logInfo(`[deletar] done deleted=${deletedCount} failed=${failedCount}`);
    return { deletedCount, failedCount, truncated: messages.length > list.length };
}

async function deleteMessagesAsAdminBulk(conn, groupId, messages, targetUser) {
    // Mantido nome legado — agora usa smart (pagamento → fake)
    return deleteMessagesSmartBulk(conn, groupId, messages, targetUser);
}

function scanCacheForUser(messagesCache, conn, groupId, targetUser, seenIds, results) {
    const gid = ensureJidString(groupId, '');
    const allKeys = typeof messagesCache.keys === 'function' ? messagesCache.keys() : [];
    const groupMsgs = [];
    for (const key of allKeys) {
        try {
            const msg = messagesCache.get(key);
            if (!msg?.key?.id || seenIds.has(msg.key.id) || msg.key.fromMe) continue;
            const a = ensureJidString(msg.key.remoteJid, '');
            const b = ensureJidString(msg.key.remoteJidAlt, '');
            if (a !== gid && b !== gid) continue;
            try {
                const { rememberLidPhonePair } = require('../utils');
                const p = String(msg.key.participant || '');
                const alt = String(msg.key.participantAlt || msg.key.participantPn || '');
                if (p.includes('@lid') && (alt.includes('@s.whatsapp.net') || alt.includes('@c.us'))) {
                    rememberLidPhonePair(p, alt);
                } else if (alt.includes('@lid') && (p.includes('@s.whatsapp.net') || p.includes('@c.us'))) {
                    rememberLidPhonePair(alt, p);
                }
            } catch (_) { /* mapping opcional */ }
            groupMsgs.push(msg);
        } catch (_) { /* continue */ }
    }
    const targetIds = expandBanTargetIds(conn, gid, targetUser);
    for (const msg of groupMsgs) {
        if (!cacheMessageMatchesTarget(msg, targetIds)) continue;
        if (seenIds.has(msg.key.id)) continue;
        results.push({
            ...msg,
            full: msg,
            messageTimestamp: msg.messageTimestamp || msg.message?.messageTimestamp || 0
        });
        seenIds.add(msg.key.id);
    }
}

async function fetchGroupHistory(conn, ctx) {
    const from = ensureJidString(ctx.from, '');
    const targetUser = ensureJidString(
        ctx.deletarTarget || ctx.quoted?.sender || ctx.quoted?.participant || ctx.sender,
        ''
    );
    const messagesCache = getSessionCache(ctx, conn);
    const results = [];
    const seenIds = new Set();

    try {
        scanCacheForUser(messagesCache, conn, from, targetUser, seenIds, results);
        results.sort((a, b) => Number(b.messageTimestamp || 0) - Number(a.messageTimestamp || 0));
        if (results.length > 0) {
            logger.logInfo(`[bna] ${results.length} msgs no cache para ${targetUser}`);
            return results.slice(0, HISTORY_SEARCH_LIMIT);
        }
    } catch (e) {
        logger.logErro('[bna] Erro ao buscar no cache:', e.message);
    }

    // Segunda passagem apos presença (append de historico pode chegar)
    try {
        logger.logInfo(`[bna] Cache vazio/mismatch para ${targetUser}, re-scan...`);
        if (typeof conn.sendPresenceUpdate === 'function') {
            try { await conn.sendPresenceUpdate('available'); } catch (_) {}
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
        scanCacheForUser(messagesCache, conn, from, targetUser, seenIds, results);
    } catch (e) {
        logger.logErro('[bna] Erro ao buscar historico:', e.message);
    }

    results.sort((a, b) => Number(b.messageTimestamp || 0) - Number(a.messageTimestamp || 0));
    return results.slice(0, HISTORY_SEARCH_LIMIT);
}

async function resolveDeleteTarget(ctx, conn) {
    try {
        const { resolveTargetJid } = require('../utils/moderation');
        const hit = await resolveTargetJid(ctx, conn);
        if (ctx._hanorkTargetImmune) return '';
        if (hit) return ensureJidString(hit, '');
    } catch (_) { /* ignore */ }
    const q = ctx.quoted?.sender || ctx.quoted?.participant || ctx.quoted?.participantPn;
    if (q) return ensureJidString(q, '');
    const m = (ctx.mentionedJid && ctx.mentionedJid[0]) || '';
    if (m) return ensureJidString(m, '');
    return '';
}

async function purgeUserMessages(conn, ctx, targetUser) {
    ctx.deletarTarget = targetUser;
    const historyMessages = await fetchGroupHistory(conn, ctx);
    const messagesToDelete = historyMessages.map((msg) => ({
        id: msg.key.id,
        participant: ensureJidString(
            msg.key.participant || (msg.key.fromMe ? conn.user?.id : null),
            targetUser
        ),
        participantAlt: msg.key.participantAlt || msg.key.participantPn,
        addressingMode: msg.key.addressingMode,
        fromMe: msg.key.fromMe || false,
        full: msg.full || msg
    }));
    const quotedId = ctx.quoted?.stanzaId;
    if (quotedId && !messagesToDelete.some((m) => m.id === quotedId)) {
        const quotedFull = resolveQuotedFullMessage(ctx, conn);
        messagesToDelete.push({
            id: quotedId,
            participant: ensureJidString(quotedFull?.key?.participant || targetUser, targetUser),
            participantAlt: quotedFull?.key?.participantAlt,
            addressingMode: quotedFull?.key?.addressingMode,
            fromMe: false,
            full: quotedFull
        });
    }
    try { persistCache(ctx.sessionId || conn._sessionId || 'default'); } catch (_) { /* ignore */ }
    if (!messagesToDelete.length) {
        return { deletedCount: 0, failedCount: 0, truncated: false, empty: true };
    }
    const bulk = await deleteMessagesAsAdminBulk(conn, ctx.from, messagesToDelete, targetUser);
    return { ...bulk, empty: false };
}

/** Resolve JID do alvo como aparece no grupo (kick LID/PN) */
async function resolveGroupMemberJid(conn, groupId, targetJid) {
    const target = ensureJidString(targetJid, '');
    if (!target) return null;
    try {
        const { getCachedGroupMetadata } = require('../utils/groupMetaCache');
        const meta = await getCachedGroupMetadata(conn, groupId);
        const hit = (meta.participants || []).find((p) => sameParticipant(p.id, target));
        if (hit?.id) return ensureJidString(hit.id, target);
    } catch (_) {}
    return target;
}

function resolveRequesterPv(conn, ctx) {
    const { getPhoneForLid, ensureJidString } = require('../utils');
    const key = ctx.info?.key || {};
    const asPn = (raw) => {
        const j = ensureJidString(raw, '');
        if (/@(s\.whatsapp\.net|c\.us)$/i.test(j)) return j.replace(/@c\.us$/i, '@s.whatsapp.net');
        return '';
    };
    for (const c of [
        ctx.senderAlt,
        key.participantAlt,
        key.participantPn,
        key.senderPn,
        key.remoteJidAlt,
        !ctx.isGroup ? ctx.from : ''
    ]) {
        const pn = asPn(c);
        if (pn) return pn;
    }
    const sender = ensureJidString(ctx.sender || key.participant || '', '');
    if (sender.endsWith('@lid')) {
        const phone = getPhoneForLid(sender);
        const d = String(phone || '').replace(/\D/g, '');
        if (d.length >= 10 && d.length <= 15) return `${d}@s.whatsapp.net`;
    }
    if (!ctx.isGroup && ctx.from && !String(ctx.from).endsWith('@g.us')) {
        return ensureJidString(ctx.from, sender);
    }
    return sender || ensureJidString(ctx.from, '');
}

function pickQuotedRawMessage(ctx) {
    try {
        const { unwrapWaMessage, contextInfoFrom } = require('../contextParser');
        const raw = ctx.info?.message;
        const inner = unwrapWaMessage(raw) || raw;
        const ci = contextInfoFrom(inner) || contextInfoFrom(raw) || {};
        if (ci.quotedMessage) return ci.quotedMessage;
    } catch (_) { /* ignore */ }
    return ctx.quoted?.message || null;
}

const DISSECAR_SEND_OPTS = { quoted: null, skipForward: true, _hanorkTrusted: true };

commands.dissecar = {
    useCtx: true,
    description: "Disseca msg citada, mencao, numero, jid, canal ou grupo — tudo do Zap",
    usage: "dissecar [jid|numero|link] | responda | mencione",
    execute: async (conn, ctx) => {
        if (!ctx || !ctx.info) return;
        if (!ctx.isOwner && ctx.authRole !== 'owner' && !ctx.fromMe) {
            return conn.sendMessage(ctx.from, { text: 'Apenas o dono da sessao.' }, { quoted: ctx.info });
        }

        const p = require('../utils/configManager').prefixFromCtx(ctx);
        const {
            dissectTarget,
            dissectWaMessage,
            parseLooseTargets,
            maskJid,
            jsonSafe,
            formatMessageReport
        } = require('../utils/dissecarTarget');
        const { stripAccents } = require('../utils/typography');
        const dest = resolveRequesterPv(conn, ctx) || ctx.from;
        const groupChat = ctx.from;

        const quoted = ctx.quoted || null;
        const mentions = [
            ...(Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : [])
        ].filter(Boolean);
        const remainder = String(ctx.text || ctx.q || (ctx.args || []).join(' ') || '').trim();
        const loose = parseLooseTargets(remainder);
        const mentionedAsTargets = mentions.filter((j) =>
            /@(s\.whatsapp\.net|lid|g\.us|newsletter|c\.us)$/i.test(String(j))
        );

        const quotedRaw = pickQuotedRawMessage(ctx);
        const hasQuoted = !!(quoted && (quoted.message || quoted.stanzaId || quotedRaw));
        const targets = [...new Set([...loose, ...mentionedAsTargets])];

        if (!hasQuoted && !targets.length) {
            await conn.sendMessage(groupChat, {
                text: stripAccents(
                    `Dissecar — puxa tudo que o Zap expuser e manda no seu PV\n\n` +
                    `Responda qualquer msg: ${p}dissecar\n` +
                    `Mencione: ${p}dissecar @pessoa\n` +
                    `Numero/JID/LID: ${p}dissecar 5511... ou 123@lid\n` +
                    `Canal: ${p}dissecar https://whatsapp.com/channel/CODIGO\n` +
                    `Grupo: ${p}dissecar chat.whatsapp.com/CODIGO\n` +
                    `Pode juntar: responder + mencionar + numero na frente.`
                )
            }, { quoted: ctx.info });
            return;
        }

        const sendDump = async (jid, content) => {
            try {
                return await conn.sendMessage(jid, content, DISSECAR_SEND_OPTS);
            } catch (e) {
                if (jid !== groupChat) {
                    logger.logAviso(`[dissecar] PV falhou, manda no chat: ${e.message}`);
                    return conn.sendMessage(groupChat, content, DISSECAR_SEND_OPTS);
                }
                throw e;
            }
        };

        await sendDump(dest, { text: stripAccents('Dissecando (puxando tudo)...') });
        if (String(dest) !== String(groupChat)) {
            await conn.sendMessage(groupChat, {
                text: stripAccents('Dissecar: dump vai no seu PV. Nao apaga a msg citada.')
            }, DISSECAR_SEND_OPTS);
        }

        try {

        const bundle = {
            when: new Date().toISOString(),
            session: ctx.sessionId || conn._sessionId || null,
            chat: ctx.from,
            inbound: null,
            quotedDump: null,
            targets: []
        };

        try {
            bundle.inbound = dissectWaMessage(ctx.info, { includeRawEnvelope: true });
        } catch (e) {
            bundle.inboundError = e.message;
        }

        if (hasQuoted) {
            try {
                const qInfo = {
                    key: quoted.key || {
                        id: quoted.stanzaId,
                        remoteJid: ctx.from,
                        fromMe: false,
                        participant: quoted.participant || quoted.sender,
                        participantAlt: quoted.participantAlt || quoted.participantPn,
                        addressingMode: quoted.key?.addressingMode
                    },
                    message: quotedRaw || quoted.message,
                    messageTimestamp: quoted.messageTimestamp || null,
                    pushName: quoted.pushName || null
                };
                const cache = getSessionCache(ctx, conn);
                const cached = quoted.stanzaId ? cache.get(quoted.stanzaId) : null;
                bundle.quotedDump = dissectWaMessage(cached && cached.message ? cached : qInfo, { includeRawEnvelope: true });
                if (cached && cached !== qInfo) bundle.quotedFromCache = true;
            } catch (e) {
                bundle.quotedError = e.message;
            }
        }

        const authorJids = [];
        const pushAuthor = (j) => {
            const s = ensureJidString(j, '');
            if (!s || /@(g\.us|newsletter|broadcast)$/.test(s)) return;
            if (!authorJids.includes(s)) authorJids.push(s);
        };
        if (bundle.quotedDump?.key?.participant) pushAuthor(bundle.quotedDump.key.participant);
        if (bundle.quotedDump?.key?.participantAlt) pushAuthor(bundle.quotedDump.key.participantAlt);
        if (bundle.quotedDump?.quoted?.participant) pushAuthor(bundle.quotedDump.quoted.participant);
        for (const t of mentionedAsTargets) pushAuthor(t);

        const extra = [...targets];
        for (const a of authorJids.slice(0, 4)) {
            if (!extra.some((t) => String(t) === a)) extra.push(a);
        }

        for (const input of extra.slice(0, 6)) {
            try {
                const result = await dissectTarget(conn, input);
                bundle.targets.push({
                    input,
                    type: result.type,
                    jid: result.jid,
                    fields: result.fields,
                    resolved: result.resolved,
                    reportText: result.reportText
                });
            } catch (e) {
                bundle.targets.push({ input, error: e.message });
            }
        }

        const reports = [];
        if (bundle.quotedDump) reports.push(formatMessageReport(bundle.quotedDump));
        else if (bundle.inbound && hasQuoted) reports.push(formatMessageReport(bundle.inbound));
        for (const t of bundle.targets) {
            if (t.reportText) reports.push(t.reportText);
            else if (t.error) reports.push(stripAccents(`Alvo ${t.input}: ${t.error}`));
        }

        const joined = reports.filter(Boolean).join('\n\n');
        if (joined.length && joined.length <= 3500) {
            await sendDump(dest, { text: joined });
        } else if (joined.length) {
            await sendDump(dest, {
                document: Buffer.from(joined, 'utf-8'),
                mimetype: 'text/plain',
                fileName: 'dissecar_relatorio.txt',
                caption: stripAccents('Dissecar — relatorio')
            });
        }

        const jsonTxt = JSON.stringify(jsonSafe(bundle), null, 2);
        await sendDump(dest, {
            document: Buffer.from(jsonTxt, 'utf-8'),
            mimetype: 'application/json',
            fileName: 'dissecar_completo.json',
            caption: stripAccents(
                `JSON completo (${jsonTxt.length} chars)\n` +
                `Msg=${hasQuoted ? 'sim' : 'nao'} alvos=${bundle.targets.length}`
            )
        });

        logger.logInfo(
            `[DISSECAR] user=${ctx.telegramUserId || '?'} quoted=${hasQuoted ? 1 : 0} alvos=${bundle.targets.length} dest=pv`
        );
        } catch (e) {
            logger.logErro('dissecar', e.message);
            try {
                await sendDump(dest, {
                    text: stripAccents(`Erro ao dissecar: ${e.message}`)
                });
            } catch (_) { /* ignore */ }
        }
    }
};

commands.inspect = commands.dissecar;
commands.raiox = commands.dissecar;

// ========== FAKEMSG — Zone scripts (zone.api.br/scripts) + LID/skipForward ==========
function resolveQuotedKey(ctx, conn) {
    const stanzaId = ctx.quoted?.stanzaId || ctx.quoted?.key?.id;
    try {
        const cache = getSessionCache(ctx, conn);
        const cached = stanzaId && cache.get(stanzaId);
        if (cached?.key?.id) return cached.key;
    } catch (_) { /* ignore */ }
    return {
        id: stanzaId,
        remoteJid: ctx.from,
        fromMe: false,
        participant: ctx.quoted?.participant || ctx.quoted?.sender,
        participantAlt: ctx.quoted?.participantAlt || ctx.quoted?.participantPn || null,
        addressingMode: ctx.quoted?.key?.addressingMode
    };
}

function fakeOpts(extra) {
    return { _hanorkTrusted: true, skipForward: true, ...(extra || {}) };
}

function quotedContextInfo(ctx) {
    try {
        const { unwrapWaMessage } = require('../contextParser');
        const raw = ctx.info?.message;
        const msg = unwrapWaMessage(raw) || raw || {};
        return msg.extendedTextMessage?.contextInfo
            || msg.imageMessage?.contextInfo
            || msg.videoMessage?.contextInfo
            || msg.documentMessage?.contextInfo
            || msg.audioMessage?.contextInfo
            || msg.stickerMessage?.contextInfo
            || {};
    } catch (_) {
        return ctx.info?.message?.extendedTextMessage?.contextInfo || {};
    }
}

function normalizeQuotedParticipant(raw) {
    const jid = ensureJidString(raw || '', '');
    if (!jid) return '';
    try {
        const { jidNormalizedUser } = require('@systemzero/baileys');
        return jidNormalizedUser(jid) || jid;
    } catch (_) {
        return jid.replace(/:\d+(?=@)/, '');
    }
}

async function sendZoneTemp(conn, chat) {
    const opts = fakeOpts();
    try {
        const msg = await conn.sendMessage(chat, { text: '' }, opts);
        if (msg?.key?.id) return msg;
    } catch (e) {
        logger.logAviso(`[fakemsg] temp vazio: ${e.message}`);
    }
    return conn.sendMessage(chat, { text: '\u200e' }, opts);
}

// Zone case_mrfiqjfwp6cuff: temp + edit { id: idTemp } com messageId = stanzaId, depois apaga temp/original/comando
async function runFakeMsgText(conn, ctx, text) {
    const key = resolveQuotedKey(ctx, conn);
    const stanzaId = key?.id || ctx.quoted?.stanzaId;
    if (!stanzaId) {
        return conn.sendMessage(ctx.from, { text: 'marca o usuario o inteligente' }, { quoted: ctx.info });
    }

    const body = String(text).trim();
    const participante = normalizeQuotedParticipant(
        key?.participant || ctx.quoted?.sender || ctx.quoted?.participant || quotedContextInfo(ctx).participant
    );

    const msgTemp = await sendZoneTemp(conn, ctx.from);
    const idTemp = msgTemp?.key?.id;
    if (!idTemp) throw new Error('temp sem id');

    await conn.sendMessage(ctx.from, {
        text: body,
        edit: { id: idTemp }
    }, fakeOpts({ messageId: stanzaId }));

    await Promise.all([
        conn.sendMessage(ctx.from, {
            delete: { remoteJid: ctx.from, id: idTemp, fromMe: true }
        }, fakeOpts()).catch(() => {}),
        conn.sendMessage(ctx.from, {
            delete: {
                remoteJid: ctx.from,
                id: stanzaId,
                fromMe: false,
                participant: participante || undefined
            }
        }, fakeOpts()).catch(() => {}),
        conn.sendMessage(ctx.from, {
            delete: {
                remoteJid: ctx.from,
                id: ctx.info?.key?.id,
                fromMe: !!ctx.info?.key?.fromMe,
                participant: ctx.sender
            }
        }, fakeOpts()).catch(() => {})
    ]);
    logger.logInfo('[fakemsg] zone edit ok');
}

// Zone case_mrmlp5qy13sq08: sendMessage text + quoted { BAE5 id, conversation: textoFake }
async function runFakeChatQuoted(conn, ctx, textoFake, resposta) {
    const ctxInfo = quotedContextInfo(ctx);
    if (!ctxInfo?.participant || ctxInfo?.stanzaId === ctx.info?.key?.id) {
        return conn.sendMessage(ctx.from, {
            text: 'Responda a mensagem de alguem para usar esse comando!'
        }, { quoted: ctx.info });
    }

    const mentioned = normalizeQuotedParticipant(
        ctxInfo.participant || ctx.quoted?.participant || ctx.quoted?.sender
    );
    if (!mentioned) {
        return conn.sendMessage(ctx.from, {
            text: 'Responda a mensagem de alguem para usar esse comando!'
        }, { quoted: ctx.info });
    }

    const p = require('../utils/configManager').prefixFromCtx(ctx);
    if (/^[.\/!#•$+\-]/.test(resposta) || resposta.toLowerCase().startsWith(String(p).toLowerCase())) {
        return conn.sendMessage(ctx.from, {
            text: 'Nao e permitido fazer o bot enviar comandos no fake chat.'
        }, { quoted: ctx.info });
    }

    const crypto = require('crypto');
    const msgId = 'BAE5' + crypto.randomBytes(13).toString('hex').toUpperCase();
    const quoted = {
        key: {
            fromMe: false,
            remoteJid: ctx.from,
            participant: mentioned,
            id: msgId
        },
        message: { conversation: String(textoFake) }
    };
    const alt = ctxInfo.participantAlt || ctxInfo.participantPn || ctx.quoted?.participantAlt || ctx.quoted?.participantPn;
    if (alt) quoted.key.participantAlt = ensureJidString(alt, alt);

    await conn.sendMessage(ctx.from, { text: String(resposta) }, fakeOpts({ quoted }));
    logger.logInfo('[fakemsg] zone fakechat ok');
}

commands.fakemsg = {
    useCtx: true,
    description: 'Fake msg (responda) — texto | fakechat com texto|resposta',
    usage: 'fakemsg <texto>  ou  fakemsg texto fake|resposta do bot (responda)',
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) {
            return conn.sendMessage(ctx.from, { text: 'Apenas o dono da sessao.' }, { quoted: ctx.info });
        }
        if (!ctx.quoted) {
            return conn.sendMessage(ctx.from, {
                text: 'Responda a msg de alguem.\n.fakemsg texto\n.fakemsg mensagem fake|resposta'
            }, { quoted: ctx.info });
        }
        const raw = String(ctx.text || '').trim();
        if (!raw) {
            return conn.sendMessage(ctx.from, { text: 'Falta o texto.' }, { quoted: ctx.info });
        }
        try {
            if (raw.includes('|')) {
                const [a, ...rest] = raw.split('|');
                const b = rest.join('|').trim();
                if (!String(a || '').trim() || !b) {
                    return conn.sendMessage(ctx.from, { text: 'Uso: fakemsg texto fake|resposta' }, { quoted: ctx.info });
                }
                await runFakeChatQuoted(conn, ctx, String(a).trim(), b);
                return;
            }
            await runFakeMsgText(conn, ctx, raw);
        } catch (e) {
            logger.logAviso(`[fakemsg] ${e.message}`);
            await conn.sendMessage(ctx.from, { text: 'Nao deu pra aplicar o fake nesta msg.' }, { quoted: ctx.info });
        }
    }
};
commands.fakechat = commands.fakemsg;

// ========== FAKE COM SUPORTE A MÍDIA ==========
commands.fake = {
    useCtx: true,
    description: "Edita uma mensagem com midia (fake)",
    usage: "fake <legenda> (responda a mensagem + envie midia)",
    execute: async (conn, ctx) => {
        // Verifica se há uma mensagem citada
        if (!ctx.quoted) {
            return conn.sendMessage(ctx.from, { 
                text: 'Responda a mensagem que deseja substituir.' 
            }, { quoted: ctx.info });
        }

        const texto = ctx.text || '';
        const hasMedia = ctx.hasMedia;
        const mediaType = ctx.mediaType;

        // Se tem mídia mas não tem legenda, pede legenda
        if (hasMedia && !texto) {
            return conn.sendMessage(ctx.from, { 
                text: 'Forneca uma legenda para a midia.' 
            }, { quoted: ctx.info });
        }

        // Se não tem mídia, usa o comando normal de texto
        if (!hasMedia) {
            // Chama o fakemsg original
            return commands.fakemsg.execute(conn, ctx);
        }

        const key = resolveQuotedKey(ctx, conn);
        const stanzaId = key?.id || ctx.quoted.stanzaId;
        const participante = ensureJidString(key?.participant || ctx.quoted.sender || ctx.quoted.participant || '', '');
        const trusted = { _hanorkTrusted: true, skipForward: true };

        try {
            // Baixa a mídia
            const buffer = await ctx.downloadMedia();
            if (!buffer) {
                return conn.sendMessage(ctx.from, { 
                    text: 'Falha ao baixar a midia.' 
                }, { quoted: ctx.info });
            }

            // Prepara o objeto de mensagem
            let messageObj = { caption: texto };
            let tipo = mediaType;

            if (tipo === 'image') {
                messageObj.image = buffer;
            } else if (tipo === 'video') {
                messageObj.video = buffer;
            } else if (tipo === 'audio') {
                messageObj.audio = buffer;
                messageObj.mimetype = ctx.message.audioMessage?.mimetype || 'audio/mp4';
                messageObj.ptt = true;
            } else if (tipo === 'gif') {
                messageObj.video = buffer;
                messageObj.gifPlayback = true;
                messageObj.caption = texto;
            } else {
                return conn.sendMessage(ctx.from, { 
                    text: `Tipo de midia nao suportado: ${tipo}. Use imagem, video, audio ou GIF.` 
                }, { quoted: ctx.info });
            }

            await conn.sendMessage(ctx.from, messageObj, trusted);

            await Promise.all([
                conn.sendMessage(ctx.from, {
                    delete: {
                        remoteJid: ctx.from,
                        id: stanzaId,
                        fromMe: false,
                        participant: participante || undefined
                    }
                }, trusted).catch(() => {}),
                conn.sendMessage(ctx.from, {
                    delete: {
                        remoteJid: ctx.from,
                        id: ctx.info.key.id,
                        fromMe: ctx.info.key.fromMe || false,
                        participant: ctx.sender
                    }
                }, trusted).catch(() => {}),
            ]);

            logger.logInfo(`[fake] Mídia ${tipo} enviada e original apagada para ${participante}`);

        } catch (e) {
            console.error('[fake]', e.message);
            await conn.sendMessage(ctx.from, { 
                text: 'Erro: ' + e.message 
            }, { quoted: ctx.info });
        }
    }
};

/** BNA: apaga msgs do alvo (fluxo antigo deletar) + remove do grupo */
commands.bna = {
    useCtx: true,
    description: "Apaga msgs do usuario e remove do grupo (responda a msg)",
    usage: "bna (responda a mensagem do alvo)",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) {
            const extra = collectMessageSenderIds(ctx.info, [ctx.senderAlt, ctx.sender]);
            const adminOk = await isGroupAdminStrict(conn, ctx.from, ctx.sender, extra);
            if (!adminOk) {
                return;
            }
        }

        if (!ctx.quoted) {
            const { prefixFromCtx, cmdExample } = require('../utils/configManager');
            const p = prefixFromCtx(ctx);
            return conn.sendMessage(ctx.from, {
                text: `Responda a mensagem da pessoa.\nUso: ${cmdExample(ctx.telegramUserId, 'bna', { prefix: p })}`
            }, { quoted: ctx.info }).catch(() => {});
        }

        const stanzaId = ctx.quoted.stanzaId;
        const participante = ensureJidString(
            ctx.quoted.sender || ctx.quoted.participant || ctx.sender,
            ''
        );
        try {
            const { checkTargetAction } = require('../utils/permissionEngine');
            if (!checkTargetAction(conn, { ...ctx, command: 'bna' }, participante).allowed) return;
        } catch (_) { /* */ }

        if (ctx.isGroup) {
            const targetUser = participante;
            logger.logInfo(`[bna] Iniciando - Alvo: ${targetUser}, Grupo: ${ctx.from} session=${ctx.sessionId || conn._sessionId}`);

            try {
                ctx.deletarTarget = targetUser;
                const historyMessages = await fetchGroupHistory(conn, ctx);
                const messagesToDelete = historyMessages.map((msg) => ({
                    id: msg.key.id,
                    participant: ensureJidString(
                        msg.key.participant || (msg.key.fromMe ? conn.user?.id : null),
                        targetUser
                    ),
                    fromMe: msg.key.fromMe || false,
                    full: msg.full || msg
                }));

                if (stanzaId && !messagesToDelete.some((m) => m.id === stanzaId)) {
                    messagesToDelete.push({
                        id: stanzaId,
                        participant: targetUser,
                        fromMe: false,
                        full: resolveQuotedFullMessage(ctx, conn)
                    });
                }

                try { persistCache(ctx.sessionId || conn._sessionId || 'default'); } catch {}

                logger.logInfo(`[bna] ${messagesToDelete.length} msgs do alvo`);

                const { deletedCount, failedCount, truncated } = await deleteMessagesAsAdminBulk(
                    conn,
                    ctx.from,
                    messagesToDelete,
                    targetUser
                );

                // Apaga comando do dono (delete normal)
                try {
                    await deleteMessageAsAdmin(
                        conn,
                        ctx.from,
                        ctx.info.key.id,
                        ctx.info.key.fromMe || false,
                        ctx.sender
                    );
                } catch (_) {}

                // Kick com JID real do grupo (LID/PN)
                let kicked = false;
                const kickJid = await resolveGroupMemberJid(conn, ctx.from, targetUser);
                try {
                    if (!isKickableJid(kickJid)) {
                        throw new Error('alvo invalido');
                    }
                    await conn.groupParticipantsUpdate(ctx.from, [kickJid], 'remove');
                    kicked = true;
                } catch (e) {
                    logger.logErro(`[bna] kick: ${e.message}`);
                }

                const wantBlack = /\b(ln|listanegra|black)\b/i.test(String(ctx.text || ''));
                if (wantBlack && kicked) {
                    try {
                        const { toggleListMember } = require('../utils/moderation');
                        toggleListMember(ctx.from, ctx.telegramUserId, 'blacklist', kickJid || targetUser, true);
                    } catch (_) {}
                }

                await conn.sendMessage(ctx.from, {
                    text:
                        `BNA concluido\n` +
                        `Msgs apagadas: ${deletedCount}` +
                        (failedCount ? ` (falhas: ${failedCount})` : '') +
                        (truncated ? ` (limite ${HISTORY_SEARCH_LIMIT})` : '') +
                        `\nRemovido do grupo: ${kicked ? 'SIM' : 'FALHOU (bot precisa ser admin)'}` +
                        (wantBlack && kicked ? '\nLista negra: SIM' : ''),
                    mentions: [kickJid || targetUser]
                });

            } catch (e) {
                logger.logErro('[bna]', e.message);
                await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
            }
        } else {
            try {
                if (stanzaId) {
                    await deleteMessageSmart(
                        conn,
                        ctx.from,
                        stanzaId,
                        false,
                        participante,
                        resolveQuotedFullMessage(ctx, conn)
                    );
                }
                await deleteMessageAsAdmin(
                    conn,
                    ctx.from,
                    ctx.info.key.id,
                    ctx.info.key.fromMe || false,
                    ctx.sender
                );
            } catch (e) {
                console.error('[bna]', e.message);
            }
        }
    }
};
commands.deletar = {
    useCtx: true,
    description: "Apaga ate 50 msgs do alvo (mencao, reply ou marca). Nao remove do grupo.",
    usage: "deletar (responda, marque ou mencione)",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner && !ctx.isVip) {
            const extra = collectMessageSenderIds(ctx.info, [ctx.senderAlt, ctx.sender]);
            const adminOk = await isGroupAdminStrict(conn, ctx.from, ctx.sender, extra);
            if (!adminOk) {
                return;
            }
        }
        if (!ctx.isGroup) {
            return conn.sendMessage(ctx.from, {
                text: 'Use no grupo: responda, marque ou mencione a pessoa.'
            }, { quoted: ctx.info }).catch(() => {});
        }
        const targetUser = await resolveDeleteTarget(ctx, conn);
        if (ctx._hanorkTargetImmune) return;
        if (!targetUser) {
            const { prefixFromCtx } = require('../utils/configManager');
            const p = prefixFromCtx(ctx);
            return conn.sendMessage(ctx.from, {
                text: `Responda, marque ou mencione a pessoa.\nUso: ${p}deletar`
            }, { quoted: ctx.info }).catch(() => {});
        }
        try {
            const { isSessionSelfIdentity } = require('../utils/moderation');
            if (isSessionSelfIdentity(conn, targetUser)) {
                return conn.sendMessage(ctx.from, {
                    text: 'Nao apago as mensagens do bot.'
                }, { quoted: ctx.info }).catch(() => {});
            }
        } catch (_) { /* ignore */ }

        logger.logInfo(`[deletar] alvo session=${ctx.sessionId || conn._sessionId}`);
        try {
            const out = await purgeUserMessages(conn, ctx, targetUser);
            logger.logInfo(`[deletar] empty=${!!out.empty} deleted=${out.deletedCount || 0} failed=${out.failedCount || 0}`);
            if (out.empty && ctx.quoted?.stanzaId) {
                await deleteMessageSmart(
                    conn,
                    ctx.from,
                    ctx.quoted.stanzaId,
                    false,
                    targetUser,
                    resolveQuotedFullMessage(ctx, conn)
                );
            }
            try {
                await deleteMessageAsAdmin(
                    conn,
                    ctx.from,
                    ctx.info.key.id,
                    ctx.info.key.fromMe || false,
                    ctx.sender
                );
            } catch (_) { /* ignore */ }
            const { mentionTag } = require('../utils/groupTheftGuard');
            const tag = mentionTag(targetUser);
            await conn.sendMessage(ctx.from, {
                text: out.empty
                    ? `Nenhuma msg no cache. Apaguei a citada se o bot for admin.\nAlvo: ${tag.tag}`
                    : `Apaguei ${out.deletedCount} msg(s) (max ${HISTORY_SEARCH_LIMIT}). Nao removi do grupo.` +
                      (out.failedCount ? `\nFalhas: ${out.failedCount}` : ''),
                mentions: tag.jid ? [tag.jid] : []
            }).catch(() => {});
        } catch (e) {
            logger.logErro('[deletar]', e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info }).catch(() => {});
        }
    }
};
commands.band = commands.bna;
commands.d = commands.deletar;
commands.deleta = commands.deletar;
commands.apaga = commands.deletar;
commands.apagar = commands.deletar;
commands.clearuser = {
    useCtx: true,
    description: "Alias de deletar (apaga ate 50 msgs, sem ban)",
    usage: "clearuser (responda, marque ou mencione)",
    execute: (conn, ctx) => commands.deletar.execute(conn, ctx)
};
commands.clearall = commands.clearuser;

module.exports = { commands };