'use strict';
/**
 * Contadores agregados de comando (sem JID, sem user id).
 * Janela rolante; so nomes de cmd + ok/err.
 */
const crypto = require('crypto');

const WINDOW_MS = Number(process.env.HANORK_CMD_STATS_WINDOW_MS || 3600000);
const MAX_KEYS = 120;

const map = new Map();

function newRequestId() {
    return crypto.randomBytes(4).toString('hex');
}

function prune(now) {
    const cut = now - WINDOW_MS;
    for (const [k, v] of map) {
        if (!v || v.last < cut) map.delete(k);
    }
    if (map.size <= MAX_KEYS) return;
    const ranked = [...map.entries()].sort(
        (a, b) => (a[1].ok + a[1].err) - (b[1].ok + b[1].err)
    );
    for (let i = 0; i < ranked.length - MAX_KEYS; i++) {
        map.delete(ranked[i][0]);
    }
}

function noteCmd(cmd, ok) {
    const name = String(cmd || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
    if (!name) return;
    const now = Date.now();
    prune(now);
    let row = map.get(name);
    if (!row) {
        row = { ok: 0, err: 0, last: now };
        map.set(name, row);
    }
    if (ok) row.ok += 1;
    else row.err += 1;
    row.last = now;
}

function getCmdStats() {
    prune(Date.now());
    let ok = 0;
    let err = 0;
    const top = [];
    for (const [cmd, v] of map) {
        ok += v.ok;
        err += v.err;
        if (v.err > 0) top.push({ cmd, ok: v.ok, err: v.err });
    }
    top.sort((a, b) => b.err - a.err);
    return {
        windowMin: Math.max(1, Math.round(WINDOW_MS / 60000)),
        ok,
        err,
        topErr: top.slice(0, 8)
    };
}

module.exports = { newRequestId, noteCmd, getCmdStats };
