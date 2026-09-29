const logger = require("../logger");
const { execFile } = require("child_process");
const { sendInteractiveButtons } = require("../helpers");
const { assertPlatformAdmin } = require("../utils/exploitGate");

const commands = {};

function checkAbInstalled() {
    return new Promise((resolve) => {
        execFile('where', ['ab'], { timeout: 10000 }, (err, stdout) => {
            if (err || !stdout) {
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}

function formatUrlForAb(url) {
    let cleanUrl = url.replace(/^https?:\/\//, '');
    cleanUrl = cleanUrl.replace(/:\d+/, '');
    cleanUrl = cleanUrl.replace(/\/$/, '');
    cleanUrl = cleanUrl + '/';
    return cleanUrl;
}

function isSafeHost(host) {
    return /^[a-zA-Z0-9.-]+\/?$/.test(host);
}

commands.ddos = {
    useCtx: true,
    description: "Teste de estresse usando ApacheBench",
    usage: "ddos <url> [req] [conc]",
    execute: async (conn, ctx) => {
        if (!(await assertPlatformAdmin(conn, ctx, 'ddos'))) return;

        const abInstalled = await checkAbInstalled();
        if (!abInstalled) {
            return sendInteractiveButtons(
                conn,
                ctx.from,
                "ApacheBench (ab) nao encontrado!\n\n" +
                "Para instalar no Termux:\n" +
                "```\npkg install apache2\n```\n\n" +
                "Ou no Linux:\n" +
                "```\nsudo apt install apache2-utils\n```",
                [
                    { id: "menu", label: "Menu" }
                ],
                "Hanork Bot",
                ctx.info
            );
        }

        const args = ctx.args;
        let url = args[0];
        const total = parseInt(args[1]) || 200;
        const concorrencia = parseInt(args[2]) || 20;

        if (!url) {
            const { prefixFromCtx } = require('../utils/configManager');
            const p = prefixFromCtx(ctx);
            return conn.sendMessage(ctx.from, { text: `Use:\n${p}ddos google.com 200 20` }, { quoted: ctx.info });
        }

        const cleanUrl = formatUrlForAb(url);
        const displayUrl = url;

        if (!isSafeHost(cleanUrl)) {
            return conn.sendMessage(ctx.from, { text: "Host invalido. Use apenas dominio simples, sem caracteres especiais." }, { quoted: ctx.info });
        }

        if (total > 5000) return conn.sendMessage(ctx.from, { text: "Maximo: 5000 requisicoes" }, { quoted: ctx.info });
        if (concorrencia > 100) return conn.sendMessage(ctx.from, { text: "Maximo: 100 conexoes simultaneas" }, { quoted: ctx.info });

        await conn.sendMessage(ctx.from, { 
            text: `Testando...\nURL: ${displayUrl}\nRequisicoes: ${total}\nConcorrencia: ${concorrencia}`
        }, { quoted: ctx.info });

        const argsAb = ['-n', String(total), '-c', String(concorrencia), '-H', 'User-Agent: Mozilla/5.0', `http://${cleanUrl}`];
        console.log(`[ddos] Executando ab com args seguros para ${cleanUrl}`);

        execFile('ab', argsAb, { timeout: 60000, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
            if (err) {
                logger.logErro("ddos", err.message);
                
                if (err.message.includes('invalid URL') || stderr.includes('invalid URL')) {
                    const { prefixFromCtx } = require('../utils/configManager');
                    const p = prefixFromCtx(ctx);
                    return sendInteractiveButtons(
                        conn,
                        ctx.from,
                        "URL invalida para o ApacheBench!\n\n" +
                        "Dicas:\n" +
                        "• Use apenas o dominio: `google.com`\n" +
                        "• Nao use protocolo (http:// ou https://)\n" +
                        "• Nao use porta (:80, :443)\n\n" +
                        "Exemplos:\n" +
                        `\`${p}ddos google.com 200 20\`\n` +
                        `\`${p}ddos example.com 100 10\`\n` +
                        `\`${p}ddos github.com 50 5\``,
                        [
                            { id: "menu", label: "Menu" }
                        ],
                        "Hanork Bot",
                        ctx.info
                    );
                }

                if (err.message.includes('SSL') || stderr.includes('SSL') || stderr.includes('TLS')) {
                    const { prefixFromCtx } = require('../utils/configManager');
                    const p = prefixFromCtx(ctx);
                    return sendInteractiveButtons(
                        conn,
                        ctx.from,
                        "Erro de SSL/TLS!\n\n" +
                        "O ApacheBench no Termux tem suporte limitado a HTTPS.\n\n" +
                        "Use HTTP:\n" +
                        `\`${p}ddos google.com 200 20\`\n\n` +
                        "Ou instale o `openssl` para suporte HTTPS:\n" +
                        "```\npkg install openssl\n```",
                        [
                            { id: "menu", label: "Menu" }
                        ],
                        "Hanork Bot",
                        ctx.info
                    );
                }

                return conn.sendMessage(ctx.from, { text: `Erro: ${err.message}` }, { quoted: ctx.info });
            }

            const lines = stdout.split('\n');
            const metrics = [];
            const keywords = ['Requests per second', 'Time per request', 'Failed requests', 'Complete requests', 'Transfer rate', 'Total transferred', 'HTML transferred'];
            
            for (const line of lines) {
                for (const kw of keywords) {
                    if (line.includes(kw)) {
                        metrics.push(line.trim());
                    }
                }
            }

            if (metrics.length === 0) {
                return conn.sendMessage(ctx.from, { text: "Nenhuma metrica encontrada. Verifique a URL." }, { quoted: ctx.info });
            }

            const resultado = metrics.join('\n');

            sendInteractiveButtons(
                conn,
                ctx.from,
                `Resultado do teste\n\n${resultado}`,
                [
                    { id: `ddos ${displayUrl} ${total} ${concorrencia}`, label: "Repetir teste" },
                    { id: "menu", label: "Menu" }
                ],
                "Hanork Bot",
                ctx.info
            );
        });
    }
};

commands.crash = {
    useCtx: true,
    description: "Simula um crash (apenas simulacao)",
    usage: "crash",
    execute: async (conn, ctx) => {
        if (!(await assertPlatformAdmin(conn, ctx, 'crash'))) return;
        await sendInteractiveButtons(
            conn,
            ctx.from,
            "Simulacao de Crash\n\nIsso e apenas uma simulacao. O bot nao vai quebrar de verdade.",
            [
                { id: "crash_confirm", label: "Sim, crashar" },
                { id: "menu", label: "Cancelar" }
            ],
            "Hanork Bot",
            ctx.info
        );
    }
};

commands.travazap = {
    useCtx: true,
    description: "Envia mensagens em sequencia (travazap)",
    usage: "travazap <texto> [quantidade]",
    execute: async (conn, ctx) => {
        if (!(await assertPlatformAdmin(conn, ctx, 'travazap'))) return;
        const parts = ctx.args;
        const texto = parts.slice(0, -1).join(' ') || parts[0] || 'teste';
        const count = parseInt(parts[parts.length-1]) || 5;
        
        await sendInteractiveButtons(
            conn,
            ctx.from,
            `Travazap\n\nTexto: "${texto}"\nQuantidade: ${count}\n\nConfirma o envio?`,
            [
                { id: `travazap_${texto}_${count}`, label: "Enviar" },
                { id: `travazap_${texto}_5`, label: "5 mensagens" },
                { id: `travazap_${texto}_10`, label: "10 mensagens" },
                { id: `travazap_${texto}_20`, label: "20 mensagens" },
                { id: "menu", label: "Cancelar" }
            ],
            "Hanork Bot",
            ctx.info
        );
    }
};

commands.addai = {
    useCtx: true,
    description: "Adiciona IA (Meta AI) ao grupo atual",
    usage: "addai",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) return conn.sendMessage(ctx.from, { text: "Apenas dono." }, { quoted: ctx.info });
        if (!ctx.isGroup) return conn.sendMessage(ctx.from, { text: "Comando apenas em grupos." }, { quoted: ctx.info });
        
        await sendInteractiveButtons(
            conn,
            ctx.from,
            "Adicionar Meta AI\n\nDeseja adicionar a Meta AI a este grupo?",
            [
                { id: "addai_confirm", label: "Adicionar" },
                { id: "menu", label: "Cancelar" }
            ],
            "Hanork Bot",
            ctx.info
        );
    }
};

module.exports = { commands };