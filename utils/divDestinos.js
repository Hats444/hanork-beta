'use strict';
/**
 * Destino da DIV — so grupo WhatsApp.
 *
 * Fonte da verdade = lista oficial (addgrupo + join de convite).
 * 1. Convites ja aceitos na database entram na lista (exceto addgrupo off).
 * 2. Destino = essa lista. Lista vazia = nao envia (nao usa os grupos do chip).
 * 3. Canal oficial / @newsletter nunca entram.
 * 4. Blacklist e gruposExcluidos saem.
 */
const logger = require('../logger');

const HEAL_GAP_MS = 45000;
const lastHealAt = new Map();

let canalDigitsCache = null;

function canalDigitsSet() {
    if (canalDigitsCache) return canalDigitsCache;
    const out = new Set();
    const push = (raw) => {
        const d = String(raw || '').replace(/\D/g, '');
        if (d.length >= 10) out.add(d);
    };
    try {
        const { getCanalId } = require('./canal');
        push(getCanalId());
    } catch (_) { /* canal opcional */ }
    push(process.env.WHATSAPP_CANAL_ID);
    push('120363412971004933');
    push('120363424111563088');
    push('120363428263139165');
    canalDigitsCache = out;
    return out;
}

function isCanalDestino(jid) {
    const s = String(jid || '').trim();
    if (!s) return false;
    if (s.endsWith('@newsletter')) return true;
    const digits = s.replace(/\D/g, '');
    if (!digits) return false;
    return canalDigitsSet().has(digits);
}

function normalizeGrupoJid(jid) {
    const s = String(jid || '').trim();
    if (!s || s.endsWith('@newsletter')) return '';
    if (s.endsWith('@lid') || s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us')) return '';
    if (s.endsWith('@g.us')) {
        const user = s.split('@')[0].split(':')[0];
        if (!user) return '';
        const gid = `${user}@g.us`;
        return isCanalDestino(gid) ? '' : gid;
    }
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 15 && digits.startsWith('120')) {
        if (canalDigitsSet().has(digits)) return '';
        return `${digits}@g.us`;
    }
    return '';
}

function isGrupoDestino(jid) {
    const g = normalizeGrupoJid(jid);
    return !!(g && g.endsWith('@g.us') && !isCanalDestino(g));
}

function uniqueGrupos(jids) {
    const out = [];
    const seen = new Set();
    for (const raw of jids || []) {
        const g = normalizeGrupoJid(raw);
        if (!g || seen.has(g)) continue;
        seen.add(g);
        out.push(g);
    }
    return out;
}

function applyBlacklist(telegramUserId, jids) {
    let list = uniqueGrupos(jids);
    try {
        const { getBlacklist } = require('./configManager');
        const bl = new Set((getBlacklist(telegramUserId) || []).map((x) => normalizeGrupoJid(x) || String(x)));
        list = list.filter((g) => !bl.has(g));
    } catch (_) { /* blacklist opcional */ }
    return list;
}

async function listParticipatingGroupJids(conn) {
    const out = new Set();
    if (!conn || typeof conn.groupFetchAllParticipating !== 'function') return [];
    try {
        const { prefetchParticipatingGroups } = require('./moderation');
        const all = await prefetchParticipatingGroups(conn);
        if (all && typeof all === 'object') {
            for (const j of Object.keys(all)) {
                const g = normalizeGrupoJid(j);
                if (g) out.add(g);
            }
        }
    } catch (_) { /* fetch opcional */ }
    return [...out];
}

async function listJoinedInviteJids(telegramUserId) {
    try {
        const { listJoinedGroupJids } = require('./groupManager/inviteStore');
        return uniqueGrupos(await listJoinedGroupJids(telegramUserId));
    } catch (_) {
        return [];
    }
}

async function healListaFromDb(telegramUserId) {
    const uid = String(telegramUserId || '');
    if (!uid) return { fromDb: [], recovered: 0 };
    const { mergeGruposLista } = require('./divulgacao');
    const fromDb = await listJoinedInviteJids(uid);
    if (fromDb.length) mergeGruposLista(uid, fromDb);
    let recovered = 0;
    const prev = lastHealAt.get(uid) || 0;
    if (Date.now() - prev >= HEAL_GAP_MS) {
        lastHealAt.set(uid, Date.now());
        try {
            recovered = await require('./groupManager/queue').recoverMissingRegistry(uid);
        } catch (_) { /* recover opcional */ }
    }
    return { fromDb, recovered: Number(recovered) || 0 };
}

/**
 * Resolve destinos reais do blast.
 * opts.onlyGroups — recorte (cooldown/teste), ainda so @g.us.
 */
async function resolveGruposDestino(conn, telegramUserId, opts = {}) {
    const uid = String(telegramUserId || '');
    const { getGruposParaDivulgar } = require('./divulgacao');
    const onlyRaw = Array.isArray(opts.onlyGroups) && opts.onlyGroups.length
        ? uniqueGrupos(opts.onlyGroups)
        : null;

    let fromDb = [];
    if (!onlyRaw) {
        const heal = await healListaFromDb(uid);
        fromDb = heal.fromDb;
    }

    let listed = uniqueGrupos((getGruposParaDivulgar(uid).grupos || []));
    let dest = listed;
    if (onlyRaw) {
        const want = new Set(onlyRaw);
        dest = dest.filter((g) => want.has(g));
        if (!dest.length) dest = onlyRaw;
    }

    dest = applyBlacklist(uid, dest);
    try {
        const { isGrupoExcluido } = require('./divulgacao');
        dest = dest.filter((g) => !isGrupoExcluido(uid, g));
    } catch (_) { /* exclude opcional */ }
    try {
        const { getGroupSecurity } = require('./moderation');
        dest = dest.filter((g) => !!getGroupSecurity(g, uid).grupoDivulgacao);
    } catch (_) { /* flag opcional: fail-open */ }
    try {
        logger.logInfo(
            `[DIV] dest listed=${listed.length} db=${fromDb.length}` +
            ` fallback=0 send=${dest.length}`
        );
    } catch (_) { /* log opcional */ }
    return dest;
}

function formatDestinoResumo(n) {
    const q = Number(n) || 0;
    if (q <= 0) {
        return 'Nenhum grupo na lista. Use addgrupo ou deixe o bot entrar pelos convites da fila.';
    }
    return (
        `${q} grupo${q === 1 ? '' : 's'} da lista oficial\n` +
        `Origem: addgrupo + grupos que o bot ja entrou pelos convites\n` +
        `Canal oficial nao recebe este envio`
    );
}

module.exports = {
    isCanalDestino,
    normalizeGrupoJid,
    isGrupoDestino,
    uniqueGrupos,
    applyBlacklist,
    listParticipatingGroupJids,
    listJoinedInviteJids,
    healListaFromDb,
    resolveGruposDestino,
    formatDestinoResumo
};
