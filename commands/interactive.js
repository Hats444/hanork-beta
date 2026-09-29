const logger = require("../logger");
const { sendInteractiveButtons, sendInteractiveList, sendCarouselWithImage } = require("../helpers");

function getUserJid(conn) {
    return conn.user?.id || conn.user?.jid || 'status@broadcast';
}

const commands = {};

commands.buttons = {
    description: "Envia botoes interativos",
    usage: "buttons <titulo> | opcao1,opcao2,...",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!q) return conn.sendMessage(from, { text: "Use: buttons <titulo> | opcao1,opcao2,..." }, { quoted: info });
        const parts = q.split("|");
        const title = parts[0].trim();
        const options = parts[1] ? parts[1].split(",").map(s => s.trim()) : [];
        if (!options.length) return conn.sendMessage(from, { text: "Nenhuma opcao." }, { quoted: info });
        const buttons = options.map((opt, i) => ({ id: `btn_${i}`, label: opt }));
        await sendInteractiveButtons(conn, from, title, buttons, "Clique abaixo", info);
    }
};

commands.list = {
    description: "Envia uma lista interativa (single_select)",
    usage: "list <titulo> | opcao1,opcao2,...",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!q) return conn.sendMessage(from, { text: "Use: list <titulo> | opcao1,opcao2,..." }, { quoted: info });
        const parts = q.split("|");
        const title = parts[0].trim();
        const options = parts[1] ? parts[1].split(",").map(s => s.trim()) : [];
        if (!options.length) return conn.sendMessage(from, { text: "Nenhuma opcao." }, { quoted: info });
        const sections = [{
            title: "Opcoes",
            rows: options.map(opt => ({ title: opt, description: `Selecionar ${opt}`, id: `list_${opt}` }))
        }];
        await sendInteractiveList(conn, from, title, sections, "Hanork Bot", info);
    }
};

commands.carousel = {
    description: "Envia um carrossel",
    usage: "carousel <titulo> | card1;card2;... (cada card: titulo|texto|botao)",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!q) return conn.sendMessage(from, { text: "Use: carousel <titulo> | card1;card2;..." }, { quoted: info });
        const parts = q.split("|");
        const title = parts[0].trim();
        const cardsData = parts[1] ? parts[1].split(";").map(c => c.trim()) : [];
        if (!cardsData.length) return conn.sendMessage(from, { text: "Nenhum card." }, { quoted: info });
        const cards = cardsData.map(card => {
            const [body, footer, label] = card.split("|").map(s => s.trim());
            return { body: body || "Card", footer: footer || "", buttons: [{ label: label || "Abrir", id: `card_${Date.now()}` }] };
        });
        await sendCarouselWithImage(conn, from, title, cards, "Hanork Bot", info, null);
    }
};

commands.copybutton = {
    description: "Envia um botao de copia",
    usage: "copybutton <texto> | <codigo a copiar>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!q) return conn.sendMessage(from, { text: "Use: copybutton <texto> | <codigo>" }, { quoted: info });
        const parts = q.split("|");
        const text = parts[0].trim();
        const code = parts[1] ? parts[1].trim() : "";
        if (!code) return conn.sendMessage(from, { text: "Codigo vazio." }, { quoted: info });
        await sendInteractiveButtons(conn, from, `${text}\n\nCodigo: ${code}`, [
            { id: `copy_${code}`, label: "Copiar (envia no PV)" }
        ], "Clique para copiar", info);
    }
};

commands.urlbutton = {
    description: "Envia um botao com URL",
    usage: "urlbutton <texto> | <url> | <label>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!q) return conn.sendMessage(from, { text: "Use: urlbutton <texto> | <url> | <label>" }, { quoted: info });
        const parts = q.split("|").map(s => s.trim());
        if (parts.length < 3) return conn.sendMessage(from, { text: "Faltam argumentos." }, { quoted: info });
        const text = parts[0];
        const url = parts[1];
        const label = parts[2];
        await sendInteractiveButtons(conn, from, text, [
            { label, url }
        ], "Clique para abrir", info);
    }
};

commands.flow = {
    description: "Envia um formulario WhatsApp Flow",
    usage: "flow <flow_id> <flow_token>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        const parts = q.split('|');
        const flowId = parts[0]?.trim();
        const flowToken = parts[1]?.trim() || 'TOKEN';
        if (!flowId) return conn.sendMessage(from, { text: "Use: flow <flow_id> | <flow_token>" }, { quoted: info });
        const { generateWAMessageFromContent } = require('@systemzero/baileys');
        const { safeRelayMessage } = require('../safeRelay');
        const formMsg = {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: {
                        body: { text: 'Preencha seus dados.' },
                        nativeFlowMessage: {
                            buttons: [{
                                name: 'galaxy_message',
                                buttonParamsJson: JSON.stringify({
                                    flow_message_version: '4',
                                    flow_id: flowId,
                                    flow_action_payload: {
                                        screen: 'contact_details',
                                        data: { full_name_visible: true, email_visible: true }
                                    },
                                    flow_cta: '__localize:FLOWS_SIGN_UP_BUTTON_TITLE',
                                    flow_action: 'navigate',
                                    flow_token: flowToken
                                })
                            }],
                            messageParamsJson: '{}'
                        }
                    }
                }
            }
        };
        await safeRelayMessage(conn, from, formMsg, {}, 'interactive.js:flow');
        await conn.sendMessage(from, { text: "Formulario enviado." }, { quoted: info });
    }
};

commands.buttonv2 = {
    description: "Usa o ButtonV2 builder",
    usage: "buttonv2 <titulo> | <corpo> | botao1, botao2",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        const { ButtonV2 } = require('@systemzero/baileys/lib/MB.cjs');
        const parts = q.split('|');
        if (parts.length < 3) return conn.sendMessage(from, { text: "Use: buttonv2 titulo | corpo | botao1,botao2" }, { quoted: info });
        const title = parts[0].trim();
        const body = parts[1].trim();
        const btns = parts[2].split(',').map(s => s.trim());
        const builder = new ButtonV2(conn);
        builder.setTitle(title);
        builder.setBody(body);
        btns.forEach((label, i) => builder.addButton(label, `btn_${i}`));
        await builder.send(from, { quoted: info });
        await conn.sendMessage(from, { text: "Botoes enviados (ButtonV2)." }, { quoted: info });
    }
};

commands.carouselbuilder = {
    description: "Usa o Carousel builder",
    usage: "carouselbuilder <titulo> | card1:desc:botao1;card2:desc:botao2",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        try {
            const { Carousel } = require('@systemzero/baileys/lib/MB.cjs');
            const parts = q.split('|');
            if (parts.length < 2) return conn.sendMessage(from, { text: "Use: carouselbuilder titulo | card1:desc:botao;card2:desc:botao" }, { quoted: info });
            const title = parts[0].trim();
            const cardsData = parts[1].split(';').map(c => c.trim());
            const builder = new Carousel(conn);
            builder.setBody(title);
            cardsData.forEach(card => {
                const [body, footer, label] = card.split(':').map(s => s.trim());
                builder.card(c => c.title(body || 'Card').text(footer || '').button(label || 'Abrir', `card_${Date.now()}`));
            });
            await builder.send(from, { quoted: info });
            await conn.sendMessage(from, { text: "✅ Carrossel enviado." }, { quoted: info });
        } catch (e) {
            if (e.message && e.message.includes('sharp')) {
                return conn.sendMessage(from, { 
                    text: "❌ O comando 'carouselbuilder' requer o modulo 'sharp'.\n\n" +
                          "Para instalar, execute:\n" +
                          "```\nnpm install sharp --cpu=wasm32\nnpm install @img/sharp-wasm32\n```\n\n" +
                          "Ou use o comando 'carousel' que nao depende do sharp."
                }, { quoted: info });
            }
            logger.logErro("carouselbuilder", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};
module.exports = { commands };