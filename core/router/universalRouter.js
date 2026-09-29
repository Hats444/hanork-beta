// core/router/universalRouter.js
// Universal Router - Camada central de roteamento de comandos

const logger = require('../../logger');
const { normalizeEvent } = require('./eventNormalizer');
const { validateInput } = require('./inputValidator');
const {
    checkPermission,
    checkRateLimit,
    checkGlobalRateLimit
} = require('./permissionManager');
const { toPublicError } = require('./errorHandler');
const { newRequestId, noteCmd } = require('./cmdStats');

const commandRegistry = new Map();

function registerCommand(name, config) {
    if (!name || typeof name !== 'string') {
        throw new Error('Nome do comando invalido');
    }

    if (!config || typeof config.handler !== 'function') {
        throw new Error('Configuracao do comando invalida: handler obrigatorio');
    }

    commandRegistry.set(name, {
        name,
        handler: config.handler,
        platforms: config.platforms || ['whatsapp', 'telegram'],
        permission: config.permission || 'vip',
        rateLimit: config.rateLimit || { max: 45, window: 60000 },
        inputValidation: config.inputValidation || {},
        sensitive: config.sensitive || false
    });
}

function getCommandConfig(name) {
    return commandRegistry.get(name) || null;
}

function listRegisteredCommands() {
    return Array.from(commandRegistry.keys());
}

function isCommandRegistered(name) {
    return commandRegistry.has(name);
}

async function processEvent(rawEvent, platform, conn, parsedCtx) {
    const startTime = Date.now();
    const rid = newRequestId();
    let normalizedEvent = null;
    let commandName = null;
    let status = 'error';
    let errorReason = null;

    try {
        normalizedEvent = normalizeEvent(rawEvent, platform, conn);

        if (!normalizedEvent) {
            return { handled: false };
        }

        // Enriquecer session/telegram do conn
        if (conn?._sessionId && (!normalizedEvent.sessionId || normalizedEvent.sessionId === 'default')) {
            normalizedEvent.sessionId = conn._sessionId;
        }
        if (conn?._telegramUserId) {
            normalizedEvent.telegramUserId = String(conn._telegramUserId);
        }
        normalizedEvent.fromMe = !!(rawEvent?.key?.fromMe);
        if (parsedCtx) normalizedEvent.parsedCtx = parsedCtx;

        if (!normalizedEvent.chatId || !normalizedEvent.userId) {
            return { handled: false };
        }

        commandName = normalizedEvent.command;
        try {
            const { resolveKnownCommand } = require('../../utils/commandTextParse');
            const canon = resolveKnownCommand(commandName);
            if (canon) {
                commandName = canon;
                normalizedEvent.command = canon;
            }
        } catch (_) { /* alias opcional */ }

        if (platform === 'whatsapp' && parsedCtx) {
            try {
                const { isPrivatePersonChat, pvAntiWouldBlock, processPrivateSecurity } = require('../../utils/moderation');
                if (isPrivatePersonChat(parsedCtx)) {
                    const tid = normalizedEvent.telegramUserId || parsedCtx.telegramUserId;
                    if (pvAntiWouldBlock(parsedCtx, tid)) {
                        await processPrivateSecurity(conn, parsedCtx, tid);
                        return { handled: true };
                    }
                }
            } catch (e) {
                try { require('../../logger').logAviso(`[ANTIPV] router: ${e.message}`); } catch (_) {}
                try {
                    const { isPrivatePersonChat: ipc, processPrivateSecurity: pps } = require('../../utils/moderation');
                    if (ipc(parsedCtx)) {
                        const tid2 = normalizedEvent.telegramUserId || parsedCtx.telegramUserId;
                        const r = await pps(conn, parsedCtx, tid2);
                        if (r && r.handled) return { handled: true };
                    }
                } catch (_) { /* ignore */ }
            }
        }

        if (!commandName) {
            return { handled: false };
        }

        const commandConfig = getCommandConfig(commandName);

        // Nao registrado → deixa fluxo classico tratar (nao engolir o comando)
        if (!commandConfig) {
            status = 'unregistered';
            return { handled: false };
        }

        if (!commandConfig.platforms.includes(platform)) {
            return {
                handled: true,
                error: 'Comando nao disponivel nesta plataforma'
            };
        }

        // Rate limit global (nav/menu/admin UI isento; dono tem teto alto)
        const roleHint =
            normalizedEvent.authRole ||
            (normalizedEvent.isOwner ? 'owner' : normalizedEvent.isVip ? 'vip' : 'user');
        const globalLimit = await checkGlobalRateLimit(normalizedEvent.userId, {
            role: roleHint,
            command: commandName
        });
        if (!globalLimit.allowed) {
            return {
                handled: true,
                error: `Muitos comandos. Aguarde ${Math.ceil((globalLimit.retryAfter || 0) / 1000)}s.`
            };
        }

        const permissionResult = await checkPermission(
            normalizedEvent.userId,
            commandConfig.permission,
            normalizedEvent.sessionId,
            conn,
            normalizedEvent
        );

        try {
            const { assertCommand } = require('../../utils/commandGate');
            const gated = assertCommand({
                from: normalizedEvent.chatId,
                sender: normalizedEvent.userId,
                telegramUserId: normalizedEvent.telegramUserId,
                isGroup: !!normalizedEvent.isGroup,
                fromMe: !!normalizedEvent.fromMe,
                isAdmin: !!normalizedEvent.isAdmin,
                conn,
                platform,
                isTelegram: platform === 'telegram',
                info: normalizedEvent.raw
            }, commandName);
            if (!gated.ok) {
                if (gated.reason === 'owner_only' || gated.silent) {
                    return { handled: true };
                }
                if (gated.reason === 'paywall') {
                    return {
                        handled: true,
                        error: gated.message || 'Este comando pede um plano pago. Use /comprar.'
                    };
                }
                if (gated.reason === 'cmd_blocked') {
                    return {
                        handled: true,
                        error: gated.message || 'Este comando esta desligado nesta sessao.'
                    };
                }
                if (!permissionResult.allowed) {
                    try {
                        const { recordCommandOutcome } = require('../../utils/evolution');
                        void recordCommandOutcome(conn, {
                            telegramUserId: normalizedEvent.telegramUserId,
                            sender: normalizedEvent.userId,
                            command: commandName,
                            ok: false,
                            error: `Permissao negada: ${permissionResult.reason}`,
                            role: permissionResult.role || normalizedEvent.authRole || 'user',
                            chatId: normalizedEvent.chatId,
                            isGroup: !!normalizedEvent.isGroup,
                            platform,
                            sendTip: false
                        });
                    } catch (_) { /* ignore */ }
                    return {
                        handled: true,
                        error: `Permissao negada: ${permissionResult.reason}`
                    };
                }
                return { handled: true, error: 'Permissao negada.' };
            }
            normalizedEvent.isOwner = gated.role === 'owner' || gated.role === 'platform_admin';
            normalizedEvent.isVip = gated.role === 'vip' || normalizedEvent.isOwner;
            normalizedEvent.authRole = gated.role;
            if (gated.role === 'group_admin' || gated.isGroupAdmin) normalizedEvent.isAdmin = true;
        } catch (gateErr) {
            logger.logAviso(`[CMDGATE] router fail-closed: ${gateErr.message}`);
            return { handled: true, error: 'Permissao negada.' };
        }

        // Quotas evolucionarias: throttle so em cmds caros (nunca menu/admin UI)
        let evoAdj = { maxMult: 1, denyCostly: false };
        try {
            const { rateLimitAdjustFor } = require('../../utils/evolution');
            evoAdj = rateLimitAdjustFor(
                normalizedEvent.telegramUserId,
                normalizedEvent.userId,
                commandName
            ) || evoAdj;
            const actorRole = permissionResult.role || normalizedEvent.authRole || roleHint;
            const skipOwnerRl = actorRole === 'owner' || actorRole === 'platform_admin';
            if (evoAdj.denyCostly && !skipOwnerRl) {
                return {
                    handled: true,
                    error: 'Limite evolucionario: espere um pouco antes de comandos pesados.'
                };
            }
        } catch (_) { /* evolution opcional */ }

        const actorRole = permissionResult.role || normalizedEvent.authRole || roleHint;
        const skipOwnerRl = actorRole === 'owner' || actorRole === 'platform_admin';
        const { applyEvoMult, commandRateConfig, isNavExempt } = require('./ratePolicy');
        const policy = commandRateConfig(commandName, {
            permission: commandConfig.permission || permissionResult.role || 'user'
        });
        if (!skipOwnerRl && !policy.skip && !isNavExempt(commandName)) {
            const baseRl = commandConfig.rateLimit || { max: policy.max, window: policy.window };
            const adjMax = applyEvoMult(baseRl.max || policy.max, evoAdj.maxMult, commandName);
            const rateLimitResult = await checkRateLimit(
                normalizedEvent.userId,
                commandName,
                { ...baseRl, max: adjMax, window: baseRl.window || policy.window }
            );

            if (!rateLimitResult.allowed) {
                return {
                    handled: true,
                    error: `Rate limit. Tente em ${Math.ceil((rateLimitResult.retryAfter || 0) / 1000)}s.`
                };
            }
        }

        if (commandConfig.inputValidation && Object.keys(commandConfig.inputValidation).length) {
            const validationResult = validateInput(
                normalizedEvent.args,
                commandConfig.inputValidation
            );

            if (!validationResult.valid) {
                return {
                    handled: true,
                    error: `Input invalido: ${validationResult.reason}`
                };
            }

            normalizedEvent.args = validationResult.sanitized;
        }

        const handlerResult = await executeHandler(
            commandConfig.handler,
            normalizedEvent,
            conn
        );

        status = 'ok';
        noteCmd(commandName, true);

        // Evolucao: score + tip (nao bloqueia resposta do cmd)
        try {
            const { recordCommandOutcome } = require('../../utils/evolution');
            void recordCommandOutcome(conn, {
                telegramUserId: normalizedEvent.telegramUserId,
                sender: normalizedEvent.userId,
                command: commandName,
                ok: true,
                role: normalizedEvent.authRole || (normalizedEvent.isOwner ? 'owner' : normalizedEvent.isVip ? 'vip' : 'user'),
                chatId: normalizedEvent.chatId,
                isGroup: !!normalizedEvent.isGroup,
                quoted: normalizedEvent.raw || null,
                platform,
                sendTip: true
            });
        } catch (_) { /* ignore */ }

        return {
            handled: true,
            result: handlerResult
        };
    } catch (e) {
        status = 'error';
        errorReason = toPublicError(e);
        if (commandName) noteCmd(commandName, false);

        logger.logException('[ROUTER]', e, {
            rid,
            platform,
            command: commandName || 'none',
            session: normalizedEvent?.sessionId ? 'yes' : 'no'
        });

        try {
            if (normalizedEvent?.telegramUserId && normalizedEvent?.userId && commandName) {
                const { recordCommandOutcome } = require('../../utils/evolution');
                void recordCommandOutcome(conn, {
                    telegramUserId: normalizedEvent.telegramUserId,
                    sender: normalizedEvent.userId,
                    command: commandName,
                    ok: false,
                    error: errorReason,
                    role: normalizedEvent.authRole || 'user',
                    chatId: normalizedEvent.chatId,
                    isGroup: !!normalizedEvent.isGroup,
                    quoted: normalizedEvent.raw || null,
                    platform,
                    sendTip: true
                });
            }
        } catch (_) { /* ignore */ }

        return {
            handled: true,
            error: errorReason || 'Erro interno ao processar comando'
        };
    } finally {
        const duration = Date.now() - startTime;

        if (process.env.DEBUG_WA === '1' || (status !== 'ok' && status !== 'unregistered') || duration > 250) {
            logger.logInfo(
                `[ROUTER] rid=${rid} platform=${platform} cmd=${commandName || 'none'} duration=${duration}ms status=${status}${errorReason ? ` reason="${errorReason}"` : ''}`
            );
        }

        if (status !== 'ok' && commandName && commandRegistry.get(commandName)?.sensitive) {
            logger.logAviso(
                `[ROUTER AUDIT] rid=${rid} cmd=${commandName} status=${status}`
            );
        }
    }
}

async function executeHandler(handler, event, conn) {
    return await handler(event, conn);
}

module.exports = {
    registerCommand,
    getCommandConfig,
    listCommands: listRegisteredCommands,
    listRegisteredCommands,
    isCommandRegistered,
    processEvent,
    newRequestId
};
