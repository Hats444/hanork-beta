const { requireSessionOwner } = require('../../utils/authorization');
// commands/divulgar/grupos.js — addgrupo e a unica forma de marcar grupo de divulgacao
const { getGruposParaDivulgar, adicionarGrupo, removerGrupo, limparGrupos, setModoGrupos } = require("../../utils/divulgacao");
const { sendDivulgacaoButtons: sendButtonsWithImage, sendDivulgacaoMessage, sendAddgrupoPrivateReply } = require("../../utils/divulgacaoReply");

const commands = {};

function parseOnOff(text) {
    try {
        const shared = require('../../utils/protectionStore').parseOnOff(text);
        if (shared !== null) return shared;
    } catch (_) { /* fallback abaixo */ }
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    const first = t.split(/\s+/)[0];
    if (/^(add|adicionar)$/.test(first)) return true;
    if (/^(remove|remover)$/.test(first)) return false;
    return null;
}

async function syncFlag(groupJid, telegramUserId, enabled) {
    try {
        const { setGroupSecurityFlag } = require('../../utils/moderation');
        await setGroupSecurityFlag(groupJid, telegramUserId, 'grupoDivulgacao', !!enabled);
    } catch (_) { /* ignore */ }
}

/**
 * Marca/desmarca o grupo atual na lista de divulgacao (+ flag).
 * Uso: addgrupo | addgrupo on | addgrupo off
 * Aliases: grupodivulgacao, divgrupo
 */
commands.addgrupo = {
    useCtx: true,
    description: "Marca/desmarca este grupo na lista de divulgacao",
    usage: "addgrupo [on|off]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        if (!ctx.isGroup) {
            return sendDivulgacaoMessage(conn, ctx, { text: 'Use dentro do grupo WhatsApp.' });
        }

        const { getGroupSecurity } = require('../../utils/moderation');
        const parsed = parseOnOff(ctx.text) ?? parseOnOff((ctx.args || [])[0]);
        let enabled;
        if (parsed === null) {
            const cur = !!getGroupSecurity(ctx.from, ctx.telegramUserId).grupoDivulgacao;
            enabled = !cur;
        } else {
            enabled = parsed;
        }

        setModoGrupos(ctx.telegramUserId, 'especificos');
        if (enabled) {
            adicionarGrupo(ctx.telegramUserId, ctx.from);
        } else {
            removerGrupo(ctx.telegramUserId, ctx.from);
        }
        await syncFlag(ctx.from, ctx.telegramUserId, enabled);

        if (ctx.isInteractive) {
            const { sendSecurityPanel } = require('../../utils/securityMenu');
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

        const data = getGruposParaDivulgar(ctx.telegramUserId);
        const n = data.grupos.length;
        const state = enabled ? 'ATIVO' : 'INATIVO';
        await sendAddgrupoPrivateReply(conn, ctx, {
            text:
                `Grupo de divulgacao: ${state}. O grupo so viu o react.\n` +
                `Lista oficial: ${n} grupo${n === 1 ? '' : 's'}.\n` +
                `Convites da fila entram sozinhos nesta lista.\n` +
                `Dispare daqui (${require('../../utils/configManager').prefixFromCtx(ctx)}divmenu).`,
            buttons: [
                { id: "gm_home", label: "Gerenciar grupos" },
                { id: "div_iniciar", label: "Iniciar" },
                { id: "div_config", label: "Configurar" }
            ],
            imageName: enabled ? 'ADICIONAR' : 'REMOVER'
        });
    }
};

// Mesma logica — nao duplicar handler
commands.grupodivulgacao = commands.addgrupo;
commands.divgrupo = commands.addgrupo;

commands.removergrupo = {
    useCtx: true,
    description: "Remove o grupo atual da lista de divulgacao",
    usage: "removergrupo",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        if (!ctx.isGroup) {
            return sendDivulgacaoMessage(conn, ctx, { text: 'Use dentro do grupo WhatsApp.' });
        }
        ctx.text = 'off';
        return commands.addgrupo.execute(conn, ctx);
    }
};

commands.divgrupos = {
    useCtx: true,
    description: "Gerenciar grupos",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const { handleGroupManagerClick } = require('../groupManager');
        await handleGroupManagerClick(conn, ctx, 'gm_home');
    }
};

commands.div_ver_grupos = {
    useCtx: true,
    description: "Ver grupos adicionados",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const data = getGruposParaDivulgar(ctx.telegramUserId);
        const n = data.grupos.length;
        await sendButtonsWithImage(
            conn,
            ctx.from,
            n
                ? `LISTA OFICIAL\n\n${n} grupo${n === 1 ? '' : 's'} (addgrupo + convites aceitos).\nCanal oficial nao entra nesta lista.`
                : 'LISTA VAZIA\n\nNenhum grupo. Use addgrupo ou deixe o bot entrar pelos convites da fila.',
            [
                { id: "gm_home", label: "Voltar" },
                { id: "div_limpar_grupos", label: "Limpar" },
                { id: "div_iniciar", label: "Iniciar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "LISTA",
            "Clique abaixo",
            ctx.telegramUserId
        );
    }
};

commands.div_limpar_grupos = {
    useCtx: true,
    description: "Limpa a lista de grupos",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        limparGrupos(ctx.telegramUserId);
        await sendButtonsWithImage(
            conn,
            ctx.from,
            "LISTA DE GRUPOS LIMPA!",
            [
                { id: "gm_home", label: "Gerenciar" },
                { id: "div_iniciar", label: "Iniciar" },
                { id: "div_config", label: "Configurar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "LIMPO",
            "Clique abaixo",
            ctx.telegramUserId
        );
    }
};

// Legado: botoes "todos/especificos" redirecionam — so existe lista
commands.div_modo_todos = {
    useCtx: true,
    description: "Divulgacao so na lista (legado)",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        setModoGrupos(ctx.telegramUserId, 'especificos');
        return commands.divgrupos.execute(conn, ctx);
    }
};

commands.div_modo_especificos = commands.div_modo_todos;

module.exports = { commands };
