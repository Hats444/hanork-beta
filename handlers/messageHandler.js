// handlers/messageHandler.js
const logger = require("../logger");
const { sendMainMenu, sendInteractiveButtons, sendInteractiveList, sendButtonsWithImage } = require("../helpers");
const crypto = require('crypto');
const { parseMessage } = require("../contextParser");
const commands = require("../commands");
const { getCommand } = commands;
const { normalizeJid, ensureJidString, uptime, getPhoneForLid, getLidForPhone } = require("../utils");
const { getCache, getStats, loadPersistedCache, putMessage } = require("../cache");
const axios = require("axios");
const { updateConfig, setModoGrupos, getConfig, getGruposParaDivulgar, limparGrupos, formatTracksSummary } = require("../utils/divulgacao");
const { getPrefix, getOwners, getVips, getButtonsEnabled, setButtonsEnabled, getWhatsAppChannelId } = require("../utils/configManager");
const { setAuthorizationFlags } = require("../utils/authorization");
const { getSessionButtonMode, areButtonsOn } = require("../utils/sessionRegistry");
const { isParticipantPending, markParticipantProcessed, getPendingCount, getMessageText, getMentionJids, clearQueue, withParticipantLock } = require("../utils/invisibleQueue");
const { processStep, cancelStep } = require("../utils/stepHandlers");
const {
    processMessageForModeration,
    processGroupSecurityGuards,
    isGroupBanned,
    getGroupSecurity,
    processPrivateSecurity,
    processPrivateAttackGuard,
    pvAntiWouldBlock,
    isPrivatePersonChat,
    hasInboundPvUserBody,
    trackGroupMessage,
    isGroupAdminStrict,
    collectMessageSenderIds
} = require("../utils/moderation");
const { processEvent } = require("../core/router/universalRouter");
require("../core/router/registeredCommands"); // Carregar comandos migrados
const { findItem } = require("../utils/menuCatalog");
const { processIntent } = require("../core/router/intent");
const { normalizeEvent } = require("../core/router/eventNormalizer");
const { formatCanalPublicText } = require("../utils/canal");

let isRestarting = false;
const divParamsCache = new Map();
const sessionHandlerState = new Map();
const prefixHintAt = new Map();
const PREFIX_HINT_MS = 10 * 60 * 1000;

async function soadmBlocksMember(conn, ctx, from, telegramUserId, sender, info) {
    if (!ctx?.isGroup) return false;
    try {
        const { isFreshSessionOwner } = require('../utils/authorization');
        if (isFreshSessionOwner(ctx)) return false;
    } catch (_) {
        if (ctx.isOwner) return false;
    }
    if (!getGroupSecurity(from, telegramUserId).soadm) return false;
    const cmd = String(ctx.command || '').toLowerCase().replace(/^cmd_/, '');
    if (cmd === 'seradm' || cmd === 'sermembro' || cmd === 'viraradm' || cmd === 'virarmembro') {
        return false;
    }
    const extra = collectMessageSenderIds(info, [ctx.senderAlt, ctx.sender]);
    if (typeof isGroupAdminStrict !== 'function') return false;
    const adminOk = await isGroupAdminStrict(conn, from, sender, extra);
    return !adminOk;
}

async function sendPrefixOnlyHelp(conn, ctx, telegramUserId, sessionId) {
    const p = String(ctx.prefix || getPrefix(telegramUserId) || '.').trim() || '.';
    await sendInteractiveButtons(
        conn,
        ctx.from,
        `Prefixo atual: ${p}\n\nUse assim: ${p}menu`,
        [{ id: 'menu', label: 'Menu principal' }],
        'Hanork',
        ctx.info,
        null,
        telegramUserId,
        sessionId
    );
}

function shouldSendPrefixHint(key) {
    const k = String(key || '');
    if (!k) return false;
    const last = prefixHintAt.get(k) || 0;
    if (Date.now() - last < PREFIX_HINT_MS) return false;
    prefixHintAt.set(k, Date.now());
    if (prefixHintAt.size > 2000) {
        const now = Date.now();
        for (const [id, t] of prefixHintAt) {
            if (now - t > PREFIX_HINT_MS) prefixHintAt.delete(id);
        }
    }
    return true;
}

function applyPermRole(ctx, perm) {
    if (!ctx || !perm?.role) return;
    ctx.authRole = perm.role;
    ctx.isVip = perm.role === 'vip' || perm.role === 'owner' || perm.role === 'platform_admin';
    try {
        const { isFreshSessionOwner } = require('../utils/authorization');
        const fresh = isFreshSessionOwner(ctx);
        if (perm.role === 'platform_admin' && !fresh) {
            ctx.authRole = 'user';
            ctx.isOwner = false;
            ctx.isVip = false;
            return;
        }
        // fromMe sozinho nao vira dono — so identidade canonica.
        if (fresh) {
            ctx.isOwner = true;
            ctx.isVip = true;
            ctx.authRole = perm.role === 'platform_admin' ? 'platform_admin' : 'owner';
            return;
        }
        if (perm.role === 'owner' || perm.role === 'platform_admin') {
            ctx.isOwner = false;
            ctx.authRole = perm.role === 'vip' ? 'vip' : 'user';
            ctx.isVip = perm.role === 'vip';
        } else {
            ctx.isOwner = false;
        }
        if (ctx.isOwner) ctx.isVip = true;
    } catch (_) {
        ctx.isOwner = perm.role === 'owner' || perm.role === 'platform_admin';
        ctx.isVip = ctx.isOwner || perm.role === 'vip';
    }
}

const EXEC_CONCURRENCY_LIMIT = Number(process.env.HANORK_EXEC_CONCURRENCY || 10);
const EXEC_PENDING_MAX = Number(process.env.HANORK_EXEC_PENDING_MAX || 100);
const EXEC_RESERVED_PRIORITY = Math.max(1, Number(process.env.HANORK_EXEC_RESERVED || 3));
const EXEC_NOISE_MAX = Math.max(1, Number(process.env.HANORK_EXEC_NOISE || 2));
const EXEC_TASK_MS = Math.max(8000, Number(process.env.HANORK_EXEC_TASK_MS || 15000));

function getSessionState(sessionId) {
    if (!sessionHandlerState.has(sessionId)) {
        sessionHandlerState.set(sessionId, {
            sessionId,
            queue: Promise.resolve(),
            activeMessageIds: new Set(),
            seenMessageIds: getCache(`${sessionId}:seen`),
            diagEnabled: process.env.HANORK_DIAG === '1' || process.env.DEBUG_FLOW === '1',
            // Controle de concorrencia para EXECUCAO de comandos. A etapa de
            // parse/dedupe/autorizacao continua serializada (rapida e em
            // ordem), mas a execucao do comando em si roda aqui, fora da
            // fila principal. Assim, um comando pesado (divulgacao, download,
            // chamada externa) nao trava a leitura das proximas mensagens.
            execActive: 0,
            execNoiseActive: 0,
            execPending: [],
            execNoisePending: [],
            droppedByBackpressure: 0,
            lastBackpressureLogAt: 0
        });
    }
    return sessionHandlerState.get(sessionId);
}

function getHandlerQueueStats() {
    const out = [];
    for (const [sessionId, state] of sessionHandlerState.entries()) {
        out.push({
            sessionId,
            execActive: state.execActive || 0,
            execNoiseActive: state.execNoiseActive || 0,
            execPending: Array.isArray(state.execPending) ? state.execPending.length : 0,
            execNoisePending: Array.isArray(state.execNoisePending) ? state.execNoisePending.length : 0,
            droppedByBackpressure: state.droppedByBackpressure || 0
        });
    }
    return out;
}

// Executa `fn` respeitando um limite de tarefas simultaneas por sessao.
// Nao bloqueia quem chama: retorna imediatamente uma Promise que resolve
// quando a tarefa termina, mas outras mensagens da mesma sessao podem
// continuar sendo lidas/despachadas sem esperar essa Promise.
// Backpressure: se a fila pendente estourar EXEC_PENDING_MAX, a msg e
// descartada (evita acumular "avalanche" apos travamento).
// Isola inferencia Intent/Ollama por mensagem: ate HANORK_EXEC_CONCURRENCY (default 10)
// slots ativos; sessoes diferentes nao compartilham este limite.
function pumpExecQueue(sessionState) {
    if (!Array.isArray(sessionState.execPending)) sessionState.execPending = [];
    if (!Array.isArray(sessionState.execNoisePending)) sessionState.execNoisePending = [];
    const nextPri = sessionState.execPending.shift();
    if (nextPri) {
        nextPri();
        return;
    }
    const noiseCap = EXEC_NOISE_MAX;
    if ((sessionState.execNoiseActive || 0) >= noiseCap) return;
    const freeForNormal = Math.max(1, EXEC_CONCURRENCY_LIMIT - EXEC_RESERVED_PRIORITY);
    if ((sessionState.execActive || 0) >= freeForNormal) return;
    const nextNoise = sessionState.execNoisePending.shift();
    if (nextNoise) nextNoise();
}

function runLimited(sessionState, fn, opts = {}) {
    return new Promise((resolve, reject) => {
        if (!Array.isArray(sessionState.execPending)) sessionState.execPending = [];
        if (!Array.isArray(sessionState.execNoisePending)) sessionState.execNoisePending = [];
        const isNoise = !!opts.noise && !opts.priority;
        const enqueuedAt = Date.now();
        const task = () => {
            const waited = Date.now() - enqueuedAt;
            if (waited > 400) {
                try {
                    logger.logAviso(
                        `[PIPE] platform=whatsapp cmd=? stage=dequeued duration=${waited}ms status=wait active=${sessionState.execActive || 0} pending=${(sessionState.execPending || []).length} noise=${(sessionState.execNoisePending || []).length}`
                    );
                } catch (_) { /* ignore */ }
            }
            sessionState.execActive++;
            if (isNoise) sessionState.execNoiseActive = (sessionState.execNoiseActive || 0) + 1;
            let budgetTimer = null;
            const budget = new Promise((_, reject) => {
                budgetTimer = setTimeout(() => {
                    try {
                        logger.logAviso(
                            `[PIPE] platform=whatsapp cmd=? stage=timeout duration=${EXEC_TASK_MS}ms status=hung active=${sessionState.execActive || 0} pending=${(sessionState.execPending || []).length}`
                        );
                    } catch (_) { /* ignore */ }
                    const err = new Error('exec_timeout');
                    err.code = 'EXEC_TIMEOUT';
                    reject(err);
                }, EXEC_TASK_MS);
                if (typeof budgetTimer.unref === 'function') budgetTimer.unref();
            });
            Promise.race([Promise.resolve().then(fn), budget])
                .then(
                    (v) => resolve(v),
                    (err) => {
                        if (err && err.code === 'EXEC_TIMEOUT') {
                            resolve({ timeout: true });
                            return;
                        }
                        reject(err);
                    }
                )
                .finally(() => {
                    if (budgetTimer) clearTimeout(budgetTimer);
                    sessionState.execActive--;
                    if (isNoise) sessionState.execNoiseActive = Math.max(0, (sessionState.execNoiseActive || 1) - 1);
                    pumpExecQueue(sessionState);
                });
        };
        const freeForNormal = Math.max(1, EXEC_CONCURRENCY_LIMIT - EXEC_RESERVED_PRIORITY);
        const canRunNow = opts.priority
            ? sessionState.execActive < EXEC_CONCURRENCY_LIMIT
            : isNoise
                ? (sessionState.execNoiseActive || 0) < EXEC_NOISE_MAX
                    && sessionState.execActive < freeForNormal
                : sessionState.execActive < freeForNormal;
        if (canRunNow) {
            task();
        } else if (isNoise && ((sessionState.execNoisePending || []).length >= EXEC_PENDING_MAX)) {
            sessionState.droppedByBackpressure = (sessionState.droppedByBackpressure || 0) + 1;
            const sid = sessionState.sessionId || '?';
            const now = Date.now();
            if (now - (sessionState.lastBackpressureLogAt || 0) > 10000) {
                sessionState.lastBackpressureLogAt = now;
                safeLog(() => logger.logAviso(
                    `[${sid}] BACKPRESSURE_DROP noise=${sessionState.execNoisePending.length} max=${EXEC_PENDING_MAX} dropped=${sessionState.droppedByBackpressure}`
                ));
            }
            resolve({ dropped: true, reason: 'backpressure' });
        } else if (!opts.priority && !isNoise && sessionState.execPending.length >= EXEC_PENDING_MAX) {
            sessionState.droppedByBackpressure = (sessionState.droppedByBackpressure || 0) + 1;
            resolve({ dropped: true, reason: 'backpressure' });
        } else if (opts.priority) {
            sessionState.execPending.unshift(task);
        } else if (isNoise) {
            sessionState.execNoisePending.push(task);
        } else {
            sessionState.execPending.push(task);
        }
    });
}

function looksLikePriorityCommand(info, prefix) {
    try {
        const { unwrapWaMessage } = require('../contextParser');
        const { parsePrefixedCommand } = require('../utils/commandTextParse');
        const raw = unwrapWaMessage(info?.message) || info?.message || {};
        if (
            raw.buttonsResponseMessage ||
            raw.listResponseMessage ||
            raw.templateButtonReplyMessage ||
            raw.interactiveResponseMessage
        ) return true;
        const t = String(
            raw.conversation ||
            raw.extendedTextMessage?.text ||
            raw.imageMessage?.caption ||
            raw.videoMessage?.caption ||
            raw.documentMessage?.caption ||
            raw.buttonsResponseMessage?.selectedButtonId ||
            raw.listResponseMessage?.singleSelectReply?.selectedRowId ||
            raw.templateButtonReplyMessage?.selectedId ||
            ''
        );
                if (/^(cmd_|div_|menu_|join_|osint_|gm_|zn_|bill_|protset_|ps_|info_)/i.test(t.trim())) return true;
        return !!(parsePrefixedCommand(t, prefix, { platform: 'whatsapp' }).command);
    } catch (_) {
        return false;
    }
}

// Authorization functions moved to utils/authorization.js for centralized management

function safeLog(fn) {
    try {
        fn();
    } catch (err) {
        try {
            logger.logException('LOGGER_SAFE', err);
        } catch (_) { /* ignore */ }
    }
}

function flowLog(sessionState, stage, data) {
    if (!sessionState.diagEnabled) return;
    safeLog(() => logger.logFlow(stage, data));
}

function setupHandlers(conn, sessionId, telegramUserId) {
    if (conn._messageHandlerBound) {
        safeLog(() => logger.logAviso(`[${sessionId}] setupHandlers ignorado: listener já registrado neste socket.`));
        return;
    }
    // NOTA: Removida a checagem de listenerCount('messages.upsert') porque
    // o connection.js já registra um listener de watchdog para o mesmo evento.
    // Essa checagem fazia com que setupHandlers NUNCA registrasse o handler
    // de mensagens, causando o travamento silencioso do processamento.
    if (!conn.user) {
        conn.user = { id: 'status@broadcast' };
    }

    conn._sessionId = sessionId;
    conn._telegramUserId = telegramUserId;

    logger.logInfo(`[${sessionId}] setupHandlers iniciando - telegramUserId=${telegramUserId}`);
    const stats = getStats(sessionId);
    const messagesCache = getCache(sessionId);
    const sessionState = getSessionState(sessionId);

    // Restaurar cache persistido do disco
    try {
        loadPersistedCache(sessionId);
    } catch (e) {}

    const messageListener = async ({ messages, type }) => {
        const batchStartedAt = Date.now();
        if (process.env.DEBUG_WA === '1') {
            logger.logInfo(`[${sessionId}] messages.upsert recebido - type=${type}, count=${Array.isArray(messages) ? messages.length : 0}`);
            safeLog(() => logger.logEvento(type, Array.isArray(messages) ? messages.length : 0));
        }
        // `append` = historico/offline no reconnect. Grupo inteiro enche a fila.
        // Comando do dono no proprio chip muitas vezes chega como append (nao notify).
        // Sem isso a sessao adm fica muda e a de outro user (membro = notify) funciona.
        let incoming = messages;
        if (type !== "notify") {
            flowLog(sessionState, 'TYPE_SKIPPED', { sessionId, type });
            const keep = [];
            const prefixHint = getPrefix(telegramUserId);
            if (Array.isArray(messages)) {
                for (const info of messages) {
                    const jid = ensureJidString(info?.key?.remoteJid, '');
                    if (looksLikePriorityCommand(info, prefixHint)) {
                        info._hanorkUpsertType = type;
                        keep.push(info);
                        continue;
                    }
                    if (jid.endsWith('@g.us')) {
                        try {
                            const { inspectInboundStealth } = require('../utils/moderation');
                            inspectInboundStealth(conn, info, telegramUserId, sessionId).catch(() => {});
                        } catch (_) { /* ignore */ }
                        continue;
                    }
                    if (
                        jid &&
                        !jid.endsWith('@newsletter') &&
                        !jid.endsWith('@broadcast') &&
                        jid !== 'status@broadcast'
                    ) {
                        if (info?.key?.fromMe) continue;
                        if (!hasInboundPvUserBody(info)) continue;
                        const ts = Number(info?.messageTimestamp || 0);
                        const ms = ts > 0 && ts < 1e12 ? ts * 1000 : ts;
                        if (ms && Date.now() - ms <= 20000) {
                            info._hanorkUpsertType = type;
                            keep.push(info);
                        }
                    }
                }
            }
            if (!keep.length) return;
            incoming = keep.length > 8 ? keep.slice(-8) : keep;
            logger.logAviso(`[${sessionId}] CATCHUP type=${type} n=${incoming.length}`);
            logger.logAviso(
                `[PIPE] platform=whatsapp cmd=catchup stage=batch duration=0 status=catchup n=${incoming.length} type=${type}`
            );
        }
        if (!Array.isArray(incoming) || incoming.length === 0) {
            flowLog(sessionState, 'EMPTY_BATCH', { sessionId, type });
            return;
        }

        // Processamento paralelo com limite de concorrência
        // Cada mensagem é processada independentemente, até o limite EXEC_CONCURRENCY_LIMIT
        // Isso evita que uma mensagem lenta bloqueie todas as outras
        for (const info of incoming) {
            const prefixHint = getPrefix(telegramUserId);
            const priority = looksLikePriorityCommand(info, prefixHint);
            runLimited(sessionState, async () => {
                const startedAt = Date.now();
                const messageId = info?.key?.id || crypto.randomUUID();
                const remoteJid = ensureJidString(info?.key?.remoteJid, '');

                try {
                    if (remoteJid.endsWith('@g.us') && info?.key?.id && info?.message) {
                        info._telegramUserId = telegramUserId;
                        putMessage(sessionId, info.key.id, info);
                        require('../utils/antiDelete').rememberMessage(sessionId, info);
                    }
                } catch (_) { /* antidelete: guardar antes do skip fromMe */ }

                try {
                    const { tryOwnerBanallSignals } = require('../utils/stickerBanall');
                    const handledBanall = await tryOwnerBanallSignals(conn, info, {
                        sessionId,
                        telegramUserId,
                        upsertType: type
                    });
                    if (handledBanall) return;
                } catch (banallErr) {
                    logger.logAviso(`[${sessionId}] FIGBANALL: ${banallErr && banallErr.message ? banallErr.message : banallErr}`);
                }

                try {
                    if (remoteJid.endsWith('@g.us') && info?.message && !info?.key?.fromMe) {
                        const { unwrapWaMessage } = require('../contextParser');
                        const inner = unwrapWaMessage(info.message) || info.message || {};
                        const rx = inner.reactionMessage;
                        const targetId = rx && rx.key && rx.key.id;
                        const emoji = String((rx && rx.text) || '').trim();
                        if (targetId && emoji) {
                            const who = ensureJidString(
                                info.key?.participant || info.key?.participantAlt || info.key?.participantPn || '',
                                ''
                            );
                            if (who) {
                                require('../utils/shopStore')
                                    .addRaffleParticipant(telegramUserId, remoteJid, targetId, who)
                                    .catch(() => {});
                            }
                        }
                    }
                } catch (_) { /* sorteio reacao */ }

                // P0 anti-loop: descartar eco do proprio bot ANTES de qualquer parser/router/intent
                try {
                    const { shouldIgnoreWhatsAppMessage } = require("../utils/selfMessageGuard");
                    const prefixEarly = getPrefix(telegramUserId);
                    const selfCheck = shouldIgnoreWhatsAppMessage(info, { prefix: prefixEarly });
                    if (selfCheck.ignore) {
                        if (selfCheck.reason !== 'fromMe_no_prefix' || process.env.DEBUG_SELF_MSG === '1') {
                            logger.logAviso(`[${sessionId}] SELF_MSG_SKIP reason=${selfCheck.reason} messageId=${messageId}`);
                        }
                        return;
                    }
                } catch (_) {}

                if (process.env.DEBUG_WA === '1') {
                    logger.logInfo(`[${sessionId}] Processando mensagem - messageId=${messageId}, remoteJid=${remoteJid}`);
                }
                flowLog(sessionState, 'EVENT_RECEIVED', { sessionId, messageId, type, remoteJid });

                // Atualiza métricas do watchdog para indicar que o handler está processando
                try {
                    if (conn._watchdogMetrics && typeof conn._watchdogMetrics.updateProcessed === 'function') {
                        conn._watchdogMetrics.updateProcessed();
                    }
                } catch (e) {}

                if (!info || !info.message) {
                    if (process.env.DEBUG_WA === '1') {
                        logger.logAviso(`[${sessionId}] MESSAGE_DROPPED - empty_message - messageId=${messageId}`);
                    }
                    flowLog(sessionState, 'MESSAGE_DROPPED', { sessionId, messageId, reason: 'empty_message' });
                    return;
                }

                if (sessionState.activeMessageIds.has(messageId) || sessionState.seenMessageIds.get(messageId)) {
                    if (process.env.DEBUG_WA === '1') {
                        logger.logAviso(`[${sessionId}] MESSAGE_DEDUPED - messageId=${messageId}`);
                    }
                    flowLog(sessionState, 'MESSAGE_DEDUPED', { sessionId, messageId });
                    return;
                }

                sessionState.activeMessageIds.add(messageId);
                sessionState.seenMessageIds.set(messageId, true, 300);
                stats.messages++;

                let ctx;
                try {
                    const prefix = getPrefix(telegramUserId);
                    if (process.env.DEBUG_WA === '1') {
                        logger.logInfo(`[${sessionId}] Iniciando parseMessage - messageId=${messageId}, prefix=${prefix}`);
                    }
                    flowLog(sessionState, 'TYPE_VALIDATED', { sessionId, messageId, type });
                    flowLog(sessionState, 'PARSER_STARTED', { sessionId, messageId });
                    ctx = await parseMessage(conn, info, prefix);
                    if (process.env.DEBUG_WA === '1') {
                        logger.logInfo(`[${sessionId}] parseMessage concluído - messageId=${messageId}, prefix=${ctx?.prefix}, command=${ctx?.command || ''}`);
                    }
                    flowLog(sessionState, 'PARSER_FINISHED', { sessionId, messageId, durationMs: Date.now() - startedAt });
                } catch (parseErr) {
                    safeLog(() => logger.logException('PARSER', parseErr, { sessionId, messageId }));
                    sessionState.activeMessageIds.delete(messageId);
                    return;
                }

                if (!ctx) {
                    logger.logAviso(`[${sessionId}] MESSAGE_DROPPED - ctx_null - messageId=${messageId}`);
                    safeLog(() => logger.logErro("PARSER", `[${sessionId}] ctx é null`));
                    flowLog(sessionState, 'MESSAGE_DROPPED', { sessionId, messageId, reason: 'ctx_null' });
                    sessionState.activeMessageIds.delete(messageId);
                    return;
                }

                ctx.from = ensureJidString(ctx.from || info.key?.remoteJid, 'status@broadcast');
                ctx.sender = ensureJidString(ctx.sender || info.key?.participant || ctx.from, ctx.from);
                ctx.inboundJid = ensureJidString(info.key?.remoteJid, ctx.from);
                ctx.upsertType = type;
                if (info && info._hanorkUpsertType) ctx.upsertType = info._hanorkUpsertType;
                if (isPrivatePersonChat(ctx) && ctx.isGroup) {
                    logger.logAviso(`[${sessionId}] ANTIPV_HEAL isGroup→PV from=${ctx.from}`);
                    ctx.isGroup = false;
                    ctx.isPrivate = true;
                }
                if (!ctx.isGroup) {
                    try {
                        const { keepInboundChatJid } = require("../utils");
                        const same = keepInboundChatJid(ctx.from, info.key);
                        if (same) {
                            ctx.from = same;
                        }
                    } catch (_) { /* mapping opcional */ }
                }

                const sender = ctx.sender;
                let from = ctx.from;
                ctx.telegramUserId = telegramUserId;
                ctx.sessionId = sessionId;
                ctx.conn = conn;

                // Use centralized authorization with JID/LID hybrid support
                setAuthorizationFlags(ctx, telegramUserId);

                // Canal @newsletter nao e PV. Comando so pra admin do canal / dono da sessao.
                const isChannelChat =
                    !!(ctx.isChannel) || String(from || '').endsWith('@newsletter');
                if (isChannelChat) {
                    ctx.isChannel = true;
                    ctx.isPrivate = false;
                    let channelOwner = false;
                    try {
                        const { isFreshSessionOwner } = require('../utils/authorization');
                        channelOwner = isFreshSessionOwner(ctx);
                    } catch (_) {
                        channelOwner = !!ctx.isOwner;
                    }
                    try {
                        const { senderIsChannelAdmin } = require('../utils/channelChat');
                        ctx.isChannelAdmin = !!(channelOwner || (await senderIsChannelAdmin(conn, ctx)));
                    } catch (_) {
                        ctx.isChannelAdmin = channelOwner;
                    }
                    if (!channelOwner && !ctx.isChannelAdmin) {
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }
                }

                // Anti-ataque (crash/atraso) + anti-PV ANTES de cmd/botao/intent.
                if (isPrivatePersonChat(ctx) && !isChannelChat) {
                    try {
                        const atkEarly = await processPrivateAttackGuard(conn, ctx, telegramUserId, info);
                        if (atkEarly && atkEarly.handled) {
                            logger.logAviso(`[${sessionId}] ${atkEarly.reason} EARLY from=${from} hit=${atkEarly.attack || '-'}`);
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                    } catch (e) {
                        logger.logAviso(`[ANTIATAQUE-PV] early: ${e.message}`);
                    }
                    try {
                        const pvEarly = await processPrivateSecurity(conn, ctx, telegramUserId);
                        if (pvEarly && pvEarly.handled) {
                            logger.logAviso(`[${sessionId}] ${pvEarly.reason} EARLY from=${from} cmd=${ctx.command || ctx.buttonId || '-'}`);
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                    } catch (e) {
                        logger.logAviso(`[ANTIPV] early: ${e.message}`);
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }
                }

                try {
                    const { ingestFromCtx } = require('../utils/groupManager');
                    ingestFromCtx(ctx).catch((e) =>
                        logger.logAviso(`[GROUP_INVITE] ingest: ${String(e.message || e).slice(0, 100)}`)
                    );
                } catch (_) { /* modulo opcional */ }

                // Clique de lista/menu: id no fullText mesmo se isInteractive falhou no parse
                if (
                    !ctx.isInteractive &&
                    !ctx.command &&
                    ctx.fullText &&
                    /^(cmd_|div_|menu_|tg_|sec_|osint_|gm_|zn_|bill_|protset_|ps_|info_)/i.test(String(ctx.fullText).trim())
                ) {
                    ctx.isInteractive = true;
                    ctx.buttonId = String(ctx.fullText).trim();
                }
                if (ctx.isInteractive && !ctx.buttonId && ctx.fullText) {
                    ctx.buttonId = String(ctx.fullText).trim();
                }

                // Foto/midia de divulgacao: salva ANTES do antiimg apagar no grupo
                const divMediaStep = String(ctx.session?.step || '');
                if (
                    ctx.isOwner &&
                    /^(awaiting_divctafoto|awaiting_divctavideo|awaiting_divimage|awaiting_divvideo|awaiting_divgif|awaiting_divaudio|awaiting_divdocument|awaiting_divstatusimage|awaiting_divstatusvideo)$/.test(divMediaStep) &&
                    (ctx.hasMedia || ctx.isReply)
                ) {
                    try {
                        const t = String(ctx.fullText || '').trim().toLowerCase();
                        if (t === 'cancelar' || t === 'cancel') {
                            cancelStep(ctx);
                            try {
                                const { sendDivulgacaoMessage } = require('../utils/divulgacaoReply');
                                await sendDivulgacaoMessage(conn, ctx, { text: 'Operacao cancelada.' });
                            } catch (_) {
                                await conn.sendMessage(from, { text: 'Operacao cancelada.' }, { quoted: info });
                            }
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                        const stepProcessed = await processStep(conn, ctx, ctx.fullText);
                        if (stepProcessed) {
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                    } catch (e) {
                        logger.logAviso(`[${sessionId}] DIV_MEDIA_STEP ${e.message}`);
                    }
                }

                try { 
                    if (info?.key?.id) {
                        // Normaliza JIDs no key pra bna/clearuser achar no cache (LID/PN)
                        if (info.key.remoteJid) {
                            info.key.remoteJid = ensureJidString(info.key.remoteJid, info.key.remoteJid);
                        }
                        if (info.key.participant) {
                            info.key.participant = ensureJidString(info.key.participant, info.key.participant);
                        }
                        putMessage(sessionId, info.key.id, info);
                        try {
                            info._telegramUserId = telegramUserId;
                            require('../utils/antiDelete').rememberMessage(sessionId, info);
                        } catch (_) { /* antidelete opcional */ }
                        // Persistencia leve a cada ~25 msgs (sobrevive restart)
                        if ((stats.messages || 0) % 25 === 0) {
                            setImmediate(() => {
                                try { require('../cache').persistCache(sessionId); } catch (_) {}
                            });
                        }
                    }
                } catch {}

                // Contador banghost (membros em grupo)
                if (ctx.isGroup && !ctx.fromMe && ctx.sender) {
                    try { trackGroupMessage(from, sender, telegramUserId); } catch (_) {}
                    try {
                        require('../utils/shopStore').bumpActivity(telegramUserId, from, sender).catch(() => {});
                    } catch (_) {}
                    try {
                        const { noteGroupMessage } = require('../utils/divulgacaoAuto');
                        noteGroupMessage(telegramUserId, from, info);
                    } catch (_) {}
                    try {
                        const { notePresented } = require('../utils/autoApresentar');
                        notePresented(from, sender, [ctx.senderAlt, ctx.senderPn]);
                    } catch (_) {}
                }

                // bangp: grupo banido — ignora tudo (guards + cmds) exceto dono da sessao
                let sessionOwnerNow = false;
                try {
                    const { isFreshSessionOwner } = require('../utils/authorization');
                    sessionOwnerNow = isFreshSessionOwner(ctx);
                } catch (_) {
                    sessionOwnerNow = !!ctx.isOwner;
                }

                if (ctx.isGroup && !sessionOwnerNow && Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length) {
                    try {
                        const shop = require('../utils/shopStore');
                        for (const j of ctx.mentionedJid.slice(0, 2)) {
                            const row = await shop.getAusente(telegramUserId, j);
                            if (row && row.reason) {
                                await conn.sendMessage(from, {
                                    text: `Ausente: ${String(row.reason).slice(0, 120)}`
                                }, { quoted: info });
                                break;
                            }
                        }
                    } catch (_) { /* */ }
                }

                if (ctx.isGroup && !sessionOwnerNow && isGroupBanned(from, telegramUserId)) {
                    logger.logAviso(`[${sessionId}] BANGP_BLOCK grupo=${from}`);
                    sessionState.activeMessageIds.delete(messageId);
                    return;
                }

                if (!sessionOwnerNow && (ctx.command || ctx.isInteractive)) {
                    try {
                        const { isBotOff } = require('../utils/botGate');
                        if (isBotOff(telegramUserId)) {
                            logger.logAviso(`[${sessionId}] BOTOFF_BLOCK cmd=${ctx.command || ctx.buttonId || ''}`);
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                    } catch (_) { /* */ }
                }

                // .block: user nao usa mais comandos/botoes/intent (LID+JID)
                if (!sessionOwnerNow) {
                    try {
                        const { isCmdBlocked } = require('../utils/cmdBlock');
                        if (isCmdBlocked(telegramUserId, ctx)) {
                            ctx._cmdBlocked = true;
                            if (ctx.command || ctx.isInteractive) {
                                logger.logAviso(`[${sessionId}] CMDBLOCK ignore cmd=${ctx.command || ctx.buttonId || ''} sender=${sender}`);
                                sessionState.activeMessageIds.delete(messageId);
                                return;
                            }
                        }
                    } catch (e) {
                        logger.logAviso(`[CMDBLOCK] ${e.message}`);
                    }
                }

                // PV: anti-PV padrao ON. Dono/VIP passam. Status/broadcast continua drop.
                if (isPrivatePersonChat(ctx) && !ctx.isChannel) {
                    if (
                        from === 'status@broadcast' ||
                        String(from).endsWith('@broadcast')
                    ) {
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }
                    try { setAuthorizationFlags(ctx, telegramUserId); } catch (_) { /* ignore */ }
                    if (pvAntiWouldBlock(ctx, telegramUserId)) {
                        try {
                            const pvLate = await processPrivateSecurity(conn, ctx, telegramUserId);
                            if (pvLate && pvLate.handled) {
                                logger.logAviso(`[${sessionId}] ${pvLate.reason} LATE from=${from}`);
                                sessionState.activeMessageIds.delete(messageId);
                                return;
                            }
                        } catch (e) {
                            logger.logAviso(`[ANTIPV] late: ${e.message}`);
                        }
                        logger.logAviso(`[${sessionId}] ANTIPV_PV_BLOCK from=${from} sender=${sender}`);
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }
                    logger.logInfo(
                        `[${sessionId}] PV_OK role=${ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user')} sender=${sender}`
                    );
                    // Responde no mesmo chat em que a msg chegou (LID ou PN).
                    try {
                        const { keepInboundChatJid, rememberLidPhonePair } = require('../utils');
                        const key = info.key || {};
                        if (key.remoteJid && key.remoteJidAlt) rememberLidPhonePair(key.remoteJid, key.remoteJidAlt);
                        if (key.participant && key.participantAlt) rememberLidPhonePair(key.participant, key.participantAlt);
                        const inbound = keepInboundChatJid(ctx.inboundJid || key.remoteJid || from, key);
                        if (
                            inbound &&
                            !String(inbound).endsWith('@broadcast') &&
                            !String(inbound).endsWith('@newsletter') &&
                            String(inbound) !== 'status@broadcast'
                        ) {
                            ctx.from = inbound;
                            from = inbound;
                        }
                    } catch (_) { /* mapping opcional */ }
                }

                // Protecoes de grupo. Comando/botao nao esperam IQ/moderacao
                // (antes isso atrasava .ping/.menu atras do groupMetadata).
                if (ctx.isGroup && !ctx.fromMe) {
                const runGroupGuards = async () => {
                try {
                    const secResult = await processGroupSecurityGuards(conn, info, telegramUserId, sessionId, {
                        isAdmin: !!ctx.isAdmin,
                        isOwner: !!sessionOwnerNow || !!ctx.isOwner,
                        senderAlt: ctx.senderAlt,
                        sender: ctx.sender,
                        ctx
                    });
                    if (secResult && secResult.success) {
                        logger.logAviso(`[MODERATION] Guard=${secResult.reason} grupo=${from}`);
                        return true;
                    }
                } catch (e) {
                    logger.logAviso(`[MODERATION] Erro security guard: ${e.message}`);
                }
                try {
                    const moderationResult = await processMessageForModeration(conn, info, sessionId, telegramUserId);
                    if (moderationResult && moderationResult.success) {
                        logger.logAviso(`[MODERATION] Ação executada automaticamente - Grupo: ${from}, Usuário: ${sender}, Motivo: ${moderationResult.reason || 'desconhecido'}`);
                        return true;
                    }
                } catch (e) {
                    logger.logAviso(`[MODERATION] Erro ao processar moderação: ${e.message}`);
                }
                return false;
                };
                if (priority) {
                    runGroupGuards().catch((e) => logger.logAviso(`[MODERATION] bg: ${e.message}`));
                } else {
                    const blocked = await runGroupGuards();
                    if (blocked) {
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }
                }
                }

                flowLog(sessionState, 'MESSAGE_ACCEPTED', { sessionId, messageId, from: from });

                // autosticker: imagem de membro vira figurinha (mesmo pipeline ZT/sharp)
                // Nao roda no slot de comando — download+ffmpeg segurava a fila por minutos.
                if (
                    !priority &&
                    ctx.isGroup &&
                    !ctx.command &&
                    !ctx.fromMe &&
                    getGroupSecurity(from, telegramUserId).autosticker
                ) {
                    try {
                        const msg = info?.message || {};
                        const hasImg = !!(msg.imageMessage || msg.viewOnceMessageV2?.message?.imageMessage);
                        if (hasImg && ctx.downloadMedia) {
                            const buf = await ctx.downloadMedia();
                            if (buf) {
                                const { sendSticker } = require('../services/stickerService');
                                await sendSticker(conn, from, buf, info, { kind: 'image' });
                            }
                        }
                    } catch (asErr) {
                        logger.logAviso(`[${sessionId}] AUTOSTICKER ${asErr.message}`);
                    }
                }

                // .gpt/.claude/etc. nao sao cmds — viram .hanork (mesmo pool)
                if (ctx.command) {
                    try {
                        const { isHanorkIaAlias } = require('../commands/hanorkChat');
                        if (isHanorkIaAlias(ctx.command)) ctx.command = 'hanork';
                    } catch (_) { /* */ }
                }

                // soadm cedo: fail-closed (meta/LID falhou = nao e admin)
                if (
                    (ctx.command || ctx.isInteractive) &&
                    await soadmBlocksMember(conn, ctx, from, telegramUserId, sender, info)
                ) {
                    logger.logAviso(`[${sessionId}] SOADM_BLOCK_EARLY`);
                    try {
                        await conn.sendMessage(from, {
                            text: 'Neste grupo so admin usa comando.'
                        }, { quoted: info });
                    } catch (_) {}
                    sessionState.activeMessageIds.delete(messageId);
                    return;
                }

                // ===== UNIVERSAL ROUTER =====
                if (ctx.command) {
                    try {
                        const routerResult = await processEvent(info, 'whatsapp', conn, ctx);
                        if (routerResult && routerResult.handled) {
                            if (routerResult.error) {
                                const errText = String(routerResult.error);
                                const { isAuthDenialText } = require("../utils/authSilence");
                                const { getPrefix } = require("../utils/configManager");
                                const { buildRestrictedText, buildRateLimitText } = require("../utils/onboarding");
                                if (isAuthDenialText(errText)) {
                                    if (ctx.fromMe || info?.key?.fromMe || sessionOwnerNow) {
                                        logger.logAviso(`[AUTH_SILENT] ROUTER jid=${from} cmd=${ctx.command} | ${errText}`);
                                    } else {
                                        try {
                                            const short = /vip/i.test(errText)
                                              ? 'Este comando e so VIP.'
                                              : /dono/i.test(errText)
                                                ? 'Este comando e so do dono.'
                                                : 'Sem permissao neste comando.';
                                            await conn.sendMessage(from, { text: short }, { quoted: info });
                                        } catch (_) {}
                                    }
                                } else if (/rate\s*limit|muitos comandos/i.test(errText) && !/overlimit/i.test(errText)) {
                                    if (sessionOwnerNow) {
                                        logger.logAviso(`[AUTH_SILENT] ROUTER rate owner jid=${from} cmd=${ctx.command}`);
                                    } else {
                                    const secMatch = errText.match(/(\d+)\s*s/i);
                                    try {
                                        await conn.sendMessage(from, {
                                            text: buildRateLimitText(secMatch ? Number(secMatch[1]) : 5)
                                        }, { quoted: info });
                                    } catch (_) {}
                                    }
                                } else {
                                    try {
                                        const { toPublicError } = require('../core/router/errorHandler');
                                        const safe = toPublicError(errText);
                                        logger.logUserFacingError('ROUTER_ERROR', errText, {
                                            sessionId,
                                            command: ctx.command
                                        });
                                        await conn.sendMessage(from, { text: safe }, { quoted: info });
                                    } catch (_) { /* ignore send fail */ }
                                }
                                logger.logAviso(`[${sessionId}] ROUTER_ERROR_USER - command=${ctx.command}, error=${routerResult.error}`);
                            } else {
                                logger.logInfo(`[${sessionId}] ROUTER_HANDLED - messageId=${messageId}, command=${ctx.command}`);
                            }
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                    } catch (routerError) {
                        logger.logErro(`[${sessionId}] ROUTER_ERROR - messageId=${messageId}, command=${ctx.command}, error=${routerError.message}`);
                        // Continua com fluxo original se router falhar de forma inesperada
                    }
                }

                // ===== VALLEY INVISIBLE - so o alvo capturado recebe (nao fan-out) =====
                if (ctx.isGroup && !ctx.fromMe && !info.key.fromMe) {
                    const isPending = isParticipantPending(sessionId, from, sender);
                    if (isPending) {
                        // Processa em background para não travar o fluxo principal
                        const lockAcquired = await withParticipantLock(sessionId, from, sender, async () => {
                            try {
                                const messageText = getMessageText(sessionId, from);
                                if (!messageText) {
                                    logger.logAviso(`[INVISIBLE] Texto não encontrado para fila - sessionId=${sessionId}, group=${from}`);
                                    return;
                                }
                                const mentionJids = typeof getMentionJids === 'function'
                                    ? getMentionJids(sessionId, from)
                                    : [];

                                const customId = info.key.id;
                                const targetJid =
                                    info.key.participantAlt ||
                                    info.key.participant ||
                                    sender;

                                const { sendInvisibleMessage } = require('../utils/directedGroupRelay');
                                const softFail = (reason) =>
                                  /rate-overlimit|forbidden|not-authorized|connection closed|timed out/i.test(
                                    String(reason || '')
                                  );

                                let relay = await sendInvisibleMessage(conn, {
                                    groupJid: from,
                                    messageId: customId,
                                    text: messageText,
                                    targetJid,
                                    mentions: mentionJids
                                });

                                // Retry em background — nao segura o slot do comando
                                if (!relay.ok && /rate-overlimit/i.test(String(relay.reason || ''))) {
                                    setTimeout(() => {
                                        sendInvisibleMessage(conn, {
                                            groupJid: from,
                                            messageId: customId,
                                            text: messageText,
                                            targetJid,
                                            mentions: mentionJids
                                        }).catch(() => {});
                                    }, 2500);
                                    return;
                                }

                                if (!relay.ok) {
                                    if (softFail(relay.reason)) {
                                        logger.logAviso(`[INVISIBLE] relay skip: ${relay.reason}`);
                                        // forbidden: nao insiste neste alvo; rate: deixa na fila pra proxima msg
                                        if (/forbidden|not-authorized/i.test(String(relay.reason || ''))) {
                                            markParticipantProcessed(sessionId, from, sender);
                                        }
                                    } else {
                                        logger.logErro(`[INVISIBLE] relay falhou: ${relay.reason || 'erro'}`);
                                    }
                                    return;
                                }

                                logger.logInfo(`[INVISIBLE] Mensagem dirigida ok - messageId=${customId}`);
                                
                                // Marca como processado
                                markParticipantProcessed(sessionId, from, sender);
                                
                                // Verifica se fila está vazia para limpar
                                const pendingCount = getPendingCount(sessionId, from);
                                if (pendingCount === 0) {
                                    logger.logInfo(`[INVISIBLE] Fila vazia, limpando - sessionId=${sessionId}, group=${from}`);
                                    clearQueue(sessionId, from);
                                }
                            } catch (err) {
                                const em = String(err?.message || err);
                                if (/rate-overlimit|forbidden|not-authorized|connection closed|timed out/i.test(em)) {
                                    logger.logAviso(`[INVISIBLE] relay skip: ${em}`);
                                } else {
                                    logger.logErro(`[INVISIBLE] Erro no relayMessage: ${em}`);
                                }
                            }
                        });

                        if (!lockAcquired) {
                            logger.logAviso(`[INVISIBLE] Lock não adquirido para participante - ${sender}`);
                        }
                    }
                }

                // STEP HANDLER CHECK - Processar step handlers antes de comandos normais
                if (ctx.session?.step) {
                    if (process.env.DEBUG_WA === '1') {
                        logger.logInfo(`[${sessionId}] STEP_DETECTED - messageId=${messageId}, step=${ctx.session.step}`);
                        flowLog(sessionState, 'STEP_DETECTED', { sessionId, messageId, step: ctx.session.step });
                    }
                    
                    try {
                        // Verificar cancelamento
                        const stepText = String(ctx.fullText || '').toLowerCase();
                        if (stepText === 'cancelar' || stepText === 'cancel') {
                            cancelStep(ctx);
                            await conn.sendMessage(from, { text: "Operacao cancelada." }, { quoted: info });
                            logger.logInfo(`[${sessionId}] STEP_CANCELLED - messageId=${messageId}`);
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                        
                        // Processar step
                        const stepProcessed = await processStep(conn, ctx, ctx.fullText);
                        if (stepProcessed) {
                            if (process.env.DEBUG_WA === '1') {
                                logger.logInfo(`[${sessionId}] STEP_PROCESSED - messageId=${messageId}, step=${ctx.session.step}`);
                                flowLog(sessionState, 'STEP_PROCESSED', { sessionId, messageId });
                            }
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                    } catch (stepError) {
                        const em = String(stepError?.message || stepError);
                        const soft = /Connection Closed|Timed Out|Socket|ECONNRESET|not connected/i.test(em);
                        if (soft) {
                            logger.logAviso(`[${sessionId}] STEP_ABORT - messageId=${messageId}, ${em}`);
                        } else {
                            logger.logErro(`[${sessionId}] STEP_ERROR - messageId=${messageId}, error=${em}`);
                        }
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }
                }

                // AUTH: blacklist = drop; user/vip/owner passam — nivel por cmd no Router/Intent
                if (ctx.authAuthorized === false || ctx.authRole === 'none') {
                    logger.logAviso(`[${sessionId}] AUTH_CHECK - messageId=${messageId}, authorized=false, role=${ctx.authRole}, sender=${sender}`);
                    safeLog(() => logger.logIgnorado(ctx.isInteractive ? (ctx.buttonId || 'interactive') : (ctx.command || 'unknown'), normalizeJid(sender)));
                    flowLog(sessionState, 'AUTH_CHECK', { sessionId, messageId, authorized: false, role: ctx.authRole });
                    sessionState.activeMessageIds.delete(messageId);
                    return;
                }
                try {
                    const { isOwnerOnlyMode, allowOwnerOnlyActor } = require('../utils/ownerOnlyMode');
                    if (isOwnerOnlyMode() && !allowOwnerOnlyActor({
                        ...ctx,
                        telegramUserId,
                        platform: 'whatsapp',
                        sender
                    })) {
                        logger.logInfo(`[${sessionId}] OWNER_ONLY drop cmd=${ctx.command || '-'} interactive=${!!ctx.isInteractive}`);
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }
                } catch (_) { /* */ }
                if (process.env.DEBUG_WA === '1' && (ctx.command || ctx.isInteractive)) {
                    logger.logInfo(`[${sessionId}] AUTH_CHECK - messageId=${messageId}, role=${ctx.authRole}, sender=${sender}, type=${ctx.isInteractive ? 'interactive' : 'command'}${ctx.buttonId ? ` btn=${ctx.buttonId}` : ''}`);
                }
                flowLog(sessionState, 'AUTH_CHECK', { sessionId, messageId, authorized: true, role: ctx.authRole, type: ctx.isInteractive ? 'interactive' : 'command' });

                if (ctx.isInteractive) {
                    const id = ctx.buttonId || ctx.fullText;
                    if (!id) {
                        logger.logAviso(`[${sessionId}] BUTTON_EMPTY_ID - messageId=${messageId}`);
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }

                    try {
                        const { shouldHandleInteractiveClick } = require('../utils/interactiveClickGuard');
                        const gate = shouldHandleInteractiveClick(conn, info, sessionState, { buttonId: id });
                        if (!gate.handle) {
                            logger.logInfo(
                                `[${sessionId}] BUTTON_SKIP - ${gate.reason} id=${id} messageId=${messageId}`
                            );
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                    } catch (gateErr) {
                        logger.logAviso(`[${sessionId}] BUTTON_GATE ${gateErr.message}`);
                    }
                    
                    // Modo botoes OFF: ignora clique (menus ja foram em texto)
                    if (!areButtonsOn(sessionId, telegramUserId)) {
                        logger.logInfo(`[${sessionId}] Botões desativados, ignorando botão interativo: ${id}`);
                        safeLog(() => logger.logBotao("IGNORADO (botões OFF)", id, normalizeJid(sender)));
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }
                    
                    safeLog(() => logger.logBotao("INTERATIVO", id, normalizeJid(sender)));
                    try {
                        const { withTimeout, HANDLER_TIMEOUT_MS } = require('../utils/timeout');
                        await withTimeout(
                            () => handleButtonAction(conn, ctx, id, telegramUserId, sessionId),
                            HANDLER_TIMEOUT_MS,
                            `button:${id}`
                        );
                        const btnMs = Date.now() - startedAt;
                        logger.logPerf('BUTTON', {
                            sessionId,
                            messageId,
                            durationMs: btnMs,
                            command: id
                        });
                        flowLog(sessionState, 'COMMAND_FINISHED', { sessionId, messageId, command: id, durationMs: btnMs, interactive: true });
                    } catch (buttonError) {
                        const msg = String(buttonError?.message || buttonError);
                        logger.logErro(`[${sessionId}] BUTTON_ERROR - messageId=${messageId}, button=${id}, error=${msg}`);
                        const socketDead = /connection closed|not connected|socket hang/i.test(msg);
                        const timedOut = /Timeout:/i.test(msg);
                        if (timedOut) {
                            logger.logAviso(`[${sessionId}] BUTTON_TIMEOUT - ${id}`);
                        } else if (!socketDead) {
                            try {
                                await conn.sendMessage(from, { text: `Erro ao processar botao.` }, { quoted: info });
                            } catch (_) { /* ignore */ }
                        }
                    }
                    sessionState.activeMessageIds.delete(messageId);
                    return;
                }

                if (!ctx.prefix && !ctx.command) {
                    if (ctx._cmdBlocked) {
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }
                    // Intent Router: nunca em fromMe (eco/resposta do bot)
                    if (ctx.isGroup && await soadmBlocksMember(conn, ctx, from, telegramUserId, sender, info)) {
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }
                    if (ctx.fromMe || info.key?.fromMe) {
                        logger.logAviso(`[${sessionId}] MESSAGE_DROPPED - fromMe_no_prefix - messageId=${messageId}`);
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }
                    // Prefixo errado (! / #) com config diferente → ignora (sem Intent/tip)
                    try {
                        const { isForeignPrefix } = require('../utils/commandTextParse');
                        const configured = getPrefix(telegramUserId);
                        const rawText = ctx.fullText || ctx.text || '';
                        if (isForeignPrefix(rawText, configured, { platform: 'whatsapp' })) {
                            logger.logInfo(
                              `[${sessionId}] MESSAGE_DROPPED - foreign_prefix ` +
                              `(aceita so "${configured}") messageId=${messageId}`
                            );
                            if (!ctx.isGroup && (ctx.isOwner || ctx.isVip)) {
                                const hintKey = `pfx:${telegramUserId}|${from}`;
                                if (shouldSendPrefixHint(hintKey)) {
                                    try {
                                        await conn.sendMessage(from, {
                                            text: `O prefixo desta sessao e "${configured}".\nExemplo: ${configured}ping`
                                        }, { quoted: info });
                                    } catch (_) { /* ignore */ }
                                }
                            }
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                    } catch (_) {}
                    // Auto-download de links (flag autodown no grupo)
                    try {
                        const { tryAutodown } = require('../utils/autodown');
                        if (await tryAutodown(conn, ctx, telegramUserId)) {
                            logger.logInfo(`[${sessionId}] AUTODOWN_HANDLED - messageId=${messageId}`);
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                    } catch (adErr) {
                        logger.logAviso(`[${sessionId}] AUTODOWN_ERROR - ${adErr.message}`);
                    }
                    // Mencao Hanork / reply ao bot / @mencao do bot (VIP/dono)
                    try {
                        const rawText = String(ctx.fullText || ctx.text || '').trim();
                        const hasUrl = /https?:\/\//i.test(rawText);
                        const startsAddress =
                            /^@?hanork\b/i.test(rawText) ||
                            /\b(oi|ola|olá|eae|hey|fala|salve)\s+@?hanork\b/i.test(rawText);
                        const looksLikeAd =
                            /\b(compre|promo|desconto|venda|divulg|grupo de|canal de|link do)\b/i.test(rawText);
                        const pvLoose =
                            !ctx.isGroup &&
                            !hasUrl &&
                            !looksLikeAd &&
                            /\bhanork\b/i.test(rawText) &&
                            rawText.length <= 120;

                        // Reply a msg do bot OU menção @ do bot (mentionedJid)
                        let replyToBot = false;
                        let botMentioned = false;
                        let botMentionDigits = '';
                        try {
                            const { sameParticipant, isSessionSelfIdentity } = require('../utils/moderation');
                            const botJid = conn.user?.id || conn.user?.jid || '';
                            const botLid = conn.user?.lid || '';
                            const q = ctx.quoted;
                            const qids = [
                                q?.key?.fromMe ? botJid : '',
                                q?.participant,
                                q?.participantAlt,
                                q?.participantPn,
                                q?.sender,
                                q?.key?.participant,
                                q?.key?.participantAlt
                            ].filter(Boolean);
                            if (q?.fromMe || q?.key?.fromMe) replyToBot = true;
                            if (qids.some((id) => isSessionSelfIdentity(conn, id))) replyToBot = true;
                            if (!replyToBot && botJid && qids.some((id) => sameParticipant(id, botJid))) {
                                replyToBot = true;
                            }
                            if (!replyToBot && botLid && qids.some((id) => sameParticipant(id, botLid))) {
                                replyToBot = true;
                            }
                            const mentions = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : [];
                            const ctxInfo =
                                ctx.message?.extendedTextMessage?.contextInfo ||
                                ctx.message?.imageMessage?.contextInfo ||
                                ctx.message?.videoMessage?.contextInfo ||
                                ctx.message?.contextInfo ||
                                {};
                            const more = Array.isArray(ctxInfo.mentionedJid) ? ctxInfo.mentionedJid : [];
                            const allMentions = [...new Set([...mentions, ...more].map(String))];
                            const botIds = [botJid, botLid].filter(Boolean);
                            botMentioned = allMentions.some((m) =>
                                botIds.some((b) => isSessionSelfIdentity(conn, m) || sameParticipant(m, b))
                            );
                            if (botMentioned && botJid) {
                                botMentionDigits = String(botJid).split(':')[0].split('@')[0].replace(/\D/g, '');
                            }
                            if (!botMentioned && botJid) {
                                const pn = String(botJid).split(':')[0].split('@')[0].replace(/\D/g, '');
                                if (pn.length >= 8 && new RegExp(`@${pn}\\b`).test(rawText)) {
                                    botMentioned = true;
                                    botMentionDigits = pn;
                                }
                            }
                        } catch (_) { /* ignore */ }

                        const addressed =
                            !hasUrl &&
                            !looksLikeAd &&
                            (startsAddress || pvLoose || replyToBot || botMentioned) &&
                            (rawText || replyToBot || botMentioned);
                        if (
                            addressed &&
                            (ctx.isOwner || ctx.isVip) &&
                            !ctx.command
                        ) {
                            const { executeHanorkChat } = require('../commands/hanorkChat');
                            let rest = rawText
                                .replace(/\b@?hanork\b/ig, ' ')
                                .replace(/\s+/g, ' ')
                                .trim();
                            // Tira o @numero da menção do bot no texto
                            if (botMentionDigits) {
                                rest = rest
                                    .replace(new RegExp(`@?${botMentionDigits}\\b`, 'g'), ' ')
                                    .replace(/\s+/g, ' ')
                                    .trim();
                            }
                            if (!rest && (replyToBot || botMentioned)) rest = 'oi';
                            const mentionCtx = {
                                ...ctx,
                                text: rest,
                                platform: 'whatsapp'
                            };
                            await executeHanorkChat(conn, mentionCtx);
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                    } catch (hkErr) {
                        logger.logAviso(`[${sessionId}] HANORK_MENTION_ERROR - ${hkErr.message}`);
                    }

                    // Intent NL so VIP/dono — membro comum no grupo nao ocupa slot
                    if (ctx.isGroup && !ctx.isOwner && !ctx.isVip) {
                        sessionState.activeMessageIds.delete(messageId);
                        return;
                    }

                    // Intent Router: mensagem sem prefixo (link / CPF / NLU)
                    try {
                        const normalized = normalizeEvent(info, 'whatsapp', conn) || {
                            platform: 'whatsapp',
                            sessionId,
                            chatId: from,
                            userId: sender,
                            isGroup: ctx.isGroup,
                            text: ctx.fullText || ctx.text || '',
                            fullText: ctx.fullText || ctx.text || '',
                            prefix: '',
                            command: '',
                            args: [],
                            raw: info
                        };
                        // Garante que fullText tem o texto bruto sem exigir prefixo
                        if (!normalized.fullText && (ctx.fullText || ctx.text)) {
                            normalized.fullText = ctx.fullText || ctx.text;
                            normalized.text = ctx.fullText || ctx.text;
                        }
                        // Sem prefixo o normalizer deixa command vazio — ok
                        normalized.command = '';
                        normalized.prefix = '';

                        const intentResult = await processIntent(normalized, {
                            conn,
                            telegramUserId,
                            waCtx: ctx,
                            authRole: ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user')
                        });
                        if (intentResult?.handled) {
                            if (intentResult.error) {
                                try {
                                    const { displayPrefix } = require('../utils/configManager');
                                    const { buildRestrictedText, buildRateLimitText } = require('../utils/onboarding');
                                    const p = displayPrefix(telegramUserId, { platform: 'whatsapp' });
                                    if (intentResult.error === 'rate_limit') {
                                        if (!sessionOwnerNow) {
                                        await conn.sendMessage(from, {
                                            text: buildRateLimitText((intentResult.retryAfter || 5000) / 1000)
                                        }, { quoted: info });
                                        }
                                    } else if (intentResult.error === 'paywall') {
                                        /* upsell ja enviado no Intent Router */
                                    } else if (
                                        intentResult.error === 'permission_denied' &&
                                        !ctx.isGroup &&
                                        !ctx.fromMe &&
                                        !info?.key?.fromMe &&
                                        !sessionOwnerNow
                                    ) {
                                        await conn.sendMessage(from, {
                                            text: buildRestrictedText(p)
                                        }, { quoted: info });
                                    }
                                } catch (_) {}
                            } else {
                                try {
                                    const { recordCommandOutcome } = require('../utils/evolution');
                                    const cmdName = intentResult.command || intentResult.route || 'intent';
                                    void recordCommandOutcome(conn, {
                                        telegramUserId,
                                        sender,
                                        command: cmdName,
                                        ok: true,
                                        role: ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user'),
                                        chatId: from,
                                        isGroup: !!ctx.isGroup,
                                        quoted: info,
                                        platform: 'whatsapp',
                                        sendTip: true
                                    });
                                } catch (_) {}
                            }
                            logger.logInfo(`[${sessionId}] INTENT_HANDLED - route=${intentResult.route} messageId=${messageId}`);
                            flowLog(sessionState, 'INTENT_HANDLED', { sessionId, messageId, route: intentResult.route });
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }

                        // Intent miss: tip SO se quase acertou
                        try {
                            const missReason = intentResult?.miss?.reason || '';
                            if (
                                missReason !== 'min_level' &&
                                missReason !== 'chat_reply_blocked_group' &&
                                missReason !== 'bot_noise' &&
                                missReason !== 'group_no_explicit_trigger'
                            ) {
                                const { maybeSendIntentMissHint } = require('../utils/onboarding');
                                await maybeSendIntentMissHint(conn, from, telegramUserId, {
                                    quoted: info,
                                    isGroup: !!ctx.isGroup,
                                    platform: 'whatsapp',
                                    text: ctx.fullText || ctx.text || '',
                                    sender: sender || ctx.sender || '',
                                    candidates: intentResult?.miss?.candidates || [],
                                    topScore: intentResult?.miss?.topScore || 0,
                                    missReason
                                });
                            }
                        } catch (_) {}
                    } catch (intentErr) {
                        logger.logAviso(`[${sessionId}] INTENT_ERROR - ${intentErr.message}`);
                    }

                    // Conversa sem comando: silencioso (nao e erro)
                    flowLog(sessionState, 'MESSAGE_DROPPED', { sessionId, messageId, reason: 'no_prefix' });
                    sessionState.activeMessageIds.delete(messageId);
                    return;
                }
                logger.logInfo(`[${sessionId}] PREFIX_DETECTED - messageId=${messageId}, prefix=${ctx.prefix}`);
                flowLog(sessionState, 'PREFIX_DETECTED', { sessionId, messageId, prefix: ctx.prefix });

                if (!ctx.command) {
                    logger.logAviso(`[${sessionId}] MESSAGE_DROPPED - no_command - messageId=${messageId}`);
                    flowLog(sessionState, 'MESSAGE_DROPPED', { sessionId, messageId, reason: 'no_command' });
                    if (ctx.prefix) {
                        const hintKey = `pfxonly:${telegramUserId}|${from}|${sender || ''}`;
                        if (shouldSendPrefixHint(hintKey)) {
                            try {
                                await sendPrefixOnlyHelp(conn, ctx, telegramUserId, sessionId);
                            } catch (e) {
                                logger.logAviso(`[${sessionId}] prefix-only: ${e.message}`);
                            }
                        }
                    }
                    sessionState.activeMessageIds.delete(messageId);
                    return;
                }
                logger.logInfo(`[${sessionId}] COMMAND_DETECTED - messageId=${messageId}, command=${ctx.command}`);
                flowLog(sessionState, 'COMMAND_DETECTED', { sessionId, messageId, command: ctx.command });

                safeLog(() => logger.logComando(ctx.command, normalizeJid(sender), ctx.isOwner));

                // Atualiza métricas de comando do watchdog
                try {
                    if (conn._watchdogMetrics && typeof conn._watchdogMetrics.updateCommand === 'function') {
                        conn._watchdogMetrics.updateCommand();
                    }
                } catch (e) {}

                const cmd = getCommand(ctx.command);
                logger.logInfo(`[${sessionId}] getCommand - messageId=${messageId}, command=${ctx.command}, cmdFound=${!!cmd}`);
                if (cmd) {
                    try {
                        // Segmentacao: cmds de divulgacao so em grupo marcado
                        const { checkDivulgacaoAllowed } = require('../utils/divulgacaoGate');
                        const divGate = checkDivulgacaoAllowed(ctx.command, {
                            isGroup: ctx.isGroup,
                            groupId: from,
                            telegramUserId
                        });
                        if (!divGate.ok) {
                            try {
                                const { sendDivulgacaoMessage } = require('../utils/divulgacaoReply');
                                await sendDivulgacaoMessage(conn, ctx, { text: divGate.message });
                            } catch (e) {
                                logger.logAviso(`div gate pv: ${e.message}`);
                            }
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }

                        // Fallback classico: mesma hierarquia do Router (defesa em profundidade)
                        try {
                            const { getCommandConfig } = require('../core/router/universalRouter');
                            const { checkPermission } = require('../core/router/permissionManager');
                            const need = getCommandConfig(ctx.command)?.permission || 'user';
                            const perm = await checkPermission(sender, need, sessionId, conn, {
                                platform: 'whatsapp',
                                telegramUserId,
                                fromMe: !!ctx.fromMe,
                                raw: info,
                                isGroup: !!ctx.isGroup,
                                isAdmin: !!ctx.isAdmin,
                                from: from,
                                chatId: from,
                                sender,
                                senderAlt: ctx.senderAlt,
                                authRole: ctx.authRole
                            });
                            const { assertCommand } = require('../utils/commandGate');
                            const gated = assertCommand(ctx, ctx.command);
                            if (!gated.ok) {
                                logger.logAviso(`[AUTH_SILENT] CLASSIC jid=${from} cmd=${ctx.command} | ${perm.reason || gated.reason}`);
                                if (gated.reason === 'paywall') {
                                  try {
                                    await require('../utils/paywall').maybeReplyDeny(conn, ctx, gated);
                                  } catch (_) { /* ignore */ }
                                } else if (gated.reason === 'cmd_blocked') {
                                    try {
                                        await conn.sendMessage(from, {
                                            text: gated.message || 'Este comando esta desligado nesta sessao.'
                                        }, { quoted: info });
                                    } catch (_) {}
                                } else if (gated.reason === 'owner_only' || gated.silent) {
                                    /* modo dono: silencio */
                                } else if (ctx.fromMe || info?.key?.fromMe || sessionOwnerNow) {
                                    /* dono/eco: nao despeja "restrito" no PV */
                                } else if (!ctx.isGroup) {
                                    try {
                                        const { buildRestrictedText } = require('../utils/onboarding');
                                        await conn.sendMessage(from, {
                                            text: buildRestrictedText(getPrefix(telegramUserId))
                                        }, { quoted: info });
                                    } catch (_) { /* ignore */ }
                                }
                                sessionState.activeMessageIds.delete(messageId);
                                return;
                            }
                            logger.logInfo(
                                `[PIPE] platform=whatsapp cmd=${ctx.command} stage=gate duration=${Date.now() - startedAt}ms status=ok role=${gated.role}`
                            );
                            if (perm.allowed && gated.role !== 'group_admin' && gated.role !== 'user') {
                                applyPermRole(ctx, perm);
                            }
                            if (gated.isGroupAdmin) ctx.isAdmin = true;
                        } catch (e) {
                            logger.logAviso(`[${sessionId}] perm check fail-closed: ${e && e.message ? e.message : e}`);
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }

                        if (isPrivatePersonChat(ctx) && pvAntiWouldBlock(ctx, telegramUserId)) {
                            try { await processPrivateSecurity(conn, ctx, telegramUserId); } catch (_) { /* ignore */ }
                            logger.logAviso(`[${sessionId}] ANTIPV_CMD_BLOCK cmd=${ctx.command} from=${from}`);
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }

                        const commandStartTime = Date.now();
                        logger.logInfo(`[${sessionId}] COMMAND_STARTED - messageId=${messageId}, command=${ctx.command}`);
                        flowLog(sessionState, 'COMMAND_STARTED', { sessionId, messageId, command: ctx.command });
                        if (cmd.useCtx || cmd['useCtx']) {
                            await cmd.execute(conn, ctx);
                            const commandDuration = Date.now() - commandStartTime;
                            logger.logInfo(`[${sessionId}] COMMAND_FINISHED - messageId=${messageId}, command=${ctx.command}, durationMs=${commandDuration}`);
                            if (commandDuration > 5000) {
                                logger.logAviso(`[${sessionId}] COMMAND_SLOW - messageId=${messageId}, command=${ctx.command}, durationMs=${commandDuration} (>5s)`);
                            }
                        } else {
                            await cmd.execute(conn, from, info, ctx.args || [], ctx.text || '', ctx.isOwner || false, ctx.isVip || false);
                            const commandDuration = Date.now() - commandStartTime;
                            logger.logInfo(`[${sessionId}] COMMAND_FINISHED - messageId=${messageId}, command=${ctx.command}, durationMs=${commandDuration}`);
                            if (commandDuration > 5000) {
                                logger.logAviso(`[${sessionId}] COMMAND_SLOW - messageId=${messageId}, command=${ctx.command}, durationMs=${commandDuration} (>5s)`);
                            }
                        }
                        stats.commands++;
                        flowLog(sessionState, 'COMMAND_FINISHED', { sessionId, messageId, command: ctx.command, durationMs: Date.now() - startedAt });
                        try {
                            const { recordCommandOutcome } = require('../utils/evolution');
                            void recordCommandOutcome(conn, {
                                telegramUserId,
                                sender,
                                command: ctx.command,
                                ok: true,
                                role: ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user'),
                                chatId: from,
                                isGroup: !!ctx.isGroup,
                                quoted: info,
                                platform: 'whatsapp',
                                sendTip: true
                            });
                        } catch (_) {}
                    } catch (e) {
                        safeLog(() => logger.logException('COMMAND_ERROR', e, {
                            sessionId,
                            messageId,
                            command: ctx?.command || 'desconhecido'
                        }));
                        try {
                            const { toPublicError } = require('../core/router/errorHandler');
                            const userMsg = toPublicError(e);
                            safeLog(() => logger.logUserFacingError('COMMAND_ERROR', e.message || String(e), {
                                sessionId,
                                command: ctx?.command,
                                private: String(e?.stack || e).slice(0, 2000)
                            }));
                            await conn.sendMessage(from, { text: userMsg }, { quoted: info });
                        } catch (sendError) {
                            safeLog(() => logger.logException('SEND_ERROR', sendError, { sessionId, messageId }));
                        }
                    }
                } else {
                    const safeMessageId = messageId || 'unknown';
                    logger.logAviso(`[${sessionId}] COMANDO_NAO_ENCONTRADO - messageId=${safeMessageId}, command=${ctx.command}`);
                    if (ctx.command === "repo") {
                        await handleRepoCommand(conn, ctx, telegramUserId);
                        stats.commands++;
                    } else if (ctx.command === "menu" || ctx.command === "ajuda" || ctx.command === "help") {
                        {
                            const { resolveMenuViewerRole } = require('../utils/menuCatalog');
                            await sendMainMenu(
                                conn,
                                from,
                                info,
                                telegramUserId,
                                sessionId,
                                resolveMenuViewerRole(ctx, telegramUserId)
                            );
                        }
                        stats.commands++;
                    } else {
                        // .menu_downloads / .menu_webia / menu_cat_* → painel da categoria
                        let openedMenu = false;
                        try {
                            const { resolveMenuCatId, sendCategoryPanel } = require('../utils/menuCatalog');
                            const catId = resolveMenuCatId(ctx.command)
                                || resolveMenuCatId(`menu_${ctx.command}`)
                                || (String(ctx.command).startsWith('menu_cat_')
                                    ? String(ctx.command).replace('menu_cat_', '')
                                    : null);
                            if (catId) {
                                const { resolveMenuViewerRole } = require('../utils/menuCatalog');
                                await sendCategoryPanel(conn, {
                                    catId,
                                    chatId: from,
                                    quoted: info,
                                    telegramUserId,
                                    sessionId,
                                    isGroup: !!ctx.isGroup,
                                    viewerRole: resolveMenuViewerRole(ctx, telegramUserId),
                                    viewerCtx: ctx
                                });
                                stats.commands++;
                                openedMenu = true;
                            }
                        } catch (_) { /* fallthrough */ }

                        if (!openedMenu) {
                        // `...` / `.$$` / lixo apos prefixo: nao e comando
                        if (!/^[a-z][a-z0-9_]{0,48}$/i.test(String(ctx.command || ''))) {
                            sessionState.activeMessageIds.delete(messageId);
                            return;
                        }
                        try {
                            const { inspectInjection, logInjectionAttempt } = require('../utils/promptInjection');
                            const inj = inspectInjection(ctx.fullText || ctx.command);
                            if (inj.hit) {
                                logInjectionAttempt({
                                    telegramUserId,
                                    sender,
                                    chatId: from,
                                    isGroup: !!ctx.isGroup,
                                    reasons: inj.reasons,
                                    text: ctx.fullText || ctx.command
                                });
                                sessionState.activeMessageIds.delete(messageId);
                                return;
                            }
                        } catch (_) { /* */ }
                        safeLog(() => logger.logAviso(`Comando desconhecido: ${ctx.command}`));
                        try {
                            const { stripAccents } = require('../utils/typography');
                            const { displayPrefix } = require('../utils/configManager');
                            const { buildUnknownCommandHint } = require('../utils/menuTaxonomy');
                            const p = displayPrefix(telegramUserId, { prefix: ctx.prefix });
                            const hint = stripAccents(buildUnknownCommandHint(ctx.command, p));
                            await conn.sendMessage(from, { text: hint }, { quoted: info });
                        } catch (_) {}
                        }
                    }
                }

                const elapsed = Date.now() - startedAt;
                const safeMessageId = messageId || 'unknown';
                if (ctx && ctx.command) {
                    logger.logInfo(
                        `[PIPE] platform=whatsapp cmd=${ctx.command} stage=done duration=${elapsed}ms status=ok`
                    );
                }
                if (elapsed > 750) {
                    safeLog(() => logger.logPerf('MESSAGE', { sessionId, messageId: safeMessageId, durationMs: elapsed, command: ctx.command || 'interactive' }));
                }
                
                // Cleanup no final do processamento normal
                sessionState.activeMessageIds.delete(safeMessageId);
            }, { priority, noise: !priority }).catch((err) => {
                safeLog(() => logger.logException('EVENT', err, { sessionId, source: 'messages.upsert' }));
            });
        }

        const batchElapsed = Date.now() - batchStartedAt;
        if (batchElapsed > 500) {
            safeLog(() => logger.logPerf('UPSERT_BATCH', { sessionId, type, durationMs: batchElapsed, count: messages.length }));
        }
    };

    conn._messageHandlerBound = true;
    conn._messageUpsertListener = messageListener;
    conn.ev.on("messages.upsert", messageListener);
    logger.logInfo(`[${sessionId}] setupHandlers concluído - listener registrado com sucesso`);
}

// ===== handleButtonAction COMPLETO =====
async function handleButtonAction(conn, ctx, id, telegramUserId, sessionId) {
    if (isPrivatePersonChat(ctx)) {
        try {
            const atk = await processPrivateAttackGuard(conn, ctx, telegramUserId, ctx.info || ctx.msg);
            if (atk && atk.handled) {
                logger.logAviso(`[ANTIATAQUE-PV] button blocked id=${id} from=${ctx.from}`);
                return;
            }
        } catch (_) { /* ignore */ }
        if (pvAntiWouldBlock(ctx, telegramUserId)) {
            try { await processPrivateSecurity(conn, ctx, telegramUserId); } catch (_) { /* ignore */ }
            logger.logAviso(`[ANTIPV] button blocked id=${id} from=${ctx.from}`);
            return;
        }
    }
    const { previewText } = require("../utils/typography");
    let from = ctx.from || ctx.fromOld || 'status@broadcast';
    let info = ctx.info || ctx.infoOld;
    const btnId = String(id || '').trim();
    logger.logAcaoBotao(btnId);
    if (!String(from).endsWith('@g.us')) {
        try {
            const { keepInboundChatJid } = require("../utils");
            from = keepInboundChatJid(from, info?.key) || from;
            ctx.from = from;
        } catch (_) { /* mapping opcional */ }
    }

    // Revalida no clique: botao no grupo pode ser apertado por qualquer membro
    // (nao confiar em quem abriu o menu). div_* / menus sensiveis = dono da sessao.
    const needsOwnerBtn =
        /^(div_|osint_|gm_|cmd_osint|cmd_grupos|cmd_div|cmd_addgrupo|cmd_removergrupo|cmd_nuke|cmd_addvip|cmd_removevip|cmd_addowner|cmd_removeowner|cmd_setprefix|cmd_consulta|cmd_cpf|cmd_telefone|cmdunblock_)/i.test(btnId) ||
        /^menu_(divulgacao|nuke|admin|consultas|config)\b/i.test(btnId);
    if (needsOwnerBtn) {
        try {
            const { isFreshSessionOwner } = require('../utils/authorization');
            if (isFreshSessionOwner(ctx)) ctx.isOwner = true;
        } catch (_) {
            try { setAuthorizationFlags(ctx, telegramUserId); } catch (_e) { /* ignore */ }
        }
    }
    if (needsOwnerBtn && !ctx.isOwner) {
        if (!ctx.isGroup) {
            try {
                const { requireSessionOwner } = require("../utils/authorization");
                const ok = await requireSessionOwner(conn, ctx);
                if (ok) {
                    ctx.isOwner = true;
                } else {
                    return;
                }
            } catch (_) {
                return;
            }
        } else {
            try {
                const logger = require('../logger');
                if (/^gm_/i.test(btnId)) {
                    logger.logAviso(`[AUTH_SILENT] gm btn=${btnId} role=${ctx.authRole || '?'}`);
                }
            } catch (_) { /* ignore */ }
            console.log(
                `[AUTH_SILENT] BTN jid=${from} btn=${btnId} role=${ctx.authRole || '?'} | dono obrigatorio`
            );
            return;
        }
    }

    // alias local — resto do handler usa `id`
    id = btnId;
    if (id === 'menu_dono' || id === 'menudono') id = 'cmd_menu_dono';
    if (id === 'menu_adm' || id === 'menuadm') id = 'cmd_menu_adm';
    if (id === 'menu_dk' || id === 'dkmenu' || id === 'menudk') id = 'cmd_menu_dk';

    // Gerenciador de grupos: clique abre o painel. Nao pede pra digitar .grupos
    // (a API Hanork tem um cmd homonimo `grupos <q>` que virava hint de uso).
    {
        const rawGm = String(id || '').trim();
        const gmName = rawGm
            .replace(/^(cmd_|menu_cat_|menu_|tg_cmd_)/i, '')
            .replace(/^[.\/!#•$]+/, '')
            .toLowerCase();
        if (
            rawGm === 'gm_home' ||
            rawGm === 'menu_grupos' ||
            gmName === 'grupos' ||
            gmName === 'divgrupos'
        ) {
            try {
                const { handleGroupManagerClick } = require("../commands/groupManager");
                await handleGroupManagerClick(conn, ctx, 'gm_home');
            } catch (e) {
                logger.logException('GROUP_MGR', e, { sessionId });
                const { toPublicError } = require('../core/router/errorHandler');
                await conn.sendMessage(from, { text: toPublicError(e) }, { quoted: info }).catch(() => {});
            }
            return;
        }
    }

    try {
        const { isDivulgacaoUiButton, divulgacaoUiTarget } = require("../utils/divulgacaoReply");
        let divUi = isDivulgacaoUiButton(id);
        if (!divUi) {
            try {
                const { resolveMenuCatId } = require("../utils/menuCatalog");
                divUi = resolveMenuCatId(id) === 'divulgacao';
            } catch (_) { /* ignore */ }
        }
        if (divUi) {
            const t = divulgacaoUiTarget(ctx, conn);
            from = t.jid;
            info = t.quoted;
        }
    } catch (_) { /* UI segue no chat original */ }

    // Usa as funções com telegramUserId
    const config = getConfig(telegramUserId);
    const data = getGruposParaDivulgar(telegramUserId);

    // Submenus / categorias — painel unificado (botoes ON = lista; OFF = texto util)
    {
        const { resolveMenuCatId, sendCategoryPanel, resolveMenuViewerRole } = require("../utils/menuCatalog");
        const catId = resolveMenuCatId(id);
        if (catId === 'divulgacao') {
            const divmenuCmd = getCommand("divmenu");
            if (divmenuCmd) {
                await divmenuCmd.execute(conn, ctx);
                return;
            }
        }
        if (catId) {
            const ok = await sendCategoryPanel(conn, {
                catId,
                chatId: from,
                quoted: info,
                telegramUserId,
                sessionId,
                isGroup: !!from?.endsWith?.("@g.us"),
                viewerRole: resolveMenuViewerRole(ctx, telegramUserId),
                viewerCtx: ctx
            });
            if (ok === null) {
                await conn.sendMessage(from, { text: "Categoria nao encontrada." }, { quoted: info });
            }
            return;
        }
    }

    if (id === "ping") {
        const pingCmd = getCommand("ping");
        if (pingCmd) await pingCmd.execute(conn, ctx);
        return;
    }

    if (id === "stats" || id === "stats_refresh" || id === "menu_stats") {
        const statsCmd = getCommand("stats");
        if (statsCmd) await statsCmd.execute(conn, ctx);
        return;
    }

    if (id === "cmdunblock_all") {
        const cmd = getCommand("unblockall") || getCommand("unblock");
        if (cmd) {
            ctx.text = 'all';
            await cmd.execute(conn, ctx);
        }
        return;
    }
    if (id.startsWith("cmdunblock_")) {
        const idx = id.replace("cmdunblock_", "");
        const cmd = getCommand("unblock");
        if (cmd) {
            ctx.text = idx;
            await cmd.execute(conn, ctx);
        }
        return;
    }

    if (id === "div_menu") {
        const divmenuCmd = getCommand("divmenu");
        if (divmenuCmd) await divmenuCmd.execute(conn, ctx);
        return;
    }
    if (id === "div_slots") {
        const { showSlotsPanel } = require("../commands/divulgar/config");
        await showSlotsPanel(conn, ctx);
        return;
    }
    if (id === "div_invite_setgrupo") {
        const { handleInvitePanelAction } = require("../commands/divulgar/config");
        await handleInvitePanelAction(conn, ctx, "setgrupo");
        return;
    }
    if (id === "div_invite_tpl_status") {
        const { handleInvitePanelAction } = require("../commands/divulgar/config");
        await handleInvitePanelAction(conn, ctx, "tpl_status");
        return;
    }
    if (id === "div_invite_tpl_cta") {
        const { handleInvitePanelAction } = require("../commands/divulgar/config");
        await handleInvitePanelAction(conn, ctx, "tpl_cta");
        return;
    }
    if (id === "div_invite_preview_status") {
        const { handleInvitePanelAction } = require("../commands/divulgar/config");
        await handleInvitePanelAction(conn, ctx, "preview_status");
        return;
    }
    if (id === "div_invite_preview_cta") {
        const { handleInvitePanelAction } = require("../commands/divulgar/config");
        await handleInvitePanelAction(conn, ctx, "preview_cta");
        return;
    }
    if (id.startsWith("div_slot_track_")) {
        const { showSlotsPanel } = require("../commands/divulgar/config");
        await showSlotsPanel(conn, ctx);
        return;
    }
    if (id.startsWith("div_slot_set_")) {
        const { showSlotsPanel, showCtaPanel, showStatusPanel } = require("../commands/divulgar/config");
        const { setActiveSlot, isDivAdmin } = require("../utils/divulgacao");
        const m = id.match(/^div_slot_set_(cta|status)_([12])$/);
        if (!m || !isDivAdmin(ctx.telegramUserId)) {
            await showSlotsPanel(conn, ctx, "Padroes so ADM.");
            return;
        }
        const track = m[1];
        const slot = Number(m[2]);
        setActiveSlot(ctx.telegramUserId, track, slot);
        if (track === "cta") {
            await showCtaPanel(conn, ctx, `Edicao CTA → slot ${slot}`);
            return;
        }
        await showStatusPanel(conn, ctx, `Edicao Status → slot ${slot}`);
        return;
    }
    if (id.startsWith("div_slot_midia_")) {
        const { showSlotsPanel, showSlotMediaPanel } = require("../commands/divulgar/config");
        const { setActiveSlot, isDivAdmin } = require("../utils/divulgacao");
        const m = id.match(/^div_slot_midia_(cta|status)_([12])$/);
        if (!m || !isDivAdmin(ctx.telegramUserId)) {
            await showSlotsPanel(conn, ctx, "Padroes so ADM.");
            return;
        }
        setActiveSlot(ctx.telegramUserId, m[1], Number(m[2]));
        await showSlotMediaPanel(conn, ctx, m[1], `Midia ${m[1]} → slot ${m[2]}`);
        return;
    }
    if (id.startsWith("div_slot_auto_")) {
        const { showSlotsPanel } = require("../commands/divulgar/config");
        const { isDivAdmin, modoKey } = require("../utils/divulgacao");
        const m = id.match(/^div_slot_auto_(cta|status)_([12])$/);
        if (!m || !isDivAdmin(ctx.telegramUserId)) {
            await showSlotsPanel(conn, ctx, "Padroes so ADM.");
            return;
        }
        const { toggleModo, restartIfEnabled, normalizeModo, formatModos } = require("../utils/divulgacaoAuto");
        const key = modoKey(m[1], Number(m[2]));
        const config = getConfig(ctx.telegramUserId);
        const modos = toggleModo(config.autoModos, key, null);
        updateConfig(ctx.telegramUserId, { autoModos: modos, autoModoIndex: 0 });
        const on = modos.includes(normalizeModo(key));
        restartIfEnabled(ctx.telegramUserId, on
            ? { tipos: [key], armTipos: [key], resetClock: true }
            : { tipos: [key] });
        await showSlotsPanel(
            conn,
            ctx,
            `${formatModos([normalizeModo(key)])}: ${on ? 'ON' : 'OFF'}`
        );
        return;
    }
    if (id.startsWith("div_slot_send_")) {
        const { isDivAdmin } = require("../utils/divulgacao");
        const { mostrarConfirmacao } = require("../commands/divulgar/div");
        const m = id.match(/^div_slot_send_(cta|status)_([12])$/);
        if (!m || !isDivAdmin(ctx.telegramUserId)) return;
        const track = m[1];
        const slot = Number(m[2]);
        const config = getConfig(ctx.telegramUserId);
        const qtd = config.quantidade || 1;
        const delayMsg = config.delayMsg || 3000;
        if (typeof mostrarConfirmacao === 'function') {
            await mostrarConfirmacao(conn, ctx, track, qtd, delayMsg, slot);
        }
        return;
    }

    if (id === "div_iniciar") {
        if (!data.grupos.length) {
            await sendButtonsWithImage(
                conn,
                from,
                "ADICIONE GRUPOS\n\nDivulgacao so vai pros grupos da lista.\nUse addgrupo (ou addgrupo off) no grupo.",
                [
                    { id: "gm_home", label: "Gerenciar grupos" },
                    { id: "div_config", label: "Configurar" }
                ],
                "Hanork Bot",
                info,
                "menu.jpg",
                "ADICIONE GRUPOS",
                "Clique abaixo",
                telegramUserId,
                null,
                sessionId
            );
            return;
        }

        await sendInteractiveButtons(
            conn,
            from,
            `ESCOLHA O TIPO DE DIVULGACAO\n\n` +
            `Manda SO o tipo que voce clicar. Nao mistura texto+CTA+pay+status.\n\n` +
            `${formatTracksSummary(config)}\n\n` +
            `Texto = msgdivul (varios links) + mencoes.\n` +
            `CTA = cartao (texto + botao + link) + mencoes.\n` +
            `Pagamento = msgdivulpay + mencoes.\n` +
            `Status = msgdivulstatus + foto/video proprios (nao usa o texto normal).`,
            [
                { id: "div_tipo_normal", label: "Texto", desc: "Msg com varios links + mencoes" },
                { id: "div_tipo_cta", label: "CTA", desc: "Cartao com botao e link" },
                { id: "div_tipo_pay", label: "Pagamento", desc: "Texto do pix/pagamento" },
                { id: "div_tipo_status", label: "Status", desc: "Manda no status dirigido" },
                { id: "div_tipo_full", label: "Modo salvo", desc: "Usa o tipo da config atual" },
                { id: "div_config", label: "Configurar", desc: "Delay, quantidade, midia" },
                { id: "div_menu", label: "Voltar", desc: "Volta ao menu de divulgacao" }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            telegramUserId
        );
        return;
    }

    // ===== HANDLERS DOS TIPOS DE DIVULGAÇÃO =====
    if (id === "div_tipo_normal") {
        const divCmd = getCommand("div");
        if (divCmd) await divCmd.execute(conn, ctx);
        return;
    }
    if (id === "div_tipo_cta") {
        const divCmd = getCommand("divbotao") || getCommand("divctaenvio");
        if (divCmd) await divCmd.execute(conn, ctx);
        return;
    }
    // Mencoes sao padrao em toda divulgacao — botao removido; alias cai no texto
    if (id === "div_tipo_mark") {
        const divCmd = getCommand("div") || getCommand("divmark");
        if (divCmd) await divCmd.execute(conn, ctx);
        return;
    }
    if (id === "div_tipo_pay") {
        const divCmd = getCommand("divpay");
        if (divCmd) await divCmd.execute(conn, ctx);
        return;
    }
    if (id === "div_tipo_status") {
        const divCmd = getCommand("divstatus");
        if (divCmd) await divCmd.execute(conn, ctx);
        return;
    }
    if (id === "div_tipo_full") {
        const divCmd = getCommand("divfull");
        if (divCmd) await divCmd.execute(conn, ctx);
        return;
    }

    if (id === "div_config") {
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id === "div_config_cta") {
        const { showCtaPanel } = require("../commands/divulgar/config");
        await showCtaPanel(conn, ctx);
        return;
    }

    if (id === "div_editar_texto" || id === "div_config_texto") {
        const cmd = getCommand("div_config_texto") || getCommand("msgdivul");
        if (cmd) {
            ctx.text = '';
            await cmd.execute(conn, ctx);
        }
        return;
    }

    if (id === "div_config_pay") {
        const cmd = getCommand("div_config_pay") || getCommand("msgdivulpay");
        if (cmd) {
            ctx.text = '';
            await cmd.execute(conn, ctx);
        }
        return;
    }

    if (id === "div_config_status_texto") {
        const { startStatusPrompt } = require("../commands/divulgar/config");
        await startStatusPrompt(conn, ctx);
        return;
    }

    if (id === "div_cta_wizard") {
        const cmd = getCommand("div_cta_wizard") || getCommand("divcta");
        if (cmd) {
            ctx.text = '';
            await cmd.execute(conn, ctx);
        }
        return;
    }

    if (id === "div_cta_texto") {
        const cmd = getCommand("div_cta_texto");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id === "div_cta_label") {
        const cmd = getCommand("div_cta_label");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id === "div_cta_url") {
        const cmd = getCommand("div_cta_url");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_cta_label2") {
        const cmd = getCommand("div_cta_label2");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_cta_url2") {
        const cmd = getCommand("div_cta_url2");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_cta_btn2_rm") {
        const cmd = getCommand("div_cta_btn2_rm");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id === "div_cta_foto") {
        const cmd = getCommand("fotodivulcta");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_cta_foto_remover") {
        const cmd = getCommand("apagafotodivulcta");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id === "div_cta_remover") {
        updateConfig(telegramUserId, { cta: null });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    // ========== HANDLER PARA BOTÕES DE CÓPIA ==========
    if (id.startsWith("copy_")) {
        const code = id.replace("copy_", "");
        const pvJid = info.key.participant || info.key.remoteJid || from;
        await conn.sendMessage(pvJid, { text: `Codigo copiado: ${code}` }, { quoted: null });
        await conn.sendMessage(from, { text: "Codigo enviado no seu PV." }, { quoted: info });
        return;
    }

    if (id === "div_preview") {
        const previewCmd = getCommand("previewdivul");
        if (previewCmd) await previewCmd.execute(conn, ctx);
        return;
    }

    if (id === "div_grupos") {
        const { handleGroupManagerClick } = require("../commands/groupManager");
        await handleGroupManagerClick(conn, ctx, "gm_home");
        return;
    }

    if (id === "div_grupos_lista") {
        const lista = data.grupos.length > 0 ? data.grupos.join('\n') : 'Nenhum grupo adicionado';
        
        await sendButtonsWithImage(
            conn,
            from,
            `GRUPOS DE DIVULGACAO\n\n` +
            `So estes grupos recebem a divulgacao.\n` +
            `Use addgrupo (ou addgrupo off) no grupo.\n` +
            `Convites: Gerenciar grupos (entrar na fila).\n\n` +
            `Lista:\n${lista}`,
            [
                { id: "gm_home", label: "Gerenciar grupos" },
                { id: "div_limpar_grupos", label: "Limpar lista" },
                { id: "div_ver_grupos", label: "Ver grupos" },
                { id: "div_config", label: "Voltar" }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            "GRUPOS",
            "Clique abaixo",
            telegramUserId
        );
        return;
    }

    if (id === "div_ver_grupos") {
        const lista = data.grupos.length > 0 ? data.grupos.join('\n') : 'Nenhum grupo adicionado';
        
        await sendButtonsWithImage(
            conn,
            from,
            `GRUPOS ADICIONADOS\n\n` +
            `${lista}\n\n` +
            `Use addgrupo (ou addgrupo off) no grupo.`,
            [
                { id: "gm_home", label: "Gerenciar grupos" },
                { id: "div_grupos_lista", label: "Voltar" },
                { id: "div_limpar_grupos", label: "Limpar lista" }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            "GRUPOS",
            "Clique abaixo",
            telegramUserId
        );
        return;
    }

    if (id === "div_ajuda") {
        const ajudaCmd = getCommand("divajuda");
        if (ajudaCmd) await ajudaCmd.execute(conn, ctx);
        return;
    }

    if (id === "div_config_modo") {
        const cmd = getCommand("divconfigmodo");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_config_status") {
        const { showStatusPanel } = require("../commands/divulgar/config");
        await showStatusPanel(conn, ctx);
        return;
    }
    if (id === "div_config_qtd") {
        const cmd = getCommand("divconfigqtd");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_config_delaymsg") {
        const cmd = getCommand("divconfigdelaymsg");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_config_delaygrupo") {
        const cmd = getCommand("divconfigdelaygrupo");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_config_ordem") {
        const cmd = getCommand("divconfigordem");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_config_repetir") {
        const cmd = getCommand("divconfigrepetir");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_config_auto") {
        const cmd = getCommand("divauto");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_auto_on") {
        ctx.args = ['on'];
        const cmd = getCommand("divauto");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_auto_off") {
        ctx.args = ['off'];
        const cmd = getCommand("divauto");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id.startsWith("div_auto_tipo_")) {
        const raw = id.slice("div_auto_tipo_".length).replace(/_(2|3)$/, ':$1');
        ctx.args = [raw, "toggle"];
        const cmd = getCommand("divconfigautomodos");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_auto_modos_texto") {
        ctx.args = ['texto'];
        const cmd = getCommand("divconfigautomodos");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_auto_modos_todos") {
        ctx.args = ['todos'];
        const cmd = getCommand("divconfigautomodos");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_auto_modos_nenhum") {
        ctx.args = ['nenhum'];
        const cmd = getCommand("divconfigautomodos");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id.startsWith("div_auto_tempo_")) {
        const { showAutoIntervalPicker } = require("../commands/divulgar/config");
        const raw = id.slice("div_auto_tempo_".length).replace(/_(2|3)$/, ':$1');
        await showAutoIntervalPicker(conn, ctx, raw);
        return;
    }
    if (id.startsWith("div_auto_int_")) {
        const rest = id.replace("div_auto_int_", "");
        const typed = rest.match(/^(normal|cta|pay|status|full)(?:_([23]))?_(\d+)$/);
        if (typed) {
            const modo = typed[2] ? `${typed[1]}:${typed[2]}` : typed[1];
            ctx.args = [modo, typed[3]];
        } else {
            ctx.args = [rest];
        }
        const cmd = getCommand("divconfigauto");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id.startsWith("div_auto_randpick_")) {
        const { showAutoRandomPicker } = require("../commands/divulgar/config");
        const t = id.slice("div_auto_randpick_".length).replace(/_(2|3)$/, ':$1');
        await showAutoRandomPicker(conn, ctx, t === 'all' ? null : t);
        return;
    }
    if (id === "div_auto_msgspick") {
        const { showAutoMsgsPicker } = require("../commands/divulgar/config");
        await showAutoMsgsPicker(conn, ctx);
        return;
    }
    if (id === "div_auto_mingappick") {
        const { showAutoMinGapPicker } = require("../commands/divulgar/config");
        await showAutoMinGapPicker(conn, ctx);
        return;
    }
    if (id.startsWith("div_auto_rand_")) {
        const rest = id.replace("div_auto_rand_", "");
        const m = rest.match(/^(normal|cta|pay|status|full|all)_(\d+)_(\d+)$/);
        if (m) {
            ctx.args = m[1] === 'all'
                ? ['aleatorio', m[2], m[3]]
                : [m[1], 'aleatorio', m[2], m[3]];
            const cmd = getCommand("divconfigauto");
            if (cmd) await cmd.execute(conn, ctx);
        }
        return;
    }
    if (id.startsWith("div_auto_randoff_")) {
        const t = id.slice("div_auto_randoff_".length);
        ctx.args = t === 'all' ? ['aleatorio', 'off'] : [t, 'aleatorio', 'off'];
        const cmd = getCommand("divconfigauto");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_auto_msgs_on" || id === "div_auto_msgs_off") {
        ctx.args = ['msgs', id.endsWith('_on') ? 'on' : 'off'];
        const cmd = getCommand("divconfigauto");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id.startsWith("div_auto_msgs_")) {
        const n = id.slice("div_auto_msgs_".length);
        if (/^\d+$/.test(n)) {
            ctx.args = ['msgs', n];
            const cmd = getCommand("divconfigauto");
            if (cmd) await cmd.execute(conn, ctx);
        }
        return;
    }
    if (id.startsWith("div_auto_mingap_")) {
        const n = id.slice("div_auto_mingap_".length);
        if (/^\d+$/.test(n)) {
            ctx.args = ['min', n];
            const cmd = getCommand("divconfigauto");
            if (cmd) await cmd.execute(conn, ctx);
        }
        return;
    }
    if (id === "div_autocriar_on") {
        ctx.args = ['on'];
        const cmd = getCommand("divautocriar");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_autocriar_off") {
        ctx.args = ['off'];
        const cmd = getCommand("divautocriar");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_auto_min_3" || id === "div_auto_min_5") {
        ctx.args = [id.endsWith("3") ? "3" : "5"];
        const cmd = getCommand("divconfigmingrupos");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_criar_lote") {
        ctx.args = ['3'];
        const cmd = getCommand("divcriagrupo");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_config_midia") {
        const { showMediaPanel } = require("../commands/divulgar/config");
        await showMediaPanel(conn, ctx);
        return;
    }
    if (id === "div_midia_texto_foto") {
        const cmd = getCommand("fotodivul");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_midia_texto_video") {
        const cmd = getCommand("videodivul");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_midia_texto_audio") {
        const cmd = getCommand("audiodivul");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_midia_texto_doc") {
        const cmd = getCommand("documentodivul");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_midia_texto_rm") {
        try {
            const { unlinkMediaFile } = require('../utils/divulgacao');
            unlinkMediaFile(telegramUserId, 'div-texto.bin');
        } catch (_) { /* */ }
        updateConfig(telegramUserId, { midia: null, midiaFile: null, midiaTipo: null, midiaMimetype: null, midiaNome: null, legenda: null });
        const { showMediaPanel } = require("../commands/divulgar/config");
        await showMediaPanel(conn, ctx);
        return;
    }
    if (id === "div_midia_cta_foto") {
        const cmd = getCommand("fotodivulcta");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_midia_cta_video") {
        const { runMediaCommand } = require("../commands/divulgar/config");
        if (typeof runMediaCommand === 'function') {
            await runMediaCommand(conn, ctx, 'video', 'cta');
        } else {
            const cmd = getCommand("fotodivulcta");
            if (cmd) await cmd.execute(conn, ctx);
        }
        return;
    }
    if (id === "div_midia_cta_rm") {
        const cmd = getCommand("apagafotodivulcta");
        if (cmd) await cmd.execute(conn, ctx);
        else {
            const { showMediaPanel } = require("../commands/divulgar/config");
            await showMediaPanel(conn, ctx);
        }
        return;
    }
    if (id === "div_midia_status_foto") {
        const { runMediaCommand } = require("../commands/divulgar/config");
        await runMediaCommand(conn, ctx, 'image', 'status');
        return;
    }
    if (id === "div_midia_status_video") {
        const { runMediaCommand } = require("../commands/divulgar/config");
        await runMediaCommand(conn, ctx, 'video', 'status');
        return;
    }
    if (id === "div_midia_status_rm") {
        try {
            const { clearStatusMedia } = require('../utils/divulgacao');
            clearStatusMedia(telegramUserId);
        } catch (_) { /* */ }
        const { showMediaPanel } = require("../commands/divulgar/config");
        await showMediaPanel(conn, ctx);
        return;
    }

    // ========== HANDLERS DE MODO COM COMBINAÇÕES ==========
    if (id === "div_modo_texto") {
        updateConfig(telegramUserId, { modoPrincipal: 'normal' });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id === "div_modo_cta") {
        updateConfig(telegramUserId, { modoPrincipal: 'cta' });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id === "div_modo_pay") {
        updateConfig(telegramUserId, { modoPrincipal: 'pay' });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id === "div_modo_texto_status" || id === "div_modo_cta_status" || id === "div_modo_pay_status") {
        const { showStatusPanel } = require("../commands/divulgar/config");
        await showStatusPanel(conn, ctx, 'Status e um tipo separado. Edita texto/midia aqui; liga o ciclo em Automatico.');
        return;
    }

    // ========== HANDLERS DE CONFIGURAÇÃO COM RETORNO ==========
    if (id === "div_status_on" || id === "div_status_off") {
        const { showStatusPanel } = require("../commands/divulgar/config");
        await showStatusPanel(conn, ctx, 'Liga/desliga o ciclo do STATUS em Automatico (Status ON/OFF). Texto e midia editam neste painel.');
        return;
    }

    if (id.startsWith("div_qtd_")) {
        const parts = id.replace("div_qtd_", "");
        if (parts === "personalizar") {
            await conn.sendMessage(from, { text: "Digite a quantidade (1 a 100):" }, { quoted: info });
            return;
        }
        const quantidade = parseInt(parts) || 1;
        updateConfig(telegramUserId, { quantidade: Math.min(Math.max(quantidade, 1), 100) });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id.startsWith("div_delaymsg_")) {
        const parts = id.replace("div_delaymsg_", "");
        if (parts === "personalizar") {
            await conn.sendMessage(from, { text: "Digite o delay em ms (500 a 30000):" }, { quoted: info });
            return;
        }
        const delay = parseInt(parts) || 3000;
        updateConfig(telegramUserId, { delayMsg: Math.min(Math.max(delay, 500), 30000) });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id.startsWith("div_delaygrupo_")) {
        const parts = id.replace("div_delaygrupo_", "");
        if (parts === "personalizar") {
            await conn.sendMessage(from, { text: "Digite o delay entre grupos em ms (0 a 60000):" }, { quoted: info });
            return;
        }
        const delay = parseInt(parts) || 2000;
        updateConfig(telegramUserId, { delayGrupo: Math.min(Math.max(delay, 0), 60000) });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id === "div_ordem_sequencial") {
        updateConfig(telegramUserId, { ordem: 'sequencial' });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_ordem_aleatoria") {
        updateConfig(telegramUserId, { ordem: 'aleatoria' });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id === "div_repetir_on") {
        updateConfig(telegramUserId, { repetir: true });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_repetir_off") {
        updateConfig(telegramUserId, { repetir: false });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    if (id === "div_midia_adicionar") {
        const cmd = getCommand("fotodivul");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }
    if (id === "div_midia_remover") {
        try {
            const { unlinkMediaFile } = require('../utils/divulgacao');
            unlinkMediaFile(telegramUserId, 'div-texto.bin');
        } catch (_) { /* */ }
        updateConfig(telegramUserId, { midia: null, midiaFile: null, midiaTipo: null, midiaMimetype: null, midiaNome: null, legenda: null });
        const cmd = getCommand("divconfig");
        if (cmd) await cmd.execute(conn, ctx);
        return;
    }

    // "Todos os grupos" removido — sempre lista addgrupo
    if (id === "div_modo_todos" || id === "div_modo_especificos") {
        setModoGrupos(telegramUserId, 'especificos');
        await sendButtonsWithImage(
            conn,
            from,
            "DIVULGACAO SO NOS GRUPOS DA LISTA\n\nUse addgrupo (ou addgrupo off) no grupo.",
            [
                { id: "div_ver_grupos", label: "Ver grupos" },
                { id: "div_limpar_grupos", label: "Limpar lista" },
                { id: "gm_home", label: "Voltar" },
                { id: "div_iniciar", label: "Iniciar divulgacao" }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            "GRUPOS",
            "Clique abaixo",
            telegramUserId
        );
        return;
    }

    if (id === "div_limpar_grupos") {
        limparGrupos(telegramUserId);
        await sendButtonsWithImage(
            conn,
            from,
            "LISTA DE GRUPOS LIMPA\n\nUse addgrupo no grupo que deseja adicionar.",
            [
                { id: "div_ver_grupos", label: "Ver grupos" },
                { id: "gm_home", label: "Voltar" }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            "LIMPADO",
            "Clique abaixo",
            telegramUserId
        );
        return;
    }

    if (id.startsWith("div_confirm_iniciar_")) {
        const divConfirmarCmd = getCommand("divconfirmar");
        if (divConfirmarCmd) {
            ctx.id = id;
            await divConfirmarCmd.execute(conn, ctx);
        }
        return;
    }

    if (id === "div_stop") {
        const divStopCmd = getCommand("divstop");
        if (divStopCmd) {
            await divStopCmd.execute(conn, ctx);
        }
        return;
    }

    if (id.startsWith("div_confirm_cancelar_")) {
        const sessId = id.replace("div_confirm_cancelar_", "");
        divParamsCache.delete(sessId);
        return;
    }

    // ========== FIGURINHA → CANAL ==========
    if (id.startsWith("figc_")) {
        try {
            const { handleFigurinhaCanalClick } = require("../commands/figurinhaCanal");
            await handleFigurinhaCanalClick(conn, ctx, id);
        } catch (e) {
            logger.logException('FIGC', e, { sessionId });
            const { toPublicError } = require('../core/router/errorHandler');
            logger.logUserFacingError('FIGC', e.message || String(e), { sessionId });
            await conn.sendMessage(from, { text: toPublicError(e) }, { quoted: info });
        }
        return;
    }

    // ========== JOIN REQUEST (entrada grupo) ==========
    if (/^join_(accept|reject)(_all)?$/i.test(id)) {
        try {
            const { handleJoinRequestClick } = require("../commands/joinRequests");
            await handleJoinRequestClick(conn, ctx, id);
        } catch (e) {
            const em = String(e?.message || e);
            if (/forbidden|not-authorized/i.test(em)) {
                logger.logAviso(`[JOIN_REQ] ${sessionId}: ${em}`);
            } else {
                logger.logException('JOIN_REQ', e, { sessionId });
            }
            const { toPublicError } = require('../core/router/errorHandler');
            try {
                await conn.sendMessage(from, { text: toPublicError(e) }, { quoted: info });
            } catch (_) { /* ignore */ }
        }
        return;
    }

    // ========== GERENCIADOR DE GRUPOS (dono) ==========
    if (id.startsWith("gm_")) {
        try {
            const { handleGroupManagerClick } = require("../commands/groupManager");
            await handleGroupManagerClick(conn, ctx, id);
        } catch (e) {
            logger.logException('GROUP_MGR', e, { sessionId });
            const { toPublicError } = require('../core/router/errorHandler');
            await conn.sendMessage(from, { text: toPublicError(e) }, { quoted: info }).catch(() => {});
        }
        return;
    }

    // ========== ZONE (ephoto / cliques zn_) ==========
    if (id.startsWith("zn_")) {
        try {
            const { handleZoneClick } = require("../commands/zoneMedia");
            await handleZoneClick(conn, ctx, id);
        } catch (e) {
            logger.logException('ZONE', e, { sessionId });
            const { toPublicError } = require('../core/router/errorHandler');
            await conn.sendMessage(from, { text: toPublicError(e) }, { quoted: info }).catch(() => {});
        }
        return;
    }

    if (id.startsWith("bill_")) {
        try {
            const { handleBillingClick } = require("../commands/billing");
            await handleBillingClick(conn, ctx, id);
        } catch (e) {
            logger.logException('BILLING', e, { sessionId });
            const { toPublicError } = require('../core/router/errorHandler');
            await conn.sendMessage(from, { text: toPublicError(e) }, { quoted: info }).catch(() => {});
        }
        return;
    }

    // ========== OSINT (dono) ==========
    if (id.startsWith("osint_")) {
        try {
            const { handleOsintClick } = require("../commands/osint");
            await handleOsintClick(conn, ctx, id);
        } catch (e) {
            logger.logException('OSINT', e, { sessionId });
            const { toPublicError } = require('../core/router/errorHandler');
            await conn.sendMessage(from, { text: toPublicError(e) }, { quoted: info }).catch(() => {});
        }
        return;
    }

    // ========== INFO (gates sempre ON — explica o que faz) ==========
    if (id === 'prot_atk_confirm' || id === 'prot_atk_cancel') {
        const { handleAtkConfirm } = require('../utils/protectionStore');
        await handleAtkConfirm(conn, ctx, id);
        return;
    }

    const protSet = /^(?:protset_|ps_)([a-z0-9]+)_([01])$/i.exec(String(id || ''));
    if (protSet) {
        ctx.text = protSet[2] === '1' ? 'on' : 'off';
        ctx.q = ctx.text;
        ctx.args = [ctx.text];
        ctx.isInteractive = true;
        id = `cmd_${protSet[1]}`;
    }

    if (id.startsWith("info_")) {
        const { findSecurityItem, buildItemHelpText } = require("../utils/securityMenu");
        const { displayPrefix } = require("../utils/configManager");
        const p = displayPrefix(telegramUserId);
        const it = findSecurityItem(id) || findSecurityItem(id.replace(/^info_/, ""));
        const text = buildItemHelpText(it, p) + `\n\nPainel: ${p}gpseguranca\nO que esta ON: ${p}protecoesativas`;
        await conn.sendMessage(from, { text }, { quoted: info });
        return;
    }

    // ========== EXECUÇÃO DIRETA DE COMANDOS ==========
    if (id.startsWith("cmd_")) {
        const cmdName = id.replace("cmd_", "");
        try {
            const { getCommandConfig } = require('../core/router/universalRouter');
            const { checkPermission } = require('../core/router/permissionManager');
            const need = getCommandConfig(cmdName)?.permission || 'owner';
            const perm = await checkPermission(ctx.sender || from, need, sessionId, conn, {
                platform: 'whatsapp',
                telegramUserId,
                fromMe: !!ctx.fromMe,
                raw: info,
                isGroup: !!ctx.isGroup,
                isAdmin: !!ctx.isAdmin,
                from,
                chatId: from,
                sender: ctx.sender || from,
                senderAlt: ctx.senderAlt,
                authRole: ctx.authRole
            });
            const { assertCommand } = require('../utils/commandGate');
            const gated = assertCommand(ctx, cmdName);
            if (!gated.ok) {
                console.log(`[AUTH_SILENT] CMDBTN jid=${from} cmd=${cmdName} | ${perm.reason || gated.reason}`);
                if (gated.reason === 'paywall') {
                  try { await require('../utils/paywall').maybeReplyDeny(conn, ctx, gated); } catch (_) {}
                }
                return;
            }
            if (perm.allowed && gated.role !== 'group_admin' && gated.role !== 'user') {
                applyPermRole(ctx, perm);
            }
            if (gated.isGroupAdmin) ctx.isAdmin = true;
        } catch (e) {
            logger.logAviso(`CMDBTN perm fail-closed cmd=${cmdName}: ${e && e.message ? e.message : e}`);
            return;
        }

        const catalogItem = findItem(cmdName);
        const hasArgs = (ctx.args && ctx.args.length) || (ctx.text && String(ctx.text).trim());
        const panelCmds = new Set([
          'grupos', 'divgrupos', 'grupolista', 'grupoconfig', 'divmenu', 'gpseguranca',
          'menu_dk', 'dkmenu', 'menudk', 'dk', 'entrardk',
          'dkpay', 'msgdkpay', 'msgdk', 'fotodk', 'listfotodk', 'rmfotodk',
          'dkmidia', 'videodk', 'apagardk', 'qtddk'
        ]);
        if (catalogItem?.needsArgs && !hasArgs && !panelCmds.has(cmdName)) {
            const { getPrefix } = require("../utils/configManager");
            const prefix = getPrefix(telegramUserId) || ".";
            await conn.sendMessage(
                from,
                { text: `${catalogItem.desc}\n\nUso: ${prefix}${catalogItem.usage}` },
                { quoted: info }
            );
            return;
        }
        const cmd = getCommand(cmdName);
        if (cmd) {
            try {
                if (cmd.useCtx || cmd['useCtx']) {
                    await cmd.execute(conn, ctx);
                } else {
                    await cmd.execute(conn, from, info, ctx.args || [], ctx.text || '', ctx.isOwner || false, ctx.isVip || false);
                }
                try {
                    const { recordCommandOutcome } = require('../utils/evolution');
                    void recordCommandOutcome(conn, {
                        telegramUserId,
                        sender: ctx.sender || from,
                        command: cmdName,
                        ok: true,
                        role: ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user'),
                        chatId: from,
                        isGroup: !!ctx.isGroup,
                        quoted: info,
                        platform: 'whatsapp',
                        sendTip: true
                    });
                } catch (_) {}
            } catch (e) {
                logger.logException('CMDBTN', e, { command: cmdName, sessionId });
                const { toPublicError } = require('../core/router/errorHandler');
                logger.logUserFacingError('CMDBTN', e.message || String(e), { command: cmdName, sessionId });
                await conn.sendMessage(from, { text: toPublicError(e) }, { quoted: info });
                try {
                    const { recordCommandOutcome } = require('../utils/evolution');
                    void recordCommandOutcome(conn, {
                        telegramUserId,
                        sender: ctx.sender || from,
                        command: cmdName,
                        ok: false,
                        error: e.message,
                        role: ctx.authRole || 'user',
                        chatId: from,
                        isGroup: !!ctx.isGroup,
                        quoted: info,
                        platform: 'whatsapp',
                        sendTip: true
                    });
                } catch (_) {}
            }
        } else {
            await conn.sendMessage(from, { text: `Comando ${cmdName} nao encontrado.` }, { quoted: info });
        }
        return;
    }

    if (id === "menu") {
        const { resolveMenuViewerRole } = require("../utils/menuCatalog");
        await sendMainMenu(
            conn,
            from,
            info,
            telegramUserId,
            sessionId,
            resolveMenuViewerRole(ctx, telegramUserId)
        );
        return;
    }

    if (id === "channel_link") {
        await conn.sendMessage(from, { text: `Canal Oficial:\n\n${formatCanalPublicText()}` }, { quoted: info });
        return;
    }

    if (id === "menu_comandos") {
        const { displayPrefix } = require("../utils/configManager");
        const {
            textMenuFallback,
            resolveMenuViewerRole
        } = require("../utils/menuCatalog");
        const { sendButtonlessFallback } = require("../helpers");
        const prefix = displayPrefix(telegramUserId);
        const role = resolveMenuViewerRole(ctx, telegramUserId);

        // Sempre catalogo textual completo — 1 mensagem
        await sendButtonlessFallback(conn, from, {
            text: textMenuFallback('whatsapp', prefix, role),
            quoted: info,
            telegramUserId,
            sessionId
        });
        return;
    }

    if (id === "back_to_search") {
        await sendInteractiveList(conn, from, "Pesquise novamente:", [
            { title: "Repositorios", rows: [{ title: "Digite o termo", description: "Use: gitsearch <termo>", id: "search_again" }] }
        ], "Hanork Bot", info);
        return;
    }

    if (id === "search_again") {
        await conn.sendMessage(from, { text: "Digite: gitsearch <termo>" }, { quoted: info });
        return;
    }

    if (id.startsWith("repo_")) {
        const repoName = id.replace("repo_", "");
        await handleRepoCommand(conn, { ...ctx, text: repoName, q: repoName }, telegramUserId);
        return;
    }

    if (id.startsWith("dissecar_completo_")) {
        const stanzaId = id.replace("dissecar_completo_", "");
        const { getCache } = require("../cache");
        const messagesCache = getCache(sessionId || conn?._sessionId || "global");
        const cacheKey = messagesCache.get(`dissecar_btn_${stanzaId}`) || `dissecar_${stanzaId}`;
        const dump = messagesCache.get(cacheKey);
        if (dump) {
            const { jsonReplacer } = require("../utils");
            const texto = JSON.stringify(dump, jsonReplacer(), 2);
            const pvJid = info.key.participant || info.key.remoteJid || from;
            try {
                if (texto.length <= 3500) {
                    await conn.sendMessage(pvJid, { text: `Disseccao completa\n\n\`\`\`json\n${texto}\n\`\`\`` }, { quoted: null });
                } else {
                    await conn.sendMessage(pvJid, {
                        document: Buffer.from(texto, "utf-8"),
                        mimetype: "application/json",
                        fileName: `dissecar_completo.json`,
                        caption: `Disseccao completa\n\nTamanho: ${texto.length} caracteres`
                    }, { quoted: null });
                }
            } catch (e) {
                logger.logErro("dissecar_completo", e.message);
                await conn.sendMessage(from, { text: `Erro ao enviar dump: ${e.message}` }, { quoted: info });
            }
            try {
                await conn.sendMessage(from, { delete: { remoteJid: from, id: info.key.id, fromMe: info.key.fromMe, participant: info.key.participant || from } }).catch(() => {});
            } catch (e) {}
            try {
                if (typeof messagesCache.del === "function") {
                    messagesCache.del(cacheKey);
                    messagesCache.del(`dissecar_btn_${stanzaId}`);
                }
            } catch (_) {}
        } else {
            await conn.sendMessage(from, { text: "Dados expirados. Use dissecar novamente." }, { quoted: info });
        }
        return;
    }

    if (id.startsWith("pair_copy_")) {
        const code = id.replace("pair_copy_", "");
        const pvJid = info.key.participant || info.key.remoteJid;
        await conn.sendMessage(pvJid, { text: `Codigo de pareamento: ${code}` }, { quoted: null });
        await conn.sendMessage(from, { text: "Codigo enviado no seu PV." }, { quoted: info });
        return;
    }

    if (id === "addai_confirm") {
        try {
            if (!String(from || '').endsWith('@g.us')) {
                await conn.sendMessage(from, { text: "Use addai dentro do grupo." }, { quoted: info });
                return;
            }
            // Meta AI: numero publico via env, sem gravar JID no repositorio
            const metaAiJid = String(process.env.META_AI_JID || '').trim();
            if (!metaAiJid) {
                await conn.sendMessage(from, { text: "Defina META_AI_JID para adicionar a Meta AI." }, { quoted: info });
                return;
            }
            await conn.groupParticipantsUpdate(from, [metaAiJid], 'add');
            await conn.sendMessage(from, { text: "Meta AI adicionada (ou convite enviado)." }, { quoted: info });
        } catch (e) {
            await conn.sendMessage(from, {
                text: `Nao foi possivel adicionar a Meta AI: ${e.message || e}`
            }, { quoted: info });
        }
        return;
    }

    if (id === "addai_close") {
        return;
    }

    // ========== CONFIRMACOES ADMIN / EXPLOITS ==========
    if (id === "clearsession_confirm") {
        try {
            const { clearSession } = require("../sessionManager");
            clearSession(sessionId || conn?._sessionId);
            await conn.sendMessage(from, { text: "Sessao limpa. Reconecte pelo Telegram." }, { quoted: info });
        } catch (e) {
            await conn.sendMessage(from, { text: `Falha ao limpar: ${e.message}` }, { quoted: info });
        }
        return;
    }

    if (id === "rr_confirm") {
        await conn.sendMessage(from, { text: "Reiniciando..." }, { quoted: info });
        setTimeout(() => process.exit(0), 800);
        return;
    }

    if (id === "repairsession_again") {
        const cmd = getCommand("repairsession");
        if (cmd) await cmd.execute(conn, from, info, [], '', true, true);
        return;
    }

    if (id === "backupsession_again") {
        const cmd = getCommand("backupsession");
        if (cmd) await cmd.execute(conn, from, info, [], '', true, true);
        return;
    }

    if (id === "crash_confirm") {
        const { isPlatformAdmin } = require("../utils/exploitGate");
        if (!isPlatformAdmin(ctx, conn)) {
            console.log(`[AUTH_SILENT] BTN crash_confirm jid=${from}`);
            return;
        }
        await conn.sendMessage(from, {
            text: "Simulacao de crash concluida.\nO bot continua online (nao houve kill real)."
        }, { quoted: info });
        return;
    }

    if (id.startsWith("travazap_")) {
        const { isPlatformAdmin } = require("../utils/exploitGate");
        if (!isPlatformAdmin(ctx, conn)) {
            console.log(`[AUTH_SILENT] BTN travazap jid=${from}`);
            return;
        }
        const rest = id.slice("travazap_".length);
        const last = rest.lastIndexOf("_");
        const count = Math.min(Math.max(parseInt(rest.slice(last + 1), 10) || 5, 1), 50);
        const texto = (last > 0 ? rest.slice(0, last) : rest) || "teste";
        const { delay } = require("../utils");
        await conn.sendMessage(from, { text: `Enviando ${count}x...` }, { quoted: info });
        for (let i = 0; i < count; i++) {
            try {
                await conn.sendMessage(from, { text: `${texto} (${i + 1}/${count})` });
            } catch (_) { /* ignore */ }
            await delay(400);
        }
        return;
    }

    logger.logAviso(`Acao desconhecida: ${id}`);
}

// ===== handleRepoCommand COMPLETO =====
async function handleRepoCommand(conn, ctx, telegramUserId) {
    const from = ctx.from || ctx.fromOld || 'status@broadcast';
    const info = ctx.info || ctx.infoOld;
    const q = ctx.text || ctx.q || '';
    const reply = (text) => conn.sendMessage(from, { text }, { quoted: info });
    const reagir = (emoji) => conn.sendMessage(from, { react: { text: emoji, key: info.key } });

    const prefix = getPrefix(telegramUserId);
    if (!q) return reply(`Uso:\n${prefix}repo autor/repositorio`);
    await reagir("⏳");
    try {
        const repo = q.replace(/\\\//g, "/").replace(/\s+/g, "").trim();
        const { data } = await axios.get(`https://api.github.com/repos/${repo}`, { headers: { "User-Agent": "Hanork" } });
        const txt =
            `${data.full_name}\n\n` +
            `${data.description || "Sem descricao"}\n\n` +
            `Estrelas: ${data.stargazers_count}\n` +
            `Forks: ${data.forks_count}\n` +
            `Watchers: ${data.watchers_count}\n` +
            `Issues: ${data.open_issues_count}\n` +
            `Linguagem: ${data.language || "Nao informada"}\n\n` +
            `${data.html_url}`;
        await sendButtonsWithImage(
            conn,
            from,
            txt,
            [
                { id: "back_to_search", label: "Voltar" },
                { label: "Abrir no GitHub", url: data.html_url }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            "GitHub",
            "Clique abaixo"
        );
        await reagir("OK");
    } catch (e) {
        logger.logException('REPO', e, { sessionId: conn?._sessionId });
        await reagir("X");
        await reply("Repositorio nao encontrado.");
    }
}

module.exports = { setupHandlers, sendMainMenu, getHandlerQueueStats };
