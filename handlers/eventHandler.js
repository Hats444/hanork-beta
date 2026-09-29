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
            const hasJid = validFailures.some(f => f.jid || f.key?.remoteJid);
            if (!hasJid) return;
            if (process.env.DEBUG_WA === '1') {
                logErro("DECRYPT", `Falha em ${validFailures.length} mensagens`);
            }
            const { inspectInboundStealth } = require('../utils/moderation');
            for (const f of validFailures) {
                const key = f.key || {
                    remoteJid: f.jid || f.remoteJid,
                    participant: f.participant || f.author,
                    id: f.id || f.msgId,
                    fromMe: false
                };
                if (!String(key.remoteJid || '').endsWith('@g.us')) continue;
                inspectInboundStealth(conn, { key, message: f.message || null }, telegramUserId, sessionId, {
                    decryptFailed: true,
                    sender: key.participant
                }).catch(() => {});
            }
        } catch (e) {}
    });

    // messages.update: anti-delete (REVOKE) — sem log de ACK
    on("messages.update", async (updates) => {
        try {
            const { processRevokeUpdates } = require('../utils/antiDelete');
            await processRevokeUpdates(conn, updates, telegramUserId, sessionId);
        } catch (e) {
            logAviso('ANTIDELETE', e && e.message ? e.message : e);
        }
    });

    on("presence.update", (presence) => {
        if (!presence || !presence.id) return;
        if (process.env.DEBUG_WA !== '1') return;
        const status = presence.presences?.[presence.id]?.lastKnownPresence || "?";
        logInfo(`presence.update: ${presence.id} esta ${status}`);
    });

    on("groups.update", (updates) => {
        if (!updates || updates.length === 0) return;
        logInfo(`groups.update: ${updates.length} grupos atualizados`);
        try {
            const { mergeGroupUpdate } = require('../utils/groupMetaCache');
            for (const u of updates) mergeGroupUpdate(u);
        } catch (_) { /* ignore */ }
        try {
            require('../utils/divulgacaoInviteLink').invalidateInviteCacheFromUpdates(updates);
        } catch (_) { /* ignore */ }
        try {
            const { processGroupsUpdate } = require('../utils/groupTheftGuard');
            processGroupsUpdate(conn, updates, telegramUserId).catch((e) => {
                logErro('GROUP-SECURITY ERROR', e && e.message ? e.message : e);
            });
        } catch (e) {
            logErro('GROUP-SECURITY ERROR', e && e.message ? e.message : e);
        }
        try {
            const { onGroupsUpdate } = require('../utils/divulgacaoDeadReplace');
            onGroupsUpdate(conn, updates, telegramUserId).catch((e) => {
                logAviso('META', e && e.message ? e.message : e);
            });
        } catch (_) { /* meta opcional */ }
        try {
            const { noteGroupMutation } = require('../utils/surfaceGuards');
            const { getGroupSecurity } = require('../utils/moderation');
            for (const u of updates) {
                const gid = u?.id;
                if (!gid) continue;
                const flags = getGroupSecurity(gid, telegramUserId);
                if (!flags.surfSettingsFlood) continue;
                const hit = noteGroupMutation(gid, 'groups.update');
                if (hit) logInfo(`[SURF] ${hit.detail}`);
            }
        } catch (_) { /* ignore */ }
    });

    on("groups.upsert", (groups) => {
        try {
            const { putGroupMetadata } = require('../utils/groupMetaCache');
            for (const g of groups || []) {
                if (g && g.id) putGroupMetadata(g.id, g);
            }
        } catch (_) { /* ignore */ }
    });

    on("group-participants.update", async (update) => {
        if (!update || !update.id) return;
        logInfo(`group-participants.update: ${update.participants?.length || 0} participantes em ${update.id} (${update.action || '?'})`);
        try {
            const n = (update.participants || []).length || 1;
            if (update.action === 'add') require('../utils/opsMetrics').bump('joins', n);
            else if (update.action === 'remove' || update.action === 'leave') require('../utils/opsMetrics').bump('leaves', n);
        } catch (_) { /* metrics opcional */ }
        let snapshot = null;
        try {
            const { peekGroupMetadata, applyParticipantUpdate, cloneGroupMeta } = require('../utils/groupMetaCache');
            const raw = peekGroupMetadata(update.id);
            snapshot = typeof cloneGroupMeta === 'function' ? cloneGroupMeta(raw) : raw;
            applyParticipantUpdate(update);
        } catch (e) {
            logErro('GROUP-SECURITY ERROR', `snapshot: ${e && e.message ? e.message : e}`);
        }
        try {
            const { processParticipantsUpdate } = require('../utils/groupTheftGuard');
            processParticipantsUpdate(conn, update, telegramUserId, snapshot).catch((e) => {
                logErro('GROUP-SECURITY ERROR', e && e.message ? e.message : e);
            });
        } catch (e) {
            logErro('GROUP-SECURITY ERROR', e && e.message ? e.message : e);
        }
        try {
            const { onParticipantsUpdate } = require('../utils/divulgacaoDeadReplace');
            onParticipantsUpdate(conn, update, telegramUserId).catch((e) => {
                logAviso('META', e && e.message ? e.message : e);
            });
        } catch (_) { /* meta opcional */ }
        try {
            const { noteGroupMutation } = require('../utils/surfaceGuards');
            const { getGroupSecurity } = require('../utils/moderation');
            const flags = getGroupSecurity(update.id, telegramUserId);
            if (flags.surfSettingsFlood) {
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
            try {
                const { onParticipantUpdate } = require('../utils/autoApresentar');
                await onParticipantUpdate(conn, update, telegramUserId);
            } catch (apErr) {
                logErro('AUTOAP', apErr.message);
            }
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
        try {
            const { processRevokeUpdates, isRevokeUpdate } = require('../utils/antiDelete');
            const revokes = [];
            for (const m of messages || []) {
                const shaped = {
                    key: m.key,
                    message: m.message,
                    messageStubType: m.messageStubType,
                    update: { message: m.message, messageStubType: m.messageStubType }
                };
                if (isRevokeUpdate(shaped) || isRevokeUpdate(m)) revokes.push(shaped);
            }
            if (revokes.length) {
                processRevokeUpdates(conn, revokes, telegramUserId, sessionId).catch((e) => {
                    logAviso('ANTIDELETE', e && e.message ? e.message : e);
                });
            }
        } catch (_) { /* ignore */ }
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