// commands/help.js
const { displayPrefix } = require("../utils/configManager");
const { sendButtonsWithImage } = require("../helpers");
const { previewText, stripAccents } = require("../utils/typography");
const commands = {};

commands.tutorial = {
    useCtx: true,
    description: "Tutorial rapido pra comecar a usar o bot",
    usage: "tutorial",
    execute: async (conn, ctx) => {
        const prefix = displayPrefix(ctx.telegramUserId, {
            prefix: ctx.prefix,
            platform: (ctx.platform === 'telegram' || ctx.isTelegram) ? 'telegram' : 'whatsapp',
            ctx
        });
        const isOwner = !!(ctx.isOwner || ctx.authRole === 'owner');

        const msgs = [
            `${previewText('LOJA')}\n\n` +
            stripAccents(
                `1) Me coloca admin do grupo\n` +
                `2) No Telegram: Proteger grupo\n` +
                `3) Pede pra um membro mandar um link (antilink)\n` +
                `4) ${prefix}gpseguranca se quiser ligar mais\n` +
                `5) Divulgacao (Pro): ${prefix}divmenu`
            )
        ];

        if (isOwner) {
            msgs.push(
                `${previewText('PARA O DONO')}\n\n` +
                stripAccents(
                    `${prefix}start — checklist completo\n` +
                    `${prefix}addowner / ${prefix}addvip — permissoes\n` +
                    `${prefix}vipall — VIP em todos do grupo\n` +
                    `${prefix}presetprotecao loja|divulgacao|fechado — no grupo\n` +
                    `${prefix}gpseguranca — painel fino\n` +
                    `${prefix}divmenu — divulgacao\n` +
                    `${prefix}menu_consultas — consultas`
                )
            );
        }

        for (const msg of msgs) {
            await conn.sendMessage(ctx.from, { text: msg }, { quoted: ctx.info });
            await new Promise((r) => setTimeout(r, 600));
        }
        await sendButtonsWithImage(
            conn,
            ctx.from,
            stripAccents("Pronto. Volte ao menu quando quiser."),
            [
                { id: "menu", label: "Menu" },
                { id: "comprar", label: "Comprar" },
                { id: "start", label: "Checklist" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            previewText("TUTORIAL"),
            stripAccents("Clique abaixo"),
            ctx.telegramUserId
        );
    }
};

commands.start = {
    useCtx: true,
    description: 'Checklist loja: admin, preset, antilink, divulgacao Pro',
    usage: 'start',
    execute: async (conn, ctx) => {
        const prefix = displayPrefix(ctx.telegramUserId, {
            prefix: ctx.prefix,
            platform: (ctx.platform === 'telegram' || ctx.isTelegram) ? 'telegram' : 'whatsapp',
            ctx
        });
        const isOwner = !!(ctx.isOwner || ctx.authRole === 'owner');
        if (!isOwner && !ctx.isVip) {
            return conn.sendMessage(ctx.from, {
                text: stripAccents(`Use ${prefix}tutorial ou ${prefix}comprar.`)
            }, { quoted: ctx.info });
        }
        const { buildBuyerStartText } = require('../utils/onboarding');
        const text = buildBuyerStartText(prefix);
        const rows = [
            { id: 'menu', label: 'Menu' },
            { id: 'div_menu', label: 'Divulgacao' }
        ];
        if (ctx.isGroup) {
            rows.push({ id: 'gpseguranca', label: 'Protecoes' });
        }
        await sendButtonsWithImage(
            conn,
            ctx.from,
            text,
            rows,
            'Hanork Bot',
            ctx.info,
            'menu.jpg',
            previewText('START'),
            stripAccents('Fluxo do dono'),
            ctx.telegramUserId
        );
    }
};

commands.novidades = {
    useCtx: true,
    description: "O que mudou recentemente no bot",
    usage: "novidades",
    execute: async (conn, ctx) => {
        const { formatPublicChangelog, containsSensitive } = require('../utils/publicChangelog');
        const prefix = displayPrefix(ctx.telegramUserId, {
            prefix: ctx.prefix,
            platform: (ctx.platform === 'telegram' || ctx.isTelegram) ? 'telegram' : 'whatsapp',
            ctx
        });
        const plat = (ctx.platform === 'telegram' || ctx.isTelegram) ? '/' : prefix;
        const text = formatPublicChangelog(plat);
        return conn.sendMessage(ctx.from, {
            text: containsSensitive(text)
                ? 'HANORK — o que mudou\n\nNotas publicas em revisao. Use comprar para planos.'
                : text
        }, { quoted: ctx.info });
    }
};
commands.changelog = commands.novidades;
commands.oquemudou = commands.novidades;
commands.status = commands.novidades;

commands.comandos = {
    useCtx: true,
    description: "Lista comandos por categoria",
    usage: "comandos [categoria]",
    execute: async (conn, ctx) => {
        const { prefixFromCtx } = require('../utils/configManager');
        const prefix = prefixFromCtx(ctx);
        const platform = (ctx.platform === 'telegram' || ctx.isTelegram) ? 'telegram' : 'whatsapp';
        const { textMenuCompact, getCategory, CATALOG } = require('../utils/menuCatalog');
        const arg = String(ctx.text || '').trim().toLowerCase();

        if (arg) {
            const { sendCategoryPanel } = require('../utils/menuCatalog');
            const cat = getCategory(arg) || CATALOG.find((c) =>
                String(c.title || '').toLowerCase() === arg || String(c.id) === arg
            );
            if (cat) {
                return sendCategoryPanel(conn, {
                    catId: cat.id,
                    chatId: ctx.from,
                    quoted: ctx.info,
                    telegramUserId: ctx.telegramUserId,
                    sessionId: ctx.sessionId || conn?._sessionId,
                    isGroup: !!ctx.isGroup,
                    viewerRole: ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user'),
                    viewerCtx: ctx
                });
            }
        }

        const role = ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user');
        const { viewerAccessOpts } = require('../utils/menuCatalog');
        return conn.sendMessage(ctx.from, {
            text: textMenuCompact(platform, prefix, role, viewerAccessOpts(ctx))
        }, { quoted: ctx.info });
    }
};

module.exports = { commands };
