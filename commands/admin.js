const { requireSessionOwner } = require('../utils/authorization');
const logger = require("../logger");
const { clearSession, repairSession, backupSession, restoreSession, exportSession, importSession } = require("../sessionManager");
const { downloadMediaMessage } = require("@systemzero/baileys");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { delay } = require("../utils");
const { sendInteractiveButtons } = require("../helpers");

const commands = {};

// commands/admin.js (adicionar)
commands.clearlogs = {
    // ...
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const logDir = path.join(__dirname, "../logs");
        const files = await fs.promises.readdir(logDir);
        await Promise.all(files.map((file) => fs.promises.unlink(path.join(logDir, file)).catch(() => {})));
        await conn.sendMessage(ctx.from, { text: "Logs limpos." }, { quoted: ctx.info });
    }
};

commands.clearsession = {
    description: "Limpa a sessao (desloga)",
    usage: "clearsession",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        await sendInteractiveButtons(
            conn,
            from,
            "Tem certeza que deseja limpar a sessao? Isso ira deslogar o bot.",
            [
                { id: "clearsession_confirm", label: "Confirmar" },
                { id: "menu", label: "Cancelar" }
            ],
            "Hanork Bot",
            info
        );
    }
};

commands.badmac = {
    description: "Verifica/limpa sessoes com Bad MAC error",
    usage: "badmac [clear]",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        const { badMacHandler } = require('@systemzero/baileys');
        if (q === 'clear') {
            badMacHandler.clearProblematicSessionFiles();
            await conn.sendMessage(from, { text: "Arquivos de sessao problematicos limpos." }, { quoted: info });
        } else {
            const hasBad = badMacHandler.isBadMacError(new Error('Teste Bad MAC (falso)'));
            await conn.sendMessage(from, { text: `Bad MAC handler disponivel: ${typeof badMacHandler.handleError === 'function'}` }, { quoted: info });
        }
    }
};

commands.repairsession = {
    description: "Repara a sessao (tenta corrigir corrupcao)",
    usage: "repairsession",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        const result = repairSession(conn._sessionId);
        const mensagem = result ? "Sessao valida." : "Sessao corrompida, limpa.";
        await sendInteractiveButtons(
            conn,
            from,
            mensagem,
            [
                { id: "repairsession_again", label: "Reparar novamente" },
                { id: "menu", label: "Menu" }
            ],
            "Hanork Bot",
            info
        );
    }
};

commands.backupsession = {
    description: "Faz backup da sessao atual",
    usage: "backupsession",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        const result = backupSession(conn._sessionId);
        const mensagem = result ? "Backup criado." : "Falha no backup.";
        await sendInteractiveButtons(
            conn,
            from,
            mensagem,
            [
                { id: "backupsession_again", label: "Fazer outro backup" },
                { id: "menu", label: "Menu" }
            ],
            "Hanork Bot",
            info
        );
    }
};

commands.restoresession = {
    description: "Restaura sessao de um backup (forneca o caminho)",
    usage: "restoresession <caminho do backup>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!q) return conn.sendMessage(from, { text: "Caminho do backup." }, { quoted: info });
        const result = restoreSession(conn._sessionId, q);
        const mensagem = result ? "Sessao restaurada." : "Falha.";
        await conn.sendMessage(from, { text: mensagem }, { quoted: info });
        if (result) setTimeout(() => process.exit(0), 2000);
    }
};

commands.exportsession = {
    description: "Exporta a sessao (JSON)",
    usage: "exportsession",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        const creds = exportSession(conn._sessionId);
        if (creds) {
            await conn.sendMessage(from, { document: Buffer.from(creds, 'utf-8'), fileName: "session_export.json", mimetype: "application/json" }, { quoted: info });
        } else {
            await conn.sendMessage(from, { text: "Falha na exportacao." }, { quoted: info });
        }
    }
};

commands.importsession = {
    description: "Importa sessao de um arquivo JSON (responda o arquivo)",
    usage: "importsession (responda um arquivo .json)",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        const quotedMsg = info.message?.documentMessage;
        if (!quotedMsg) return conn.sendMessage(from, { text: "Responda a um arquivo JSON." }, { quoted: info });
        try {
            const buffer = await downloadMediaMessage({ message: quotedMsg }, "buffer", {}, {});
            const json = buffer.toString("utf-8");
            const result = importSession(conn._sessionId, json);
            const mensagem = result ? "Sessao importada. Reinicie." : "Falha.";
            await conn.sendMessage(from, { text: mensagem }, { quoted: info });
            if (result) setTimeout(() => process.exit(0), 2000);
        } catch (e) {
            logger.logErro("importsession", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.logs = {
    description: "Mostra os ultimos logs",
    usage: "logs [linhas]",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        try {
            // Cap duro: nunca despejar arquivo inteiro no chat
            let n = parseInt(String(q || args?.[0] || ''), 10);
            if (!Number.isFinite(n) || n < 1) n = 15;
            if (n > 40) n = 40;

            const logPath = path.join(__dirname, "../logs");
            if (!fs.existsSync(logPath)) {
                return conn.sendMessage(from, { text: "Pasta de logs vazia." }, { quoted: info });
            }
            const files = (await fs.promises.readdir(logPath)).filter((f) => f.endsWith('.log') || f.endsWith('.txt')).sort();
            // Preferir errors_*.log (falhas) — senao bot_*.log mais recente
            const errorFiles = files.filter((f) => f.startsWith('errors_'));
            const botFiles = files.filter((f) => f.startsWith('bot_'));
            const lastLog = (errorFiles.length && errorFiles[errorFiles.length - 1])
                || (botFiles.length && botFiles[botFiles.length - 1])
                || files[files.length - 1];
            if (!lastLog) return conn.sendMessage(from, { text: "Nenhum log." }, { quoted: info });
            const content = await fs.promises.readFile(path.join(logPath, lastLog), "utf-8");
            const sliced = content.split("\n").slice(-n).join("\n");
            // Limite WA ~4000; corta com margem
            const body = sliced.length > 2800 ? sliced.slice(-2800) : sliced;
            const txt = `Ultimos ${n} logs (${lastLog})\nArquivo: logs/${lastLog}\n\n${body}`;

            await sendInteractiveButtons(
                conn,
                from,
                txt,
                [
                    { id: "logs 10", label: "10 linhas" },
                    { id: "logs 20", label: "20 linhas" },
                    { id: "logs 40", label: "40 linhas" },
                    { id: "menu_admin", label: "Menu Admin" },
                    { id: "menu", label: "Menu" }
                ],
                "Hanork Bot",
                info
            );
        } catch (e) {
            logger.logException("logs", e);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.rr = {
    description: "Reinicia o bot",
    usage: "rr",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        await sendInteractiveButtons(
            conn,
            from,
            "Tem certeza que deseja reiniciar o bot?",
            [
                { id: "rr_confirm", label: "Sim, reiniciar" },
                { id: "menu", label: "Cancelar" }
            ],
            "Hanork Bot",
            info
        );
    }
};

commands.tentativasinjecao = {
    useCtx: true,
    description: "Ultimas tentativas de injecao detectadas (so dono)",
    usage: "tentativasinjecao",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) {
            return conn.sendMessage(ctx.from, { text: "Apenas o dono da sessao." }, { quoted: ctx.info });
        }
        const { formatInjectionLog } = require('../utils/promptInjection');
        const n = parseInt(String(ctx.text || '').trim(), 10);
        const body = formatInjectionLog(ctx.telegramUserId, Number.isFinite(n) && n > 0 ? n : 15);
        await conn.sendMessage(ctx.from, { text: body.slice(0, 3500) }, { quoted: ctx.info });
    }
};
commands.injectlog = commands.tentativasinjecao;
commands.injecoes = commands.tentativasinjecao;

module.exports = { commands };