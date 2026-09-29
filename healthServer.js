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
    const ollamaOk = ollama.available === true;
    // Bot pode viver sem Ollama (Intent local) — ok=true se processo vivo;
    // ready exige ao menos 1 sessao conectada OU sockets; ollama e informativo
    const ready = sockets > 0 || connected > 0;

    return {
        ok: true,
        ready,
        service: 'hanork-beta',
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        pid: process.pid,
        memory: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024)
        },
        sessions: {
            registered: sessions.length,
            connected,
            sockets,
            detail: sessions.map((s) => ({
                id: s.sessionId || s.id,
                status: s.status,
                telegramUserId: s.telegramUserId
            })).slice(0, 40)
        },
        ollama: {
            ...ollama,
            ok: ollamaOk
        },
        intentPool: intentPool || undefined,
        queues: {
            sessions: queueStats.length,
            execActive: activeTotal,
            execPending: pendingTotal,
            detail: queueStats,
            jobs
        }
    };
}

function startHealthServer(options = {}) {
    if (server) return server;

    const port = Number(options.port || process.env.HEALTH_PORT || 3847);
    const host = options.host || process.env.HEALTH_HOST || '127.0.0.1';
    startedAt = Date.now();

    const app = express();
    app.disable('x-powered-by');

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

    server = app.listen(port, host, () => {
        logger.logInfo(`[HEALTH] listening on ${host}:${port}  http://${host}:${port}/health`);
    });

    server.on('error', (err) => {
        logger.logAviso(`[HEALTH] não iniciado: ${err.message}`);
        server = null;
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
