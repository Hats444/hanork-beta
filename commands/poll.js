const logger = require("../logger");
const crypto = require("crypto");

const commands = {};

commands.poll = {
    description: "Cria uma enquete",
    usage: "poll <pergunta> | opcao1,opcao2,...",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono && !isVip) return conn.sendMessage(from, { text: "Apenas dono/VIP." }, { quoted: info });
        const parts = q.split("|");
        const question = parts[0]?.trim();
        if (!question) return conn.sendMessage(from, { text: "Pergunta obrigatoria." }, { quoted: info });
        const options = parts[1] ? parts[1].split(",").map(s => s.trim()) : [];
        if (options.length < 2) return conn.sendMessage(from, { text: "Minimo 2 opcoes." }, { quoted: info });
        try {
            await conn.sendMessage(from, {
                poll: {
                    name: question,
                    values: options,
                    selectableCount: 1,
                    messageSecret: crypto.randomBytes(32)
                }
            }, { quoted: info });
            await conn.sendMessage(from, { text: "Enquete criada." }, { quoted: info });
        } catch (e) {
            logger.logErro("poll", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.pollresult = {
    description: "Mostra resultados de uma enquete (responda a enquete)",
    usage: "pollresult (responda a enquete)",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        const ctx = info.message?.extendedTextMessage?.contextInfo;
        const quotedMsg = ctx?.quotedMessage;
        if (!quotedMsg || !quotedMsg.pollCreationMessage) {
            return conn.sendMessage(from, { text: "Responda a uma enquete." }, { quoted: info });
        }
        try {
            const pollMsg = quotedMsg.pollCreationMessage;
            const votes = await conn.getAggregateVotesInPollMessage({ key: ctx, message: quotedMsg });
            const results = votes.map(v => `${v.name}: ${v.voters.length} votos`).join("\n");
            await conn.sendMessage(from, { text: `Resultados:\n${results}` }, { quoted: info });
        } catch (e) {
            logger.logErro("pollresult", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

module.exports = { commands };