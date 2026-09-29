// utils/divulgacaoReply.js
// UI de divulgacao responde NO MESMO CHAT do pedido (grupo ou PV).
// O blast (.div) continua nos grupos da lista.
'use strict';

const { ensureJidString, resolvePeerJid } = require('../utils');

function isWaGroup(jid) {
    return String(jid || '').endsWith('@g.us');
}

function isTelegram(ctx, conn) {
    return !!(conn?._isTelegramShim || ctx?.platform === 'telegram');
}

/**
 * PV do dono (PN). Grupo @g.us nao serve — addgrupo responde aqui pra o grupo nao ver o bot.
 */
function resolveOwnerPrivateJid(ctx, conn) {
    const key = ctx?.info?.key || {};
    const raws = [
        key.participantPn,
        key.senderPn,
        key.participantAlt,
        key.remoteJidAlt,
        ctx?.senderAlt,
        ctx?.sender,
        key.participant
    ];
    for (const raw of raws) {
        const s = ensureJidString(raw, '');
        if (!s || s.endsWith('@g.us') || s.endsWith('@newsletter') || s.endsWith('@broadcast')) continue;
        try {
            const r = resolvePeerJid(s, key, conn) || s;
            if (String(r).endsWith('@s.whatsapp.net') || String(r).endsWith('@c.us')) return r;
        } catch (_) {
            if (s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us')) return s;
        }
    }
    try {
        const { getOwners } = require('./configManager');
        const { matchesAuthorizedEntry } = require('./authorization');
        const owners = getOwners(ctx?.telegramUserId || conn?._telegramUserId) || [];
        const ids = raws.map((v) => ensureJidString(v, '')).filter(Boolean);
        const hit = owners.find((o) => {
            const s = String(o || '');
            if (!s.endsWith('@s.whatsapp.net') && !s.endsWith('@c.us')) return false;
            return ids.some((id) => id && matchesAuthorizedEntry(id, o));
        });
        if (hit) return String(hit);
        const anyPn = owners.find((o) => {
            const s = String(o || '');
            return s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us');
        });
        if (anyPn) return String(anyPn);
    } catch (_) { /* ignore */ }
    return '';
}

/**
 * Destino da UI = chat onde o dono pediu (menus). addgrupo desvia no proprio handler.
 */
function divulgacaoUiTarget(ctx, conn) {
    let from = ensureJidString(ctx?.from, '');
    const inGroup = !!(ctx?.isGroup || isWaGroup(from));
    if (!inGroup) {
        from = ensureJidString(ctx?.inboundJid || from, from);
    }
    return {
        jid: from,
        quoted: ctx?.info || null,
        groupJid: inGroup ? from : null,
        redirected: false
    };
}

function divulgacaoUiTargetFromChat(chatId, quoted, conn) {
    return divulgacaoUiTarget({
        from: chatId,
        isGroup: isWaGroup(chatId),
        info: quoted
    }, conn);
}

function isDivulgacaoUiButton(id) {
    const s = String(id || '');
    return /^(div_|cmd_addgrupo|cmd_removergrupo|cmd_div)/i.test(s)
        || /^menu_divulgacao\b/i.test(s)
        || /^menu_cat_divulgacao\b/i.test(s);
}

async function sendDivulgacaoButtons(conn, chatId, text, buttons, footer, quoted, ...rest) {
    const { sendButtonsWithImage } = require('../helpers');
    const t = divulgacaoUiTargetFromChat(chatId, quoted, conn);
    return sendButtonsWithImage(conn, t.jid, text, buttons, footer, t.quoted, ...rest);
}

async function sendDivulgacaoList(conn, chatId, title, sections, footer, quoted, imageSource, telegramUserId, sessionId, options) {
    const { sendInteractiveList } = require('../helpers');
    const t = divulgacaoUiTargetFromChat(chatId, quoted, conn);
    return sendInteractiveList(
        conn,
        t.jid,
        title,
        sections,
        footer,
        t.quoted,
        imageSource,
        telegramUserId,
        sessionId,
        options
    );
}

async function sendDivulgacaoMessage(conn, ctx, content, extra = {}) {
    const { formatReportBlock, stripAccents } = require('./typography');
    const t = divulgacaoUiTarget(ctx, conn);
    const rest = extra && typeof extra === 'object' ? { ...extra } : {};
    delete rest.quoted;
    const payload = content && typeof content === 'object' ? { ...content } : content;
    if (payload && typeof payload.text === 'string') {
        const lines = String(payload.text).split(/\n/);
        const head = stripAccents(lines[0] || 'DIVULGACAO').slice(0, 48);
        payload.text = formatReportBlock(head || 'DIVULGACAO', lines.slice(1));
    }
    try {
        return await conn.sendMessage(t.jid, payload, { quoted: t.quoted, _hanorkTrusted: true, ...rest });
    } catch (e) {
        if (!/forbidden|not-authorized/i.test(String(e && e.message ? e.message : e))) throw e;
        const pv = resolveOwnerPrivateJid(ctx, conn);
        if (pv && String(pv) !== String(t.jid)) {
            return conn.sendMessage(pv, payload, { _hanorkTrusted: true, ...rest });
        }
        throw e;
    }
}

function pvReplyHint() {
    return '';
}

/**
 * addgrupo: react no grupo, painel so no PV do dono.
 */
async function sendAddgrupoPrivateReply(conn, ctx, { text, buttons, imageName }) {
    const groupJid = isWaGroup(ctx?.from) ? ctx.from : null;
    if (groupJid && ctx?.info?.key) {
        try {
            await conn.sendMessage(groupJid, { react: { text: '✅', key: ctx.info.key } });
        } catch (_) { /* grupo sem react */ }
    }
    const dest = resolveOwnerPrivateJid(ctx, conn);
    if (!dest) {
        try {
            require('../logger').logAviso('[ADDGRUPO] sem dest PV — grupo so teve react');
        } catch (_) { /* ignore */ }
        return null;
    }
    try {
        const { updateConfig } = require('./divulgacao');
        if (ctx?.telegramUserId) updateConfig(ctx.telegramUserId, { lastUiJid: dest });
    } catch (_) { /* ignore */ }
    const { sendButtonsWithImage } = require('../helpers');
    return sendButtonsWithImage(
        conn,
        dest,
        text,
        buttons || [],
        'Hanork Bot',
        null,
        'menu.jpg',
        imageName || 'GRUPO',
        'Clique abaixo',
        ctx?.telegramUserId || conn?._telegramUserId || null,
        null,
        conn?._sessionId || null
    );
}

module.exports = {
    divulgacaoUiTarget,
    divulgacaoUiTargetFromChat,
    resolveOwnerPrivateJid,
    isDivulgacaoUiButton,
    sendDivulgacaoButtons,
    sendDivulgacaoList,
    sendDivulgacaoMessage,
    sendAddgrupoPrivateReply,
    pvReplyHint
};
