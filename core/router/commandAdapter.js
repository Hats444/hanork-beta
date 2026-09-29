// core/router/commandAdapter.js
// Adaptador para migrar comandos existentes para o router

const { getCommand } = require('../../commands/index');
const { withTimeout, HANDLER_TIMEOUT_MS } = require('../../utils/timeout');

function runTimed(commandName, fn) {
    return withTimeout(fn, HANDLER_TIMEOUT_MS, `cmd:${commandName}`);
}

async function denyGated(conn, ctx, gated) {
    if (gated.reason === 'owner_only' || gated.silent) {
        return { denied: true, reason: 'owner_only', silent: true };
    }
    if (gated.reason === 'paywall') {
        try {
            await require('../../utils/paywall').maybeReplyDeny(conn, ctx, gated);
        } catch (_) { /* ignore */ }
        return { denied: true, reason: 'paywall' };
    }
    if (gated.reason === 'cmd_blocked') {
        try {
            const { sendDivulgacaoMessage } = require('../../utils/divulgacaoReply');
            await sendDivulgacaoMessage(conn, ctx, {
                text: gated.message || 'Este comando esta desligado nesta sessao.'
            });
        } catch (_) { /* ignore */ }
        return { denied: true, reason: 'cmd_blocked' };
    }
    const { sendDivulgacaoMessage } = require('../../utils/divulgacaoReply');
    try {
        await sendDivulgacaoMessage(conn, ctx, {
            text: gated.message || 'Apenas dono/VIP cadastrado no bot. Admin do grupo nao libera comando de dono.'
        });
    } catch (_) { /* ignore */ }
    return { denied: true, reason: gated.reason };
}

/**
 * Cria wrapper para comando existente compativel com router
 */
function wrapExistingCommand(commandName) {
    const existingCommand = getCommand(commandName);

    if (!existingCommand) {
        throw new Error(`Comando nao encontrado: ${commandName}`);
    }

    return async (event, conn) => {
        if ((existingCommand.useCtx || existingCommand['useCtx']) && event.parsedCtx) {
            const ctx = event.parsedCtx;
            ctx.sessionId = event.sessionId || conn?._sessionId || ctx.sessionId;
            ctx.telegramUserId = event.telegramUserId || conn?._telegramUserId || ctx.telegramUserId;
            ctx.command = event.command || ctx.command || commandName;
            if (event.args && event.args.length) ctx.args = event.args;
            if (event.text != null && event.text !== '') ctx.text = event.text;
            const { assertCommand } = require('../../utils/commandGate');
            const gated = assertCommand(ctx, commandName);
            if (!gated.ok) {
                return denyGated(conn, ctx, gated);
            }
            const { checkDivulgacaoAllowed } = require('../../utils/divulgacaoGate');
            const divGate = checkDivulgacaoAllowed(commandName, {
                isGroup: !!ctx.isGroup,
                groupId: ctx.from,
                telegramUserId: ctx.telegramUserId
            });
            if (!divGate.ok) {
                const { sendDivulgacaoMessage } = require('../../utils/divulgacaoReply');
                return sendDivulgacaoMessage(conn, ctx, { text: divGate.message });
            }
            return await runTimed(commandName, () => existingCommand.execute(conn, ctx));
        }
        // WA + useCtx: parse completo (quoted, downloadMedia, midia, etc.)
        // Sem isso, bna/deletar/clearuser/revelar sempre falham ("sem quoted" / cache vazio).
        if ((existingCommand.useCtx || existingCommand['useCtx']) && event.platform === 'whatsapp' && event.raw) {
            const { parseMessage } = require('../../contextParser');
            const { setAuthorizationFlags } = require('../../utils/authorization');
            const { getPrefix } = require('../../utils/configManager');

            const telegramUserId =
                event.telegramUserId ||
                (conn && conn._telegramUserId) ||
                null;
            const prefix = event.prefix || getPrefix(telegramUserId) || '.';
            const ctx = await parseMessage(conn, event.raw, prefix);
            if (!ctx) {
                throw new Error('Falha ao parsear mensagem para o comando');
            }

            ctx.sessionId = event.sessionId || conn?._sessionId || 'default';
            ctx.telegramUserId = telegramUserId;
            ctx.command = event.command || ctx.command || commandName;
            if (event.args && event.args.length) ctx.args = event.args;
            if (event.text != null && event.text !== '') ctx.text = event.text;

            setAuthorizationFlags(ctx, telegramUserId);
            if (event.platform === 'telegram') {
                ctx.platform = 'telegram';
                ctx.isTelegram = true;
            }
            const { assertCommand } = require('../../utils/commandGate');
            const gated = assertCommand(ctx, commandName);
            if (!gated.ok) {
                return denyGated(conn, ctx, gated);
            }

            const { checkDivulgacaoAllowed } = require('../../utils/divulgacaoGate');
            const divGate = checkDivulgacaoAllowed(commandName, {
                isGroup: !!ctx.isGroup,
                groupId: ctx.from,
                telegramUserId
            });
            if (!divGate.ok) {
                const { sendDivulgacaoMessage } = require('../../utils/divulgacaoReply');
                return sendDivulgacaoMessage(conn, ctx, { text: divGate.message });
            }

            return await runTimed(commandName, () => existingCommand.execute(conn, ctx));
        }

        const ctx = {
            from: event.chatId,
            info: event.raw,
            text: event.text || '',
            args: Array.isArray(event.args) ? event.args : [],
            command: event.command,
            isGroup: !!event.isGroup,
            isOwner: !!event.isOwner,
            isVip: !!event.isVip,
            authRole: event.authRole || 'none',
            sessionId: event.sessionId || (conn && conn._sessionId) || undefined,
            telegramUserId: event.telegramUserId || (event.platform === 'telegram' ? event.userId : null),
            telegramChatId: event.platform === 'telegram' ? event.chatId : null,
            platform: event.platform || 'whatsapp',
            sender: event.userId,
            prefix: event.platform === 'whatsapp' ? (event.prefix || '') : '/',
            fromMe: !!event.fromMe,
            fullText: event.fullText || event.text || ''
        };

        try {
            const { getConversationSession } = require('../../utils/conversationSession');
            ctx.session = getConversationSession(ctx.sessionId, ctx.sender);
        } catch (_) {
            ctx.session = { step: null, quantidade: null };
        }

        const { checkDivulgacaoAllowed } = require('../../utils/divulgacaoGate');
        const divGate = checkDivulgacaoAllowed(commandName, {
            isGroup: !!ctx.isGroup,
            groupId: ctx.from,
            telegramUserId: ctx.telegramUserId
        });
        if (!divGate.ok) {
            const { sendDivulgacaoMessage } = require('../../utils/divulgacaoReply');
            return sendDivulgacaoMessage(conn, ctx, { text: divGate.message });
        }

        const { assertCommand } = require('../../utils/commandGate');
        const gated = assertCommand(ctx, commandName);
        if (!gated.ok) {
            return denyGated(conn, ctx, gated);
        }

        if (existingCommand.useCtx || existingCommand['useCtx']) {
            return await runTimed(commandName, () => existingCommand.execute(conn, ctx));
        }

        return await runTimed(commandName, () => existingCommand.execute(
            conn,
            event.chatId,
            event.raw,
            ctx.args,
            ctx.text,
            ctx.isOwner,
            ctx.isVip
        ));
    };
}

function migrateCommand(commandName, config = {}) {
    const handler = wrapExistingCommand(commandName);
    let rateLimit = config.rateLimit;
    if (!rateLimit) {
        try {
            const { commandRateConfig } = require('./ratePolicy');
            const p = commandRateConfig(commandName, { permission: config.permission || 'owner' });
            rateLimit = { max: p.max, window: p.window };
        } catch (_) {
            rateLimit = { max: 45, window: 60000 };
        }
    }

    return {
        name: commandName,
        handler,
        platforms: config.platforms || ['whatsapp', 'telegram'],
        permission: config.permission || 'owner',
        rateLimit,
        inputValidation: config.inputValidation || {},
        sensitive: config.sensitive || false
    };
}

function migrateCommandGroup(commandNames, defaultConfig = {}) {
    const migrated = [];

    for (const name of commandNames) {
        try {
            migrated.push(migrateCommand(name, defaultConfig));
        } catch (e) {
            require('../../logger').logException('commandAdapter', e, { name });
        }
    }

    return migrated;
}

module.exports = {
    wrapExistingCommand,
    migrateCommand,
    migrateCommandGroup
};
