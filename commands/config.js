// commands/config.js
const logger = require("../logger");
const {
    getOwners, addOwner, removeOwner,
    getVips, addVip, removeVip,
    formatOwnerLabel,
    getBlacklist, addBlacklist, removeBlacklist,
    getPrefix, setPrefix,
    getButtonsEnabled, setButtonsEnabled,
    getWhatsAppChannelId, setWhatsAppChannelId,
    getModerationConfig, setModerationConfig
} = require("../utils/configManager");
const { sendButtonsWithImage } = require("../helpers");
        const { getPhoneForLid, getLidForPhone, ensureJidString } = require("../utils");
const { getSessionButtonMode, toggleSessionButtonMode, syncButtonsMode, areButtonsOn } = require("../utils/sessionRegistry");
const { setForwardMode, isForwardModeEnabled, getForwardModeStatus, clearForwardMode } = require("../utils/channelForward");
const {
    isModerationActive,
    enableModeration,
    disableModeration,
    getGroupSecurity,
    setGroupSecurityFlag,
    formatGroupSecurityStatus
} = require("../utils/moderation");

const commands = {};

function resolvePersonJid(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (t.includes('@')) return t.split(/\s+/)[0];
    try {
        const { parsePhoneAndQty } = require('../utils/phoneTarget');
        const parsed = parsePhoneAndQty(t, { defaultQty: 1 });
        return parsed?.jid || null;
    } catch (_) {
        const digits = t.replace(/\D/g, '');
        return digits.length >= 10 ? `${digits}@s.whatsapp.net` : null;
    }
}

function sessionOwner(ctx) {
    try {
        return require('../utils/authorization').isFreshSessionOwner(ctx);
    } catch (_) {
        return !!ctx?.isOwner;
    }
}

function sessionVip(ctx) {
    if (sessionOwner(ctx)) return true;
    try {
        const { checkAuthorization, resolveCanonicalIdentity } = require('../utils/authorization');
        const tid = String(ctx.telegramUserId || '');
        const ids = resolveCanonicalIdentity(ctx.sender, ctx);
        const auth = checkAuthorization(ids[0] || ctx.sender, tid, false, ids, ctx.conn);
        return auth.role === 'vip' || auth.role === 'owner' || auth.role === 'platform_admin';
    } catch (_) {
        return !!(ctx?.isVip || ctx?.isOwner);
    }
}

// ========== PREFIXO ==========
commands.setprefix = {
    useCtx: true,
    description: "Altera o prefixo do bot",
    usage: "setprefix <novo_prefixo>",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem alterar o prefixo." }, { quoted: ctx.info });
        const newPrefix = ctx.text.trim();
        if (!newPrefix || newPrefix.length > 2) {
            return conn.sendMessage(ctx.from, { text: "Use: setprefix <prefixo> (maximo 2 caracteres)" }, { quoted: ctx.info });
        }
        if (!setPrefix(ctx.telegramUserId, newPrefix)) {
            return conn.sendMessage(ctx.from, { text: "Nao foi possivel alterar o prefixo." }, { quoted: ctx.info });
        }
        const { formatPrefixStatus } = require("../utils/configManager");
        await conn.sendMessage(ctx.from, {
            text: `Prefixo WhatsApp: ${newPrefix}\n\n${formatPrefixStatus(ctx.telegramUserId)}`
        }, { quoted: ctx.info });
    }
};

commands.prefixo = {
    useCtx: true,
    description: 'Mostra o prefixo desta sessao',
    usage: 'prefixo',
    execute: async (conn, ctx) => {
        const p = String(getPrefix(ctx.telegramUserId) || ctx.prefix || '.').trim() || '.';
        await conn.sendMessage(ctx.from, {
            text: `Prefixo desta sessao: ${p}\nExemplo: ${p}menu`
        }, { quoted: ctx.info });
    }
};
commands.prefix = commands.prefixo;

// ========== DONOS ==========
commands.addowner = {
    useCtx: true,
    description: "Adiciona um dono",
    usage: "addowner <jid>",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem adicionar donos." }, { quoted: ctx.info });
        const jid = resolvePersonJid(ctx.text);
        if (!jid) return conn.sendMessage(ctx.from, { text: "Use: addowner <jid|numero> (aceita +55 51 8205-2118)" }, { quoted: ctx.info });
        const ok = addOwner(ctx.telegramUserId, jid);
        await conn.sendMessage(ctx.from, { text: ok ? `Dono ${formatOwnerLabel(jid)} adicionado.` : `Ja esta na lista.` }, { quoted: ctx.info });
    }
};

commands.removeowner = {
    useCtx: true,
    description: "Remove um dono",
    usage: "removeowner <jid>",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem remover donos." }, { quoted: ctx.info });
        const jid = resolvePersonJid(ctx.text);
        if (!jid) return conn.sendMessage(ctx.from, { text: "Use: removeowner <jid|numero>" }, { quoted: ctx.info });
        // Não permitir remover o último dono
        const owners = getOwners(ctx.telegramUserId);
        if (owners.length <= 1 && owners.some((o) => {
            try { return require('../utils/authorization').matchesAuthorizedEntry(o, jid); } catch (_) { return o === jid; }
        })) {
            return conn.sendMessage(ctx.from, { text: "Nao e possivel remover o unico dono." }, { quoted: ctx.info });
        }
        const ok = removeOwner(ctx.telegramUserId, jid);
        await conn.sendMessage(ctx.from, { text: ok ? `Dono ${formatOwnerLabel(jid)} removido.` : `Nao estava na lista.` }, { quoted: ctx.info });
    }
};

commands.listowners = {
    useCtx: true,
    description: "Lista os donos",
    usage: "listowners",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem ver a lista." }, { quoted: ctx.info });
        const owners = getOwners(ctx.telegramUserId);
        const texto = owners.length
            ? owners.map((o) => formatOwnerLabel(o)).join('\n')
            : 'Nenhum dono cadastrado.';
        await conn.sendMessage(ctx.from, { text: `Donos:\n${texto}` }, { quoted: ctx.info });
    }
};

// ========== VIPS ==========
commands.addvip = {
    useCtx: true,
    description: "Adiciona um VIP",
    usage: "addvip <jid>",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem adicionar VIPs." }, { quoted: ctx.info });
        const jid = resolvePersonJid(ctx.text);
        if (!jid) return conn.sendMessage(ctx.from, { text: "Use: addvip <jid|numero> (aceita +55 51 8205-2118)" }, { quoted: ctx.info });
        try {
            const { checkTargetAction } = require('../utils/permissionEngine');
            if (!checkTargetAction(conn, { ...ctx, command: 'addvip' }, jid).allowed) return;
        } catch (_) { /* fail-open so se o motor faltar: gate ja bloqueou nao-dono */ }
        const ok = addVip(ctx.telegramUserId, jid);
        await conn.sendMessage(ctx.from, { text: ok ? `VIP ${jid} adicionado.` : `Ja esta na lista.` }, { quoted: ctx.info });
    }
};

commands.removevip = {
    useCtx: true,
    description: "Remove um VIP",
    usage: "removevip <jid>",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem remover VIPs." }, { quoted: ctx.info });
        const jid = resolvePersonJid(ctx.text);
        if (!jid) return conn.sendMessage(ctx.from, { text: "Use: removevip <jid|numero>" }, { quoted: ctx.info });
        try {
            const { checkTargetAction } = require('../utils/permissionEngine');
            if (!checkTargetAction(conn, { ...ctx, command: 'removevip' }, jid).allowed) return;
        } catch (_) { /* */ }
        const ok = removeVip(ctx.telegramUserId, jid);
        await conn.sendMessage(ctx.from, { text: ok ? `VIP ${jid} removido.` : `Nao estava na lista.` }, { quoted: ctx.info });
    }
};

commands.listvips = {
    useCtx: true,
    description: "Lista os VIPs",
    usage: "listvips",
    execute: async (conn, ctx) => {
        if (!sessionVip(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos ou VIPs podem ver a lista." }, { quoted: ctx.info });
        const vips = getVips(ctx.telegramUserId);
        const texto = vips.length ? vips.join('\n') : 'Nenhum VIP cadastrado.';
        await conn.sendMessage(ctx.from, { text: `⭐ VIPs:\n${texto}` }, { quoted: ctx.info });
    }
};

// ========== BLACKLIST ==========
commands.addblacklist = {
    useCtx: true,
    description: "Adiciona um grupo a blacklist",
    usage: "addblacklist <jid_do_grupo>",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem gerenciar a blacklist." }, { quoted: ctx.info });
        const jid = ensureJidString(ctx.text && ctx.text.trim(), '');
        if (!jid || !jid.endsWith('@g.us')) {
            return conn.sendMessage(ctx.from, { text: "Use: addblacklist <code>jid_do_grupo</code> (deve terminar com @g.us)" }, { quoted: ctx.info });
        }
        const ok = addBlacklist(ctx.telegramUserId, jid);
        await conn.sendMessage(ctx.from, { text: ok ? `Grupo ${jid} adicionado a blacklist.` : `Ja esta na blacklist.` }, { quoted: ctx.info });
    }
};

commands.removeblacklist = {
    useCtx: true,
    description: "Remove um grupo da blacklist",
    usage: "removeblacklist <jid_do_grupo>",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem gerenciar a blacklist." }, { quoted: ctx.info });
        const jid = ensureJidString(ctx.text && ctx.text.trim(), '');
        if (!jid) return conn.sendMessage(ctx.from, { text: "Use: removeblacklist <code>jid_do_grupo</code>" }, { quoted: ctx.info });
        const ok = removeBlacklist(ctx.telegramUserId, jid);
        await conn.sendMessage(ctx.from, { text: ok ? `Grupo ${jid} removido da blacklist.` : `Nao estava na blacklist.` }, { quoted: ctx.info });
    }
};

commands.listblacklist = {
    useCtx: true,
    description: "Lista os grupos na blacklist",
    usage: "listblacklist",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem ver a blacklist." }, { quoted: ctx.info });
        const blacklist = getBlacklist(ctx.telegramUserId);
        const texto = blacklist.length ? blacklist.join('\n') : 'Nenhum grupo na blacklist.';
        await conn.sendMessage(ctx.from, { text: `🚫 Blacklist:\n${texto}` }, { quoted: ctx.info });
    }
};

// ========== BOTÕES INTERATIVOS ==========
commands.buttonson = {
    useCtx: true,
    description: "Ativa botoes interativos",
    usage: "buttonson",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem alterar essa configuracao." }, { quoted: ctx.info });
        syncButtonsMode(ctx.telegramUserId, true, ctx.sessionId || conn?._sessionId);
        await conn.sendMessage(ctx.from, { text: "Botoes interativos ATIVADOS (todas as sessoes)." }, { quoted: ctx.info });
    }
};

commands.buttonsoff = {
    useCtx: true,
    description: "Desativa botoes interativos",
    usage: "buttonsoff",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem alterar essa configuracao." }, { quoted: ctx.info });
        syncButtonsMode(ctx.telegramUserId, false, ctx.sessionId || conn?._sessionId);
        const channelId = getWhatsAppChannelId(ctx.telegramUserId);
        await conn.sendMessage(ctx.from, { text: `Botoes DESATIVADOS (todas as sessoes).\nCanal: ${channelId}` }, { quoted: ctx.info });
    }
};

commands.buttons = {
    useCtx: true,
    description: "Ativa/Desativa botoes interativos",
    usage: "buttons <on|off>",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem alterar essa configuracao." }, { quoted: ctx.info });
        
        const action = ctx.text.trim().toLowerCase();
        const sid = ctx.sessionId || conn?._sessionId;
        if (action === 'on' || action === 'true' || action === '1') {
            syncButtonsMode(ctx.telegramUserId, true, sid);
            await conn.sendMessage(ctx.from, { text: `Botoes ATIVADOS.\nStatus: ${areButtonsOn(sid, ctx.telegramUserId) ? 'ON' : 'OFF'}` }, { quoted: ctx.info });
        } else if (action === 'off' || action === 'false' || action === '0') {
            syncButtonsMode(ctx.telegramUserId, false, sid);
            await conn.sendMessage(ctx.from, { text: `Botoes DESATIVADOS.\nStatus: ${areButtonsOn(sid, ctx.telegramUserId) ? 'ON' : 'OFF'}` }, { quoted: ctx.info });
        } else {
            await conn.sendMessage(ctx.from, { text: `Status: ${areButtonsOn(sid, ctx.telegramUserId) ? 'ON' : 'OFF'}\n\nUse: buttons on | buttons off` }, { quoted: ctx.info });
        }
    }
};

commands.channelid = {
    useCtx: true,
    description: "Configura o ID do canal do WhatsApp (JID numerico @newsletter)",
    usage: "channelid <120363...@newsletter>",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem alterar essa configuracao." }, { quoted: ctx.info });
        
        const newChannelId = ctx.text.trim();
        if (!newChannelId) {
            const currentId = getWhatsAppChannelId(ctx.telegramUserId);
            return conn.sendMessage(ctx.from, {
                text:
                    `ID do canal atual: ${currentId}\n\n` +
                    `Use o JID numerico (ex: 120363412971004933@newsletter).\n` +
                    `NAO use codigo de convite 0029... — causa "atualizacao encaminhada nao e valida".`
            }, { quoted: ctx.info });
        }
        
        const result = setWhatsAppChannelId(ctx.telegramUserId, newChannelId);
        if (!result?.ok) {
            return conn.sendMessage(ctx.from, {
                text:
                    `JID invalido: ${newChannelId}\n` +
                    `Salvo fallback: ${result.saved}\n\n` +
                    `Envie o ID numerico do canal (digitos + @newsletter), nao o link/convite.`
            }, { quoted: ctx.info });
        }
        await conn.sendMessage(ctx.from, { text: `ID do canal atualizado para: ${result.saved}` }, { quoted: ctx.info });
    }
};

// ========== TOGGLE BOTÕES ==========
commands.togglebuttons = {
    useCtx: true,
    description: "Alterna modo de botoes ON/OFF para a sessao atual",
    usage: "togglebuttons",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem alterar o modo de botoes." }, { quoted: ctx.info });
        
        const sessionId = ctx.sessionId;
        if (!sessionId) {
            return conn.sendMessage(ctx.from, { text: "Sessao nao encontrada. Este comando so funciona em sessoes conectadas." }, { quoted: ctx.info });
        }
        
        const newMode = syncButtonsMode(
            ctx.telegramUserId,
            !areButtonsOn(sessionId, ctx.telegramUserId),
            sessionId
        );
        const modeText = newMode ? "ON (com botoes)" : "OFF (encaminhada de canal)";
        
        await conn.sendMessage(ctx.from, { 
            text: `Modo de botoes: ${modeText}\n\nON: Menus com botoes interativos\nOFF: Mensagens como encaminhadas do canal oficial` 
        }, { quoted: ctx.info });
    }
};

commands.buttonmode = {
    useCtx: true,
    description: "Verifica o modo de botoes atual da sessao",
    usage: "buttonmode",
    execute: async (conn, ctx) => {
        const sessionId = ctx.sessionId;
        if (!sessionId) {
            return conn.sendMessage(ctx.from, { text: "Sessao nao encontrada." }, { quoted: ctx.info });
        }
        
        const currentMode = areButtonsOn(sessionId, ctx.telegramUserId);
        const modeText = currentMode ? "ON (com botoes)" : "OFF (texto apenas)";
        
        await conn.sendMessage(ctx.from, { 
            text: `Modo de botoes atual: ${modeText}\n\nUse .togglebuttons | .buttonson | .buttonsoff` 
        }, { quoted: ctx.info });
    }
};

// ========== ANTI-FLOOD / SEGURANCA DE GRUPO ==========

function parseOnOff(text) {
    try {
        return require('../utils/protectionStore').parseOnOff(text);
    } catch (_) {
        const t = String(text || '').trim().toLowerCase();
        if (!t) return null;
        const first = t.split(/\s+/)[0];
        if (/^(on|1|true|ativar|ativa|ligar|liga|sim|yes)$/.test(first)) return true;
        if (/^(off|0|false|desativar|desativa|desligar|desliga|nao|não|no)$/.test(first)) return false;
        return null;
    }
}

async function toggleSecurityFlag(conn, ctx, flag, label) {
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
    const saved = await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, flag, enabled);
    const actualOn = !!saved?.[flag];

    // futuro.txt item 9: clique no painel = toggle + reenvia lista (sem confirm/submenu)
    const fromPanel = !!(ctx.isInteractive || (parsed === null && !String(ctx.text || '').trim()));
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

    const p = require('../utils/configManager').prefixFromCtx(ctx);
    const { findSecurityItem } = require('../utils/securityMenu');
    const item = findSecurityItem(flag) || findSecurityItem(label);
    const explain = item?.explain ? `\n${item.explain}` : '';
    const acao = item?.actionHint
        ? `\nAcao: ${item.actionHint} (admins/dono em geral isentos)`
        : '';
    await conn.sendMessage(ctx.from, {
        text:
            `${label}: ${actualOn ? 'LIGADO' : 'DESLIGADO'}` +
            (actualOn !== !!enabled ? ' (corrigido apos gravar)' : '') +
            explain +
            acao +
            `\n\nVer o que apaga/ban agora: ${p}protecoesativas\nPainel: ${p}gpseguranca`
    }, { quoted: ctx.info });
}

commands.modhelp = {
    useCtx: true,
    description: 'Ajuda / painel anti-flood e seguranca',
    usage: 'modhelp',
    execute: async (conn, ctx) => {
        const { sendSecurityPanel } = require('../utils/securityMenu');
        await sendSecurityPanel(conn, {
            chatId: ctx.from,
            quoted: ctx.info,
            telegramUserId: ctx.telegramUserId,
            sessionId: ctx.sessionId || conn?._sessionId,
            isGroup: !!ctx.isGroup,
            groupId: ctx.isGroup ? ctx.from : null
        });
    }
};
commands.antifloodhelp = commands.modhelp;
commands.gpseguranca = {
    useCtx: true,
    description: 'Painel de seguranca do grupo (botoes ou texto)',
    usage: 'gpseguranca',
    execute: async (conn, ctx) => {
        if (!ctx.isGroup) {
            const { prefixFromCtx, cmdExample } = require('../utils/configManager');
            const p = prefixFromCtx(ctx);
            return conn.sendMessage(ctx.from, {
                text: `Use DENTRO do grupo WhatsApp.\n\nLa: ${cmdExample(ctx.telegramUserId, 'gpseguranca', { prefix: p })} ou ${cmdExample(ctx.telegramUserId, 'modhelp', { prefix: p })}`
            }, { quoted: ctx.info });
        }
        const { sendSecurityPanel } = require('../utils/securityMenu');
        await sendSecurityPanel(conn, {
            chatId: ctx.from,
            quoted: ctx.info,
            telegramUserId: ctx.telegramUserId,
            sessionId: ctx.sessionId || conn?._sessionId,
            isGroup: true,
            groupId: ctx.from
        });
    }
};
commands.seguranca = commands.gpseguranca;
commands.protecao = commands.gpseguranca;

/** Lista so o que esta LIGADO e pode apagar/banir mensagens */
commands.protecoesativas = {
    useCtx: true,
    description: 'Lista protecoes ON que apagam/banem neste grupo',
    usage: 'protecoesativas',
    execute: async (conn, ctx) => {
        if (!ctx.isGroup) {
            return conn.sendMessage(ctx.from, {
                text: 'Use DENTRO do grupo WhatsApp.\n\nLa: protecoesativas'
            }, { quoted: ctx.info });
        }
        const { buildActiveDangerSummary } = require('../utils/securityMenu');
        const { prefixFromCtx } = require('../utils/configManager');
        const p = prefixFromCtx(ctx);
        const body = buildActiveDangerSummary(ctx.from, ctx.telegramUserId);
        await conn.sendMessage(ctx.from, {
            text: `${body}\n\nPainel completo: ${p}gpseguranca\nAjuda de um item: ${p}protecoeshelp <nome>`
        }, { quoted: ctx.info });
    }
};
commands.oquestaon = commands.protecoesativas;
commands.protecoeson = commands.protecoesativas;

/** Explica o que uma protecao faz (ex.: .protecoeshelp antilink) */
commands.protecoeshelp = {
    useCtx: true,
    description: 'Explica o que uma protecao do grupo faz',
    usage: 'protecoeshelp <nome>',
    execute: async (conn, ctx) => {
        const { findSecurityItem, buildItemHelpText, SECURITY_ITEMS } = require('../utils/securityMenu');
        const { prefixFromCtx } = require('../utils/configManager');
        const p = prefixFromCtx(ctx);
        const q = String(ctx.text || '').trim().split(/\s+/)[0] || '';
        if (!q) {
            const nomes = [];
            for (const sec of SECURITY_ITEMS) {
                for (const it of sec.items) {
                    if (it.info || it.action) continue;
                    if (it.name) nomes.push(it.name);
                }
            }
            return conn.sendMessage(ctx.from, {
                text:
                    `Uso: ${p}protecoeshelp <nome>\n` +
                    `Ex.: ${p}protecoeshelp antilink\n` +
                    `O que esta ON: ${p}protecoesativas\n` +
                    `Painel: ${p}gpseguranca\n\n` +
                    `Nomes: ${nomes.slice(0, 40).join(', ')}…`
            }, { quoted: ctx.info });
        }
        const it = findSecurityItem(q);
        if (!it) {
            return conn.sendMessage(ctx.from, {
                text: `Nao achei "${q}".\nTente: ${p}protecoeshelp antilink\nou abra ${p}gpseguranca`
            }, { quoted: ctx.info });
        }
        await conn.sendMessage(ctx.from, {
            text: buildItemHelpText(it, p) + `\n\nO que esta ON: ${p}protecoesativas`
        }, { quoted: ctx.info });
    }
};

commands.modenable = {
    useCtx: true,
    description: 'Ativa anti-flood/anti-abuso no grupo atual',
    usage: 'modenable',
    execute: async (conn, ctx) => {
        const { assertCanToggle } = require('../utils/protectionStore');
        const gate = assertCanToggle(ctx);
        if (!gate.ok) {
            return conn.sendMessage(ctx.from, { text: gate.text }, { quoted: ctx.info });
        }
        if (!ctx.isGroup) {
            return conn.sendMessage(ctx.from, {
                text:
                    'ANTI-FLOOD — como ativar\n\n' +
                    '1) Entre no grupo WhatsApp\n' +
                    '2) Envie: modenable (com seu prefixo)\n' +
                    '3) Confira com: modstatus\n\n' +
                    'No Telegram: menu Anti-flood → Ativar em grupo'
            }, { quoted: ctx.info });
        }
        await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, 'antiflood', true, ctx.sender);
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
        const p = require('../utils/configManager').prefixFromCtx(ctx);
        await conn.sendMessage(ctx.from, {
            text:
                'Anti-flood ATIVADO neste grupo.\n\n' +
                'O que remove automaticamente (membros comuns):\n' +
                '- View-once / mensagem invisivel (tipo)\n' +
                '- Bolha de pagamento nativa (tipo, nao o texto)\n' +
                '- Protocolos de status abusivos (tipo)\n\n' +
                'Admins do grupo NAO sao afetados.\n\n' +
                `Ver tudo que apaga agora: ${p}protecoesativas\n` +
                `Painel: ${p}gpseguranca | ${p}modstatus\n` +
                `Desativar: ${p}moddisable`
        }, { quoted: ctx.info });
    }
};

commands.moddisable = {
    useCtx: true,
    description: 'Desativa anti-flood no grupo atual',
    usage: 'moddisable',
    execute: async (conn, ctx) => {
        const { assertCanToggle } = require('../utils/protectionStore');
        const gate = assertCanToggle(ctx);
        if (!gate.ok) {
            return conn.sendMessage(ctx.from, { text: gate.text }, { quoted: ctx.info });
        }
        if (!ctx.isGroup) {
            return conn.sendMessage(ctx.from, {
                text: 'Use DENTRO do grupo.\n\nDesativar: moddisable\nNo Telegram: Anti-flood → Desativar em grupo'
            }, { quoted: ctx.info });
        }
        await setGroupSecurityFlag(ctx.from, ctx.telegramUserId, 'antiflood', false, ctx.sender);
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
            text: 'Anti-flood DESATIVADO neste grupo.\n\nReativar: modenable\nStatus: modstatus'
        }, { quoted: ctx.info });
    }
};

commands.modstatus = {
    useCtx: true,
    description: 'Mostra status anti-flood e seguranca do grupo',
    usage: 'modstatus',
    execute: async (conn, ctx) => {
        if (!ctx.isGroup) {
            return conn.sendMessage(ctx.from, {
                text: 'Use dentro do grupo.\n\nPara listar todos os grupos com anti-flood: modlist'
            }, { quoted: ctx.info });
        }
        // Painel interativo (toggle ON/OFF) — mesmo de protecoes/gpseguranca
        const { sendSecurityPanel } = require('../utils/securityMenu');
        await sendSecurityPanel(conn, {
            chatId: ctx.from,
            quoted: ctx.info,
            telegramUserId: ctx.telegramUserId,
            sessionId: ctx.sessionId || conn?._sessionId,
            isGroup: true,
            groupId: ctx.from
        });
    }
};

/** Painel interativo — cada protecao com toggle clicavel (mesmo gpseguranca) */
commands.protecoes = {
    useCtx: true,
    description: 'Painel interativo ON/OFF de cada protecao do grupo',
    usage: 'protecoes',
    execute: async (conn, ctx) => {
        if (!ctx.isGroup) {
            return conn.sendMessage(ctx.from, {
                text: 'Use dentro do grupo.\n\nCada protecao liga/desliga sozinha via painel ou comando.'
            }, { quoted: ctx.info });
        }
        const { sendSecurityPanel } = require('../utils/securityMenu');
        await sendSecurityPanel(conn, {
            chatId: ctx.from,
            quoted: ctx.info,
            telegramUserId: ctx.telegramUserId,
            sessionId: ctx.sessionId || conn?._sessionId,
            isGroup: true,
            groupId: ctx.from
        });
    }
};
commands.statusprotecoes = commands.protecoes;
commands.listprotecoes = commands.protecoes;
commands.painel = commands.protecoes;
commands.painelprotecoes = commands.protecoes;

commands.modlist = {
    useCtx: true,
    description: 'Lista grupos com anti-flood ativo',
    usage: 'modlist',
    execute: async (conn, ctx) => {
        try {
            const { isFreshSessionOwner } = require('../utils/authorization');
            if (!isFreshSessionOwner(ctx)) {
                return conn.sendMessage(ctx.from, { text: 'Apenas o dono pode ver a lista.' }, { quoted: ctx.info });
            }
        } catch (_) {
            if (!sessionOwner(ctx)) {
                return conn.sendMessage(ctx.from, { text: 'Apenas o dono pode ver a lista.' }, { quoted: ctx.info });
            }
        }
        const { listGroupsWithFlag } = require('../utils/protectionStore');
        const enabledGroups = listGroupsWithFlag(ctx.telegramUserId, 'antiflood');
        if (!enabledGroups.length) {
            return conn.sendMessage(ctx.from, {
                text: 'Nenhum grupo com anti-flood ativo.\n\nAtive dentro do grupo com: modenable'
            }, { quoted: ctx.info });
        }
        const lines = enabledGroups.map((g, i) => `${i + 1}. ${g}`);
        await conn.sendMessage(ctx.from, {
            text:
                `Grupos com anti-flood ATIVO (${enabledGroups.length}):\n\n` +
                `${lines.join('\n')}\n\n` +
                `Desativar: entre no grupo e use moddisable`
        }, { quoted: ctx.info });
    }
};

commands.antilink = {
    useCtx: true,
    description: 'Anti-link: apaga links de membros comuns',
    usage: 'antilink on|off',
    execute: async (conn, ctx) => toggleSecurityFlag(conn, ctx, 'antilink', 'Anti-link')
};
commands.antilinkhard = {
    useCtx: true,
    description: 'Anti-link hard: apaga link e remove o membro',
    usage: 'antilinkhard on|off',
    execute: async (conn, ctx) => toggleSecurityFlag(conn, ctx, 'antilinkHard', 'Anti-link HARD')
};
commands.antifake = {
    useCtx: true,
    description: 'Anti-fake: remove numeros estrangeiros ao entrar',
    usage: 'antifake on|off',
    execute: async (conn, ctx) => toggleSecurityFlag(conn, ctx, 'antifake', 'Anti-fake')
};
commands.soadm = {
    useCtx: true,
    description: 'So admins podem usar comandos do bot no grupo',
    usage: 'soadm on|off',
    execute: async (conn, ctx) => toggleSecurityFlag(conn, ctx, 'soadm', 'Somente admin (comandos)')
};
commands.onlyadm = commands.soadm;
commands.blockgp = commands.soadm;
commands.admcmd = commands.soadm;

// ========== DIAGNOSTICO LID/TELEFONE ==========
commands.meujid = {
    useCtx: true,
    description: "Mostra o JID/LID que o WhatsApp enviou e a resolucao de telefone",
    usage: "meujid",
    execute: async (conn, ctx) => {
        const sender = ctx.sender || '';
        const senderAlt = ctx.senderAlt || '';
        const isLid = sender.includes('@lid');
        const linhas = [
            `Sender: ${sender}`,
            `Tipo: ${isLid ? 'LID' : 'JID/telefone'}`,
            `Alt (Baileys): ${senderAlt || 'nenhum'}`
        ];

        if (isLid) {
            const phone = getPhoneForLid(sender);
            linhas.push(`Telefone via cache: ${phone || 'nao encontrado'}`);
            if (senderAlt && !senderAlt.includes('@lid')) {
                linhas.push(`Telefone via alt: ${senderAlt}`);
            }
        } else {
            const lid = getLidForPhone(sender);
            linhas.push(`LID via cache: ${lid || 'nao encontrado'}`);
            if (senderAlt && senderAlt.includes('@lid')) {
                linhas.push(`LID via alt: ${senderAlt}`);
            }
        }

        linhas.push(`Role agora: ${ctx.authRole || '?'}`);
        linhas.push(`Dono: ${sessionOwner(ctx) ? 'sim' : 'nao'}`);
        linhas.push('', 'Cadastre sender OU telefone com addowner (dono).');

        await conn.sendMessage(ctx.from, { text: linhas.join('\n') }, { quoted: ctx.info });
    }
};

// ========== MODO DE ENCAMINHAMENTO DE CANAL (ON/OFF) ==========
commands.forwardoff = {
    useCtx: true,
    description: "Ativa modo OFF (mensagens como encaminhadas de canal)",
    usage: "forwardoff",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem alterar o modo de encaminhamento." }, { quoted: ctx.info });
        
        const sessionId = ctx.sessionId;
        if (!sessionId) return conn.sendMessage(ctx.from, { text: "Sessao nao identificada." }, { quoted: ctx.info });
        
        setForwardMode(sessionId, true);
        await conn.sendMessage(ctx.from, { 
            text: `Modo OFF ativado. Mensagens serao enviadas como encaminhadas do canal oficial.` 
        }, { quoted: ctx.info });
    }
};

commands.forwardon = {
    useCtx: true,
    description: "Ativa modo ON (mensagens normais com botoes)",
    usage: "forwardon",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem alterar o modo de encaminhamento." }, { quoted: ctx.info });
        
        const sessionId = ctx.sessionId;
        if (!sessionId) return conn.sendMessage(ctx.from, { text: "Sessao nao identificada." }, { quoted: ctx.info });
        
        setForwardMode(sessionId, false);
        await conn.sendMessage(ctx.from, { 
            text: `Modo ON ativado. Mensagens serao enviadas normalmente com botoes interativos.` 
        }, { quoted: ctx.info });
    }
};

commands.forwardstatus = {
    useCtx: true,
    description: "Verifica o status do modo de encaminhamento",
    usage: "forwardstatus",
    execute: async (conn, ctx) => {
        const sessionId = ctx.sessionId;
        if (!sessionId) return conn.sendMessage(ctx.from, { text: "Sessao nao identificada." }, { quoted: ctx.info });
        
        const status = getForwardModeStatus(sessionId);
        const statusText = status === 'OFF' ? 'OFF (encaminhado)' : 'ON (normal)';
        
        await conn.sendMessage(ctx.from, { 
            text: `Modo de encaminhamento: ${statusText}` 
        }, { quoted: ctx.info });
    }
};

commands.forwardclear = {
    useCtx: true,
    description: "Remove o modo de encaminhamento da sessao",
    usage: "forwardclear",
    execute: async (conn, ctx) => {
        if (!sessionOwner(ctx)) return conn.sendMessage(ctx.from, { text: "Apenas donos podem remover o modo de encaminhamento." }, { quoted: ctx.info });
        
        const sessionId = ctx.sessionId;
        if (!sessionId) return conn.sendMessage(ctx.from, { text: "Sessao nao identificada." }, { quoted: ctx.info });
        
        clearForwardMode(sessionId);
        await conn.sendMessage(ctx.from, { 
            text: `Modo de encaminhamento removido. Mensagens serao enviadas normalmente.` 
        }, { quoted: ctx.info });
    }
};

// ========== INTENT ROUTER ==========
commands.intentrouter = {
    useCtx: true,
    description: "Liga/desliga o Intent Router (deteccao automatica sem prefixo)",
    usage: "intentrouter [on|off|status]",
    execute: async (conn, ctx) => {
        const { getIntentConfig, setIntentRouterEnabled } = require("../utils/configManager");
        const arg = String(ctx.args?.[0] || ctx.text || '').trim().toLowerCase();
        const uid = ctx.telegramUserId;

        if (!arg || arg === 'status') {
            const cfg = getIntentConfig(uid);
            const { stripAccents, previewText } = require('../utils/typography');
            return conn.sendMessage(ctx.from, {
                text:
                    `${previewText('FRASE NATURAL')}\n\n` +
                    stripAccents(
                        `Quando ON, o bot entende pedido sem prefixo\n` +
                        `(ex: "quero ouvir X" ou link solto).\n\n` +
                        `Status: ${cfg.enabled ? 'ON' : 'OFF'}\n` +
                        `IA local: ${cfg.allowNlu !== false ? 'on' : 'off'}\n` +
                        `Links automaticos: ${cfg.allowUrls ? 'on' : 'off'}\n` +
                        `CPF/tel automatico: ${cfg.allowIdentifiers ? 'on' : 'off'}\n\n` +
                        `Uso: ${require('../utils/configManager').prefixFromCtx(ctx)}intentrouter on|off`
                    )
            }, { quoted: ctx.info });
        }

        if (!sessionVip(ctx)) {
            return conn.sendMessage(ctx.from, { text: "Apenas dono/VIP." }, { quoted: ctx.info });
        }

        if (arg === 'on' || arg === 'off') {
            const cfg = setIntentRouterEnabled(uid, arg === 'on');
            return conn.sendMessage(ctx.from, {
                text: `Frase natural ${cfg.enabled ? 'ativada' : 'desativada'}.`
            }, { quoted: ctx.info });
        }

        return conn.sendMessage(ctx.from, { text: `Uso: ${require('../utils/configManager').prefixFromCtx(ctx)}intentrouter on|off|status` }, { quoted: ctx.info });
    }
};

module.exports = { commands };