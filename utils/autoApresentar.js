'use strict';
// Auto-apresentar: membro novo tem X segundos pra mandar msg; senao o bot remove.
// Default OFF. Admin/dono/bot isentos.

const logger = require('../logger');
const { ensureJidString } = require('../utils');

const pending = new Map();

function waitMs() {
    const n = Number(process.env.AUTOAPRESENTAR_MS || 90000);
    if (!Number.isFinite(n)) return 90000;
    return Math.min(Math.max(n, 15000), 600000);
}

function idsOf(raw) {
    if (!raw) return [];
    if (typeof raw === 'string') return [ensureJidString(raw, '')].filter(Boolean);
    const out = [];
    for (const k of ['id', 'jid', 'phoneNumber', 'lid', 'participant']) {
        const v = ensureJidString(raw[k], '');
        if (v) out.push(v);
    }
    return out;
}

function allKeys(gid, ids) {
    const g = ensureJidString(gid, '');
    const uniq = [...new Set((ids || []).map((id) => ensureJidString(id, '')).filter(Boolean))];
    return uniq.map((id) => `${g}|${id}`);
}

function cancelEntry(entry) {
    if (!entry) return;
    try { clearTimeout(entry.timer); } catch (_) { /* */ }
    for (const [k, v] of pending) {
        if (v === entry) pending.delete(k);
    }
}

function cancelKeys(keys) {
    const seen = new Set();
    for (const k of keys || []) {
        const hit = pending.get(k);
        if (!hit || seen.has(hit)) continue;
        seen.add(hit);
        cancelEntry(hit);
    }
}

function cancelGroup(groupId) {
    const gid = ensureJidString(groupId, '');
    if (!gid) return;
    const prefix = `${gid}|`;
    const keys = [];
    for (const k of pending.keys()) {
        if (k.startsWith(prefix)) keys.push(k);
    }
    cancelKeys(keys);
}

function notePresented(groupId, senderId, extraIds = []) {
    const gid = ensureJidString(groupId, '');
    if (!gid.endsWith('@g.us')) return;
    const ids = new Set([
        ensureJidString(senderId, ''),
        ...((Array.isArray(extraIds) ? extraIds : []).map((x) => ensureJidString(x, '')))
    ].filter(Boolean));
    if (!ids.size) return;
    const prefix = `${gid}|`;
    const keys = [];
    for (const k of pending.keys()) {
        if (!k.startsWith(prefix)) continue;
        if (ids.has(k.slice(prefix.length))) keys.push(k);
    }
    cancelKeys(keys);
}

async function kickLate(conn, gid, jid, telegramUserId, keys) {
    cancelKeys(keys);
    try {
        const { getGroupSecurity, isGroupAdminOrBot } = require('./moderation');
        const flags = getGroupSecurity(gid, telegramUserId);
        if (!flags.autoapresentar) return;
        if (await isGroupAdminOrBot(conn, gid, jid)) return;
        await conn.groupParticipantsUpdate(gid, [jid], 'remove');
        const mention = `@${String(jid).split('@')[0]}`;
        await conn.sendMessage(gid, {
            text: `${mention} removido: nao se apresentou a tempo.`,
            mentions: [jid]
        }).catch(() => {});
        logger.logAviso(`[AUTOAP] kick grupo=${gid}`);
    } catch (e) {
        logger.logAviso(`[AUTOAP] kick falhou: ${e.message}`);
    }
}

async function onParticipantUpdate(conn, update, telegramUserId) {
    if (!update || !update.id) return;
    const gid = ensureJidString(update.id, '');
    if (!gid.endsWith('@g.us')) return;
    const people = update.participants || [];
    if (update.action === 'remove' || update.action === 'leave') {
        for (const p of people) cancelKeys(allKeys(gid, idsOf(p)));
        return;
    }
    if (update.action !== 'add') return;

    const { getGroupSecurity, isGroupAdminOrBot } = require('./moderation');
    const flags = getGroupSecurity(gid, telegramUserId);
    if (!flags.autoapresentar) return;

    const ms = waitMs();
    const sec = Math.round(ms / 1000);

    for (const p of people) {
        const ids = idsOf(p);
        const jid = ids[0];
        if (!jid) continue;
        try {
            if (await isGroupAdminOrBot(conn, gid, jid, ids.slice(1))) continue;
        } catch (_) { /* fail-open: ainda agenda; kickLate recheca */ }

        const keys = allKeys(gid, ids);
        cancelKeys(keys);
        const mention = `@${jid.split('@')[0]}`;
        try {
            await conn.sendMessage(gid, {
                text: `${mention} se apresente em ${sec}s (um oi e o nome). Sem mensagem, o bot remove.`,
                mentions: [jid]
            });
        } catch (e) {
            logger.logAviso(`[AUTOAP] aviso: ${e.message}`);
        }
        const timer = setTimeout(() => {
            void kickLate(conn, gid, jid, telegramUserId, keys);
        }, ms);
        const entry = { timer, telegramUserId, jid };
        for (const k of keys) pending.set(k, entry);
    }
}

module.exports = {
    onParticipantUpdate,
    notePresented,
    cancelGroup
};
