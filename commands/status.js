const logger = require("../logger");
const crypto = require("crypto");
const { isGroup } = require("../utils");
const { downloadMediaMessage, prepareWAMessageMedia, generateWAMessageFromContent } = require("@systemzero/baileys");

const commands = {};

function isMediaQuoted(quotedMsg) {
    if (!quotedMsg || typeof quotedMsg !== 'object') return false;
    return !!(
        quotedMsg.imageMessage ||
        quotedMsg.videoMessage ||
        quotedMsg.audioMessage ||
        quotedMsg.stickerMessage ||
        quotedMsg.documentMessage ||
        quotedMsg.viewOnceMessage?.message?.imageMessage ||
        quotedMsg.viewOnceMessage?.message?.videoMessage ||
        quotedMsg.viewOnceMessageV2?.message?.imageMessage ||
        quotedMsg.viewOnceMessageV2?.message?.videoMessage
    );
}

function unwrapQuotedMedia(quotedMsg) {
    return (
        quotedMsg.imageMessage ||
        quotedMsg.videoMessage ||
        quotedMsg.viewOnceMessage?.message ||
        quotedMsg.viewOnceMessageV2?.message ||
        quotedMsg
    );
}

commands.status = {
    description: "Envia um status (texto, imagem, video)",
    usage: "status <texto> ou responda midia",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono && !isVip) {
            return conn.sendMessage(from, { text: "Apenas dono/VIP." }, { quoted: info });
        }
        try {
            const quotedMsg = info.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quotedMsg && isMediaQuoted(quotedMsg)) {
                const mediaNode = unwrapQuotedMedia(quotedMsg);
                const buffer = await downloadMediaMessage(
                    { message: mediaNode.imageMessage || mediaNode.videoMessage ? mediaNode : quotedMsg },
                    "buffer",
                    {},
                    {}
                );
                const isVideo = !!(quotedMsg.videoMessage || mediaNode.videoMessage);
                const prep = await prepareWAMessageMedia(
                    isVideo ? { video: buffer } : { image: buffer },
                    { upload: conn.waUploadToServer }
                );
                const payload = isVideo
                    ? { video: prep.videoMessage }
                    : { image: prep.imageMessage };
                await conn.sendMessage("status@broadcast", payload);
            } else if (quotedMsg && (quotedMsg.conversation || quotedMsg.extendedTextMessage)) {
                // citou texto — NAO tenta downloadMedia (erro "conversation is not a media message")
                const t =
                    quotedMsg.conversation ||
                    quotedMsg.extendedTextMessage?.text ||
                    q ||
                    '';
                if (!t) {
                    return conn.sendMessage(from, { text: "Texto ou responda midia." }, { quoted: info });
                }
                await conn.sendMessage("status@broadcast", { text: String(t) });
            } else if (q) {
                await conn.sendMessage("status@broadcast", { text: q });
            } else {
                return conn.sendMessage(from, { text: "Texto ou responda midia." }, { quoted: info });
            }
            await conn.sendMessage(from, { text: "Status enviado." }, { quoted: info });
        } catch (e) {
            logger.logErro("status", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

module.exports = { commands };
