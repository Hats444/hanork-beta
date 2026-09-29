// handlers/eventHandler.js
const logger = require("../logger");

const lastMsgTimes = new Map();

function setupEventListeners(conn, sessionId, telegramUserId) {
    if (conn._eventListenersBound) {
        logger.logAviso(`[${sessionId || 'unknown'}] setupEventListeners ignorado: listeners já registrados neste socket.`);
        return;
    }

    const prefix = `[${sessionId || 'unknown'}]`;

    const logInfo = (msg) => logger.logInfo(`${prefix} ${msg}`);
    const logErro = (tipo, msg) => logger.logErro(tipo, `${prefix} ${msg}`);
    const logAviso = (tipo, msg) => logger.logAviso(`${prefix} ${tipo}: ${msg}`);
    const logSucesso = (msg) => logger.logSucesso(`${prefix} ${msg}`);

    lastMsgTimes.set(sessionId, Date.now());

    const listeners = [];
    const on = (event, handler) => {
        // Wrapper com tratamento de erros robusto
        const safeHandler = async (...args) => {
            try {
                await handler(...args);
            } catch (e) {
                logger.logException(`EVENT_HANDLER_${event.toUpperCase()}`, e, { prefix, event });
            }
        };
        listeners.push([event, safeHandler]);
        conn.ev.on(event, safeHandler);
    };

    on("messages.decrypt-failed", (failures) => {
        try {
            if (!failures || !Array.isArray(failures) || failures.length === 0) return;
            const validFailures = failures.filter(f => f && typeof f === 'object');
            if (validFailures.length === 0) return;
            const hasJid = validFailures.some(f => f.jid);
            if (!hasJid) return;
            logErro("DECRYPT", `Falha em ${validFailures.length} mensagens`);
            validFailures.slice(0, 2).forEach(f => {
                if (f.jid) {
                    logInfo(`  JID: ${f.jid}, Tipo: ${f.type || '?'}`);
                }
            });
        } catch (e) {}
    });

    // messages.update / delete / reaction: sem log (ACK Status|ID floodava o console)

    on("presence.update", (presence) => {
        if (!presence || !presence.id) return;
        const status = presence.presences?.[presence.id]?.lastKnownPresence || "?";
        logInfo(`presence.update: ${presence.id} esta ${status}`);
    });

    on("groups.update", (updates) => {
        if (!updates || updates.length === 0) return;
        logInfo(`groups.update: ${updates.length} grupos atualizados`);
        try {
            const { noteGroupMutation } = require('../utils/surfaceGuards');
            const { getGroupSecurity } = require('../utils/moderation');
            for (const u of updates) {
                const gid = u?.id;
                if (!gid) continue;
                const flags = getGroupSecurity(gid, telegramUserId);
                if (flags.surfSettingsFlood === false) continue;
                const hit = noteGroupMutation(gid, 'groups.update');
                if (hit) logInfo(`[SURF] ${hit.detail}`);
            }
        } catch (_) { /* ignore */ }
    });

    on("group-participants.update", async (update) => {
        if (!update || !update.id) return;
        logInfo(`group-participants.update: ${update.participants?.length || 0} participantes em ${update.id} (${update.action || '?'})`);
        try {
            const { invalidateGroupMetadata } = require('../utils/groupMetaCache');
            invalidateGroupMetadata(update.id);
        } catch (_) { /* ignore */ }
        try {
            const { noteGroupMutation } = require('../utils/surfaceGuards');
            const { getGroupSecurity } = require('../utils/moderation');
            const flags = getGroupSecurity(update.id, telegramUserId);
            if (flags.surfSettingsFlood !== false) {
                const kind = `participants.${update.action || 'upd'}`;
                const hit = noteGroupMutation(update.id, kind);
                if (hit) logInfo(`[SURF] ${hit.detail}`);
            }
        } catch (_) { /* ignore */ }
        try {
            const {
                processAntifakeJoin,
                processBlacklistJoin,
                processWelcomeLeave
            } = require("../utils/moderation");
            await processBlacklistJoin(conn, update, telegramUserId);
            await processAntifakeJoin(conn, update, telegramUserId);
            await processWelcomeLeave(conn, update, telegramUserId);
        } catch (e) {
            logErro("ANTIFAKE", e.message);
        }
    });

    on("group.join-request", async (update) => {
        if (!update || !update.id) return;
        logInfo(
            `group.join-request: ${update.id} action=${update.action || '?'} ` +
            `from=${update.participant || update.author || '?'}`
        );
        try {
            const { onJoinRequestEvent } = require('../utils/joinRequestManager');
            await onJoinRequestEvent(conn, update, telegramUserId);
        } catch (e) {
            logAviso("JOIN_REQUEST", e.message);
        }
    });

    on("contacts.update", (updates) => {
        if (!updates || updates.length === 0) return;
        if (process.env.DEBUG_WA === '1') {
            logInfo(`contacts.update: ${updates.length} contatos atualizados`);
        }
    });

    on("call", async (call) => {
        if (!call) return;
        const fromHint = Array.isArray(call) ? call[0]?.from : call.from;
        logInfo(`call recebida de ${fromHint || 'desconhecido'}`);
        try {
            const { processAntiCall } = require("../utils/moderation");
            await processAntiCall(conn, call, telegramUserId);
        } catch (e) {
            logErro("ANTICALL", e.message);
        }
    });

    on("creds.update", () => {
        if (process.env.DEBUG_WA === '1') logInfo("creds.update (via eventHandler)");
    });

    on("connection.update", (update) => {
        if (update.connection) {
            logInfo(`connection.update: ${update.connection}`);
        }
    });

    on("messages.upsert", ({ messages }) => {
        if (messages && messages.length > 0) {
            lastMsgTimes.set(sessionId, Date.now());
        }
        // Fallback: Baileys JSON.parse no stub de join-request explode e o evento nao emite
        try {
            const { onJoinRequestStubMessage } = require('../utils/joinRequestManager');
            for (const m of messages || []) {
                if (!m?.messageStubType) continue;
                onJoinRequestStubMessage(conn, m, telegramUserId).catch((e) => {
                    const em = String(e?.message || e);
                    if (/forbidden|not-authorized/i.test(em)) logAviso('JOIN_REQUEST_STUB', em);
                    else logErro('JOIN_REQUEST_STUB', em);
                });
            }
        } catch (_) { /* ignore */ }
    });

    conn._eventListenersBound = true;
    conn._eventListenersCleanup = () => {
        for (const [event, handler] of listeners) {
            try { conn.ev.off(event, handler); } catch {}
        }
        conn._eventListenersBound = false;
    };

    logSucesso("Event listeners registrados");
}

module.exports = { setupEventListeners, lastMsgTimes };