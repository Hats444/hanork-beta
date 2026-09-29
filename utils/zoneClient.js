'use strict';
// Cliente HTTP das APIs Zone / SystemZone / publicas. Sem logar chave, PII ou URL com token.

const axios = require('axios');
const logger = require('../logger');

const DEFAULT_TIMEOUT = 20000;

function zoneBase() {
    return String(process.env.ZONE_API_BASE || 'https://zone.api.br').replace(/\/$/, '');
}
function zoneKey() {
    return String(process.env.ZONE_API_KEY || '').trim();
}
function szBase() {
    return String(process.env.SYSTEMZONE_API_BASE || 'https://systemzone.store').replace(/\/$/, '');
}
function szKey() {
    return String(process.env.SYSTEMZONE_API_KEY || process.env.ZONE_API_KEY || '').trim();
}
function nyxToken() {
    return String(process.env.NYX_FF_TOKEN || '').trim();
}

function missingKeyText(name) {
    return `Configure ${name} no .env da host pra usar este comando.`;
}

function pickImageUrl(data) {
    if (!data) return '';
    if (typeof data === 'string' && /^https?:\/\//i.test(data)) return data;
    if (typeof data !== 'object') return '';
    const cands = [
        data.resultado?.url,
        data.resultado?.image,
        data.resultado?.download,
        data.result?.url,
        data.result?.image,
        data.result?.download,
        data.result?.resultado,
        typeof data.resultado === 'string' ? data.resultado : '',
        typeof data.result === 'string' ? data.result : '',
        data.url,
        data.image,
        data.download
    ];
    for (const u of cands) {
        const s = String(u || '').trim();
        if (/^https?:\/\//i.test(s)) return s;
    }
    return '';
}

function pickText(data) {
    if (data == null) return '';
    if (typeof data === 'string') return data.trim();
    const cands = [
        data.resultado?.text,
        data.resultado?.resposta,
        data.resultado?.fato,
        data.result?.text,
        data.result?.resposta,
        typeof data.resultado === 'string' ? data.resultado : '',
        typeof data.result === 'string' ? data.result : '',
        data.resposta,
        data.text,
        data.fato,
        data.message
    ];
    for (const t of cands) {
        const s = String(t || '').trim();
        if (s && s !== '[object Object]') return s;
    }
    return '';
}

async function httpGet(url, { params, timeout = DEFAULT_TIMEOUT, headers } = {}) {
    const res = await axios.get(url, {
        params,
        timeout,
        headers,
        validateStatus: () => true,
        maxRedirects: 3,
        responseType: 'json'
    });
    return res;
}

async function httpGetBuffer(url, { timeout = DEFAULT_TIMEOUT } = {}) {
    const res = await axios.get(url, {
        timeout,
        responseType: 'arraybuffer',
        validateStatus: () => true,
        maxRedirects: 3
    });
    if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
    }
    return Buffer.from(res.data);
}

async function httpPostForm(url, fields, files, { timeout = 45000, headers } = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields || {})) {
        if (v == null) continue;
        form.append(k, String(v));
    }
    for (const f of files || []) {
        if (!f || !f.buffer) continue;
        const blob = new Blob([f.buffer], { type: f.type || 'application/octet-stream' });
        form.append(f.field || 'file', blob, f.filename || 'file.bin');
    }
    const res = await axios.post(url, form, {
        timeout,
        headers: { ...(headers || {}) },
        validateStatus: () => true,
        maxRedirects: 3
    });
    return res;
}

function quotedPayload(ctx) {
    const q =
        ctx?.quoted?.message ||
        ctx?.info?.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
        null;
    if (q) return q;
    const msg = ctx?.info?.message;
    if (msg && (msg.imageMessage || msg.videoMessage || msg.audioMessage || msg.stickerMessage || msg.documentMessage)) {
        return msg;
    }
    return null;
}

async function downloadQuotedMedia(ctx, kinds = ['image', 'video', 'audio', 'sticker', 'document']) {
    const quoted = quotedPayload(ctx);
    if (!quoted || typeof quoted !== 'object') return null;
    const want = new Set(kinds);
    const node =
        (want.has('image') && (quoted.imageMessage || quoted.viewOnceMessageV2?.message?.imageMessage)) ||
        (want.has('video') && (quoted.videoMessage || quoted.viewOnceMessageV2?.message?.videoMessage)) ||
        (want.has('audio') && quoted.audioMessage) ||
        (want.has('sticker') && quoted.stickerMessage) ||
        (want.has('document') && quoted.documentMessage) ||
        null;
    if (!node) return null;
    try {
        const { downloadMediaMessage } = require('@systemzero/baileys');
        const buf = await downloadMediaMessage({ message: quoted }, 'buffer', {}, {});
        if (!buf || !buf.length) return null;
        return { buffer: Buffer.from(buf), node };
    } catch (e) {
        logger.logAviso(`[ZONE] download midia: ${e.message}`);
        return null;
    }
}

async function replyText(conn, ctx, text) {
    if (ctx && ctx.replyPv) return replyToCommander(conn, ctx, text);
    return conn.sendMessage(ctx.from, { text: String(text || '').slice(0, 4000) }, { quoted: ctx.info });
}

function commanderPvJid(conn, ctx) {
    const { resolvePeerJid, getPhoneForLid, ensureJidString, rememberLidPhonePair } = require('../utils');
    const key = ctx.info?.key || {};
    const cands = [
        ctx.senderAlt,
        ctx.senderPn,
        key.participantPn,
        key.participantAlt,
        key.senderPn,
        key.remoteJidAlt,
        ctx.isGroup ? '' : ctx.from,
        ctx.sender,
        key.participant
    ];
    for (const c of cands) {
        const s = ensureJidString(c, '');
        if (s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us')) {
            const lid = String(ctx.sender || key.participant || '');
            if (lid.includes('@lid')) {
                try { rememberLidPhonePair(lid, s); } catch (_) { /* cache */ }
            }
            return s;
        }
    }
    let dm = resolvePeerJid(ctx.sender || key.participant, key, conn) || '';
    if (String(dm).includes('@lid')) {
        const pn = getPhoneForLid(dm);
        const d = String(pn || '').replace(/\D/g, '');
        if (d.length >= 10) dm = `${d}@s.whatsapp.net`;
    }
    if (String(dm).includes('@lid')) {
        logger.logAviso('[consulta] dest ainda lid (sem PN no cache)');
    }
    return dm || ctx.sender || '';
}

async function sendConsultaBody(conn, jid, content, quoted) {
    const { sendAsChannel } = require('./channelForward');
    return sendAsChannel(conn, jid, content, quoted ? { quoted } : {});
}

async function replyToCommander(conn, ctx, text) {
    const body = String(text || '').slice(0, 4000);
    const content = { text: body };
    if (!ctx.isGroup) {
        return sendConsultaBody(conn, ctx.from, content, ctx.info);
    }
    const dm = commanderPvJid(conn, ctx);
    try {
        await sendConsultaBody(conn, dm, content);
        try {
            await conn.sendMessage(ctx.from, { text: 'Enviei no PV.' }, {
                quoted: ctx.info, skipForward: true, _hanorkTrusted: true
            });
        } catch (_) { /* grupo opcional */ }
    } catch (e) {
        logger.logAviso(`[consulta] pv: ${e.message}`);
        await sendConsultaBody(conn, ctx.from, content, ctx.info);
    }
}

async function replyImage(conn, ctx, urlOrBuf, caption) {
    const payload = Buffer.isBuffer(urlOrBuf)
        ? { image: urlOrBuf, caption: caption || undefined }
        : { image: { url: urlOrBuf }, caption: caption || undefined };
    if (ctx && ctx.replyPv && ctx.isGroup) {
        const dm = commanderPvJid(conn, ctx);
        const opts = { skipForward: true, _hanorkTrusted: true };
        try {
            const { sendAsChannel } = require('./channelForward');
            await sendAsChannel(conn, dm, payload);
            await conn.sendMessage(ctx.from, { text: 'Enviei no PV.' }, { quoted: ctx.info, ...opts });
            return;
        } catch (e) {
            logger.logAviso(`[consulta] pv img: ${e.message}`);
        }
    }
    return conn.sendMessage(ctx.from, payload, { quoted: ctx.info });
}

function runJob(conn, ctx, tag, work) {
    setImmediate(() => {
        Promise.resolve()
            .then(work)
            .catch((e) => {
                const msg = String(e?.message || e);
                logger.logAviso(`[ZONE] ${tag}: ${msg}`);
                const friendly = /timeout|timed out|ECONN|ENOTFOUND|429|503/i.test(msg)
                    ? 'API ocupada ou fora. Tente de novo em instantes.'
                    : 'Nao deu pra concluir agora. Tente de novo.';
                return replyText(conn, ctx, friendly).catch(() => {});
            });
    });
}

function argText(ctx) {
    return String(ctx.text || (Array.isArray(ctx.args) ? ctx.args.join(' ') : '') || '').trim();
}

module.exports = {
    zoneBase,
    zoneKey,
    szBase,
    szKey,
    nyxToken,
    missingKeyText,
    pickImageUrl,
    pickText,
    httpGet,
    httpGetBuffer,
    httpPostForm,
    downloadQuotedMedia,
    replyText,
    replyToCommander,
    commanderPvJid,
    replyImage,
    runJob,
    argText
};
