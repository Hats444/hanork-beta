const { uptime } = require("../utils");
const logger = require("../logger");
const { getStats } = require("../cache");
const { sendMainMenu, sendInteractiveButtons, sendButtonsWithImage } = require("../helpers");
const { previewText, stripAccents, labelValue } = require("../utils/typography");
const { buildSobreMenu, DEV_WA_CHAT, FREE_TELEGRAM, FREE_CATALOG } = require("../utils/productOffer");
const { prefixFromCtx } = require("../utils/configManager");
const os = require("os");

const commands = {};

function safeStats(ctx) {
    try {
        const sid = ctx?.sessionId || ctx?.conn?._sessionId || 'global';
        const s = getStats(sid) || {};
        return {
            messages: Number(s.messages) || 0,
            commands: Number(s.commands) || 0,
            started: s.started || Date.now()
        };
    } catch (_) {
        return { messages: 0, commands: 0, started: Date.now() };
    }
}

function fmtUptimeSec(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return uptime(Date.now() - s * 1000);
}

function formatRuntimeSnapshot(ctx, extra = {}) {
    const mem = process.memoryUsage();
    const rss = Math.round(mem.rss / 1048576);
    const heap = Math.round(mem.heapUsed / 1048576);
    const heapTot = Math.round(mem.heapTotal / 1048576);
    let limit = 1536;
    let pairMax = 1075;
    let pressure = false;
    try {
        const mw = require('../utils/memoryWatch');
        if (typeof mw.rssLimitMb === 'function') limit = mw.rssLimitMb();
        if (typeof mw.rssPairMaxMb === 'function') pairMax = mw.rssPairMaxMb();
        if (typeof mw.isPressure === 'function') pressure = mw.isPressure();
    } catch (_) { /* ignore */ }
    const ramPct = limit ? Math.round((rss / limit) * 100) : 0;
    const st = safeStats(ctx);
    let sessLine = 'n/d';
    try {
        const { getAllSessions } = require('../utils/sessionRegistry');
        const list = typeof getAllSessions === 'function' ? getAllSessions() : [];
        const up = list.filter((s) => String(s.status || '') === 'connected').length;
        sessLine = `${up}/${list.length} no ar`;
    } catch (_) { /* ignore */ }
    let thisWa = 'n/d';
    try {
        if (ctx?.conn?.user) thisWa = 'conectado';
        else if (ctx?.conn) thisWa = 'sem user';
    } catch (_) { /* ignore */ }
    let pending = 0;
    let grade = '';
    try {
        const p = require('../services/healthServer').buildPayload();
        pending = Number(p?.queues?.execPending) || 0;
        grade = String(p?.commercial?.grade || '');
    } catch (_) { /* ignore */ }
    const load = os.loadavg().map((n) => Number(n).toFixed(2)).join(' / ');
    const freeMb = Math.round(os.freemem() / 1048576);
    const totalMb = Math.round(os.totalmem() / 1048576);
    const lines = [];
    if (extra.latencyMs != null) {
        lines.push(labelValue('Latencia', `${extra.latencyMs} ms`));
    }
    lines.push(labelValue('Ligado ha', fmtUptimeSec(process.uptime())));
    lines.push(labelValue('Memoria RSS', `${rss} MB / ${limit} MB (${ramPct}%)`));
    lines.push(labelValue('Heap', `${heap} MB usado · ${heapTot} MB alocado`));
    lines.push(labelValue('RAM do servidor', `${freeMb} MB livre / ${totalMb} MB`));
    lines.push(labelValue('Load 1/5/15', load));
    lines.push(labelValue('WhatsApp', `${thisWa} · sessoes ${sessLine}`));
    lines.push(labelValue('Msgs / cmds', `${st.messages} / ${st.commands}`));
    if (pending) lines.push(labelValue('Fila', `${pending} pendente(s)`));
    if (pressure) lines.push(labelValue('Pressao RAM', `sim (parear bloqueia em ${pairMax} MB)`));
    if (grade) lines.push(labelValue('Saude', grade));
    lines.push(labelValue('Node', process.version));
    lines.push(labelValue('PID', process.pid));
    return lines.join('\n');
}

async function sendRuntimePanel(conn, ctx, title, extra = {}) {
    if (ctx && !ctx.conn) ctx.conn = conn;
    const from = ctx.from || ctx.info?.key?.remoteJid;
    if (!from) return;
    const txt = `${previewText(title)}\n${formatRuntimeSnapshot(ctx, extra)}`;
    await sendButtonsWithImage(
        conn,
        from,
        txt,
        extra.buttons || [
            { id: 'ping', label: 'Ping' },
            { id: 'stats', label: 'Estatisticas' },
            { id: 'menu', label: 'Menu' }
        ],
        'Hanork Bot',
        ctx.info || null,
        'menu.jpg',
        previewText(title),
        stripAccents('Clique abaixo'),
        ctx.telegramUserId
    );
}

async function sendSobre(conn, ctx) {
    const from = ctx.from || ctx.info?.key?.remoteJid;
    if (!from) return;
    const p = prefixFromCtx(ctx) || (ctx.platform === 'telegram' ? '/' : '.');
    const text = buildSobreMenu({ prefix: p, telegramUserId: ctx.telegramUserId });
    await sendButtonsWithImage(
        conn,
        from,
        text,
        [
            { id: 'menu', label: 'Menu' },
            { url: DEV_WA_CHAT, label: 'Abrir o bot' },
            { url: FREE_TELEGRAM, label: 'Telegram' }
        ],
        'Hanork',
        ctx.info || null,
        'menu.jpg',
        previewText('Sobre'),
        stripAccents('Planos e contato'),
        ctx.telegramUserId
    );
}

commands.sobre = {
    useCtx: true,
    description: 'Dono, capacidades, planos e contato para compra',
    usage: 'sobre',
    execute: async (conn, ctx) => sendSobre(conn, ctx)
};
commands.dono = commands.sobre;
commands.comprar = commands.sobre;
commands.planos = commands.sobre;
commands.preco = commands.sobre;
commands.ownerinfo = commands.sobre;

commands.ping = {
    useCtx: true,
    description: "Latencia, memoria, sessoes e saude do processo",
    usage: "ping",
    execute: async (conn, ctx) => {
        if (typeof ctx !== 'object' || ctx === null) {
            console.error('[ping] ctx invalido, tipo:', typeof ctx);
            return;
        }
        const from = ctx.from || ctx.info?.key?.remoteJid;
        if (!from) {
            console.error('[ping] Nao foi possivel obter o chat');
            return;
        }
        const ini = Date.now();
        if (typeof conn.sendPresenceUpdate === 'function') {
            try { await conn.sendPresenceUpdate('available', from); } catch (_) {}
        }
        const latency = Date.now() - ini;
        await sendRuntimePanel(conn, ctx, 'Pong', {
            latencyMs: latency,
            buttons: [
                { id: 'ping', label: 'Repetir Ping' },
                { id: 'stats', label: 'Estatisticas' },
                { id: 'menu', label: 'Menu' }
            ]
        });
    }
};

commands.menu = {
    useCtx: true,
    description: "Exibe o menu principal",
    usage: "menu",
    execute: async (conn, ctx) => {
        if (typeof ctx !== 'object' || ctx === null) {
            console.error('[menu] ctx invalido, tipo:', typeof ctx);
            return;
        }
        const from = ctx.from || ctx.info?.key?.remoteJid;
        if (!from) {
            console.error('[menu] Nao foi possivel obter o chat');
            return;
        }
        const info = ctx.info || null;
        await sendMainMenu(
            conn,
            from,
            info,
            ctx.telegramUserId,
            ctx.sessionId || conn._sessionId,
            ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user')
        );
    }
};

/** Menus de categoria via NL ("menu admin") — NUNCA dispara logs/rr/nuke */
async function sendCategoryMenuCmd(conn, ctx, catId) {
    const from = ctx.from || ctx.info?.key?.remoteJid;
    if (!from) return;
    const { sendCategoryPanel, getCategory, resolveMenuViewerRole } = require('../utils/menuCatalog');
    const cat = getCategory(catId);
    if (!cat) {
        return conn.sendMessage(from, {
            text: stripAccents('Categoria nao encontrada.')
        }, { quoted: ctx.info });
    }
    return sendCategoryPanel(conn, {
        catId,
        chatId: from,
        quoted: ctx.info,
        telegramUserId: ctx.telegramUserId,
        sessionId: ctx.sessionId || conn._sessionId,
        isGroup: !!from?.endsWith?.('@g.us'),
        viewerRole: resolveMenuViewerRole(ctx, ctx.telegramUserId),
        viewerCtx: ctx
    });
}

commands.menu_admin = {
    useCtx: true,
    description: 'Menu Admin / Sessao (lista — nao envia logs)',
    usage: 'menu_admin',
    execute: async (conn, ctx) => sendCategoryMenuCmd(conn, ctx, 'admin')
};

commands.menu_dono = {
    useCtx: true,
    description: 'Tudo que o dono da sessao pode usar',
    usage: 'menu_dono',
    execute: async (conn, ctx) => {
        const { sendRoleMenu } = require('../utils/roleMenus');
        return sendRoleMenu(conn, ctx, 'dono');
    }
};
commands.menudono = commands.menu_dono;

commands.menu_adm = {
    useCtx: true,
    description: 'Tudo que o admin do grupo pode usar',
    usage: 'menu_adm',
    execute: async (conn, ctx) => {
        const { sendRoleMenu } = require('../utils/roleMenus');
        return sendRoleMenu(conn, ctx, 'adm');
    }
};
commands.menuadm = commands.menu_adm;

commands.menu_tools = {
    useCtx: true,
    description: 'Menu Ferramentas',
    usage: 'menu_tools',
    execute: async (conn, ctx) => sendCategoryMenuCmd(conn, ctx, 'tools')
};

// Registra todos menu_* do catalogo (fluxo .menu → .menu_downloads etc.)
try {
    const { MENU_ID_TO_CAT } = require('../utils/menuCatalog');
    for (const [menuId, catId] of Object.entries(MENU_ID_TO_CAT || {})) {
        if (commands[menuId]) continue;
        commands[menuId] = {
            useCtx: true,
            description: `Menu ${catId}`,
            usage: menuId,
            execute: async (conn, ctx) => sendCategoryMenuCmd(conn, ctx, catId)
        };
    }
} catch (_) { /* catalogo ainda nao pronto */ }

commands.stats = {
    useCtx: true,
    description: "Estatisticas do bot (memoria, sessoes, msgs)",
    usage: "stats",
    execute: async (conn, ctx) => {
        if (typeof ctx !== 'object' || ctx === null) {
            console.error('[stats] ctx invalido, tipo:', typeof ctx);
            return;
        }
        const from = ctx.from || ctx.info?.key?.remoteJid;
        if (!from) {
            console.error('[stats] Nao foi possivel obter o chat');
            return;
        }
        await sendRuntimePanel(conn, ctx, 'Estatisticas', {
            buttons: [
                { id: 'stats', label: 'Atualizar' },
                { id: 'ping', label: 'Ping' },
                { id: 'menu', label: 'Menu' }
            ]
        });
    }
};

module.exports = { commands };