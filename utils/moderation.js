// utils/moderation.js
// Sistema de moderação anti-abuso para grupos (Tarefa 3)
const logger = require("../logger");
const { getCache } = require("../cache");
const { getModerationConfig, setModerationConfig } = require("./configManager");
const { ensureJidString, normalizeJid } = require("../utils");

const FLOOD_THRESHOLD = Number(process.env.MOD_FLOOD_THRESHOLD || 5);
const FLOOD_TIME_WINDOW = Number(process.env.MOD_FLOOD_WINDOW_MS || 10000);

// Cache para rastrear mensagens suspeitas por grupo+sender
const groupSuspicionCache = new Map();

/** Protobuf nativo de cobranca WA — NAO texto ("pix", "pagamento", "R$"). */
const NATIVE_PAYMENT_KEYS = [
    'requestPaymentMessage',
    'sendPaymentMessage',
    'declinePaymentRequestMessage',
    'cancelPaymentRequestMessage',
    'paymentInviteMessage',
    'invoiceMessage'
];

const PAYMENT_FLOW_NAMES = new Set([
    'payment_info',
    'review_and_pay',
    'pix',
    'send_payment',
    'request_payment',
    'payment_status',
    'mpm'
]);

/** Copia a key do Zap (addressingMode / Alt). Revoke sem isso "ok" e a bolha fica. */
function cloneWaKey(key, overrides = {}) {
    const k = key && typeof key === 'object' ? key : {};
    const out = {
        remoteJid: k.remoteJid,
        id: k.id,
        fromMe: !!k.fromMe
    };
    if (k.participant) out.participant = k.participant;
    if (k.participantAlt) out.participantAlt = k.participantAlt;
    if (k.participantPn) out.participantPn = k.participantPn;
    if (k.remoteJidAlt) out.remoteJidAlt = k.remoteJidAlt;
    if (k.addressingMode) out.addressingMode = k.addressingMode;
    if (k.server_id) out.server_id = k.server_id;
    Object.assign(out, overrides);
    if (!Object.prototype.hasOwnProperty.call(overrides, 'fromMe')) {
        out.fromMe = !!k.fromMe;
    }
    return out;
}

/**
 * Apaga mensagem como admin (protocolo delete normal do WhatsApp).
 * Usa o participant ORIGINAL da msg primeiro (LID ou PN como o Zap gravou).
 * Nao troca pelo id do metadata — isso fazia o revoke "sucesso" sem apagar.
 * Se o original falhar, tenta LID e PN do membro.
 * origKey: key completa do upsert (addressingMode / participantAlt).
 */
async function deleteMessageAsAdmin(conn, groupId, messageId, fromMe, participant, origKey = null) {
    const gid = ensureJidString(groupId, '');
    const mid = String(messageId || '');
    const original = ensureJidString(participant, '');
    if (!gid || !mid) return { success: false, id: mid, error: 'invalid ids' };
    try { require('./antiDelete').noteBotDeleted(mid); } catch (_) { /* ignore */ }

    const sendDel = async (part) => {
        const delKey = origKey && origKey.id === mid
            ? cloneWaKey(origKey, {
                remoteJid: gid,
                id: mid,
                fromMe: !!fromMe,
                participant: fromMe ? undefined : (part || origKey.participant || undefined)
            })
            : {
                remoteJid: gid,
                id: mid,
                fromMe: !!fromMe,
                participant: fromMe ? undefined : (part || undefined)
            };
        if (fromMe) delete delKey.participant;
        if (delKey.participant === undefined) delete delKey.participant;
        await Promise.race([
            conn.sendMessage(gid, { delete: delKey }, { _hanorkTrusted: true }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('delete-timeout')), 2500))
        ]);
    };

    const altParts = () => {
        const out = [];
        const seen = new Set();
        const push = (v) => {
            const s = ensureJidString(v, '');
            if (!s || seen.has(s) || s === original || !isKickableJid(s)) return;
            seen.add(s);
            out.push(s);
        };
        try {
            const { peekGroupMetadata } = require('./groupMetaCache');
            const { rememberLidPhonePair } = require('../utils');
            const meta = peekGroupMetadata(gid) || {};
            const hit = (meta.participants || []).find((p) =>
                participantIdentityIds(p).some((id) => sameParticipant(id, original))
            );
            if (hit) {
                const ids = participantIdentityIds(hit);
                const lid = ids.find((id) => isLidJid(id));
                const pn = ids.find((id) => isPhoneJid(id));
                if (lid && pn) {
                    try { rememberLidPhonePair(lid, pn); } catch (_) { /* cache opcional */ }
                }
                for (const id of ids) push(id);
            }
        } catch (_) { /* peek opcional */ }
        return out;
    };

    try {
        if (fromMe) {
            await sendDel(undefined);
            return { success: true, id: mid, via: 'admin' };
        }
        try {
            await sendDel(original || undefined);
            return { success: true, id: mid, via: 'admin' };
        } catch (e) {
            const first = String(e && e.message ? e.message : e);
            if (/rate-overlimit|forbidden|not-authorized/i.test(first)) throw e;
            let lastErr = first;
            for (const p of altParts()) {
                try {
                    await sendDel(p);
                    return { success: true, id: mid, via: 'admin' };
                } catch (e2) {
                    lastErr = String(e2 && e2.message ? e2.message : e2);
                    if (/rate-overlimit|forbidden|not-authorized/i.test(lastErr)) break;
                }
            }
            throw new Error(lastErr);
        }
    } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        if (/rate-overlimit|forbidden|not-authorized/i.test(msg)) {
            logger.logAviso(`[ADMIN_DELETE] ${mid}: ${msg}`);
        } else {
            logger.logErro(`[ADMIN_DELETE] ${mid}: ${msg}`);
        }
        return { success: false, id: mid, error: msg, via: 'admin' };
    }
}

/**
 * Tecnica fakemsg — SO pra apagar requestPaymentMessage (divulgacao / PIX nativo).
 * Copia o .fakemsg que funciona: temp + edit { id: idTemp } com messageId = stanza alvo,
 * _hanorkTrusted + skipForward. Sem isso o Zap ignora o steal e a bolha PIX fica.
 */
async function deleteMessageWithFakeTechnique(conn, groupId, messageId, fromMe, participant, origKey = null) {
    const gid = ensureJidString(groupId, '');
    const mid = String(messageId || '');
    const part = ensureJidString(participant, '');
    if (!gid || !mid) return { success: false, id: mid, error: 'invalid ids' };
    const trusted = { _hanorkTrusted: true, skipForward: true };

    try {
        let temp;
        try {
            temp = await conn.sendMessage(gid, { text: '' }, trusted);
        } catch (e) {
            logger.logAviso(`[FAKE_DELETE] temp vazio: ${e.message}`);
            temp = await conn.sendMessage(gid, { text: '\u200e' }, trusted);
        }
        const idTemp = temp?.key?.id;
        if (!idTemp) throw new Error('temp_id_missing');

        await conn.sendMessage(
            gid,
            { text: '\u200e', edit: { id: idTemp } },
            { ...trusted, messageId: mid }
        );

        const origDel = origKey && origKey.id === mid
            ? cloneWaKey(origKey, {
                remoteJid: gid,
                id: mid,
                fromMe: !!fromMe,
                participant: fromMe ? undefined : (part || origKey.participant || undefined)
            })
            : {
                remoteJid: gid,
                id: mid,
                fromMe: !!fromMe,
                participant: fromMe ? undefined : (part || undefined)
            };
        if (fromMe || origDel.participant === undefined) delete origDel.participant;

        await Promise.all([
            conn.sendMessage(gid, { delete: { remoteJid: gid, id: idTemp, fromMe: true } }, trusted).catch(() => {}),
            conn.sendMessage(gid, { delete: origDel }, trusted).catch(() => {})
        ]);

        logger.logAviso(`[FAKE_DELETE] ok id=${mid}`);
        return { success: true, id: mid, via: 'fake_payment' };
    } catch (e) {
        logger.logAviso(`[FAKE_DELETE] ${mid}: ${e.message} — fallback admin`);
        return deleteMessageAsAdmin(conn, gid, mid, fromMe, part, origKey);
    }
}

/**
 * Normal (texto/audio/foto/video) → admin delete.
 * Pagamento divulgacao (requestPaymentMessage) → tecnica fakemsg.
 */
async function deleteMessageSmart(conn, groupId, messageId, fromMe, participant, messageOrHint = null) {
    if (messageOrHint && isGroupStatusLike(messageOrHint)) {
        return deleteGroupStatusAsAdmin(conn, messageOrHint);
    }
    if (isDivulgacaoPaymentPayload(messageOrHint)) {
        const origKey = messageOrHint?.key && messageOrHint.key.id === messageId ? messageOrHint.key : null;
        return deleteMessageWithFakeTechnique(conn, groupId, messageId, fromMe, participant, origKey);
    }
    const origKey = messageOrHint?.key && messageOrHint.key.id === messageId ? messageOrHint.key : null;
    return deleteMessageAsAdmin(conn, groupId, messageId, fromMe, participant, origKey);
}

function groupJidForStatusDelete(key) {
    const a = ensureJidString(key?.remoteJid, '');
    if (a.endsWith('@g.us')) return a;
    const b = ensureJidString(key?.remoteJidAlt, '');
    if (b.endsWith('@g.us')) return b;
    return a;
}

function pickStatusContextInfo(message) {
    const raw = message?.message || {};
    const inner = unwrapMessage(message) || raw;
    const nodes = [
        inner.extendedTextMessage,
        inner.imageMessage,
        inner.videoMessage,
        inner.documentMessage,
        inner.audioMessage,
        raw.extendedTextMessage,
        raw.imageMessage,
        raw.videoMessage,
        raw.groupStatusMentionMessage,
        raw.groupStatusMessageV2,
        raw.groupStatusMessage
    ];
    for (const n of nodes) {
        if (!n || typeof n !== 'object') continue;
        if (n.contextInfo) return n.contextInfo;
        const nested = n.message;
        if (nested?.extendedTextMessage?.contextInfo) return nested.extendedTextMessage.contextInfo;
        if (nested?.imageMessage?.contextInfo) return nested.imageMessage.contextInfo;
        if (nested?.videoMessage?.contextInfo) return nested.videoMessage.contextInfo;
    }
    return {};
}

function statusAuthorIsBot(conn, jid) {
    const s = ensureJidString(jid, '');
    if (!s || !conn) return false;
    const botId = ensureJidString(conn.user?.id, '');
    const botLid = ensureJidString(conn.user?.lid, '');
    if (botId && identitiesEqualStrict(s, botId)) return true;
    if (botLid && identitiesEqualStrict(s, botLid)) return true;
    return false;
}

/**
 * Keys de revoke do status GP — tecnica delstts (zone.api.br/scripts case_ms8q0qc1qgglnt):
 * remoteJid = grupo (nunca status@broadcast); id = stanza original; participant = autor.
 */
function groupStatusKeyVariants(message, conn = null) {
    const key = message?.key || {};
    const gid = groupJidForStatusDelete(key);
    const variants = [];
    const seen = new Set();
    const push = (k) => {
        if (!k?.id || !gid) return;
        const dest = ensureJidString(k.remoteJid, gid);
        const remote = dest.endsWith('@g.us') ? dest : gid;
        if (remote.endsWith('@broadcast')) return;
        const part = ensureJidString(k.participant, '');
        const sig = `${k.id}|${part}|${k.addressingMode || ''}|${k.fromMe ? 1 : 0}`;
        if (seen.has(sig)) return;
        seen.add(sig);
        variants.push({ ...k, remoteJid: remote });
    };

    const ctx = pickStatusContextInfo(message);
    let innerKey = null;
    try {
        const rawMsg = message?.message || {};
        const gs =
            rawMsg.groupStatusMessageV2 ||
            rawMsg.groupStatusMessage ||
            rawMsg.groupStatusMentionMessage;
        if (gs && typeof gs === 'object') innerKey = gs.key || gs.message?.key || null;
    } catch (_) { /* inner key opcional */ }

    const originalId = String(
        innerKey?.id ||
        ctx.stanzaId ||
        ctx.quotedMessage?.key?.id ||
        key.id ||
        ''
    );
    const author = ensureJidString(
        innerKey?.participant ||
        ctx.participant ||
        key.participant ||
        '',
        ''
    );
    const fromMe = statusAuthorIsBot(conn, author);

    // 1) Key canonica delstts (bandeja)
    if (originalId) {
        const zoneKey = {
            remoteJid: gid,
            id: originalId,
            fromMe,
            participant: fromMe ? undefined : (author || undefined)
        };
        if (key.participantAlt && originalId === key.id) zoneKey.participantAlt = key.participantAlt;
        if (key.addressingMode && originalId === key.id) zoneKey.addressingMode = key.addressingMode;
        if (!zoneKey.participant) delete zoneKey.participant;
        push(zoneKey);
    }

    // 2) Envelope original (bolha / cartao de mencao)
    push(cloneWaKey(key, { remoteJid: gid, fromMe: statusAuthorIsBot(conn, key.participant) }));
    if (innerKey?.id) {
        push(cloneWaKey(innerKey, { remoteJid: gid }));
    }

    const senderIds = collectMessageSenderIds(message);
    const pn = senderIds.find((id) => isPhoneJid(id));
    const lid = senderIds.find((id) => isLidJid(id));
    if (originalId && pn) {
        push({ remoteJid: gid, id: originalId, fromMe: false, participant: pn, addressingMode: 'pn' });
    }
    if (originalId && lid) {
        push({ remoteJid: gid, id: originalId, fromMe: false, participant: lid, addressingMode: 'lid' });
    }
    for (const sid of senderIds) {
        if (originalId) push({ remoteJid: gid, id: originalId, fromMe: false, participant: sid });
    }
    return { gid, originalId, envelopeId: String(key.id || ''), variants };
}

async function tryLibDeleteGroupStatus(conn, gid, key) {
    if (typeof conn.deleteGroupStatus === 'function') {
        await conn.deleteGroupStatus(gid, key);
        return 'conn.deleteGroupStatus';
    }
    try {
        const b = require('@systemzero/baileys');
        if (typeof b.deleteGroupStatus === 'function') {
            await b.deleteGroupStatus(conn, gid, key);
            return 'lib.deleteGroupStatus';
        }
    } catch (_) { /* helper opcional */ }
    return null;
}

/**
 * Apaga status de grupo (bandeja + bolha).
 * Primario = delstts: sendMessage({ delete: key }) no JID do grupo, id=stanza original.
 * Depois wrap groupStatus:true pra bandeja. Sem relay edit:8 (so tirava a bolha).
 */
async function deleteGroupStatusAsAdmin(conn, message) {
    const packed = groupStatusKeyVariants(message, conn);
    const gid = packed.gid;
    const mid = packed.originalId || String(message?.key?.id || '');
    if (!gid || !mid || !gid.endsWith('@g.us')) {
        return { success: false, id: mid, error: 'invalid ids' };
    }

    const variants = packed.variants;
    let lastErr = '';
    let okVia = '';

    for (const k of variants) {
        try {
            const via = await tryLibDeleteGroupStatus(conn, gid, k);
            if (via) {
                okVia = via;
                break;
            }
        } catch (e) {
            lastErr = String(e && e.message ? e.message : e);
            if (/rate-overlimit|forbidden|not-authorized/i.test(lastErr)) {
                logger.logAviso(`[STATUS_DEL] lib ${mid}: ${lastErr}`);
                break;
            }
        }
    }

    // delstts: delete simples no grupo (nao status@broadcast)
    if (!okVia) {
        for (const k of variants) {
            try {
                await conn.sendMessage(gid, { delete: k }, { _hanorkTrusted: true });
                okVia = 'delstts';
                break;
            } catch (e) {
                lastErr = String(e && e.message ? e.message : e);
                if (/rate-overlimit|forbidden|not-authorized/i.test(lastErr)) break;
            }
        }
    }

    // Bandeja: mesmo key com wrap groupStatus (envio de status GP usa esse flag)
    for (const k of variants) {
        try {
            await conn.sendMessage(gid, { delete: k, groupStatus: true }, { _hanorkTrusted: true });
            if (!okVia) okVia = 'status-wrap';
            break;
        } catch (e) {
            lastErr = String(e && e.message ? e.message : e);
            if (/rate-overlimit|forbidden|not-authorized/i.test(lastErr)) break;
        }
    }

    // Cartao de mencao tem id diferente do status da bandeja — apaga a bolha tambem
    if (packed.envelopeId && packed.envelopeId !== packed.originalId) {
        try {
            const envKey = cloneWaKey(message.key, { remoteJid: gid });
            await conn.sendMessage(gid, { delete: envKey }, { _hanorkTrusted: true });
        } catch (_) { /* bolha extra */ }
    }

    if (okVia) {
        logger.logInfo(`[STATUS_DEL] via=${okVia} id=${mid}`);
        return { success: true, id: mid, via: okVia };
    }

    logger.logAviso(`[STATUS_DEL] falhou id=${mid}: ${lastErr || 'no-strategy'}`);
    const key = message?.key || {};
    return deleteMessageAsAdmin(
        conn,
        gid,
        packed.envelopeId || mid,
        !!key.fromMe,
        key.participant,
        key
    );
}

/** Pipeline: status GP → bandeja; PIX nativo → fakemsg; resto → admin + key original. */
async function deleteInboundMessage(conn, message, participantFallback) {
    const key = message?.key || {};
    const gid = ensureJidString(key.remoteJid, '');
    const mid = String(key.id || '');
    const fromMe = !!key.fromMe;
    const part = ensureJidString(key.participant || participantFallback, '');
    if (!gid || !mid) return { success: false, id: mid, error: 'invalid ids' };
    if (isGroupStatusLike(message)) return deleteGroupStatusAsAdmin(conn, message);
    if (isDivulgacaoPaymentPayload(message)) {
        return deleteMessageWithFakeTechnique(conn, gid, mid, fromMe, part, key);
    }
    return deleteMessageAsAdmin(conn, gid, mid, fromMe, part, key);
}

function getMessageText(msg) {
    if (!msg) return '';
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.requestPaymentMessage?.noteMessage?.extendedTextMessage?.text) {
        return msg.requestPaymentMessage.noteMessage.extendedTextMessage.text;
    }
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;
    if (msg.buttonsMessage?.contentText) return msg.buttonsMessage.contentText;
    if (msg.listMessage?.description) return msg.listMessage.description;
    return '';
}

function unwrapMessage(message) {
    let msg = message?.message || message;
    if (!msg || typeof msg !== 'object') return null;
    // wrappers comuns + status-de-grupo / edit (pagamento "invisivel" mora aqui)
    for (let i = 0; i < 8; i++) {
        if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
        else if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
        else if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
        else if (msg.viewOnceMessageV2Extension?.message) msg = msg.viewOnceMessageV2Extension.message;
        else if (msg.documentWithCaptionMessage?.message) msg = msg.documentWithCaptionMessage.message;
        else if (msg.botInvokeMessage?.message) msg = msg.botInvokeMessage.message;
        else if (msg.groupStatusMessage?.message) msg = msg.groupStatusMessage.message;
        else if (msg.groupStatusMessageV2?.message) msg = msg.groupStatusMessageV2.message;
        else if (msg.groupStatusMentionMessage?.message) msg = msg.groupStatusMentionMessage.message;
        else if (msg.editedMessage?.message) msg = msg.editedMessage.message;
        else if (msg.protocolMessage?.editedMessage) msg = msg.protocolMessage.editedMessage;
        else if (msg.associatedChildMessage?.message) msg = msg.associatedChildMessage.message;
        else if (msg.futureProofMessage?.message) msg = msg.futureProofMessage.message;
        else if (msg.deviceSentMessage?.message) msg = msg.deviceSentMessage.message;
        else break;
    }
    return msg;
}

/**
 * Deep-walk do TIPO da msg (crash/trava/status).
 * NAO entra em quoted/noteMessage — isso e texto da divulgacao citada, nao o tipo desta msg.
 */
const ATTACK_WALK_SKIP = new Set([
    'quotedMessage',
    'quotedAd',
    'hydratedQuotedMessage',
    'noteMessage',
    'contextInfo'
]);

function walkMessageNodes(root, visit, depth = 0) {
    if (!root || typeof root !== 'object' || depth > 8) return;
    visit(root, depth);
    for (const [k, v] of Object.entries(root)) {
        if (ATTACK_WALK_SKIP.has(k)) continue;
        if (v && typeof v === 'object') {
            if (Array.isArray(v)) {
                for (const item of v.slice(0, 40)) {
                    if (item && typeof item === 'object') walkMessageNodes(item, visit, depth + 1);
                }
            } else {
                walkMessageNodes(v, visit, depth + 1);
            }
        } else if (typeof v === 'string' && (k === 'paramsJson' || k === 'description' || k === 'groupName')) {
            // paramsJson = nome de flow (tipo); description/groupName = tamanho de crash — nunca o copy da div
            visit({ __field: k, __value: v }, depth);
        }
    }
}

/** contextInfo de status de grupo (mencao/postagem) — espelho statuspost/divstatus */
function hasGroupStatusContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return false;
    return !!(
        ctx.isGroupStatus ||
        ctx.statusSourceType != null ||
        ctx.statusAttributionType != null ||
        ctx.statusMentionMessage ||
        (Array.isArray(ctx.statusMentioned) && ctx.statusMentioned.length > 0)
    );
}

function hasGroupStatusPayload(raw, inner) {
    if (!raw && !inner) return false;
    // V1 + V2 + cartao de mencao na bandeja. contextInfo de repost pessoal e outro detector.
    return !!(
        raw?.groupStatusMessageV2 ||
        inner?.groupStatusMessageV2 ||
        raw?.groupStatusMessage ||
        inner?.groupStatusMessage ||
        raw?.groupStatusMentionMessage ||
        inner?.groupStatusMentionMessage
    );
}

function isGroupStatusLike(message) {
    if (!message) return false;
    if (message._hanorkGroupStatus) return true;
    try {
        const b = require('@systemzero/baileys');
        if (typeof b.hasGroupStatusMessage === 'function' && b.hasGroupStatusMessage(message)) return true;
        if (typeof b.hasGroupStatusFlag === 'function' && b.hasGroupStatusFlag(message.message || message)) {
            return true;
        }
    } catch (_) { /* detector da lib opcional */ }
    const raw = message.message || (typeof message === 'object' && !message.key ? message : null);
    if (!raw || typeof raw !== 'object') return false;
    const inner = unwrapMessage(message) || raw;
    if (hasGroupStatusPayload(raw, inner)) return true;
    const ctx =
        inner.extendedTextMessage?.contextInfo ||
        inner.imageMessage?.contextInfo ||
        inner.videoMessage?.contextInfo ||
        raw.extendedTextMessage?.contextInfo ||
        {};
    return hasGroupStatusContext(ctx);
}

/**
 * Status de grupo que o Zap mostra so pra admin (oi.json: statusSourceType=4 + isGroupStatus).
 * Nao e bolha normal — .deletar admin-revoke nao tira; precisa deleteGroupStatusAsAdmin.
 */
function isAdminVisibleOnlyStatus(message) {
    if (!message) return false;
    if (message._hanorkGroupStatus) return true;
    const raw = message.message || (typeof message === 'object' && !message.key ? message : null) || {};
    if (raw.groupStatusMessageV2 || raw.groupStatusMessage || raw.groupStatusMentionMessage) return true;
    const inner = unwrapMessage(message) || raw;
    if (inner.groupStatusMessageV2 || inner.groupStatusMessage || inner.groupStatusMentionMessage) return true;
    const ctx =
        inner.extendedTextMessage?.contextInfo ||
        inner.imageMessage?.contextInfo ||
        inner.videoMessage?.contextInfo ||
        raw.extendedTextMessage?.contextInfo ||
        {};
    if (!(ctx.isGroupStatus === true || Number(ctx.statusSourceType) === 4)) return false;
    // Resposta citando status: nao e o post da bandeja
    if (ctx.quotedMessage && ctx.stanzaId && !hasGroupStatusPayload(raw, inner)) return false;
    return true;
}

const SCAM_INVITE_RE = /chat\.whatsapp\.com\/|whatsapp\.com\/channel\/|wa\.me\//i;

function collectOwnContextInfos(message) {
    const raw = message?.message || {};
    const inner = unwrapMessage(message) || raw;
    const pay = inner.requestPaymentMessage || raw.requestPaymentMessage || {};
    const note = pay.noteMessage?.extendedTextMessage || {};
    return [
        inner.extendedTextMessage?.contextInfo,
        inner.imageMessage?.contextInfo,
        inner.videoMessage?.contextInfo,
        raw.extendedTextMessage?.contextInfo,
        note.contextInfo
    ].filter((c) => c && typeof c === 'object');
}

function extractFloodText(message) {
    const inner = unwrapMessage(message) || message?.message || {};
    const pay = inner.requestPaymentMessage || message?.message?.requestPaymentMessage;
    const note = String(pay?.noteMessage?.extendedTextMessage?.text || '');
    const t = String(getMessageText(inner) || getMessageText(message) || '');
    return `${t}\n${note}`;
}

function countFloodMentions(message) {
    let n = 0;
    for (const ctx of collectOwnContextInfos(message)) {
        if (Array.isArray(ctx.mentionedJid)) n = Math.max(n, ctx.mentionedJid.length);
    }
    return n;
}

/**
 * Flood do oi.json: PIX nativo com convite/mencao em massa, ou status so-admin com convite.
 * Nao e PIX legitimo nem status de loja.
 */
function classifyScamInviteFlood(message) {
    if (!message) return null;
    const text = extractFloodText(message);
    const hasInvite = SCAM_INVITE_RE.test(text);
    const mentions = countFloodMentions(message);
    const pay = isPaymentMessage(message);
    const adminStatus = isAdminVisibleOnlyStatus(message) || isGroupStatusLike(message);
    if (pay && (hasInvite || mentions >= 10)) {
        return { kind: 'payment', reason: 'scam_pay_invite' };
    }
    if (adminStatus && hasInvite) {
        return { kind: 'status', reason: 'scam_status_invite' };
    }
    return null;
}

/**
 * Assinaturas derivadas dos comandos legítimos do bot (exploits/div/status)
 * quando chegam de terceiros no grupo.
 * @returns {{ hit: boolean, reason: string, detail?: string, flag?: string }|null}
 */
function atkHit(reason, detail, flag = null) {
    return {
        hit: true,
        reason,
        detail,
        flag: flag || attackFlagForReason(reason)
    };
}

function detectAttackSignature(message) {
    if (!message?.message) return null;
    const raw = message.message;
    const inner = unwrapMessage(message) || raw;

    let hasViewOnce = !!(
        raw.viewOnceMessage ||
        raw.viewOnceMessageV2 ||
        raw.viewOnceMessageV2Extension ||
        raw.ephemeralMessage?.message?.viewOnceMessage ||
        raw.ephemeralMessage?.message?.viewOnceMessageV2
    );
    let hasCallPermission = false;
    let hasListResponse = false;
    let listDescLen = 0;
    let carouselCards = 0;
    let hasGroupInvite = false;
    let inviteNameLen = 0;
    let hasBotInvoke = !!raw.botInvokeMessage;
    let hasNewsletterInvite = false;
    let hasInteractive = false;
    let hasInteractiveResponse = false;
    let badLocation = false;
    let badVideoSeconds = false;
    let mentioned = 0;
    let nullByteParams = false;
    let hugeString = false;
    let hasGroupStatus = hasGroupStatusPayload(raw, inner);
    let hasPaymentNative = hasNativePaymentPayload(raw) || hasNativePaymentPayload(inner);

    const ctx =
        inner.extendedTextMessage?.contextInfo ||
        inner.imageMessage?.contextInfo ||
        inner.videoMessage?.contextInfo ||
        inner.locationMessage?.contextInfo ||
        {};
    mentioned = Math.max(mentioned, (ctx.mentionedJid || []).length);

    walkMessageNodes(raw, (node) => {
        if (node.__field) {
            const s = String(node.__value || '');
            if (s.includes('\0')) nullByteParams = true;
            if (s.length > 12000) hugeString = true;
            if (node.__field === 'description') listDescLen = Math.max(listDescLen, s.length);
            if (node.__field === 'groupName') inviteNameLen = Math.max(inviteNameLen, s.length);
            if (node.__field === 'paramsJson' && (/call_permission_request/i.test(s) || s.includes('\0'))) {
                hasCallPermission = true;
                if (s.includes('\0')) nullByteParams = true;
            }
            return;
        }
        if (node.viewOnceMessage || node.viewOnceMessageV2 || node.viewOnceMessageV2Extension) hasViewOnce = true;
        if (node.listResponseMessage) {
            hasListResponse = true;
            listDescLen = Math.max(listDescLen, String(node.listResponseMessage.description || '').length);
        }
        if (node.interactiveMessage) {
            hasInteractive = true;
            const cards = node.interactiveMessage.carouselMessage?.cards;
            if (Array.isArray(cards)) carouselCards = Math.max(carouselCards, cards.length);
            const buttons = node.interactiveMessage.nativeFlowMessage?.buttons;
            if (Array.isArray(buttons)) {
                for (const b of buttons) {
                    const name = String(b?.name || '');
                    const pj = String(b?.buttonParamsJson || '');
                    if (/call_permission_request/i.test(name) || /call_permission_request/i.test(pj)) {
                        hasCallPermission = true;
                    }
                    if (pj.includes('\0') || pj.length > 8000) nullByteParams = true;
                }
            }
        }
        if (node.interactiveResponseMessage) {
            hasInteractiveResponse = true;
            const nfr = node.interactiveResponseMessage.nativeFlowResponseMessage;
            if (nfr && /call_permission_request/i.test(String(nfr.name || ''))) hasCallPermission = true;
            if (String(nfr?.paramsJson || '').includes('\0')) nullByteParams = true;
        }
        if (node.groupInviteMessage) {
            hasGroupInvite = true;
            inviteNameLen = Math.max(inviteNameLen, String(node.groupInviteMessage.groupName || '').length);
        }
        if (node.newsletterAdminInviteMessage) hasNewsletterInvite = true;
        if (node.botInvokeMessage) hasBotInvoke = true;
        if (
            node.requestPaymentMessage ||
            node.sendPaymentMessage ||
            node.paymentInviteMessage ||
            node.invoiceMessage ||
            node.declinePaymentRequestMessage ||
            node.cancelPaymentRequestMessage
        ) {
            hasPaymentNative = true;
        }
        if (node.groupStatusMessage || node.groupStatusMessageV2) hasGroupStatus = true;
        if (node.locationMessage) {
            const lat = node.locationMessage.degreesLatitude;
            const lng = node.locationMessage.degreesLongitude;
            if (lat != null && (typeof lat === 'string' || Number.isNaN(Number(lat)))) badLocation = true;
            if (lng != null && (typeof lng === 'string' || Number.isNaN(Number(lng)))) badLocation = true;
        }
        if (node.videoMessage && node.videoMessage.seconds != null) {
            const sec = Number(node.videoMessage.seconds);
            if (!Number.isFinite(sec) || sec < 0 || sec > 7200) badVideoSeconds = true;
        }
        // mencoes: so as desta msg (ctx no topo). Nao soma quoted/note da divulgacao.
    });

    // --- regras: TIPO da msg (protobuf), nunca o copy da divulgacao ---
    if (hasPaymentNative) {
        return atkHit('antiataque_pagamento', 'payment nativo');
    }
    if (raw.reactionMessage || inner?.reactionMessage) {
        return atkHit('antiataque_reacao', 'reactionMessage');
    }
    if (hasViewOnce && hasCallPermission) {
        return atkHit('antiataque_atraso_invisible', 'viewOnce+call_permission_request');
    }
    if (hasViewOnce && hasListResponse && listDescLen > 4000) {
        return atkHit('antiataque_crash_ios', `listResponse desc=${listDescLen}`);
    }
    if ((hasViewOnce || hasInteractive) && carouselCards >= 30) {
        return atkHit('antiataque_atraso_carousel', `cards=${carouselCards}`);
    }
    if (hasGroupInvite && inviteNameLen > 180) {
        return atkHit('antiataque_convite', `groupNameLen=${inviteNameLen}`);
    }
    if (hasBotInvoke && hasNewsletterInvite) {
        return atkHit('antiataque_bugchat', 'botInvoke+newsletterAdminInvite');
    }
    if (hasNewsletterInvite && inviteNameLen > 200) {
        return atkHit('antiataque_newsletter_virtex', `nameLen=${inviteNameLen}`);
    }
    if (badLocation) {
        return atkHit('antiataque_loc_malformada', 'location non-numeric');
    }
    if (badVideoSeconds) {
        return atkHit('antiataque_video_malformado', 'video.seconds invalido');
    }
    if (nullByteParams || hugeString) {
        return atkHit('antiataque_payload_gigante', nullByteParams ? 'null-bytes' : 'string>12k');
    }
    if (mentioned >= 25) {
        return atkHit('antiataque_mencao_massa', `mentioned=${mentioned}`);
    }
    // Status GP ataque = so groupStatusMessageV2 (nao mencao/context/repost)
    if (hasGroupStatus) {
        return atkHit('antiataque_status_grupo', 'groupStatusMessageV2');
    }
    if (hasViewOnce && hasInteractiveResponse) {
        return atkHit('antiataque_viewonce_interactive', 'viewOnce+interactiveResponse');
    }
    // visunica / enquete / template sozinhos = tipo legitimo do WA — NAO kick
    const proto = raw.protocolMessage || inner?.protocolMessage;
    if (proto) {
        const t = Number(proto.type);
        if (t === 14 || String(proto.type || '').toUpperCase().includes('EDIT')) {
            return atkHit('antiataque_edicao', `protocolEdit type=${proto.type}`);
        }
    }

    return null;
}

/**
 * Status de grupo = groupStatusMessageV2 + protocolos de status.
 * NAO texto livre ("status", "online").
 */
function isStatusMessage(message) {
    if (!message || !message.message) return false;
    const raw = message.message;
    const msg = unwrapMessage(message) || raw;

    if (hasGroupStatusPayload(raw, msg)) return true;

    const ctx =
        msg.extendedTextMessage?.contextInfo ||
        msg.imageMessage?.contextInfo ||
        msg.videoMessage?.contextInfo ||
        raw.extendedTextMessage?.contextInfo ||
        {};
    if (hasGroupStatusContext(ctx)) return true;

    if (msg.protocolMessage || raw.protocolMessage) {
        const t = (msg.protocolMessage || raw.protocolMessage).type;
        if (t === 25 || t === 30 || t === 14) return true;
    }

    return false;
}

function nativePaymentKeys(msg) {
    if (!msg || typeof msg !== 'object') return [];
    const found = [];
    for (const k of NATIVE_PAYMENT_KEYS) {
        if (msg[k]) found.push(k);
    }
    const buttons = msg.interactiveMessage?.nativeFlowMessage?.buttons;
    if (Array.isArray(buttons)) {
        for (const b of buttons) {
            const n = String(b?.name || '').toLowerCase();
            if (PAYMENT_FLOW_NAMES.has(n)) found.push(`flow:${n}`);
        }
    }
    return found;
}

function hasNativePaymentPayload(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (nativePaymentKeys(msg).length > 0) return true;
    let hit = false;
    walkMessageNodes(msg, (node) => {
        if (hit || node?.__field) return;
        if (nativePaymentKeys(node).length > 0) hit = true;
    });
    return hit;
}

/** Envelope dirigido / status-no-grupo — so alguns membros veem. */
function isStealthPayOrStatusEnvelope(message) {
    const raw = message?.message;
    if (!raw || typeof raw !== 'object') return true;
    if (raw.groupStatusMessage || raw.groupStatusMessageV2 || raw.groupStatusMentionMessage) return true;
    if (isAdminVisibleOnlyStatus(message) || isGroupStatusLike(message)) return true;
    if (raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension) {
        return isPaymentMessage(message) || hasGroupStatusPayload(raw, unwrapMessage(message));
    }
    return false;
}

const stealthDecryptHits = new Map();

function noteDecryptFailBurst(groupId, senderId) {
    const key = `${ensureJidString(groupId)}_${ensureJidString(senderId)}`;
    const now = Date.now();
    let s = stealthDecryptHits.get(key);
    if (!s || now - s.t0 > 20_000) s = { n: 0, t0: now };
    s.n += 1;
    stealthDecryptHits.set(key, s);
    return s.n >= 3;
}

/**
 * Pagamento/status dirigido (participant) ou embrulhado em groupStatus.
 * Apaga + remove se os toggles de pay/status/surf estiverem ON.
 */
async function inspectInboundStealth(conn, message, telegramUserId, sessionId = null, extra = {}) {
    try {
        if (!message?.key || message.key.fromMe) return null;
        const groupId = ensureJidString(message.key.remoteJid, '');
        if (!groupId.endsWith('@g.us')) return null;

        const flags = getGroupSecurity(groupId, telegramUserId);
        const senderIds = collectMessageSenderIds(message, [extra.sender, extra.senderAlt]);
        const senderId = senderIds[0] || ensureJidString(extra.sender || message.key.participant || '', '');
        if (!senderId) return null;
        if (isWhitelisted(groupId, telegramUserId, senderId)) return null;
        if (await isGroupAdminOrBot(conn, groupId, senderId, senderIds.slice(1))) return null;

        const pay = isPaymentMessage(message) || extra.fromGuard === true;
        const statusProto = isGroupStatusLike(message) || isAdminVisibleOnlyStatus(message);
        const decryptBurst = extra.decryptFailed === true && noteDecryptFailBurst(groupId, senderId);

        if (!pay && !statusProto && !decryptBurst) return null;

        const wantPay = !!(flags.antipayment || flags.antiatkpagamento || flags.surfPayment);
        const wantStatus = !!(flags.antiatkstatus || flags.antistatus || flags.surfGroupStatus);

        if (pay && !wantPay && !(statusProto && wantStatus)) return null;
        if (statusProto && !pay && !wantStatus) return null;
        if (decryptBurst && !pay && !statusProto) {
            if (!(flags.antipayment || flags.antiatkpagamento || flags.antiatkinvisivel || flags.antiatkstatus)) {
                return null;
            }
        }

        let reason = 'stealth_payment';
        if (statusProto && !pay) reason = 'stealth_status';
        if (pay && flags.antiatkpagamento) reason = 'antiataque_pagamento';
        if (statusProto && !pay && flags.antiatkstatus) reason = 'antiataque_status_grupo';

        logger.logAviso(
            `[STEALTH] reason=${reason} pay=${pay} status=${statusProto} decrypt=${decryptBurst} ` +
            `grupo=${groupId.slice(0, 22)} user=${String(senderId).slice(0, 28)}`
        );

        const kick = !(statusProto && !pay) || !!flags.antiatkstatus;
        return await executeModerationAction(
            conn,
            groupId,
            senderId,
            reason,
            message.message ? [message] : [],
            { telegramUserId, flags, kick, extraIds: senderIds }
        );
    } catch (e) {
        logger.logAviso(`[STEALTH] abort: ${e.message}`);
        return null;
    }
}

/** True se for pagamento nativo estilo divulgacao (requestPaymentMessage) — nunca texto. */
function isDivulgacaoPaymentPayload(messageOrHint) {
    try {
        if (!messageOrHint) return false;
        if (messageOrHint._hanorkPayment) return true;
        const raw = messageOrHint.message || messageOrHint;
        if (!raw || typeof raw !== 'object') return false;
        if (raw.requestPaymentMessage && raw.requestPaymentMessage._hanork) return true;
        if (hasNativePaymentPayload(raw)) return true;
        const inner = unwrapMessage(messageOrHint) || raw;
        return hasNativePaymentPayload(inner);
    } catch (_) {
        return false;
    }
}

/** antipayment: SO bolha nativa de PIX/cobranca. Texto "pix"/"pagamento" NAO conta. */
function isPaymentMessage(message) {
    if (!message) return false;
    const raw = message.message || message;
    if (!raw || typeof raw !== 'object') return false;
    if (hasNativePaymentPayload(raw)) return true;
    const inner = unwrapMessage(message) || raw;
    return hasNativePaymentPayload(inner);
}

function isInvisibleMessage(message) {
    if (!message || !message.message) return false;
    const msg = message.message;

    if (msg.viewOnceMessage) return true;
    if (msg.viewOnceMessageV2) return true;
    if (msg.viewOnceMessageV2Extension) return true;

    // view-once aninhado
    const inner = unwrapMessage(message);
    if (inner && inner !== msg) {
        if (msg.ephemeralMessage?.message?.viewOnceMessage) return true;
        if (msg.ephemeralMessage?.message?.viewOnceMessageV2) return true;
    }

    // Status GP so-admin (oi.json statusSourceType 4) — membros nao veem a bolha
    if (isAdminVisibleOnlyStatus(message)) return true;

    return false;
}

function detectPaymentFlood(groupId, senderId) {
    const key = `${ensureJidString(groupId)}_${ensureJidString(senderId)}`;
    const now = Date.now();

    if (!groupSuspicionCache.has(key)) {
        groupSuspicionCache.set(key, []);
    }

    const messages = groupSuspicionCache.get(key);
    const recentMessages = messages.filter((m) => now - m.timestamp < FLOOD_TIME_WINDOW);
    groupSuspicionCache.set(key, recentMessages);

    if (recentMessages.length >= FLOOD_THRESHOLD) {
        logger.logAviso(
            `[MODERATION] Flood detectado - Grupo: ${groupId}, Usuário: ${senderId}, Mensagens: ${recentMessages.length}`
        );
        return true;
    }
    return false;
}

/** Flood tipado (reacao/edicao) — limiar proprio pra nao banir 1 emoji */
function detectTypedFlood(groupId, senderId, type, threshold = 6) {
    const key = `${ensureJidString(groupId)}_${ensureJidString(senderId)}`;
    const now = Date.now();
    const all = (groupSuspicionCache.get(key) || []).filter((m) => now - m.timestamp < FLOOD_TIME_WINDOW);
    groupSuspicionCache.set(key, all);
    const typed = all.filter((m) => m.type === type);
    return typed.length >= threshold;
}

function registerSuspiciousMessage(groupId, senderId, type) {
    const key = `${ensureJidString(groupId)}_${ensureJidString(senderId)}`;
    if (!groupSuspicionCache.has(key)) {
        groupSuspicionCache.set(key, []);
    }
    groupSuspicionCache.get(key).push({ timestamp: Date.now(), type });
}

function clearSuspicion(groupId, senderId) {
    const key = `${ensureJidString(groupId)}_${ensureJidString(senderId)}`;
    groupSuspicionCache.delete(key);
}

function isModerationActive(groupId, telegramUserId) {
    const gid = ensureJidString(groupId, '');
    try {
        return !!require('./protectionStore').getProtection(gid, 'antiflood', telegramUserId);
    } catch (_) {
        return false;
    }
}

function enableModeration(groupId, telegramUserId) {
    const gid = ensureJidString(groupId, '');
    if (!gid) return;
    const config = getModerationConfig(telegramUserId) || { enabledGroups: [] };
    if (!config.enabledGroups) config.enabledGroups = [];
    if (!config.enabledGroups.some((g) => ensureJidString(g) === gid)) {
        config.enabledGroups.push(gid);
        setModerationConfig(telegramUserId, config);
        logger.logInfo(`[MODERATION] Moderação ativada para grupo ${gid} por usuário ${telegramUserId}`);
    }
}

function disableModeration(groupId, telegramUserId) {
    const gid = ensureJidString(groupId, '');
    const config = getModerationConfig(telegramUserId);
    if (config && config.enabledGroups) {
        config.enabledGroups = config.enabledGroups.filter((id) => ensureJidString(id) !== gid);
        setModerationConfig(telegramUserId, config);
        logger.logInfo(`[MODERATION] Moderação desativada para grupo ${gid} por usuário ${telegramUserId}`);
    }
}

const DEFAULT_GROUP_FLAGS = {
    antilink: false,
    antilinkHard: false,
    antilinkGp: false,
    antilinkEasy: false,
    antifake: false,
    soadm: false,
    antiimg: false,
    antivideo: false,
    antiaudio: false,
    antisticker: false,
    antidoc: false,
    antiloc: false,
    antictt: false,
    antichannel: false,
    antipayment: false,
    anticatalogo: false,
    antistatus: false,
    antipalavrao: false,
    bemvindo: false,
    saiu: false,
    autodown: false,
    antinotas: false,
    bangp: false,
    autosticker: false,
    antiporno: false,
    limiteflood: false,
    antiflood: false,
    antifloodsticker: 0, // 0=off, N=max stickers na janela
    /** Anti-ataque adaptativo — cada vetor liga/desliga sozinho (ban+apaga) */
    antiatkstatus: false,
    antiatkinvisivel: false,
    antiatkpagamento: false,
    antiatkcrash: false,
    antiatkpoll: false,
    antiatkmencao: false,
    antiatkreacao: false,
    antiatkedicao: false,
    /** Grupo marcado como divulgacao — so nele rodam cmds div* */
    grupoDivulgacao: false,
    /** Legado: se ON, equivale a todos antiatk* ON (nao usar como unico botao) */
    antiataque: false,
    /** Superficies Baileys (inbound) — default OFF, toggle individual */
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
    surfSettingsFlood: false,
    /** Alerta automatico de solicitacao de entrada (default OFF) */
    autoconvite: false,
    /** Aceita pedido de entrada sozinho (default OFF) */
    autoaceitar: false,
    /** Avisa mudanca de nome/desc/foto/anuncio (default OFF) */
    x9config: false,
    /** Membro novo precisa se apresentar ou e removido (default OFF) */
    autoapresentar: false,
    /** Anti-roubo / X9 admin — protecao default OFF (falso positivo) */
    antiadmin: false,
    antiadminAudit: false,
    antiadminRevert: false,
    antiadminAlert: false,
    antiadminSilent: false,
    antiadminDetect: false,
    /** Recupera msg apagada por membro neste grupo (default OFF) */
    antidelete: false
};

/** Flags globais da sessao (nao por grupo) — estilo ZT obrigadoEXT */
const DEFAULT_OWNER_SECURITY = {
    anticall: false,
    antipv: true,    // bloqueia quem manda PV (padrao ON)
    antipv2: true,   // avisa 1x e ignora/bloqueia (padrao ON)
    antipv3: true,   // ignora PV de user; dono/VIP passam (padrao ON)
    odelete: false   // pre-apagar ofensor (sessao; default OFF)
};

const DEFAULT_BAD_WORDS = [
    'porra', 'caralho', 'puta', 'puto', 'merda', 'fdp', 'viado', 'buceta', 'cuzão', 'cuzao', 'arrombado'
];

const FLAG_ALIASES = {
    antilinkhard: 'antilinkHard',
    antilinkgp: 'antilinkGp',
    antilingp: 'antilinkGp',
    antilinkeasy: 'antilinkEasy',
    antiimagem: 'antiimg',
    antidocumento: 'antidoc',
    anticontato: 'antictt',
    antichannell: 'antichannel',
    antimencao: 'antistatus',
    antistatusatk: 'antiatkstatus',
    antiinvisivel: 'antiatkinvisivel',
    antipagamentoatk: 'antiatkpagamento',
    anticrash: 'antiatkcrash',
    anticrashgp: 'antiatkcrash',
    antipollatk: 'antiatkpoll',
    antimencaomassa: 'antiatkmencao',
    antireacao: 'antiatkreacao',
    antiedicao: 'antiatkedicao',
    addgrupo: 'grupoDivulgacao',
    grupodivulgacao: 'grupoDivulgacao',
    divgrupo: 'grupoDivulgacao',
    antiattack: 'antiataque',
    // superficies Baileys
    surfpayment: 'surfPayment',
    surfgroupstatus: 'surfGroupStatus',
    surfforwardspoof: 'surfForwardSpoof',
    surfmetai: 'surfMetaAi',
    surfbizfake: 'surfBizFake',
    surfphishad: 'surfPhishAd',
    surfnativeflow: 'surfNativeFlow',
    surfviewonce: 'surfViewOnce',
    surfcapmentions: 'surfCapMentions',
    surfcapmedia: 'surfCapMedia',
    surffakepoll: 'surfFakePoll',
    surfsettingsflood: 'surfSettingsFlood',
    autoapresentar: 'autoapresentar',
    autoapres: 'autoapresentar',
    autoaceitar: 'autoaceitar',
    attacc: 'autoaceitar',
    x9config: 'x9config',
    soadmin: 'soadm',
    onlyadm: 'soadm',
    antidel: 'antidelete',
    'anti-delete': 'antidelete',
    antidelete: 'antidelete',
    antiadminaudit: 'antiadminAudit',
    antiadminrevert: 'antiadminRevert',
    antiadminalert: 'antiadminAlert',
    antiadminsilent: 'antiadminSilent',
    antiadmindetect: 'antiadminDetect'
};

const TOGGLE_FLAGS = new Set(Object.keys(DEFAULT_GROUP_FLAGS).filter((k) => k !== 'antifloodsticker'));

/** Toggles anti-ataque (ban+apaga) — independentes entre si */
const ATTACK_TOGGLE_KEYS = [
    'antiatkstatus',
    'antiatkinvisivel',
    'antiatkpagamento',
    'antiatkcrash',
    'antiatkpoll',
    'antiatkmencao',
    'antiatkreacao',
    'antiatkedicao'
];

const ATTACK_TOGGLE_LABELS = {
    antiatkstatus: 'Anti-ataque proto status GP (nao mencao)',
    antiatkinvisivel: 'Anti-ataque viewOnce+crash (nao visu normal)',
    antiatkpagamento: 'Anti-ataque pagamento nativo (ban+apaga)',
    antiatkcrash: 'Anti-ataque crash/trava (template/carousel/etc)',
    antiatkpoll: 'Anti-ataque poll/enquete',
    antiatkmencao: 'Anti-ataque menção em massa',
    antiatkreacao: 'Anti-ataque flood de reações',
    antiatkedicao: 'Anti-ataque edição maliciosa'
};

const REASON_TO_ATTACK_FLAG = {
    antiataque_status_grupo: 'antiatkstatus',
    antiataque_pagamento: 'antiatkpagamento',
    antiataque_invisivel: 'antiatkinvisivel',
    antiataque_ephemeral: 'antiatkinvisivel',
    antiataque_viewonce_interactive: 'antiatkinvisivel',
    antiataque_poll: 'antiatkpoll',
    antiataque_mencao_massa: 'antiatkmencao',
    antiataque_reacao: 'antiatkreacao',
    antiataque_edicao: 'antiatkedicao',
    antiataque_atraso_invisible: 'antiatkcrash',
    antiataque_crash_ios: 'antiatkcrash',
    antiataque_atraso_carousel: 'antiatkcrash',
    antiataque_template: 'antiatkcrash',
    antiataque_convite: 'antiatkcrash',
    antiataque_bugchat: 'antiatkcrash',
    antiataque_newsletter_virtex: 'antiatkcrash',
    antiataque_loc_malformada: 'antiatkcrash',
    antiataque_video_malformado: 'antiatkcrash',
    antiataque_payload_gigante: 'antiatkcrash'
};

function attackFlagForReason(reason) {
    return REASON_TO_ATTACK_FLAG[String(reason || '')] || null;
}

function isAntiAtkFlagEnabled(flags, attackFlag) {
    if (!attackFlag) return false;
    if (flags[attackFlag]) return true;
    // Legado master: so crash/trava. Nao cobre status/visu/poll/reacao/mencao/pagamento
    // (esses exigem o toggle do vetor — evita ban aleatorio com antilink off).
    return !!flags.antiataque && attackFlag === 'antiatkcrash';
}

function anyAntiAtkEnabled(flags) {
    if (flags.antiataque) return true;
    return ATTACK_TOGGLE_KEYS.some((k) => !!flags[k]);
}

function formatAntiAtkStatus(flags) {
    const on = (v) => (v ? 'ON' : 'OFF');
    const lines = ATTACK_TOGGLE_KEYS.map((k) => `${ATTACK_TOGGLE_LABELS[k]}: ${on(flags[k])}`);
    if (flags.antiataque) {
        lines.push('(Legado antiataque master: ON — so crash/trava; kick exige toggle do vetor)');
    }
    return lines.join('\n');
}

const stickerFloodCache = new Map();
const paymentFloodCache = new Map();
const DEFAULT_WARN_LIMIT = 3;
const DEFAULT_CHAR_LIMIT = 800;

function getGroupLists(groupId, telegramUserId) {
    const gid = ensureJidString(groupId, '');
    const config = getModerationConfig(telegramUserId) || {};
    const raw = (config.groupLists || {})[gid] || {};
    return {
        whitelist: Array.isArray(raw.whitelist) ? raw.whitelist.map((j) => ensureJidString(j, '')).filter(Boolean) : [],
        mutes: Array.isArray(raw.mutes) ? raw.mutes.map((j) => ensureJidString(j, '')).filter(Boolean) : [],
        blacklist: Array.isArray(raw.blacklist) ? raw.blacklist.map((j) => ensureJidString(j, '')).filter(Boolean) : [],
        warns: raw.warns && typeof raw.warns === 'object' ? { ...raw.warns } : {},
        warnLimit: Number(raw.warnLimit) > 0 ? Number(raw.warnLimit) : DEFAULT_WARN_LIMIT,
        limitec: Number(raw.limitec) > 0 ? Number(raw.limitec) : DEFAULT_CHAR_LIMIT,
        badWords: Array.isArray(raw.badWords) && raw.badWords.length ? raw.badWords.map(String) : [...DEFAULT_BAD_WORDS],
        welcomeText: String(raw.welcomeText || ''),
        leaveText: String(raw.leaveText || '')
    };
}

function saveGroupLists(groupId, telegramUserId, lists) {
    const gid = ensureJidString(groupId, '');
    if (!gid) return;
    const config = getModerationConfig(telegramUserId) || { enabledGroups: [], groupFlags: {}, groupLists: {} };
    if (!config.groupLists) config.groupLists = {};
    config.groupLists[gid] = {
        whitelist: lists.whitelist || [],
        mutes: lists.mutes || [],
        blacklist: lists.blacklist || [],
        warns: lists.warns || {},
        warnLimit: lists.warnLimit || DEFAULT_WARN_LIMIT,
        limitec: lists.limitec || DEFAULT_CHAR_LIMIT,
        badWords: lists.badWords || [...DEFAULT_BAD_WORDS],
        welcomeText: lists.welcomeText || '',
        leaveText: lists.leaveText || ''
    };
    setModerationConfig(telegramUserId, config);
}

function normalizeParticipantKey(jid) {
    return ensureJidString(jid, '');
}

function listHasParticipant(list, jid) {
    const target = normalizeParticipantKey(jid);
    if (!target) return false;
    return (list || []).some((x) => sameParticipant(x, target));
}

function getGlobalBlacklist(telegramUserId) {
    const config = getModerationConfig(telegramUserId) || {};
    const raw = Array.isArray(config.globalBlacklist) ? config.globalBlacklist : [];
    return raw.map((j) => ensureJidString(j, '')).filter(Boolean);
}

function saveGlobalBlacklist(telegramUserId, list) {
    const config = getModerationConfig(telegramUserId) || { enabledGroups: [], groupFlags: {}, groupLists: {} };
    config.globalBlacklist = (list || []).map((j) => ensureJidString(j, '')).filter(Boolean);
    setModerationConfig(telegramUserId, config);
    return config.globalBlacklist;
}

/**
 * Todos os JIDs do alvo pra casar cache (LID + PN + participante do grupo).
 * Peek de meta — sem IQ extra.
 */
function expandBanTargetIds(conn, groupId, targetJid) {
    const out = [];
    const seen = new Set();
    const push = (v) => {
        const s = ensureJidString(v, '');
        if (!s || seen.has(s) || !isKickableJid(s)) return;
        seen.add(s);
        out.push(s);
    };
    push(targetJid);
    for (const id of identitiesForBlacklist(targetJid)) push(id);
    try {
        const { getPhoneForLid, getLidForPhone, rememberLidPhonePair } = require('../utils');
        const t = ensureJidString(targetJid, '');
        if (isLidJid(t)) {
            const pn = getPhoneForLid(t);
            if (pn) {
                const d = String(pn).replace(/\D/g, '');
                if (d.length >= 10) push(`${d}@s.whatsapp.net`);
            }
        } else {
            const digits = identityPhoneDigits(t) || t.split('@')[0].replace(/\D/g, '');
            const lid = digits ? getLidForPhone(digits) : '';
            if (lid) push(lid);
        }
        const gid = ensureJidString(groupId, '');
        if (gid.endsWith('@g.us')) {
            const { peekGroupMetadata } = require('./groupMetaCache');
            const meta = peekGroupMetadata(gid) || {};
            const hit = (meta.participants || []).find((p) =>
                participantMatchesTarget(p, t, out)
            );
            if (hit) {
                const ids = participantIdentityIds(hit);
                const lid = ids.find((id) => isLidJid(id));
                const pn = ids.find((id) => isPhoneJid(id));
                if (lid && pn) {
                    try { rememberLidPhonePair(lid, pn); } catch (_) { /* cache opcional */ }
                }
                for (const id of ids) push(id);
            }
        }
    } catch (_) { /* mapping opcional */ }
    return out;
}

/** Msg do cache pertence ao alvo (LID e telefone do mesmo membro). */
function cacheMessageMatchesTarget(msg, targetIds) {
    if (!msg?.key || msg.key.fromMe) return false;
    const senders = collectMessageSenderIds(msg);
    if (!senders.length) {
        const p = ensureJidString(msg.key.participant, '');
        if (p) senders.push(p);
    }
    const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
    return senders.some((s) => ids.some((t) => identitiesEqualStrict(s, t) || sameParticipant(s, t)));
}

function identitiesForBlacklist(jid) {
    const out = [];
    const seen = new Set();
    const push = (v) => {
        const s = ensureJidString(v, '');
        if (!s || seen.has(s)) return;
        if (isKickableJid(s) || /^\d{10,15}$/.test(s)) {
            seen.add(s);
            out.push(s);
        }
    };
    push(jid);
    try {
        for (const k of participantKeys(jid)) {
            if (String(k).includes('@')) push(k);
            else if (/^\d{10,15}$/.test(String(k))) push(`${k}@s.whatsapp.net`);
        }
    } catch (_) { /* ignore */ }
    return out;
}

function isGloballyBlacklisted(telegramUserId, jidOrIds) {
    const list = getGlobalBlacklist(telegramUserId);
    if (!list.length) return false;
    const ids = Array.isArray(jidOrIds) ? jidOrIds : [jidOrIds];
    return ids.some((id) => listHasParticipant(list, id));
}

function addGlobalBlacklisted(telegramUserId, jid) {
    const list = getGlobalBlacklist(telegramUserId);
    let added = 0;
    for (const id of identitiesForBlacklist(jid)) {
        if (!listHasParticipant(list, id)) {
            list.push(id);
            added++;
        }
    }
    saveGlobalBlacklist(telegramUserId, list);
    return { ok: true, added, list };
}

function removeGlobalBlacklisted(telegramUserId, jid) {
    const list = getGlobalBlacklist(telegramUserId);
    const next = list.filter((x) => !sameParticipant(x, jid));
    const removed = list.length - next.length;
    saveGlobalBlacklist(telegramUserId, next);
    return { ok: true, removed, list: next };
}

function isPhoneJid(jid) {
    const s = ensureJidString(jid, '');
    return s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us');
}

function isLidJid(jid) {
    return ensureJidString(jid, '').includes('@lid');
}

/** Digitos E.164 so de JID de telefone — nunca do user-part de @lid. */
function identityPhoneDigits(jid) {
    const s = ensureJidString(jid, '').replace(/:\d+(?=@)/, '');
    if (!s || isLidJid(s)) return '';
    if (!isPhoneJid(s) && !/^\d{8,15}$/.test(s)) return '';
    const d = s.split('@')[0].replace(/\D/g, '');
    if (d.length < 8 || d.length > 15) return '';
    return d;
}

/** Mesmo numero nacional (BR com/sem 55). Nao compara sufixo de LID. */
function sameNationalPhone(a, b) {
    const x = String(a || '').replace(/\D/g, '');
    const y = String(b || '').replace(/\D/g, '');
    if (!x || !y || x.length < 8 || y.length < 8) return false;
    if (x === y) return true;
    const stripBr = (d) => (d.startsWith('55') && (d.length === 12 || d.length === 13) ? d.slice(2) : d);
    const nx = stripBr(x);
    const ny = stripBr(y);
    return nx.length >= 10 && ny.length >= 10 && nx === ny;
}

function stripDeviceJid(jid) {
    return ensureJidString(jid, '').replace(/:\d+(?=@)/, '');
}

/**
 * Protecao dono/bot: JID/LID exato, ou telefone so contra telefone.
 * Nunca LID user-part vs E.164 (era o falso "nao pode banir dono").
 */
function identitiesEqualStrict(a, b) {
    const A = stripDeviceJid(a);
    const B = stripDeviceJid(b);
    if (!A || !B) return false;
    if (A === B) return true;
    if (isLidJid(A) && isLidJid(B)) {
        return A.split('@')[0] === B.split('@')[0];
    }
    if (isLidJid(A) || isLidJid(B)) return false;
    const aPhone = identityPhoneDigits(A);
    const bPhone = identityPhoneDigits(B);
    return !!(aPhone && bPhone && sameNationalPhone(aPhone, bPhone));
}

/** So a sessao atual (conn.user.id / .lid). Lista owners (aliases LID/PN) nao entra — barrava terceiro. */
function isSessionSelfIdentity(conn, jid) {
    const target = stripDeviceJid(jid);
    if (!target) return true;
    const botId = stripDeviceJid(conn?.user?.id);
    const botLid = stripDeviceJid(conn?.user?.lid);
    if (botId && identitiesEqualStrict(target, botId)) return true;
    if (botLid && identitiesEqualStrict(target, botLid)) return true;
    return false;
}

function isOwnerOrBotTarget(conn, telegramUserId, jid) {
    if (isSessionSelfIdentity(conn, jid)) return true;
    const target = stripDeviceJid(jid);
    if (!target) return true;
    const tid = String(telegramUserId || conn?._telegramUserId || '');
    if (!tid) return false;
    try {
        const { checkAuthorization, isConnSelfIdentity } = require('./authorization');
        if (isConnSelfIdentity(target, [target], conn)) return true;
        const auth = checkAuthorization(target, tid, false, [target], conn);
        return auth.role === 'owner' || auth.role === 'platform_admin';
    } catch (_) {
        return false;
    }
}

const BANALL_KICK_CONCURRENCY = 8;
const BANALL_FETCH_MS = 2800;

function sleepMs(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

async function runPool(items, concurrency, worker) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return;
    const n = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
    let cursor = 0;
    await Promise.all(Array.from({ length: n }, async () => {
        while (true) {
            const i = cursor++;
            if (i >= list.length) return;
            await worker(list[i], i);
        }
    }));
}

function groupsFromMetaCache(prefer) {
    const groups = {};
    try {
        const { peekAllGroupMetas, peekGroupMetadata } = require('./groupMetaCache');
        for (const meta of peekAllGroupMetas() || []) {
            const id = ensureJidString(meta.id || meta.jid, '');
            if (id.endsWith('@g.us')) groups[id] = meta;
        }
        if (prefer.endsWith('@g.us')) {
            const hit = peekGroupMetadata(prefer);
            if (hit) groups[prefer] = hit;
            else if (!groups[prefer]) groups[prefer] = { id: prefer, participants: [] };
        }
    } catch (_) { /* cache opcional */ }
    return groups;
}

async function prefetchParticipatingGroups(conn) {
    if (!conn || typeof conn.groupFetchAllParticipating !== 'function') return null;
    try {
        const all = await Promise.race([
            conn.groupFetchAllParticipating(),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${BANALL_FETCH_MS}ms`)), BANALL_FETCH_MS))
        ]);
        if (!all || typeof all !== 'object') return null;
        try {
            require('./groupMetaCache').seedFromParticipating(all);
        } catch (_) { /* seed opcional */ }
        return all;
    } catch (e) {
        logger.logAviso(`[BANALL] listar grupos: ${e.message}`);
        return null;
    }
}

function mergeGroupMaps(...maps) {
    const out = {};
    for (const m of maps) {
        if (!m || typeof m !== 'object') continue;
        for (const [gid, meta] of Object.entries(m)) {
            const id = ensureJidString(gid || meta?.id || meta?.jid, '');
            if (!id.endsWith('@g.us') || !meta) continue;
            const prev = out[id];
            const prevN = (prev?.participants || []).length;
            const nextN = (meta.participants || []).length;
            if (!prev || nextN >= prevN) out[id] = { ...meta, id: meta.id || id };
        }
    }
    return out;
}

function botAdminInParts(parts, botId, botLid) {
    for (const p of parts || []) {
        if (!participantIsAdmin(p)) continue;
        if (botId && findParticipantByTarget([p], botId)) return true;
        if (botLid && findParticipantByTarget([p], botLid)) return true;
    }
    return false;
}

function collectBanKickIds(member, target, targetIds, preferredKid, conn) {
    const kickIds = [];
    const seenKick = new Set();
    const push = (raw) => {
        const kid = stripDeviceJid(raw);
        if (!isKickableJid(kid) || seenKick.has(kid)) return;
        if (conn && isSessionSelfIdentity(conn, kid)) return;
        seenKick.add(kid);
        kickIds.push(kid);
    };
    push(preferredKid);
    if (member) {
        push(member.id);
        push(member.lid);
        push(member.phoneNumber);
        push(member.jid);
        push(member.participant);
    }
    push(target);
    for (const id of targetIds || []) push(id);
    return kickIds;
}

async function kickIdsFromGroup(conn, gidS, kickIds) {
    let lastErr = '';
    for (const kid of kickIds) {
        try {
            await conn.groupParticipantsUpdate(gidS, [kid], 'remove');
            return { ok: true, kid, err: '' };
        } catch (e) {
            lastErr = e && e.message ? e.message : String(e);
            if (/rate-overlimit/i.test(lastErr)) {
                await sleepMs(180);
                try {
                    await conn.groupParticipantsUpdate(gidS, [kid], 'remove');
                    return { ok: true, kid, err: '' };
                } catch (e2) {
                    lastErr = e2 && e2.message ? e2.message : String(e2);
                }
            }
        }
    }
    return { ok: false, kid: '', err: lastErr };
}

async function banFromAllParticipatingGroups(conn, targetJid, telegramUserId, currentGroupId, opts = {}) {
    const started = Date.now();
    const target = ensureJidString(targetJid, '');
    const result = { kicked: 0, skipped: 0, failed: 0, scanned: 0, blocked: null };
    if (!target) return result;
    if (isOwnerOrBotTarget(conn, telegramUserId, target)) {
        result.blocked = 'protected';
        return result;
    }

    const prefer = ensureJidString(currentGroupId, '');
    const prefetch = opts && opts.prefetch && typeof opts.prefetch.then === 'function'
        ? opts.prefetch
        : prefetchParticipatingGroups(conn);

    const botId = ensureJidString(conn?.user?.id, '');
    const botLid = ensureJidString(conn?.user?.lid, '');
    const targetIds = identitiesForBlacklist(target);
    let preferredKid = '';
    let skippedAdmin = 0;
    let skippedMember = 0;

    const applyKickResult = (gidS, isCurrent, kick) => {
        if (kick.ok) {
            result.kicked++;
            if (kick.kid) preferredKid = kick.kid;
            logger.logInfo(`[BANALL] removido de ${gidS}`);
            return;
        }
        result.failed++;
        logger.logAviso(`[BANALL] kick falhou ${isCurrent ? 'grupo-cmd' : 'gp'}: ${String(kick.err || '').slice(0, 80)}`);
    };

    const planGroup = (gidS, meta, isCurrent) => {
        result.scanned++;
        const parts = meta?.participants || [];
        if (!isCurrent && parts.length && !botAdminInParts(parts, botId, botLid)) {
            skippedAdmin++;
            result.skipped++;
            return null;
        }
        const member = parts.find((p) => participantMatchesTarget(p, target, targetIds)) || null;
        if (!member && !isCurrent) {
            skippedMember++;
            result.skipped++;
            return null;
        }
        const kickIds = collectBanKickIds(member, target, targetIds, preferredKid, conn);
        if (!kickIds.length) {
            result.skipped++;
            return null;
        }
        return { gidS, isCurrent, kickIds };
    };

    // Grupo do comando sai na hora — nao espera o fetch de todos.
    if (prefer.endsWith('@g.us')) {
        const cached = groupsFromMetaCache(prefer);
        const job = planGroup(prefer, cached[prefer] || { id: prefer, participants: [] }, true);
        if (job) {
            const kick = await kickIdsFromGroup(conn, job.gidS, job.kickIds);
            applyKickResult(job.gidS, true, kick);
        }
    }

    const fetched = await prefetch.catch(() => null);
    const groups = mergeGroupMaps(groupsFromMetaCache(prefer), fetched);

    const rest = [];
    for (const [gid, meta] of Object.entries(groups || {})) {
        const gidS = ensureJidString(gid, '');
        if (!gidS.endsWith('@g.us') || gidS === prefer) continue;
        const job = planGroup(gidS, meta, false);
        if (job) rest.push(job);
    }

    await runPool(rest, BANALL_KICK_CONCURRENCY, async (job) => {
        const ids = preferredKid
            ? collectBanKickIds(null, target, job.kickIds, preferredKid, conn)
            : job.kickIds;
        const kick = await kickIdsFromGroup(conn, job.gidS, ids);
        applyKickResult(job.gidS, false, kick);
    });

    logger.logInfo(
        `[BANALL] scanned=${result.scanned} kicked=${result.kicked} skipAdmin=${skippedAdmin} skipMember=${skippedMember} failed=${result.failed} alvo=${isLidJid(target) ? 'lid' : 'pn'} ms=${Date.now() - started}`
    );
    return result;
}

function isWhitelisted(groupId, telegramUserId, jid) {
    const lists = getGroupLists(groupId, telegramUserId);
    return listHasParticipant(lists.whitelist, jid);
}

function getGroupSecurity(groupId, telegramUserId) {
    const gid = ensureJidString(groupId, '');
    let flags = {};
    try {
        flags = require('./protectionStore').getAllProtections(gid, telegramUserId) || {};
    } catch (_) {
        flags = { ...DEFAULT_GROUP_FLAGS };
    }
    flags.antiflood = !!flags.antiflood;
    flags.antifloodsticker = Number(flags.antifloodsticker) || 0;
    return flags;
}

async function setGroupSecurityFlag(groupId, telegramUserId, flag, enabled, actorId) {
    const gid = ensureJidString(groupId, '');
    if (!gid) return getGroupSecurity(gid, telegramUserId);
    if (!String(gid).endsWith('@g.us')) {
        logger.logAviso(`[MODERATION] recusa flag em jid nao-grupo`);
        return getGroupSecurity(gid, telegramUserId);
    }
    let key = String(flag || '');
    if (FLAG_ALIASES[key.toLowerCase()]) key = FLAG_ALIASES[key.toLowerCase()];
    if (key === 'antifloodsticker') {
        const n = typeof enabled === 'number' ? enabled : (enabled ? 5 : 0);
        try {
            await require('./protectionStore').setProtection(gid, key, n, actorId, telegramUserId);
        } catch (e) {
            logger.logAviso(`[MODERATION] protectionStore sticker: ${e.message || e}`);
        }
        return getGroupSecurity(gid, telegramUserId);
    }
    if (key === 'antiflood') {
        const want = !!enabled;
        if (want) enableModeration(gid, telegramUserId);
        else disableModeration(gid, telegramUserId);
        try {
            await require('./protectionStore').setProtection(gid, key, want, actorId, telegramUserId);
        } catch (e) {
            logger.logAviso(`[MODERATION] protectionStore antiflood: ${e.message || e}`);
        }
        return getGroupSecurity(gid, telegramUserId);
    }
    if (!TOGGLE_FLAGS.has(key)) {
        logger.logAviso(`[MODERATION] flag desconhecida recusada: ${key}`);
        return getGroupSecurity(gid, telegramUserId);
    }

    const want = !!enabled;
    try {
        await require('./protectionStore').setProtection(gid, key, want, actorId, telegramUserId);
    } catch (e) {
        logger.logAviso(`[MODERATION] protectionStore ${key}: ${e.message || e}`);
        const config = getModerationConfig(telegramUserId) || { enabledGroups: [], groupFlags: {} };
        if (!config.groupFlags) config.groupFlags = {};
        if (!config.groupFlags[gid]) config.groupFlags[gid] = { ...DEFAULT_GROUP_FLAGS };
        config.groupFlags[gid][key] = want;
        setModerationConfig(telegramUserId, config);
        try {
            await require('./sqlStore').upsertGroupFlagAsync(telegramUserId, gid, key, want);
        } catch (_) { /* ignore */ }
    }
    if (key === 'autoapresentar' && !want) {
        try { require('./autoApresentar').cancelGroup(gid); } catch (_) { /* */ }
    }
    const verified = getGroupSecurity(gid, telegramUserId);
    logger.logInfo(`[MODERATION] ${key}=${want} confirmado=${!!verified[key]} grupo=${gid.slice(0, 18)}…`);
    if (key === 'grupoDivulgacao') {
        try {
            const div = require('./divulgacao');
            if (want) div.adicionarGrupo(telegramUserId, gid);
            else div.removerGrupo(telegramUserId, gid);
        } catch (e) {
            logger.logAviso(`[MODERATION] lista DIV: ${String(e.message || e).slice(0, 80)}`);
        }
    }
    return verified;
}

function formatGroupSecurityStatus(groupId, telegramUserId) {
    const { previewText } = require('./typography');
    const f = getGroupSecurity(groupId, telegramUserId);
    const lists = getGroupLists(groupId, telegramUserId);
    const on = (v) => (v ? 'ON' : 'OFF');
    return [
        previewText('SEGURANCA DO GRUPO'),
        previewText(`Anti-flood: ${on(f.antiflood)}`),
        previewText(`Anti-link: ${on(f.antilink)} | Easy: ${on(f.antilinkEasy)} | HARD: ${on(f.antilinkHard)} | GP: ${on(f.antilinkGp)}`),
        previewText(`Anti-canal: ${on(f.antichannel)} | Anti-pagamento: ${on(f.antipayment)}`),
        previewText(`Anti-catalogo: ${on(f.anticatalogo)} | Anti-status: ${on(f.antistatus)} | Anti-palavrao: ${on(f.antipalavrao)}`),
        previewText(`Anti-fake: ${on(f.antifake)} | So-admin: ${on(f.soadm)}`),
        previewText(`Anti-img/video/audio/sticker: ${on(f.antiimg)}/${on(f.antivideo)}/${on(f.antiaudio)}/${on(f.antisticker)}`),
        previewText(`Anti-doc/loc/contato: ${on(f.antidoc)}/${on(f.antiloc)}/${on(f.antictt)}`),
        previewText(`Bem-vindo: ${on(f.bemvindo)} | Saida: ${on(f.saiu)} | Autoconvite: ${on(f.autoconvite)} | Auto-aceitar: ${on(f.autoaceitar)}`),
        previewText(`Aviso config (x9config): ${on(f.x9config)}`),
        previewText(`Auto-apresentar: ${on(f.autoapresentar)} (default OFF, so este grupo)`),
        previewText(`Auto-down: ${on(f.autodown)} | Anti-notas: ${on(f.antinotas)} | Bangp: ${on(f.bangp)} | Auto-sticker: ${on(f.autosticker)}`),
        previewText(`Anti-porno: ${on(f.antiporno)} | Grupo divulgacao: ${on(f.grupoDivulgacao)}`),
        previewText(`Anti-admin: ${on(f.antiadmin)} | X9: ${on(f.antiadminAudit)} | Revert: ${on(f.antiadminRevert)}`),
        previewText(`Anti-delete: ${on(f.antidelete)} (recupera msg apagada neste grupo)`),
        '',
        previewText('ANTI-ATAQUE (ban+apaga — toggles individuais):'),
        previewText(formatAntiAtkStatus(f)),
        previewText(`Limite chars: ${on(f.limiteflood)} (${lists.limitec})`),
        previewText(`Anti-flood sticker: ${f.antifloodsticker > 0 ? `ON (${f.antifloodsticker})` : 'OFF'}`),
        previewText(`Mute: ${lists.mutes.length} | Lista negra do grupo: ${lists.blacklist.length} | Global: ${getGlobalBlacklist(telegramUserId).length} | Branca: ${lists.whitelist.length}`),
        previewText(`Advertencias: limiar ${lists.warnLimit}`)
    ].join('\n');
}

function getOwnerSecurity(telegramUserId) {
    let uid = '';
    try {
        uid = require('./userManager').normalizeTenantUid(telegramUserId) || '';
    } catch (_) {
        uid = String(telegramUserId || '').trim();
        if (uid === 'undefined' || uid === 'null') uid = '';
    }
    if (!uid) return { ...DEFAULT_OWNER_SECURITY };
    const config = getModerationConfig(uid) || {};
    const saved = config.ownerSecurity || {};
    const merged = { ...DEFAULT_OWNER_SECURITY, ...saved };
    if (saved.antipvDisabled === true) {
        merged.antipv = false;
        merged.antipv2 = false;
        merged.antipv3 = false;
        return merged;
    }
    // Padrao ON. Estado legado "3 off + chosen" (mutex antigo) volta a bloquear.
    if (saved.antipvChosen !== true || !(merged.antipv || merged.antipv2 || merged.antipv3)) {
        merged.antipv = true;
        merged.antipv2 = true;
        merged.antipv3 = true;
    }
    return merged;
}

function setOwnerSecurityFlag(telegramUserId, flag, enabled) {
    let uid = '';
    try {
        uid = require('./userManager').normalizeTenantUid(telegramUserId) || '';
    } catch (_) {
        uid = String(telegramUserId || '').trim();
        if (uid === 'undefined' || uid === 'null') uid = '';
    }
    if (!uid) return getOwnerSecurity(telegramUserId);
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_OWNER_SECURITY, flag)) {
        return getOwnerSecurity(uid);
    }
    const config = getModerationConfig(uid) || { enabledGroups: [] };
    config.ownerSecurity = { ...DEFAULT_OWNER_SECURITY, ...(config.ownerSecurity || {}) };
    config.ownerSecurity[flag] = !!enabled;
    if (flag === 'antipv' || flag === 'antipv2' || flag === 'antipv3') {
        config.ownerSecurity.antipvChosen = true;
        if (enabled) config.ownerSecurity.antipvDisabled = false;
    }
    setModerationConfig(uid, config);
    return getOwnerSecurity(uid);
}

function setAntipvAll(telegramUserId, enabled) {
    let uid = '';
    try {
        uid = require('./userManager').normalizeTenantUid(telegramUserId) || '';
    } catch (_) {
        uid = String(telegramUserId || '').trim();
        if (uid === 'undefined' || uid === 'null') uid = '';
    }
    if (!uid) return getOwnerSecurity(telegramUserId);
    const want = !!enabled;
    const config = getModerationConfig(uid) || { enabledGroups: [] };
    config.ownerSecurity = { ...DEFAULT_OWNER_SECURITY, ...(config.ownerSecurity || {}) };
    config.ownerSecurity.antipv = want;
    config.ownerSecurity.antipv2 = want;
    config.ownerSecurity.antipv3 = want;
    config.ownerSecurity.antipvChosen = true;
    config.ownerSecurity.antipvDisabled = !want;
    setModerationConfig(uid, config);
    return getOwnerSecurity(uid);
}

function formatOwnerSecurityStatus(telegramUserId) {
    const o = getOwnerSecurity(telegramUserId);
    const on = (v) => (v ? 'ON' : 'OFF');
    return [
        'SEGURANCA DA SESSAO (PV / LIGACOES)',
        `Anti-call: ${on(o.anticall)} — bloqueia quem ligar`,
        `Anti-PV: ${on(o.antipv)} — avisa e bloqueia PV (dono/VIP passam)`,
        `Anti-PV2: ${on(o.antipv2)} — avisa 1x e bloqueia`,
        `Anti-PV3: ${on(o.antipv3)} — ignora PV (dono/VIP passam)`,
        `Pre-apagar: ${on(o.odelete)} — protecoes apagam a msg ofensora`
    ].join('\n');
}

/** Conta msgs por membro (banghost) — RAM por telegramUserId, flush a cada 10 */
const msgCountRam = new Map(); // tid -> { [gid]: { [jid]: n } }

function _msgBag(telegramUserId) {
    const key = String(telegramUserId);
    if (!msgCountRam.has(key)) {
        const config = getModerationConfig(telegramUserId) || {};
        msgCountRam.set(key, { ...(config.msgCounts || {}) });
    }
    return msgCountRam.get(key);
}

function trackGroupMessage(groupId, senderId, telegramUserId) {
    const gid = ensureJidString(groupId, '');
    const sid = ensureJidString(senderId, '');
    if (!gid.endsWith('@g.us') || !sid || !telegramUserId) return;
    const bag = _msgBag(telegramUserId);
    if (!bag[gid]) bag[gid] = {};
    // Soma em todas as chaves LID↔telefone do mesmo membro
    const keys = [...participantKeys(sid)].filter(Boolean);
    const storeKey = keys.find((k) => bag[gid][k] != null) || sid;
    const next = Number(bag[gid][storeKey] || 0) + 1;
    bag[gid][storeKey] = next;
    // espelha nas aliases para leitura futura
    for (const k of keys) {
        if (k && k !== storeKey) bag[gid][k] = next;
    }
    if (next % 10 === 0) flushMsgCounts(telegramUserId);
}

function flushMsgCounts(telegramUserId) {
    const key = String(telegramUserId);
    if (!msgCountRam.has(key)) return;
    const config = getModerationConfig(telegramUserId) || { enabledGroups: [] };
    config.msgCounts = msgCountRam.get(key);
    setModerationConfig(telegramUserId, config);
}

function getMsgCounts(groupId, telegramUserId) {
    const gid = ensureJidString(groupId, '');
    const bag = _msgBag(telegramUserId);
    return { ...(bag[gid] || {}) };
}

/**
 * Membros com <= maxMsgs msgs (e opcionalmente fora do grupo = 0).
 * Exclui admins / bot.
 */
async function listGhostCandidates(conn, groupId, telegramUserId, maxMsgs = 0) {
    const gid = ensureJidString(groupId, '');
    const counts = getMsgCounts(gid, telegramUserId);
    const { getCachedGroupMetadata } = require('./groupMetaCache');
    const meta = await getCachedGroupMetadata(conn, gid);
    const botJid = ensureJidString(conn.user?.id || conn.user?.jid || '', '');
    const adminSet = new Set(
        (meta.participants || [])
            .filter((p) => p.admin === 'admin' || p.admin === 'superadmin')
            .map((p) => ensureJidString(p.id, ''))
    );
    const memberIds = (meta.participants || []).map((p) => ensureJidString(p.id, '')).filter(Boolean);
    const ghosts = [];
    for (const id of memberIds) {
        if (!id || sameParticipant(id, botJid)) continue;
        const isAdm = [...adminSet].some((a) => sameParticipant(a, id));
        if (isAdm) continue;
        let n = 0;
        for (const k of participantKeys(id)) {
            if (counts[k] != null) {
                n = Math.max(n, Number(counts[k]) || 0);
            }
        }
        if (n <= maxMsgs) ghosts.push({ id, msgs: n });
    }
    return ghosts.sort((a, b) => a.msgs - b.msgs);
}

function formatGroupSecurityHelp(prefix = '.', groupId = null, telegramUserId = null) {
    try {
        const { buildSecurityTextMenu } = require('./securityMenu');
        return buildSecurityTextMenu(prefix, groupId, telegramUserId, { isGroup: !!groupId });
    } catch (_) {
        const p = prefix || '.';
        return [
            'ANTI-FLOOD E SEGURANCA DE GRUPO',
            '',
            `Use DENTRO do grupo. Prefixo: ${p}`,
            `${p}modenable | ${p}moddisable | ${p}modstatus`,
            `${p}antilink | ${p}antilinkhard | ${p}antilinkgp | ${p}antichannel`,
            `${p}antiimg | ${p}antivideo | ${p}antisticker | ${p}soadm`,
            `${p}gpseguranca | ${p}modhelp`
        ].join('\n');
    }
}

const URL_RE = /https?:\/\/|www\.|chat\.whatsapp\.com\/|whatsapp\.com\/(?:channel|invite)\/|wa\.me\//i;
const URL_HIDDEN_RE = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|gg|io|me|app|site|link|xyz|br)(?:\/|\b)/i;
const INVITE_RE = /chat\.whatsapp\.com\/[A-Za-z0-9_-]+/i;
const CHANNEL_RE = /whatsapp\.com\/channel\/|@newsletter\b/i;
const LINK_TEXT_KEYS = new Set([
    'conversation', 'text', 'caption', 'contentText', 'description', 'title',
    'footerText', 'fileName', 'displayText', 'matchedText', 'canonicalUrl',
    'sourceUrl', 'body', 'selectedDisplayText', 'hydratedContentText', 'url'
]);

function stripHiddenChars(input) {
    return String(input || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '');
}

function collectLinkHaystack(message) {
    const root = unwrapMessage(message) || message?.message || {};
    const parts = [];
    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 10 || parts.length > 80) return;
        for (const [k, v] of Object.entries(node)) {
            if (k === 'quotedMessage' || k === 'quotedAd' || k === 'hydratedQuotedMessage') continue;
            if (typeof v === 'string' && v.length && v.length <= 20000) {
                if (LINK_TEXT_KEYS.has(k) || k === 'paramsJson') parts.push(v);
            } else if (v && typeof v === 'object') {
                if (Array.isArray(v)) {
                    for (const item of v.slice(0, 30)) walk(item, depth + 1);
                } else {
                    walk(v, depth + 1);
                }
            }
        }
    };
    walk(root, 0);
    const matched = root.extendedTextMessage?.contextInfo?.matchedText;
    if (matched) parts.push(matched);
    return stripHiddenChars(parts.join('\n'));
}

function messageHasLink(message) {
    const hay = collectLinkHaystack(message);
    if (!hay) return false;
    if (URL_RE.test(hay) || URL_HIDDEN_RE.test(hay)) return true;
    const norm = hay.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    if (norm.includes('clique na imagem')) return true;
    return false;
}

function messageHasInviteLink(message) {
    return INVITE_RE.test(collectLinkHaystack(message));
}

function messageHasChannelLink(message) {
    return CHANNEL_RE.test(collectLinkHaystack(message));
}

function detectBlockedMedia(message, flags) {
    const msg = unwrapMessage(message) || message?.message || {};
    if (flags.antiimg && msg.imageMessage) return 'antiimg';
    if (flags.antivideo && msg.videoMessage) return 'antivideo';
    if (flags.antiaudio && (msg.audioMessage || msg.pttMessage)) return 'antiaudio';
    if (flags.antisticker && msg.stickerMessage) return 'antisticker';
    if (flags.antidoc && (msg.documentMessage || msg.documentWithCaptionMessage)) return 'antidoc';
    if (flags.antiloc && (msg.locationMessage || msg.liveLocationMessage)) return 'antiloc';
    if (flags.antictt && (msg.contactMessage || msg.contactsArrayMessage)) return 'antictt';
    return null;
}

/** IDs de um participant do groupMetadata (LID + PN) */
function participantIdentityIds(p) {
    if (!p || typeof p !== 'object') return [];
    return [p.id, p.phoneNumber, p.jid, p.lid, p.participant].filter(Boolean);
}

function participantIsAdmin(p) {
    const a = p?.admin;
    if (a === 'admin' || a === 'superadmin' || a === true || a === 1) return true;
    return !!(p?.isAdmin || p?.isSuperAdmin);
}

function participantMatchesTarget(p, target, extraIds = []) {
    if (!p) return false;
    if (findParticipantByTarget([p], target)) return true;
    for (const t of extraIds || []) {
        if (t && findParticipantByTarget([p], t)) return true;
    }
    return false;
}

const failOpenHits = [];
let lastFailOpenAlertAt = 0;

function noteFailOpen(kind) {
    const now = Date.now();
    failOpenHits.push({ kind: String(kind || 'meta'), at: now });
    while (failOpenHits.length && now - failOpenHits[0].at > 3600000) failOpenHits.shift();
    if (failOpenHits.length < 25) return;
    if (now - lastFailOpenAlertAt < 30 * 60 * 1000) return;
    lastFailOpenAlertAt = now;
    logger.logAviso(`[MOD] fail-open ${failOpenHits.length}/h kind=${kind} — politica intacta (nao punir no escuro)`);
    try {
        const ids = String(process.env.TELEGRAM_ADMIN_IDS || '').split(/[,\s]+/).filter(Boolean);
        const tg = require('../telegramBot');
        const chat = ids[0];
        if (tg.bot && chat) {
            tg.bot.sendMessage(
                chat,
                `Alerta: fail-open LID/JID ${failOpenHits.length} na ultima hora. Continuo sem punir no escuro.`
            ).catch(() => {});
        }
    } catch (_) { /* tg opcional */ }
}

function getFailOpenStats() {
    const now = Date.now();
    while (failOpenHits.length && now - failOpenHits[0].at > 3600000) failOpenHits.shift();
    return { hour: failOpenHits.length };
}

const lastModFailLog = new Map();
function logModFailOnce(groupId, reason) {
    const msg = String(reason || '');
    if (/backoff|stale|iq-cap|Timeout: groupMetadata|rate-overlimit/i.test(msg)) return;
    const now = Date.now();
    const prev = lastModFailLog.get(groupId) || 0;
    if (now - prev < 15_000) return;
    lastModFailLog.set(groupId, now);
    if (/lid-mismatch/i.test(msg)) {
        noteFailOpen('lid-mismatch');
        logger.logAviso(`[MOD] fail-open: remetente nao casou LID/JID nos participantes ${groupId}`);
        return;
    }
    noteFailOpen('meta');
    logger.logAviso(
        `[soadm/meta] falha groupMetadata ${groupId}: ${msg} (fail-open: nao punir sem confirmar admin)`
    );
}

/** Todos os JIDs do remetente na msg (participant + Alt LID↔PN). Nunca o grupo. */
function collectMessageSenderIds(message, extraIds = []) {
    const key = message?.key || {};
        const raw = [
        key.participant,
        key.participantAlt,
        key.participantPn,
        key.senderPn,
        ...(Array.isArray(extraIds) ? extraIds : [extraIds])
    ];
    // remoteJidAlt em grupo as vezes e o PN do remetente; so entra se for pessoa
    if (key.remoteJidAlt && isKickableJid(key.remoteJidAlt)) raw.push(key.remoteJidAlt);
    if (message?.participant && isKickableJid(message.participant)) raw.push(message.participant);
    if (message?.author && isKickableJid(message.author)) raw.push(message.author);
    try {
        const rawMsg = message?.message || {};
        const gs =
            rawMsg.groupStatusMessageV2 ||
            rawMsg.groupStatusMessage ||
            rawMsg.groupStatusMentionMessage;
        if (gs && typeof gs === 'object') {
            raw.push(gs.participant, gs.author, gs.key?.participant, gs.key?.participantAlt);
        }
    } catch (_) { /* ignore */ }
    const out = [];
    const seen = new Set();
    for (const j of raw) {
        const s = ensureJidString(j, '');
        if (!s || seen.has(s) || !isKickableJid(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

/**
 * Admin/bot isento de protecoes automaticas.
 * extraIds: participantAlt / senderAlt — critico em modo LID.
 */
async function isGroupAdminOrBot(conn, groupId, senderId, extraIds = []) {
    const botId = ensureJidString(conn?.user?.id, '');
    const botLid = ensureJidString(conn?.user?.lid, '');
    const candidates = [
        senderId,
        ...(Array.isArray(extraIds) ? extraIds : extraIds ? [extraIds] : [])
    ]
        .map((j) => ensureJidString(j, ''))
        .filter((j) => j && (isKickableJid(j) || (botId && sameParticipant(j, botId)) || (botLid && sameParticipant(j, botLid))));
    // Sem JID de pessoa (status/midia sem participant) → fail-open: nao punir (pode ser ADM)
    if (!candidates.length) return true;

    try {
        const { getSecurityGroupMetadata, peekGroupMetadata } = require('./groupMetaCache');
        let meta = null;
        try {
            meta = await getSecurityGroupMetadata(conn, groupId);
        } catch (_) {
            meta = peekGroupMetadata(groupId);
        }
        if (!meta) {
            return true;
        }
        const stamp = peekMetaFreshness(groupId);
        const metaFresh = !!(stamp && stamp.fresh);
        const isBot = candidates.some((c) =>
            (botId && sameParticipant(c, botId)) || (botLid && sameParticipant(c, botLid))
        );
        if (isBot) return true;

        const parts = meta.participants || [];
        const matched = parts.filter((p) => {
            const pids = participantIdentityIds(p);
            return candidates.some((c) => pids.some((pid) => sameParticipant(pid, c)));
        });
        if (!matched.length) {
            logModFailOnce(groupId, 'lid-mismatch');
            return true;
        }
        const isAdm = matched.some((p) => p.admin === 'admin' || p.admin === 'superadmin');
        if (isAdm) return true;
        // Cache velho/soft diz "membro": nao punir (pode ter virado admin)
        if (!metaFresh) return true;
        return false;
    } catch (e) {
        logModFailOnce(groupId, e && e.message ? e.message : e);
        return true;
    }
}

function peekMetaFreshness(groupId) {
    try {
        const { peekMetaStamp, SECURITY_TTL_MS } = require('./groupMetaCache');
        if (typeof peekMetaStamp === 'function') return peekMetaStamp(groupId);
        const { peekGroupMetadata } = require('./groupMetaCache');
        const meta = peekGroupMetadata(groupId);
        return {
            meta,
            ageMs: meta ? 0 : Infinity,
            soft: !meta,
            fresh: !!meta && (SECURITY_TTL_MS == null || true)
        };
    } catch (_) {
        return { meta: null, ageMs: Infinity, soft: true, fresh: false };
    }
}

/** Fail-closed: so true se o cache/live mostrar admin. Sem meta = nao-admin. */
async function isGroupAdminStrict(conn, groupId, senderId, extraIds = []) {
    try {
        const { getSecurityGroupMetadata, peekGroupMetadata } = require('./groupMetaCache');
        let meta = null;
        try {
            meta = await getSecurityGroupMetadata(conn, groupId);
        } catch (_) {
            meta = peekGroupMetadata(groupId);
        }
        if (!meta) return false;
        const cands = [senderId, ...(Array.isArray(extraIds) ? extraIds : extraIds ? [extraIds] : [])]
            .map((j) => ensureJidString(j, ''))
            .filter(Boolean);
        if (!cands.length) return false;
        const matched = (meta.participants || []).filter((p) => {
            const pids = participantIdentityIds(p);
            return cands.some((c) => pids.some((pid) => sameParticipant(pid, c)));
        });
        if (!matched.length) return false;
        return matched.some((p) => p.admin === 'admin' || p.admin === 'superadmin');
    } catch (_) {
        return false;
    }
}

/** Protecao auto: admin / dono / fromMe → nao apaga/ban */
async function isSecurityExemptSender(conn, message, opts = {}) {
    if (!message?.key) return false;
    if (message.key.fromMe) return true;
    const groupId = ensureJidString(message.key.remoteJid, '');
    if (!groupId.endsWith('@g.us')) return false;
    const ids = collectMessageSenderIds(message, [
        opts.senderAlt,
        opts.sender,
        ...(opts.extraIds || [])
    ]);
    if (!ids.length) return true;
    try {
        const { isFreshSessionOwner } = require('./authorization');
        if (opts.ctx && isFreshSessionOwner(opts.ctx)) return true;
    } catch (_) { /* ignore */ }
    if (opts.telegramUserId && ids.some((id) => isOwnerOrBotTarget(conn, opts.telegramUserId, id))) {
        return true;
    }
    return isGroupAdminOrBot(conn, groupId, ids[0], ids.slice(1));
}

/**
 * Anti-link / hard / gp — apaga (e remove se hard). Respeita listabranca.
 */
async function processGroupLinkGuard(conn, message, telegramUserId) {
    if (!message?.key) return null;
    const groupId = ensureJidString(message.key.remoteJid, '');
    if (!groupId.endsWith('@g.us') || message.key.fromMe) return null;
    // antilink le URL no texto — nao aplica em bolha de pagamento/reacao
    if (isPaymentMessage(message) || unwrapMessage(message)?.reactionMessage) return null;

    const flags = getGroupSecurity(groupId, telegramUserId);
    if (!flags.antilink && !flags.antilinkHard && !flags.antilinkGp && !flags.antilinkEasy) return null;

    const senderIds = collectMessageSenderIds(message);
    const senderId = senderIds[0] || '';
    if (!senderId) return null;
    if (isWhitelisted(groupId, telegramUserId, senderId)) return null;
    if (senderIds.slice(1).some((id) => isWhitelisted(groupId, telegramUserId, id))) return null;

    const hasAny = messageHasLink(message);
    const hasInvite = messageHasInviteLink(message);
    let hit = null;
    if (flags.antilinkHard && hasAny) hit = 'antilink_hard';
    else if ((flags.antilink || flags.antilinkEasy) && hasAny) hit = flags.antilinkEasy ? 'antilink_easy' : 'antilink';
    else if (flags.antilinkGp && hasInvite) hit = 'antilink_gp';
    if (!hit) return null;

    if (telegramUserId && senderIds.some((id) => isOwnerOrBotTarget(conn, telegramUserId, id))) return null;
    if (await isGroupAdminOrBot(conn, groupId, senderId, senderIds.slice(1))) return null;

    await deleteMessageAsAdmin(
        conn,
        groupId,
        message.key.id,
        !!message.key.fromMe,
        senderId
    );

    if (hit === 'antilink_hard') {
        const banned = await kickIfAllowed(conn, groupId, senderId, 'antilink_hard', flags);
        await announceGroupProtection(conn, groupId, senderId, hit, message, !!banned);
        return { success: true, reason: banned ? 'antilink_hard' : 'antilink_hard_delete_only', banned };
    }
    await announceGroupProtection(conn, groupId, senderId, hit, message, false);
    return { success: true, reason: hit };
}

/**
 * Telefone do membro: PN no JID, LID→PN no cache, ou campos do participant.
 * LID sem mapa fica vazio (nao chute BR).
 */
function resolveMemberPhoneDigits(conn, jid, participant) {
    const s = ensureJidString(jid, '');
    let d = identityPhoneDigits(s);
    if (d) return d;
    try {
        const { getPhoneForLid, resolvePeerJid } = require('../utils');
        if (isLidJid(s)) {
            const mapped = getPhoneForLid(s)
                || (typeof resolvePeerJid === 'function' ? resolvePeerJid(s, null, conn) : null);
            if (mapped) {
                const asJid = ensureJidString(mapped, '');
                d = identityPhoneDigits(asJid) || String(mapped).replace(/\D/g, '');
                if (d.length >= 10 && d.length <= 15) return d;
            }
        }
    } catch (_) { /* mapping opcional */ }
    if (participant && typeof participant === 'object') {
        for (const c of [participant.phoneNumber, participant.jid, participant.id]) {
            const t = String(c || '');
            if (!t || t.includes('@lid') || t.includes('@g.us')) continue;
            const n = t.replace(/\D/g, '');
            if (n.length >= 10 && n.length <= 15) return n;
        }
    }
    return '';
}

function isForeignBrazilDdi(digits) {
    const n = String(digits || '').replace(/\D/g, '');
    if (!n || n.length < 10) return false;
    return !n.startsWith('55');
}

/** Anti-fake: remove DDI != 55 ao entrar. Tenta LID→PN antes de desistir. */
async function processAntifakeJoin(conn, update, telegramUserId) {
    if (!update || update.action !== 'add') return;
    const groupId = ensureJidString(update.id, '');
    if (!groupId.endsWith('@g.us')) return;
    const flags = getGroupSecurity(groupId, telegramUserId);
    if (!flags.antifake) return;

    let metaParts = [];
    try {
        const { peekGroupMetadata } = require('./groupMetaCache');
        metaParts = peekGroupMetadata(groupId)?.participants || [];
    } catch (_) { /* cache opcional */ }

    for (const p of update.participants || []) {
        const jid = ensureJidString(typeof p === 'string' ? p : (p?.id || p?.jid || p?.lid), '');
        if (!jid || !isKickableJid(jid)) continue;
        const part = (typeof p === 'object' && p) || metaParts.find((m) => {
            const ids = [m.id, m.lid, m.jid, m.phoneNumber].map((x) => ensureJidString(x, ''));
            return ids.includes(jid);
        }) || null;
        const digits = resolveMemberPhoneDigits(conn, jid, part);
        if (!isForeignBrazilDdi(digits)) continue;
        await kickIfAllowed(conn, groupId, jid, 'antifake', flags, [`${digits}@s.whatsapp.net`]);
        await announceGroupProtection(conn, groupId, jid, 'antifake', { message: {} }, true);
    }
}

/** Anti-fake em mensagem: quem ja esta no grupo com DDI != 55. */
async function processAntifakeMessage(conn, message, telegramUserId) {
    const groupId = ensureJidString(message?.key?.remoteJid, '');
    if (!groupId.endsWith('@g.us')) return null;
    const flags = getGroupSecurity(groupId, telegramUserId);
    if (!flags.antifake) return null;
    const senderIds = collectMessageSenderIds(message);
    const senderId = senderIds[0] || '';
    if (!senderId) return null;
    let digits = '';
    for (const sid of senderIds) {
        digits = resolveMemberPhoneDigits(conn, sid, null);
        if (digits) break;
    }
    if (!isForeignBrazilDdi(digits)) return null;
    await deleteInboundMessage(conn, message, senderId);
    const kicked = await kickIfAllowed(conn, groupId, senderId, 'antifake', flags, senderIds);
    return { success: true, reason: 'antifake', banned: !!kicked };
}

/** Lista negra no join (grupo + global) */
async function processBlacklistJoin(conn, update, telegramUserId) {
    if (!update || update.action !== 'add') return;
    const groupId = ensureJidString(update.id, '');
    if (!groupId.endsWith('@g.us')) return;
    const lists = getGroupLists(groupId, telegramUserId);
    const global = getGlobalBlacklist(telegramUserId);
    if (!lists.blacklist.length && !global.length) return;
    for (const p of update.participants || []) {
        const jid = ensureJidString(p, '');
        if (!jid || !isKickableJid(jid)) continue;
        if (isOwnerOrBotTarget(conn, telegramUserId, jid)) continue;
        const hit =
            listHasParticipant(lists.blacklist, jid) ||
            isGloballyBlacklisted(telegramUserId, jid);
        if (!hit) continue;
        await kickIfAllowed(conn, groupId, jid, 'listanegra_join', getGroupSecurity(groupId, telegramUserId));
    }
}

async function processMuteGuard(conn, message, telegramUserId) {
    if (!message?.key || message.key.fromMe) return null;
    const groupId = ensureJidString(message.key.remoteJid, '');
    if (!groupId.endsWith('@g.us')) return null;
    const senderIds = collectMessageSenderIds(message);
    const senderId = senderIds[0] || '';
    if (!senderId) return null;
    const lists = getGroupLists(groupId, telegramUserId);
    const muted = senderIds.some((id) => listHasParticipant(lists.mutes, id));
    if (!muted) return null;
    // Membros: mute ainda respeita admin (nao apaga admin mutado por engano LID)
    if (await isGroupAdminOrBot(conn, groupId, senderId, senderIds.slice(1))) return null;
    await deleteInboundMessage(conn, message, senderId);
    return { success: true, reason: 'mute' };
}

async function processBlacklistMessage(conn, message, telegramUserId) {
    if (!message?.key || message.key.fromMe) return null;
    const groupId = ensureJidString(message.key.remoteJid, '');
    if (!groupId.endsWith('@g.us')) return null;
    const senderIds = collectMessageSenderIds(message);
    const senderId = senderIds[0] || '';
    if (!senderId) return null;
    const lists = getGroupLists(groupId, telegramUserId);
    const black =
        senderIds.some((id) => listHasParticipant(lists.blacklist, id)) ||
        isGloballyBlacklisted(telegramUserId, senderIds);
    if (!black) return null;
    if (isOwnerOrBotTarget(conn, telegramUserId, senderId)) return null;
    if (await isGroupAdminOrBot(conn, groupId, senderId, senderIds.slice(1))) return null;
    await deleteMessageAsAdmin(conn, groupId, message.key.id, !!message.key.fromMe, senderId);
    const banned = await kickIfAllowed(
        conn,
        groupId,
        senderId,
        'listanegra',
        getGroupSecurity(groupId, telegramUserId)
    );
    return { success: true, reason: banned ? 'listanegra' : 'listanegra_delete_only', banned };
}

function trackPaymentFlood(groupId, senderId, max = 3) {
    const key = `${ensureJidString(groupId)}_${ensureJidString(senderId)}`;
    const now = Date.now();
    if (!paymentFloodCache.has(key)) paymentFloodCache.set(key, []);
    const arr = paymentFloodCache.get(key).filter((t) => now - t < 20_000);
    arr.push(now);
    paymentFloodCache.set(key, arr);
    return arr.length >= max;
}

function trackStickerFlood(groupId, senderId, max) {
    const key = `${ensureJidString(groupId)}_${ensureJidString(senderId)}`;
    const now = Date.now();
    if (!stickerFloodCache.has(key)) stickerFloodCache.set(key, []);
    const arr = stickerFloodCache.get(key).filter((t) => now - t < FLOOD_TIME_WINDOW);
    arr.push(now);
    stickerFloodCache.set(key, arr);
    return arr.length > max;
}

/**
 * Midia / canal / limite chars / flood sticker — so apaga (nao remove).
 */
async function processContentGuards(conn, message, telegramUserId) {
    if (!message?.key || message.key.fromMe) return null;
    const groupId = ensureJidString(message.key.remoteJid, '');
    if (!groupId.endsWith('@g.us')) return null;
    const senderIds = collectMessageSenderIds(message);
    const senderId = senderIds[0] || '';
    if (!senderId) return null;
    if (isWhitelisted(groupId, telegramUserId, senderId)) return null;
    if (senderIds.slice(1).some((id) => isWhitelisted(groupId, telegramUserId, id))) return null;

    const flags = getGroupSecurity(groupId, telegramUserId);
    if (flags.antifake) {
        const fakeHit = await processAntifakeMessage(conn, message, telegramUserId);
        if (fakeHit) return fakeHit;
    }
    const lists = getGroupLists(groupId, telegramUserId);
    const msg = unwrapMessage(message) || message?.message || {};
    const nativePay = isPaymentMessage(message);
    const isReaction = !!(msg.reactionMessage);
    let reason = null;

    // Tipos protobuf primeiro — nunca o texto da divulgacao/note
    if (flags.antipayment && nativePay) reason = 'antipayment';
    if (!reason && flags.anticatalogo && (msg.productMessage || msg.orderMessage || msg.productListMessage)) {
        reason = 'anticatalogo';
    }
    if (!reason && flags.antistatus && isStatusMessage(message)) reason = 'antistatus';
    if (!reason && flags.antinotas) {
        if (
            msg.keepInChatMessage ||
            msg.pinInChatMessage ||
            msg.newsletterAdminInviteMessage ||
            msg.eventMessage ||
            (msg.protocolMessage && Number(msg.protocolMessage.type) === 25)
        ) {
            reason = 'antinotas';
        }
    }
    // Texto so em conversa normal (link/palavrao). Nao vasculha note da cobranca nem reacao.
    if (!reason && !nativePay && !isReaction && flags.antichannel && messageHasChannelLink(message)) {
        reason = 'antichannel';
    }
    if (!reason && !nativePay && !isReaction && flags.antipalavrao) {
        const text = getMessageText(msg).toLowerCase();
        const words = lists.badWords || DEFAULT_BAD_WORDS;
        if (text && words.some((w) => w && text.includes(String(w).toLowerCase()))) {
            reason = 'antipalavrao';
        }
    }
    if (!reason && flags.antiporno) {
        if (msg.imageMessage) {
            if (await isGroupAdminOrBot(conn, groupId, senderId, senderIds.slice(1))) return null;
            const pornHit = await analyzeAntiporno(conn, message, groupId, senderId, telegramUserId);
            if (pornHit) return pornHit;
        }
    }
    if (!reason) reason = detectBlockedMedia(message, flags);

    if (!reason && !nativePay && !isReaction && flags.limiteflood) {
        const text = getMessageText(msg);
        if (text && text.length > (lists.limitec || DEFAULT_CHAR_LIMIT)) reason = 'limiteflood';
    }

    if (!reason && flags.antifloodsticker > 0) {
        if (msg.stickerMessage && trackStickerFlood(groupId, senderId, flags.antifloodsticker)) {
            reason = 'antifloodsticker';
        }
    }

    if (!reason) return null;
    // Admin so apos ter motivo — msg comum nao gasta meta (LID+Alt)
    if (await isGroupAdminOrBot(conn, groupId, senderId, senderIds.slice(1))) return null;
    if (reason === 'antipayment') {
        const keys = [
            ...nativePaymentKeys(message.message || {}),
            ...nativePaymentKeys(msg)
        ].filter((v, i, a) => a.indexOf(v) === i);
        logger.logAviso(`[MODERATION] antipayment nativo keys=${keys.join(',') || '?'} grupo=${groupId}`);
    }
    // Pagamento divulgacao (requestPaymentMessage) → fake; resto → admin
    if (reason === 'antipayment' || isDivulgacaoPaymentPayload(message)) {
        await deleteMessageWithFakeTechnique(conn, groupId, message.key.id, !!message.key.fromMe, senderId, message.key);
        const flood = trackPaymentFlood(groupId, senderId);
        const wantKick = !!(flags.antiatkpagamento || (flood && flags.antipayment));
        let banned = false;
        if (wantKick) {
            banned = await kickIfAllowed(
                conn,
                groupId,
                senderId,
                flags.antiatkpagamento ? 'antiataque_pagamento' : 'stealth_payment',
                flags
            );
        }
        await announceGroupProtection(conn, groupId, senderId, reason, message, !!banned);
    } else {
        await deleteInboundMessage(conn, message, senderId);
        await announceGroupProtection(conn, groupId, senderId, reason, message, false);
    }
    return { success: true, reason };
}

function setWelcomeText(groupId, telegramUserId, text, kind = 'welcome') {
    const lists = getGroupLists(groupId, telegramUserId);
    const t = String(text || '').trim();
    if (kind === 'leave') lists.leaveText = t;
    else lists.welcomeText = t;
    saveGroupLists(groupId, telegramUserId, lists);
    return kind === 'leave' ? lists.leaveText : lists.welcomeText;
}

/** Bem-vindo / saida — so envia o que o lojista configurou (texto/foto/fig/audio). */
async function processWelcomeLeave(conn, update, telegramUserId) {
    if (!update || !update.id) return;
    const groupId = ensureJidString(update.id, '');
    if (!groupId.endsWith('@g.us')) return;
    const flags = getGroupSecurity(groupId, telegramUserId);
    const lists = getGroupLists(groupId, telegramUserId);
    const action = update.action;
    const people = update.participants || [];
    if (!people.length) return;
    if (action !== 'add' && action !== 'remove' && action !== 'leave') return;

    const { sendWelcomeLeave } = require('./welcomeKit');
    for (const p of people) {
        const jid = ensureJidString(p, '');
        if (!jid) continue;
        if ((action === 'remove' || action === 'leave') && isGloballyBlacklisted(telegramUserId, jid)) {
            continue;
        }
        try {
            await sendWelcomeLeave(conn, {
                groupId,
                telegramUserId,
                jid,
                action,
                flags,
                lists
            });
        } catch (e) {
            logger.logAviso(`[WELCOME] ${e.message}`);
        }
    }
}

/**
 * Credenciais da API Hanork / Zero Two (mesma key do .env — ex: ).
 */
function resolveHanorkApiCreds() {
    const API_BASE = (
        process.env.HANORK_API_BASE ||
        process.env.ZEROTWO_API_BASE ||
        'https://zero-two-apis.store'
    ).replace(/\/$/, '');
    const API_KEY = (
        process.env.HANORK_API_KEY ||
        process.env.ZEROTWO_API_KEY ||
        process.env.HANORK_API_KEY ||
        process.env.ZEROTWO_API_KEY ||
        ''
    ).trim();
    return { API_BASE, API_KEY };
}

/**
 * Antiporno via Hanork API (HANORK_API_KEY ou ZEROTWO_API_KEY — ex. ).
 * Niveis: aviso / delete / kick.
 * So imagem. Video/sticker entram no if do caller mas aqui nao ha classificador de frame.
 */
function parseAntipornoClasses(analysis) {
    const raw = analysis?.resultado ?? analysis?.result ?? analysis?.data;
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.classifications)) return raw.classifications;
    if (Array.isArray(raw?.predictions)) return raw.predictions;
    if (Array.isArray(analysis?.classifications)) return analysis.classifications;
    return null;
}

function antipornoApiError(analysis) {
    const raw = analysis?.resultado;
    const msg =
        (raw && !Array.isArray(raw) && (raw.error?.message || raw.error)) ||
        analysis?.error?.message ||
        analysis?.error ||
        analysis?.mensagem ||
        '';
    return String(msg || '').slice(0, 160);
}

let antipornoLast = { at: 0, ok: null, err: '' };

function noteAntipornoHealth(ok, err) {
    antipornoLast = {
        at: Date.now(),
        ok: !!ok,
        err: String(err || '').replace(/\s+/g, ' ').slice(0, 80)
    };
}

/** Painel: SEM CHAVE / API MORTA / ok. Nao dispara request. */
function getAntipornoHealth() {
    const hasKey = !!resolveHanorkApiCreds().API_KEY;
    if (!hasKey) {
        return {
            state: 'no_key',
            label: 'SEM CHAVE',
            explain: 'SEM CHAVE: toggle nao analisa midia. Coloque HANORK_API_KEY no .env'
        };
    }
    if (antipornoLast.ok === true) {
        return {
            state: 'ok',
            label: null,
            explain: 'Classifica so foto. Video/figurinha nao. Se a API cair, nao apaga.'
        };
    }
    if (antipornoLast.ok === false) {
        const modelo = /not loaded/i.test(antipornoLast.err);
        return {
            state: 'down',
            label: 'API MORTA',
            explain: modelo
                ? 'API MORTA: modelo NSFW nao carregado no provedor. Toggle nao apaga.'
                : 'API MORTA: classificacao fora. Toggle nao apaga ate o provedor voltar.'
        };
    }
    return {
        state: 'unknown',
        label: null,
        explain: 'Classifica so foto. Se a API estiver morta, o toggle nao apaga.'
    };
}

async function callAntipornoApi(mediaUrl, API_BASE, API_KEY) {
    const axios = require('axios');
    let lastErr = '';
    for (let i = 0; i < 3; i++) {
        const { data, status } = await axios.get(`${API_BASE}/api/antiporno`, {
            params: { url: mediaUrl, apikey: API_KEY, model: 'latest' },
            timeout: 25000,
            validateStatus: () => true
        });
        const classes = parseAntipornoClasses(data);
        if (classes && classes.length) return { ok: true, classes, data };
        lastErr = antipornoApiError(data) || `http_${status}`;
        if (/not loaded/i.test(lastErr) && i < 2) {
            await new Promise((r) => setTimeout(r, 2500));
            continue;
        }
        return { ok: false, err: lastErr, data };
    }
    return { ok: false, err: lastErr || 'vazio' };
}

async function analyzeAntiporno(conn, message, groupId, senderId, telegramUserId) {
    const { API_BASE, API_KEY } = resolveHanorkApiCreds();
    if (!API_KEY) {
        logger.logAviso('[ANTIPORNO] sem HANORK_API_KEY / ZEROTWO_API_KEY no .env');
        return null;
    }

    const msg = unwrapMessage(message) || message?.message || {};
    const img = msg.imageMessage;
    if (!img) return null;

    try {
        const { downloadMediaMessage } = require('@systemzero/baileys');
        const buffer = await downloadMediaMessage(
            { key: message.key, message: message.message },
            'buffer',
            {},
            {}
        );
        if (!buffer) return null;
        const { uploadImageBuffer } = require('./mediaUpload');
        const mediaUrl = await uploadImageBuffer(buffer);
        if (!mediaUrl) {
            logger.logAviso('[ANTIPORNO] upload da imagem falhou');
            return null;
        }

        const hit = await callAntipornoApi(mediaUrl, API_BASE, API_KEY);
        if (!hit.ok) {
            noteAntipornoHealth(false, hit.err || 'sem classes');
            logger.logAviso(`[ANTIPORNO] API indisponivel: ${hit.err || 'sem classes'}`);
            return null;
        }
        noteAntipornoHealth(true, '');
        const results = hit.classes.filter((item) =>
            ['Porn', 'Sexy', 'Hentai'].includes(item.className)
        );
        const prob = (name) => results.find((i) => i.className === name)?.probability || 0;
        const porn = prob('Porn');
        const sexy = prob('Sexy');
        const hentai = prob('Hentai');

        let shouldDelete = false;
        let shouldBan = false;
        let text = '';
        if (porn > 0.85 || sexy > 0.97 || hentai > 0.85) {
            shouldDelete = true;
            shouldBan = true;
            text =
                `BANIMENTO AUTOMATICO\n@${senderId.split('@')[0]} removido por conteudo NSFW\n` +
                `Porn: ${(porn * 100).toFixed(0)}% | Hentai: ${(hentai * 100).toFixed(0)}%`;
        } else if (porn > 0.65 || sexy > 0.9 || hentai > 0.7) {
            shouldDelete = true;
            text =
                `ALERTA\n@${senderId.split('@')[0]}, conteudo improprio detectado.\nUltimo aviso.`;
        } else if (porn > 0.4 || sexy > 0.75 || hentai > 0.5) {
            text =
                `Aviso\n@${senderId.split('@')[0]}, cuidado com o conteudo.\nAnti-porno ativo.`;
        } else {
            return null;
        }

        if (shouldDelete) {
            await deleteMessageAsAdmin(
                conn,
                groupId,
                message.key.id,
                !!message.key.fromMe,
                senderId
            );
        }
        if (shouldBan) {
            await kickIfAllowed(
                conn,
                groupId,
                senderId,
                'antiporno_ban',
                getGroupSecurity(groupId, telegramUserId)
            );
        }
        if (text) {
            await conn.sendMessage(groupId, { text, mentions: [senderId] }).catch(() => {});
        }
        // Soft-warn nao aborta o restante do handler
        if (!shouldDelete && !shouldBan) return null;
        return { success: true, reason: shouldBan ? 'antiporno_ban' : 'antiporno' };
    } catch (e) {
        noteAntipornoHealth(false, e.message);
        logger.logAviso(`[ANTIPORNO] ${e.message}`);
        return null;
    }
}

const antipvWarned = new Map(); // key telegramUserId:jid -> true
const antipvBlockedAt = new Map();

function pvAntiMode(telegramUserId) {
    const flags = getOwnerSecurity(telegramUserId);
    if (flags.antipv) return 'antipv';
    if (flags.antipv2) return 'antipv2';
    if (flags.antipv3) return 'antipv3';
    return null;
}

/** 1:1 LID/PN/hosted — nao confia em ctx.isGroup (Baileys/LID ja marcou PV como grupo). */
function isPrivatePersonChat(ctx) {
    if (!ctx || ctx.isChannel) return false;
    const from = ensureJidString(ctx.from || ctx.chatId || ctx.info?.key?.remoteJid || '', '');
    if (!from) return false;
    if (from.endsWith('@g.us') || from.endsWith('@newsletter')) return false;
    if (from === 'status@broadcast' || from.endsWith('@broadcast')) return false;
    if (
        from.endsWith('@lid') ||
        from.endsWith('@s.whatsapp.net') ||
        from.endsWith('@c.us') ||
        from.endsWith('@hosted') ||
        from.endsWith('@hosted.lid') ||
        from.includes('.lid')
    ) {
        return true;
    }
    return ctx.isGroup !== true;
}

function isPvAntiExempt(ctx) {
    if (!ctx) return false;
    try {
        const { isFreshSessionOwner, checkAuthorization, resolveCanonicalIdentity } = require('./authorization');
        if (isFreshSessionOwner(ctx)) return true;
        const ids = resolveCanonicalIdentity(ctx.sender || ctx.from, ctx);
        const sender = ids[0] || ctx.sender || ctx.from;
        if (!sender) return false;
        const auth = checkAuthorization(
            sender,
            ctx.telegramUserId,
            false,
            ids.slice(1),
            ctx.conn
        );
        return auth.role === 'vip' || auth.role === 'owner' || auth.role === 'platform_admin';
    } catch (_) {
        return false;
    }
}

function pvAntiWouldBlock(ctx, telegramUserId) {
    if (!ctx) return null;
    if (!isPrivatePersonChat(ctx)) return null;
    if (ctx.fromMe || ctx.info?.key?.fromMe) return null;
    const mode = pvAntiMode(telegramUserId);
    if (!mode) return null;
    if (isPvAntiExempt(ctx)) return null;
    return mode;
}

/**
 * Corpo de usuario no PV (texto/midia/botao). Protocolo, historico e stub
 * nao contam — responder isso abre conversa com quem nao mandou nada.
 */
function hasInboundPvUserBody(info) {
    if (!info || typeof info !== 'object') return false;
    if (info.messageStubType) return false;
    const key = info.key || {};
    if (key.fromMe) return false;
    const msg = unwrapMessage(info) || unwrapMessage(info.message) || info.message;
    if (!msg || typeof msg !== 'object') return false;
    const ext = msg.extendedTextMessage || msg.extendedTextMessage;
    const proto = msg.protocolMessage || msg.protocolMessage;
    const sk = msg.senderKeyDistributionMessage || msg.senderKeyDistributionMessage;
    if (proto && !msg.conversation && !ext) return false;
    if (sk && !msg.conversation && !ext) {
        const keys = Object.keys(msg).filter((k) => k !== 'messageContextInfo');
        if (keys.length <= 1) return false;
    }
    const text = String(
        msg.conversation ||
        ext?.text ||
        msg.imageMessage?.caption ||
        msg.imageMessage?.caption ||
        msg.videoMessage?.caption ||
        msg.videoMessage?.caption ||
        msg.documentMessage?.caption ||
        msg.documentMessage?.caption ||
        ''
    ).trim();
    if (text) return true;
    if (
        msg.imageMessage ||
        msg.imageMessage ||
        msg.videoMessage ||
        msg.videoMessage ||
        msg.audioMessage ||
        msg.audioMessage ||
        msg.stickerMessage ||
        msg.stickerMessage ||
        msg.documentMessage ||
        msg.documentMessage
    ) {
        return true;
    }
    if (
        msg.contactMessage ||
        msg.contactMessage ||
        msg.contactsArrayMessage ||
        msg.contactsArrayMessage ||
        msg.locationMessage ||
        msg.locationMessage ||
        msg.liveLocationMessage ||
        msg.liveLocationMessage
    ) {
        return true;
    }
    if (
        msg.buttonsResponseMessage ||
        msg.buttonsResponseMessage ||
        msg.listResponseMessage ||
        msg.listResponseMessage ||
        msg.templateButtonReplyMessage ||
        msg.templateButtonReplyMessage ||
        msg.interactiveResponseMessage ||
        msg.interactiveResponseMessage ||
        msg.nativeFlowResponseMessage ||
        msg.nativeFlowResponseMessage
    ) {
        return true;
    }
    if (msg.pollCreationMessage || msg.pollCreationMessage || msg.pollCreationMessageV3 || msg.pollCreationMessageV3) {
        return true;
    }
    return false;
}

function isLivePvNotify(ctx, info) {
    const t = String(
        ctx?.upsertType ||
        info?._hanorkUpsertType ||
        ctx?.info?._hanorkUpsertType ||
        ''
    ).toLowerCase();
    if (!t) return true;
    return t === 'notify';
}

function collectPvBlockTargets(from, ctx, conn) {
    const seen = new Set();
    const out = [];
    const push = (raw) => {
        const s = ensureJidString(raw, '');
        if (!s || seen.has(s)) return;
        if (s.endsWith('@g.us') || s.endsWith('@newsletter') || s === 'status@broadcast') return;
        seen.add(s);
        out.push(s);
    };
    push(from);
    push(ctx?.from);
    push(ctx?.sender);
    push(ctx?.senderAlt);
    const k = (ctx && (ctx.info?.key || ctx.key)) || {};
    push(k.remoteJid);
    push(k.remoteJidAlt);
    push(k.senderPn);
    push(k.participantPn);
    try {
        const { getPhoneForLid, resolvePeerJid } = require('../utils');
        const pn = typeof resolvePeerJid === 'function' ? resolvePeerJid(from, k, conn) : null;
        if (pn) push(pn);
        for (const j of [...out]) {
            if (String(j).includes('@lid')) {
                const mapped = getPhoneForLid(j);
                if (mapped) {
                    const d = String(mapped).replace(/\D/g, '');
                    if (d.length >= 10) push(`${d}@s.whatsapp.net`);
                }
            }
        }
    } catch (_) { /* mapping opcional */ }
    return out;
}

async function blockPvJid(conn, jid) {
    if (!conn || !jid) return false;
    const fn = conn.updateBlockStatus || conn.updateBlockStatus;
    if (typeof fn !== 'function') return false;
    await fn.call(conn, jid, 'block');
    return true;
}

/**
 * Anti-PV (sessao). Retorna { handled: true } se a msg deve ser ignorada.
 * Dono/VIP passam. User comum: sem resposta de comando + tenta block no Zap.
 */
async function processPrivateSecurity(conn, ctx, telegramUserId) {
    if (!ctx || !isPrivatePersonChat(ctx)) return null;
    if (ctx.fromMe || ctx.info?.key?.fromMe) return null;
    const from = ensureJidString(ctx.from, '');
    if (!from) return null;
    const mode = pvAntiWouldBlock(ctx, telegramUserId);
    if (!mode) return null;

    const info = ctx.info || ctx.msg || ctx;
    // Catchup/append/historico: nao falar no PV. Mandar aviso abre conversa
    // com quem nunca escreveu (parece que o bot chamou a pessoa).
    if (!isLivePvNotify(ctx, info)) {
        logger.logAviso(`[ANTIPV] silencioso catchup from=${from}`);
        return { handled: true, reason: 'antipv-catchup-silent' };
    }
    if (!hasInboundPvUserBody(info)) {
        logger.logAviso(`[ANTIPV] silencioso sem-corpo from=${from}`);
        return { handled: true, reason: 'antipv-no-body' };
    }

    const warnKey = `${telegramUserId}:${from}`;
    let notice = '';
    if (!antipvWarned.has(warnKey)) {
        antipvWarned.set(warnKey, true);
        let custom = '';
        try {
            custom = await require('./groupModStore').getPvNotice(telegramUserId);
        } catch (_) { /* opcional */ }
        if (mode === 'antipv') notice = custom || 'PV bloqueado (anti-pv ativo). Contate o dono da sessao.';
        else if (mode === 'antipv2') notice = custom || 'Aviso: o PV desta sessao nao atende comandos. Voce foi bloqueado.';
        else notice = '';
    }
    if (notice) {
        await conn.sendMessage(from, { text: notice }).catch(() => {});
    }
    const recent = antipvBlockedAt.get(warnKey);
    if (!recent || Date.now() - recent > 60 * 1000) {
        const targets = collectPvBlockTargets(from, ctx, conn);
        let ok = 0;
        for (const jid of targets) {
            try {
                if (await blockPvJid(conn, jid)) ok += 1;
            } catch (e) {
                logger.logAviso(`[ANTIPV] wa-block: ${e.message}`);
            }
        }
        if (ok > 0) antipvBlockedAt.set(warnKey, Date.now());
        logger.logAviso(`[ANTIPV] wa-block ok=${ok}/${targets.length}`);
    }
    return { handled: true, reason: mode };
}

/**
 * PV: payload de crash/trava. Dono passa. Sem isso o handler chama
 * processPrivateAttackGuard e quebra (nao era exportada).
 */
async function processPrivateAttackGuard(conn, ctx, telegramUserId, info) {
    if (!ctx || ctx.isChannel) return null;
    if (!isPrivatePersonChat(ctx)) return null;
    try {
        const { isFreshSessionOwner } = require('./authorization');
        if (isFreshSessionOwner(ctx)) return null;
    } catch (_) {
        if (ctx.isOwner) return null;
    }
    const message = info || ctx.info || ctx.msg || ctx;
    const sig = detectAttackSignature(message);
    if (!sig || !sig.hit) return null;
    const from = ensureJidString(ctx.from || message?.key?.remoteJid, '');
    logger.logAviso(`[ANTIATAQUE-PV] ${sig.reason} from=${from}`);
    return { handled: true, reason: 'antiatk-pv', attack: sig.reason };
}

/** Anti-call: bloqueia quem ligar (evento call Baileys) */
async function processAntiCall(conn, callPayload, telegramUserId) {
    const flags = getOwnerSecurity(telegramUserId);
    if (!flags.anticall) return;
    const calls = Array.isArray(callPayload) ? callPayload : [callPayload];
    for (const call of calls) {
        if (!call) continue;
        const status = String(call.status || '').toLowerCase();
        if (status && status !== 'offer' && status !== 'ringing') continue;
        const from = ensureJidString(call.from || call.chatId || '', '');
        if (!from) continue;
        try {
            if (typeof conn.rejectCall === 'function' && call.id) {
                await conn.rejectCall(call.id, from);
            }
        } catch (_) {}
        try {
            await conn.updateBlockStatus(from, 'block');
            logger.logAviso(`[ANTICALL] Bloqueado ${from}`);
        } catch (e) {
            logger.logAviso(`[ANTICALL] ${e.message}`);
        }
    }
}

/**
 * Anti-ataque / protecao total: ban + delete (mesma logica do antiflood).
 * Ignora fromMe (divulgacao/status legitimos do bot) e admins.
 */
async function processAntiAtaqueGuard(conn, message, telegramUserId, sessionId = null) {
    try {
        return await processAntiAtaqueGuardInner(conn, message, telegramUserId, sessionId);
    } catch (e) {
        logger.logErro(`[ANTIATAQUE] abort sem acao: ${e.message}`);
        return null;
    }
}

async function processAntiAtaqueGuardInner(conn, message, telegramUserId, sessionId = null) {
    if (!message?.key || message.key.fromMe) return null;
    const groupId = ensureJidString(message.key.remoteJid, '');
    if (!groupId.endsWith('@g.us')) return null;

    const flags = getGroupSecurity(groupId, telegramUserId);
    if (!anyAntiAtkEnabled(flags)) return null;

    const senderIds = collectMessageSenderIds(message);
    const senderId = senderIds[0] || '';
    if (!senderId) return null;
    if (isWhitelisted(groupId, telegramUserId, senderId)) return null;
    if (senderIds.slice(1).some((id) => isWhitelisted(groupId, telegramUserId, id))) return null;

    const sig = detectAttackSignature(message);
    if (!sig?.hit || !sig.flag) return null;
    if (!isAntiAtkFlagEnabled(flags, sig.flag)) return null;

    // Admin/dono isento (LID + participantAlt)
    if (await isGroupAdminOrBot(conn, groupId, senderId, senderIds.slice(1))) return null;

    // Reacao/edicao: exige flood (nao banir 1 emoji/edit)
    if (sig.reason === 'antiataque_reacao' || sig.reason === 'antiataque_edicao') {
        registerSuspiciousMessage(groupId, senderId, sig.reason);
        if (!detectTypedFlood(groupId, senderId, sig.reason, 6)) return null;
    }

    const sid = sessionId || conn?._sessionId || null;
    logger.logAviso(
        `[ANTIATAQUE] flag=${sig.flag} hit=${sig.reason} detail=${sig.detail || '-'} ` +
        `grupo=${groupId.slice(0, 22)}… sender=${String(senderId).replace(/\d(?=\d{4})/g, '*')} ` +
        `ts=${new Date().toISOString()}`
    );

    const userMessages = [message];
    try {
        if (sid) {
            const { getCache } = require('../cache');
            const messagesCache = getCache(sid);
            const allKeys = typeof messagesCache.keys === 'function' ? messagesCache.keys() : [];
            for (const key of allKeys) {
                try {
                    const msg = messagesCache.get(key);
                    if (!msg?.key?.id || msg.key.id === message.key.id) continue;
                    if (ensureJidString(msg.key.remoteJid) !== groupId) continue;
                    const msgSender = ensureJidString(
                        msg.key.participant || (msg.key.fromMe ? conn?.user?.id : null),
                        ''
                    );
                    if (sameParticipant(msgSender, senderId)) userMessages.push(msg);
                } catch (_) { /* continue */ }
            }
        }
    } catch (e) {
        logger.logAviso(`[ANTIATAQUE] cache: ${e.message}`);
    }

    const capped = shouldKickMember(sig.reason, flags, senderId)
        ? userMessages.slice(0, 40)
        : [message];
    const result = await executeModerationAction(conn, groupId, senderId, sig.reason, capped, {
        telegramUserId,
        flags,
        extraIds: senderIds
    });
    return { ...result, reason: sig.reason, attackDetail: sig.detail };
}

async function processScamInviteGuard(conn, message, telegramUserId) {
    if (!message?.key || message.key.fromMe) return null;
    const groupId = ensureJidString(message.key.remoteJid, '');
    if (!groupId.endsWith('@g.us')) return null;
    const hit = classifyScamInviteFlood(message);
    if (!hit) return null;
    const senderIds = collectMessageSenderIds(message);
    const senderId = senderIds[0] || ensureJidString(message.key.participant, '');
    if (!senderId) return null;
    if (isWhitelisted(groupId, telegramUserId, senderId)) return null;
    if (await isGroupAdminOrBot(conn, groupId, senderId, senderIds.slice(1))) return null;

    const flags = getGroupSecurity(groupId, telegramUserId);
    logger.logAviso(`[SCAM] kind=${hit.kind} reason=${hit.reason} grupo=${groupId.slice(0, 22)}`);

    const wantKick = hit.kind === 'payment' ? !!flags.antiatkpagamento : !!flags.antiatkstatus;
    if (wantKick) {
        return executeModerationAction(conn, groupId, senderId, hit.reason, [message], {
            telegramUserId,
            flags,
            kick: true,
            extraIds: senderIds
        });
    }
    await deleteInboundMessage(conn, message, senderId);
    await announceGroupProtection(conn, groupId, senderId, hit.reason, message, false);
    return { success: true, reason: hit.reason };
}

/** Pipeline unico: isento admin/dono PRIMEIRO (fail-open). Depois: lista negra → stealth → antiataque → superficies → mute → link → midia */
async function processGroupSecurityGuards(conn, message, telegramUserId, sessionId = null, opts = {}) {
    try {
        const securityExempt = await isSecurityExemptSender(conn, message, {
            isAdmin: !!opts.isAdmin,
            isOwner: !!opts.isOwner,
            senderAlt: opts.senderAlt,
            sender: opts.sender,
            extraIds: opts.extraIds,
            telegramUserId,
            ctx: opts.ctx
        });
        if (securityExempt) return null;

        const bl = await processBlacklistMessage(conn, message, telegramUserId);
        if (bl) return bl;

        const scam = await processScamInviteGuard(conn, message, telegramUserId);
        if (scam) return scam;

        const stealth = await inspectInboundStealth(conn, message, telegramUserId, sessionId, {
            sender: opts.sender,
            senderAlt: opts.senderAlt
        });
        if (stealth && stealth.success) return stealth;

        const atk = await processAntiAtaqueGuard(conn, message, telegramUserId, sessionId);
        if (atk) return atk;

        try {
            const { processSurfaceGuards } = require('./surfaceGuards');
            const groupId = ensureJidString(message.key.remoteJid, '');
            const senderIds = collectMessageSenderIds(message, [opts.senderAlt, opts.sender]);
            const surf = await processSurfaceGuards(conn, message, telegramUserId, sessionId, {
                getFlags: () => getGroupSecurity(groupId, telegramUserId),
                isAdmin: (sender) => isGroupAdminOrBot(conn, groupId, sender, senderIds),
                isWhitelisted: (sender) => isWhitelisted(groupId, telegramUserId, sender),
                deleteMsg: async (msg) => {
                    await deleteInboundMessage(conn, msg, msg?.key?.participant);
                }
            });
            if (surf?.deleted) return { success: true, reason: surf.reason, surface: surf.surface };
        } catch (e) {
            logger.logAviso(`[SURF] pipeline: ${e.message}`);
        }

        const mute = await processMuteGuard(conn, message, telegramUserId);
        if (mute) return mute;

        const link = await processGroupLinkGuard(conn, message, telegramUserId);
        if (link) return link;
        return await processContentGuards(conn, message, telegramUserId);
    } catch (e) {
        logger.logErro(`[MODERATION] pipeline abort sem acao: ${e.message}`);
        return null;
    }
}

// ---- gestao de listas (mute / negra / branca / adv) ----

function toggleListMember(groupId, telegramUserId, listName, jid, add) {
    const lists = getGroupLists(groupId, telegramUserId);
    const target = ensureJidString(jid, '');
    if (!target || !['mutes', 'blacklist', 'whitelist'].includes(listName)) {
        return { ok: false, lists };
    }
    const arr = lists[listName];
    const idx = arr.findIndex((x) => sameParticipant(x, target));
    if (add) {
        if (idx < 0) arr.push(target);
    } else if (idx >= 0) {
        arr.splice(idx, 1);
    }
    lists[listName] = arr;
    saveGroupLists(groupId, telegramUserId, lists);
    return { ok: true, lists, present: add ? true : idx >= 0 };
}

function addWarning(groupId, telegramUserId, jid) {
    const lists = getGroupLists(groupId, telegramUserId);
    const target = ensureJidString(jid, '');
    if (!target) return { count: 0, limit: lists.warnLimit, kicked: false };
    // Acumula advs LID↔telefone na mesma conta
    let prev = 0;
    for (const k of Object.keys(lists.warns || {})) {
        if (sameParticipant(k, target)) prev = Math.max(prev, Number(lists.warns[k]) || 0);
    }
    const count = prev + 1;
    lists.warns[target] = count;
    for (const k of Object.keys(lists.warns)) {
        if (k !== target && sameParticipant(k, target)) lists.warns[k] = count;
    }
    saveGroupLists(groupId, telegramUserId, lists);
    return { count, limit: lists.warnLimit, kicked: count >= lists.warnLimit };
}

function clearWarning(groupId, telegramUserId, jid) {
    const lists = getGroupLists(groupId, telegramUserId);
    const target = ensureJidString(jid, '');
    if (!target) return lists;
    delete lists.warns[target];
    // tambem limpa por match
    for (const k of Object.keys(lists.warns)) {
        if (sameParticipant(k, target)) delete lists.warns[k];
    }
    saveGroupLists(groupId, telegramUserId, lists);
    return lists;
}

function setLimitec(groupId, telegramUserId, n) {
    const lists = getGroupLists(groupId, telegramUserId);
    lists.limitec = Math.max(50, Math.min(10000, Number(n) || DEFAULT_CHAR_LIMIT));
    saveGroupLists(groupId, telegramUserId, lists);
    return lists.limitec;
}

function scrubBanTargetText(raw) {
    return String(raw || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
        .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
        .replace(/^(tel|phone|lid|pn|jid)\s*[:=]\s*/i, '')
        .trim();
}

function commandRemainder(ctx) {
    const argsJoin = Array.isArray(ctx?.args) && ctx.args.length ? ctx.args.join(' ').trim() : '';
    const stripCmd = (s) => scrubBanTargetText(s)
        .replace(/^[.\-!$/#]*[a-z0-9_]+/i, '')
        .replace(/^(all|todos|global)\b/i, '')
        .trim();
    const fromText = stripCmd(ctx?.text);
    const fromFull = stripCmd(ctx?.fullText);
    const fromArgs = scrubBanTargetText(argsJoin).replace(/^(all|todos|global)\b/i, '').trim();
    const score = (s) => String(s || '').replace(/\D/g, '').length;
    const cands = [fromArgs, fromText, fromFull].filter(Boolean);
    if (!cands.length) return '';
    cands.sort((a, b) => score(b) - score(a));
    return cands[0];
}

function jidFromDigits(digits) {
    const d = String(digits || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.length >= 16 && d.length <= 22) return `${d}@lid`;
    if (d.length >= 8 && d.length <= 15) return `${d}@s.whatsapp.net`;
    return '';
}

function parseBanTargetFromText(raw) {
    const t0 = scrubBanTargetText(raw);
    if (!t0) return null;
    const t = t0.replace(/^(all|todos|global)\b/i, '').trim();
    const { parsePhoneAndQty, peelPhoneAndRest, normalizeInternationalDigits } = require('./phoneTarget');

    const wame = t.match(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|whatsapp\.com\/send\?phone=)(\+?[\d\s().-]{8,})/i);
    if (wame) {
        const p = parsePhoneAndQty(wame[1], { defaultQty: 1, maxQty: 1 });
        if (p?.jid && isKickableJid(p.jid)) return p.jid;
    }

    const explicit = t.match(/(\d{5,}(?::\d+)?@(?:s\.whatsapp\.net|c\.us|lid))\b/i);
    if (explicit) {
        const jid = ensureJidString(explicit[1].replace(/:\d+(?=@)/, ''), '');
        if (isKickableJid(jid)) return jid;
    }

    const lidOnly = t.match(/(\d{8,})@lid\b/i);
    if (lidOnly) {
        const jid = `${lidOnly[1]}@lid`;
        if (isKickableJid(jid)) return jid;
    }

    const atNum = t.match(/@(\+?[\d\s().-]{8,})/);
    if (atNum) {
        const p = parsePhoneAndQty(atNum[1], { defaultQty: 1, maxQty: 1 });
        if (p?.jid && isKickableJid(p.jid)) return p.jid;
        const jid = jidFromDigits(atNum[1]);
        if (jid && isKickableJid(jid)) return jid;
    }

    const peeled = peelPhoneAndRest(t);
    if (peeled?.jid && isKickableJid(peeled.jid)) return peeled.jid;

    const parsed = parsePhoneAndQty(t, { defaultQty: 1, maxQty: 1 });
    if (parsed?.jid && isKickableJid(parsed.jid)) return parsed.jid;

    const allDigits = t.replace(/\D/g, '');
    if (allDigits.length >= 16 && allDigits.length <= 22) {
        const jid = `${allDigits}@lid`;
        if (isKickableJid(jid)) return jid;
    }
    if (allDigits.length >= 8 && allDigits.length <= 15) {
        const hadPlus = /^\+|00\s*\d/.test(t) || /\+\d/.test(t);
        const d = normalizeInternationalDigits(allDigits, { hadPlus, defaultCountry: 'BR' });
        const jid = jidFromDigits(d || allDigits);
        if (jid && isKickableJid(jid)) return jid;
    }

    return null;
}

function digitsLooseMatch(a, b) {
    const x = String(a || '').replace(/\D/g, '');
    const y = String(b || '').replace(/\D/g, '');
    if (x.length < 8 || x.length > 15 || y.length < 8 || y.length > 15) return false;
    return sameNationalPhone(x, y);
}

function pickParticipantJid(p, fallback) {
    const ids = [p?.id, p?.lid, p?.jid, p?.phoneNumber]
        .map((x) => ensureJidString(x, ''))
        .filter((id) => id && isKickableJid(id));
    if (!ids.length) return fallback;
    const lid = ids.find((id) => id.endsWith('@lid'));
    const pn = ids.find((id) => id.endsWith('@s.whatsapp.net') || id.endsWith('@c.us'));
    try {
        if (lid && pn) {
            const { rememberLidPhonePair } = require('../utils');
            rememberLidPhonePair(lid, pn);
        }
    } catch (_) { /* cache opcional */ }
    return lid || pn || ids[0] || fallback;
}

function findParticipantByTarget(participants, target) {
    const t = stripDeviceJid(target);
    if (!t) return '';
    const targetPhone = identityPhoneDigits(t);
    const targetLid = isLidJid(t) ? t : '';
    for (const p of participants || []) {
        const ids = [p.id, p.phoneNumber, p.jid, p.lid]
            .map((x) => stripDeviceJid(x))
            .filter(Boolean);
        const hit = ids.some((id) => {
            if (id === t) return true;
            if (targetLid && isLidJid(id) && id === targetLid) return true;
            const pPhone = identityPhoneDigits(id);
            if (targetPhone && pPhone && sameNationalPhone(targetPhone, pPhone)) return true;
            return false;
        });
        if (hit) return pickParticipantJid(p, t);
    }
    return '';
}

async function matchParticipantJid(conn, groupId, jid) {
    const target = ensureJidString(jid, '');
    if (!target) return target;
    try {
        const { peekGroupMetadata, peekAllGroupMetas, getCachedGroupMetadata } = require('./groupMetaCache');
        const gid = ensureJidString(groupId, '');
        if (gid.endsWith('@g.us')) {
            let meta = peekGroupMetadata(gid);
            if (!meta && conn) {
                try { meta = await getCachedGroupMetadata(conn, gid); } catch (_) { meta = null; }
            }
            const local = findParticipantByTarget(meta?.participants, target);
            if (local) return local;
        }
        for (const meta of peekAllGroupMetas() || []) {
            const found = findParticipantByTarget(meta?.participants, target);
            if (found) return found;
        }
    } catch (_) { /* meta opcional */ }
    return target;
}

async function enrichTargetJid(conn, jid, groupId, uid, opts = {}) {
    const s0 = stripDeviceJid(jid);
    if (!s0 || !isKickableJid(s0)) return s0;
    let s = s0;
    const waMsRaw = opts && opts.waResolveMs;
    const waMs = waMsRaw === 0 || waMsRaw === '0' ? 0 : Number(waMsRaw);
    const doWa = Number.isFinite(waMs) ? waMs > 0 : true;
    const waTimeout = doWa ? (Number.isFinite(waMs) ? waMs : 4000) : 0;
    try {
        const { getLidForPhone, getPhoneForLid, rememberLidPhonePair } = require('../utils');
        const { resolveWhatsAppJid } = require('./phoneTarget');
        const digits = identityPhoneDigits(s) || (!isLidJid(s) ? s.split('@')[0].replace(/\D/g, '') : '');
        if (doWa && !s.endsWith('@lid') && digits) {
            try {
                const found = await Promise.race([
                    resolveWhatsAppJid(conn, { digits, jid: s }),
                    new Promise((resolve) => setTimeout(() => resolve(null), waTimeout))
                ]);
                const resolved = stripDeviceJid(found);
                if (resolved && isKickableJid(resolved)) {
                    if (!(isSessionSelfIdentity(conn, resolved) && !isSessionSelfIdentity(conn, s0))) {
                        s = resolved;
                        if (s.endsWith('@lid') && digits) rememberLidPhonePair(s, `${digits}@s.whatsapp.net`);
                    }
                }
            } catch (_) { /* sessao instavel: fica no PN */ }
        }
        if (s.endsWith('@lid')) {
            const pn = getPhoneForLid(s);
            if (pn) rememberLidPhonePair(s, pn);
        } else if (digits) {
            const lid = getLidForPhone(digits);
            if (lid && isKickableJid(lid)) {
                const lidS = stripDeviceJid(lid);
                if (!(isSessionSelfIdentity(conn, lidS) && !isSessionSelfIdentity(conn, s0))) {
                    rememberLidPhonePair(lidS, s);
                    s = lidS;
                }
            }
        }
        const matched = await matchParticipantJid(conn, groupId, s);
        if (matched && isSessionSelfIdentity(conn, matched) && !isSessionSelfIdentity(conn, s0)) {
            return s0;
        }
        s = matched || s;
    } catch (_) { /* mapping opcional */ }
    if (isSessionSelfIdentity(conn, s) && !isSessionSelfIdentity(conn, s0)) return s0;
    return s;
}

function unwrapInboundMessage(raw) {
    let msg = raw;
    if (!msg || typeof msg !== 'object') return msg;
    for (let i = 0; i < 6; i++) {
        if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
        else if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
        else if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
        else if (msg.viewOnceMessageV2Extension?.message) msg = msg.viewOnceMessageV2Extension.message;
        else if (msg.documentWithCaptionMessage?.message) msg = msg.documentWithCaptionMessage.message;
        else if (msg.editedMessage?.message) msg = msg.editedMessage.message;
        else break;
    }
    return msg;
}

function inboundContextInfo(ctx) {
    const raw = ctx?.message || ctx?.info?.message || ctx?.raw?.message || {};
    const msg = unwrapInboundMessage(raw) || raw;
    return msg.extendedTextMessage?.contextInfo
        || msg.imageMessage?.contextInfo
        || msg.videoMessage?.contextInfo
        || msg.documentMessage?.contextInfo
        || msg.audioMessage?.contextInfo
        || msg.stickerMessage?.contextInfo
        || msg.buttonsResponseMessage?.contextInfo
        || msg.listResponseMessage?.contextInfo
        || msg.templateButtonReplyMessage?.contextInfo
        || msg.interactiveResponseMessage?.contextInfo
        || msg.buttonsMessage?.contextInfo
        || msg.interactiveMessage?.contextInfo
        || msg.contextInfo
        || {};
}

/** Quem digitou o comando + o bot da sessao. Nunca e alvo de banall. */
function collectCommanderIds(ctx, conn) {
    const out = [];
    const seen = new Set();
    const push = (v) => {
        const s = stripDeviceJid(v);
        if (!s || seen.has(s)) return;
        seen.add(s);
        out.push(s);
    };
    const key = ctx?.info?.key || ctx?.key || ctx?.raw?.key || {};
    push(ctx?.sender);
    push(ctx?.senderAlt);
    push(key.participant);
    push(key.participantPn);
    push(key.participantAlt);
    push(key.senderPn);
    push(key.remoteJidAlt);
    if (!String(ctx?.from || key.remoteJid || '').endsWith('@g.us')) {
        push(ctx?.from);
        push(key.remoteJid);
    }
    push(conn?.user?.id);
    push(conn?.user?.lid);
    return out;
}

function isCommanderOrBotJid(jid, commanderIds) {
    const s = stripDeviceJid(jid);
    if (!s || !isKickableJid(s)) return true;
    return (commanderIds || []).some((id) => identitiesEqualStrict(s, id));
}

function pickExplicitBanTarget(ctx, conn) {
    const skipIds = collectCommanderIds(ctx, conn);
    const skip = (jid) => isCommanderOrBotJid(jid, skipIds);
    const mentions = collectMentionIds(ctx)
        .map((j) => stripDeviceJid(j))
        .filter((j) => j && !skip(j));
    const quoted = collectQuotedTargetIds(ctx)
        .map((j) => stripDeviceJid(j))
        .filter((j) => j && !skip(j));
    const fromText = parseBanTargetFromText(commandRemainder(ctx));
    const textOk = fromText && !skip(fromText) ? stripDeviceJid(fromText) : '';
    return { mentions, quoted, textOk, skipIds };
}

/**
 * Alvo de ban/mute: @mencao (nao quem digitou), reply (PN/Alt/LID do quoted), numero no texto.
 */
async function resolveTargetJid(ctx, conn) {
    const uid = ctx?.telegramUserId;
    const groupId = ctx?.from || ctx?.chat || ctx?.info?.key?.remoteJid || '';
    const { mentions, quoted, textOk } = pickExplicitBanTarget(ctx, conn);
    const raw = mentions[0] || quoted[0] || textOk || '';
    if (!raw) return '';
    const jid = await enrichTargetJid(conn, raw, groupId, uid);
    const resolved = jid || raw;
    try {
        const { checkTargetAction, actorRoleFromCtx } = require('./permissionEngine');
        const actor = actorRoleFromCtx(ctx);
        if (actor !== 'platform_admin') {
            const { matchesAuthorizedEntry, resolveCanonicalIdentity } = require('./authorization');
            const ids = resolveCanonicalIdentity(ctx?.sender, ctx) || [];
            const self = ids.some((id) => matchesAuthorizedEntry(id, resolved))
                || matchesAuthorizedEntry(ctx?.sender, resolved);
            if (!self) {
                const r = checkTargetAction(conn, ctx, resolved);
                if (!r.allowed) {
                    if (ctx) ctx._hanorkTargetImmune = true;
                    return '';
                }
            }
        }
    } catch (_) { /* imunidade opcional */ }
    return resolved;
}

/**
 * BANALL: se o enrich cair no dono/bot mas mencao/reply/texto aponta outro, fica o outro.
 */
async function resolveBanAllTarget(ctx, conn) {
    const uid = ctx?.telegramUserId;
    const groupId = ctx?.from || ctx?.chat || ctx?.info?.key?.remoteJid || '';
    const { mentions, quoted, textOk, skipIds } = pickExplicitBanTarget(ctx, conn);
    const skip = (jid) => isCommanderOrBotJid(jid, skipIds) || isSessionSelfIdentity(conn, jid);
    let raw = '';
    if (textOk && (textOk.endsWith('@s.whatsapp.net') || textOk.endsWith('@c.us'))) {
        raw = textOk;
    } else if (mentions.length) raw = mentions[0];
    else if (quoted.length) raw = quoted[0];
    else if (textOk) raw = textOk;
    if (!raw) {
        logger.logAviso(`[BANALL] sem alvo mentions=${mentions.length} quoted=${quoted.length} text=${textOk ? 1 : 0}`);
        return '';
    }
    logger.logInfo(`[BANALL] alvo mentions=${mentions.length} quoted=${quoted.length} text=${textOk ? 1 : 0} tipo=${isLidJid(raw) ? 'lid' : 'pn'}`);

    const enriched = await enrichTargetJid(conn, raw, groupId, uid, { waResolveMs: 0 });
    if (enriched && !skip(enriched)) return enriched;

    const fallbacks = [raw, ...mentions, ...quoted, textOk].filter((j) => j && !skip(j));
    if (fallbacks.length) {
        if (enriched && skip(enriched)) {
            try { logger.logAviso('[BANALL] skip-owner-false-lid'); } catch (_) { /* ignore */ }
        }
        return fallbacks[0];
    }
    return enriched || raw;
}

function collectQuotedTargetIds(ctx) {
    const cinfo = inboundContextInfo(ctx);
    const q = ctx.quoted || {};
    return [
        cinfo.participantPn,
        cinfo.participantAlt,
        q.participantPn,
        q.participantAlt,
        q.key?.participantPn,
        q.key?.participantAlt,
        cinfo.participant,
        q.participant,
        q.sender,
        q.key?.participant,
        ctx.quotedParticipant
    ];
}

function collectMentionIds(ctx) {
    const list = [];
    const seen = new Set();
    const push = (item) => {
        const s = stripDeviceJid(item);
        if (!s || seen.has(s) || !isKickableJid(s)) return;
        seen.add(s);
        list.push(s);
    };
    const raw = ctx?.message || ctx?.info?.message || ctx?.raw?.message || {};
    const msg = unwrapInboundMessage(raw) || raw;
    const infos = [
        inboundContextInfo(ctx),
        msg.extendedTextMessage?.contextInfo,
        msg.imageMessage?.contextInfo,
        msg.videoMessage?.contextInfo,
        msg.documentMessage?.contextInfo,
        msg.buttonsResponseMessage?.contextInfo,
        msg.listResponseMessage?.contextInfo,
        msg.interactiveResponseMessage?.contextInfo,
        msg.interactiveMessage?.contextInfo,
        msg.contextInfo
    ];
    for (const ci of infos) {
        if (Array.isArray(ci?.mentionedJid)) {
            for (const j of ci.mentionedJid) push(j);
        }
    }
    if (Array.isArray(ctx?.mentionedJid)) {
        for (const j of ctx.mentionedJid) push(j);
    }
    return list;
}

/** bangp: grupo banido — bot ignora tudo exceto dono */
function isGroupBanned(groupId, telegramUserId) {
    return !!getGroupSecurity(groupId, telegramUserId).bangp;
}

/** soadm: true = membro comum nao pode usar comandos do bot no grupo */
function shouldBlockNonAdminCommand(groupId, telegramUserId, isGroupAdmin, isOwner) {
    if (isOwner || isGroupAdmin) return false;
    const flags = getGroupSecurity(groupId, telegramUserId);
    return !!flags.soadm;
}

/** Chaves comparaveis LID ↔ telefone (bna/clearuser/moderacao). LID nunca vira dígito solto. */
function participantKeys(jid) {
    const keys = new Set();
    const s = ensureJidString(jid, '').replace(/:\d+(?=@)/, '');
    if (!s) return keys;
    keys.add(s);
    if (s.endsWith('@lid') || s.includes('@lid')) {
        try {
            const { getPhoneForLid } = require('../utils');
            const phone = getPhoneForLid(s);
            if (phone) {
                const d = String(phone).replace(/\D/g, '');
                if (d.length >= 10 && d.length <= 15) {
                    keys.add(d);
                    keys.add(`${d}@s.whatsapp.net`);
                }
            }
        } catch (_) { /* mapping opcional */ }
        return keys;
    }
    const norm = normalizeJid(s);
    if (norm && !String(norm).includes('@lid')) keys.add(norm);
    const userPart = s.split('@')[0];
    if (userPart) keys.add(userPart);
    try {
        const d = String(userPart || '').replace(/\D/g, '');
        if (d.length >= 8 && d.length <= 15) {
            keys.add(d);
            try {
                const { getLidForPhone } = require('../utils');
                const lid = getLidForPhone(d);
                if (lid) {
                    const lidS = String(lid);
                    keys.add(lidS);
                    if (!lidS.includes('@')) keys.add(`${lidS}@lid`);
                }
            } catch (_) { /* mapping opcional */ }
        }
    } catch (_) { /* ignore */ }
    return keys;
}

function sameParticipant(a, b) {
    const A = participantKeys(a);
    const B = participantKeys(b);
    if (!A.size || !B.size) return false;
    for (const k of A) {
        if (k && B.has(k)) return true;
    }
    return false;
}

/** So pessoa (PN/LID). Nunca grupo/canal/broadcast. */
function isKickableJid(jid) {
    const s = ensureJidString(jid, '');
    if (!s) return false;
    if (s.endsWith('@g.us') || s.endsWith('@newsletter') || s === 'status@broadcast') return false;
    return s.endsWith('@s.whatsapp.net') || s.endsWith('@lid') || s.endsWith('@c.us');
}

function describeInboundPayload(message, reason) {
    const inner = unwrapMessage(message) || message?.message || {};
    const bits = [];
    try {
        if (isPaymentMessage(message)) bits.push('bolha de pagamento/PIX');
    } catch (_) { /* */ }
    try {
        if (isAdminVisibleOnlyStatus(message) || isGroupStatusLike(message)) bits.push('status no grupo (so admin ve)');
    } catch (_) { /* */ }
    if (inner.imageMessage) bits.push('imagem');
    if (inner.videoMessage) bits.push('video');
    if (inner.stickerMessage) bits.push('figurinha');
    if (inner.audioMessage) bits.push('audio');
    if (inner.documentMessage) bits.push('documento');
    if (inner.contactMessage || inner.contactsArrayMessage) bits.push('contato');
    if (inner.locationMessage || inner.liveLocationMessage) bits.push('localizacao');
    if (inner.viewOnceMessage || inner.viewOnceMessageV2 || message?.message?.viewOnceMessage) bits.push('view-once');
    if (inner.groupStatusMessage || inner.groupStatusMessageV2 || inner.groupStatusMentionMessage) bits.push('status no grupo');
    const text = String(getMessageText(inner) || getMessageText(message) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
    if (text) bits.push(`texto: "${text}"`);
    if (!bits.length) bits.push(String(reason || 'conteudo bloqueado'));
    return bits.join(' · ');
}

const PROT_REASON_LABEL = {
    antilink: 'Anti-link',
    antilink_easy: 'Anti-link',
    antilink_gp: 'Anti-link de grupo',
    antilink_hard: 'Anti-link HARD',
    antilinkhard: 'Anti-link HARD',
    antifake: 'Anti-fake (DDI)',
    antipayment: 'Anti-pagamento',
    stealth_payment: 'Anti-pagamento',
    surf_payment: 'Anti-pay',
    stealth_status: 'Anti-status no grupo',
    surf_group_status: 'Anti-status no grupo',
    antistatus: 'Anti-status',
    antipalavrao: 'Anti-palavrao',
    antichannel: 'Anti-canal',
    anticatalogo: 'Anti-catalogo',
    antiporno: 'Anti-porno',
    antiporno_ban: 'Anti-porno',
    listanegra: 'Lista negra',
    antiataque_pagamento: 'Anti-ataque pagamento',
    antiataque_status_grupo: 'Anti-ataque status',
    scam_pay_invite: 'PIX/divulgacao com convite',
    scam_status_invite: 'Status invisivel com convite'
};

async function announceGroupProtection(conn, groupId, senderId, reason, message, banned) {
    const gid = ensureJidString(groupId, '');
    const sid = ensureJidString(senderId, '');
    if (!conn || !gid.endsWith('@g.us') || !sid) return;
    const label = PROT_REASON_LABEL[reason] || String(reason || 'protecao');
    const what = describeInboundPayload(message, reason);
    const tag = `@${sid.split('@')[0]}`;
    const text = banned
        ? `Removido ${tag}\nMotivo: ${label}\nMandou: ${what}`
        : `Apaguei msg de ${tag}\nMotivo: ${label}\nMandou: ${what}`;
    await conn.sendMessage(gid, { text, mentions: [sid] }).catch(() => {});
}

/**
 * Kick so com flag EXPLICITA do vetor. Antilink off nao remove ninguem.
 * antiataque master NAO basta pra expulsar (evita ban aleatorio).
 */
function shouldKickMember(reason, flags, senderId) {
    if (!isKickableJid(senderId)) {
        logger.logAviso(`[KICK] recusado jid=${String(senderId || '').slice(0, 48)} reason=${reason}`);
        return false;
    }
    const r = String(reason || '');
    const f = flags || {};
    if (r === 'antilink_hard' || r === 'antilinkhard') return !!f.antilinkHard;
    if (r === 'listanegra' || r === 'listanegra_join' || r === 'antifake') return true;
    if (r === 'antiporno_ban') return !!f.antiporno;
    if (r === 'adv_kick') return true;
    if (r === 'stealth_payment' || r === 'antipayment' || r === 'surf_payment' || r === 'scam_pay_invite') {
        return !!(f.antipayment || f.antiatkpagamento || f.surfPayment);
    }
    if (r === 'stealth_status' || r === 'surf_group_status' || r === 'antistatus' || r === 'scam_status_invite') {
        return !!f.antiatkstatus;
    }
    if (r.startsWith('antiataque_')) {
        const flag = attackFlagForReason(r);
        if (!flag || !f[flag]) {
            logger.logAviso(`[KICK] recusado flag=${flag || '?'} off reason=${r}`);
            return false;
        }
        return true;
    }
    // antiflood/modenable: nunca expulsa (so os toggles antiatk/hard)
    if (r === 'invisible_message' || r === 'status_message' || r === 'payment_flood') {
        logger.logAviso(`[KICK] recusado flood-generico reason=${r} (liga antiatk* pra ban)`);
        return false;
    }
    logger.logAviso(
        `[KICK] recusado reason nao mapeado ${r}`
    );
    return false;
}

async function kickIfAllowed(conn, groupId, senderId, reason, flags, extraIds = []) {
    const gid = ensureJidString(groupId, '');
    const sid = ensureJidString(senderId, '');
    if (!shouldKickMember(reason, flags || {}, sid)) return false;
    const tryIds = [];
    const seen = new Set();
    const extra = Array.isArray(extraIds) ? extraIds : extraIds ? [extraIds] : [];
    for (const raw of [sid, ...identitiesForBlacklist(sid), ...extra]) {
        const kid = ensureJidString(raw, '');
        if (!isKickableJid(kid) || seen.has(kid)) continue;
        seen.add(kid);
        tryIds.push(kid);
    }
    const tid = conn?._telegramUserId || '';
    if (tryIds.some((id) => isOwnerOrBotTarget(conn, tid, id))) {
        logger.logAviso(`[KICK] recusado dono/chip reason=${reason}`);
        return false;
    }
    if (await isGroupAdminOrBot(conn, gid, sid, tryIds)) {
        logger.logAviso(`[KICK] recusado admin/bot reason=${reason}`);
        return false;
    }
    let lastErr = '';
    for (const kid of tryIds) {
        try {
            await conn.groupParticipantsUpdate(gid, [kid], 'remove');
            logger.logInfo(`[KICK] removido ${kid} de ${gid} reason=${reason}`);
            return true;
        } catch (e) {
            lastErr = e.message || String(e);
        }
    }
    logger.logAviso(`[KICK] falhou reason=${reason}: ${lastErr}`);
    return false;
}

async function executeModerationAction(conn, groupId, senderId, reason, messages = [], extra = {}) {
    const gid = ensureJidString(groupId, '');
    const sid = ensureJidString(senderId, '');
    const telegramUserId = extra.telegramUserId ?? conn?._telegramUserId ?? null;
    const flags = extra.flags || getGroupSecurity(gid, telegramUserId);
    const extraIds = extra.extraIds || extra.senderIds || [];
    if (telegramUserId && isOwnerOrBotTarget(conn, telegramUserId, sid)) {
        logger.logInfo(`[MODERATION] skip acao ${reason} — dono da sessao`);
        return null;
    }
    if (await isGroupAdminOrBot(conn, gid, sid, extraIds)) {
        logger.logInfo(`[MODERATION] skip acao ${reason} — admin/bot/sem remetente`);
        return null;
    }

    const doKick = extra.kick !== false && shouldKickMember(reason, flags, sid);

    logger.logAviso(
        `[MODERATION] acao reason=${reason} kick=${doKick ? 'SIM' : 'nao'} ` +
        `grupo=${gid} user=${sid}`
    );

    try {
        if (doKick) {
            await kickIfAllowed(conn, gid, sid, reason, flags);
        }

        let deletedCount = 0;
        if (messages.length > 0) {
            const BATCH_SIZE = 3;
            for (let i = 0; i < messages.length; i += BATCH_SIZE) {
                const batch = messages.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(
                    batch.map((msg) => {
                        return deleteInboundMessage(
                            conn,
                            msg,
                            ensureJidString(msg?.key?.participant, sid)
                        );
                    })
                );
                deletedCount += results.filter((r) => r.success).length;
                if (i + BATCH_SIZE < messages.length) {
                    await new Promise((resolve) => setTimeout(resolve, 800));
                }
            }
            logger.logInfo(`[MODERATION] ${deletedCount}/${messages.length} msgs apagadas (${sid})`);
        }

        if (doKick) clearSuspicion(gid, sid);
        await announceGroupProtection(conn, gid, sid, reason, messages[0] || extra.message, doKick);
        return { success: true, banned: doKick, deleted: deletedCount, reason };
    } catch (e) {
        logger.logErro(`[MODERATION] Erro ao executar ação: ${e.message}`);
        return { success: false, error: e.message, reason };
    }
}

/**
 * Processa mensagem para detecção de abuso.
 * Retorna resultado da ação se moderou; null se ignorou.
 */
async function processMessageForModeration(conn, message, sessionId, telegramUserId) {
    if (!message || !message.key) return null;

    const groupId = ensureJidString(message.key.remoteJid, '');
    if (!groupId.endsWith('@g.us')) return null;
    if (!isModerationActive(groupId, telegramUserId)) return null;
    if (message.key.fromMe) return null;

    // Precedência: participant / Alt. Nunca o JID do grupo.
    const senderIds = collectMessageSenderIds(message);
    const senderId = senderIds[0] || '';
    if (!senderId || !isKickableJid(senderId)) return null;

    // Não moderar admin, dono nem bot (cache + fail-open se meta cair; LID+Alt)
    if (telegramUserId && senderIds.some((id) => isOwnerOrBotTarget(conn, telegramUserId, id))) {
        return null;
    }
    if (await isGroupAdminOrBot(conn, groupId, senderId, senderIds.slice(1))) return null;

    let detectedReason = null;

    // viewOnce / status: so age em flood (1 visu unica ou 1 edit nao e ataque)
    if (isInvisibleMessage(message)) {
        registerSuspiciousMessage(groupId, senderId, 'invisible_message');
        if (detectTypedFlood(groupId, senderId, 'invisible_message', 4)) {
            detectedReason = 'invisible_message';
            logger.logAviso(`[MODERATION] Flood invisivel - Grupo: ${groupId}, Usuário: ${senderId}`);
        }
    } else if (isStatusMessage(message)) {
        registerSuspiciousMessage(groupId, senderId, 'status_message');
        if (detectTypedFlood(groupId, senderId, 'status_message', 3)) {
            detectedReason = 'status_message';
            logger.logAviso(`[MODERATION] Flood status/protocolo - Grupo: ${groupId}, Usuário: ${senderId}`);
        }
    } else if (isPaymentMessage(message)) {
        registerSuspiciousMessage(groupId, senderId, 'payment');
        if (detectPaymentFlood(groupId, senderId)) {
            detectedReason = 'payment_flood';
            logger.logAviso(`[MODERATION] Flood de pagamento nativo - Grupo: ${groupId}`);
        }
    }

    if (!detectedReason) return null;

    const userMessages = [message];
    try {
        const messagesCache = getCache(sessionId);
        const allKeys = typeof messagesCache.keys === 'function' ? messagesCache.keys() : [];
        for (const key of allKeys) {
            try {
                const msg = messagesCache.get(key);
                if (!msg?.key?.id || msg.key.id === message.key.id) continue;
                if (ensureJidString(msg.key.remoteJid) !== groupId) continue;
                const msgSender = ensureJidString(
                    msg.key.participant || (msg.key.fromMe ? conn?.user?.id : null),
                    ''
                );
                if (sameParticipant(msgSender, senderId)) userMessages.push(msg);
            } catch (_) { /* continue */ }
        }
    } catch (e) {
        logger.logErro(`[MODERATION] Erro ao buscar mensagens do usuário: ${e.message}`);
    }

    // Limita volume de deletes por ação
    const capped = userMessages.slice(0, 40);
    return await executeModerationAction(conn, groupId, senderId, detectedReason, capped, {
        telegramUserId,
        kick: false,
        extraIds: senderIds
    });
}

module.exports = {
    isStatusMessage,
    isPaymentMessage,
    isStealthPayOrStatusEnvelope,
    inspectInboundStealth,
    unwrapMessage,
    hasNativePaymentPayload,
    isDivulgacaoPaymentPayload,
    isInvisibleMessage,
    isAdminVisibleOnlyStatus,
    classifyScamInviteFlood,
    detectAttackSignature,
    detectPaymentFlood,
    registerSuspiciousMessage,
    isModerationActive,
    enableModeration,
    disableModeration,
    getGroupSecurity,
    setGroupSecurityFlag,
    getGroupLists,
    getGlobalBlacklist,
    addGlobalBlacklisted,
    removeGlobalBlacklisted,
    isGloballyBlacklisted,
    banFromAllParticipatingGroups,
    prefetchParticipatingGroups,
    isOwnerOrBotTarget,
    isSessionSelfIdentity,
    ATTACK_TOGGLE_KEYS,
    ATTACK_TOGGLE_LABELS,
    attackFlagForReason,
    isAntiAtkFlagEnabled,
    anyAntiAtkEnabled,
    formatAntiAtkStatus,
    formatGroupSecurityStatus,
    formatGroupSecurityHelp,
    getOwnerSecurity,
    setOwnerSecurityFlag,
    setAntipvAll,
    formatOwnerSecurityStatus,
    trackGroupMessage,
    flushMsgCounts,
    getMsgCounts,
    listGhostCandidates,
    processPrivateSecurity,
    processPrivateAttackGuard,
    hasInboundPvUserBody,
    isLivePvNotify,
    pvAntiWouldBlock,
    isPrivatePersonChat,
    isPvAntiExempt,
    processAntiCall,
    resolveHanorkApiCreds,
    getAntipornoHealth,
    processGroupLinkGuard,
    processGroupSecurityGuards,
    processAntiAtaqueGuard,
    processContentGuards,
    processMuteGuard,
    processBlacklistMessage,
    processBlacklistJoin,
    processAntifakeJoin,
    processAntifakeMessage,
    resolveMemberPhoneDigits,
    processWelcomeLeave,
    setWelcomeText,
    shouldBlockNonAdminCommand,
    isGroupBanned,
    isGroupAdminOrBot,
    isGroupAdminStrict,
    logModFailOnce,
    isSecurityExemptSender,
    getFailOpenStats,
    collectMessageSenderIds,
    participantIdentityIds,
    executeModerationAction,
    shouldKickMember,
    isKickableJid,
    kickIfAllowed,
    processMessageForModeration,
    toggleListMember,
    addWarning,
    clearWarning,
    setLimitec,
    resolveTargetJid,
    resolveBanAllTarget,
    expandBanTargetIds,
    cacheMessageMatchesTarget,
    sameParticipant,
    identitiesEqualStrict,
    participantKeys,
    DEFAULT_GROUP_FLAGS,
    DEFAULT_OWNER_SECURITY,
    deleteMessageAsAdmin,
    deleteMessageWithFakeTechnique,
    deleteMessageSmart,
    deleteGroupStatusAsAdmin,
    deleteInboundMessage,
    isGroupStatusLike,
    FLOOD_THRESHOLD,
    FLOOD_TIME_WINDOW
};
