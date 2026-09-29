// index.js
require('dotenv').config();

// libsignal dumpa SessionEntry inteiro (chaves) no console — silencia
(function patchLibsignalNoise() {
  const origInfo = console.info.bind(console);
  console.info = (...args) => {
    const a0 = args[0];
    if (a0 === 'Closing session:' || (typeof a0 === 'string' && a0.startsWith('Closing session'))) {
      return;
    }
    return origInfo(...args);
  };
})();

const logger = require('./logger');
logger.installConsoleCapture(); // garante captura mesmo se outro modulo carregou logger antes
const fs = require('fs');
const path = require('path');
const { startHealthServer, stopHealthServer, setHealthProviders } = require('./services/healthServer');

// Bind health BEFORE heavy requires — senão o egg mata o processo no "starting"
// (SERVER_PORT / "listening on") enquanto ainda carrega commands/telegramBot.
try {
    startHealthServer();
} catch (e) {
    logger.logAviso(`[HEALTH] falha ao iniciar (early): ${e.message}`);
}

process.on('uncaughtException', (error) => {
    try { fs.writeSync(1, `[BOOT_CRASH] ${error && error.stack ? error.stack : error}\n`); } catch (_) {}
    try { logger.logException('UNCAUGHT_EXCEPTION', error); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
    const msg = String(reason && reason.message ? reason.message : reason || '');
    // Ruido WA (chip morto / reconnect). O handler de baixo tambem filtra;
    // se nao filtrar aqui, cada rate-overlimit vira UNHANDLED no log.
    if (/rate-overlimit|item-not-found|Connection Closed|conflict/i.test(msg)) return;
    const err = reason instanceof Error ? reason : new Error(String(reason || ''));
    try { fs.writeSync(1, `[BOOT_REJ] ${err.stack || err.message}\n`); } catch (_) {}
    try { logger.logException('UNHANDLED_REJECTION', err); } catch (_) {}
});

let connect;
let setupHandlers;
let setupEventListeners;
let carregarConfig;
let salvarConfig;
let ADMIN_IDS;
let ensureUserDir;
let getAllSessions;
let restoreAllSessions;
let telegramBot;
let activeConnections;
let releaseInstanceLock;
let startTelegramPolling;
try {
    ({ connect } = require('./connection'));
    ({ setupHandlers } = require('./handlers/messageHandler'));
    ({ setupEventListeners } = require('./handlers/eventHandler'));
    ({ carregarConfig, salvarConfig } = require('./utils/configManager'));
    ({ ADMIN_IDS, ensureUserDir } = require('./utils/userManager'));
    ({ getAllSessions } = require('./utils/sessionRegistry'));
    ({
        restoreAllSessions,
        bot: telegramBot,
        activeConnections,
        releaseInstanceLock,
        startTelegramPolling
    } = require('./telegramBot'));
} catch (e) {
    const s = e && e.stack ? e.stack : String(e);
    try { fs.writeSync(1, `[BOOT_REQUIRE] ${s}\n`); } catch (_) {}
    logger.logErro(`[BOOT_REQUIRE] ${s}`);
}
try {
    require('./utils/memoryWatch').startMemoryWatch();
} catch (e) {
    logger.logAviso(`[MEM] watch: ${e.message}`);
}

try {
  require('./utils/sqlStore').initSqlStore();
} catch (e) {
  logger.logAviso(`[sqlStore] boot: ${e.message}`);
}
try {
  require('./services/billing').startJobs();
} catch (e) {
  logger.logAviso(`[billing] boot: ${e.message}`);
}
try {
  try {
    require('./services/opsJobs').startJobs();
  } catch (e) {
    logger.logAviso(`[opsJobs] ${e.message}`);
  }
  try {
    require('./utils/dbBackup').startDbBackupScheduler();
  } catch (e) {
    logger.logAviso(`[DB_BACKUP] ${e.message}`);
  }
} catch (e) {
  logger.logAviso(`[ops] boot: ${e.message}`);
}

try {
  const gm = require('./utils/groupManager');
  gm.healOnBoot().catch((e) => logger.logAviso(`[gm] heal: ${e.message}`));
} catch (e) {
  logger.logAviso(`[gm] boot: ${e.message}`);
}

let shuttingDown = false;


// ===== MIGRAÇÃO DA CONFIGURAÇÃO LEGADA =====
function migrateLegacyConfig(adminId) {
    const legacyConfigPath = path.join(__dirname, 'database/config.json');
    const adminConfigPath = path.join(__dirname, 'data/users', adminId, 'config/config.json');

    // Se já existir config do admin, não migrar
    if (fs.existsSync(adminConfigPath)) {
        logger.logInfo('Config do admin já existe. Migração ignorada.');
        return;
    }

    // Se existir config legada, copiar
    if (fs.existsSync(legacyConfigPath)) {
        try {
            const legacyConfig = JSON.parse(fs.readFileSync(legacyConfigPath, 'utf-8'));
            // Garante que o admin tenha seus próprios owners
            if (!legacyConfig.owners || legacyConfig.owners.length === 0) {
                // Tenta recuperar do antigo module.exports (fallback)
                try {
                    const oldDonos = require('./handlers/messageHandler').DONO || [];
                    if (oldDonos.length) legacyConfig.owners = oldDonos;
                } catch {}
            }
            // Salva no diretório do admin
            const adminDir = path.dirname(adminConfigPath);
            if (!fs.existsSync(adminDir)) fs.mkdirSync(adminDir, { recursive: true });
            fs.writeFileSync(adminConfigPath, JSON.stringify(legacyConfig, null, 2));
            logger.logSucesso(`Config legada migrada para o admin ${adminId}`);
        } catch (e) {
            logger.logErro('MIGRAÇÃO', e.message);
        }
    } else {
        // Cria config padrão para o admin
        const defaultConfig = { prefix: '.', owners: [adminId], vips: [], blacklist: [] };
        const adminDir = path.dirname(adminConfigPath);
        if (!fs.existsSync(adminDir)) fs.mkdirSync(adminDir, { recursive: true });
        fs.writeFileSync(adminConfigPath, JSON.stringify(defaultConfig, null, 2));
        logger.logInfo(`Config padrão criada para o admin ${adminId}`);
    }
}

// ===== FUNÇÃO PRINCIPAL =====
let heartbeatInterval = null; // Para limpeza adequada

async function main() {
    logger.logTitulo('INICIANDO HANORK BOT - MULTIUSER');

    // 1. Determinar o admin principal
    const adminId = (ADMIN_IDS && ADMIN_IDS[0]) || 'admin_padrao';
    if (!ADMIN_IDS || ADMIN_IDS.length === 0) {
        logger.logAviso('Nenhum ADMIN_ID definido. Use TELEGRAM_ADMIN_IDS no .env ou defina manualmente.');
        logger.logAviso('Usando "admin_padrao" como fallback. Configure corretamente para produção.');
    }

    // 2. Garantir diretório do admin e migrar config
    ensureUserDir(adminId);
    migrateLegacyConfig(adminId);
    try {
        const n = require('./utils/configManager').compactAllUserOwners();
        if (n) logger.logInfo(`[owners] compactou ${n} config(s) — 1 pessoa = 1 dono`);
    } catch (e) {
        logger.logAviso(`[owners] compact: ${e.message}`);
    }
    try {
        const ops = require('./utils/bootOpsOnce').runBootOpsOnce();
        if (ops && ops.ran) logger.logInfo('[BOOT_OPS] flag owners-32 processada');
    } catch (e) {
        logger.logAviso(`[BOOT_OPS] ${e.message}`);
    }

    // 2b. Ollama sidecar (llama.cpp) + warmup. Sem binario: skip — intent usa ZT
    try {
        const sidecar = require('./services/ollamaSidecar');
        sidecar.ensureOllamaSidecar().then((ok) => {
            if (!ok) return;
            try {
                require('./services/ollamaService').warmOllamaIntent().catch(() => {});
            } catch (_) { /* ignore */ }
        }).catch(() => {});
    } catch (_) { /* ignore */ }

    // 3. Restaurar todas as sessões salvas (via TelegramBot)
    await restoreAllSessions();

    // Restaura modo OFF (encaminhada) a partir do registry persistido
    try {
        const { restoreForwardModesFromRegistry } = require('./utils/channelForward');
        restoreForwardModesFromRegistry();
    } catch (e) {
        logger.logErro('[BOOT] restoreForwardModes:', e.message);
    }

    // Fila Bull/Redis (T5) — fallback in-process se REDIS_URL ausente
    try {
        const { initJobQueue, registerJobHandler } = require('./services/jobQueue');
        await initJobQueue();
        const { handleDivAutoJob, restoreAllAutoSchedulers } = require('./utils/divulgacaoAuto');
        registerJobHandler('div-auto', handleDivAutoJob);
        restoreAllAutoSchedulers();
    } catch (e) {
        logger.logAviso(`[BOOT] jobQueue: ${e.message}`);
    }

    // 4. Opcional: conectar uma sessão via terminal (modo legado) se o admin quiser
    // Descomente as linhas abaixo se quiser que o bot inicie automaticamente uma sessão
    // para o admin via terminal. Isso fará com que o bot se comporte como antes.
    /*
    try {
        const sessionId = `admin_terminal_${Date.now()}`;
        const conn = await connect({ sessionId, telegramUserId: adminId, connectionMethod: 'terminal' });
        setupHandlers(conn, sessionId, adminId);
        setupEventListeners(conn, sessionId, adminId);
        logger.logSucesso('Sessão terminal do admin conectada.');
    } catch (e) {
        logger.logErro('CONNECT_TERMINAL', e.message);
    }
    */

    // 5. Iniciar polling Telegram (após restore — require não inicia mais sozinho)
    if (telegramBot && typeof startTelegramPolling === 'function') {
        try {
            await startTelegramPolling();
            logger.logInfo('Bot Telegram ativo e aguardando comandos.');
        } catch (e) {
            logger.logErro('[BOOT] startTelegramPolling', e.message);
        }
    } else {
        logger.logAviso('Bot Telegram não iniciado (token não configurado).');
    }

    // 6. Estatísticas finais
    const totalSessions = getAllSessions().length;
    logger.logSucesso('Sistema multi-sessão inicializado.');
    logger.logInfo(`ADMIN ID: ${adminId}`);
    logger.logInfo(`Sessões ativas (registradas): ${totalSessions}`);
    logger.logInfo(`Limite global: ${require('./utils/sessionRegistry').MAX_SESSIONS}`);

    // 7. Health HTTP (supervisão 24/7) + heartbeat de logs
    setHealthProviders({
        getSessions: () => getAllSessions(),
        getSocketCount: () => (activeConnections ? activeConnections.size : 0),
        getQueueStats: () => {
            try {
                const handlerStats = require('./handlers/messageHandler').getHandlerQueueStats();
                const { getQueueStats } = require('./services/jobQueue');
                return { sessions: handlerStats, jobs: getQueueStats() };
            } catch (_) {
                return { sessions: [], jobs: null };
            }
        },
        getOllamaHealth: () => {
            try {
                return require('./services/ollamaService').getOllamaHealth();
            } catch (_) {
                return { available: false, checked: false, ok: false };
            }
        }
    });
    try {
        startHealthServer();
    } catch (e) {
        logger.logAviso(`[HEALTH] falha ao iniciar: ${e.message}`);
    }

    const HEARTBEAT_INTERVAL = 300000; // 5 minutos
    const startTime = Date.now();
    let heartbeatTicks = 0;
    
    heartbeatInterval = setInterval(() => {
        heartbeatTicks += 1;
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const sessions = getAllSessions();
        const activeCount = sessions.filter(s => s.status === 'connected').length;
        const connectingCount = sessions.filter(s => s.status === 'connecting').length;
        const errorCount = sessions.filter(s => s.status === 'error').length;
        
        // Monitoramento de memória e CPU
        const memUsage = process.memoryUsage();
        const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const memTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
        const memExternalMB = Math.round(memUsage.external / 1024 / 1024);
        const memRSSMB = Math.round(memUsage.rss / 1024 / 1024);
        
        const cpuUsage = process.cpuUsage();
        const cpuUserS = (cpuUsage.user / 1e6).toFixed(1);
        const cpuSystemS = (cpuUsage.system / 1e6).toFixed(1);

        logger.logInfo(`[HEARTBEAT] uptime=${uptime}s sessions=${sessions.length} connected=${activeCount} connecting=${connectingCount} error=${errorCount} mem_heap=${memUsedMB}MB/${memTotalMB}MB mem_external=${memExternalMB}MB mem_rss=${memRSSMB}MB cpu_user=${cpuUserS}s cpu_system=${cpuSystemS}s`);

        try {
            const qs = require('./handlers/messageHandler').getHandlerQueueStats();
            const stuck = (qs || []).filter((s) =>
                (s.execPending || 0) + (s.execActive || 0) + (s.execNoisePending || 0) > 0
            );
            if (stuck.length) {
                logger.logAviso(
                    `[PIPE] platform=heartbeat cmd=queue duration=0 status=drain ${stuck.map((s) =>
                        `sid=${s.sessionId} active=${s.execActive} pend=${s.execPending} noise=${s.execNoisePending}`
                    ).join(' ')}`
                );
            }
        } catch (_) { /* ignore */ }

        try {
            const mw = require('./utils/memoryWatch');
            if (mw.isRssHigh() && (heartbeatTicks === 1 || heartbeatTicks % 6 === 0)) {
                logger.logAviso(`[ALERTA] RSS ${memRSSMB}MB >= teto pair ${mw.rssPairMaxMb()}MB — pair novo recusado`);
            }
        } catch (_) { /* ignore */ }

        if (sessions.length >= 1 && activeCount === 0 && (heartbeatTicks === 1 || heartbeatTicks % 6 === 0)) {
            logger.logAviso(`[ALERTA] 0 chips WA no ar (${sessions.length} registradas, error=${errorCount}) — re-parear no Telegram`);
        }

        if (heartbeatTicks === 1 || heartbeatTicks % 6 === 0) {
            try {
                const cs = require('./core/router/cmdStats').getCmdStats();
                if (cs && (cs.ok || cs.err)) {
                    logger.logInfo(`[HEARTBEAT] cmds_${cs.windowMin}m ok=${cs.ok} err=${cs.err}`);
                }
            } catch (_) { /* ignore */ }
            try { require('./telegramBot').pruneExpiredPairPending(); } catch (_) { /* ignore */ }
            try {
                const snap = require('./utils/sqlStore').snapshotBackup;
                if (typeof snap === 'function') void Promise.resolve(snap()).catch(() => {});
            } catch (_) { /* snapshot opcional */ }
            void (async () => {
                try {
                    const nEvt = await require('./utils/groupTheftStore').pruneOldEvents();
                    if (nEvt) logger.logInfo(`[HEARTBEAT] prune events=${nEvt}`);
                } catch (_) { /* ignore */ }
            })();
        }

        if (memRSSMB >= 980 || memUsedMB >= 450) {
            try {
                const n = require('./utils/memoryWatch').pruneNow(memRSSMB >= 1180 ? 180 : 500);
                logger.logAviso(`[HEARTBEAT] prune=${n} rss=${memRSSMB}MB (limite host 1536MB)`);
            } catch (_) { /* ignore */ }
        }
    }, HEARTBEAT_INTERVAL);

    // 8. Graceful shutdown completo (único ponto — ver também handlers abaixo de main)
    // Handlers de sinal registrados fora de main para cobrir boot precoce.
}

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.logInfo(`[SHUTDOWN] Recebido ${signal}, iniciando graceful shutdown...`);

    try {
        const cache = require('./cache');
        cache.pruneAllCaches(150);
        for (const sid of activeConnections.keys()) {
            try { cache.persistCache(sid); } catch (_) { /* ignore */ }
        }
    } catch (_) { /* ignore */ }

    try {
        const { setProcessShuttingDown, cancelSessionReconnect } = require('./connection');
        setProcessShuttingDown(true);
        for (const sessionId of [...activeConnections.keys()]) {
            try { cancelSessionReconnect(sessionId); } catch (_) { /* ignore */ }
        }
    } catch (e) {
        logger.logErro('[SHUTDOWN] flag reconnect:', e.message);
    }

    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }

    try {
        await stopHealthServer();
    } catch (e) {
        logger.logErro('[SHUTDOWN] health server:', e.message);
    }

    try {
        const { cancelAllTimeouts } = require('./utils/timeout');
        cancelAllTimeouts();
    } catch (e) {
        logger.logErro('[SHUTDOWN] timeout cleanup:', e.message);
    }

    // Sockets WA vivem em activeConnections (RAM), não no registry JSON
    const sessionIds = [...(activeConnections && activeConnections.keys ? activeConnections.keys() : [])];
    logger.logInfo(`[SHUTDOWN] Desconectando ${sessionIds.length} sockets WA (dados preservados)...`);

    for (const sessionId of sessionIds) {
        try {
            const conn = activeConnections.get(sessionId);
            if (conn) {
                try {
                    if (typeof conn.end === 'function') await conn.end(undefined);
                    else if (typeof conn.ws?.close === 'function') conn.ws.close();
                } catch (_) { /* ignore close errors */ }
                activeConnections.delete(sessionId);
                logger.logInfo(`[SHUTDOWN] Sessão ${sessionId} desconectada`);
            }
        } catch (e) {
            logger.logErro(`[SHUTDOWN] Erro ao desconectar sessão ${sessionId}: ${e.message}`);
        }
    }

    try {
        if (telegramBot && typeof telegramBot.stopPolling === 'function') {
            await telegramBot.stopPolling();
            logger.logInfo('[SHUTDOWN] Telegram bot parado');
        }
    } catch (e) {
        logger.logErro('[SHUTDOWN] Erro ao parar Telegram bot:', e.message);
    }

    try {
        if (typeof releaseInstanceLock === 'function') releaseInstanceLock();
    } catch (_) { /* ignore */ }

    try {
        require('./services/ollamaSidecar').stopOllamaSidecar();
    } catch (_) { /* ignore */ }

    logger.logSucesso('[SHUTDOWN] Graceful shutdown concluído');
    process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

process.on('uncaughtException', (error) => {
    logger.logException('UNCAUGHT_EXCEPTION', error);
    // Nao shutdown: throw do Baileys/libsignal derrubava o egg (host offline).
});

process.on('unhandledRejection', (reason) => {
    const msg = String(reason && reason.message ? reason.message : reason || '');
    if (/rate-overlimit|item-not-found|Connection Closed|conflict/i.test(msg)) {
        if (!process._hanorkOlLogAt || Date.now() - process._hanorkOlLogAt > 30000) {
            process._hanorkOlLogAt = Date.now();
            logger.logAviso(`[UNHANDLED] ruido WA ${msg.slice(0, 80)} (omito repeticao 30s)`);
        }
        return;
    }
    const err = reason instanceof Error ? reason : new Error(logger.formatErrValue(reason));
    logger.logException('UNHANDLED_REJECTION', err);
});

// ===== INÍCIO =====
main();