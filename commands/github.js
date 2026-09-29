const logger = require("../logger");
const axios = require("axios");
const { proto } = require("@systemzero/baileys");
const { safeRelayMessage, getUserJid } = require("../safeRelay");
const { readSearchQuery } = require("../utils/searchQueryLimit");

const commands = {};

commands.gitsearch = {
    useCtx: true,
    description: "Busca repositorios no GitHub",
    usage: "gitsearch <termo>",
    execute: async (conn, ctx) => {
        const query = await readSearchQuery(conn, ctx, "Digite um termo.");
        if (!query) return;
        try {
            const { data } = await axios.get(`https://api.github.com/search/repositories`, {
                params: { q: query, sort: "stars", order: "desc", per_page: 10 },
                headers: { "User-Agent": "Hanork" }
            });
            if (!data.items.length) return conn.sendMessage(ctx.from, { text: "Nenhum resultado." }, { quoted: ctx.info });

            const rows = data.items.map(repo => ({
                header: `${repo.stargazers_count} • ${repo.forks_count}`,
                title: repo.full_name,
                description: (repo.description || "Sem descricao").slice(0, 72),
                id: `repo_${repo.full_name}`
            }));

            const content = {
                viewOnceMessage: {
                    message: {
                        interactiveMessage: proto.Message.InteractiveMessage.create({
                            body: { text: `Resultados para: ${query}\n\nSelecione um repositorio.` },
                            footer: { text: "Hanork • GitHub Search" },
                            header: { hasMediaAttachment: false },
                            nativeFlowMessage: {
                                buttons: [{
                                    name: "single_select",
                                    buttonParamsJson: JSON.stringify({
                                        title: "Abrir resultados",
                                        sections: [{ title: "Repositorios encontrados", rows }]
                                    })
                                }]
                            }
                        })
                    }
                }
            };

            await safeRelayMessage(conn, ctx.from, content, {}, 'github.js:gitsearch');
        } catch (e) {
            logger.logErro("gitsearch", e.message);
            console.error('[github.js:gitsearch]', e.stack);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.github = commands.gitsearch;
commands.repos = commands.gitsearch;

commands.repo = {
    useCtx: true,
    description: "Mostra detalhes de um repositorio",
    usage: "repo <autor/repo>",
    execute: async (conn, ctx) => {
        if (!ctx.text) return conn.sendMessage(ctx.from, { text: "Use: repo autor/repo" }, { quoted: ctx.info });
        try {
            const { enforceSearchQuery } = require("../utils/searchQueryLimit");
            const repoName = enforceSearchQuery(ctx.text.replace(/\\\//g, "/").replace(/\s+/g, "").trim());
            const { data } = await axios.get(`https://api.github.com/repos/${repoName}`, {
                headers: { "User-Agent": "Hanork" }
            });
            const txt =
                `${data.full_name}\n\n` +
                `${data.description || "Sem descricao"}\n\n` +
                `Estrelas: ${data.stargazers_count}\n` +
                `Forks: ${data.forks_count}\n` +
                `Watchers: ${data.watchers_count}\n` +
                `Issues: ${data.open_issues_count}\n` +
                `Linguagem: ${data.language || "N/A"}\n\n` +
                `${data.html_url}`;
            await conn.sendMessage(ctx.from, { text: txt }, { quoted: ctx.info });
        } catch (e) {
            if (e && e.code === 'SEARCH_QUERY_TOO_LONG') {
                return conn.sendMessage(ctx.from, { text: e.message }, { quoted: ctx.info });
            }
            logger.logErro("repo", e.message);
            console.error('[github.js:repo]', e.stack);
            await conn.sendMessage(ctx.from, { text: "Repositorio nao encontrado." }, { quoted: ctx.info });
        }
    }
};

module.exports = { commands };