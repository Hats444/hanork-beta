// commands/groupsecurity.js
// Protecao de grupos (logica Hanork / moderation.js)

const {
    getGroupSecurity,
    setGroupSecurityFlag,
    getGroupLists,
    formatGroupSecurityStatus,
    formatAntiAtkStatus,
    toggleListMember,
    addWarning,
    clearWarning,
    setLimitec,
    setWelcomeText,
    resolveTargetJid,
    resolveBanAllTarget,
    getOwnerSecurity,
    setOwnerSecurityFlag,
    setAntipvAll,
    formatOwnerSecurityStatus,
    listGhostCandidates,
    flushMsgCounts,
    isKickableJid,
    addGlobalBlacklisted,
    removeGlobalBlacklisted,
    getGlobalBlacklist,
    banFromAllParticipatingGroups,
    prefetchParticipatingGroups,
    isSessionSelfIdentity,
    isOwnerOrBotTarget,
    deleteMessageSmart,
    deleteMessageAsAdmin,
    expandBanTargetIds,
    cacheMessageMatchesTarget,
    collectMessageSenderIds,
    identitiesEqualStrict,
    sameParticipant,
    isDivulgacaoPaymentPayload,
    resolveMemberPhoneDigits
} = require('../utils/moderation');
const { ensureJidString } = require('../utils');

/** Digitos E.164 do membro (PN/jid). LID tenta mapa LID→PN. */
function participantPhoneDigits(p) {
    try {
        const jid = p?.id || p?.jid || p?.lid || p?.phoneNumber;
        const d = resolveMemberPhoneDigits(null, jid, p);
        if (d) return d;
    } catch (_) { /* fallback abaixo */ }
    const cands = [p?.phoneNumber, p?.jid, p?.id];
    for (const c of cands) {
        const s = String(c || '');
        if (!s || s.includes('@lid') || s.includes('@g.us') || s.includes('@newsletter')) continue;
        const num = s.replace(/\D/g, '');
        if (num.length >= 10 && num.length <= 15) return num;
    }
    return '';
}

function participantIsAdminLocal(p) {
    const a = p?.admin;
    if (a === 'admin' || a === 'superadmin' || a === true || a === 1) return true;
    return !!(p?.isAdmin || p?.isSuperAdmin);
}

/**
 * Membros com DDI != 55. Ignora bot, dono da sessao e (default) admins.
 */
function listFakeParticipants(meta, conn, telegramUserId, opts = {}) {
    const skipAdmins = opts.skipAdmins !== false;
    const botId = ensureJidString(conn?.user?.id || '', '');
    const botLid = ensureJidString(conn?.user?.lid || '', '');
    const out = [];
    const seen = new Set();
    for (const p of meta?.participants || []) {
        if (skipAdmins && participantIsAdminLocal(p)) continue;
        const ids = [p.id, p.lid, p.phoneNumber, p.jid]
            .map((x) => ensureJidString(x, ''))
            .filter(Boolean);
        if (ids.some((id) => sameParticipant(id, botId) || sameParticipant(id, botLid))) continue;
        if (telegramUserId && ids.some((id) => isOwnerOrBotTarget(conn, telegramUserId, id))) continue;
        const digits = participantPhoneDigits(p);
        if (!digits || digits.startsWith('55')) continue;
        if (seen.has(digits)) continue;
        seen.add(digits);
        out.push({
            id: ensureJidString(p.id, ''),
            lid: p.lid,
            phoneNumber: p.phoneNumber,
            jid: p.jid,
            digits,
            participant: p
        });
    }
    return out;
}

function collectFakeKickIds(fake) {
    const kickIds = [];
    const seen = new Set();
    const push = (raw) => {
        const kid = ensureJidString(raw, '');
        if (!kid || !isKickableJid(kid) || seen.has(kid)) return;
        seen.add(kid);
        kickIds.push(kid);
    };
    push(fake?.id);
    push(fake?.lid);
    push(fake?.phoneNumber);
    push(fake?.jid);
    if (fake?.digits) push(`${fake.digits}@s.whatsapp.net`);
    return kickIds;
}

async function kickFakeFromGroup(conn, gid, fake) {
    const kickIds = collectFakeKickIds(fake);
    for (const kid of kickIds) {
        try {
            await conn.groupParticipantsUpdate(gid, [kid], 'remove');
            return { ok: true, kid };
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            if (/rate-overlimit/i.test(msg)) {
                await new Promise((r) => setTimeout(r, 200));
                try {
                    await conn.groupParticipantsUpdate(gid, [kid], 'remove');
                    return { ok: true, kid };
                } catch (_) { /* next id */ }
            }
        }
    }
    return { ok: false, kid: '' };
}

async function purgeFakeMessagesInGroup(conn, ctx, groupId, fake) {
    const gid = ensureJidString(groupId, '');
    const target = fake?.phoneNumber || fake?.jid || (fake?.digits ? `${fake.digits}@s.whatsapp.net` : '') || fake?.id;
    if (!gid || !target) return { deleted: 0 };
    const fakeCtx = { ...ctx, from: gid, isGroup: true };
    try {
        return await deleteTargetUserMessages(conn, fakeCtx, target, BANALL_DELETE_CAP);
    } catch (_) {
        return { deleted: 0 };
    }
}

async function banFakesInGroup(conn, ctx, groupId, fakes) {
    const gid = ensureJidString(groupId, '');
    let kicked = 0;
    let failed = 0;
    let deleted = 0;
    for (const fake of fakes) {
        try {
            const del = await purgeFakeMessagesInGroup(conn, ctx, gid, fake);
            deleted += del?.deleted || 0;
        } catch (_) { /* best-effort */ }
        try {
            const kick = await kickFakeFromGroup(conn, gid, fake);
            if (kick.ok) kicked++;
            else failed++;
        } catch (_) {
            failed++;
        }
        await new Promise((r) => setTimeout(r, 550));
    }
    return { kicked, failed, deleted, fakes: fakes.length };
}

const commands = {};

function parseOnOff(text) {
    const { parseOnOff: shared } = require('../utils/protectionStore');
    return shared(text);
}

/** Dono, VIP ou IDM (platform_admin / admin TG) */
function isStaffDeleteAdmin(ctx, conn) {
    if (ctx?.isOwner || ctx?.isVip) return true;
    if (ctx?.authRole === 'platform_admin' || ctx?.authRole === 'owner') return true;
    try {
        const { isPlatformAdmin } = require('../utils/exploitGate');
        if (isPlatformAdmin(ctx, conn)) return true;
    } catch (_) { /* ignore */ }
    return false;
}

async function refreshToggleCtx(conn, ctx) {
    ctx.conn = ctx.conn || conn;
    try {
        const { getCachedGroupMetadata } = require('../utils/groupMetaCache');
        if (ctx.isGroup && ctx.from) await getCachedGroupMetadata(conn, ctx.from);
    } catch (_) { /* cache opcional */ }
}

async function toggleFlag(conn, ctx, flag, label) {
    await refreshToggleCtx(conn, ctx);
    let bangpOwner = false;
    try {
        const { isFreshSessionOwner } = require('../utils/authorization');
        bangpOwner = isFreshSessionOwner(ctx);
        if (bangpOwner) ctx.isOwner = true;
    } catch (_) {
        bangpOwner = !!ctx.isOwner;
    }
    if (flag === 'bangp' && !bangpOwner) {
        return conn.sendMessage(ctx.from, {
            text: 'So o dono da sessao liga/desliga bangp (bot ignora o grupo).'
        }, { quoted: ctx.info });
    }
    const { assertCanToggle } = require('../utils/protectionStore');
    const gate = assertCanToggle(ctx);
    if (!gate.ok) {
        return conn.sendMessage(ctx.from, { text: gate.text }, { quoted: ctx.info });
    }
    if (!ctx.isGroup) {
        return conn.sendMessage(ctx.from, {
            text: `Use este comando DENTRO do grupo WhatsApp.\n\nExemplo: ${require('../utils/configManager').prefixFromCtx(ctx)}${flag} on`
        }, { quoted: ctx.info });
    }
    const parsed = parseOnOff(ctx.text) ?? parseOnOff((ctx.args || [])[0]);
    let enabled;
    if (parsed === null) {
        const cur = getGroupSecurity(ctx.from, ctx.telegramUserId)[flag];
        enabled = !cur;
    } else {
        enabled = parsed;
    }
    if (enabled && (flag === 'antiporno' || flag === 'antiporn')) {
        const key = String(
            process.env.HANORK_API_KEY || process.env.ZEROTWO_API_KEY || ''
        ).trim();
        if (!key) {
            return conn.sendMessage(ctx.from, {
                text:
                    'Anti-porno precisa de HANORK_API_KEY ou ZEROTWO_API_KEY no .env ' +
                    '(ex.: key  da Zero Two API).\n' +
                    'Sem a chave a flag nao analisa imagens.'
            }, { quoted: ctx.info });
        }
    }
    const saved = await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, flag, enabled, ctx.sender);
    const actualOn = !!saved[flag];
    const fromPanel = !!(ctx.isInteractive || (parsed === null && !String(ctx.text || '').trim()));
    const p = require('../utils/configManager').prefixFromCtx(ctx);
    const { findSecurityItem } = require('../utils/securityMenu');
    const item = findSecurityItem(flag) || findSecurityItem(label);
    const explain = item?.explain ? `\n${item.explain}` : '';
    const acao = flag === 'antidelete'
        ? (actualOn
            ? '\nEfeito: apagar uma msg neste grupo faz o bot reenviar. Teste agora (texto + apagar pra todos).'
            : '\nEfeito: o bot nao recupera mais msg apagada neste grupo.')
        : (item?.actionHint
            ? `\nAcao: ${item.actionHint} (admins/dono em geral isentos)`
            : '');
    await conn.sendMessage(ctx.from, {
        text:
            `${label}: ${actualOn ? 'LIGADO' : 'DESLIGADO'} neste grupo` +
            (actualOn !== !!enabled ? ' (corrigido apos gravar)' : '') +
            `\nOutros grupos nao mudam.` +
            explain +
            acao +
            `\n\nVer o que apaga/ban agora: ${p}protecoesativas\nPainel: ${p}gpseguranca`
    }, { quoted: ctx.info });
    if (fromPanel) {
        const { sendSecurityPanel } = require('../utils/securityMenu');
        return sendSecurityPanel(conn, {
            chatId: ctx.from,
            quoted: ctx.info,
            telegramUserId: ctx.telegramUserId,
            sessionId: ctx.sessionId || conn?._sessionId,
            isGroup: true,
            groupId: ctx.from,
            skipIntroStatus: true
        });
    }
}

function needOwner(conn, ctx) {
    try {
        const { isFreshSessionOwner } = require('../utils/authorization');
        if (isFreshSessionOwner(ctx)) {
            ctx.isOwner = true;
            return true;
        }
    } catch (_) {
        if (ctx.isOwner) return true;
    }
    conn.sendMessage(ctx.from, { text: 'Apenas o dono da sessao.' }, { quoted: ctx.info });
    return false;
}

function needOwnerOrVip(conn, ctx) {
    try {
        const { isFreshSessionOwner } = require('../utils/authorization');
        if (isFreshSessionOwner(ctx)) {
            ctx.isOwner = true;
            return true;
        }
    } catch (_) {
        if (ctx.isOwner) return true;
    }
    if (ctx.isVip || ctx.authRole === 'vip' || ctx.authRole === 'platform_admin') return true;
    try {
        const { checkAuthorization, resolveCanonicalIdentity } = require('../utils/authorization');
        const ids = resolveCanonicalIdentity(ctx.sender, ctx);
        const auth = checkAuthorization(ids[0] || ctx.sender, ctx.telegramUserId, false, ids, ctx.conn);
        if (auth.role === 'vip' || auth.role === 'owner' || auth.role === 'platform_admin') {
            if (auth.role === 'vip') ctx.isVip = true;
            return true;
        }
    } catch (_) { /* */ }
    conn.sendMessage(ctx.from, { text: 'So dono ou VIP.' }, { quoted: ctx.info });
    return false;
}

async function senderIsGroupAdmin(conn, ctx) {
    if (ctx.isAdmin || ctx.authRole === 'group_admin') return true;
    try {
        const { canTogglePolicy } = require('../utils/protectionStore');
        if (canTogglePolicy(ctx.sender, ctx.from, ctx)) return true;
    } catch (_) { /* ignore */ }
    try {
        const { getSecurityGroupMetadata, peekGroupMetadata } = require('../utils/groupMetaCache');
        let meta = null;
        try {
            meta = await getSecurityGroupMetadata(conn, ctx.from);
        } catch (_) {
            meta = peekGroupMetadata(ctx.from);
        }
        if (!meta && conn?.groupMetadata) {
            meta = await Promise.race([
                conn.groupMetadata(ctx.from).catch(() => null),
                new Promise((res) => setTimeout(() => res(null), 2500))
            ]);
        }
        if (!meta) return false;
        const cands = [ctx.sender, ctx.senderAlt, ctx.senderPn, ctx.senderLid].filter(Boolean);
        return (meta.participants || []).some((p) => {
            const adm = p.admin === 'admin' || p.admin === 'superadmin';
            if (!adm) return false;
            const ids = [p.id, p.phoneNumber, p.jid, p.lid].filter(Boolean);
            return cands.some((c) => ids.some((id) => sameParticipant(id, c)));
        });
    } catch (_) {
        return false;
    }
}

async function needOwnerOrGroupAdmin(conn, ctx) {
    try {
        const { isFreshSessionOwner } = require('../utils/authorization');
        if (isFreshSessionOwner(ctx)) {
            ctx.isOwner = true;
            return true;
        }
    } catch (_) {
        if (ctx.isOwner) return true;
    }
    if (!ctx.isGroup) {
        conn.sendMessage(ctx.from, { text: 'Apenas o dono da sessao.' }, { quoted: ctx.info });
        return false;
    }
    if (await senderIsGroupAdmin(conn, ctx)) return true;
    conn.sendMessage(ctx.from, {
        text: 'Apenas o dono da sessao ou um admin deste grupo (bot tambem admin).'
    }, { quoted: ctx.info });
    return false;
}

/** Teto: 50 mais recentes no cache. Lote paralelo — kick nao espera o purge. */
const BANALL_DELETE_CAP = 50;
const BANALL_DELETE_BATCH = 4;
const BANALL_DELETE_DELAY_MS = 80;

function messageTimestamp(msg) {
    const t = msg?.messageTimestamp ?? msg?.message?.messageTimestamp;
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
}

function rememberPairFromKey(key) {
    if (!key) return;
    try {
        const { rememberLidPhonePair } = require('../utils');
        const a = String(key.participant || '');
        const b = String(key.participantAlt || key.participantPn || key.senderPn || '');
        if (a.includes('@lid') && (b.includes('@s.whatsapp.net') || b.includes('@c.us'))) {
            rememberLidPhonePair(a, b);
        } else if (b.includes('@lid') && (a.includes('@s.whatsapp.net') || a.includes('@c.us'))) {
            rememberLidPhonePair(b, a);
        }
    } catch (_) { /* cache opcional */ }
}

function messageInGroup(msg, gid) {
    const g = ensureJidString(gid, '');
    if (!g) return false;
    const a = ensureJidString(msg?.key?.remoteJid, '');
    const b = ensureJidString(msg?.key?.remoteJidAlt, '');
    return a === g || b === g;
}

function quotedMessageFromCtx(ctx, gid) {
    const info = ctx?.info || ctx?.raw || {};
    let raw = info.message || ctx?.message || {};
    for (let i = 0; i < 4; i++) {
        if (raw.ephemeralMessage?.message) raw = raw.ephemeralMessage.message;
        else if (raw.viewOnceMessage?.message) raw = raw.viewOnceMessage.message;
        else if (raw.viewOnceMessageV2?.message) raw = raw.viewOnceMessageV2.message;
        else break;
    }
    const cinfo =
        raw.extendedTextMessage?.contextInfo ||
        raw.imageMessage?.contextInfo ||
        raw.videoMessage?.contextInfo ||
        raw.documentMessage?.contextInfo ||
        raw.stickerMessage?.contextInfo ||
        {};
    const stanzaId = String(cinfo.stanzaId || ctx.quoted?.stanzaId || '');
    if (!stanzaId) return null;
    const participant = cinfo.participant || ctx.quoted?.participant || ctx.quoted?.sender;
    if (!participant) return null;
    return {
        key: {
            remoteJid: gid,
            id: stanzaId,
            fromMe: false,
            participant,
            participantAlt: cinfo.participantAlt || cinfo.participantPn || ctx.quoted?.participantAlt,
            participantPn: cinfo.participantPn || ctx.quoted?.participantPn,
            addressingMode: ctx.info?.key?.addressingMode || ctx.quoted?.key?.addressingMode,
            remoteJidAlt: ctx.info?.key?.remoteJidAlt
        },
        message: cinfo.quotedMessage || ctx.quoted?.message || undefined,
        messageTimestamp: 0
    };
}

async function deleteTargetUserMessages(conn, ctx, targetJid, max = BANALL_DELETE_CAP) {
    if (!ctx.isGroup) return { deleted: 0, scanned: 0 };
    const { getCache } = require('../cache');
    const { ensureJidString } = require('../utils');
    const sid = ctx.sessionId || conn?._sessionId || 'default';
    const gid = ensureJidString(ctx.from, '');
    let cache;
    try { cache = getCache(sid); } catch (_) { return { deleted: 0, scanned: 0 }; }
    if (!cache || typeof cache.keys !== 'function') return { deleted: 0, scanned: 0 };

    const cmdId = String(ctx.info?.key?.id || ctx.key?.id || '');
    const groupMsgs = [];
    const seenKey = new Set();
    const keys = cache.keys();
    for (const key of keys) {
        try {
            const msg = cache.get(key);
            const mid = msg?.key?.id;
            if (!mid || seenKey.has(mid)) continue;
            if (cmdId && mid === cmdId) continue;
            if (msg.key.fromMe) continue;
            if (!messageInGroup(msg, gid)) continue;
            rememberPairFromKey(msg.key);
            seenKey.add(mid);
            groupMsgs.push(msg);
        } catch (_) { /* continue */ }
    }

    const targetIds = expandBanTargetIds(conn, gid, targetJid);
    const quoted = quotedMessageFromCtx(ctx, gid);
    if (quoted) rememberPairFromKey(quoted.key);

    const hits = [];
    const seen = new Set();
    const pushHit = (msg) => {
        const mid = msg?.key?.id;
        if (!mid || seen.has(mid) || (cmdId && mid === cmdId)) return;
        if (msg.key.fromMe) return;
        seen.add(mid);
        hits.push(msg);
    };
    for (const msg of groupMsgs) {
        if (cacheMessageMatchesTarget(msg, targetIds)) pushHit(msg);
    }
    if (quoted) {
        const qPay = isDivulgacaoPaymentPayload(quoted);
        const idx = hits.findIndex((m) => m.key.id === quoted.key.id);
        if (idx >= 0 && qPay) {
            hits[idx] = quoted;
        } else if (cacheMessageMatchesTarget(quoted, targetIds) || qPay) {
            pushHit(quoted);
        } else {
            const qIds = [
                quoted.key.participant,
                quoted.key.participantAlt,
                quoted.key.participantPn
            ];
            const aimed = qIds.some((id) => targetIds.some((t) => identitiesEqualStrict(id, t)));
            if (aimed) pushHit(quoted);
        }
    }

    const anyTs = hits.some((m) => messageTimestamp(m) > 0);
    if (anyTs) {
        hits.sort((a, b) => messageTimestamp(b) - messageTimestamp(a));
    }
    if (hits.length > max) hits.length = max;

    let deleted = 0;
    const special = [];
    const normal = [];
    for (const msg of hits) {
        if (isDivulgacaoPaymentPayload(msg)) special.push(msg);
        else normal.push(msg);
    }

    const wipe = async (msg) => {
        const part = msg.key.participant
            || collectMessageSenderIds(msg)[0]
            || targetJid;
        return deleteMessageSmart(
            conn,
            gid,
            msg.key.id,
            !!msg.key.fromMe,
            part,
            msg
        );
    };

    for (const msg of special) {
        try {
            const r = await wipe(msg);
            if (r?.success) deleted++;
        } catch (_) { /* best-effort */ }
    }

    for (let i = 0; i < normal.length; i += BANALL_DELETE_BATCH) {
        const batch = normal.slice(i, i + BANALL_DELETE_BATCH);
        const results = await Promise.all(batch.map(async (msg) => {
            try {
                return await wipe(msg);
            } catch (_) {
                return { success: false };
            }
        }));
        deleted += results.filter((r) => r?.success).length;
        if (i + BANALL_DELETE_BATCH < normal.length) {
            await new Promise((r) => setTimeout(r, BANALL_DELETE_DELAY_MS));
        }
    }
    try {
        require('../logger').logInfo(
            `[BANALL] purge hits=${hits.length} deleted=${deleted} scanned=${groupMsgs.length} pay=${special.length}`
        );
    } catch (_) { /* ignore */ }
    return { deleted, scanned: hits.length, payments: special.length };
}

/** Apaga ate 50 msgs do alvo nos grupos do cache. skipGid = grupo ja purgado. */
async function deleteTargetUserMessagesAllGroups(conn, ctx, targetJid, maxPerGroup = BANALL_DELETE_CAP, skipGid = '') {
    const { ensureJidString } = require('../utils');
    const gids = new Set();
    const skip = ensureJidString(skipGid, '');
    const current = ensureJidString(ctx.from, '');
    if (current.endsWith('@g.us') && current !== skip) gids.add(current);
    try {
        const { getCache } = require('../cache');
        const sid = ctx.sessionId || conn?._sessionId || 'default';
        const cache = getCache(sid);
        if (cache && typeof cache.keys === 'function') {
            for (const key of cache.keys()) {
                try {
                    const msg = cache.get(key);
                    const gid = ensureJidString(msg?.key?.remoteJid, '');
                    if (gid.endsWith('@g.us')) gids.add(gid);
                } catch (_) { /* skip */ }
            }
        }
    } catch (_) { /* cache opcional */ }
    try {
        const { peekAllGroupMetas } = require('../utils/groupMetaCache');
        for (const meta of peekAllGroupMetas() || []) {
            const id = ensureJidString(meta.id || meta.jid, '');
            if (id.endsWith('@g.us')) gids.add(id);
        }
    } catch (_) { /* meta opcional */ }

    let deleted = 0;
    let groupsHit = 0;
    let scanned = 0;
    for (const gid of gids) {
        if (skip && gid === skip) continue;
        const fakeCtx = { ...ctx, from: gid, isGroup: true };
        try {
            const r = await deleteTargetUserMessages(conn, fakeCtx, targetJid, maxPerGroup);
            const n = r?.deleted || 0;
            scanned += r?.scanned || 0;
            if (n) {
                deleted += n;
                groupsHit++;
            }
        } catch (e) {
            try {
                require('../logger').logAviso(`[BANALL] delete ${gid}: ${e.message}`);
            } catch (_) { /* ignore */ }
        }
    }
    return { deleted, groups: groupsHit, scanned };
}

async function deleteCommanderCommand(conn, ctx) {
    if (!ctx.isGroup) return false;
    const key = ctx.info?.key || ctx.key || {};
    const id = key.id;
    if (!id) return false;
    const { ensureJidString } = require('../utils');
    try {
        const r = await deleteMessageAsAdmin(
            conn,
            ensureJidString(ctx.from, ''),
            id,
            !!key.fromMe,
            key.participant || ctx.sender || ctx.senderAlt
        );
        return !!r?.success;
    } catch (_) {
        return false;
    }
}

function tagUser(jid) {
    return `@${String(jid || '').split('@')[0].split(':')[0]}`;
}

async function sendBanNote(conn, ctx, jid, body, title = 'BAN GLOBAL') {
    const { formatReportBlock } = require('../utils/typography');
    const lines = Array.isArray(body) ? body : [body];
    const payload = {
        text: formatReportBlock(title, lines),
        mentions: jid ? [jid] : undefined
    };
    try {
        return await conn.sendMessage(ctx.from, payload, { quoted: ctx.info, skipForward: true, _hanorkTrusted: true });
    } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        if (!/forbidden|not-authorized/i.test(msg)) throw e;
        try {
            const { resolveOwnerPrivateJid } = require('../utils/divulgacaoReply');
            const pv = resolveOwnerPrivateJid(ctx, conn);
            if (pv && String(pv) !== String(ctx.from)) {
                return await conn.sendMessage(pv, { text: payload.text }, { skipForward: true, _hanorkTrusted: true });
            }
        } catch (_) { /* ignore */ }
    }
}

function banallUsageLines(ctx) {
    const p = require('../utils/configManager').prefixFromCtx(ctx);
    return [
        'Apaga ate 50 msgs recentes do alvo no cache de CADA grupo da sessao (PIX nativo pela tecnica fake; resto revoke de admin), tira de todos os grupos (bot adm) e coloca na lista negra.',
        '',
        `Banir — ${p}banall @ / numero / responda`,
        `Tirar da lista — ${p}unbanall @ / numero`,
        `Ver lista — ${p}listban`
    ];
}

async function executeBanAllTarget(conn, ctx, jid) {
    if (!jid) {
        return sendBanNote(conn, ctx, null, banallUsageLines(ctx));
    }
    if (!isKickableJid(jid)) {
        return conn.sendMessage(ctx.from, { text: 'Alvo invalido (nao e um usuario).' }, { quoted: ctx.info });
    }
    if (isSessionSelfIdentity(conn, jid)) {
        return conn.sendMessage(ctx.from, { text: 'Nao e possivel banir o dono da sessao nem o proprio bot.' }, { quoted: ctx.info });
    }

    const logger = require('../logger');
    const tag = tagUser(jid);
    addGlobalBlacklisted(ctx.telegramUserId, jid);
    const prefetch = Promise.race([
        prefetchParticipatingGroups(conn),
        new Promise((resolve) => setTimeout(() => resolve(null), 2500))
    ]);

    let deleted = 0;
    let groupsDeleted = 0;
    let sweep = { kicked: 0, skipped: 0, failed: 0, scanned: 0 };
    const prevSweep = !!conn._hanorkBanallSweep;
    conn._hanorkBanallSweep = true;
    try {
        if (ctx.isGroup) {
            const here = await deleteTargetUserMessages(conn, ctx, jid, BANALL_DELETE_CAP).catch((e) => {
                logger.logAviso(`[BANALL] delete aqui: ${e.message}`);
                return { deleted: 0, scanned: 0 };
            });
            deleted = here?.deleted || 0;
            if (deleted) groupsDeleted = 1;
        }
        const restP = deleteTargetUserMessagesAllGroups(
            conn, ctx, jid, BANALL_DELETE_CAP, ctx.from
        ).catch((e) => {
            logger.logAviso(`[BANALL] delete outros: ${e.message}`);
            return { deleted: 0, groups: 0 };
        });
        sweep = await banFromAllParticipatingGroups(
            conn, jid, ctx.telegramUserId, ctx.from, { prefetch }
        ).catch((e) => {
            logger.logAviso(`[BANALL] sweep: ${e.message}`);
            return { kicked: 0, skipped: 0, failed: 0, scanned: 0 };
        });
        const rest = await Promise.race([
            restP,
            new Promise((r) => setTimeout(() => r(null), 5000))
        ]);
        if (rest) {
            deleted += rest.deleted || 0;
            groupsDeleted += rest.groups || 0;
        } else {
            restP.then((r) => {
                if (r?.deleted) logger.logInfo(`[BANALL] delete fundo +${r.deleted} em ${r.groups} gp`);
            }).catch(() => {});
        }
    } finally {
        conn._hanorkBanallSweep = prevSweep;
    }

    const bits = [`${tag} —`];
    if (deleted) bits.push(`${deleted} msgs apagadas${groupsDeleted ? ` em ${groupsDeleted} grupo(s),` : ','}`);
    bits.push(sweep.kicked ? `saiu de ${sweep.kicked} grupos,` : 'nao estava em nenhum grupo com o bot adm,');
    bits.push('lista negra ligada.');
    if (sweep.failed) bits.push(`${sweep.failed} falha(s) de permissao.`);
    let pay = [];
    try {
        pay = require('../utils/productOffer').banallPayFooter() || [];
    } catch (_) { /* oferta opcional */ }
    const noteLines = [bits.join(' '), ...pay];
    await sendBanNote(conn, ctx, jid, noteLines);
    try {
        const { formatReportBlock } = require('../utils/typography');
        await sendBanallPayToTarget(conn, jid, formatReportBlock('BAN GLOBAL', noteLines));
    } catch (e) {
        logger.logAviso(`[BANALL] pay pv: ${e && e.message ? e.message : e}`);
    }
    try {
        await deleteCommanderCommand(conn, ctx);
    } catch (_) { /* comando do dono: best-effort */ }
}

async function sendBanallPayToTarget(conn, jid, text) {
    if (!jid || !text) return false;
    const raw = String(jid);
    if (raw.endsWith('@g.us') || raw.endsWith('@newsletter') || raw.endsWith('@broadcast')) return false;
    const dests = [raw];
    try {
        const { resolvePeerJid } = require('../utils');
        const pn = resolvePeerJid(raw, null, conn);
        if (pn && !dests.includes(pn) && !String(pn).endsWith('@g.us')) dests.push(pn);
    } catch (_) { /* mapping opcional */ }
    for (const dest of dests) {
        try {
            await conn.sendMessage(dest, { text }, { skipForward: true, _hanorkTrusted: true });
            return true;
        } catch (_) { /* tenta o proximo jid */ }
    }
    return false;
}

async function cmdBanAll(conn, ctx) {
    if (!needOwner(conn, ctx)) return;
    const jid = await resolveBanAllTarget(ctx, conn);
    if (jid && await denyIfCannotTarget(conn, ctx, jid)) return;
    return executeBanAllTarget(conn, ctx, jid);
}

async function cmdUnbanAll(conn, ctx) {
    if (!needOwner(conn, ctx)) return;
    const jid = await resolveTargetJid(ctx, conn);
    if (ctx._hanorkTargetImmune) return;
    if (!jid) {
        return sendBanNote(conn, ctx, null, banallUsageLines(ctx), 'LISTA NEGRA');
    }
    const r = removeGlobalBlacklisted(ctx.telegramUserId, jid);
    if (ctx.isGroup) {
        try { toggleListMember(ctx.from, ctx.telegramUserId, 'blacklist', jid, false); } catch (_) {}
    }
    const tag = tagUser(jid);
    await sendBanNote(
        conn,
        ctx,
        jid,
        r.removed
            ? `${tag} saiu da lista negra. Nao volta sozinho pros grupos.`
            : `${tag} nao estava na lista negra.`,
        'LISTA NEGRA'
    );
}

async function cmdListBan(conn, ctx) {
    if (!needOwner(conn, ctx)) return;
    const global = getGlobalBlacklist(ctx.telegramUserId);
    const local = ctx.isGroup ? getGroupLists(ctx.from, ctx.telegramUserId).blacklist : [];
    const gBody = global.length ? global.map((j, i) => `${i + 1}. ${j}`).join('\n') : '(vazia)';
    const lines = [
        'LISTA NEGRA GLOBAL',
        gBody
    ];
    if (ctx.isGroup && local.length) {
        lines.push('', 'Lista deste grupo (legado):', local.map((j, i) => `${i + 1}. ${j}`).join('\n'));
    }
    await conn.sendMessage(ctx.from, { text: lines.join('\n') }, { quoted: ctx.info });
}

async function needOwnerGroup(conn, ctx) {
    return needOwnerOrGroupAdmin(conn, ctx);
}

async function denyIfCannotTarget(conn, ctx, jid) {
    try {
        const { checkTargetActionLive } = require('../utils/permissionEngine');
        const r = await checkTargetActionLive(conn, ctx, jid);
        if (!r.allowed) {
            await conn.sendMessage(ctx.from, {
                text: 'Nao posso remover dono, VIP ou admin.'
            }, { quoted: ctx.info });
            return true;
        }
        return false;
    } catch (_) {
        try {
            const { isFreshSessionOwner } = require('../utils/authorization');
            if (isFreshSessionOwner(ctx)) return false;
        } catch (_e) { /* */ }
        await conn.sendMessage(ctx.from, {
            text: 'Nao posso remover dono, VIP ou admin.'
        }, { quoted: ctx.info }).catch(() => {});
        return true;
    }
}

// ---- toggles midia / link gp / canal / limite ----
const TOGGLES = [
    ['antilink', 'antilink', 'Anti-link'],
    ['antilinkhard', 'antilinkHard', 'Anti-link HARD'],
    ['antifake', 'antifake', 'Anti-fake'],
    ['soadm', 'soadm', 'Somente admin (comandos)'],
    ['antilinkgp', 'antilinkGp', 'Anti-link GP (convite)'],
    ['antilinkeasy', 'antilinkEasy', 'Anti-link easy'],
    ['antiimg', 'antiimg', 'Anti-imagem'],
    ['antivideo', 'antivideo', 'Anti-video'],
    ['antiaudio', 'antiaudio', 'Anti-audio'],
    ['antisticker', 'antisticker', 'Anti-sticker'],
    ['antidoc', 'antidoc', 'Anti-documento'],
    ['antiloc', 'antiloc', 'Anti-localizacao'],
    ['antictt', 'antictt', 'Anti-contato'],
    ['antichannel', 'antichannel', 'Anti-canal'],
    ['antipayment', 'antipayment', 'Anti-pagamento'],
    ['anticatalogo', 'anticatalogo', 'Anti-catalogo'],
    ['antistatus', 'antistatus', 'Anti-status'],
    ['antipalavrao', 'antipalavrao', 'Anti-palavrao'],
    ['bemvindo', 'bemvindo', 'Bem-vindo'],
    ['autoapresentar', 'autoapresentar', 'Auto-apresentar (kick se nao falar)'],
    ['saiu', 'saiu', 'Aviso de saida'],
    ['autoconvite', 'autoconvite', 'Alerta pedido de entrada'],
    ['autoaceitar', 'autoaceitar', 'Aceita pedido de entrada sozinho'],
    ['x9config', 'x9config', 'Avisa nome/desc/foto/fechamento'],
    ['autodown', 'autodown', 'Auto-download de links'],
    ['antinotas', 'antinotas', 'Anti-notas'],
    ['bangp', 'bangp', 'Banir grupo (bot ignora)'],
    ['autosticker', 'autosticker', 'Auto-sticker'],
    ['antiporno', 'antiporno', 'Anti-porno (API)'],
    ['limiteflood', 'limiteflood', 'Limite de caracteres'],
    ['antidelete', 'antidelete', 'Anti-delete (recupera msg apagada)']
];

/** Ban+apaga por vetor — cada um liga/desliga sozinho (nao e um master unico) */
const ATTACK_TOGGLES = [
    ['antiatkstatus', 'antiatkstatus', 'Anti-ataque proto status GP (nao mencao)'],
    ['antiatkinvisivel', 'antiatkinvisivel', 'Anti-ataque viewOnce+crash (nao visu normal)'],
    ['antiatkpagamento', 'antiatkpagamento', 'Anti-ataque pagamento nativo (ban+apaga)'],
    ['antiatkcrash', 'antiatkcrash', 'Anti-ataque crash/trava (template/carousel/etc)'],
    ['antiatkpoll', 'antiatkpoll', 'Anti-ataque poll/enquete'],
    ['antiatkmencao', 'antiatkmencao', 'Anti-ataque mencao em massa'],
    ['antiatkreacao', 'antiatkreacao', 'Anti-ataque flood de reacoes'],
    ['antiatkedicao', 'antiatkedicao', 'Anti-ataque edicao maliciosa']
];

/** Superficies Baileys — default OFF, apaga (exceto viewOnce=log e settings=log) */
const SURFACE_TOGGLES = [
    ['surfpayment', 'surfPayment', 'Anti-pay scam (lib)'],
    ['surfgroupstatus', 'surfGroupStatus', 'Anti-status GP (lib)'],
    ['surfforwardspoof', 'surfForwardSpoof', 'Anti-forward spoof'],
    ['surfmetai', 'surfMetaAi', 'Anti-Meta AI spoof'],
    ['surfbizfake', 'surfBizFake', 'Anti-biz fake (0@)'],
    ['surfphishad', 'surfPhishAd', 'Anti-phish ad'],
    ['surfnativeflow', 'surfNativeFlow', 'Deny nativeFlow desconhecido'],
    ['surfviewonce', 'surfViewOnce', 'Anti-viewOnce (so log)'],
    ['surfcapmentions', 'surfCapMentions', 'Cap mentions'],
    ['surfcapmedia', 'surfCapMedia', 'Cap midia/album'],
    ['surffakepoll', 'surfFakePoll', 'Anti-fake poll'],
    ['surfsettingsflood', 'surfSettingsFlood', 'Sensor settings flood']
];

for (const [name, flag, label] of TOGGLES) {
    commands[name] = {
        useCtx: true,
        description: `${label} on/off`,
        usage: `${name} on|off`,
        execute: async (conn, ctx) => toggleFlag(conn, ctx, flag, label)
    };
}
commands.antidel = commands.antidelete;
commands.onlyadm = commands.soadm;
commands.blockgp = commands.soadm;
commands.admcmd = commands.soadm;
commands.soadmin = commands.soadm;
commands.attacc = commands.autoaceitar;

commands.protoff = {
    useCtx: true,
    description: 'Desliga todas as protecoes deste grupo',
    usage: 'protoff',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const { resetAllGroupProtections, assertCanToggle } = require('../utils/protectionStore');
        const gate = assertCanToggle(ctx);
        if (!gate.ok) {
            return conn.sendMessage(ctx.from, { text: gate.text }, { quoted: ctx.info });
        }
        await resetAllGroupProtections(ctx.from, ctx.sender, ctx.telegramUserId);
        await conn.sendMessage(ctx.from, {
            text: 'Todas as protecoes deste grupo DESLIGADAS.\nLiga uma a uma: .gpseguranca'
        }, { quoted: ctx.info });
    }
};
commands.desligarprotecoes = commands.protoff;
commands.protecoesoff = commands.protoff;

for (const [name, flag, label] of ATTACK_TOGGLES) {
    commands[name] = {
        useCtx: true,
        description: `${label} on/off (ban+apaga autor)`,
        usage: `${name} on|off`,
        execute: async (conn, ctx) => toggleFlag(conn, ctx, flag, label)
    };
}

for (const [name, flag, label] of SURFACE_TOGGLES) {
    commands[name] = {
        useCtx: true,
        description: `${label} on/off`,
        usage: `${name} on|off`,
        execute: async (conn, ctx) => toggleFlag(conn, ctx, flag, label)
    };
}

commands.antilingp = commands.antilinkgp;
commands.antidocumento = commands.antidoc;
commands.anticontato = commands.antictt;
commands.antichannell = commands.antichannel;
commands.antimencao = commands.antistatus;
commands.welcome = commands.bemvindo;
commands.bv = commands.bemvindo;
commands.autoapres = commands.autoapresentar;
commands.autodownload = commands.autodown;
commands.antiporn = commands.antiporno;
commands.antistatusatk = commands.antiatkstatus;
commands.antiinvisivel = commands.antiatkinvisivel;
commands.antipagamentoatk = commands.antiatkpagamento;
commands.anticrash = commands.antiatkcrash;
commands.anticrashgp = commands.antiatkcrash;
commands.antipollatk = commands.antiatkpoll;
commands.antimencaomassa = commands.antiatkmencao;
commands.antireacao = commands.antiatkreacao;
commands.antiedicao = commands.antiatkedicao;

{
    const bemvindoToggle = commands.bemvindo;
    commands.bemvindo = {
        useCtx: true,
        description: 'Boas-vindas personalizaveis on/off',
        usage: 'bemvindo on|off',
        execute: async (conn, ctx) => {
            const parsed = parseOnOff(ctx.text) ?? parseOnOff((ctx.args || [])[0]);
            const kit = require('../utils/welcomeKit');
            const p = require('../utils/configManager').prefixFromCtx(ctx);
            if (parsed === null && !ctx.isInteractive) {
                if (!ctx.isGroup) {
                    return conn.sendMessage(ctx.from, { text: 'Use no grupo.' }, { quoted: ctx.info });
                }
                const lists = getGroupLists(ctx.from, ctx.telegramUserId);
                const st = await kit.statusLines(ctx.telegramUserId, ctx.from, lists);
                const on = !!getGroupSecurity(ctx.from, ctx.telegramUserId).bemvindo;
                return conn.sendMessage(ctx.from, {
                    text: `Bem-vindo: ${on ? 'LIGADO' : 'DESLIGADO'}\n${st}\n\n${kit.howto(p)}`
                }, { quoted: ctx.info });
            }
            await bemvindoToggle.execute(conn, ctx);
            const on = !!getGroupSecurity(ctx.from, ctx.telegramUserId).bemvindo;
            if (on && ctx.isGroup) {
                const lists = getGroupLists(ctx.from, ctx.telegramUserId);
                const st = await kit.statusLines(ctx.telegramUserId, ctx.from, lists);
                await conn.sendMessage(ctx.from, { text: `${st}\n\n${kit.howto(p)}` }, { quoted: ctx.info }).catch(() => {});
            }
        }
    };
    commands.welcome = commands.bemvindo;
    commands.bv = commands.bemvindo;

    const saiuToggle = commands.saiu;
    commands.saiu = {
        useCtx: true,
        description: 'Aviso de saida personalizavel on/off',
        usage: 'saiu on|off',
        execute: async (conn, ctx) => {
            const parsed = parseOnOff(ctx.text) ?? parseOnOff((ctx.args || [])[0]);
            const kit = require('../utils/welcomeKit');
            const p = require('../utils/configManager').prefixFromCtx(ctx);
            if (parsed === null && !ctx.isInteractive) {
                if (!ctx.isGroup) {
                    return conn.sendMessage(ctx.from, { text: 'Use no grupo.' }, { quoted: ctx.info });
                }
                const lists = getGroupLists(ctx.from, ctx.telegramUserId);
                const st = await kit.statusLines(ctx.telegramUserId, ctx.from, lists);
                const on = !!getGroupSecurity(ctx.from, ctx.telegramUserId).saiu;
                return conn.sendMessage(ctx.from, {
                    text: `Saida: ${on ? 'LIGADO' : 'DESLIGADO'}\n${st}\n\n${kit.howto(p)}`
                }, { quoted: ctx.info });
            }
            await saiuToggle.execute(conn, ctx);
            const on = !!getGroupSecurity(ctx.from, ctx.telegramUserId).saiu;
            if (on && ctx.isGroup) {
                const lists = getGroupLists(ctx.from, ctx.telegramUserId);
                const st = await kit.statusLines(ctx.telegramUserId, ctx.from, lists);
                await conn.sendMessage(ctx.from, { text: `${st}\n\n${kit.howto(p)}` }, { quoted: ctx.info }).catch(() => {});
            }
        }
    };
}

commands.autoconvite = {
    useCtx: true,
    description: 'Alerta de pedido de entrada on/off (por grupo)',
    usage: 'autoconvite on|off',
    execute: async (conn, ctx) => {
        try {
            const { resolveGroupJid } = require('../utils/joinRequestManager');
            const gid = resolveGroupJid(ctx);
            if (gid) {
                ctx.from = gid;
                ctx.isGroup = true;
            }
        } catch (_) { /* */ }
        return toggleFlag(conn, ctx, 'autoconvite', 'Autoconvite');
    }
};

/** Abre o mesmo painel (anti-trava ja esta la) — sem segundo menu/texto enorme */
commands.antiataque = {
    useCtx: true,
    description: 'Liga/desliga os 8 vetores antiatk (com confirmacao)',
    usage: 'antiataque on|off',
    execute: async (conn, ctx) => {
        if (!ctx.isGroup) {
            return conn.sendMessage(ctx.from, { text: 'Use dentro do grupo.' }, { quoted: ctx.info });
        }
        await refreshToggleCtx(conn, ctx);
        const { assertCanToggle, armAtkConfirm, ATTACK_VECTORS } = require('../utils/protectionStore');
        const gate = assertCanToggle(ctx);
        if (!gate.ok) {
            return conn.sendMessage(ctx.from, { text: gate.text }, { quoted: ctx.info });
        }
        const parsed = parseOnOff(ctx.text) ?? parseOnOff((ctx.args || [])[0]);
        const p = require('../utils/configManager').prefixFromCtx(ctx);
        if (parsed === null) {
            const { sendSecurityPanel } = require('../utils/securityMenu');
            return sendSecurityPanel(conn, {
                chatId: ctx.from,
                quoted: ctx.info,
                telegramUserId: ctx.telegramUserId,
                sessionId: ctx.sessionId || conn?._sessionId,
                isGroup: true,
                groupId: ctx.from,
                skipIntroStatus: true
            });
        }
        armAtkConfirm(ctx, parsed);
        const { sendInteractiveButtons } = require('../helpers');
        const verb = parsed ? 'ligar' : 'desligar';
        return sendInteractiveButtons(
            conn,
            ctx.from,
            `Isso vai ${verb} os ${ATTACK_VECTORS.length} vetores antiatk neste grupo. Confirma?`,
            [
                { id: 'prot_atk_confirm', label: parsed ? 'Sim, ligar' : 'Sim, desligar' },
                { id: 'prot_atk_cancel', label: 'Cancelar' }
            ],
            'Hanork Bot',
            ctx.info,
            null,
            ctx.telegramUserId,
            ctx.sessionId || conn?._sessionId
        );
    }
};
commands.protecaototal = commands.antiataque;
commands.antiattack = commands.antiataque;

commands.presetprotecao = {
    useCtx: true,
    description: 'Aplica preset de protecao (loja|divulgacao|fechado)',
    usage: 'presetprotecao loja|divulgacao|fechado',
    execute: async (conn, ctx) => {
        if (!ctx.isGroup) {
            return conn.sendMessage(ctx.from, { text: 'Use dentro do grupo.' }, { quoted: ctx.info });
        }
        await refreshToggleCtx(conn, ctx);
        const { assertCanToggle, applyProtectionPreset, PROTECTION_PRESETS } = require('../utils/protectionStore');
        const gate = assertCanToggle(ctx);
        if (!gate.ok) {
            return conn.sendMessage(ctx.from, { text: gate.text }, { quoted: ctx.info });
        }
        const id = String((ctx.args && ctx.args[0]) || '').toLowerCase().trim();
        const p = require('../utils/configManager').prefixFromCtx(ctx);
        if (!id || !PROTECTION_PRESETS[id]) {
            const list = Object.entries(PROTECTION_PRESETS)
                .map(([k, v]) => `• ${k} — ${v.desc}`)
                .join('\n');
            return conn.sendMessage(ctx.from, {
                text: `Presets:\n${list}\n\nUso: ${p}presetprotecao loja`
            }, { quoted: ctx.info });
        }
        const r = await applyProtectionPreset(ctx.from, id, ctx.sender, ctx.telegramUserId);
        if (!r.ok) {
            return conn.sendMessage(ctx.from, { text: r.message || 'Falha no preset.' }, { quoted: ctx.info });
        }
        return conn.sendMessage(ctx.from, {
            text: `Preset ${r.label} aplicado.\n${r.desc}\nPainel: ${p}gpseguranca`
        }, { quoted: ctx.info });
    }
};
commands.presetseg = commands.presetprotecao;

commands.legendabv = {
    useCtx: true,
    description: 'Texto de bem-vindo (@user @grupo #hora#)',
    usage: 'legendabv <texto>',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const kit = require('../utils/welcomeKit');
        const t = String(ctx.text || '').trim();
        const p = require('../utils/configManager').prefixFromCtx(ctx);
        if (!t) {
            const lists = getGroupLists(ctx.from, ctx.telegramUserId);
            const cur = kit.isGenericTemplate(lists.welcomeText, 'welcome')
                ? '(vazio — nao manda frase padrao)'
                : lists.welcomeText;
            return conn.sendMessage(ctx.from, {
                text: `Legenda entrada:\n${cur}\n\n${kit.howto(p)}`
            }, { quoted: ctx.info });
        }
        if (/^(off|0)$/i.test(t)) {
            setWelcomeText(ctx.from, ctx.telegramUserId, '', 'welcome');
            return conn.sendMessage(ctx.from, { text: 'Legenda entrada apagada.' }, { quoted: ctx.info });
        }
        const saved = setWelcomeText(ctx.from, ctx.telegramUserId, t, 'welcome');
        await conn.sendMessage(ctx.from, { text: `Legenda entrada salva.\n${saved}` }, { quoted: ctx.info });
    }
};
commands.legendasaiu = {
    useCtx: true,
    description: 'Texto de saida (@user @grupo)',
    usage: 'legendasaiu <texto>',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const kit = require('../utils/welcomeKit');
        const t = String(ctx.text || '').trim();
        const p = require('../utils/configManager').prefixFromCtx(ctx);
        if (!t) {
            const lists = getGroupLists(ctx.from, ctx.telegramUserId);
            const cur = kit.isGenericTemplate(lists.leaveText, 'leave')
                ? '(vazio)'
                : lists.leaveText;
            return conn.sendMessage(ctx.from, {
                text: `Legenda saida:\n${cur}\n\n${kit.howto(p)}`
            }, { quoted: ctx.info });
        }
        if (/^(off|0)$/i.test(t)) {
            setWelcomeText(ctx.from, ctx.telegramUserId, '', 'leave');
            return conn.sendMessage(ctx.from, { text: 'Legenda saida apagada.' }, { quoted: ctx.info });
        }
        const saved = setWelcomeText(ctx.from, ctx.telegramUserId, t, 'leave');
        await conn.sendMessage(ctx.from, { text: `Legenda saida salva.\n${saved}` }, { quoted: ctx.info });
    }
};

commands.limitec = {
    useCtx: true,
    description: 'Define limite de caracteres (com limiteflood)',
    usage: 'limitec <numero>',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const n = parseInt(String(ctx.text || ctx.args?.[0] || ''), 10);
        if (!Number.isFinite(n)) {
            const lists = getGroupLists(ctx.from, ctx.telegramUserId);
            return conn.sendMessage(ctx.from, {
                text: `Limite atual: ${lists.limitec} chars\nUso: limitec <numero>\nAtive com: limiteflood on`
            }, { quoted: ctx.info });
        }
        const set = setLimitec(ctx.from, ctx.telegramUserId, n);
        await conn.sendMessage(ctx.from, {
            text: `Limite de caracteres: ${set}\nAtive/desative: limiteflood on|off`
        }, { quoted: ctx.info });
    }
};

commands.antifloodsticker = {
    useCtx: true,
    description: 'Limite de stickers por janela (off ou N)',
    usage: 'antifloodsticker <n>|off',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const t = String(ctx.text || (ctx.args || [])[0] || '').trim().toLowerCase();
        const first = t.split(/\s+/)[0] || '';
        const cur = Number(getGroupSecurity(ctx.from, ctx.telegramUserId).antifloodsticker) || 0;
        let n = 0;
        if (!first) {
            n = cur > 0 ? 0 : 5;
        } else if (/^(off|0|false|desativar|desliga|desligar|nao|não|no)$/.test(first)) {
            n = 0;
        } else if (/^(on|1|true|ativar|liga|ligar|sim|yes)$/.test(first)) {
            n = cur > 0 ? cur : 5;
        } else {
            n = parseInt(first, 10);
            if (!Number.isFinite(n) || n < 1) {
                return conn.sendMessage(ctx.from, {
                    text: 'Uso: antifloodsticker <n> ou antifloodsticker off\nPainel: toque liga (5) / desliga'
                }, { quoted: ctx.info });
            }
        }
        await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, 'antifloodsticker', n);
        if (ctx.isInteractive) {
            const { sendSecurityPanel } = require('../utils/securityMenu');
            return sendSecurityPanel(conn, {
                chatId: ctx.from,
                quoted: ctx.info,
                telegramUserId: ctx.telegramUserId,
                sessionId: ctx.sessionId || conn?._sessionId,
                isGroup: true,
                groupId: ctx.from,
                skipIntroStatus: true
            });
        }
        await conn.sendMessage(ctx.from, {
            text: n > 0
                ? `Anti-flood sticker ATIVADO (max ${n} na janela)\nON: apaga quem manda muitas figurinhas seguidas`
                : 'Anti-flood sticker DESATIVADO'
        }, { quoted: ctx.info });
    }
};

// ---- listabranca ----
commands.addlistabranca = {
    useCtx: true,
    description: 'Add jid a lista branca (isento antilink)',
    usage: 'addlistabranca <jid|responda>',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const jid = await resolveTargetJid(ctx, conn);
        if (ctx._hanorkTargetImmune) return;
        if (!jid) {
            return conn.sendMessage(ctx.from, { text: 'Responda a msg ou informe o jid/numero.' }, { quoted: ctx.info });
        }
        if (await denyIfCannotTarget(conn, ctx, jid)) return;
        toggleListMember(ctx.from, ctx.telegramUserId, 'whitelist', jid, true);
        await conn.sendMessage(ctx.from, { text: `Lista branca: adicionado ${jid}` }, { quoted: ctx.info });
    }
};
commands.rmlistabranca = {
    useCtx: true,
    description: 'Remove da lista branca',
    usage: 'rmlistabranca <jid|responda>',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const jid = await resolveTargetJid(ctx, conn);
        if (ctx._hanorkTargetImmune) return;
        if (!jid) {
            return conn.sendMessage(ctx.from, { text: 'Responda a msg ou informe o jid/numero.' }, { quoted: ctx.info });
        }
        toggleListMember(ctx.from, ctx.telegramUserId, 'whitelist', jid, false);
        await conn.sendMessage(ctx.from, { text: `Lista branca: removido ${jid}` }, { quoted: ctx.info });
    }
};
commands.listabranca = {
    useCtx: true,
    description: 'Lista branca do grupo',
    usage: 'listabranca',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const lists = getGroupLists(ctx.from, ctx.telegramUserId);
        const body = lists.whitelist.length
            ? lists.whitelist.map((j, i) => `${i + 1}. ${j}`).join('\n')
            : '(vazia)';
        await conn.sendMessage(ctx.from, { text: `LISTA BRANCA\n${body}` }, { quoted: ctx.info });
    }
};
commands.listabrancagrupo = commands.listabranca;
commands.addlistabrancagp = commands.addlistabranca;
commands.rmvlistabrancagp = commands.rmlistabranca;

// ---- mute ----
commands.mute = {
    useCtx: true,
    description: 'Mute membro (apaga msgs)',
    usage: 'mute <jid|responda>',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const jid = await resolveTargetJid(ctx, conn);
        if (ctx._hanorkTargetImmune) return;
        if (!jid) {
            return conn.sendMessage(ctx.from, { text: 'Responda a msg do membro ou informe o numero.' }, { quoted: ctx.info });
        }
        if (await denyIfCannotTarget(conn, ctx, jid)) return;
        toggleListMember(ctx.from, ctx.telegramUserId, 'mutes', jid, true);
        await conn.sendMessage(ctx.from, { text: `Mute ATIVO: ${jid}` }, { quoted: ctx.info });
    }
};
commands.desmute = {
    useCtx: true,
    description: 'Remove mute',
    usage: 'desmute <jid|responda>',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const jid = await resolveTargetJid(ctx, conn);
        if (ctx._hanorkTargetImmune) return;
        if (!jid) {
            return conn.sendMessage(ctx.from, { text: 'Responda a msg ou informe o numero.' }, { quoted: ctx.info });
        }
        toggleListMember(ctx.from, ctx.telegramUserId, 'mutes', jid, false);
        await conn.sendMessage(ctx.from, { text: `Mute removido: ${jid}` }, { quoted: ctx.info });
    }
};
commands.mutelist = {
    useCtx: true,
    description: 'Lista mutados',
    usage: 'mutelist',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const lists = getGroupLists(ctx.from, ctx.telegramUserId);
        const body = lists.mutes.length
            ? lists.mutes.map((j, i) => `${i + 1}. ${j}`).join('\n')
            : '(nenhum)';
        await conn.sendMessage(ctx.from, { text: `MUTELIST\n${body}` }, { quoted: ctx.info });
    }
};

// ---- banall / lista negra global ----
commands.banall = {
    useCtx: true,
    description: 'Ban global: apaga as msgs do alvo no cache, remove de todos os grupos e lista negra',
    usage: 'banall  (sem alvo = ajuda)',
    execute: cmdBanAll
};
commands.listanegra = {
    useCtx: true,
    description: 'Alias de banall (lista negra global)',
    usage: 'listanegra  (sem alvo = ajuda)',
    execute: cmdBanAll
};
commands.listanegrag = commands.banall;
commands.tirardalista = {
    useCtx: true,
    description: 'Remove da lista negra global',
    usage: 'tirardalista <@|numero|responda>',
    execute: cmdUnbanAll
};
commands.unbanall = {
    useCtx: true,
    description: 'Alias de tirardalista',
    usage: 'unbanall <@|numero|responda>',
    execute: cmdUnbanAll
};
commands.listban = {
    useCtx: true,
    description: 'Mostra a lista negra global',
    usage: 'listban',
    execute: cmdListBan
};

// ---- advertencias ----
commands.adv = {
    useCtx: true,
    description: 'Advertencia (kick ao atingir limiar)',
    usage: 'adv <jid|responda>',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const jid = await resolveTargetJid(ctx, conn);
        if (ctx._hanorkTargetImmune) return;
        if (!jid) {
            return conn.sendMessage(ctx.from, { text: 'Responda a msg ou informe o numero.' }, { quoted: ctx.info });
        }
        if (await denyIfCannotTarget(conn, ctx, jid)) return;
        const r = addWarning(ctx.from, ctx.telegramUserId, jid);
        let text = `Advertencia ${r.count}/${r.limit}: ${jid}`;
        if (r.kicked) {
            if (!isKickableJid(jid)) {
                text += '\nLimite atingido — alvo invalido pra remover.';
            } else {
                try {
                    await conn.groupParticipantsUpdate(ctx.from, [jid], 'remove');
                    clearWarning(ctx.from, ctx.telegramUserId, jid);
                    text += '\nLimite atingido — removido do grupo.';
                } catch (e) {
                    text += `\nFalha ao remover: ${e.message}`;
                }
            }
        }
        await conn.sendMessage(ctx.from, { text }, { quoted: ctx.info });
    }
};
commands.rmadv = {
    useCtx: true,
    description: 'Limpa advertencias',
    usage: 'rmadv <jid|responda>',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const jid = await resolveTargetJid(ctx, conn);
        if (ctx._hanorkTargetImmune) return;
        if (!jid) {
            return conn.sendMessage(ctx.from, { text: 'Responda a msg ou informe o numero.' }, { quoted: ctx.info });
        }
        clearWarning(ctx.from, ctx.telegramUserId, jid);
        await conn.sendMessage(ctx.from, { text: `Advertencias limpas: ${jid}` }, { quoted: ctx.info });
    }
};
commands.listadv = {
    useCtx: true,
    description: 'Lista advertencias',
    usage: 'listadv',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const lists = getGroupLists(ctx.from, ctx.telegramUserId);
        const entries = Object.entries(lists.warns || {});
        const body = entries.length
            ? entries.map(([j, c], i) => `${i + 1}. ${j} — ${c}/${lists.warnLimit}`).join('\n')
            : '(nenhuma)';
        await conn.sendMessage(ctx.from, { text: `ADVERTENCIAS\n${body}` }, { quoted: ctx.info });
    }
};

commands.unbangp = {
    useCtx: true,
    description: 'Desbanir grupo (bangp off)',
    usage: 'unbangp',
    execute: async (conn, ctx) => {
        ctx.text = 'off';
        ctx.args = ['off'];
        return toggleFlag(conn, ctx, 'bangp', 'Banir grupo');
    }
};

// ---- ban / kick (resposta) ----
commands.ban = {
    useCtx: true,
    description: 'Remove membro do grupo (responda ou jid)',
    usage: 'ban <jid|responda>',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const first = String(ctx.args?.[0] || '').toLowerCase();
        if (first === 'all' || first === 'todos' || first === 'global') {
            ctx.args = (ctx.args || []).slice(1);
            if (ctx.text) ctx.text = String(ctx.text).replace(/^\s*(all|todos|global)\b/i, '').trim();
            return cmdBanAll(conn, ctx);
        }
        const jid = await resolveTargetJid(ctx, conn);
        if (ctx._hanorkTargetImmune) return;
        if (!jid) {
            return conn.sendMessage(ctx.from, { text: 'Responda a msg ou informe o numero.' }, { quoted: ctx.info });
        }
        if (!isKickableJid(jid)) {
            return conn.sendMessage(ctx.from, { text: 'Alvo invalido (nao e um membro).' }, { quoted: ctx.info });
        }
        if (await denyIfCannotTarget(conn, ctx, jid)) return;
        try {
            await conn.groupParticipantsUpdate(ctx.from, [jid], 'remove');
            await conn.sendMessage(ctx.from, {
                text: `Removido: @${jid.split('@')[0]}`,
                mentions: [jid]
            }, { quoted: ctx.info });
        } catch (e) {
            await conn.sendMessage(ctx.from, { text: `Falha: ${e.message}` }, { quoted: ctx.info });
        }
    }
};
commands.kick = commands.ban;
commands.banir = commands.ban;

// ---- abrir / fechar grupo ----
async function setGroupTalk(conn, ctx, closed) {
    if (!ctx.isGroup) {
        return conn.sendMessage(ctx.from, { text: 'Use no grupo.' }, { quoted: ctx.info });
    }
    if (!(await needOwnerGroup(conn, ctx))) return;
    const specRaw = String(ctx.text || (ctx.args || []).join(' ') || '').trim();
    if (specRaw) {
        try {
            const mod = require('../utils/groupModStore');
            const spec = mod.parseScheduleSpec(specRaw);
            if (spec) {
                const action = closed ? 'close' : 'open';
                const ok = await mod.upsertOnceSchedule(ctx.telegramUserId, ctx.from, action, spec.fireAt);
                if (!ok) {
                    return conn.sendMessage(ctx.from, { text: 'Horario invalido.' }, { quoted: ctx.info });
                }
                const when = mod.formatWhen(spec.fireAt);
                return conn.sendMessage(ctx.from, {
                    text: closed
                        ? `Grupo fecha as ${when} (BRT).`
                        : `Grupo abre as ${when} (BRT).`
                }, { quoted: ctx.info });
            }
        } catch (_) { /* agenda opcional — cai no imediato */ }
    }
    try {
        await conn.groupSettingUpdate(ctx.from, closed ? 'announcement' : 'not_announcement');
        await conn.sendMessage(ctx.from, {
            text: closed ? 'Grupo FECHADO. So admin fala.' : 'Grupo ABERTO. Todos falam.'
        }, { quoted: ctx.info });
    } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        const hint = /not-authorized|forbidden|not-admin|admin/i.test(msg)
            ? 'O bot precisa ser admin deste grupo.'
            : 'Nao alterou o grupo. Confere se o bot e admin.';
        await conn.sendMessage(ctx.from, { text: hint }, { quoted: ctx.info });
    }
}

commands.fechargp = {
    useCtx: true,
    description: 'Fecha o grupo (so admins falam). Com hora: uma vez',
    usage: 'fechargp [22:00|4h]',
    execute: (conn, ctx) => setGroupTalk(conn, ctx, true)
};
commands.fechargrupo = commands.fechargp;
commands.gpfechar = commands.fechargp;
commands.groupclose = commands.fechargp;

commands.abrirgp = {
    useCtx: true,
    description: 'Abre o grupo (todos falam). Com hora: uma vez',
    usage: 'abrirgp [08:00|4h]',
    execute: (conn, ctx) => setGroupTalk(conn, ctx, false)
};
commands.abrirgrupo = commands.abrirgp;
commands.gpabrir = commands.abrirgp;
commands.groupopen = commands.abrirgp;

// ---- cita ----
commands.cita = {
    useCtx: true,
    description: 'Encaminha/copia a msg respondida e menciona os membros',
    usage: 'cita (responda) [texto]',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        try {
            const { sendCita } = require('../utils/citaRelay');
            await sendCita(conn, ctx, ctx.text);
        } catch (e) {
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.hidetag = commands.cita;
commands.totag = commands.cita;
commands.tagall = commands.cita;
commands.marcar = commands.cita;
commands.marcartodos = commands.cita;

// ---- limpar chat (fecha, limpa visual, abre) ----
commands.limpar = {
    useCtx: true,
    description: 'Fecha grupo, limpa visual do chat e reabre',
    usage: 'limpar',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const blank = 'ㅤ\n'.repeat(40);
        try {
            await conn.sendMessage(ctx.from, { text: 'Grupo FECHADO para limpeza...' }, { quoted: ctx.info });
            await conn.groupSettingUpdate(ctx.from, 'announcement');
            for (let i = 0; i < 4; i++) {
                await conn.sendMessage(ctx.from, { text: blank });
                await new Promise((r) => setTimeout(r, 800));
            }
            await conn.sendMessage(ctx.from, { text: 'Limpeza concluida. Reabrindo...' });
            await conn.groupSettingUpdate(ctx.from, 'not_announcement');
            await conn.sendMessage(ctx.from, { text: 'Grupo ABERTO novamente.' });
        } catch (e) {
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

// ---- listfake ----
commands.listfake = {
    useCtx: true,
    description: 'Lista membros com DDI diferente de 55',
    usage: 'listfake',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        try {
            const { getCachedGroupMetadata } = require('../utils/groupMetaCache');
            const meta = await getCachedGroupMetadata(conn, ctx.from);
            const fakes = listFakeParticipants(meta, conn, ctx.telegramUserId, { skipAdmins: false });
            if (!fakes.length) {
                return conn.sendMessage(ctx.from, { text: 'Nenhum numero estrangeiro no grupo.' }, { quoted: ctx.info });
            }
            const body = fakes.map((f, i) => {
                const show = f.phoneNumber || f.jid || `+${f.digits}` || f.id;
                return `${i + 1}. ${show}`;
            }).join('\n');
            await conn.sendMessage(ctx.from, {
                text:
                    `LISTA FAKE (DDI != 55)\n${body}\n\n` +
                    `Remover neste grupo: ${require('../utils/configManager').prefixFromCtx(ctx)}banfake\n` +
                    `Remover em todos: ${require('../utils/configManager').prefixFromCtx(ctx)}banfake all`
            }, { quoted: ctx.info });
        } catch (e) {
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

// ---- banfake / banfake all ----
commands.banfake = {
    useCtx: true,
    description: 'Apaga msgs e remove fakes (DDI != 55). Use "all" em todos os grupos',
    usage: 'banfake | banfake all',
    execute: async (conn, ctx) => {
        const arg = String(ctx.text || (Array.isArray(ctx.args) ? ctx.args.join(' ') : '') || '')
            .trim()
            .toLowerCase();
        const isAll = /^(all|todos|tudo)$/i.test(arg);
        if (isAll) {
            if (!needOwner(conn, ctx)) return;
        } else if (!(await needOwnerGroup(conn, ctx))) {
            return;
        }
        const pfx = require('../utils/configManager').prefixFromCtx(ctx);

        if (!isAll && !ctx.isGroup) {
            return conn.sendMessage(ctx.from, {
                text:
                    'Use dentro do grupo.\n' +
                    `Neste grupo: ${pfx}banfake\n` +
                    `Todos os grupos: ${pfx}banfake all`
            }, { quoted: ctx.info });
        }

        const { getCachedGroupMetadata, peekAllGroupMetas, peekGroupMetadata } = require('../utils/groupMetaCache');
        const prevSweep = !!conn._hanorkBanallSweep;
        conn._hanorkBanallSweep = true;

        try {
            if (!isAll) {
                const meta = await getCachedGroupMetadata(conn, ctx.from);
                const fakes = listFakeParticipants(meta, conn, ctx.telegramUserId);
                if (!fakes.length) {
                    return conn.sendMessage(ctx.from, {
                        text: 'Nenhum fake (DDI != 55) neste grupo (admins/bot ignorados).'
                    }, { quoted: ctx.info });
                }
                await conn.sendMessage(ctx.from, {
                    text: `Banfake: apagando msgs e removendo ${fakes.length} fake(s)...`
                }, { quoted: ctx.info });
                const r = await banFakesInGroup(conn, ctx, ctx.from, fakes);
                await conn.sendMessage(ctx.from, {
                    text:
                        `Banfake concluido\n` +
                        `Fakes: ${r.fakes}\n` +
                        `Msgs apagadas: ${r.deleted}\n` +
                        `Removidos: ${r.kicked}` +
                        (r.failed ? `\nFalhas: ${r.failed}` : '')
                });
                try { await deleteCommanderCommand(conn, ctx); } catch (_) { /* best-effort */ }
                return;
            }

            await conn.sendMessage(ctx.from, {
                text: 'Banfake ALL: varrendo grupos (DDI != 55)... Pode demorar.'
            }, { quoted: ctx.info });

            const fetched = await prefetchParticipatingGroups(conn).catch(() => null);
            const groups = {};
            const pushMap = (m) => {
                if (!m || typeof m !== 'object') return;
                for (const [gid, meta] of Object.entries(m)) {
                    const id = ensureJidString(gid || meta?.id || meta?.jid, '');
                    if (!id.endsWith('@g.us') || !meta) continue;
                    const prev = groups[id];
                    const prevN = (prev?.participants || []).length;
                    const nextN = (meta.participants || []).length;
                    if (!prev || nextN >= prevN) groups[id] = { ...meta, id: meta.id || id };
                }
            };
            if (fetched) pushMap(fetched);
            try {
                const fromPeek = {};
                for (const meta of peekAllGroupMetas() || []) {
                    const id = ensureJidString(meta.id || meta.jid, '');
                    if (id.endsWith('@g.us')) fromPeek[id] = meta;
                }
                if (ctx.isGroup) {
                    const hit = peekGroupMetadata(ctx.from);
                    if (hit) fromPeek[ensureJidString(ctx.from, '')] = hit;
                }
                pushMap(fromPeek);
            } catch (_) { /* cache opcional */ }

            const entries = Object.entries(groups);
            let groupsHit = 0;
            let totalFakes = 0;
            let totalKicked = 0;
            let totalFailed = 0;
            let totalDeleted = 0;

            for (const [gid, meta] of entries) {
                let parts = meta?.participants || [];
                if (!parts.length) {
                    try {
                        const fresh = await getCachedGroupMetadata(conn, gid);
                        parts = fresh?.participants || [];
                        if (fresh) groups[gid] = fresh;
                    } catch (_) { /* meta opcional */ }
                }
                const fakes = listFakeParticipants(groups[gid] || meta, conn, ctx.telegramUserId);
                if (!fakes.length) continue;
                groupsHit++;
                totalFakes += fakes.length;
                const r = await banFakesInGroup(conn, ctx, gid, fakes);
                totalKicked += r.kicked;
                totalFailed += r.failed;
                totalDeleted += r.deleted;
            }

            await conn.sendMessage(ctx.from, {
                text:
                    `Banfake ALL concluido\n` +
                    `Grupos com fake: ${groupsHit}/${entries.length}\n` +
                    `Fakes: ${totalFakes}\n` +
                    `Msgs apagadas: ${totalDeleted}\n` +
                    `Removidos: ${totalKicked}` +
                    (totalFailed ? `\nFalhas: ${totalFailed}` : '')
            });
            try { await deleteCommanderCommand(conn, ctx); } catch (_) { /* best-effort */ }
        } catch (e) {
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        } finally {
            conn._hanorkBanallSweep = prevSweep;
        }
    }
};
commands.banfakeall = {
    useCtx: true,
    description: 'Alias: banfake all',
    usage: 'banfakeall',
    execute: async (conn, ctx) => {
        const next = { ...ctx, text: 'all', args: ['all'] };
        return commands.banfake.execute(conn, next);
    }
};

// ---- promover / rebaixar (estilo ZT: responda) ----
commands.promover = {
    useCtx: true,
    description: 'Promove a admin (responda ou jid)',
    usage: 'promover (responda|jid)',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const jid = await resolveTargetJid(ctx, conn);
        if (ctx._hanorkTargetImmune) return;
        if (!jid) {
            return conn.sendMessage(ctx.from, { text: 'Responda a msg ou informe o numero.' }, { quoted: ctx.info });
        }
        if (await denyIfCannotTarget(conn, ctx, jid)) return;
        try {
            await conn.groupParticipantsUpdate(ctx.from, [jid], 'promote');
            await conn.sendMessage(ctx.from, {
                text: `Promovido a admin: @${jid.split('@')[0]}`,
                mentions: [jid]
            }, { quoted: ctx.info });
        } catch (e) {
            await conn.sendMessage(ctx.from, { text: `Falha: ${e.message}` }, { quoted: ctx.info });
        }
    }
};
commands.rebaixar = {
    useCtx: true,
    description: 'Remove admin (responda ou jid)',
    usage: 'rebaixar (responda|jid)',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const jid = await resolveTargetJid(ctx, conn);
        if (ctx._hanorkTargetImmune) return;
        if (!jid) {
            return conn.sendMessage(ctx.from, { text: 'Responda a msg ou informe o numero.' }, { quoted: ctx.info });
        }
        if (await denyIfCannotTarget(conn, ctx, jid)) return;
        try {
            await conn.groupParticipantsUpdate(ctx.from, [jid], 'demote');
            await conn.sendMessage(ctx.from, {
                text: `Rebaixado: @${jid.split('@')[0]}`,
                mentions: [jid]
            }, { quoted: ctx.info });
        } catch (e) {
            await conn.sendMessage(ctx.from, { text: `Falha: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

async function loadGroupMeta(conn, groupId) {
    try {
        const { peekGroupMetadata, getCachedGroupMetadata } = require('../utils/groupMetaCache');
        const peek = peekGroupMetadata(groupId);
        if (peek) return peek;
        if (typeof getCachedGroupMetadata === 'function') {
            return await getCachedGroupMetadata(conn, groupId);
        }
    } catch (_) { /* */ }
    if (!conn?.groupMetadata) return null;
    try {
        return await Promise.race([
            conn.groupMetadata(groupId).catch(() => null),
            new Promise((res) => setTimeout(() => res(null), 2500))
        ]);
    } catch (_) {
        return null;
    }
}

function actorInMeta(ctx, meta) {
    const cands = [ctx.sender, ctx.senderAlt, ctx.senderPn, ctx.senderLid].filter(Boolean);
    for (const p of meta?.participants || []) {
        const ids = [p.id, p.phoneNumber, p.jid, p.lid].filter(Boolean);
        if (cands.some((c) => ids.some((id) => sameParticipant(id, c)))) return p;
    }
    return null;
}

async function selfRoleUpdate(conn, ctx, action) {
    if (!ctx.isGroup) {
        return conn.sendMessage(ctx.from, { text: 'Use no grupo.' }, { quoted: ctx.info });
    }
    if (!needOwnerOrVip(conn, ctx)) return;
    try {
        if (isSessionSelfIdentity(ctx.sender, conn)) {
            return conn.sendMessage(ctx.from, { text: 'Nao mexe no proprio bot.' }, { quoted: ctx.info });
        }
    } catch (_) { /* */ }
    const meta = await loadGroupMeta(conn, ctx.from);
    if (!meta) {
        return conn.sendMessage(ctx.from, { text: 'Nao li o grupo agora.' }, { quoted: ctx.info });
    }
    try {
        const { botIsGroupAdmin } = require('../utils/protectionStore');
        if (!botIsGroupAdmin(meta, conn)) {
            return conn.sendMessage(ctx.from, { text: 'Bot precisa ser admin.' }, { quoted: ctx.info });
        }
    } catch (_) { /* */ }
    const part = actorInMeta(ctx, meta);
    if (!part) {
        return conn.sendMessage(ctx.from, { text: 'Voce nao esta neste grupo.' }, { quoted: ctx.info });
    }
    const jid = part.id || part.jid;
    const isAdm = part.admin === 'admin' || part.admin === 'superadmin';
    if (action === 'promote' && isAdm) {
        return conn.sendMessage(ctx.from, { text: 'Voce ja e admin.' }, { quoted: ctx.info });
    }
    if (action === 'demote' && !isAdm) {
        return conn.sendMessage(ctx.from, { text: 'Voce ja e membro.' }, { quoted: ctx.info });
    }
    if (action === 'demote' && part.admin === 'superadmin') {
        return conn.sendMessage(ctx.from, { text: 'Dono nativo do grupo nao rebaixa.' }, { quoted: ctx.info });
    }
    try {
        await conn.groupParticipantsUpdate(ctx.from, [jid], action);
        return conn.sendMessage(ctx.from, {
            text: action === 'promote' ? 'Agora voce e admin.' : 'Agora voce e membro.'
        }, { quoted: ctx.info });
    } catch (e) {
        return conn.sendMessage(ctx.from, { text: `Falha: ${String(e.message || e).slice(0, 80)}` }, { quoted: ctx.info });
    }
}

commands.seradm = {
    useCtx: true,
    description: 'Vira admin neste grupo (dono/VIP)',
    usage: 'seradm',
    execute: (conn, ctx) => selfRoleUpdate(conn, ctx, 'promote')
};
commands.viraradm = commands.seradm;

commands.sermembro = {
    useCtx: true,
    description: 'Vira membro neste grupo (dono/VIP)',
    usage: 'sermembro',
    execute: (conn, ctx) => selfRoleUpdate(conn, ctx, 'demote')
};
commands.virarmembro = commands.sermembro;

// ---- sessao: anticall / antipv / odelete ----
async function toggleOwnerFlag(conn, ctx, flag, label) {
    const staffOk = flag === 'odelete' && isStaffDeleteAdmin(ctx, conn);
    let ownerOk = false;
    try {
        const { isFreshSessionOwner } = require('../utils/authorization');
        ownerOk = isFreshSessionOwner(ctx);
        if (ownerOk) ctx.isOwner = true;
    } catch (_) {
        ownerOk = !!(ctx.isOwner || ctx.authRole === 'platform_admin' || ctx.authRole === 'owner');
    }
    if (flag === 'odelete') {
        if (!staffOk) {
            return conn.sendMessage(ctx.from, { text: 'Apenas IDM, dono ou VIP.' }, { quoted: ctx.info });
        }
    } else if (!ownerOk) {
        return conn.sendMessage(ctx.from, { text: 'Apenas o dono da sessao.' }, { quoted: ctx.info });
    }
    const parsed = parseOnOff(ctx.text) ?? parseOnOff((ctx.args || [])[0]);
    const curAll = getOwnerSecurity(ctx.telegramUserId);
    let enabled;
    let saved;
    if (flag === 'antipv') {
        const anyOn = !!(curAll.antipv || curAll.antipv2 || curAll.antipv3);
        enabled = parsed === null ? !anyOn : parsed;
        saved = setAntipvAll(ctx.telegramUserId, enabled);
    } else {
        const cur = curAll[flag];
        enabled = parsed === null ? !cur : parsed;
        saved = setOwnerSecurityFlag(ctx.telegramUserId, flag, enabled);
    }
    const actualOn = flag === 'antipv'
      ? !!(saved.antipv || saved.antipv2 || saved.antipv3)
      : !!saved[flag];
    const fromPanel = !!(ctx.isInteractive || (parsed === null && !String(ctx.text || '').trim()));
    if (fromPanel && ctx.isGroup) {
        const { sendSecurityPanel } = require('../utils/securityMenu');
        return sendSecurityPanel(conn, {
            chatId: ctx.from,
            quoted: ctx.info,
            telegramUserId: ctx.telegramUserId,
            sessionId: ctx.sessionId || conn?._sessionId,
            isGroup: true,
            groupId: ctx.from,
            skipIntroStatus: true
        });
    }
    await conn.sendMessage(ctx.from, {
        text:
            `${label}: ${actualOn ? 'ON' : 'OFF'}` +
            (actualOn !== !!enabled ? ' (corrigido apos gravar)' : '') +
            (flag === 'anticall'
              ? (actualOn ? '\nEfeito: quem ligar no chip e recusado/bloqueado.' : '\nEfeito: ligacoes no chip passam.')
              : '') +
            (flag === 'odelete'
              ? '\nEfeito: este botao e da sessao. Apagar msg ofensora segue cada protecao (antilink, antiimg...) ligada no grupo.'
              : '') +
            (/^antipv/.test(flag)
              ? (actualOn
                ? '\nEfeito: PV de desconhecido e barrado. Dono e VIP passam.'
                : '\nEfeito: este modo de PV desligado.')
              : '')
    }, { quoted: ctx.info });
}

commands.anticall = {
    useCtx: true,
    description: 'Bloqueia quem ligar pra bot',
    usage: 'anticall on|off',
    execute: async (conn, ctx) => toggleOwnerFlag(conn, ctx, 'anticall', 'Anti-call')
};
commands.antiligar = commands.anticall;
commands.antiligacao = commands.anticall;

commands.antipv = {
    useCtx: true,
    description: 'Bloqueia quem mandar mensagem no PV',
    usage: 'antipv on|off',
    execute: async (conn, ctx) => toggleOwnerFlag(conn, ctx, 'antipv', 'Anti-PV')
};
commands.antipv2 = {
    useCtx: true,
    description: 'Avisa 1x e ignora PV',
    usage: 'antipv2 on|off',
    execute: async (conn, ctx) => toggleOwnerFlag(conn, ctx, 'antipv2', 'Anti-PV2')
};
commands.antipv3 = {
    useCtx: true,
    description: 'PV so dono/VIP (ignora o resto)',
    usage: 'antipv3 on|off',
    execute: async (conn, ctx) => toggleOwnerFlag(conn, ctx, 'antipv3', 'Anti-PV3')
};
commands.odelete = {
    useCtx: true,
    description: 'ON: protecoes apagam a msg ofensora (default OFF)',
    usage: 'odelete on|off',
    execute: async (conn, ctx) => toggleOwnerFlag(conn, ctx, 'odelete', 'Pre-apagar')
};
commands.preapagar = commands.odelete;
commands.predelete = commands.odelete;
commands.pvseguranca = {
    useCtx: true,
    description: 'Status anti-call / anti-pv',
    usage: 'pvseguranca',
    execute: async (conn, ctx) => {
        if (!needOwner(conn, ctx)) return;
        await conn.sendMessage(ctx.from, {
            text: formatOwnerSecurityStatus(ctx.telegramUserId)
        }, { quoted: ctx.info });
    }
};

// ---- banghost ----
commands.banghost = {
    useCtx: true,
    description: 'Remove membros com poucas msgs',
    usage: 'banghost <maxMsgs>',
    execute: async (conn, ctx) => {
        if (!(await needOwnerGroup(conn, ctx))) return;
        const n = parseInt(String(ctx.text || ctx.args?.[0] || '').trim(), 10);
        if (Number.isNaN(n) || n < 0 || n > 999) {
            return conn.sendMessage(ctx.from, {
                text: 'Uso: banghost <numero>\nEx: banghost 0 — remove quem tem 0 msgs contadas\nEx: banghost 2 — remove quem tem ate 2 msgs'
            }, { quoted: ctx.info });
        }
        try {
            flushMsgCounts(ctx.telegramUserId);
            const ghosts = await listGhostCandidates(conn, ctx.from, ctx.telegramUserId, n);
            if (!ghosts.length) {
                return conn.sendMessage(ctx.from, {
                    text: `Nenhum membro com <= ${n} msgs (admins/bot ignorados).`
                }, { quoted: ctx.info });
            }
            await conn.sendMessage(ctx.from, {
                text: `Removendo ${ghosts.length} ghost(s) com <= ${n} msgs...`
            }, { quoted: ctx.info });
            let ok = 0;
            let fail = 0;
            for (const g of ghosts) {
                try {
                    if (!isKickableJid(g.id)) {
                        fail++;
                        continue;
                    }
                    await conn.groupParticipantsUpdate(ctx.from, [g.id], 'remove');
                    ok++;
                    await new Promise((r) => setTimeout(r, 900));
                } catch (_) {
                    fail++;
                }
            }
            await conn.sendMessage(ctx.from, {
                text: `Banghost concluido\nRemovidos: ${ok}\nFalhas: ${fail}`
            });
        } catch (e) {
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

// ---- revelar visu unica ----
commands.revelar = {
    useCtx: true,
    description: 'Revela midia de visualizacao unica (responda)',
    usage: 'revelar (responda a visu)',
    execute: async (conn, ctx) => {
        try {
            const { isFreshSessionOwner, checkAuthorization, resolveCanonicalIdentity } = require('../utils/authorization');
            if (!isFreshSessionOwner(ctx)) {
                const tid = String(ctx.telegramUserId || '');
                const ids = resolveCanonicalIdentity(ctx.sender, ctx);
                const auth = checkAuthorization(ids[0] || ctx.sender, tid, false, ids, ctx.conn);
                if (auth.role !== 'vip' && auth.role !== 'owner' && auth.role !== 'platform_admin') return;
            }
        } catch (_) {
            if (!ctx.isOwner && !ctx.isVip) return;
        }
        const q = ctx.quoted?.message || ctx.message;
        if (!q) {
            return conn.sendMessage(ctx.from, {
                text: 'Responda a mensagem de visualizacao unica.'
            }, { quoted: ctx.info });
        }
        const img =
            q.imageMessage ||
            q.viewOnceMessageV2?.message?.imageMessage ||
            q.viewOnceMessage?.message?.imageMessage;
        const vid =
            q.videoMessage ||
            q.viewOnceMessageV2?.message?.videoMessage ||
            q.viewOnceMessage?.message?.videoMessage;
        if (!img && !vid) {
            return conn.sendMessage(ctx.from, {
                text: 'Nenhuma imagem/video na mensagem citada.'
            }, { quoted: ctx.info });
        }
        try {
            const buf = await ctx.downloadMedia();
            if (!buf) {
                return conn.sendMessage(ctx.from, { text: 'Falha ao baixar midia.' }, { quoted: ctx.info });
            }
            const caption = (img?.caption || vid?.caption || '') + '\n\nREVELADO';
            if (img) {
                await conn.sendMessage(ctx.from, { image: buf, caption }, { quoted: ctx.info });
            } else {
                await conn.sendMessage(ctx.from, { video: buf, caption }, { quoted: ctx.info });
            }
        } catch (e) {
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};
commands.revelarvisu = commands.revelar;
commands.abrirvisu = commands.revelar;

module.exports = { commands, executeBanAllTarget, needOwnerGroup };
