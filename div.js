const { requireSessionOwner } = require('../../utils/authorization');
// commands/divulgar/div.js
const logger = require("../../logger");
const { sendButtonsWithImage } = require("../../helpers");
const { getConfig, getGruposParaDivulgar, isCtaReady, ctaMissing, formatCtaSummary, isTextoReady, isPayReady, formatTextoSummary, formatPaySummary, queueTextForTipo, getCtaImageBuffer } = require("../../utils/divulgacao");
const { getBlacklist } = require("../../utils/configManager");
const { delay } = require("../../utils");
const { withTimeout, DEFAULT_TIMEOUT_MS } = require("../../utils/timeout");
const crypto = require("crypto");
const { generateWAMessageFromContent, prepareWAMessageMedia, generateWAMessage } = require("@systemzero/baileys");
const { createQueue, getPendingCount, getMessageText, clearQueue } = require("../../utils/invisibleQueue");
const { relayDirectedToParticipant } = require("../../utils/directedGroupRelay");
const divJob = require("../../utils/divulgacaoJob");

const DIRECTED_CAP = 40;
const MAX_QTD = 3;
const MIN_DELAY = 800;
const MAX_DELAY = 6000;
const DEFAULT_DELAY = 1500;
const DIRECTED_GAP_MS = 200;
const RATE_BACKOFF_MS = 2500;

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
    return /rate-overlimit|connection closed|timed out|forbidden/i.test(m);
}

function isWaFatalStop(err) {
    const m = String(err?.message || err || '');
    return /connection closed/i.test(m);
}

function logDivGroupErr(scope, groupId, err) {
    const msg = String(err?.message || err || '');
    if (/forbidden|not-authorized|rate-overlimit/i.test(msg)) {
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
    }
    return ids;
}

function isGroupAdmin(p) {
    return p?.admin === 'admin' || p?.admin === 'superadmin';
}

async function obterMembrosElegiveis(conn, groupId) {
    return withTimeout(async () => {
        const { getCachedGroupMetadata } = require('../../utils/groupMetaCache');
        const meta = await getCachedGroupMetadata(conn, groupId);
        const botIds = collectBotIds(conn);
        return (meta.participants || [])
            .filter((p) => p && p.id && !isGroupAdmin(p) && !botIds.has(p.id))
            .map((p) => p.id)
            .filter((id) => !/@g\.us$|@newsletter$/.test(id));
    }, 10000, `obterMembrosElegiveis(${groupId})`).catch(e => {
        const msg = String(e && e.message ? e.message : e);
        // forbidden = bot fora do grupo / sem permissao — aviso, nao ERRO ruidoso
        if (/forbidden|not-authorized|rate-overlimit/i.test(msg)) {
            logger.logAviso(`obterMembrosElegiveis ${groupId}: ${msg}`);
        } else {
            logger.logErro("obterMembrosElegiveis", `Erro ao obter membros do grupo ${groupId}: ${msg}`);
        }
        return [];
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
    description: "Alias de .div (texto com mencoes invisivel)",
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
        await mostrarConfirmacao(conn, ctx, 'full', qtd, delayMsg);
    }
};

// ========== FUNÇÃO DE CONFIRMAÇÃO ==========
async function mostrarConfirmacao(conn, ctx, tipo, qtd, delayMsg) {
    const from = ctx.from;
    const info = ctx.info;
    const config = getConfig(ctx.telegramUserId);
    const data = getGruposParaDivulgar(ctx.telegramUserId);

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

    if ((tipo === 'normal' || tipo === 'status' || tipo === 'closefriends') && !isTextoReady(config)) {
        return sendButtonsWithImage(
            conn,
            from,
            "TEXTO NAO CONFIGURADO\n\nUse: msgdivul <texto>\nPode colar varios links. Isso NAO mexe no CTA.",
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

    if ((tipo === 'pay' || tipo === 'full') && !isPayReady(config)) {
        return sendButtonsWithImage(
            conn,
            from,
            "TEXTO DE PAGAMENTO NAO CONFIGURADO\n\nUse: msgdivulpay <texto>\nSeparado do texto normal e do CTA.",
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
            "ADICIONE GRUPOS\n\nDivulgacao so vai pros grupos da lista.\nUse addgrupo (ou addgrupo off) no grupo.",
            [
                { id: "div_grupos", label: "Gerenciar grupos" },
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

    const modoTexto = `${data.grupos.length} grupos na lista`;
    const tipoMap = {
        normal: 'Texto',
        cta: 'CTA',
        pay: 'Pagamento',
        status: 'Status Close Friends',
        closefriends: 'Close Friends (Invisivel)',
        full: 'Completa'
    };
    const tipoTexto = tipoMap[tipo] || tipo;
    const statusTexto = config.statusAtivo ? 'Sim' : 'Nao';
    const temMidia = config.midia ? 'Sim' : 'Nao';
    let extra = '';
    if (tipo === 'cta') extra = `\n${formatCtaSummary(config)}\n`;
    else if (tipo === 'pay' || tipo === 'full') extra = `\n${formatPaySummary(config)}\n`;
    else extra = `\n${formatTextoSummary(config)}\n`;

    await sendButtonsWithImage(
        conn,
        from,
        `*CONFIRMAR DIVULGACAO*\n\n` +
        `Tipo: ${tipoTexto}\n` +
        `Grupos: ${modoTexto}\n` +
        `Quantidade: ${qtd}x\n` +
        `Delay: ${delayMsg}ms\n` +
        `Status extra: ${statusTexto}\n` +
        `Midia (texto/status): ${temMidia}\n` +
        `Mencoes: TODOS os membros (ignora admins) em texto/CTA/pay/status.\n` +
        `Pay/Status dirigido: ate ${DIRECTED_CAP} envios por grupo.\n` +
        `Voce recebe aviso na hora e outro quando terminar.\n` +
        `Invisivel: so quem falar ve; mencoes = todos (ignora admins)` +
        extra,
        [
            { id: `div_confirm_iniciar_${tipo}_${qtd}_${delayMsg}`, label: "Confirmar" },
            { id: "div_config", label: "Configurar" },
            { id: "div_grupos", label: "Grupos" },
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
    status: 'Status Close Friends',
    closefriends: 'Close Friends (Invisivel)',
    full: 'Completa'
};

async function sendDivNotice(conn, from, info, telegramUserId, text, header, extraButtons = []) {
    try {
        await sendButtonsWithImage(
            conn,
            from,
            text,
            [
                { id: "div_stop", label: "Parar" },
                ...extraButtons,
                { id: "div_menu", label: "Menu div" }
            ],
            "Hanork Bot",
            info,
            "menu.jpg",
            header,
            "Clique abaixo",
            telegramUserId
        );
    } catch (e) {
        logger.logAviso(`div notice: ${e.message}`);
        try {
            await conn.sendMessage(from, { text }, { quoted: info, _hanorkTrusted: true });
        } catch (_) { /* socket morto */ }
    }
}

async function executarDivulgacao(conn, {
    jobKey, tipo, qtd, delayMsg, grupos, config, sessionId, from, info, telegramUserId
}) {
    const delayGrupo = clampDelay(config.delayGrupo || 1200, 1200);
    let totalMembros = 0;
    const membrosPorGrupo = new Map();
    let abortDiv = false;
    let abortedReason = null;
    let totalEnviadas = 0;
    let totalErros = 0;
    let statusEnviados = 0;

    const stopped = () => abortDiv || divJob.shouldAbort(jobKey);

    try {
        for (let i = 0; i < grupos.length; i++) {
            if (stopped()) {
                abortDiv = true;
                abortedReason = abortedReason || 'parada pelo dono';
                break;
            }
            const groupId = grupos[i];
            try {
                const membros = await obterMembrosElegiveis(conn, groupId);
                membrosPorGrupo.set(groupId, membros);
                if (membros.length > 0) {
                    createQueue(sessionId, groupId, membros, queueTextForTipo(config, tipo));
                    totalMembros += membros.length;
                    logger.logInfo(`[DIV] fila ${groupId} n=${membros.length}`);
                }
            } catch (e) {
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
                const membros = membrosPorGrupo.get(groupId) || [];
                let groupEnviadas = 0;
                let groupErros = 0;
                let groupStatus = 0;

                try {
                    if (tipo !== 'closefriends' && tipo !== 'status') {
                        if (tipo === 'normal' || tipo === 'cta' || tipo === 'pay' || tipo === 'full') {
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
                                    await delay(delayMsg);
                                    await yieldLoop();
                                } catch (e) {
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
                    }

                    const wantStatus =
                        tipo === 'status' ||
                        tipo === 'closefriends' ||
                        !!config.statusAtivo;
                    if (!stopped() && wantStatus) {
                        for (let j = 0; j < qtd; j++) {
                            if (stopped()) break;
                            try {
                                const st = await enviarStatusVIP(conn, groupId, config, membros);
                                groupStatus += st.sent || 0;
                                groupErros += st.errors || 0;
                                await delay(delayMsg);
                                await yieldLoop();
                            } catch (e) {
                                logDivGroupErr('status', groupId, e);
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
                logger.logInfo(`[DIV] grupo ${i + 1}/${grupos.length} ok pub=${groupEnviadas} st=${groupStatus} err=${groupErros}`);

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
        `Membros (fila invisivel cap): ${totalMembros}\n`;
    if (abortedReason) {
        mensagemResultado += `Motivo: ${abortedReason}\n`;
    }
    mensagemResultado += `Msgs publicas: ${totalEnviadas}\n` +
        `Status/pay dirigidos: ${statusEnviados}\n` +
        `Erros: ${totalErros}\n` +
        `Qtd: ${qtd}x`;

    await sendDivNotice(conn, from, info, telegramUserId, mensagemResultado, endedPartial ? 'PARCIAL' : 'FIM', [
        { id: "div_iniciar", label: "Repetir" },
        { id: "div_config", label: "Configurar" }
    ]);
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

        const from = ctx.from;
        const info = ctx.info;
        const config = getConfig(ctx.telegramUserId);
        const data = getGruposParaDivulgar(ctx.telegramUserId);
        const sessionId = ctx.sessionId;
        const jobKey = divJob.jobKey(ctx.telegramUserId, sessionId);

        if (tipo === 'cta' && !isCtaReady(config)) {
            return sendButtonsWithImage(
                conn, from,
                "CTA INCOMPLETO\n\nConfigure texto, botao e link do CTA (nao usa o texto normal).",
                [{ id: "div_cta_wizard", label: "Configurar CTA" }, { id: "div_config", label: "Configurar" }],
                "Hanork Bot", info, "menu.jpg", "CTA", "Clique abaixo", ctx.telegramUserId
            );
        }
        if ((tipo === 'normal' || tipo === 'status' || tipo === 'closefriends') && !isTextoReady(config)) {
            return sendButtonsWithImage(
                conn, from,
                "TEXTO NAO CONFIGURADO\n\nUse msgdivul. Nao usa o texto do CTA.",
                [{ id: "div_config_texto", label: "Configurar Texto" }, { id: "div_config", label: "Configurar" }],
                "Hanork Bot", info, "menu.jpg", "TEXTO", "Clique abaixo", ctx.telegramUserId
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

        let grupos = Array.isArray(data.grupos) ? data.grupos.slice() : [];
        if (!grupos.length) {
            return conn.sendMessage(from, {
                text: 'Nenhum grupo na lista. Use addgrupo (ou addgrupo off) no grupo.'
            }, { quoted: info });
        }

        const blacklist = getBlacklist(ctx.telegramUserId);
        grupos = grupos.filter(g => !blacklist.includes(g));
        if (grupos.length === 0) {
            return conn.sendMessage(from, { text: "Todos os grupos selecionados estao na blacklist." }, { quoted: info });
        }

        if (divJob.isRunning(jobKey)) {
            const cur = divJob.getJob(jobKey);
            return conn.sendMessage(from, {
                text: `Ja tem uma divulgacao rodando (${cur?.tipo || '?'} · ${cur?.doneGrupos || 0}/${cur?.grupos || '?'} grupos).\nUse Parar e depois confirme de novo.`
            }, { quoted: info });
        }

        const started = divJob.tryStart(jobKey, { tipo, grupos: grupos.length });
        if (!started.ok) {
            return conn.sendMessage(from, { text: 'Ja tem uma divulgacao rodando. Use Parar primeiro.' }, { quoted: info });
        }

        const tipoTexto = TIPO_LABEL[tipo] || tipo;
        await sendDivNotice(
            conn,
            from,
            info,
            ctx.telegramUserId,
            `*DIVULGACAO COMECOU*\n\n` +
            `Tipo: ${tipoTexto}\n` +
            `Grupos: ${grupos.length}\n` +
            `Qtd: ${qtd}x · delay ${delayMsg}ms\n` +
            `Mencoes: todos os membros (ignora admins)\n` +
            `Dirigido: ate ${DIRECTED_CAP}/grupo\n\n` +
            `O bot continua respondendo enquanto envia.\n` +
            `Voce recebe outro aviso quando terminar.`,
            'COMECOU'
        );

        setImmediate(() => {
            executarDivulgacao(conn, {
                jobKey, tipo, qtd, delayMsg, grupos, config, sessionId, from, info,
                telegramUserId: ctx.telegramUserId
            }).catch((e) => {
                logger.logErro('div job', e.message);
                divJob.finish(jobKey);
            });
        });
    }
};

commands.divstop = {
    useCtx: true,
    aliases: ['parardiv', 'divparar', 'stopdiv'],
    description: "Para a divulgacao em andamento",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const jobKey = divJob.jobKey(ctx.telegramUserId, ctx.sessionId);
        if (divJob.requestStop(jobKey)) {
            await conn.sendMessage(ctx.from, {
                text: 'Parando a divulgacao... aguarde o aviso de fim.'
            }, { quoted: ctx.info, _hanorkTrusted: true });
        } else {
            await conn.sendMessage(ctx.from, {
                text: 'Nenhuma divulgacao em andamento.'
            }, { quoted: ctx.info, _hanorkTrusted: true });
        }
    }
};
commands.parardiv = commands.divstop;
commands.divparar = commands.divstop;
commands.stopdiv = commands.divstop;

// ========== FUNÇÕES AUXILIARES ==========

/** Mencoes = todos os membros elegiveis (ignora admins/bot) em toda rota visivel. */
function mentionJids(membros) {
    return [...new Set((membros || []).filter(Boolean))];
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

    if (config.midia && config.midiaTipo) {
        const buffer = Buffer.from(config.midia, 'base64');
        const tipo = config.midiaTipo;
        if (tipo === 'image') {
            await conn.sendMessage(chatId, { image: buffer, caption: texto, ...extra }, { _hanorkTrusted: true });
        } else if (tipo === 'video') {
            await conn.sendMessage(chatId, { video: buffer, caption: texto, ...extra }, { _hanorkTrusted: true });
        } else if (tipo === 'gif') {
            await conn.sendMessage(chatId, { video: buffer, gifPlayback: true, caption: texto, ...extra }, { _hanorkTrusted: true });
        } else if (tipo === 'audio') {
            await conn.sendMessage(chatId, { audio: buffer, mimetype: config.midiaMimetype || 'audio/mpeg', ...extra }, { _hanorkTrusted: true });
        } else if (tipo === 'document') {
            await conn.sendMessage(chatId, {
                document: buffer,
                fileName: config.midiaNome || 'documento.pdf',
                caption: texto,
                ...extra
            }, { _hanorkTrusted: true });
        } else if (tipo === 'sticker') {
            await conn.sendMessage(chatId, { sticker: buffer, ...extra }, { _hanorkTrusted: true });
        } else {
            await conn.sendMessage(chatId, { text: texto, ...extra }, { _hanorkTrusted: true });
        }
        return;
    }
    await conn.sendMessage(chatId, { text: texto, ...extra }, { _hanorkTrusted: true });
}

async function enviarMensagemCta(conn, chatId, config, membros = []) {
    if (!isCtaReady(config)) {
        throw new Error('CTA incompleto: precisa texto, botao e link');
    }
    const imageBuf = getCtaImageBuffer(config);
    return await sendButtonsWithImage(
        conn,
        chatId,
        config.cta.texto,
        [{ label: config.cta.label, url: config.cta.url }],
        "",
        null,
        imageBuf,
        "Divulgacao",
        "",
        conn?._telegramUserId || null,
        mentionJids(membros),
        conn?._sessionId || null,
        { forceNative: true, rawLabels: true }
    );
}

async function enviarStatusVIP(conn, chatId, config, membros = []) {
    // @systemzero/baileys: MessageRelayOptions.participant = so 1 participante recebe.
    // groupStatus:true → groupStatusMessageV2. Admins nao estao em `membros`.
    const all = [...new Set((membros || []).filter(Boolean))];
    const targets = capList(all, DIRECTED_CAP);
    if (!targets.length) {
        logger.logAviso(`[DIV] status sem alvos (admins/bot ignorados) group=${chatId}`);
        return { sent: 0, errors: 0 };
    }
    if (all.length > targets.length) {
        logger.logAviso(`[DIV] status cap ${targets.length}/${all.length} group=${chatId}`);
    }

    const textoFinal = String(config.texto || '').trim();
    let sent = 0;
    let errors = 0;

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        try {
            const content = {
                groupStatus: true,
                // Mencoes da rota status: lista elegivel (ignora admins), igual texto/CTA/pay
                mentions: mentionJids(all)
            };

            if (config.midia && config.midiaTipo) {
                const buffer = Buffer.from(config.midia, 'base64');
                const tipo = config.midiaTipo;
                if (tipo === 'image') {
                    content.image = buffer;
                    content.caption = textoFinal;
                } else if (tipo === 'video') {
                    content.video = buffer;
                    content.caption = textoFinal;
                } else if (tipo === 'gif') {
                    content.video = buffer;
                    content.gifPlayback = true;
                    content.caption = textoFinal;
                } else if (tipo === 'audio') {
                    content.audio = buffer;
                    content.mimetype = config.midiaMimetype || 'audio/mpeg';
                } else if (tipo === 'document') {
                    content.document = buffer;
                    content.fileName = config.midiaNome || 'documento.pdf';
                    content.caption = textoFinal;
                } else {
                    content.text = textoFinal || 'hanork';
                }
            } else {
                content.text = textoFinal || 'hanork';
            }

            const fullMsg = await generateWAMessage(chatId, content, {
                userJid: conn.user?.id,
                upload: conn.waUploadToServer
            });

            const relay = await relayDirectedToParticipant(conn, {
                groupJid: chatId,
                message: fullMsg.message,
                targetJid: target,
                messageId: fullMsg.key?.id
            });

            if (relay.ok) sent++;
            else {
                errors++;
                if (isWaFatalStop({ message: relay.reason })) {
                    throw new Error(relay.reason || 'Connection Closed');
                }
                if (isWaRateOrClosed({ message: relay.reason })) {
                    await delay(RATE_BACKOFF_MS);
                }
            }
        } catch (e) {
            errors++;
            logDivGroupErr('status-dirigido', chatId, e);
            if (isWaFatalStop(e)) throw e;
            if (isWaRateOrClosed(e)) await delay(RATE_BACKOFF_MS);
        }
        if (i + 1 < targets.length) {
            await delay(DIRECTED_GAP_MS);
            await yieldLoop();
        }
    }

    logger.logInfo(`[DIV] status dirigido group=${chatId} sent=${sent}/${targets.length} errors=${errors}`);
    return { sent, errors };
}

async function enviarPagamento(conn, chatId, config, membros = []) {
    // System Zero: participant em relayMessage vale pra qualquer protobuf (incl. requestPaymentMessage).
    // Mesma logica do status: 1 relay dirigido por membro elegivel (admins/bot fora).
    const textoPay = String(config.textoPay || '').trim();
    if (!textoPay) throw new Error('Texto de pagamento vazio');

    const all = [...new Set((membros || []).filter(Boolean))];
    const targets = capList(all, DIRECTED_CAP);
    if (!targets.length) {
        logger.logAviso(`[DIV] pagamento sem alvos (admins/bot ignorados) group=${chatId}`);
        return { sent: 0, errors: 0 };
    }
    if (all.length > targets.length) {
        logger.logAviso(`[DIV] pay cap ${targets.length}/${all.length} group=${chatId}`);
    }
    const mentionPay = mentionJids(all);

    let sent = 0;
    let errors = 0;

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        try {
            const paymentMessage = {
                requestPaymentMessage: {
                    currencyCodeIso4217: "BRL",
                    amount1000: "0",
                    noteMessage: {
                        extendedTextMessage: {
                            text: textoPay,
                            contextInfo: {
                                // Mencoes da rota pay: lista elegivel (ignora admins)
                                mentionedJid: mentionPay
                            }
                        }
                    },
                    expiryTimestamp: "0",
                    amount: {
                        value: "0",
                        offset: 0,
                        currencyCode: "BRL"
                    },
                    recipientJid: target
                }
            };

            const relay = await relayDirectedToParticipant(conn, {
                groupJid: chatId,
                message: paymentMessage,
                targetJid: target
            });

            if (relay.ok) sent++;
            else {
                errors++;
                if (isWaFatalStop({ message: relay.reason })) {
                    throw new Error(relay.reason || 'Connection Closed');
                }
                if (isWaRateOrClosed({ message: relay.reason })) {
                    await delay(RATE_BACKOFF_MS);
                }
            }
        } catch (e) {
            errors++;
            logDivGroupErr('pay-dirigido', chatId, e);
            if (isWaFatalStop(e)) throw e;
            if (isWaRateOrClosed(e)) await delay(RATE_BACKOFF_MS);
        }
        if (i + 1 < targets.length) {
            await delay(DIRECTED_GAP_MS);
            await yieldLoop();
        }
    }

    logger.logInfo(`[DIV] pagamento dirigido group=${chatId} sent=${sent}/${targets.length} errors=${errors}`);
    return { sent, errors };
}

module.exports = { commands };