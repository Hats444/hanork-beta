// core/router/permissionManager.js
// Permissoes (via authorization hybrid JID/LID) + rate limit por comando e global

const { checkAuthorization, isConnSelfIdentity } = require('../../utils/authorization');
const { getSession } = require('../../utils/sessionRegistry');
const { isAdmin } = require('../../utils/userManager');
const { canUseCommand } = require('../../utils/permissionEngine');
const {
    isNavExempt,
    commandRateConfig,
    globalRateConfig
} = require('./ratePolicy');

const rateLimitStore = new Map();

/** legado — preferir globalRateConfig(role) */
const DEFAULT_GLOBAL_LIMIT = { max: 80, window: 60000 };

/**
 * Resolve telegramUserId da sessao / conn / event
 */
function collectSenderAlts(event) {
    const key = event?.raw?.key || {};
    return [
        key.participant,
        key.participantAlt,
        key.remoteJidAlt,
        key.senderPn,
        key.participantPn,
        event?.senderAlt,
        event?.parsedCtx?.senderAlt,
        event?.parsedCtx?.sender
    ].filter(Boolean);
}

/** Admin nativo DESTE @g.us (meta + bot admin). Nao promove a dono/VIP. */
function eventLooksGroupAdmin(event, conn) {
    const raw = event.raw || event.info || {};
    const key = raw.key || {};
    const chatId = String(event.chatId || event.from || key.remoteJid || '');
    const isGroup = event.isGroup != null ? !!event.isGroup : /@g\.us$/i.test(chatId);
    if (!isGroup) return false;
    const ctx = {
        isGroup: true,
        from: chatId,
        sender: event.userId || event.sender || key.participant,
        senderAlt: event.senderAlt || key.participantAlt || key.remoteJidAlt,
        senderPn: event.senderPn || key.senderPn,
        senderLid: event.senderLid,
        isAdmin: !!event.isAdmin,
        authRole: event.authRole,
        conn: conn || event.conn
    };
    try {
        const { isGroupAdminActor } = require('../../utils/commandGate');
        return isGroupAdminActor(ctx);
    } catch (_) {
        return !!event.isAdmin;
    }
}

function resolveTelegramUserId(sessionId, conn, event) {
    if (event?.telegramUserId) return String(event.telegramUserId);
    if (conn?._telegramUserId) return String(conn._telegramUserId);
    if (sessionId) {
        const session = getSession(sessionId);
        if (session?.telegramUserId) return String(session.telegramUserId);
    }
    if (event?.platform === 'telegram' && event?.userId) return String(event.userId);
    return null;
}

/**
 * Verifica permissao do usuario (multiuser: owners/vips da sessao)
 */
async function checkPermission(userId, requiredPermission, sessionId, conn, event = {}) {
    try {
        const telegramUserId = resolveTelegramUserId(sessionId, conn, event);
        const fromMe = false;
        const alts = collectSenderAlts(event);
        // fromMe sozinho nao vira dono — precisa casar LID/PN com o chip.
        const senderIsChip = isConnSelfIdentity(userId, alts, conn);
        const tgActor = event?.platform === 'telegram'
            ? String(event.userId || event.sender || userId || '')
            : '';
        const actorIsAdmin = event?.platform === 'telegram' && tgActor && isAdmin(tgActor);

        // Chip deste Zap = dono da sessao (banall/comando no grupo).
        // TELEGRAM_ADMIN_IDS so vira platform_admin no chip, nunca em membro.
        if (senderIsChip || actorIsAdmin) {
            const role = actorIsAdmin || (telegramUserId && isAdmin(telegramUserId))
                ? 'platform_admin'
                : 'owner';
            event.isOwner = true;
            event.isVip = true;
            event.isPlatformAdmin = role === 'platform_admin';
            event.authRole = role;
            event.telegramUserId = telegramUserId;
            if (requiredPermission === 'adm') {
                return { allowed: true, role };
            }
            if (canUseCommand(role, requiredPermission)) return { allowed: true, role };
            return { allowed: false, reason: 'nivel insuficiente' };
        }

        if (!telegramUserId) {
            return { allowed: false, reason: 'sessao sem telegramUserId' };
        }

        event.telegramUserId = telegramUserId;

        // Exploits / travas: no TG so o REMETENTE em TELEGRAM_ADMIN_IDS (nunca o dono da sessao).
        if (requiredPermission === 'platform_admin') {
            if (event?.platform === 'telegram' && actorIsAdmin) {
                event.isOwner = true;
                event.isVip = true;
                event.authRole = 'platform_admin';
                return { allowed: true, role: 'platform_admin' };
            }
            const auth = checkAuthorization(
                userId,
                telegramUserId,
                fromMe,
                collectSenderAlts(event),
                conn
            );
            event.isOwner = auth.role === 'owner';
            event.isVip = auth.role === 'vip' || auth.role === 'owner';
            event.authRole = auth.role;
            if (auth.role === 'owner' || auth.role === 'platform_admin') {
                return { allowed: true, role: auth.role };
            }
            return { allowed: false, reason: 'apenas dono' };
        }

        const auth = checkAuthorization(
            userId,
            telegramUserId,
            fromMe,
            collectSenderAlts(event),
            conn
        );
        event.isOwner = auth.role === 'owner';
        event.isVip = auth.role === 'vip' || auth.role === 'owner';
        event.authRole = auth.role;

        if (!auth.authorized) {
            if (requiredPermission === 'adm' && eventLooksGroupAdmin(event, conn)) {
                event.isAdmin = true;
                event.authRole = 'group_admin';
                event.isVip = false;
                event.isOwner = false;
                return { allowed: true, role: 'group_admin' };
            }
            return { allowed: false, reason: 'nao autorizado' };
        }

        const adminHere = eventLooksGroupAdmin(event, conn);
        if (adminHere) event.isAdmin = true;

        if (requiredPermission === 'adm') {
            if (canUseCommand(auth.role, 'adm', { isGroupAdmin: adminHere })) {
                if (auth.role === 'vip') {
                    event.isVip = true;
                    event.authRole = 'vip';
                }
                return { allowed: true, role: auth.role };
            }
            return { allowed: false, reason: 'adm de grupo' };
        }

        if (!canUseCommand(auth.role, requiredPermission, { isGroupAdmin: adminHere })) {
            if (requiredPermission === 'owner') {
                return { allowed: false, reason: 'apenas dono' };
            }
            if (requiredPermission === 'vip') {
                return { allowed: false, reason: 'apenas vip/dono' };
            }
            if (requiredPermission === 'platform_admin') {
                return { allowed: false, reason: 'apenas dono' };
            }
            return { allowed: false, reason: 'nivel insuficiente' };
        }

        return { allowed: true, role: auth.role };
    } catch (e) {
        require('../../logger').logException('permissionManager', e, { op: 'checkPermission' });
        return { allowed: false, reason: 'erro ao verificar permissao' };
    }
}

function hitRateLimit(key, max, window) {
    const now = Date.now();
    const userLimits = rateLimitStore.get(key) || { count: 0, resetAt: now + window };

    if (now > userLimits.resetAt) {
        userLimits.count = 0;
        userLimits.resetAt = now + window;
    }

    if (userLimits.count >= max) {
        return { allowed: false, retryAfter: userLimits.resetAt - now };
    }

    userLimits.count++;
    rateLimitStore.set(key, userLimits);
    return { allowed: true };
}

/**
 * Rate limit por usuario+comando
 * opts.skip / comando nav → sempre libera
 */
async function checkRateLimit(userId, commandName, config = {}) {
    try {
        if (config.skip === true || isNavExempt(commandName)) {
            return { allowed: true, skipped: true };
        }
        const policy = commandRateConfig(commandName);
        if (policy.skip) return { allowed: true, skipped: true };

        const max = config.max || policy.max || 10;
        const window = config.window || policy.window || 60000;
        return hitRateLimit(`${userId}:${commandName}`, max, window);
    } catch (e) {
        require('../../logger').logException('permissionManager', e, { op: 'rateLimit' });
        return { allowed: true };
    }
}

/**
 * Rate limit global por usuario
 * @param {string} userId
 * @param {object} [config]
 * @param {string} [config.role]
 * @param {string} [config.command] — se nav exempt, nao conta no global
 */
async function checkGlobalRateLimit(userId, config = {}) {
    try {
        if (config.command && (config.skipGlobal || isNavExempt(config.command))) {
            return { allowed: true, skipped: true };
        }
        const byRole = globalRateConfig(config.role || 'user');
        const max = config.max || byRole.max || DEFAULT_GLOBAL_LIMIT.max;
        const window = config.window || byRole.window || DEFAULT_GLOBAL_LIMIT.window;
        return hitRateLimit(`global:${userId}`, max, window);
    } catch (e) {
        require('../../logger').logException('permissionManager', e, { op: 'globalRateLimit' });
        return { allowed: true };
    }
}

/** Limpa buckets (testes / admin) */
function resetAllRateLimits() {
    rateLimitStore.clear();
}

function cleanupRateLimits() {
    const now = Date.now();
    for (const [key, value] of rateLimitStore.entries()) {
        if (now > value.resetAt) rateLimitStore.delete(key);
    }
}

setInterval(cleanupRateLimits, 300000).unref?.();

module.exports = {
    checkPermission,
    checkRateLimit,
    checkGlobalRateLimit,
    cleanupRateLimits,
    resetAllRateLimits,
    DEFAULT_GLOBAL_LIMIT,
    resolveTelegramUserId,
    isNavExempt,
    commandRateConfig,
    globalRateConfig
};
