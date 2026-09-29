// logger.js — console + arquivo diario (bot_*.log) + erros (errors_*.log)
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "logs");

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LOG_BUFFER_LIMIT = 1000;
const LOG_FLUSH_INTERVAL_MS = 1000;
let logBuffer = [];
let flushing = false;
let flushTimer = null;
let consoleCaptureInstalled = false;
let capturingConsole = false;

function getLogFilePath() {
    return path.join(LOG_DIR, `bot_${new Date().toISOString().split('T')[0]}.log`);
}

function getErrorLogFilePath() {
    return path.join(LOG_DIR, `errors_${new Date().toISOString().split('T')[0]}.log`);
}

/** Serializa Error / qualquer valor pra linha de log */
function formatErrValue(value) {
    if (value == null) return '';
    if (value instanceof Error) {
        const name = value.name || 'Error';
        const msg = value.message || String(value);
        const stack = value.stack ? String(value.stack) : '';
        return stack && stack.includes(msg) ? stack : `${name}: ${msg}${stack ? `\n${stack}` : ''}`;
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch (_) {
            return String(value);
        }
    }
    return String(value);
}

function appendSync(filePath, text) {
    try {
        fs.appendFileSync(filePath, text, 'utf8');
    } catch (e) {
        // evita recursao com console.error capturado
        try {
            process.stderr.write(`[LOGGER] Falha sync append: ${e.message}\n`);
        } catch (_) { /* ignore */ }
    }
}

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushLogs().catch((err) => {
            try {
                process.stderr.write(`[LOGGER] Falha no flush agendado: ${err.message}\n`);
            } catch (_) { /* ignore */ }
        });
    }, LOG_FLUSH_INTERVAL_MS);
}

async function flushLogs() {
    if (flushing || logBuffer.length === 0) return;
    flushing = true;
    const batch = logBuffer.splice(0, logBuffer.length);
    const grouped = new Map();

    for (const entry of batch) {
        const logFile = getLogFilePath();
        if (!grouped.has(logFile)) grouped.set(logFile, []);
        grouped.get(logFile).push(entry);
    }

    try {
        for (const [logFile, entries] of grouped.entries()) {
            await fs.promises.appendFile(logFile, entries.join(''), 'utf8');
        }
    } catch (e) {
        try {
            process.stderr.write(`[LOGGER] Falha ao gravar logs em arquivo: ${e.message}\n`);
        } catch (_) { /* ignore */ }
        try {
            appendSync(getLogFilePath(), batch.join(''));
        } catch (_) { /* ignore */ }
    } finally {
        flushing = false;
        if (logBuffer.length > 0) scheduleFlush();
    }
}

/**
 * @param {string} message
 * @param {{ level?: 'error'|'warn'|'info', immediate?: boolean }} [opts]
 */
function maskLogPayload(raw) {
    let t = String(raw || '');
    t = t.replace(
        /[A-Za-z0-9._-]{5,}@(?:s\.whatsapp\.net|lid|g\.us|newsletter|broadcast)\b/gi,
        (m) => {
            const at = m.lastIndexOf('@');
            const user = m.slice(0, at);
            const host = m.slice(at + 1);
            const tail = user.slice(-4);
            return `***${tail}@${host}`;
        }
    );
    t = t.replace(/([?&](?:q|query|cpf|cnpj|phone|tel|nome|doc|chave)=)[^&\s]+/gi, '$1***');
    return t;
}

function writeToFile(message, opts = {}) {
    try {
        const timestamp = new Date().toISOString();
        let payload = maskLogPayload(String(message || ''));
        if (payload.length > 1600) payload = payload.slice(0, 1600) + '…';
        const line = `[${timestamp}] ${payload}\n`;
        const deadSocket = /\[DIV-AUTO\].*sem socket vivo/i.test(payload);
        const isError = !deadSocket && (opts.level === 'error' || opts.immediate === true);

        if (isError) {
            // Erros: sync imediato no arquivo de erros + fila do bot diario
            appendSync(getErrorLogFilePath(), line);
            appendSync(getLogFilePath(), line);
            return;
        }

        if (logBuffer.length >= LOG_BUFFER_LIMIT) {
            logBuffer.shift();
            try {
                process.stderr.write('[LOGGER] Buffer cheio, descartando log mais antigo\n');
            } catch (_) { /* ignore */ }
        }
        logBuffer.push(line);
        if (logBuffer.length >= 50) {
            flushLogs().catch(() => {});
        } else {
            scheduleFlush();
        }
    } catch (e) {
        try {
            process.stderr.write(`[LOGGER] Falha ao enfileirar log: ${e.message}\n`);
        } catch (_) { /* ignore */ }
    }
}

async function shutdownLogger() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    await flushLogs();
}

// Flush no encerramento — NAO chama process.exit (index.js cuida do shutdown)
process.once('beforeExit', () => {
    try { flushLogs(); } catch (_) { /* ignore */ }
});
process.once('exit', () => {
    try {
        if (logBuffer.length) appendSync(getLogFilePath(), logBuffer.splice(0).join(''));
    } catch (_) { /* ignore */ }
});

const IGNORAR_ERROS = ['DECRYPT'];

const cores = {
    titulo: chalk.bold.cyan,
    destaque: chalk.yellow,
    sucesso: chalk.green,
    erro: chalk.red,
    info: chalk.blue,
    aviso: chalk.yellow,
    cinza: chalk.gray,
    magenta: chalk.magenta,
    cyan: chalk.cyan,
    verde: chalk.green,
    vermelho: chalk.red,
    branco: chalk.white,
    negrito: chalk.bold
};

function logEvento(type, count) {
    const msg = `[${type.toUpperCase()}] ${count} mensagem${count > 1 ? 's' : ''}`;
    console.log(chalk.blue(`📨 ${msg}`));
    writeToFile(`[EVENTO] ${type} | ${count} msgs`);
}

function logComando(command, sender, isDono) {
    const donoStatus = isDono ? chalk.green("✓") : chalk.red("✗");
    const msg = `${chalk.cyan(command)} | ${chalk.yellow(sender)} | ${donoStatus}`;
    console.log(`⚡ ${msg}`);
    writeToFile(`[COMANDO] ${command} | ${sender} | Dono: ${isDono}`);
}

function logIgnorado(command, sender) {
    const msg = `${chalk.gray(command)} | ${chalk.gray(sender)} (não autorizado)`;
    console.log(`⛔ ${msg}`);
    writeToFile(`[IGNORADO] ${command} | ${sender}`);
}

function logBotao(tipo, id, sender) {
    const msg = `${chalk.magenta(tipo)} | ${chalk.cyan(id)} | ${chalk.yellow(sender)}`;
    console.log(`🔘 ${msg}`);
    writeToFile(`[BOTAO] ${tipo} | ${id} | ${sender}`);
}

function logAcaoBotao(id) {
    const msg = `${chalk.green('Ação:')} ${chalk.cyan(id)}`;
    console.log(`🔄 ${msg}`);
    writeToFile(`[HANDLE] ${id}`);
}

/**
 * Log de erro → console + bot_*.log + errors_*.log (sync).
 * Aceita: logErro('TIPO', err) | logErro('msg unica') | logErro('TIPO', 'texto')
 */
function logErro(tipo, erro) {
    let tag = String(tipo || 'ERRO');
    let detail = erro;

    if (arguments.length === 1) {
        detail = tipo;
        tag = 'ERRO';
    }

    if (IGNORAR_ERROS.includes(tag) && (!detail || String(detail).includes('dados invalidos'))) {
        return;
    }

    const detailText = formatErrValue(detail);
    const short = detailText.split('\n')[0].slice(0, 300);
    const msg = `${chalk.red(`❌ ${tag}`)}: ${chalk.white(short)}`;
    console.log(msg);
    writeToFile(`[ERRO] ${tag} | ${detailText}`, { level: 'error', immediate: true });
}

/**
 * Erro com contexto (comando, session, etc.) — stack completa no arquivo.
 */
function logException(scope, err, meta = {}) {
    const tag = String(scope || 'EXCEPTION');
    const metaStr = Object.entries(meta || {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : formatErrValue(v)}`)
        .join(' ');
    const body = formatErrValue(err);
    const short = body.split('\n')[0].slice(0, 300);
    console.log(`${chalk.red(`❌ ${tag}`)}: ${chalk.white(short)}${metaStr ? chalk.gray(` | ${metaStr}`) : ''}`);
    writeToFile(
        `[ERRO] ${tag} | ${metaStr ? `${metaStr} | ` : ''}${body}`,
        { level: 'error', immediate: true }
    );
}

/**
 * Quando o bot envia mensagem de erro ao usuario — espelha no arquivo.
 */
function logUserFacingError(scope, userText, meta = {}) {
    const tag = String(scope || 'USER_ERROR');
    const text = String(userText || '').slice(0, 500);
    const metaStr = Object.entries(meta || {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
    writeToFile(
        `[USER_ERROR] ${tag} | ${metaStr ? `${metaStr} | ` : ''}${text}`,
        { level: 'error', immediate: true }
    );
}

function logInfo(texto) {
    const msg = `${chalk.cyan(`ℹ️ ${texto}`)}`;
    console.log(msg);
    writeToFile(`[INFO] ${texto}`);
}

function logSucesso(texto) {
    const msg = `${chalk.green(`✅ ${texto}`)}`;
    console.log(msg);
    writeToFile(`[SUCESSO] ${texto}`);
}

function logAviso(texto) {
    const msg = `${chalk.yellow(`⚠️ ${texto}`)}`;
    console.log(msg);
    writeToFile(`[AVISO] ${texto}`);
}

function logStatus(online) {
    const status = online ? chalk.green.bold("🟢 ONLINE") : chalk.red.bold("🔴 OFFLINE");
    console.log(`\n${status}\n`);
    writeToFile(`[STATUS] ${online ? 'ONLINE' : 'OFFLINE'}`, { level: online ? 'info' : 'warn' });
}

function logSeparador() {
    console.log(chalk.gray(" ".repeat(60)));
}

function logTitulo(texto) {
    console.log(`\n${chalk.bold.cyan(texto)}\n`);
}

function logLatency(ms) {
    const color = ms < 200 ? chalk.green : ms < 500 ? chalk.yellow : chalk.red;
    console.log(`⏱️ Latência: ${color(ms + 'ms')}`);
}

function logMemoria(uso) {
    console.log(`🧠 Memória: ${chalk.cyan(uso)} MB`);
}

function logBanner(info) {
    const {
        numero,
        dispositivo,
        prefixo,
        donos,
        vips,
        versaoProtocolo,
        sessionStatus,
        uptime,
        messagesCount,
        commandsCount,
        backupPath
    } = info;

    console.clear();

    console.log(chalk.bold.magenta("\n  H A N O R K   B O T  \n"));

    console.log(chalk.bold.cyan("  STATUS DO BOT"));
    console.log(chalk.cyan(`  Número:       ${chalk.yellow(numero || "N/A")}`));
    console.log(chalk.cyan(`  Dispositivo:  ${chalk.yellow(dispositivo || "N/A")}`));
    console.log(chalk.cyan(`  Prefixo:      ${chalk.yellow(prefixo || "•")}`));
    console.log(chalk.cyan(`  Protocolo:    ${chalk.yellow(versaoProtocolo || "N/A")}`));
    console.log(chalk.cyan(`  Sessão:       ${sessionStatus ? chalk.green("Ativa") : chalk.red("Nova")}`));

    const donosList = donos && donos.length > 0 ? donos.map(d => `    • ${d}`).join("\n") : "    • Nenhum";
    const vipsList = vips && vips.length > 0 ? vips.map(v => `    • ${v}`).join("\n") : "    • Nenhum";

    console.log(chalk.bold.magenta("\n  DONOS E PERMISSÕES"));
    console.log(chalk.magenta(`  👑 Donos:`));
    console.log(chalk.magenta(donosList));
    console.log(chalk.magenta(`  ⭐ VIPs:`));
    console.log(chalk.magenta(vipsList));

    console.log(chalk.bold.green("\n  ESTATÍSTICAS"));
    console.log(chalk.green(`  Mensagens:    ${chalk.yellow(messagesCount || 0)}`));
    console.log(chalk.green(`  Comandos:     ${chalk.yellow(commandsCount || 0)}`));
    console.log(chalk.green(`  Uptime:       ${chalk.yellow(uptime || "0s")}`));
    console.log(chalk.green(`  Memória:      ${chalk.yellow(Math.round(process.memoryUsage().rss / 1024 / 1024) + " MB")}`));

    if (backupPath) {
        console.log(chalk.gray(`\n  💾 Backup: ${chalk.cyan(backupPath)}`));
    }

    console.log(chalk.gray(`\n  📅 ${new Date().toLocaleString()}\n`));
    writeToFile(`[BANNER] numero=${numero || 'N/A'} prefixo=${prefixo || '.'} sessao=${sessionStatus ? 'ativa' : 'nova'}`);
}

function logFlow(stage, data = {}) {
    const details = Object.entries(data)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
    const msg = `[FLOW] ${stage}${details ? ` | ${details}` : ''}`;
    console.log(chalk.gray(msg));
    writeToFile(msg);
}

function logPerf(scope, data = {}) {
    const details = Object.entries(data)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
    const msg = `[PERF] ${scope}${details ? ` | ${details}` : ''}`;
    console.log(chalk.magenta(msg));
    writeToFile(msg);
}

function logDebug(texto) {
    if (String(process.env.LOG_DEBUG || '') !== '1') return;
    const msg = `${chalk.gray(`🔍 ${texto}`)}`;
    console.log(msg);
    writeToFile(`[DEBUG] ${texto}`);
}

const CONSOLE_NOISE_RE = /Bad MAC|Session error:Error: Bad MAC|Failed to decrypt message with any known session|MessageCounterError|Key used already or never filled|rate-overlimit|Timed Out|Timeout of \d+ms|Connection Closed|item-not-found|conflict|PreKeyError|No matching sessions|Closing open session|stream:error|Connection Terminated|status@broadcast/i;

const errorBurstAt = new Map();
function allowErrorBurst(text) {
    const key = String(text || '').replace(/\s+/g, ' ').slice(0, 96);
    if (!key) return false;
    const now = Date.now();
    const last = errorBurstAt.get(key) || 0;
    if (now - last < 8000) return false;
    errorBurstAt.set(key, now);
    if (errorBurstAt.size > 400) {
        for (const [k, t] of errorBurstAt) {
            if (now - t > 60000) errorBurstAt.delete(k);
        }
    }
    return true;
}

/**
 * Espelha console.error / console.warn no arquivo de logs (todo o processo).
 */
function installConsoleCapture() {
    if (consoleCaptureInstalled) return;
    consoleCaptureInstalled = true;

    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);

    console.error = (...args) => {
        if (!capturingConsole) {
            capturingConsole = true;
            try {
                const text = args.map((a) => formatErrValue(a)).join(' ');
                if (CONSOLE_NOISE_RE.test(text)) {
                    capturingConsole = false;
                    return;
                }
                if (!text || text.startsWith('[LOGGER]')) {
                    capturingConsole = false;
                    return origError(...args);
                }
                if (!allowErrorBurst(text)) {
                    capturingConsole = false;
                    return;
                }
                writeToFile(`[CONSOLE.ERROR] ${text}`, { level: 'warn' });
            } catch (_) { /* ignore */ }
            capturingConsole = false;
        }
        return origError(...args);
    };

    console.warn = (...args) => {
        if (!capturingConsole) {
            capturingConsole = true;
            try {
                const text = args.map((a) => formatErrValue(a)).join(' ');
                if (/Closing open session in favor of incoming prekey|Decrypted message with closed session/i.test(text)) {
                    capturingConsole = false;
                    return;
                }
                if (text && !text.startsWith('[LOGGER]')) {
                    writeToFile(`[CONSOLE.WARN] ${text}`, { level: 'warn' });
                }
            } catch (_) { /* ignore */ }
            capturingConsole = false;
        }
        return origWarn(...args);
    };
}

/**
 * Handlers globais (idempotente). Stack completa no arquivo.
 */
function installProcessHandlers(onFatal) {
    if (global.__hanorkProcessHandlers) return;
    global.__hanorkProcessHandlers = true;

    process.on('uncaughtException', (error) => {
        logException('UNCAUGHT_EXCEPTION', error);
        // Nao onFatal/exit: throw do Baileys/libsignal derrubava o egg.
    });

    process.on('unhandledRejection', (reason) => {
        const msg = String(reason && reason.message ? reason.message : reason || '');
        if (/rate-overlimit|item-not-found|Connection Closed|conflict/i.test(msg)) {
            if (!global.__hanorkOlLogAt || Date.now() - global.__hanorkOlLogAt > 30000) {
                global.__hanorkOlLogAt = Date.now();
                logAviso(`[UNHANDLED] ruido WA ${msg.slice(0, 80)} (omito repeticao 30s)`);
            }
            return;
        }
        logException('UNHANDLED_REJECTION', reason instanceof Error ? reason : new Error(formatErrValue(reason)));
    });
}

// Captura automatica assim que o logger e carregado
installConsoleCapture();

module.exports = {
    logEvento,
    logComando,
    logIgnorado,
    logBotao,
    logAcaoBotao,
    logErro,
    logException,
    logUserFacingError,
    logInfo,
    logSucesso,
    logAviso,
    logDebug,
    logStatus,
    logSeparador,
    logTitulo,
    logLatency,
    logMemoria,
    logBanner,
    logFlow,
    logPerf,
    flushLogs,
    shutdownLogger,
    getLogFilePath,
    getErrorLogFilePath,
    maskLogPayload,
    formatErrValue,
    installConsoleCapture,
    installProcessHandlers,
    LOG_DIR,
    cores
};
