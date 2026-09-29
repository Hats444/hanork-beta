const logger = require("../logger");
const { isGroup } = require("../utils");
const {
    sendGroupStatusV2,
    sendGroupPaymentMembers,
    captureStatusPayload,
    parseStatusMode,
    stripModeArgs,
    formatSendResult,
    formatPaymentResult
} = require("../utils/groupStatusV2");

const commands = {};

commands.statuspost = {
    useCtx: true,
    description: "Status de grupo: texto, foto, video, foto+texto, video+texto",
    usage: "statuspost [membros|todos|canal] <texto> (mande ou responda foto/video)",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner && !ctx.isVip) return conn.sendMessage(ctx.from, { text: "Apenas dono/VIP." }, { quoted: ctx.info });

        let canalJid = null;
        let args = [...(ctx.args || [])];
        if (args.length && String(args[0]).includes('@newsletter')) {
            canalJid = args.shift();
        } else if (args.length && /^(canal|channel|newsletter)$/i.test(String(args[0]))) {
            args.shift();
            if (args.length && String(args[0]).includes('@newsletter')) {
                canalJid = args.shift();
            } else {
                const { resolveCanalJid } = require('../utils/groupStatusV2');
                canalJid = resolveCanalJid('');
            }
        }
        const mode = parseStatusMode(args);
        let texto = stripModeArgs(args).join(' ').trim() || '';

        const media = await captureStatusPayload(conn, ctx);
        if (media && media.error) {
            return conn.sendMessage(ctx.from, { text: "Falha ao baixar midia." }, { quoted: ctx.info });
        }
        if (!texto && media?.caption) texto = String(media.caption).trim();

        if (canalJid || mode === 'canal') {
            const { sendChannelStatus, resolveCanalJid, formatSendResult } = require('../utils/groupStatusV2');
            const dest = canalJid || resolveCanalJid('');
            if (!dest) {
                return conn.sendMessage(ctx.from, { text: "JID do canal (@newsletter) ou configure o canal oficial." }, { quoted: ctx.info });
            }
            if (!media?.buffer && !texto) {
                return conn.sendMessage(ctx.from, { text: "Manda texto, foto, video ou os dois." }, { quoted: ctx.info });
            }
            try {
                const r = await sendChannelStatus(conn, dest, {
                    texto,
                    buffer: media?.buffer,
                    tipo: media?.tipo
                });
                await conn.sendMessage(ctx.from, { text: formatSendResult(r) }, { quoted: ctx.info });
            } catch (e) {
                logger.logErro("statuspost-canal", e.message);
                await conn.sendMessage(ctx.from, { text: "Falha ao enviar status de canal." }, { quoted: ctx.info });
            }
            return;
        }

        if (!isGroup(ctx.from)) {
            return conn.sendMessage(ctx.from, { text: "Use .statuspost no grupo (texto, foto, video ou os dois)." }, { quoted: ctx.info });
        }
        if (!media?.buffer && !texto) {
            return conn.sendMessage(ctx.from, { text: "Manda texto, foto, video ou responda midia. Legenda vale junto. Vai pra bandeja do grupo." }, { quoted: ctx.info });
        }

        try {
            const r = await sendGroupStatusV2(conn, ctx.from, {
                texto,
                buffer: media?.buffer,
                tipo: media?.tipo,
                mode
            });
            await conn.sendMessage(ctx.from, { text: formatSendResult(r) }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro("statuspost", e.message);
            await conn.sendMessage(ctx.from, { text: "Falha ao enviar o status." }, { quoted: ctx.info });
        }
    }
};

commands.channelstatus = {
    useCtx: true,
    description: "Status de canal (24h, aba Status) — nao e post do feed",
    usage: "channelstatus [jid@newsletter] <texto> (mande ou responda midia)",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner && !ctx.isVip) {
            return conn.sendMessage(ctx.from, { text: "Apenas dono/VIP." }, { quoted: ctx.info });
        }
        const { sendChannelStatus, captureStatusPayload, stripModeArgs, resolveCanalJid, formatSendResult } = require('../utils/groupStatusV2');
        let args = [...(ctx.args || [])];
        let canalJid = '';
        if (args.length && String(args[0]).includes('@newsletter')) {
            canalJid = args.shift();
        } else {
            canalJid = resolveCanalJid('');
        }
        let texto = stripModeArgs(args).join(' ').trim() || '';
        try {
            const media = await captureStatusPayload(conn, ctx);
            if (media?.error) {
                return conn.sendMessage(ctx.from, { text: "Falha ao baixar midia." }, { quoted: ctx.info });
            }
            if (!texto && media?.caption) texto = String(media.caption).trim();
            if (!media?.buffer && !texto) {
                return conn.sendMessage(ctx.from, { text: "Texto, foto, video ou os dois. Vai pra aba Status do canal." }, { quoted: ctx.info });
            }
            if (!canalJid) {
                return conn.sendMessage(ctx.from, { text: "Passe o JID @newsletter ou configure o canal oficial." }, { quoted: ctx.info });
            }
            const r = await sendChannelStatus(conn, canalJid, {
                texto,
                buffer: media?.buffer,
                tipo: media?.tipo
            });
            await conn.sendMessage(ctx.from, { text: formatSendResult(r) }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro("channelstatus", e.message);
            await conn.sendMessage(ctx.from, { text: "Falha ao enviar status de canal." }, { quoted: ctx.info });
        }
    }
};

commands.paypost = {
    useCtx: true,
    description: "Cobranca nativa no grupo (membros|todos) — teste antes da div automatica",
    usage: "paypost [membros|todos] <texto>",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner && !ctx.isVip) {
            return conn.sendMessage(ctx.from, { text: "Apenas dono/VIP." }, { quoted: ctx.info });
        }
        if (!isGroup(ctx.from)) {
            return conn.sendMessage(ctx.from, { text: "Use .paypost no grupo." }, { quoted: ctx.info });
        }
        const args = [...(ctx.args || [])];
        const mode = parseStatusMode(args);
        if (mode === 'canal') {
            return conn.sendMessage(ctx.from, { text: "Pagamento nao vai pra canal. Use membros ou todos." }, { quoted: ctx.info });
        }
        let texto = stripModeArgs(args).join(' ').trim();
        if (!texto) {
            try {
                const { getConfig } = require('../utils/divulgacao');
                texto = String(getConfig(ctx.telegramUserId)?.textoPay || '').trim();
            } catch (_) { /* sem config */ }
        }
        if (!texto) {
            return conn.sendMessage(ctx.from, {
                text: "Manda o texto ou configura com .msgdivulpay. Ex: .paypost teste"
            }, { quoted: ctx.info });
        }
        try {
            const r = await sendGroupPaymentMembers(conn, ctx.from, { texto, mode });
            await conn.sendMessage(ctx.from, { text: formatPaymentResult(r) }, { quoted: ctx.info });
        } catch (e) {
            logger.logErro("paypost", e.message);
            await conn.sendMessage(ctx.from, { text: "Falha ao enviar o pagamento." }, { quoted: ctx.info });
        }
    }
};
commands.pagamentopost = commands.paypost;
commands.postpay = commands.paypost;
commands.groupstatus = commands.statuspost;

module.exports = { commands };
