// utils/authorization.js
// Centralized authorization system with hybrid JID/LID support
const { getEffectiveOwners, getVips, getBlacklist } = require('./configManager');
const { normalizeJid, getPhoneForLid, getLidForPhone, resolveLid } = require('../utils');
const logger = require('../logger');

// Cache de autorização para reduzir verificações repetitivas
// Estrutura: Map<telegramUserId, Map<sender, { authorized: boolean, role: string, timestamp: number }>>
const authCache = new Map();
const CACHE_TTL = 60000; // 1 minuto

function asJidString(v) {
    if (v == null) return '';
    if (typeof v === 'object') return String(v.id || v.jid || v._serialized || '').trim();
    return String(v).trim();
}

function canonJid(v) {
    return asJidString(v).replace(/:\d+(?=@)/, '');
}

function isPersonJid(v) {
    const s = canonJid(v);
    if (!s) return false;
    if (s.endsWith('@g.us') || s.endsWith('@newsletter') || s.endsWith('@broadcast') || s === 'status@broadcast') {
        return false;
    }
    return s.endsWith('@lid') || s.includes('.lid') || s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us') || /^\d{10,15}$/.test(s);
}

/** Variantes BR: com/sem 55, com/sem 9 apos DDD. LID nao entra. */
function brPhoneVariants(raw) {
    const s = String(raw || '');
    if (s.includes('@lid')) return [];
    const d = s.replace(/\D/g, '');
    if (d.length < 10 || d.length > 15) return d ? [d] : [];
    const out = new Set();
    const add = (x) => {
        const n = String(x || '').replace(/\D/g, '');
        if (n.length >= 10 && n.length <= 15) out.add(n);
    };
    add(d);
    const local = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
    add(local);
    add('55' + local);
    if (local.length === 11 && local[2] === '9') {
        const noNine = local.slice(0, 2) + local.slice(3);
        add(noNine);
        add('55' + noNine);
    }
    if (local.length === 10) {
        const withNine = local.slice(0, 2) + '9' + local.slice(2);
        add(withNine);
        add('55' + withNine);
    }
    return [...out];
}

function phoneDigits(v) {
    const s = String(v || '');
    if (s.includes('@lid')) return null;
    const user = s.split('@')[0].split(':')[0];
    const d = user.replace(/\D/g, '');
    return d.length >= 10 && d.length <= 15 ? d : null;
}

function phonesMatch(a, b) {
    const va = brPhoneVariants(a);
    const vb = brPhoneVariants(b);
    if (!va.length || !vb.length) return false;
    return va.some((x) => vb.includes(x));
}

function lidsMatch(a, b) {
    const A = canonJid(a);
    const B = canonJid(b);
    if (!/@lid\b|\.lid\b/i.test(A) || !/@lid\b|\.lid\b/i.test(B)) return false;
    if (A === B) return true;
    return A.split('@')[0] === B.split('@')[0];
}

/**
 * Matches a sender (JID or LID) against an authorization entry
 * Supports hybrid JID/LID matching with enhanced error handling
 */
function matchesAuthorizedEntry(sender, entry) {
    if (!sender || !entry) return false;
    if (!isPersonJid(sender) || !isPersonJid(entry)) return false;

    const a = canonJid(sender);
    const b = canonJid(entry);
    if (a === b) return true;

    try {
        if (normalizeJid(a) && normalizeJid(a) === normalizeJid(b)) return true;
    } catch (e) {
        logger.logAviso(`[AUTH] Erro ao normalizar JID: ${e.message}`);
    }

    if (lidsMatch(a, b)) return true;

    const sd = phoneDigits(a);
    const ed = phoneDigits(b);
    if (sd && ed && phonesMatch(sd, ed)) return true;

    const senderIsLid = a.includes('@lid');
    const entryIsLid = b.includes('@lid');

    if (senderIsLid && !entryIsLid) {
        try {
            const phone = getPhoneForLid(a) || getPhoneForLid(sender);
            if (phone && phonesMatch(phone, b)) return true;
        } catch (e) {
            logger.logAviso(`[AUTH] Erro ao resolver LID->Phone: ${e.message}`);
        }
        try {
            const lid = getLidForPhone(b) || getLidForPhone(entry);
            if (lid && lidsMatch(lid, a)) return true;
        } catch (e) {
            logger.logAviso(`[AUTH] Erro ao resolver Phone->LID: ${e.message}`);
        }
    }

    if (!senderIsLid && entryIsLid) {
        try {
            const phone = getPhoneForLid(b) || getPhoneForLid(entry);
            if (phone && phonesMatch(phone, a)) return true;
        } catch (e) {
            logger.logAviso(`[AUTH] Erro ao resolver LID->Phone (inverso): ${e.message}`);
        }
        try {
            const lid = getLidForPhone(a) || getLidForPhone(sender);
            if (lid && lidsMatch(lid, b)) return true;
        } catch (e) {
            logger.logAviso(`[AUTH] Erro ao resolver Phone->LID (inverso): ${e.message}`);
        }
    }

    return false;
}

/**
 * Checks if a sender is authorized based on owners and VIPs lists
 * @param {string} sender - The sender's JID or LID
 * @param {Array} owners - List of owner JIDs/LIDs
 * @param {Array} vips - List of VIP JIDs/LIDs
 * @returns {boolean} - True if authorized
 */
function isAuthorized(sender, owners, vips) {
    if (!Array.isArray(owners) || !sender) return false;
    
    const isOwner = owners.some(entry => matchesAuthorizedEntry(sender, entry));
    if (isOwner) return true;
    
    if (Array.isArray(vips)) {
        const isVip = vips.some(entry => matchesAuthorizedEntry(sender, entry));
        if (isVip) return true;
    }
    
    return false;
}

function collectAuthIdentities(ctx) {
    const key = ctx?.info?.key || ctx?.key || {};
    const out = [];
    const push = (v) => {
        const s = canonJid(v);
        if (!s || out.includes(s)) return;
        if (!isPersonJid(s)) return;
        out.push(s);
    };
    push(ctx?.sender);
    push(ctx?.from);
    push(ctx?.senderAlt);
    push(key.participant);
    push(key.participantAlt);
    push(key.remoteJid);
    push(key.remoteJidAlt);
    push(key.senderPn);
    push(key.participantPn);
    try {
        const conn = ctx?.conn;
        const map = conn?.signalRepository?.lidMapping;
        for (const id of [...out]) {
            if (!String(id).includes('@lid') || !map) continue;
            const pn =
                (typeof map.getPNForLID === 'function' && map.getPNForLID(id)) ||
                (typeof map.lidToPn === 'function' && map.lidToPn(id)) ||
                (typeof map.get === 'function' && map.get(id));
            if (pn) push(pn);
        }
    } catch (_) { /* mapping opcional */ }
    try {
        const { getPhoneForLid, rememberLidPhonePair } = require('../utils');
        const k = ctx?.info?.key || ctx?.key || {};
        if (k.participant && (k.participantPn || k.participantAlt || k.senderPn)) {
            rememberLidPhonePair(k.participant, k.participantPn || k.participantAlt || k.senderPn);
        }
        for (const id of [...out]) {
            if (!String(id).includes('@lid')) continue;
            const pn = getPhoneForLid(id);
            if (pn) push(pn);
        }
    } catch (_) { /* cache LID desta msg */ }
    for (const id of [...out]) {
        if (String(id).includes('@lid')) continue;
        const user = String(id).split('@')[0].split(':')[0];
        const d = user.replace(/\D/g, '');
        if (d.length >= 10 && d.length <= 15) {
            push(`${d}@s.whatsapp.net`);
        }
    }
    return out;
}

/** Liga LID do grupo atual com PN do mesmo participante (cache, sem IQ, sem varrer todos os grupos). */
function expandIdsFromGroupCache(ids, groupJid) {
    const seed = Array.isArray(ids) ? ids.filter(Boolean).map(String) : [];
    if (!seed.length) return seed;
    const gid = String(groupJid || '');
    if (!gid.endsWith('@g.us')) return seed;
    const extra = [];
    try {
        const { peekGroupMetadata } = require('./groupMetaCache');
        const meta = peekGroupMetadata(gid);
        if (!meta) return seed;
        for (const p of meta.participants || []) {
            const pids = [p.id, p.phoneNumber, p.jid, p.lid, p.participant].filter(Boolean).map(String);
            if (!pids.length) continue;
            const hit = seed.some((id) => pids.some((pid) => matchesAuthorizedEntry(id, pid)));
            if (hit) extra.push(...pids.filter(isPersonJid));
        }
    } catch (_) { /* cache opcional */ }
    const out = [...seed];
    for (const x of extra) {
        if (x && !out.includes(x)) out.push(x);
    }
    return out;
}

function rememberIdentitiesFromCtx(ctx) {
    try {
        const { rememberLidPhonePair } = require('../utils');
        const key = ctx?.info?.key || ctx?.key || {};
        const pairs = [
            [key.remoteJid, key.remoteJidAlt],
            [key.participant, key.participantAlt],
            [key.participant, key.participantPn],
            [key.remoteJid, key.senderPn]
        ];
        for (const [a, b] of pairs) {
            if (!a || !b) continue;
            const A = String(a);
            const B = String(b);
            if (A.includes('@lid') && (B.includes('@s.whatsapp.net') || B.includes('@c.us'))) {
                rememberLidPhonePair(A, B);
            } else if (B.includes('@lid') && (A.includes('@s.whatsapp.net') || A.includes('@c.us'))) {
                rememberLidPhonePair(B, A);
            }
        }
    } catch (_) { /* ignore */ }
}

function botIdentities(conn) {
    const u = conn?.user || {};
    const me = conn?.authState?.creds?.me || {};
    const out = [];
    const push = (v) => {
        const s = canonJid(v);
        if (!s || out.includes(s)) return;
        out.push(s);
        const user = s.split('@')[0].split(':')[0];
        if (/^\d{10,15}$/.test(user)) {
            const pn = `${user}@s.whatsapp.net`;
            if (!out.includes(pn)) out.push(pn);
            for (const d of brPhoneVariants(user)) {
                const j = `${d}@s.whatsapp.net`;
                if (!out.includes(j)) out.push(j);
            }
        }
    };
    push(u.id);
    push(u.jid);
    push(u.lid);
    push(me.id);
    push(me.jid);
    push(me.lid);
    try {
        const { getPhoneForLid, getLidForPhone } = require('../utils');
        for (const id of [...out]) {
            if (String(id).includes('@lid')) {
                const phone = getPhoneForLid(id);
                if (phone) push(phone);
            } else {
                const lid = getLidForPhone(id);
                if (lid) push(lid);
            }
        }
    } catch (_) { /* cache opcional */ }
    return out;
}

/**
 * PV: resolve LID→PN no ctx.from e trata o proprio chip do bot como dono.
 * Grupo @g.us nao mexe.
 */
function healPrivateContext(ctx) {
    if (!ctx || ctx.isGroup) return;
    const from = asJidString(ctx.from);
    if (from.endsWith('@g.us') || from.endsWith('@newsletter')) return;
    rememberIdentitiesFromCtx(ctx);
    // Nao reescreve ctx.from LID→PN: a resposta tem que ir no mesmo chat.
    const conn = ctx.conn;
    const bots = botIdentities(conn);
    if (!bots.length) return;
    const ids = collectAuthIdentities(ctx);
    const self = ids.some((id) => bots.some((b) => matchesAuthorizedEntry(id, b)));
    if (!self) return;
    if (ctx.info?.key?.fromMe !== true) return;
    ctx.fromMe = true;
}

/**
 * Chip desta sessao = dono so se a identidade casar (LID/PN).
 * Extra de outra pessoa (ex.: JID do bot vazado no key) nao vira dono.
 */
function idMatchesBot(id, conn) {
    if (!id || !conn) return false;
    const bots = botIdentities(conn);
    if (!bots.length) return false;
    const c = canonJid(id);
    if (!c) return false;
    return bots.some((b) => {
        if (matchesAuthorizedEntry(c, b)) return true;
        const sd = phoneDigits(c);
        const bd = phoneDigits(b);
        return sd && bd && phonesMatch(sd, bd);
    });
}

function isConnSelfIdentity(sender, senderAlt, conn) {
    if (!conn) return false;
    const bots = botIdentities(conn);
    if (!bots.length) return false;
    const extra = Array.isArray(senderAlt) ? senderAlt : (senderAlt ? [senderAlt] : []);
    const primary = canonJid(sender);
    if (idMatchesBot(primary, conn)) return true;
    const extras = extra.map(canonJid).filter(Boolean);
    if (!primary) return extras.some((id) => idMatchesBot(id, conn));
    // Extra so conta se for o MESMO usuario (par LID/PN). Bot no extra de outra pessoa nao vira dono.
    const samePerson = extras.filter((id) => {
        if (matchesAuthorizedEntry(id, primary)) return true;
        const sd = phoneDigits(primary);
        const ed = phoneDigits(id);
        return sd && ed && phonesMatch(sd, ed);
    });
    return samePerson.some((id) => idMatchesBot(id, conn));
}

function detectMessageContext(jid) {
    const s = asJidString(jid);
    if (s.endsWith('@g.us')) return 'group';
    if (s.endsWith('@newsletter')) return 'channel';
    if (s.endsWith('@broadcast')) return 'broadcast';
    return 'dm';
}

function checkAuthorization(sender, telegramUserId, fromMe = false, senderAlt = null, conn = null) {
    // Chip desta sessao = dono so se a identidade casar (LID/PN).
    // fromMe sozinho e fail-open: membro com flag errada virava dono (.nuke).
    if (isConnSelfIdentity(sender, senderAlt, conn)) {
        return { authorized: true, role: 'owner' };
    }

    // TELEGRAM_ADMIN_IDS e da CONTA da sessao, nao do remetente.
    // Liberar todo mundo no grupo do chip admin virou VIP falso (consulta no GP).

    if (!sender || !telegramUserId) {
        return { authorized: false, role: 'none' };
    }

    const extra = Array.isArray(senderAlt) ? senderAlt : (senderAlt ? [senderAlt] : []);
    const ids = [sender, ...extra].filter(Boolean);
    let uniqueIds = [...new Set(ids.map(String).map(canonJid).filter(isPersonJid))];
    // Chip da sessao no extra nao pode promover um user a dono/VIP.
    if (conn && uniqueIds.length && !isConnSelfIdentity(sender, null, conn)) {
        const stripped = uniqueIds.filter((id) => !idMatchesBot(id, conn));
        uniqueIds = stripped.length ? stripped : [canonJid(sender)].filter(isPersonJid);
    }
    const alt = uniqueIds.find((id) => id !== String(sender)) || null;
    const normalizedSender = normalizeJid(sender);
    const cacheKey = uniqueIds.map((id) => normalizeJid(id) || id).join('|');

    // Verifica cache
    if (!authCache.has(telegramUserId)) {
        authCache.set(telegramUserId, new Map());
    }
    const userCache = authCache.get(telegramUserId);

    const cached = userCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < CACHE_TTL) {
        return { authorized: cached.authorized, role: cached.role };
    }

    const owners = expandStoredOwners(getEffectiveOwners(telegramUserId), conn);
    const vips = expandStoredOwners(getVips(telegramUserId), conn);
    const blacklist = getBlacklist(telegramUserId) || [];

    const hitList = (list) =>
        Array.isArray(list) && uniqueIds.some((id) => list.some((entry) => matchesAuthorizedEntry(id, entry)));

    // Blacklist da sessao — bloqueia tudo
    if (hitList(blacklist)) {
        const result = { authorized: false, role: 'none', timestamp: now };
        userCache.set(cacheKey, result);
        return result;
    }

    // Check owner (sender OU senderAlt / telefone do LID)
    if (hitList(owners)) {
        if (process.env.DEBUG_WA === '1') {
            logger.logInfo(`[AUTH] Owner authorized: ${normalizedSender}${alt ? ` alt=${normalizeJid(alt)}` : ''}`);
        }
        const result = { authorized: true, role: 'owner', timestamp: now };
        userCache.set(cacheKey, result);
        return result;
    }

    // Check VIP
    if (hitList(vips)) {
        if (process.env.DEBUG_WA === '1') {
            logger.logInfo(`[AUTH] VIP authorized: ${normalizedSender}${alt ? ` alt=${normalizeJid(alt)}` : ''}`);
        }
        const result = { authorized: true, role: 'vip', timestamp: now };
        userCache.set(cacheKey, result);
        return result;
    }

    try {
        const vipIndex = require('../services/billing/vipIndex');
        if (vipIndex.hasAny('whatsapp', uniqueIds)) {
            const result = { authorized: true, role: 'vip', timestamp: now };
            userCache.set(cacheKey, result);
            return result;
        }
        const selfTg = String(telegramUserId || '');
        const senderStr = String(sender || '');
        if (selfTg && /^\d{5,}$/.test(senderStr) && senderStr === selfTg && vipIndex.tierOf('telegram', selfTg) !== 'free') {
            const result = { authorized: true, role: 'vip', timestamp: now };
            userCache.set(cacheKey, result);
            return result;
        }
    } catch (_) { /* billing opcional */ }

    // Usuario comum: nao cacheia — senão PV_DROP gruda 60s depois do dono ser reconhecido no grupo
    return { authorized: true, role: 'user' };
}

/**
 * Limpa o cache de autorização para um usuário específico
 * @param {string} telegramUserId - The Telegram user ID
 */
function clearAuthCache(telegramUserId) {
    if (authCache.has(telegramUserId)) {
        authCache.delete(telegramUserId);
        logger.logInfo(`[AUTH] Cache limpo para usuario: ${telegramUserId}`);
    }
}

/**
 * Limpa todo o cache de autorização
 */
function clearAllAuthCache() {
    authCache.clear();
    logger.logInfo(`[AUTH] Todo o cache de autorização limpo`);
}

/**
 * Sets authorization flags on context object
 * @param {Object} ctx - The message context
 * @param {string} telegramUserId - The Telegram user ID
 */
function expandIdsFromConn(conn, ids) {
    const seed = Array.isArray(ids) ? ids.filter(Boolean).map(String) : [];
    if (!seed.length || !conn) return seed;
    const extra = [];
    try {
        const map = conn.signalRepository?.lidMapping;
        for (const id of seed) {
            if (!String(id).includes('@lid') || !map) continue;
            const pn =
                (typeof map.getPNForLID === 'function' && map.getPNForLID(id)) ||
                (typeof map.lidToPn === 'function' && map.lidToPn(id)) ||
                (typeof map.get === 'function' && map.get(id));
            if (pn) extra.push(String(pn));
        }
    } catch (_) { /* mapping opcional */ }
    const out = [...seed];
    for (const x of extra) {
        if (x && !out.includes(x)) out.push(x);
    }
    return out;
}

function expandStoredOwners(list, conn) {
    const out = [];
    const seen = new Set();
    const push = (v) => {
        const s = canonJid(v);
        if (!s || seen.has(s) || !isPersonJid(s)) return;
        seen.add(s);
        out.push(s);
    };
    for (const e of list || []) push(e);
    const map = conn?.signalRepository?.lidMapping;
    for (const e of [...out]) {
        if (String(e).includes('@lid')) {
            try {
                const pn =
                    (typeof map?.getPNForLID === 'function' && map.getPNForLID(e)) ||
                    (typeof map?.lidToPn === 'function' && map.lidToPn(e)) ||
                    (typeof map?.get === 'function' && map.get(e));
                if (pn) push(String(pn));
            } catch (_) { /* ignore */ }
        } else if (map) {
            try {
                const user = String(e).split('@')[0];
                const lid =
                    (typeof map.getLIDForPN === 'function' && map.getLIDForPN(e)) ||
                    (typeof map.pnToLid === 'function' && map.pnToLid(e)) ||
                    (typeof map.get === 'function' && map.get(user));
                if (lid) push(String(lid).includes('@') ? String(lid) : `${lid}@lid`);
            } catch (_) { /* ignore */ }
        }
    }
    return out;
}

function setAuthorizationFlags(ctx, telegramUserId) {
    healPrivateContext(ctx);
    rememberIdentitiesFromCtx(ctx);
    let ids = collectAuthIdentities(ctx);
    ids = expandIdsFromGroupCache(ids, ctx.from);
    ids = expandIdsFromConn(ctx.conn, ids);
    const sender = ids[0] || ctx.sender || ctx.from;
    const senderAlt = ids.slice(1);

    const authResult = checkAuthorization(sender, telegramUserId, false, senderAlt, ctx.conn);

    const fresh = isFreshSessionOwner(ctx);
    const pvOwnerHit = !ctx.isGroup && (
        authResult.role === 'owner' || authResult.role === 'platform_admin'
    );
    ctx.isOwner = fresh || pvOwnerHit;
    ctx.isVip = ctx.isOwner || authResult.role === 'vip';
    if (ctx.isOwner) {
        ctx.authRole = authResult.role === 'platform_admin' ? 'platform_admin' : 'owner';
    } else {
        ctx.authRole = authResult.role;
    }
    ctx.isUser = authResult.authorized && (authResult.role === 'user' || ctx.isVip || ctx.isOwner);
    ctx.authAuthorized = authResult.authorized;
    if (!ctx.senderAlt && ids[1]) ctx.senderAlt = ids[1];

    return { authorized: ctx.authAuthorized, role: ctx.authRole };
}

/**
 * Recalcula dono da sessao. Nao confia em ctx.isOwner (admin de grupo / flag velha).
 * Admin nativo do Zap NUNCA entra aqui.
 */
function isFreshSessionOwner(ctx) {
    if (!ctx) return false;
    const conn = ctx.conn || null;
    const fromMe = !!(ctx.fromMe || ctx.info?.key?.fromMe || ctx.key?.fromMe);
    const inGroup = !!(ctx.isGroup || /@g\.us$/i.test(String(ctx.from || '')));
    // fromMe em PV: sender e o peer — precisa elevar (anti-PV).
    // fromMe em grupo: so eleva se identidade casar com o chip (nao confiar so na flag).
    if (fromMe) {
        if (!inGroup) return true;
        const ids = resolveCanonicalIdentity(ctx.sender || ctx.from, ctx);
        if (conn && isConnSelfIdentity(ids[0] || ctx.sender || ctx.from, ids, conn)) return true;
        // Sem conn nao fail-open em grupo (evita membro virar dono por fromMe errado).
        return false;
    }
    const ids = resolveCanonicalIdentity(ctx.sender || ctx.from, ctx);
    // O chip conectado e dono da sessao, mesmo se a lista `owners` estiver suja
    // ou telegramUserId ainda nao tiver sido copiado pro ctx.
    if (isConnSelfIdentity(ids[0] || ctx.sender || ctx.from, ids, conn)) return true;
    const tid = String(ctx.telegramUserId || conn?._telegramUserId || '');
    if (!tid) return false;
    const auth = checkAuthorization(ids[0] || ctx.sender || ctx.from, tid, false, ids, conn);
    return auth.role === 'owner' || auth.role === 'platform_admin';
}

/** Alias pedido na OS: uma funcao de identidade. */
function sameIdentity(a, b) {
    return matchesAuthorizedEntry(a, b);
}

function resolveIdentity(raw) {
    return canonJid(raw);
}

/** Fonte unica OS: qualquer LID/PN/JID → lista canonica (PN + LID). */
function resolveCanonicalIdentity(raw, ctx = null) {
    const ids = collectAuthIdentities({
        ...(ctx || {}),
        sender: raw || ctx?.sender,
        from: ctx?.from,
        conn: ctx?.conn,
        info: ctx?.info
    });
    if (ids.length) return ids;
    const one = canonJid(raw);
    return one ? [one] : [];
}

/** Numero na lista `owners` da sessao = dono em TODOS os grupos, independente de admin nativo. */
function isBotSessionOwner(telegramUserId, jid, extraIds, conn) {
    if (!telegramUserId || !jid) return false;
    const extra = Array.isArray(extraIds) ? extraIds : (extraIds ? [extraIds] : []);
    try {
        const auth = checkAuthorization(jid, telegramUserId, false, extra, conn);
        if (auth.role === 'owner' || auth.role === 'platform_admin') return true;
    } catch (_) { /* ignore */ }
    try {
        const owners = getEffectiveOwners(telegramUserId) || [];
        const ids = [jid, ...extra].filter(Boolean);
        if (ids.some((id) => owners.some((o) => sameIdentity(o, id)))) return true;
    } catch (_) { /* ignore */ }
    return false;
}

/**
 * Gate de dono da sessao.
 * NUNCA redireciona pro PV do dono (resolveOwnerPrivateJid e so pra UI de addgrupo).
 * Grupo / fromMe / canal: so log AUTH_SILENT. PV: responde no mesmo chat.
 * @returns {Promise<boolean>} true se e dono
 */
async function requireSessionOwner(conn, ctx, text = 'Apenas o dono da sessao.') {
    if (ctx && conn) {
        if (!ctx.conn) ctx.conn = conn;
        if (!ctx.telegramUserId && conn._telegramUserId) ctx.telegramUserId = conn._telegramUserId;
    }
    const ok = isFreshSessionOwner(ctx);
    if (ctx) ctx.isOwner = ok;
    if (ok) return true;

    const fromMe = !!(ctx?.fromMe || ctx?.info?.key?.fromMe);
    const from = String(ctx?.from || '');
    const inGroup = !!(ctx?.isGroup || (typeof from === 'string' && from.endsWith('@g.us')));
    const inChannel = !!(ctx?.isChannel || (typeof from === 'string' && (from.endsWith('@newsletter') || from.endsWith('@broadcast'))));
    const where = fromMe ? 'fromMe' : (inGroup ? 'group' : (inChannel ? 'channel' : 'dm'));

    if (fromMe || inGroup || inChannel) {
        try {
            logger.logAviso(`[AUTH_SILENT] requireSessionOwner where=${where} from=${from} sender=${ctx?.sender || ''}`);
        } catch (_) { /* ignore */ }
        return false;
    }

    const dest = from;
    if (!dest || dest.endsWith('@lid')) {
        try {
            logger.logAviso(`[AUTH_SILENT] requireSessionOwner where=${where} from=${from} sender=${ctx?.sender || ''} skipped=lid_or_empty`);
        } catch (_) { /* ignore */ }
        return false;
    }
    try {
        logger.logAviso(`[AUTH_DM] requireSessionOwner from=${from} sender=${ctx?.sender || ''}`);
    } catch (_) { /* ignore */ }
    if (conn?.sendMessage) {
        try {
            await conn.sendMessage(dest, { text }, { quoted: ctx?.info || null });
        } catch (_) { /* ignore */ }
    }
    return false;
}

module.exports = {
    matchesAuthorizedEntry,
    sameIdentity,
    resolveIdentity,
    resolveCanonicalIdentity,
    isAuthorized,
    checkAuthorization,
    setAuthorizationFlags,
    isFreshSessionOwner,
    collectAuthIdentities,
    botIdentities,
    isConnSelfIdentity,
    detectMessageContext,
    clearAuthCache,
    clearAllAuthCache,
    requireSessionOwner,
    isBotSessionOwner,
    phonesMatch
};
