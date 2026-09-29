// services/healthServer.js
// HTTP health endpoint for process supervision (uses express already in package.json)
// Providers are injected from index.js to avoid side-effect requires (e.g. telegramBot polling).

const express = require('express');
const logger = require('../logger');

let server = null;
let startedAt = Date.now();

const providers = {
    getSessions: () => [],
    getSocketCount: () => 0,
    getQueueStats: () => [],
    getOllamaHealth: null
};

function setHealthProviders(partial = {}) {
    if (typeof partial.getSessions === 'function') providers.getSessions = partial.getSessions;
    if (typeof partial.getSocketCount === 'function') providers.getSocketCount = partial.getSocketCount;
    if (typeof partial.getQueueStats === 'function') providers.getQueueStats = partial.getQueueStats;
    if (typeof partial.getOllamaHealth === 'function') providers.getOllamaHealth = partial.getOllamaHealth;
}

/** Normaliza fila: aceita array OU { sessions: [] } do index.js */
function normalizeQueueStats(raw) {
    if (Array.isArray(raw)) return { sessions: raw, jobs: null };
    if (raw && typeof raw === 'object') {
        const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
        return { sessions, jobs: raw.jobs ?? null };
    }
    return { sessions: [], jobs: null };
}

function buildPayload() {
    let sessions = [];
    let queueRaw = [];
    let sockets = 0;
    let ollama = { available: null, checked: false };
    try { sessions = providers.getSessions() || []; } catch (_) { /* ignore */ }
    try { sockets = Number(providers.getSocketCount()) || 0; } catch (_) { /* ignore */ }
    try { queueRaw = providers.getQueueStats() || []; } catch (_) { /* ignore */ }
    try {
        if (typeof providers.getOllamaHealth === 'function') {
            ollama = providers.getOllamaHealth() || ollama;
        } else {
            const { getOllamaHealth } = require('./ollamaService');
            ollama = getOllamaHealth();
        }
    } catch (_) { /* ignore */ }

    let intentPool = null;
    try {
        const { getPoolHealth } = require('../core/intent/providerPool');
        intentPool = getPoolHealth();
    } catch (_) { /* ignore */ }

    const { sessions: queueStats, jobs } = normalizeQueueStats(queueRaw);
    const mem = process.memoryUsage();
    const pendingTotal = queueStats.reduce((n, s) => n + (s.execPending || 0), 0);
    const activeTotal = queueStats.reduce((n, s) => n + (s.execActive || 0), 0);

    const connected = sessions.filter((s) => s.status === 'connected').length;
    const errorN = sessions.filter((s) => s.status === 'error').length;
    const ollamaOk = ollama.available === true;
    const ready = sockets > 0 || connected > 0;
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    let rssAlert = false;
    let rssPairMaxMB = 1075;
    try {
        const mw = require('../utils/memoryWatch');
        rssPairMaxMB = mw.rssPairMaxMb();
        rssAlert = mw.isRssHigh();
    } catch (_) {
        rssAlert = rssMB >= 1075;
    }

    let mpConfigured = false;
    try {
        mpConfigured = require('./billing/mercadoPagoService').isConfigured();
    } catch (_) { /* ignore */ }

    let cmdStats = null;
    try {
        cmdStats = require('../core/router/cmdStats').getCmdStats();
    } catch (_) { /* ignore */ }
    let failOpenHour = 0;
    try {
        failOpenHour = require('../utils/moderation').getFailOpenStats()?.hour || 0;
    } catch (_) { /* ignore */ }
    const nyxSet = !!String(process.env.NYX_FF_TOKEN || '').trim();
    let commercial = 'OK';
    if (connected < 1) commercial = 'DOWN';
    else if (sessions.length >= 2 && connected === 1) commercial = 'DEGRADED';
    if (rssAlert && commercial === 'OK') commercial = 'DEGRADED';

    return {
        ok: commercial !== 'DOWN',
        ready,
        service: 'hanork-beta',
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        pid: process.pid,
        memory: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            rssMB,
            rssPairMaxMB
        },
        commercial: {
            grade: commercial,
            waConnected: connected,
            waError: errorN,
            waRegistered: sessions.length,
            mpConfigured,
            nyxFfToken: nyxSet,
            rssAlert,
            failOpenHour
        },
        commands: cmdStats || undefined,
        sessions: {
            registered: sessions.length,
            connected,
            sockets
        },
        ollama: {
            ...ollama,
            ok: ollamaOk
        },
        intentPool: intentPool || undefined,
        postgres: (() => {
            try {
                return require('./pgClient').health();
            } catch (_) {
                return { configured: false, dualWrite: false, readDriver: 'sqlite' };
            }
        })(),
        queues: {
            sessions: queueStats.length,
            execActive: activeTotal,
            execPending: pendingTotal,
            jobs
        }
    };
}

function resolveBind(options = {}) {
    const serverPortRaw = process.env.SERVER_PORT;
    if (serverPortRaw != null && String(serverPortRaw).trim() !== '') {
        const port = Number(String(serverPortRaw).trim());
        if (Number.isFinite(port) && port > 0 && port <= 65535) {
            return { host: '0.0.0.0', port };
        }
    }
    const port = Number(options.port || process.env.HEALTH_PORT || 3847);
    const host = options.host || process.env.HEALTH_HOST || '127.0.0.1';
    return {
        host,
        port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : 3847
    };
}

function startHealthServer(options = {}) {
    if (server) return server;

    const { host, port } = resolveBind(options);
    startedAt = Date.now();

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '256kb' }));

    app.get('/health', (_req, res) => {
        try {
            res.status(200).json(buildPayload());
        } catch (e) {
            res.status(503).json({ ok: false, error: e.message });
        }
    });

    app.get('/ready', (_req, res) => {
        try {
            const payload = buildPayload();
            const status = payload.ready ? 200 : 503;
            res.status(status).json({ ready: !!payload.ready, ...payload });
        } catch (e) {
            res.status(503).json({ ready: false, error: e.message });
        }
    });

    try {
        require('./billing/webhookService').mount(app);
    } catch (e) {
        logger.logAviso(`[HEALTH] webhook billing: ${e.message}`);
    }

    server = app.listen(port, host, () => {
        // Raw stdout (fd 1): Wings matches egg "done" on the PTY, not the file logger.
        // parkervcp node.js generic defaults: "change this text 1" / "change this text 2"
        const fsSync = require('fs');
        const doneLines = [
            `listening on ${host}:${port}`,
            `Listening on ${host}:${port}`,
            'change this text 1',
            'change this text 2'
        ];
        for (const line of doneLines) {
            try { fsSync.writeSync(1, `${line}\n`); } catch (_) { console.log(line); }
        }
        logger.logInfo(`[HEALTH] listening on ${host}:${port}  http://${host}:${port}/health`);
    });

    server.on('error', (err) => {
        const code = err && err.code;
        if (code === 'EADDRINUSE') {
            logger.logAviso(`[HEALTH] porta ${host}:${port} em uso (EADDRINUSE) — bot continua sem health HTTP`);
        } else {
            logger.logAviso(`[HEALTH] não iniciado: ${err && err.message ? err.message : err}`);
        }
        server = null;
        // NEVER process.exit on health bind failure — egg would mark the host offline.
    });

    return server;
}

function stopHealthServer() {
    return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => {
            server = null;
            resolve();
        });
    });
}

module.exports = {
    startHealthServer,
    stopHealthServer,
    setHealthProviders,
    buildPayload
};
