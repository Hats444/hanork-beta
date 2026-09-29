const logger = require("../logger");
const { downloadMediaMessage, prepareWAMessageMedia } = require("@systemzero/baileys");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { isGroup } = require("../utils");
const { getCache } = require("../cache");
const {
    sendSticker,
    stickerToImage,
    resolveStickerSource,
    pickTApplyTarget,
    mediaToStickerBuffer,
    hasFfmpeg
} = require("../services/stickerService");
const { prefixFromCtx } = require("../utils/configManager");

const commands = {};

async function getMediaBufferFromCtx(ctx) {
    if (ctx.hasMedia && typeof ctx.downloadMedia === 'function') {
        const buf = await ctx.downloadMedia();
        if (buf) return buf;
    }
    if (ctx.text && ctx.text.startsWith('http')) {
        const resp = await axios.get(ctx.text, { responseType: "arraybuffer" });
        return Buffer.from(resp.data);
    } else if (ctx.text) {
        try {
            await fs.promises.access(ctx.text, fs.constants.R_OK);
            return await fs.promises.readFile(ctx.text);
        } catch {}
    }
    return null;
}

async function downloadProto(conn, ctx, proto, kind) {
    const keyName =
        kind === 'video' ? 'videoMessage' :
        kind === 'sticker' ? 'stickerMessage' :
        'imageMessage';
    const fakeMsg = {
        key: ctx.key || {
            remoteJid: ctx.from,
            id: ctx.messageId || `sticker_${Date.now()}`,
            fromMe: false,
            participant: ctx.sender
        },
        message: { [keyName]: proto }
    };
    const opts = {};
    if (conn?.updateMediaMessage) {
        opts.reuploadRequest = conn.updateMediaMessage.bind(conn);
    }
    return downloadMediaMessage(fakeMsg, 'buffer', {}, opts);
}

function stickerFailText(e) {
    const m = String((e && e.message) || e || '');
    if (/ENOENT|ffmpeg/i.test(m)) {
        return 'Nao consegui montar a figurinha agora. Tenta de novo daqui a pouco.';
    }
    return `Erro: ${m}`.slice(0, 180);
}

function defaultPackMeta(_ctx) {
    try {
        return require('../services/stickerService').defaultStickerBrand();
    } catch (_) {
        return { packname: 'by: @hanorkbeta', author: 'dono: @hanork' };
    }
}

commands.text = {
    useCtx: true,
    description: "Envia uma mensagem de texto",
    usage: "text <texto>",
    execute: async (conn, ctx) => {
        if (!ctx.text) return conn.sendMessage(ctx.from, { text: "Digite o texto." }, { quoted: ctx.info });
        await conn.sendMessage(ctx.from, { text: ctx.text }, { quoted: ctx.info });
    }
};

commands.image = {
    useCtx: true,
    description: "Envia uma imagem (responda a imagem, URL ou caminho local)",
    usage: "image <url ou caminho> (ou responda a uma imagem)",
    execute: async (conn, ctx) => {
        const buffer = await getMediaBufferFromCtx(ctx);
        if (!buffer) {
            return conn.sendMessage(ctx.from, { text: "Forneca uma URL, caminho local ou responda a uma imagem." }, { quoted: ctx.info });
        }
        try {
            const prep = await prepareWAMessageMedia({ image: buffer }, { upload: conn.waUploadToServer });
            await conn.sendMessage(ctx.from, { image: prep.imageMessage }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro("image", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.video = {
    useCtx: true,
    description: "Envia um video (responda a video, URL ou caminho local)",
    usage: "video <url ou caminho> (ou responda a um video)",
    execute: async (conn, ctx) => {
        const buffer = await getMediaBufferFromCtx(ctx);
        if (!buffer) {
            return conn.sendMessage(ctx.from, { text: "Forneca uma URL, caminho local ou responda a um video." }, { quoted: ctx.info });
        }
        try {
            const prep = await prepareWAMessageMedia({ video: buffer }, { upload: conn.waUploadToServer });
            await conn.sendMessage(ctx.from, { video: prep.videoMessage }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro("video", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.audio = {
    useCtx: true,
    description: "Envia um audio (responda a audio, URL ou caminho local)",
    usage: "audio <url ou caminho> (ou responda a um audio)",
    execute: async (conn, ctx) => {
        const buffer = await getMediaBufferFromCtx(ctx);
        if (!buffer) {
            return conn.sendMessage(ctx.from, { text: "Forneca uma URL, caminho local ou responda a um audio." }, { quoted: ctx.info });
        }
        try {
            const prep = await prepareWAMessageMedia(
                { audio: buffer, mimetype: "audio/mpeg" },
                { upload: conn.waUploadToServer }
            );
            await conn.sendMessage(ctx.from, { audio: prep.audioMessage }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro("audio", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.document = {
    useCtx: true,
    description: "Envia um documento (responda a documento, URL ou caminho local)",
    usage: "document <url ou caminho> [nome] (ou responda a um documento)",
    execute: async (conn, ctx) => {
        const buffer = await getMediaBufferFromCtx(ctx);
        if (!buffer) {
            return conn.sendMessage(ctx.from, { text: "Forneca uma URL, caminho local ou responda a um documento." }, { quoted: ctx.info });
        }
        let filename = "documento.pdf";
        if (ctx.text && !ctx.text.startsWith("http")) {
            const parts = ctx.text.split(" ");
            if (parts.length > 1) {
                filename = parts.slice(1).join(" ");
            } else {
                filename = path.basename(parts[0]);
            }
        } else if (ctx.text && ctx.text.startsWith("http")) {
            const urlObj = new URL(ctx.text);
            filename = path.basename(urlObj.pathname) || "documento.pdf";
        }
        try {
            const prep = await prepareWAMessageMedia(
                { document: buffer, fileName: filename },
                { upload: conn.waUploadToServer }
            );
            await conn.sendMessage(ctx.from, { document: prep.documentMessage }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro("document", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

async function executeStickerCmd(conn, ctx) {
    const { packMetaFromT } = require('../utils/userStickerT');
    const meta = packMetaFromT(ctx, defaultPackMeta(ctx));
    const src = resolveStickerSource(ctx.info);

    // URL / caminho local (texto)
    if (!src.image && !src.video && ctx.text) {
        const buffer = await getMediaBufferFromCtx(ctx);
        if (!buffer) {
            return conn.sendMessage(ctx.from, {
                text: `Marque uma imagem ou video de ate 10s com ${prefixFromCtx(ctx)}${ctx.command || 's'}`
            }, { quoted: ctx.info });
        }
        try {
            await sendSticker(conn, ctx.from, buffer, ctx.info, { kind: 'image', ...meta });
        } catch (e) {
            logger.logErro('sticker', e.message);
            await conn.sendMessage(ctx.from, { text: stickerFailText(e) }, { quoted: ctx.info });
        }
        return;
    }

    if (src.image) {
        try {
            const buf = await downloadProto(conn, ctx, src.image, 'image');
            if (!buf) {
                return conn.sendMessage(ctx.from, { text: 'Falha ao baixar a imagem.' }, { quoted: ctx.info });
            }
            await sendSticker(conn, ctx.from, buf, ctx.info, { kind: 'image', ...meta });
        } catch (e) {
            logger.logErro('sticker', e.message);
            await conn.sendMessage(ctx.from, { text: stickerFailText(e) }, { quoted: ctx.info });
        }
        return;
    }

    if (src.video) {
        const secs = Number(src.video.seconds || 0);
        if (secs > 10) {
            return conn.sendMessage(ctx.from, {
                text: 'Video deve ter no maximo 10 segundos.'
            }, { quoted: ctx.info });
        }
        if (!hasFfmpeg()) {
            return conn.sendMessage(ctx.from, {
                text: 'Figurinha de video indisponivel (ffmpeg). Use imagem.'
            }, { quoted: ctx.info });
        }
        try {
            const buf = await downloadProto(conn, ctx, src.video, 'video');
            if (!buf) {
                return conn.sendMessage(ctx.from, { text: 'Falha ao baixar o video.' }, { quoted: ctx.info });
            }
            await sendSticker(conn, ctx.from, buf, ctx.info, { kind: 'video', maxSeconds: 10, ...meta });
        } catch (e) {
            logger.logErro('sticker', e.message);
            await conn.sendMessage(ctx.from, { text: stickerFailText(e) }, { quoted: ctx.info });
        }
        return;
    }

    return conn.sendMessage(ctx.from, {
        text: `Marque uma imagem ou video de ate 10s com ${prefixFromCtx(ctx)}${ctx.command || 's'}`
    }, { quoted: ctx.info });
}

commands.sticker = {
    useCtx: true,
    description: "Cria figurinha (responda imagem/video ate 10s)",
    usage: "sticker (responda imagem/video)",
    execute: executeStickerCmd
};
commands.s = commands.sticker;
commands.f = commands.sticker;
commands.fig = commands.sticker;
// .figurinha = lista/canal (commands/figurinhaCanal.js) — nao alias de sticker
commands.stiker = commands.sticker;
commands.st = commands.sticker;
commands.stk = commands.sticker;
commands.fsticker = commands.sticker;
commands.fstiker = commands.sticker;

commands.toimg = {
    useCtx: true,
    description: "Converte figurinha em imagem (responda o sticker)",
    usage: "toimg (responda sticker)",
    execute: async (conn, ctx) => {
        const src = resolveStickerSource(ctx.info);
        if (!src.sticker) {
            return conn.sendMessage(ctx.from, { text: "Responda uma figurinha." }, { quoted: ctx.info });
        }
        try {
            const buffer = await downloadProto(conn, ctx, src.sticker, 'sticker');
            const png = await stickerToImage(buffer);
            await conn.sendMessage(ctx.from, { image: png }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro("toimg", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};
commands.toimage = commands.toimg;

commands.filtroigdark = {
    useCtx: true,
    description: 'Filtro P&B dark (contraste alto, estilo Instagram). Responda uma foto.',
    usage: 'filtroigdark (responda uma imagem)',
    execute: async (conn, ctx) => {
        const src = resolveStickerSource(ctx.info);
        let buffer = null;
        try {
            if (src.image) {
                buffer = await downloadProto(conn, ctx, src.image, 'image');
            } else if (src.sticker) {
                buffer = await downloadProto(conn, ctx, src.sticker, 'sticker');
            } else {
                buffer = await getMediaBufferFromCtx(ctx);
            }
        } catch (e) {
            logger.logErro('filtroigdark', e.message);
        }
        if (!buffer) {
            return conn.sendMessage(ctx.from, {
                text: `Responda uma foto (ou figurinha) com ${prefixFromCtx(ctx)}filtroigdark`
            }, { quoted: ctx.info });
        }
        try {
            const { applyDarkBWFilter } = require('../services/darkBwFilter');
            const jpeg = await applyDarkBWFilter(buffer);
            await conn.sendMessage(ctx.from, { image: jpeg, caption: 'filtroigdark' }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro('filtroigdark', e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};
commands.filtroigdark = commands.filtroigdark;

async function sendRenamedSticker(conn, ctx, stickerNode, pack, author, asChannel) {
    const buffer = await downloadProto(conn, ctx, stickerNode, 'sticker');
    try {
        const { fromStickerNode } = require('../utils/stickerFingerprint');
        const { isBanned } = require('../utils/bannedStickers');
        const fp = fromStickerNode(stickerNode);
        if (isBanned(ctx.telegramUserId || conn._telegramUserId, fp)) {
            await conn.sendMessage(ctx.from, {
                text: 'Essa figurinha ta na lista. Nao reenvio (rename bloqueado).'
            }, { quoted: ctx.info });
            return false;
        }
    } catch (_) { /* gate opcional */ }
    const sticker = await mediaToStickerBuffer(buffer, 'sticker', { packname: pack, author });
    const content = { sticker, mimetype: 'image/webp' };
    if (asChannel && !conn?._isTelegramShim) {
        try {
            const { sendAsChannel } = require('../utils/channelForward');
            await sendAsChannel(conn, ctx.from, content, { quoted: ctx.info });
            return true;
        } catch (e) {
            logger.logAviso(`[t] canal: ${e.message}`);
        }
    }
    await conn.sendMessage(ctx.from, content, { quoted: ctx.info });
    return true;
}

async function sendTPackedSticker(conn, ctx, buffer, kind, rec) {
    const sticker = await mediaToStickerBuffer(buffer, kind, {
        packname: rec.pack,
        author: rec.author,
        maxSeconds: kind === 'video' ? 10 : undefined
    });
    const content = { sticker, mimetype: 'image/webp' };
    if (!conn?._isTelegramShim) {
        try {
            const { sendAsChannel } = require('../utils/channelForward');
            await sendAsChannel(conn, ctx.from, content, { quoted: ctx.info });
            return true;
        } catch (e) {
            logger.logAviso(`[t] canal: ${e.message}`);
        }
    }
    await conn.sendMessage(ctx.from, content, { quoted: ctx.info });
    return true;
}

commands.roubar = {
    useCtx: true,
    description: "Renomeia pack/autor da figurinha (responda sticker)",
    usage: "roubar <pack>/<autor> (responda sticker)",
    execute: async (conn, ctx) => {
        const src = resolveStickerSource(ctx.info);
        if (!src.sticker) {
            return conn.sendMessage(ctx.from, { text: "Responda uma figurinha." }, { quoted: ctx.info });
        }
        const raw = String(ctx.text || '').trim();
        if (!raw || !raw.includes('/')) {
            return conn.sendMessage(ctx.from, {
                text: `Uso: ${prefixFromCtx(ctx)}roubar pack/autor`
            }, { quoted: ctx.info });
        }
        const parts = raw.split('/');
        const pack = (parts[0] || 'Hanork').trim() || 'Hanork';
        const author = (parts.slice(1).join('/') || 'Hanork').trim() || 'Hanork';
        try {
            await sendRenamedSticker(conn, ctx, src.sticker, pack, author, false);
        } catch (e) {
            logger.logErro("roubar", e.message);
            await conn.sendMessage(ctx.from, { text: stickerFailText(e) }, { quoted: ctx.info });
        }
    }
};
commands.take = commands.roubar;
commands.rename = commands.roubar;

async function executeT(conn, ctx) {
    const { getT, setT, parsePackAuthor, formatT } = require('../utils/userStickerT');
    const p = prefixFromCtx(ctx);
    const raw = String(ctx.text || '').trim();
    const parsed = parsePackAuthor(raw, ctx.pushName || ctx.info?.pushName || '');
    if (parsed) setT(ctx, parsed.pack, parsed.author);

    const rec = getT(ctx);
    const target = pickTApplyTarget(ctx.info);
    const needT = `Salva teu T primeiro: ${p}t pack/autor\nDepois responde a fig/foto com t (ou poe t na legenda da foto)`;

    if (target && target.kind === 'sticker') {
        if (!rec) {
            return conn.sendMessage(ctx.from, { text: needT }, { quoted: ctx.info });
        }
        try {
            await sendRenamedSticker(conn, ctx, target.node, rec.pack, rec.author, true);
        } catch (e) {
            logger.logErro('t', e.message);
            await conn.sendMessage(ctx.from, { text: stickerFailText(e) }, { quoted: ctx.info });
        }
        return;
    }

    if (target && (target.kind === 'image' || target.kind === 'video')) {
        if (!rec) {
            return conn.sendMessage(ctx.from, { text: needT }, { quoted: ctx.info });
        }
        if (target.kind === 'video') {
            if (Number(target.seconds || 0) > 10) {
                return conn.sendMessage(ctx.from, {
                    text: 'Video deve ter no maximo 10 segundos.'
                }, { quoted: ctx.info });
            }
            if (!hasFfmpeg()) {
                return conn.sendMessage(ctx.from, {
                    text: 'Figurinha de video indisponivel (ffmpeg). Manda uma foto.'
                }, { quoted: ctx.info });
            }
        }
        try {
            const buf = await downloadProto(conn, ctx, target.node, target.kind);
            if (!buf) {
                return conn.sendMessage(ctx.from, {
                    text: target.kind === 'video' ? 'Falha ao baixar o video.' : 'Falha ao baixar a foto.'
                }, { quoted: ctx.info });
            }
            await sendTPackedSticker(conn, ctx, buf, target.kind, rec);
        } catch (e) {
            logger.logErro('t', e.message);
            await conn.sendMessage(ctx.from, { text: stickerFailText(e) }, { quoted: ctx.info });
        }
        return;
    }

    if (parsed) {
        return conn.sendMessage(ctx.from, {
            text: `T salvo: ${formatT(parsed)}\nFoto com t na legenda (ou responde fig/foto com t) que eu mando com teu pack e o canal.`
        }, { quoted: ctx.info });
    }

    if (rec) {
        return conn.sendMessage(ctx.from, {
            text: `Teu T: ${formatT(rec)}\nResponde fig/foto com t, ou poe t na legenda da foto.\nTrocar: ${p}t pack/autor`
        }, { quoted: ctx.info });
    }

    return conn.sendMessage(ctx.from, {
        text: `T e o teu pack/autor de figurinha.\nSalva: ${p}t pack/autor  (ou t pack/autor sem prefixo)\nUsa: responde fig/foto com t, ou manda a foto com t na legenda`
    }, { quoted: ctx.info });
}

commands.t = {
    useCtx: true,
    description: 'Aplica teu T na fig ou faz fig da foto (selo do canal). Sem prefixo tambem.',
    usage: 't  |  t pack/autor  (fig, foto ou video ate 10s)',
    execute: executeT
};
commands.sett = {
    useCtx: true,
    description: 'Salva ou aplica o T (fig, foto ou video ate 10s)',
    usage: 'sett pack/autor',
    execute: executeT
};
commands.editt = commands.sett;
commands.meut = {
    useCtx: true,
    description: 'Mostra o T salvo',
    usage: 'meut',
    execute: async (conn, ctx) => {
        const { getT, formatT } = require('../utils/userStickerT');
        const rec = getT(ctx);
        const p = prefixFromCtx(ctx);
        if (!rec) {
            return conn.sendMessage(ctx.from, {
                text: `Voce ainda nao tem T. Salva com ${p}t pack/autor`
            }, { quoted: ctx.info });
        }
        return conn.sendMessage(ctx.from, {
            text: `Teu T: ${formatT(rec)}\nResponde fig/foto com t, ou poe t na legenda da foto.`
        }, { quoted: ctx.info });
    }
};

commands.attp = {
    useCtx: true,
    description: "Figurinha de texto (Hanork API)",
    usage: "attp <texto>",
    execute: async (conn, ctx) => {
        const text = String(ctx.text || '').trim();
        if (!text) {
            return conn.sendMessage(ctx.from, { text: `Uso: ${prefixFromCtx(ctx)}attp <texto>` }, { quoted: ctx.info });
        }
        try {
            const { fetchAttp } = require('../services/downloadService');
            const buf = await fetchAttp(text, 'attp');
            const meta = defaultPackMeta(ctx);
            try {
                await sendSticker(conn, ctx.from, buf, ctx.info, { kind: 'image', ...meta });
            } catch {
                await conn.sendMessage(ctx.from, { sticker: buf }, { quoted: ctx.info });
            }
        } catch (e) {
            logger.logErro("attp", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.ususticker = {
    useCtx: true,
    description: "Figurinha com foto de perfil do alvo (marque/responda)",
    usage: "ususticker @user",
    execute: async (conn, ctx) => {
        let target =
            ctx.info?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
            ctx.quoted?.participant ||
            ctx.quoted?.sender ||
            null;
        if (!target && ctx.args?.[0]) {
            try {
                const { parsePhoneAndQty } = require('../utils/phoneTarget');
                const parsed = parsePhoneAndQty(String(ctx.args[0]), { defaultQty: 1, maxQty: 1 });
                if (parsed?.jid) target = parsed.jid;
            } catch (_) {
                const n = String(ctx.args[0]).replace(/[^0-9]/g, '');
                if (n) target = `${n}@s.whatsapp.net`;
            }
        }
        if (!target) {
            return conn.sendMessage(ctx.from, {
                text: `Marque alguem: ${prefixFromCtx(ctx)}ususticker @user`
            }, { quoted: ctx.info });
        }
        try {
            let url;
            try {
                url = await conn.profilePictureUrl(target, 'image');
            } catch {
                url = null;
            }
            if (!url) {
                return conn.sendMessage(ctx.from, { text: 'Sem foto de perfil.' }, { quoted: ctx.info });
            }
            const resp = await axios.get(url, { responseType: 'arraybuffer' });
            await sendSticker(conn, ctx.from, Buffer.from(resp.data), ctx.info, {
                kind: 'image',
                ...defaultPackMeta(ctx)
            });
        } catch (e) {
            logger.logErro('ususticker', e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};
commands.us = commands.ususticker;

commands.album = {
    useCtx: true,
    description: "Envia um album (multiplas imagens/videos por URLs)",
    usage: "album <url1,url2,...>",
    execute: async (conn, ctx) => {
        const urls = ctx.text.split(',').map(u => u.trim());
        if (urls.length < 2) {
            return conn.sendMessage(ctx.from, { text: "Minimo 2 URLs." }, { quoted: ctx.info });
        }
        const album = urls.map(url => {
            const isVideo = /\.(mp4|webm|mkv)/i.test(url);
            return isVideo ? { video: { url } } : { image: { url } };
        });
        try {
            await conn.sendMessage(ctx.from, { album }, { quoted: ctx.info });
            await conn.sendMessage(ctx.from, { text: "Album enviado." }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro("album", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.stickerpack = {
    useCtx: true,
    description: "Cria um sticker pack nativo (responda a uma imagem)",
    usage: "stickerpack <nome>|<autor> (responda uma imagem)",
    execute: async (conn, ctx) => {
        const parts = String(ctx.text || '').split('|');
        const name = parts[0]?.trim() || 'Pack Hanork';
        const author = parts[1]?.trim() || 'Hanork';
        const src = resolveStickerSource(ctx.info);
        if (!src.image && !src.video) {
            return conn.sendMessage(ctx.from, { text: "Responda uma imagem/video para criar o pack." }, { quoted: ctx.info });
        }
        try {
            const kind = src.image ? 'image' : 'video';
            const proto = src.image || src.video;
            const buffer = await downloadProto(conn, ctx, proto, kind);
            const stickerBuffer = await mediaToStickerBuffer(buffer, kind === 'video' ? 'video' : 'image', {
                packname: name,
                author
            });
            await conn.sendMessage(ctx.from, {
                cover: stickerBuffer,
                stickers: [{ data: stickerBuffer, emojis: [''] }],
                name,
                publisher: author
            }, { quoted: ctx.info });
            await conn.sendMessage(ctx.from, { text: `Sticker pack "${name}" criado.` }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro('stickerpack', e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.avatarsticker = {
    useCtx: true,
    description: "Envia uma figurinha de avatar (responda a uma imagem)",
    usage: "avatarsticker (responda uma imagem)",
    execute: async (conn, ctx) => {
        const src = resolveStickerSource(ctx.info);
        if (!src.image) {
            return conn.sendMessage(ctx.from, { text: "Responda uma imagem." }, { quoted: ctx.info });
        }
        try {
            const buffer = await downloadProto(conn, ctx, src.image, 'image');
            const stickerBuffer = await mediaToStickerBuffer(buffer, 'image', {
                packname: 'Hanork Avatars',
                author: 'Hanork'
            });
            await conn.sendMessage(ctx.from, {
                sticker: stickerBuffer,
                isAvatar: true,
                stickerPackName: 'Hanork Avatars',
                stickerAuthor: 'Hanork'
            }, { quoted: ctx.info });
            await conn.sendMessage(ctx.from, { text: "Figurinha de avatar enviada." }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro('avatarsticker', e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.groupstatus = {
    useCtx: true,
    description: "Status de grupo: texto, foto, video, foto+texto, video+texto",
    usage: "groupstatus [membros|todos] <texto> (mande ou responda midia)",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner && !ctx.isVip) {
            return conn.sendMessage(ctx.from, { text: "Apenas dono/VIP." }, { quoted: ctx.info });
        }
        if (!isGroup(ctx.from)) return conn.sendMessage(ctx.from, { text: "Apenas em grupos." }, { quoted: ctx.info });
        const { sendGroupStatusV2, captureStatusPayload, parseStatusMode, stripModeArgs, formatSendResult } = require('../utils/groupStatusV2');
        const mode = parseStatusMode(ctx.args);
        let texto = stripModeArgs(ctx.args).join(' ').trim();
        try {
            const media = await captureStatusPayload(conn, ctx);
            if (media?.error) {
                return conn.sendMessage(ctx.from, { text: "Falha ao baixar midia." }, { quoted: ctx.info });
            }
            if (!texto && media?.caption) texto = String(media.caption).trim();
            if (!media?.buffer && !texto) {
                return conn.sendMessage(ctx.from, { text: "Texto, foto, video ou os dois. Vai pra bandeja do grupo." }, { quoted: ctx.info });
            }
            const r = await sendGroupStatusV2(conn, ctx.from, {
                texto,
                buffer: media?.buffer,
                tipo: media?.tipo,
                mode
            });
            await conn.sendMessage(ctx.from, { text: formatSendResult(r) }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro('groupstatus', e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.closefriends = {
    useCtx: true,
    description: "Status de grupo so pra membros (audience close friends)",
    usage: "closefriends <texto> (mande ou responda midia)",
    execute: async (conn, ctx) => {
        if (!isGroup(ctx.from)) return conn.sendMessage(ctx.from, { text: "Apenas em grupos." }, { quoted: ctx.info });
        if (!ctx.isOwner && !ctx.isVip) {
            return conn.sendMessage(ctx.from, { text: "Apenas dono/VIP." }, { quoted: ctx.info });
        }
        const { sendGroupStatusV2, captureStatusPayload, formatSendResult } = require('../utils/groupStatusV2');
        try {
            const media = await captureStatusPayload(conn, ctx);
            if (media?.error) {
                return conn.sendMessage(ctx.from, { text: "Falha ao baixar midia." }, { quoted: ctx.info });
            }
            let texto = String(ctx.text || '').trim();
            if (!texto && media?.caption) texto = String(media.caption).trim();
            if (!media?.buffer && !texto) {
                return conn.sendMessage(ctx.from, { text: "Texto, foto, video ou os dois." }, { quoted: ctx.info });
            }
            const r = await sendGroupStatusV2(conn, ctx.from, {
                texto,
                buffer: media?.buffer,
                tipo: media?.tipo,
                mode: 'membros',
                closeFriends: true
            });
            await conn.sendMessage(ctx.from, { text: formatSendResult(r) }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro('closefriends', e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.forward = {
    useCtx: true,
    description: "Encaminha uma mensagem citada",
    usage: "forward (responda a uma mensagem)",
    execute: async (conn, ctx) => {
        const quotedMsg = ctx.info?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMsg) return conn.sendMessage(ctx.from, { text: "Responda uma mensagem." }, { quoted: ctx.info });
        await conn.sendMessage(ctx.from, { forward: { key: ctx.info.message.extendedTextMessage.contextInfo, message: quotedMsg } }, { quoted: ctx.info });
    }
};

commands.edit = {
    useCtx: true,
    description: "Edita sua propria mensagem (responda)",
    usage: "edit <novo texto> (responda a mensagem)",
    execute: async (conn, ctx) => {
        const ctxInfo = ctx.info?.message?.extendedTextMessage?.contextInfo;
        if (!ctxInfo?.stanzaId) return conn.sendMessage(ctx.from, { text: "Responda a mensagem que deseja editar." }, { quoted: ctx.info });
        if (!ctx.text) return conn.sendMessage(ctx.from, { text: "Digite o novo texto." }, { quoted: ctx.info });
        try {
            await conn.sendMessage(ctx.from, { text: ctx.text, edit: { id: ctxInfo.stanzaId } });
            await conn.sendMessage(ctx.from, { text: "Mensagem editada." }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro("edit", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.delete = {
    useCtx: true,
    description: "Apaga a mensagem respondida (PIX/status usa a tecnica certa)",
    usage: "delete (responda a mensagem)",
    execute: async (conn, ctx) => {
        const ctxInfo = ctx.info?.message?.extendedTextMessage?.contextInfo
            || ctx.info?.message?.imageMessage?.contextInfo
            || ctx.info?.message?.videoMessage?.contextInfo
            || {};
        const stanzaId = ctxInfo.stanzaId || ctx.quoted?.stanzaId;
        if (!stanzaId) {
            return conn.sendMessage(ctx.from, { text: "Responda a mensagem." }, { quoted: ctx.info });
        }
        try {
            const {
                deleteMessageSmart,
                isGroupAdminStrict,
                collectMessageSenderIds,
                isSessionSelfIdentity
            } = require('../utils/moderation');
            const part = ctx.quoted?.sender || ctx.quoted?.participant || ctxInfo.participant || '';
            const fromMe = !!ctx.quoted?.fromMe || isSessionSelfIdentity(conn, part);
            if (!fromMe && ctx.isGroup && !ctx.isOwner && !ctx.isVip) {
                const extra = collectMessageSenderIds(ctx.info, [ctx.senderAlt, ctx.sender]);
                const adminOk = await isGroupAdminStrict(conn, ctx.from, ctx.sender, extra);
                if (!adminOk) return;
            }
            const quotedMsg = ctx.quoted?.message || ctxInfo.quotedMessage || null;
            const full = {
                key: {
                    remoteJid: ctx.from,
                    id: stanzaId,
                    fromMe,
                    participant: part || undefined,
                    participantAlt: ctx.quoted?.participantAlt || ctx.quoted?.participantPn || undefined
                },
                message: quotedMsg,
                _hanorkPayment: !!(quotedMsg && quotedMsg.requestPaymentMessage),
                _hanorkGroupStatus: !!(quotedMsg && (
                    quotedMsg.groupStatusMessageV2
                    || quotedMsg.groupStatusMessage
                    || quotedMsg.extendedTextMessage?.contextInfo?.isGroupStatus
                    || Number(quotedMsg.extendedTextMessage?.contextInfo?.statusSourceType) === 4
                ))
            };
            const result = await deleteMessageSmart(conn, ctx.from, stanzaId, fromMe, part, full);
            if (!result.success) {
                return conn.sendMessage(ctx.from, { text: "Nao consegui apagar. O bot precisa ser admin." }, { quoted: ctx.info });
            }
        } catch (e) {
            logger.logErro("delete", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.react = {
    useCtx: true,
    description: "Reage a uma mensagem (responda)",
    usage: "react <emoji> (responda a mensagem)",
    execute: async (conn, ctx) => {
        const ctxInfo = ctx.info?.message?.extendedTextMessage?.contextInfo;
        if (!ctxInfo?.stanzaId) return conn.sendMessage(ctx.from, { text: "Responda a mensagem." }, { quoted: ctx.info });
        if (!ctx.text) return conn.sendMessage(ctx.from, { text: "Digite o emoji." }, { quoted: ctx.info });
        try {
            await conn.sendMessage(ctx.from, { react: { text: ctx.text, key: { remoteJid: ctx.from, id: ctxInfo.stanzaId } } });
            await conn.sendMessage(ctx.from, { text: "Reacao enviada." }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro("react", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

/**
 * ValleyInvisible adaptado (futuro.txt 17–26).
 *
 * Tecnicamente = hijack de messageId (Valley msg.js / pv.js).
 * Envelope no GRUPO; admins AINDA veem. Texto only.
 *
 * Publico:
 *   1 numero | varios separados por virgula | "todos"
 *
 * Uso (igual Valley):
 *   pv  grupo@g.us | numero[,n2] | texto
 *   msg  @alguem texto   (no grupo)
 *   msgdir  … (alias)
 *
 * Cotacao: se responder a msg do alvo, relay imediato.
 * Botoes ON: sem args → menu de modos (mesmo handler).
 */
async function executeInvisibleCmd(conn, ctx) {
    if (!ctx.isOwner && ctx.authRole !== 'platform_admin') {
        return conn.sendMessage(ctx.from, { text: 'Apenas o dono.' }, { quoted: ctx.info });
    }

    const {
        LIMITS,
        normalizeUserJid,
        parseTargetList,
        tryRelayFromQuoted,
        armInvisibleAudience
    } = require('../utils/directedGroupRelay');
    const { areButtonsOn } = require('../utils/sessionRegistry');
    const { sendButtonsWithImage } = require('../helpers');
    const p = prefixFromCtx(ctx);
    const raw = String(ctx.text || '').trim();
    const sessionId = ctx.sessionId || conn?._sessionId;
    const buttonsOn = areButtonsOn(sessionId, ctx.telegramUserId);

    // Botoes ON + sem args → UI (mesmo handler de texto)
    if (!raw && buttonsOn && !conn?._isTelegramShim) {
        return sendButtonsWithImage(
            conn,
            ctx.from,
            [
                'Msg dirigida (admins AINDA veem — nao e invisivel)',
                '',
                '1 alvo: responda a pessoa + texto',
                'Ou digite:',
                `${p}pv grupo@g.us | numero | texto`,
                `${p}pv grupo@g.us | n1,n2 | texto`,
                `${p}pv grupo@g.us | todos | texto`,
                '',
                `Limite real: admins veem. Texto. Tecnica=${LIMITS.technique}`
            ].join('\n'),
            [
                { id: 'cmd_msgdir_help', label: 'Ajuda' },
                { id: 'cmd_menu', label: 'Menu' }
            ],
            'Hanork',
            ctx.info,
            'menu.jpg',
            'Msg dirigida',
            'Hanork',
            ctx.telegramUserId,
            null,
            sessionId
        );
    }

    if (!raw && !buttonsOn) {
        return conn.sendMessage(
            ctx.from,
            {
                text:
                    `Uso (msg dirigida — admins veem):\n` +
                    `${p}pv grupo@g.us | numero | texto\n` +
                    `${p}pv grupo@g.us | n1,n2 | texto\n` +
                    `${p}pv grupo@g.us | todos | texto\n` +
                    `No grupo: ${p}msg @alguem texto\n` +
                    `Ou responda a msg do alvo: ${p}msgdir texto\n\n` +
                    `Limite: aparece no GRUPO (admins veem). Sem midia. Sem ocultar de admin.`
            },
            { quoted: ctx.info }
        );
    }

    const parts = raw.split('|').map((x) => x.trim()).filter((x) => x.length);

    let groupJid = null;
    let targetsRaw = null;
    let text = '';

    if (parts.length >= 3 && parts[0].includes('@g.us')) {
        groupJid = parts[0];
        targetsRaw = parts[1];
        text = parts.slice(2).join('|');
    } else if (ctx.isGroup && parts.length >= 2) {
        groupJid = ctx.from;
        targetsRaw = parts[0];
        text = parts.slice(1).join('|');
    } else if (ctx.isGroup) {
        groupJid = ctx.from;
        const ctxInfo = ctx.info?.message?.extendedTextMessage?.contextInfo;
        const mentioned = Array.isArray(ctxInfo?.mentionedJid) ? ctxInfo.mentionedJid : [];
        if (mentioned.length) {
            targetsRaw = mentioned.map((j) => normalizeUserJid(j)).filter(Boolean).join(',');
            // remove @mentions do texto
            text = raw.replace(/@\d+/g, '').trim();
        } else if (ctxInfo?.participant || ctx.quoted) {
            targetsRaw = ctxInfo?.participant || ctx.quoted?.participant || null;
            text = raw;
        } else if (parts.length === 1) {
            text = parts[0];
            targetsRaw = ctxInfo?.participant || null;
        }
    }

    if (!groupJid || !String(groupJid).endsWith('@g.us')) {
        return conn.sendMessage(
            ctx.from,
            { text: `Informe o grupo. Ex: ${p}pv 120363...@g.us | numero | texto` },
            { quoted: ctx.info }
        );
    }

    const targets = parseTargetList(targetsRaw);
    if (!targets.length) {
        return conn.sendMessage(
            ctx.from,
            {
                text:
                    `Informe alvo(s): numero, lista (n1,n2) ou "todos".\n` +
                    `Ex: ${p}pv ${groupJid} | 5511... | oi`
            },
            { quoted: ctx.info }
        );
    }

    if (!text) text = 'hanork';

    // Relay imediato se quote for do alvo (1 alvo)
    const quotedKey = ctx.info?.message?.extendedTextMessage?.contextInfo
        ? {
            id: ctx.info.message.extendedTextMessage.contextInfo.stanzaId,
            participant: ctx.info.message.extendedTextMessage.contextInfo.participant,
            participantAlt: ctx.info.message.extendedTextMessage.contextInfo.participantAlt
        }
        : null;

    if (quotedKey?.id && !targets.includes('__ALL__') && targets.length === 1) {
        const immediate = await tryRelayFromQuoted(conn, {
            groupJid,
            quotedKey,
            targetJids: targets,
            text
        });
        if (immediate.ok) {
            return conn.sendMessage(ctx.from, { text: 'Relay enviado (quote).' }, { quoted: ctx.info });
        }
    }

    const label =
        targets.includes('__ALL__')
            ? 'todos os membros'
            : targets.length === 1
                ? targets[0].split('@')[0]
                : `${targets.length} alvos`;

    await conn.sendMessage(
        ctx.from,
        {
            text:
                `Monitorando ${label} em ${groupJid}.\n` +
                `Quando mandar(em) msg, relay so pra esse alvo (timeout 3 min).\n` +
                `Outros membros do grupo nao recebem. Texto only.`
        },
        { quoted: ctx.info }
    );

    const { promise } = armInvisibleAudience(conn, {
        groupJid,
        targets,
        text,
        timeoutMs: 180000,
        excludeAdmins: false
    });
    const result = await promise;
    if (result.ok) {
        const n = (result.hits || []).filter((h) => h.ok).length;
        return conn.sendMessage(
            ctx.from,
            { text: `Relay ok: ${n}/${(result.hits || []).length || n}.` },
            { quoted: ctx.info }
        );
    }
    return conn.sendMessage(
        ctx.from,
        { text: `Falhou: ${result.reason || 'erro'}` },
        { quoted: ctx.info }
    );
}

commands.msgdir = {
    useCtx: true,
    description: 'Msg dirigida Valley (1/N/todos)',
    usage: 'msgdir grupo@g.us | numero|todos | texto',
    execute: executeInvisibleCmd
};
commands.msgdirigida = commands.msgdir;
commands.pvdir = commands.msgdir;
commands.pv = commands.msgdir;
commands.msg = commands.msgdir;
commands.invisivel = commands.msgdir;
commands.msginv = commands.msgdir;
commands.sendinvisible = commands.msgdir;

commands.msgdir_help = {
    useCtx: true,
    description: 'Ajuda msg dirigida',
    usage: 'msgdir_help',
    execute: async (conn, ctx) => {
        const p = prefixFromCtx(ctx);
        return conn.sendMessage(
            ctx.from,
            {
                text:
                    `Msg dirigida (Valley → Hanork)\n\n` +
                    `${p}pv grupo@g.us | numero | texto\n` +
                    `${p}pv grupo@g.us | n1,n2 | texto\n` +
                    `${p}pv grupo@g.us | todos | texto\n` +
                    `No grupo: ${p}msg @user texto\n` +
                    `Responda msg do alvo: ${p}msgdir texto\n\n` +
                    `Tecnica: reusa messageId + participant dirigido. So o alvo ve.`
            },
            { quoted: ctx.info }
        );
    }
};

function stickerFpFromCtx(ctx) {
    const { fromQuoted, fromMessage, fromStickerNode } = require('../utils/stickerFingerprint');
    const { resolveStickerSource } = require('../services/stickerService');
    const src = resolveStickerSource(ctx.info);
    return fromStickerNode(src.sticker) || fromQuoted(ctx.info) || fromMessage(ctx.info);
}

async function ownerOnlyStickerCmd(conn, ctx) {
    const { requireSessionOwner } = require('../utils/authorization');
    return requireSessionOwner(conn, ctx, 'Apenas o dono da sessao.');
}

commands.stickerinfo = {
    useCtx: true,
    description: 'Mostra ID/hash da figurinha (responda). Nao bane.',
    usage: 'stickerinfo (responda a figurinha)',
    execute: async (conn, ctx) => {
        if (!(await ownerOnlyStickerCmd(conn, ctx))) return;
        const fp = stickerFpFromCtx(ctx);
        if (!fp) {
            return conn.sendMessage(ctx.from, { text: 'Responda uma figurinha.' }, { quoted: ctx.info });
        }
        const uid = ctx.telegramUserId || conn._telegramUserId;
        const { isBanned, isTrigger } = require('../utils/bannedStickers');
        const { formatLines } = require('../utils/stickerFingerprint');
        const { formatReportBlock, labelValue } = require('../utils/typography');
        const rows = formatLines(fp);
        rows.push(labelValue('Lista bloqueio', isBanned(uid, fp) ? 'sim' : 'nao'));
        rows.push(labelValue('Trigger banall', isTrigger(uid, fp) ? 'sim' : 'nao'));
        await conn.sendMessage(ctx.from, { text: formatReportBlock('FIGURINHA', rows) }, { quoted: ctx.info });
    }
};

commands.figban = {
    useCtx: true,
    description: 'Bloqueia essa figurinha no envio do bot (responda). So dono da sessao.',
    usage: 'figban (responda a figurinha)',
    execute: async (conn, ctx) => {
        if (!(await ownerOnlyStickerCmd(conn, ctx))) return;
        const fp = stickerFpFromCtx(ctx);
        if (!fp) {
            return conn.sendMessage(ctx.from, { text: 'Responda a figurinha que quer bloquear.' }, { quoted: ctx.info });
        }
        const uid = ctx.telegramUserId || conn._telegramUserId;
        const r = require('../utils/bannedStickers').addFingerprint(uid, fp, 'banned');
        if (!r.ok) {
            return conn.sendMessage(ctx.from, { text: 'Essa figurinha nao tem fileSha256. Nao da pra listar.' }, { quoted: ctx.info });
        }
        await conn.sendMessage(ctx.from, {
            text: `Figurinha na lista de bloqueio. O bot nao reenvia. ${r.ids[0].slice(0, 16)}…`
        }, { quoted: ctx.info });
    }
};

commands.figunban = {
    useCtx: true,
    description: 'Tira figurinha da lista (responda ou cole o hash).',
    usage: 'figunban (responda) | figunban <hash>',
    execute: async (conn, ctx) => {
        if (!(await ownerOnlyStickerCmd(conn, ctx))) return;
        const fp = stickerFpFromCtx(ctx);
        const hex = String(ctx.text || '').trim();
        const r = require('../utils/bannedStickers').removeFingerprint(ctx.telegramUserId || conn._telegramUserId, fp || hex);
        await conn.sendMessage(ctx.from, {
            text: r.removed ? 'Tirei da lista.' : 'Nao achei essa figurinha na lista.'
        }, { quoted: ctx.info });
    }
};

commands.figbanall = {
    useCtx: true,
    description: 'Marca a figurinha como trigger de banall (responda). So dono da sessao.',
    usage: 'figbanall (responda a figurinha)',
    execute: async (conn, ctx) => {
        if (!(await ownerOnlyStickerCmd(conn, ctx))) return;
        const fp = stickerFpFromCtx(ctx);
        if (!fp) {
            return conn.sendMessage(ctx.from, { text: 'Responda a figurinha que vai disparar banall.' }, { quoted: ctx.info });
        }
        const uid = ctx.telegramUserId || conn._telegramUserId;
        const r = require('../utils/bannedStickers').addFingerprint(uid, fp, 'trigger');
        if (!r.ok) {
            return conn.sendMessage(ctx.from, { text: 'Essa figurinha nao tem fileSha256.' }, { quoted: ctx.info });
        }
        const p = prefixFromCtx(ctx);
        await conn.sendMessage(ctx.from, {
            text: `Trigger de banall gravado. Responda a pessoa com essa fig, ou reaja 🤠 na msg dela. So o dono da sessao. ${p}stickerinfo pra ver o ID.`
        }, { quoted: ctx.info });
    }
};

commands.figbanlist = {
    useCtx: true,
    description: 'Lista figurinhas bloqueadas nesta sessao.',
    usage: 'figbanlist',
    execute: async (conn, ctx) => {
        if (!(await ownerOnlyStickerCmd(conn, ctx))) return;
        const list = require('../utils/bannedStickers').listBanned(ctx.telegramUserId || conn._telegramUserId);
        if (!list.length) {
            return conn.sendMessage(ctx.from, { text: 'Lista vazia. Responda uma fig com figban ou figbanall.' }, { quoted: ctx.info });
        }
        const { formatReportBlock, labelValue } = require('../utils/typography');
        const rows = list.slice(0, 20).map((it, i) =>
            labelValue(`${i + 1}${it.trigger ? ' trigger' : ''}`, String(it.id || '').slice(0, 24) + '…')
        );
        await conn.sendMessage(ctx.from, { text: formatReportBlock('LISTA FIG', rows) }, { quoted: ctx.info });
    }
};

module.exports = { commands };