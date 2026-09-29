// commands/webintelligence.js
// Comandos de busca web + analise IA (Ollama) com status progressivo editavel
const logger = require('../logger');
const { formatStatusBlock, formatReportBlock, labelValue, toMono } = require('../utils/typography');
const { createWhatsAppStatus } = require('../utils/statusProgress');
const {
    webSearch,
    deepSearch,
    analyzeSpecific,
    generateReport,
    getState,
    clearState
} = require('../services/webIntelligenceService');

const commands = {};

function formatResults(query, results) {
    const rows = [
        labelValue('Consulta', query),
        labelValue('Resultados', results.length),
        ''
    ];
    results.slice(0, 10).forEach((r, i) => {
        rows.push(`${i + 1}. ${r.title}`);
        rows.push(`   ${r.url}`);
        if (r.description) rows.push(`   ${r.description.slice(0, 100)}`);
        rows.push('');
    });
    rows.push(labelValue('Dica', 'analisar <numero> para IA'));
    return formatReportBlock('PESQUISA WEB', rows);
}

function formatReport(query, analysis) {
    const rows = [labelValue('Consulta', query), ''];
    if (analysis.error) {
        rows.push('Ollama offline. Resultados sem analise IA.');
        rows.push('');
    } else if (analysis.answer) {
        rows.push(analysis.answer);
        rows.push('');
    }
    if (analysis.sources_used && analysis.sources_used.length > 0) {
        rows.push(toMono('Fontes'));
        analysis.sources_used.forEach((s, i) => {
            rows.push(`${i + 1}. ${s}`);
        });
    }
    return formatReportBlock('RELATORIO IA', rows);
}

// ===== GOOGLE / PESQUISAR / WEB / SEARCH =====
commands.google = {
    useCtx: true,
    description: "Busca na web em tempo real",
    usage: "google <termo>",
    execute: async (conn, ctx) => {
        const { readSearchQuery } = require('../utils/searchQueryLimit');
        const query = await readSearchQuery(conn, ctx, `Uso: ${require('../utils/configManager').prefixFromCtx(ctx)}google <termo>`);
        if (!query) return;
        const userId = ctx.sender || ctx.from;
        const sessionId = ctx.sessionId || conn._sessionId || 'default';
        const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'PESQUISA');
        try {
            await status.update('Buscando', query);
            const results = await webSearch(userId, query, sessionId);
            if (!results || results.length === 0) {
                await status.finish(formatStatusBlock('PESQUISA', [['Estado', 'nenhum resultado']]));
                return;
            }
            await status.update('Resultado encontrado', String(results.length));
            await status.finish(formatResults(query, results));
        } catch (e) {
            logger.logErro('[google]', e.message);
            await status.finish(formatStatusBlock('PESQUISA', [['Erro', e.message]]));
        }
    }
};

commands.pesquisar = commands.google;
commands.web = commands.google;
commands.search = commands.google;

// ===== DEEPSEARCH =====
commands.deepsearch = {
    useCtx: true,
    description: "Busca profunda com multiplas queries geradas por IA",
    usage: "deepsearch <termo>",
    execute: async (conn, ctx) => {
        const { readSearchQuery } = require('../utils/searchQueryLimit');
        const query = await readSearchQuery(conn, ctx, `Uso: ${require('../utils/configManager').prefixFromCtx(ctx)}deepsearch <termo>`);
        if (!query) return;
        const userId = ctx.sender || ctx.from;
        const sessionId = ctx.sessionId || conn._sessionId || 'default';
        const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'DEEP SEARCH');
        try {
            await status.setRows([
                ['Estado', 'gerando queries'],
                ['Consulta', query]
            ]);
            const { results, queries } = await deepSearch(userId, query, sessionId);
            await status.setRows([
                ['Estado', 'buscando fontes'],
                ['Queries', (queries || []).join(' | ')]
            ]);
            if (!results || results.length === 0) {
                await status.finish(formatStatusBlock('DEEP SEARCH', [['Estado', 'nenhum resultado']]));
                return;
            }
            await status.update('Resultado encontrado', String(results.length));

            const rows = [
                labelValue('Consulta', query),
                queries?.length ? labelValue('Queries', queries.join(' | ')) : null,
                labelValue('Resultados', results.length),
                ''
            ].filter((x) => x !== null);

            results.slice(0, 10).forEach((r, i) => {
                rows.push(`${i + 1}. ${r.title}`);
                rows.push(`   ${r.url}`);
                if (r.description) rows.push(`   ${r.description.slice(0, 100)}`);
                rows.push('');
            });
            rows.push(labelValue('Dica', 'relatorio para analise IA'));
            await status.finish(formatReportBlock('DEEP SEARCH', rows));
        } catch (e) {
            logger.logErro('[deepsearch]', e.message);
            await status.finish(formatStatusBlock('DEEP SEARCH', [['Erro', e.message]]));
        }
    }
};

// ===== ANALISAR N =====
commands.analisar = {
    useCtx: true,
    description: "Analisa uma fonte especifica com IA",
    usage: "analisar <numero>",
    execute: async (conn, ctx) => {
        const num = parseInt(ctx.args[0], 10);
        if (!num) {
            return conn.sendMessage(ctx.from, { text: `Uso: ${require('../utils/configManager').prefixFromCtx(ctx)}analisar <numero>` }, { quoted: ctx.info });
        }
        const userId = ctx.sender || ctx.from;
        const sessionId = ctx.sessionId || conn._sessionId || 'default';
        const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'ANALISE');
        try {
            await status.update('Estado', `analisando fonte ${num}`);
            const result = await analyzeSpecific(userId, num, sessionId);
            if (result.error) {
                await status.finish(formatStatusBlock('ANALISE', [['Erro', result.error]]));
                return;
            }
            const rows = [
                labelValue('Fonte', result.result.title),
                labelValue('URL', result.result.url),
                ''
            ];
            if (result.analysis.error) {
                rows.push('Ollama offline. Conteudo da pagina:');
                rows.push('');
                rows.push((result.page.content || '').slice(0, 1500));
            } else if (result.analysis.answer) {
                rows.push(result.analysis.answer);
            }
            await status.finish(formatReportBlock('ANALISE IA', rows));
        } catch (e) {
            logger.logErro('[analisar]', e.message);
            await status.finish(formatStatusBlock('ANALISE', [['Erro', e.message]]));
        }
    }
};

commands.ganalisar = commands.analisar;

// ===== RELATORIO =====
commands.relatorio = {
    useCtx: true,
    description: "Gera relatorio IA completo da pesquisa",
    usage: "relatorio",
    execute: async (conn, ctx) => {
        const userId = ctx.sender || ctx.from;
        const sessionId = ctx.sessionId || conn._sessionId || 'default';
        const status = await createWhatsAppStatus(conn, ctx.from, ctx.info, 'RELATORIO');
        try {
            await status.update('Estado', 'baixando fontes');
            const result = await generateReport(userId, sessionId);
            if (result.error) {
                await status.finish(formatStatusBlock('RELATORIO', [['Erro', result.error]]));
                return;
            }
            await status.update('Estado', 'analisando com IA');
            const text = formatReport(result.query || 'Pesquisa', result.analysis);
            await status.finish(text);
        } catch (e) {
            logger.logErro('[relatorio]', e.message);
            await status.finish(formatStatusBlock('RELATORIO', [['Erro', e.message]]));
        }
    }
};

// ===== GLISTA =====
commands.glista = {
    useCtx: true,
    description: "Lista todos os resultados da pesquisa",
    usage: "glista",
    execute: async (conn, ctx) => {
        const userId = ctx.sender || ctx.from;
        const sessionId = ctx.sessionId || conn._sessionId || 'default';
        const state = getState(userId, sessionId);
        if (!state.results || state.results.length === 0) {
            return conn.sendMessage(ctx.from, { text: "Nenhuma pesquisa salva. Use google/deepsearch primeiro." }, { quoted: ctx.info });
        }
        await conn.sendMessage(ctx.from, { text: formatResults(state.query, state.results) }, { quoted: ctx.info });
    }
};

commands.glist = commands.glista;
commands.googlelista = commands.glista;

// ===== GOPEN N =====
commands.gopen = {
    useCtx: true,
    description: "Abre um resultado especifico",
    usage: "gopen <numero>",
    execute: async (conn, ctx) => {
        const num = parseInt(ctx.args[0], 10);
        if (!num) {
            return conn.sendMessage(ctx.from, { text: `Uso: ${require('../utils/configManager').prefixFromCtx(ctx)}gopen <numero>` }, { quoted: ctx.info });
        }
        const userId = ctx.sender || ctx.from;
        const sessionId = ctx.sessionId || conn._sessionId || 'default';
        const state = getState(userId, sessionId);
        if (!state.results || state.results.length === 0) {
            return conn.sendMessage(ctx.from, { text: "Nenhuma pesquisa salva. Use google/deepsearch primeiro." }, { quoted: ctx.info });
        }
        const r = state.results[num - 1];
        if (!r) {
            return conn.sendMessage(ctx.from, { text: `Resultado ${num} nao encontrado.` }, { quoted: ctx.info });
        }
        await conn.sendMessage(ctx.from, { text: `${r.title}\n\n${r.url}` }, { quoted: ctx.info });
    }
};

// ===== GCOPY N =====
commands.gcopy = {
    useCtx: true,
    description: "Copia o link de um resultado",
    usage: "gcopy <numero>",
    execute: async (conn, ctx) => {
        const num = parseInt(ctx.args[0], 10);
        if (!num) {
            return conn.sendMessage(ctx.from, { text: `Uso: ${require('../utils/configManager').prefixFromCtx(ctx)}gcopy <numero>` }, { quoted: ctx.info });
        }
        const userId = ctx.sender || ctx.from;
        const sessionId = ctx.sessionId || conn._sessionId || 'default';
        const state = getState(userId, sessionId);
        if (!state.results || state.results.length === 0) {
            return conn.sendMessage(ctx.from, { text: "Nenhuma pesquisa salva. Use google/deepsearch primeiro." }, { quoted: ctx.info });
        }
        const r = state.results[num - 1];
        if (!r) {
            return conn.sendMessage(ctx.from, { text: `Resultado ${num} nao encontrado.` }, { quoted: ctx.info });
        }
        await conn.sendMessage(ctx.from, { text: r.url }, { quoted: ctx.info });
    }
};

// ===== GLIMPAR =====
commands.glimpar = {
    useCtx: true,
    description: "Limpa o estado da pesquisa",
    usage: "glimpar",
    execute: async (conn, ctx) => {
        const userId = ctx.sender || ctx.from;
        const sessionId = ctx.sessionId || conn._sessionId || 'default';
        clearState(userId, sessionId);
        await conn.sendMessage(ctx.from, { text: "Pesquisa limpa." }, { quoted: ctx.info });
    }
};

module.exports = { commands };
