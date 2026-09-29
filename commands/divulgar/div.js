const { requireSessionOwner } = require('../../utils/authorization');
// commands/divulgar/div.js
const logger = require("../../logger");
const { sendDivulgacaoButtons: sendButtonsWithImage, sendDivulgacaoMessage } = require("../../utils/divulgacaoReply");
const { sendButtonsWithImage: sendNativeButtons } = require("../../helpers");
const { getConfig, resolveGruposDestino, formatDestinoResumo, isCtaReady, ctaMissing, formatCtaSummary, isTextoReady, isPayReady, isStatusReady, formatTextoSummary, formatPaySummary, formatStatusSummary, getCtaImageBuffer, getCtaStoredBuffer, getTextoMediaBuffer, getStatusMediaBuffer, ctaUrlButtons, applyViewConfig, parseTipoSlot, modoKey, getActiveSlot, setActiveSlot, isDivAdmin, clampSlot } = require("../../utils/divulgacao");
const { isGrupoDestino, normalizeGrupoJid } = require("../../utils/divDestinos");
const { delay } = require("../../utils");
const { withTimeout, DEFAULT_TIMEOUT_MS } = require("../../utils/timeout");
const divJob = require("../../utils/divulgacaoJob");
const { waitGroupGap } = require("../../utils/divulgacaoGroupGap");
const MANUAL_START_DEBOUNCE_MS = 8000;
const lastManualStartAt = new Map();
const BLAST_SEND_OPTS = { _hanorkTrusted: true, skipForward: true };

const DIRECTED_CAP = 40;
const MAX_QTD = 3;
const MIN_DELAY = 400;
const MAX_DELAY = 6000;
const DEFAULT_DELAY = 1000;
const DIRECTED_GAP_MS = 200;
const RATE_BACKOFF_MS = 6000;

function clampQtd(n) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v) || v < 1) return 1;
    return Math.min(MAX_QTD, v);
}

function clampDelay(n, fallback = DEFAULT_DELAY) {
    const v = parseInt(n, 10);
    const base = Number.isFinite(v) && v > 0 ? v : fallback;
    return Math.min(MAX_DELAY, Math.max(MIN_DELAY, base));
}

function capList(list, max) {
    const uniq = [...new Set((list || []).filter(Boolean))];
    return uniq.slice(0, max);
}

async function yieldLoop() {
    await new Promise((r) => setImmediate(r));
}

const commands = {};

function isWaRateOrClosed(err) {
    const m = String(err?.message || err || '');
    return /rate-overlimit|connection closed|timed out|forbidden|item-not-found|not-authorized|backoff/i.test(m);
}

function isWaFatalStop(err) {
    const m = String(err?.message || err || '');
    return /connection closed/i.test(m);
}

function logDivGroupErr(scope, groupId, err) {
    const msg = String(err?.message || err || '');
    if (/forbidden|not-authorized|rate-overlimit|backoff|item-not-found|GROUP_META_/i.test(msg)) {
        logger.logAviso(`div ${scope} ${groupId}: ${msg}`);
    } else {
        logger.logErro("div", `${scope} ${groupId}: ${msg}`);
    }
}

// ========== FUNÇÃO CENTRAL PARA OBTER MEMBROS ELEGÍVEIS ==========
function collectBotIds(conn) {
    const ids = new Set();
    const add = (jid) => {
        if (!jid || typeof jid !== 'string') return;
        ids.add(jid);
        const user = jid.split('@')[0].split(':')[0];
        if (user) {
            ids.add(`${user}@s.whatsapp.net`);
            ids.add(`${user}@lid`);
        }
    };
    const u = conn?.user;
    if (u) {
        add(u.id);
        add(u.lid);
        add(u.jid);
        add(u.phoneNumber);
    }
    return ids;
}

function isGroupAdmin(p) {
    if (!p || typeof p !== 'object') return false;
    const a = p.admin;
    if (a === true || a === 1) return true;
    const s = String(a || '').toLowerCase();
    if (!s || s === 'member' || s === 'participant' || s === 'null' || s === 'false' || s === '0') return false;
    if (s === 'admin' || s === 'superadmin' || s === 'owner' || s === 'super_admin') return true;
    return !!(p.isAdmin || p.isSuperAdmin);
}

function participantIds(p) {
    return [p?.id, p?.jid, p?.lid, p?.phoneNumber].filter(Boolean).map(String);
}

function isBotParticipant(p, botIds) {
    return participantIds(p).some((id) => {
        if (botIds.has(id)) return true;
        const user = id.split('@')[0].split(':')[0];
        return !!(user && (botIds.has(`${user}@s.whatsapp.net`) || botIds.has(`${user}@lid`)));
    });
}

function toPnJid(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    if (s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us')) return s;
    if (s.includes('@lid') || s.endsWith('@g.us') || s.endsWith('@newsletter')) return '';
    const d = s.replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 15) return `${d}@s.whatsapp.net`;
    return '';
}

function memberRelayJid(p) {
    const id = String(p?.id || p?.jid || '').trim();
    if (id && !/@g\.us$|@newsletter$/.test(id)) return id;
    return toPnJid(p?.phoneNumber) || '';
}

function memberMentionJid(p, conn) {
    const pn = toPnJid(p?.phoneNumber) || toPnJid(p?.jid);
    if (pn) return pn;
    const id = String(p?.id || p?.jid || '').trim();
    if (id.endsWith('@s.whatsapp.net') || id.endsWith('@c.us')) return id;
    if (id.includes('@lid')) {
        try {
            const { resolvePeerJid } = require('../../utils');
            const resolved = resolvePeerJid(id, {
                senderPn: p?.phoneNumber,
                remoteJidAlt: p?.phoneNumber,
                participantPn: p?.phoneNumber
            }, conn);
            const asPn = toPnJid(resolved);
            if (asPn) return asPn;
        } catch (_) { /* mapping opcional */ }
    }
    return id && !/@g\.us$|@newsletter$/.test(id) ? id : '';
}

async function obterMembrosElegiveis(conn, groupId) {
    return withTimeout(async () => {
        const { peekGroupMetadata, getCachedGroupMetadata } = require('../../utils/groupMetaCache');
        let meta = peekGroupMetadata(groupId);
        let parts = Array.isArray(meta?.participants) ? meta.participants : [];
        let adminN = parts.filter(isGroupAdmin).length;
        // Peek do warm (groupFetchAll) as vezes vem sem flag admin → mencionava ADM.
        if (!parts.length || adminN === 0) {
            try {
                meta = await getCachedGroupMetadata(conn, groupId, { force: true });
            } catch (_) {
                try { meta = await getCachedGroupMetadata(conn, groupId); } catch (_) { /* keep peek */ }
            }
            parts = Array.isArray(meta?.participants) ? meta.participants : [];
            adminN = parts.filter(isGroupAdmin).length;
        }
        if (!meta) return [];
        if (adminN === 0 && parts.length > 1) {
            logger.logAviso(`[DIV] meta sem admins — mencao pulada (nao marco ADM) total=${parts.length}`);
            return [];
        }
        const botIds = collectBotIds(conn);
        const out = [];
        for (const p of parts) {
            if (!p || isGroupAdmin(p) || isBotParticipant(p, botIds)) continue;
            const relay = memberRelayJid(p);
            const mention = memberMentionJid(p, conn) || relay;
            if (!relay && !mention) continue;
            out.push({ mention, relay: relay || mention });
        }
        const pnN = out.filter((m) => /@(s\.whatsapp\.net|c\.us)$/.test(m.mention)).length;
        logger.logInfo(`[DIV] elegiveis group n=${out.length} mentionPn=${pnN} adminsSkip=${adminN} total=${parts.length}`);
        return out;
    }, 10000, `obterMembrosElegiveis(${groupId})`).catch(e => {
        const msg = String(e && e.message ? e.message : e);
        if (/forbidden|not-authorized|rate-overlimit|backoff|GROUP_META_|Timeout: groupMetadata|iq-cap/i.test(msg)) {
            logger.logAviso(`obterMembrosElegiveis ${groupId}: ${msg}`);
        } else {
            logger.logErro("obterMembrosElegiveis", `Erro ao obter membros do grupo ${groupId}: ${msg}`);
        }
        const err = e instanceof Error ? e : new Error(msg);
        throw err;
    });
}

// ========== COMANDOS PRINCIPAIS ==========
commands.div = {
    useCtx: true,
    description: "Envia divulgacao de texto (varios links + mencoes)",
    usage: "div [quantidade] [delay]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        const args = ctx.args || [];
        const qtd = clampQtd(args[0] || config.quantidade || 1);
        const delayMsg = clampDelay(args[1] || config.delayMsg || DEFAULT_DELAY);
        await mostrarConfirmacao(conn, ctx, 'normal', qtd, delayMsg);
    }
};

commands.divbotao = {
    useCtx: true,
    description: "Envia divulgacao CTA (texto + botao + link + mencoes)",
    usage: "divbotao [quantidade] [delay]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        const args = ctx.args || [];
        const qtd = clampQtd(args[0] || config.quantidade || 1);
        const delayMsg = clampDelay(args[1] || config.delayMsg || DEFAULT_DELAY);
        await mostrarConfirmacao(conn, ctx, 'cta', qtd, delayMsg);
    }
};
commands.divctaenvio = commands.divbotao;
commands.divcta2 = {
    useCtx: true,
    description: "Confirma disparo do CTA #2 (ADM, independente do CTA 1)",
    usage: "divcta2 [quantidade] [delay]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        if (!isDivAdmin(ctx.telegramUserId)) {
            return sendDivulgacaoMessage(conn, ctx, { text: 'CTA #2 so para ADM.' });
        }
        setActiveSlot(ctx.telegramUserId, 'cta', 2);
        const config = getConfig(ctx.telegramUserId);
        const args = ctx.args || [];
        const qtd = clampQtd(args[0] || config.quantidade || 1);
        const delayMsg = clampDelay(args[1] || config.delayMsg || DEFAULT_DELAY);
        await mostrarConfirmacao(conn, ctx, 'cta', qtd, delayMsg, 2);
    }
};
commands.divstatus2 = {
    useCtx: true,
    description: "Confirma disparo do Status #2 (ADM, independente do Status 1)",
    usage: "divstatus2 [quantidade] [delay]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        if (!isDivAdmin(ctx.telegramUserId)) {
            return sendDivulgacaoMessage(conn, ctx, { text: 'Status #2 so para ADM.' });
        }
        setActiveSlot(ctx.telegramUserId, 'status', 2);
        const config = getConfig(ctx.telegramUserId);
        const args = ctx.args || [];
        const qtd = clampQtd(args[0] || config.quantidade || 1);
        const delayMsg = clampDelay(args[1] || config.delayMsg || DEFAULT_DELAY);
        await mostrarConfirmacao(conn, ctx, 'status', qtd, delayMsg, 2);
    }
};

commands.divpay = {
    useCtx: true,
    description: "Envia divulgacao de pagamento (sem midia)",
    usage: "divpay [quantidade] [delay]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        const args = ctx.args || [];
        const qtd = clampQtd(args[0] || config.quantidade || 1);
        const delayMsg = clampDelay(args[1] || config.delayMsg || DEFAULT_DELAY);
        await mostrarConfirmacao(conn, ctx, 'pay', qtd, delayMsg);
    }
};

commands.divmark = {
    useCtx: true,
    description: "Alias de div (texto com mencoes invisivel)",
    usage: "divmark [quantidade] [delay]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        const args = ctx.args || [];
        const qtd = clampQtd(args[0] || config.quantidade || 1);
        const delayMsg = clampDelay(args[1] || config.delayMsg || DEFAULT_DELAY);
        await mostrarConfirmacao(conn, ctx, 'normal', qtd, delayMsg);
    }
};

commands.divstatus = {
    useCtx: true,
    description: "Envia divulgacao como Status Close Friends (com midia se configurada)",
    usage: "divstatus [quantidade] [delay]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        const args = ctx.args || [];
        const qtd = clampQtd(args[0] || config.quantidade || 1);
        const delayMsg = clampDelay(args[1] || config.delayMsg || DEFAULT_DELAY);
        await mostrarConfirmacao(conn, ctx, 'status', qtd, delayMsg);
    }
};

commands.divcf = {
    useCtx: true,
    description: "Envia divulgacao como Close Friends (modo exclusivo)",
    usage: "divcf [quantidade] [delay]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        const args = ctx.args || [];
        const qtd = clampQtd(args[0] || config.quantidade || 1);
        const delayMsg = clampDelay(args[1] || config.delayMsg || DEFAULT_DELAY);
        await mostrarConfirmacao(conn, ctx, 'closefriends', qtd, delayMsg);
    }
};

commands.divfull = {
    useCtx: true,
    description: "Envia divulgacao completa (normal + Status VIP + pagamento)",
    usage: "divfull [quantidade] [delay]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        const args = ctx.args || [];
        const qtd = clampQtd(args[0] || config.quantidade || 1);
        const delayMsg = clampDelay(args[1] || config.delayMsg || DEFAULT_DELAY);
        const modo = config.modoPrincipal === 'cta' ? 'cta' : config.modoPrincipal === 'pay' ? 'pay' : 'normal';
        await mostrarConfirmacao(conn, ctx, modo, qtd, delayMsg);
    }
};

// ========== FUNÇÃO DE CONFIRMAÇÃO ==========
async function mostrarConfirmacao(conn, ctx, tipo, qtd, delayMsg, slotOpt) {
    const from = ctx.from;
    const info = ctx.info;
    const rawConfig = getConfig(ctx.telegramUserId);
    const destinos = await resolveGruposDestino(conn, ctx.telegramUserId);
    const data = { grupos: destinos };
    const track = (tipo === 'closefriends' || tipo === 'status') ? 'status'
      : (tipo === 'full' ? (rawConfig.modoPrincipal === 'cta' ? 'cta' : rawConfig.modoPrincipal === 'pay' ? 'pay' : 'normal') : tipo);
    let slot = slotOpt != null ? clampSlot(slotOpt) : 1;
    if (slotOpt == null && isDivAdmin(ctx.telegramUserId) && track && track !== 'full') {
      slot = getActiveSlot(rawConfig, track);
    }
    const config = applyViewConfig(rawConfig, tipo, slot);
    const slotTag = slot > 1 ? ` · slot ${slot}` : '';

    const precisaCta = tipo === 'cta';
    if (precisaCta && !isCtaReady(config)) {
        const miss = ctaMissing(config);
        return sendButtonsWithImage(
            conn,
            from,
            "CTA INCOMPLETO\n\n" +
            `Falta: ${miss.join(', ')}\n\n` +
            "CTA e separado do texto normal. Configure so o cartao (texto + botao + link).",
            [
                { id: "div_cta_wizard", label: "Configurar CTA" },
                { id: "div_config", label: "Configurar" },
                { id: "div_menu", label: "Voltar" }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            "CTA",
            "Clique abaixo",
            ctx.telegramUserId
        );
    }

    if (tipo === 'normal' && !isTextoReady(config)) {
        return sendButtonsWithImage(
            conn,
            from,
            "TEXTO NAO CONFIGURADO\n\nUse: msgdivul <texto>\nPode colar varios links. Isso NAO mexe no CTA nem no status.",
            [
                { id: "div_config_texto", label: "Configurar Texto" },
                { id: "div_config", label: "Configurar" },
                { id: "div_menu", label: "Voltar" }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            "ERRO",
            "Clique abaixo",
            ctx.telegramUserId
        );
    }

    if ((tipo === 'status' || tipo === 'closefriends') && !isStatusReady(config)) {
        return sendButtonsWithImage(
            conn,
            from,
            "STATUS NAO CONFIGURADO\n\nUse: msgdivulstatus <texto> e/ou foto status.\nIsso NAO usa o texto/midia normal.",
            [
                { id: "div_config_status", label: "Configurar Status" },
                { id: "div_config", label: "Configurar" },
                { id: "div_menu", label: "Voltar" }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            "ERRO",
            "Clique abaixo",
            ctx.telegramUserId
        );
    }

    if ((tipo === 'pay' || tipo === 'full') && !isPayReady(config)) {
        return sendButtonsWithImage(
            conn,
            from,
            "TEXTO DE PAGAMENTO NAO CONFIGURADO\n\nUse: msgdivulpay <texto>\nSeparado do texto normal, CTA e status.",
            [
                { id: "div_config_pay", label: "Texto pagamento" },
                { id: "div_config", label: "Configurar" },
                { id: "div_menu", label: "Voltar" }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            "ERRO",
            "Clique abaixo",
            ctx.telegramUserId
        );
    }

    if (!data.grupos.length) {
        return sendButtonsWithImage(
            conn,
            from,
            "SEM GRUPOS NA LISTA\n\n" +
            "A divulgacao vai so para a lista oficial:\n" +
            "- addgrupo no grupo, ou\n" +
            "- o bot entra pelos links da fila e a lista atualiza sozinha.\n\n" +
            "Se a lista estiver vazia no disparo, usa os grupos em que o chip esta.\n" +
            "Canal oficial nao recebe divulgacao.",
            [
                { id: "gm_home", label: "Gerenciar grupos" },
                { id: "div_config", label: "Configurar" }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            "ADICIONE GRUPOS",
            "Clique abaixo",
            ctx.telegramUserId
        );
    }

    const modoTexto = formatDestinoResumo(data.grupos.length);
    const tipoMap = {
        normal: 'Texto',
        cta: 'CTA',
        pay: 'Pagamento',
        status: 'Status de grupo',
        closefriends: 'Status de grupo (close friends)',
        full: 'Completa'
    };
    const tipoTexto = (tipoMap[tipo] || tipo) + slotTag;
    const temMidia = isStatusBlastTipo(tipo)
        ? (config.statusMidiaFile ? 'Sim' : 'Nao')
        : (config.midia ? 'Sim' : 'Nao');
    let extra = '';
    if (tipo === 'cta') extra = `\n${formatCtaSummary(config)}\n`;
    else if (tipo === 'pay' || tipo === 'full') extra = `\n${formatPaySummary(config)}\n`;
    else if (isStatusBlastTipo(tipo)) extra = `\n${formatStatusSummary(config)}\n`;
    else extra = `\n${formatTextoSummary(config)}\n`;
    const regras = isStatusBlastTipo(tipo)
        ? `Status normal na bandeja de cada grupo (visivel pra todos).\nAviso no comeco e no fim.`
        : `Mencoes: membros (admins de fora) em texto, CTA e pagamento.\n` +
          `Pagamento: 1 cobranca nativa no grupo, so membro recebe.\n` +
          `Aviso no comeco e no fim.`;

    await sendButtonsWithImage(
        conn,
        from,
        `CONFIRMAR DIVULGACAO\n\n` +
        `Tipo: ${tipoTexto}\n` +
        `Destino: ${modoTexto}\n` +
        `Quantidade: ${qtd}x\n` +
        `Delay: ${delayMsg}ms\n` +
        `Midia deste tipo: ${temMidia}\n` +
        `${regras}` +
        extra,
        [
            { id: `div_confirm_iniciar_${tipo}_${qtd}_${delayMsg}_s${slot}`, label: "Confirmar" },
            ...(isDivAdmin(ctx.telegramUserId) && tipo === 'cta'
                ? [{ id: `div_confirm_iniciar_cta_${qtd}_${delayMsg}_s2`, label: "Confirmar CTA #2" }]
                : []),
            ...(isDivAdmin(ctx.telegramUserId) && (tipo === 'status' || tipo === 'closefriends')
                ? [{ id: `div_confirm_iniciar_status_${qtd}_${delayMsg}_s2`, label: "Confirmar Status #2" }]
                : []),
            { id: "div_config", label: "Configurar" },
            { id: "gm_home", label: "Grupos" },
            { id: "div_menu", label: "Cancelar" }
        ],
        "Hanork Bot",
        info,
        "menu.jpg",
        "CONFIRMAR",
        "Clique abaixo",
        ctx.telegramUserId
    );
}

const TIPO_LABEL = {
    normal: 'Texto',
    cta: 'CTA',
    pay: 'Pagamento',
    status: 'Status de grupo',
    closefriends: 'Status de grupo (close friends)',
    full: 'Completa'
};

function isStatusBlastTipo(tipo) {
    return tipo === 'status' || tipo === 'closefriends';
}

function ownerPvJid(conn, from, info, telegramUserId) {
    try {
        const { resolveOwnerPrivateJid } = require('../../utils/divulgacaoReply');
        return resolveOwnerPrivateJid({ from, info, telegramUserId }, conn) || '';
    } catch (_) {
        return '';
    }
}

async function sendDivNotice(conn, from, info, telegramUserId, text, header, extraButtons = []) {
    const buttons = [
        { id: "div_stop", label: "Parar" },
        ...extraButtons,
        { id: "div_menu", label: "Menu div" }
    ];
    const tryChat = async (jid, quoted) => {
        await sendButtonsWithImage(
            conn,
            jid,
            text,
            buttons,
            "Hanork Bot",
            quoted,
            "menu.jpg",
            header,
            "Clique abaixo",
            telegramUserId
        );
    };
    const fromGroup = String(from || '').endsWith('@g.us');
    const fromCanal = String(from || '').endsWith('@newsletter');
    const pv = ownerPvJid(conn, from, info, telegramUserId);
    if (fromCanal) {
        const dest = pv || '';
        if (!dest) return;
        try {
            await tryChat(dest, null);
        } catch (ePv) {
            logger.logAviso(`div notice canal→PV: ${ePv.message}`);
        }
        return;
    }
    // Grupo de anuncio/so-admin: o comando some. Confirma no PV sempre.
    if (fromGroup && pv && String(pv) !== String(from)) {
        try {
            await tryChat(pv, null);
        } catch (ePv) {
            logger.logAviso(`div notice PV: ${ePv.message}`);
            try {
                await conn.sendMessage(pv, { text: `*${header}*\n\n${text}` });
            } catch (_) { /* ignore */ }
        }
    }
    try {
        await tryChat(from, info);
    } catch (e) {
        logger.logAviso(`div notice: ${e.message}`);
        if (!fromGroup && pv && String(pv) !== String(from)) {
            try {
                await tryChat(pv, null);
            } catch (e2) {
                logger.logAviso(`div notice PV: ${e2.message}`);
            }
        }
    }
}

async function executarDivulgacao(conn, {
    jobKey, tipo, qtd, delayMsg, grupos, config, sessionId, from, info, telegramUserId
}) {
    if (tipo === 'full') {
        tipo = config?.modoPrincipal === 'cta' ? 'cta' : config?.modoPrincipal === 'pay' ? 'pay' : 'normal';
    }
    const delayGrupo = clampDelay(config.delayGrupo || 800, 800);
    grupos = (grupos || []).map(normalizeGrupoJid).filter(isGrupoDestino);
    let totalMembros = 0;
    const membrosPorGrupo = new Map();
    const prepErr = new Map();
    let abortDiv = false;
    let abortedReason = null;
    let totalEnviadas = 0;
    let totalErros = 0;
    let statusEnviados = 0;
    let progress = null;
    const failedGroups = [];

    const stopped = () => abortDiv || divJob.shouldAbort(jobKey);

    try {
        const { createWhatsAppStatus } = require('../../utils/statusProgress');
        const jidRaw = from || config?.lastUiJid;
        const jid = String(jidRaw || '').endsWith('@newsletter')
            ? (ownerPvJid(conn, jidRaw, info, telegramUserId) || '')
            : jidRaw;
        if (jid) {
            progress = await createWhatsAppStatus(conn, jid, info, 'DIVULGACAO');
            await progress.setRows([
                ['Estado', 'iniciando'],
                ['Tipo', tipo],
                ['Grupos', `0/${grupos.length}`]
            ]);
        }
    } catch (_) { /* progresso e opcional */ }

    try {
        for (let i = 0; i < grupos.length; i++) {
            if (stopped()) {
                abortDiv = true;
                abortedReason = abortedReason || 'parada pelo dono';
                break;
            }
            const groupId = grupos[i];
            if (!isGrupoDestino(groupId)) continue;
            let lastGroupErr = '';
            try {
                const membros = await obterMembrosElegiveis(conn, groupId);
                membrosPorGrupo.set(groupId, membros);
                if (membros && membros.length > 0) {
                    totalMembros += membros.length;
                    const pnN = mentionJids(membros).filter((j) => /@(s\.whatsapp\.net|c\.us)$/.test(j)).length;
                    logger.logInfo(`[DIV] prep n=${membros.length} mentionPn=${pnN}`);
                }
            } catch (e) {
                lastGroupErr = e.message || String(e);
                membrosPorGrupo.set(groupId, null);
                prepErr.set(groupId, lastGroupErr);
                logger.logErro(`[DIV] prep ${groupId}: ${e.message}`);
                if (isWaFatalStop(e)) {
                    abortDiv = true;
                    abortedReason = 'Connection Closed';
                    break;
                }
                if (isWaRateOrClosed(e)) await delay(RATE_BACKOFF_MS);
            }
            if (i + 1 < grupos.length) {
                await delay(150);
                await yieldLoop();
            }
        }

        if (!stopped()) {
            for (let i = 0; i < grupos.length; i++) {
                if (stopped()) {
                    abortDiv = true;
                    abortedReason = abortedReason || 'parada pelo dono';
                    break;
                }
                const groupId = grupos[i];
                if (!isGrupoDestino(groupId)) continue;
                const stored = membrosPorGrupo.get(groupId);
                let groupEnviadas = 0;
                let groupErros = 0;
                let groupStatus = 0;
                let lastGroupErr = prepErr.get(groupId) || '';

                try {
                    const { inspectGroupHealth } = require('../../utils/groupFailure');
                    const health = inspectGroupHealth(conn, groupId);
                    if (health.kind === 'dead') {
                        lastGroupErr = health.reason;
                        const auto = require('../../utils/divulgacaoAuto');
                        auto.noteGroupAttempt(telegramUserId, groupId, tipo, {
                            sent: false,
                            fail: true,
                            reason: health.reason,
                            context: { kind: health.reason }
                        });
                        failedGroups.push(`${String(groupId).replace(/@g\.us$/i, '').slice(-8)} ${health.reason}`);
                        continue;
                    }
                } catch (_) { /* inspect opcional */ }

                if (stored == null) {
                    if (!lastGroupErr) lastGroupErr = 'meta_fail';
                    groupErros = 1;
                    try {
                        const auto = require('../../utils/divulgacaoAuto');
                        auto.noteGroupAttempt(telegramUserId, groupId, tipo, {
                            sent: false,
                            fail: true,
                            reason: lastGroupErr
                        });
                    } catch (_) { /* persistencia opcional */ }
                    failedGroups.push(`${String(groupId).replace(/@g\.us$/i, '').slice(-8)} ${String(lastGroupErr).slice(0, 80)}`);
                    continue;
                }
                const membros = stored;

                try {
                    await waitGroupGap(groupId);
                    if (isStatusBlastTipo(tipo)) {
                        for (let j = 0; j < qtd; j++) {
                            if (stopped()) break;
                            try {
                                const st = await enviarStatusVIP(conn, groupId, config, membros, {
                                    closeFriends: tipo === 'closefriends'
                                });
                                groupStatus += st.sent || 0;
                                groupErros += st.errors || 0;
                                if (j + 1 < qtd) {
                                    await delay(delayMsg);
                                    await yieldLoop();
                                }
                            } catch (e) {
                                lastGroupErr = e.message || String(e);
                                logDivGroupErr('status-gp', groupId, e);
                                groupErros++;
                                if (isWaFatalStop(e)) {
                                    abortDiv = true;
                                    abortedReason = 'Connection Closed';
                                    break;
                                }
                                if (isWaRateOrClosed(e)) {
                                    if (/forbidden|not-authorized/i.test(String(e.message || ''))) break;
                                    await delay(Math.max(delayMsg, RATE_BACKOFF_MS));
                                }
                            }
                        }
                    } else if (tipo === 'normal' || tipo === 'cta' || tipo === 'pay' || tipo === 'full') {
                        for (let j = 0; j < qtd; j++) {
                            if (stopped()) break;
                            try {
                                if (tipo === 'pay' || tipo === 'full') {
                                    const pay = await enviarPagamento(conn, groupId, config, membros);
                                    groupEnviadas += pay.sent || 0;
                                    groupErros += pay.errors || 0;
                                } else if (tipo === 'cta') {
                                    await enviarMensagemCta(conn, groupId, config, membros);
                                    groupEnviadas++;
                                } else {
                                    await enviarMensagemTexto(conn, groupId, config, membros);
                                    groupEnviadas++;
                                }
                                if (j + 1 < qtd) {
                                    await delay(delayMsg);
                                    await yieldLoop();
                                }
                            } catch (e) {
                                lastGroupErr = e.message || String(e);
                                logDivGroupErr('principal', groupId, e);
                                groupErros++;
                                if (isWaFatalStop(e)) {
                                    abortDiv = true;
                                    abortedReason = 'Connection Closed';
                                    break;
                                }
                                if (isWaRateOrClosed(e)) {
                                    if (/forbidden|not-authorized/i.test(String(e.message || ''))) break;
                                    await delay(Math.max(delayMsg, RATE_BACKOFF_MS));
                                }
                            }
                        }
                    }
                } catch (e) {
                    lastGroupErr = e.message || String(e);
                    logger.logErro("div", `Erro no grupo ${groupId}: ${e.message}`);
                    groupErros++;
                    if (isWaFatalStop(e)) {
                        abortDiv = true;
                        abortedReason = 'Connection Closed';
                    }
                }

                totalEnviadas += groupEnviadas;
                totalErros += groupErros;
                statusEnviados += groupStatus;
                divJob.markProgress(jobKey, i + 1);
                try {
                    const auto = require('../../utils/divulgacaoAuto');
                    const sent = isStatusBlastTipo(tipo) ? groupStatus > 0 : groupEnviadas > 0;
                    auto.noteGroupAttempt(telegramUserId, groupId, tipo, {
                      sent,
                      fail: !sent && groupErros > 0,
                      reason: lastGroupErr
                    });
                } catch (_) { /* persistencia opcional */ }
                logger.logInfo(`[DIV] grupo ${i + 1}/${grupos.length} ok pub=${groupEnviadas} st=${groupStatus} err=${groupErros}`);
                if (groupErros > 0 && groupEnviadas === 0 && groupStatus === 0) {
                    const why = /forbidden|not-authorized/i.test(String(lastGroupErr || ''))
                        ? 'sem permissao de enviar (so admin / anuncio)'
                        : String(lastGroupErr || 'falhou').slice(0, 80);
                    failedGroups.push(`${String(groupId).replace(/@g\.us$/i, '').slice(-8)} ${why}`);
                    logger.logAviso(`[DIV] skip permanente neste ciclo ${groupId}: ${why}`);
                }
                try {
                    const m = require('../../utils/opsMetrics');
                    if (groupEnviadas > 0) m.bump('divOk', groupEnviadas);
                    if (groupErros > 0) m.bump('divFail', groupErros);
                    m.noteDivGroupResult(telegramUserId, {
                      ok: groupEnviadas > 0 || groupStatus > 0,
                      fail: groupErros > 0 && groupEnviadas === 0 && groupStatus === 0,
                      reason: lastGroupErr
                    });
                } catch (_) { /* ignore */ }
                try {
                    await progress?.setRows([
                        ['Estado', stopped() ? 'parando' : 'enviando'],
                        ['Tipo', tipo],
                        ['Grupo', `${i + 1}/${grupos.length}`],
                        ['Status GP', String(statusEnviados)],
                        ['Erros', String(totalErros)]
                    ]);
                } catch (_) { /* ignore */ }

                if (!stopped() && i + 1 < grupos.length) {
                    await delay(delayGrupo);
                    await yieldLoop();
                }
            }
        }
    } catch (e) {
        abortDiv = true;
        abortedReason = String(e.message || e).slice(0, 80);
        logger.logErro('div job', abortedReason);
    }

    if ((abortDiv || divJob.shouldAbort(jobKey)) && !abortedReason) {
        abortDiv = true;
        abortedReason = 'parada pelo dono';
    }
    const endedPartial = abortDiv || divJob.shouldAbort(jobKey);
    divJob.finish(jobKey);

    const tipoTexto = TIPO_LABEL[tipo] || tipo;
    let mensagemResultado = `*DIVULGACAO ${endedPartial ? 'INTERROMPIDA' : 'CONCLUIDA'}*\n\n` +
        `Tipo: ${tipoTexto}\n` +
        `Grupos: ${grupos.length}\n` +
        `Membros (lista): ${totalMembros}\n`;
    if (abortedReason) {
        mensagemResultado += `Motivo: ${abortedReason}\n`;
    }
    if (isStatusBlastTipo(tipo)) {
        mensagemResultado += `Status de grupo (bandeja): ${statusEnviados}\n`;
    } else {
        mensagemResultado += `Msgs publicas: ${totalEnviadas}\n`;
    }
    mensagemResultado += `Erros: ${totalErros}\n` +
        `Qtd: ${qtd}x`;
    if (failedGroups.length) {
        mensagemResultado += `\n\nNao postou (${failedGroups.length}):\n` +
            failedGroups.slice(0, 10).join('\n') +
            (failedGroups.length > 10 ? `\n+${failedGroups.length - 10}` : '') +
            `\nColoca o bot como admin nesses grupos (anuncio/so-admin).`;
    }
    if (isStatusBlastTipo(tipo)) {
        mensagemResultado += `\nOlhe a bandeja de Status de cada grupo.`;
    }

    try {
        if (progress) await progress.finish(mensagemResultado);
        else {
            await sendDivNotice(conn, from, info, telegramUserId, mensagemResultado, endedPartial ? 'PARCIAL' : 'FIM', [
                { id: "div_iniciar", label: "Repetir" },
                { id: "div_config", label: "Configurar" }
            ]);
        }
    } catch (_) {
        await sendDivNotice(conn, from, info, telegramUserId, mensagemResultado, endedPartial ? 'PARCIAL' : 'FIM', [
            { id: "div_iniciar", label: "Repetir" },
            { id: "div_config", label: "Configurar" }
        ]);
    }
}

commands.divconfirmar = {
    useCtx: true,
    description: "Confirma e inicia a divulgacao",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;

        const parts = ctx.id?.replace("div_confirm_iniciar_", "").split("_") || [];
        const tipo = parts[0] || 'normal';
        const qtd = clampQtd(parts[1] || 1);
        const delayMsg = clampDelay(parts[2] || DEFAULT_DELAY);
        let slot = 1;
        const sPart = parts.find((p) => /^s\d+$/i.test(String(p || '')));
        if (sPart) slot = clampSlot(String(sPart).slice(1));

        const from = ctx.from;
        const info = ctx.info;
        const rawConfig = getConfig(ctx.telegramUserId);
        const config = applyViewConfig(rawConfig, tipo, slot);
        const sessionId = ctx.sessionId;
        const tipoKey = modoKey(tipo, slot);
        const jobKey = divJob.jobKey(ctx.telegramUserId, sessionId, tipoKey);

        if (tipo === 'cta' && !isCtaReady(config)) {
            return sendButtonsWithImage(
                conn, from,
                "CTA INCOMPLETO\n\nConfigure texto, botao e link do CTA (nao usa o texto normal).",
                [{ id: "div_cta_wizard", label: "Configurar CTA" }, { id: "div_config", label: "Configurar" }],
                "Hanork Bot", info, "menu.jpg", "CTA", "Clique abaixo", ctx.telegramUserId
            );
        }
        if (tipo === 'normal' && !isTextoReady(config)) {
            return sendButtonsWithImage(
                conn, from,
                "TEXTO NAO CONFIGURADO\n\nUse msgdivul. Nao usa o texto do CTA nem do status.",
                [{ id: "div_config_texto", label: "Configurar Texto" }, { id: "div_config", label: "Configurar" }],
                "Hanork Bot", info, "menu.jpg", "TEXTO", "Clique abaixo", ctx.telegramUserId
            );
        }
        if ((tipo === 'status' || tipo === 'closefriends') && !isStatusReady(config)) {
            return sendButtonsWithImage(
                conn, from,
                "STATUS NAO CONFIGURADO\n\nUse msgdivulstatus e/ou foto status. Nao usa o texto normal.",
                [{ id: "div_config_status", label: "Configurar Status" }, { id: "div_config", label: "Configurar" }],
                "Hanork Bot", info, "menu.jpg", "STATUS", "Clique abaixo", ctx.telegramUserId
            );
        }
        if ((tipo === 'pay' || tipo === 'full') && !isPayReady(config)) {
            return sendButtonsWithImage(
                conn, from,
                "TEXTO DE PAGAMENTO NAO CONFIGURADO\n\nUse msgdivulpay.",
                [{ id: "div_config_pay", label: "Texto pagamento" }, { id: "div_config", label: "Configurar" }],
                "Hanork Bot", info, "menu.jpg", "PAGAMENTO", "Clique abaixo", ctx.telegramUserId
            );
        }

        let grupos = await resolveGruposDestino(conn, ctx.telegramUserId);
        if (!grupos.length) {
            return sendDivulgacaoMessage(conn, ctx, {
                text: 'Nenhum grupo na lista. Use addgrupo ou deixe o bot entrar pelos convites da fila.'
            });
        }

        if (divJob.isRunning(jobKey)) {
            const cur = divJob.getJob(jobKey);
            return sendDivulgacaoMessage(conn, ctx, {
                text: `Ja tem uma divulgacao DESTE TIPO rodando (${cur?.tipo || tipo} · ${cur?.doneGrupos || 0}/${cur?.grupos || '?'} grupos).\nOutros tipos continuam livres. Use Parar pra abortar este.`
            });
        }

        const result = await startDivulgacaoFromConfig(conn, {
            telegramUserId: ctx.telegramUserId,
            sessionId,
            tipo,
            slot,
            qtd,
            delayMsg,
            from,
            info,
            source: 'manual'
        });
        if (!result.ok && result.reason === 'debounce') {
            return sendDivNotice(
                conn,
                from,
                info,
                ctx.telegramUserId,
                'Ja disparou agora. Espera uns segundos.\nSe este grupo bloqueia o bot, a confirmacao foi pro teu PV.',
                'DIV'
            );
        }
        if (!result.ok && result.reason === 'running') {
            const cur = result.job || divJob.getJob(jobKey);
            return sendDivulgacaoMessage(conn, ctx, {
                text: `Ja tem uma divulgacao DESTE TIPO rodando (${cur?.tipo || tipo} · ${cur?.doneGrupos || 0}/${cur?.grupos || '?'} grupos).\nOutros tipos continuam livres. Use Parar pra abortar este.`
            });
        }
        if (!result.ok && result.message) {
            return sendDivulgacaoMessage(conn, ctx, { text: result.message });
        }
    }
};

async function startDivulgacaoFromConfig(conn, opts = {}) {
    const telegramUserId = opts.telegramUserId;
    const sessionId = opts.sessionId || conn?._sessionId;
    if (!telegramUserId) {
        return { ok: false, reason: 'no-owner', message: 'Sessao sem dono — divulgacao abortada.' };
    }
    const rawConfig = getConfig(telegramUserId);
    try {
        const { assertSessionOwnsDivPayload } = require('../../utils/divulgacao');
        assertSessionOwnsDivPayload(telegramUserId, rawConfig, conn);
    } catch (e) {
        logger.logErro(`[DIV] incidente isolamento: ${e.code || e.message} uid=${telegramUserId} conn=${conn?._telegramUserId || '-'}`);
        return { ok: false, reason: 'owner-mismatch', message: 'Conteudo nao pertence a esta sessao. Envio abortado.' };
    }
    try {
        const { hydrateAdminAffiliate } = require('../../utils/divulgacaoAdminDefaults');
        if (typeof hydrateAdminAffiliate === 'function') {
            await hydrateAdminAffiliate(rawConfig, telegramUserId);
        }
    } catch (e) {
        logger.logAviso(`[DIV] template render: ${String(e.message || e).slice(0, 120)}`);
    }
    const parsed = parseTipoSlot(opts.tipo || rawConfig.modoPrincipal || 'normal');
    const slot = opts.slot != null ? Number(opts.slot) : parsed.slot;
    const tipo = parsed.tipo;
    const tipoKey = modoKey(tipo, slot);
    const config = applyViewConfig(rawConfig, tipo, slot);
    const qtd = clampQtd(opts.qtd || config.quantidade || 1);
    const delayMsg = clampDelay(opts.delayMsg || config.delayMsg || DEFAULT_DELAY);
    const from = opts.from || config.lastUiJid || null;
    const info = opts.info || null;
    const silentSkip = !!opts.silentSkip;
    const jobKey = divJob.jobKey(telegramUserId, sessionId, tipoKey);

    // Placeholders {{groupInviteLink}} → link live (ADM). Falha = nao dispara texto quebrado.
    try {
        const inv = require('../../utils/divulgacaoInviteLink');
        const renderOpts = {
            telegramUserId,
            groupJid: config.inviteGroupJid,
            lastInviteUrl: config.inviteLinkLast || ''
        };
        const patchText = async (fieldPath) => {
            if (fieldPath === 'texto' && inv.hasInvitePlaceholder(config.texto)) {
                const r = await inv.renderWithLiveInvite(conn, config.texto, renderOpts);
                if (!r.ok) return r;
                config.texto = r.text;
            }
            if (fieldPath === 'cta' && config.cta) {
                if (config.cta.texto) {
                    config.cta = {
                        ...config.cta,
                        texto: inv.stripInviteFromText
                            ? inv.stripInviteFromText(config.cta.texto)
                            : String(config.cta.texto)
                    };
                }
                for (const uk of ['url', 'url2']) {
                    if (inv.hasInvitePlaceholder(config.cta[uk])) {
                        const r = await inv.renderWithLiveInvite(conn, config.cta[uk], renderOpts);
                        if (!r.ok) return r;
                        config.cta = { ...config.cta, [uk]: r.text.trim() };
                    }
                }
            }
            if (fieldPath === 'status' && inv.hasInvitePlaceholder(config.textoStatus)) {
                const r = await inv.renderWithLiveInvite(conn, config.textoStatus, renderOpts);
                if (!r.ok) return r;
                config.textoStatus = r.text;
            }
            if (fieldPath === 'pay' && inv.hasInvitePlaceholder(config.textoPay)) {
                const r = await inv.renderWithLiveInvite(conn, config.textoPay, renderOpts);
                if (!r.ok) return r;
                config.textoPay = r.text;
            }
            return { ok: true };
        };
        const tracks =
            tipo === 'cta' ? ['cta']
            : tipo === 'status' || tipo === 'closefriends' ? ['status']
            : tipo === 'pay' ? ['pay']
            : tipo === 'full' ? ['texto', 'cta', 'pay', 'status']
            : ['texto'];
        for (const t of tracks) {
            const r = await patchText(t);
            if (r && r.ok === false) {
                return {
                    ok: false,
                    reason: 'invite-link',
                    message: r.message || inv.failMessage(r.reason)
                };
            }
        }
        const urlLeft = String(config.inviteLinkLast || '').trim();
        const hasChat = (s) => /chat\.whatsapp\.com/i.test(String(s || ''));
        if (/^https?:\/\/chat\.whatsapp\.com\//i.test(urlLeft)) {
            if (tipo === 'cta' && config.cta) {
                const u1 = String(config.cta.url || '').trim();
                if (!u1 || inv.hasInvitePlaceholder(u1)) {
                    config.cta = { ...config.cta, url: urlLeft };
                }
            }
            if ((tipo === 'status' || tipo === 'closefriends' || tipo === 'full') && config.textoStatus && !hasChat(config.textoStatus)) {
                config.textoStatus = `${String(config.textoStatus).trim()}\n\n${urlLeft}`;
            }
        }
    } catch (e) {
        logger.logAviso(`[DIV] invite render: ${String(e.message || e).slice(0, 120)}`);
    }

    if (tipo === 'cta' && !isCtaReady(config)) {
        return { ok: false, reason: 'cta', message: 'CTA incompleto.' };
    }
    if (tipo === 'normal' && !isTextoReady(config)) {
        return { ok: false, reason: 'texto', message: 'Texto nao configurado.' };
    }
    if ((tipo === 'status' || tipo === 'closefriends') && !isStatusReady(config)) {
        return { ok: false, reason: 'status', message: 'Status nao configurado.' };
    }
    if ((tipo === 'pay' || tipo === 'full') && !isPayReady(config)) {
        return { ok: false, reason: 'pay', message: 'Texto de pagamento nao configurado.' };
    }

    let grupos = await resolveGruposDestino(conn, telegramUserId, { onlyGroups: opts.onlyGroups });
    if (!grupos.length) {
        return { ok: false, reason: 'no-groups', message: 'Nenhum grupo na lista. Use addgrupo ou deixe o bot entrar pelos convites da fila.' };
    }
    if (opts.source === 'auto' || opts.source === 'auto-msg') {
        try {
            const auto = require('../../utils/divulgacaoAuto');
            grupos = grupos.filter((g) => auto.canSendToGroup(telegramUserId, g, tipoKey));
        } catch (_) { /* cooldown opcional */ }
        if (!grupos.length) {
            return { ok: false, reason: 'cooldown', message: 'Tempo minimo ainda nao passou neste grupo.' };
        }
    }

    if (divJob.isRunning(jobKey)) {
        return { ok: false, reason: 'running', job: divJob.getJob(jobKey) };
    }
    if (opts.source !== 'auto' && opts.source !== 'auto-msg') {
        const prev = lastManualStartAt.get(jobKey) || 0;
        if (Date.now() - prev < MANUAL_START_DEBOUNCE_MS) {
            logger.logAviso(`[DIV] debounce start tipo=${tipoKey} qtd=${qtd}`);
            return { ok: false, reason: 'debounce' };
        }
    }
    const started = divJob.tryStart(jobKey, { tipo: tipoKey, grupos: grupos.length, source: opts.source || 'manual', qtd, slot });
    if (!started.ok) {
        return { ok: false, reason: 'running', job: started.job };
    }
    if (opts.source !== 'auto') lastManualStartAt.set(jobKey, Date.now());
    logger.logInfo(`[DIV] start tipo=${tipoKey} qtd=${qtd} grupos=${grupos.length} dest=g.us delay=${delayMsg} source=${opts.source || 'manual'}`);

    if (from && !silentSkip) {
        const tipoTexto = (TIPO_LABEL[tipo] || tipo) + (slot > 1 ? ` #${slot}` : '');
        const dica = isStatusBlastTipo(tipo)
            ? `Olhe a bandeja de Status de cada grupo (status normal, visivel pra todos).`
            : `O bot continua respondendo enquanto envia.`;
        await sendDivNotice(
            conn,
            from,
            info,
            telegramUserId,
            `DIVULGACAO COMECOU\n\n` +
            `Tipo: ${tipoTexto}\n` +
            `Destino: ${formatDestinoResumo(grupos.length)}\n` +
            `Qtd: ${qtd}x · delay ${delayMsg}ms\n` +
            `Fonte: ${opts.source === 'auto' ? 'automatica' : 'manual'}\n\n` +
            dica,
            'COMECOU'
        );
    }

    setImmediate(() => {
        executarDivulgacao(conn, {
            jobKey, tipo, qtd, delayMsg, grupos, config, sessionId, from, info,
            telegramUserId, slot
        }).catch((e) => {
            logger.logErro('div job', e.message);
            divJob.finish(jobKey);
        });
    });
    return { ok: true, tipo: tipoKey, grupos: grupos.length, jobKey, slot };
}

commands.divstop = {
    useCtx: true,
    aliases: ['parardiv', 'divparar', 'stopdiv'],
    description: "Para a divulgacao em andamento",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const n = divJob.requestStopAll(ctx.telegramUserId, ctx.sessionId);
        if (n > 0) {
            await sendDivulgacaoMessage(conn, ctx, {
                text: n > 1
                    ? `Parando ${n} divulgacoes em andamento... aguarde o aviso de fim.`
                    : 'Parando a divulgacao... aguarde o aviso de fim.'
            });
        } else {
            await sendDivulgacaoMessage(conn, ctx, {
                text: 'Nenhuma divulgacao em andamento.'
            });
        }
    }
};
commands.parardiv = commands.divstop;
commands.divparar = commands.divstop;
commands.stopdiv = commands.divstop;

// ========== FUNÇÕES AUXILIARES ==========

/** Mencoes = todos os membros elegiveis (ignora admins/bot) em toda rota visivel. */
function asMemberList(membros) {
    return (membros || []).map((m) => {
        if (!m) return null;
        if (typeof m === 'string') return { mention: m, relay: m };
        const mention = m.mention || m.relay || m.id;
        const relay = m.relay || m.mention || m.id;
        if (!mention && !relay) return null;
        return { mention: mention || relay, relay: relay || mention };
    }).filter(Boolean);
}

function mentionCap() {
    const n = Number(process.env.HANORK_DIV_MENTION_CAP || 80);
    if (!Number.isFinite(n) || n <= 0) return 80;
    return Math.min(500, Math.floor(n));
}

function mentionJids(membros) {
    return [...new Set(asMemberList(membros).map((m) => m.mention).filter(Boolean))].slice(0, mentionCap());
}

function relayJids(membros) {
    return [...new Set(asMemberList(membros).map((m) => m.relay).filter(Boolean))];
}

function mentionPayload(membros) {
    const mentions = mentionJids(membros);
    if (!mentions.length) return {};
    return {
        mentions,
        contextInfo: { mentionedJid: mentions }
    };
}

async function enviarMensagemTexto(conn, chatId, config, membros = []) {
    const texto = String(config.texto || '').trim();
    if (!texto) throw new Error('Texto normal vazio');
    const extra = mentionPayload(membros);
    const pack = getTextoMediaBuffer(config, conn?._telegramUserId);
    if (pack) {
        const buffer = pack.buffer;
        const tipo = pack.tipo;
        if (tipo === 'image') {
            await conn.sendMessage(chatId, { image: buffer, caption: texto, ...extra }, BLAST_SEND_OPTS);
        } else if (tipo === 'video') {
            await conn.sendMessage(chatId, { video: buffer, caption: texto, ...extra }, BLAST_SEND_OPTS);
        } else if (tipo === 'gif') {
            await conn.sendMessage(chatId, { video: buffer, gifPlayback: true, caption: texto, ...extra }, BLAST_SEND_OPTS);
        } else if (tipo === 'audio') {
            await conn.sendMessage(chatId, { audio: buffer, mimetype: pack.mimetype || config.midiaMimetype || 'audio/mpeg', ...extra }, BLAST_SEND_OPTS);
        } else if (tipo === 'document') {
            await conn.sendMessage(chatId, {
                document: buffer,
                fileName: pack.fileName || config.midiaNome || 'documento.pdf',
                caption: texto,
                ...extra
            }, BLAST_SEND_OPTS);
        } else if (tipo === 'sticker') {
            await conn.sendMessage(chatId, { sticker: buffer, ...extra }, BLAST_SEND_OPTS);
        } else {
            await conn.sendMessage(chatId, { text: texto, ...extra }, BLAST_SEND_OPTS);
        }
        return;
    }
    await conn.sendMessage(chatId, { text: texto, ...extra }, BLAST_SEND_OPTS);
}

function ctaBodyText(config) {
    try {
        const { stripInviteFromText } = require('../../utils/divulgacaoInviteLink');
        return stripInviteFromText(config?.cta?.texto || '');
    } catch (_) {
        return String(config?.cta?.texto || '').replace(/https?:\/\/chat\.whatsapp\.com\/\S+/gi, '').trim();
    }
}

async function enviarMensagemCta(conn, chatId, config, membros = []) {
    if (!isCtaReady(config)) {
        throw new Error('CTA incompleto: precisa texto, botao e link');
    }
    const ownerId = conn?._telegramUserId || config?._ownerTelegramUserId;
    try {
        const { assertSessionOwnsDivPayload } = require('../../utils/divulgacao');
        if (ownerId) assertSessionOwnsDivPayload(ownerId, config, conn);
    } catch (e) {
        logger.logErro(`[DIV] incidente isolamento cta: ${e.code || e.message}`);
        throw e;
    }
    const mentions = mentionJids(membros);
    const buttons = ctaUrlButtons(config, ownerId);
    const body = ctaBodyText(config);
    logger.logInfo(`[DIV] cta mentions=${mentions.length} botoes=${buttons.length}`);
    if (config.cta?.midiaTipo === 'video') {
        const vid = getCtaStoredBuffer(config, conn?._telegramUserId);
        if (vid) {
            await conn.sendMessage(chatId, {
                video: vid,
                caption: body,
                ...mentionPayload(membros)
            }, BLAST_SEND_OPTS);
        }
        return await sendNativeButtons(
            conn,
            chatId,
            body,
            buttons,
            "",
            null,
            null,
            "Divulgacao",
            "",
            conn?._telegramUserId || null,
            mentions,
            conn?._sessionId || null,
            { forceNative: true, rawLabels: true, skipForward: true, _hanorkTrusted: true }
        );
    }
    const imageBuf = getCtaImageBuffer(config, conn?._telegramUserId);
    return await sendNativeButtons(
        conn,
        chatId,
        body,
        buttons,
        "",
        null,
        imageBuf,
        "Divulgacao",
        "",
        conn?._telegramUserId || null,
        mentions,
        conn?._sessionId || null,
        { forceNative: true, rawLabels: true, skipForward: true, _hanorkTrusted: true }
    );
}

async function enviarStatusVIP(conn, chatId, config, membros = [], opts = {}) {
    const textoFinal = String(config.textoStatus || '').trim();
    const pack = getStatusMediaBuffer(config, conn?._telegramUserId);
    if (!textoFinal && !pack) {
        throw new Error('Status sem texto e sem midia');
    }

    const { sendGroupStatusV2 } = require('../../utils/groupStatusV2');
    const r = await sendGroupStatusV2(conn, chatId, {
        texto: textoFinal,
        buffer: pack?.buffer,
        tipo: pack?.tipo,
        mimetype: pack?.mimetype,
        mode: 'membros',
        closeFriends: !!opts.closeFriends
    });
    logger.logInfo(
      `[DIV] status-gp group=${chatId} tray=${r.kind} mode=membros filter=${r.filtered ? 1 : 0}` +
      ` hidden=${r.hidden || 0} midia=${pack ? pack.tipo : 'texto'}`
    );
    return r;
}

async function enviarPagamento(conn, chatId, config, membros = []) {
    // Bolha nativa requestPaymentMessage, 1 pkmsg por membro (ADM do grupo nao recebe).
    // Nao e mencao oculta / zero-width. Hide-admin = HANORK_STATUS_HIDE_ADMIN (default 1).
    const textoPay = String(config.textoPay || '').trim();
    if (!textoPay) throw new Error('Texto de pagamento vazio');

    const { sendGroupPaymentMembers } = require('../../utils/groupStatusV2');
    const r = await sendGroupPaymentMembers(conn, chatId, {
        texto: textoPay,
        mode: 'membros',
        hideAdmin: true,
        mentions: mentionJids(membros)
    });
    logger.logInfo(`[DIV] pagamento membros group=${chatId} filter=${r.filtered ? 1 : 0} hidden=${r.hidden}`);
    return r;
}

module.exports = { commands, startDivulgacaoFromConfig, executarDivulgacao, mostrarConfirmacao };