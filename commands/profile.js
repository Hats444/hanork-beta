const logger = require("../logger");
const { prepareWAMessageMedia } = require("@systemzero/baileys");
const axios = require("axios");
const fs = require("fs");

const commands = {};

commands.setname = {
    description: "Altera o nome do perfil",
    usage: "setname <novo nome>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!q) return conn.sendMessage(from, { text: "Digite o novo nome." }, { quoted: info });
        try {
            await conn.updateProfileName(q);
            await conn.sendMessage(from, { text: `Nome alterado para: ${q}` }, { quoted: info });
        } catch (e) {
            logger.logErro("setname", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.setbio = {
    description: "Altera a bio do perfil",
    usage: "setbio <nova bio>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!q) return conn.sendMessage(from, { text: "Digite a nova bio." }, { quoted: info });
        try {
            await conn.updateProfileStatus(q);
            await conn.sendMessage(from, { text: "Bio alterada." }, { quoted: info });
        } catch (e) {
            logger.logErro("setbio", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.setprofilepic = {
    description: "Altera a foto do perfil (URL ou local)",
    usage: "setprofilepic <url ou caminho>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!q) return conn.sendMessage(from, { text: "Forneca URL ou caminho." }, { quoted: info });
        try {
            let buffer;
            if (q.startsWith("http")) {
                const resp = await axios.get(q, { responseType: "arraybuffer" });
                buffer = Buffer.from(resp.data);
            } else {
                buffer = await fs.promises.readFile(q);
            }
            const prep = await prepareWAMessageMedia({ image: buffer }, { upload: conn.waUploadToServer });
            await conn.updateProfilePicture(conn.user.id, prep.imageMessage.url);
            await conn.sendMessage(from, { text: "Foto alterada." }, { quoted: info });
        } catch (e) {
            logger.logErro("setprofilepic", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.block = {
    useCtx: true,
    description: "Bloqueia o user de usar comandos do bot (reply / @ / numero)",
    usage: "block (responda | @mencao | numero)",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) {
            return conn.sendMessage(ctx.from, { text: "Apenas o dono da sessao." }, { quoted: ctx.info });
        }
        const {
            collectTargetIdentities,
            blockUser,
            enrichFromGroup,
            maskId
        } = require("../utils/cmdBlock");
        let ids = collectTargetIdentities(ctx);
        ids = await enrichFromGroup(conn, ctx.from, ids);
        const r = blockUser(ctx.telegramUserId, ids);
        if (!r.ok) {
            const why =
                r.reason === 'nao_bloqueia_dono'
                    ? 'Nao da pra bloquear o dono da sessao.'
                    : 'Responda a msg, mencione com @ ou mande o numero / LID.';
            return conn.sendMessage(ctx.from, { text: why }, { quoted: ctx.info });
        }
        const shown = (r.ids || []).slice(0, 3).map(maskId).join(' | ');
        await conn.sendMessage(ctx.from, {
            text:
                (r.already ? 'Ja estava bloqueado. Identidades atualizadas.\n' : 'Bloqueado: nao usa mais comandos do bot.\n') +
                shown +
                '\nDesfazer: .unblock (responda / @ / numero / lista)'
        }, { quoted: ctx.info });
    }
};
commands.bloquear = commands.block;
commands.blockcmd = commands.block;
commands.blockuser = commands.block;

async function showUnblockPanel(conn, ctx) {
    const { sendButtonsWithImage } = require("../helpers");
    const { listBlocked, maskId } = require("../utils/cmdBlock");
    const list = listBlocked(ctx.telegramUserId);
    if (!list.length) {
        return conn.sendMessage(ctx.from, { text: "Ninguem bloqueado de comandos." }, { quoted: ctx.info });
    }
    const lines = list.map((e, i) => `${i + 1}. ${(e.ids || []).slice(0, 3).map(maskId).join(' | ')}`);
    const buttons = list.slice(0, 8).map((e, i) => ({
        id: `cmdunblock_${i + 1}`,
        label: `Liberar ${i + 1}`
    }));
    buttons.push({ id: "cmdunblock_all", label: "Liberar todos" });
    await sendButtonsWithImage(
        conn,
        ctx.from,
        `BLOQUEADOS DE COMANDOS (${list.length})\n\n` +
        `${lines.join('\n')}\n\n` +
        `Clique pra liberar, ou:\n` +
        `${require("../utils/configManager").prefixFromCtx(ctx)}unblock (responda / @ / numero)\n` +
        `${require("../utils/configManager").prefixFromCtx(ctx)}unblock 1\n` +
        `${require("../utils/configManager").prefixFromCtx(ctx)}unblockall`,
        buttons,
        "Hanork Bot",
        ctx.info,
        "menu.jpg",
        "LIBERAR",
        "Clique abaixo",
        ctx.telegramUserId
    );
}

commands.unblock = {
    useCtx: true,
    description: "Libera o user pra usar comandos de novo",
    usage: "unblock (responda | @ | numero | indice | all)",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) {
            return conn.sendMessage(ctx.from, { text: "Apenas o dono da sessao." }, { quoted: ctx.info });
        }
        const {
            collectTargetIdentities,
            unblockUser,
            unblockByIndex,
            unblockAll,
            enrichFromGroup,
            maskId
        } = require("../utils/cmdBlock");
        const raw = String(ctx.text || '').trim();
        const low = raw.toLowerCase();

        if (low === 'all' || low === 'todos' || low === '*') {
            const r = unblockAll(ctx.telegramUserId);
            if (!r.ok) {
                return conn.sendMessage(ctx.from, { text: "Ninguem bloqueado de comandos." }, { quoted: ctx.info });
            }
            return conn.sendMessage(ctx.from, {
                text: `Liberados: ${r.count} user(s). Ja podem usar o bot de novo.`
            }, { quoted: ctx.info });
        }

        if (/^\d{1,3}$/.test(raw)) {
            const r = unblockByIndex(ctx.telegramUserId, parseInt(raw, 10));
            if (!r.ok) {
                return conn.sendMessage(ctx.from, {
                    text: 'Indice invalido. Use .blocklist e depois .unblock 1'
                }, { quoted: ctx.info });
            }
            await conn.sendMessage(ctx.from, {
                text: `Liberado: ${(r.ids || []).slice(0, 3).map(maskId).join(' | ')}`
            }, { quoted: ctx.info });
            return showUnblockPanel(conn, ctx);
        }

        let ids = collectTargetIdentities(ctx);
        ids = await enrichFromGroup(conn, ctx.from, ids);
        if (!ids.length) {
            return showUnblockPanel(conn, ctx);
        }
        const r = unblockUser(ctx.telegramUserId, ids);
        if (!r.ok) {
            const why =
                r.reason === 'nao_estava'
                    ? 'Esse user nao esta na lista de bloqueio de comandos.\nUse .blocklist'
                    : 'Responda a msg, mencione com @, mande o numero, ou .unblock sem argumento pra ver a lista.';
            return conn.sendMessage(ctx.from, { text: why }, { quoted: ctx.info });
        }
        await conn.sendMessage(ctx.from, {
            text: `Liberado: ${(r.ids || []).slice(0, 3).map(maskId).join(' | ')}`
        }, { quoted: ctx.info });
    }
};
commands.desbloquear = commands.unblock;
commands.unblockcmd = commands.unblock;
commands.liberar = commands.unblock;

commands.unblockall = {
    useCtx: true,
    description: "Libera todos os users bloqueados de comandos",
    usage: "unblockall",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) {
            return conn.sendMessage(ctx.from, { text: "Apenas o dono da sessao." }, { quoted: ctx.info });
        }
        ctx.text = 'all';
        return commands.unblock.execute(conn, ctx);
    }
};
commands.liberartodos = commands.unblockall;
commands.desbloquearall = commands.unblockall;

commands.blocklist = {
    useCtx: true,
    description: "Lista quem nao pode usar comandos do bot",
    usage: "blocklist",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) {
            return conn.sendMessage(ctx.from, { text: "Apenas o dono da sessao." }, { quoted: ctx.info });
        }
        return showUnblockPanel(conn, ctx);
    }
};
commands.listblock = commands.blocklist;
commands.bloqueados = commands.blocklist;

commands.blockwa = {
    description: "Bloqueia o contato no WhatsApp (nao e block de comando)",
    usage: "blockwa <jid>",
    execute: async (conn, from, info, args, q, isDono) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!q) return conn.sendMessage(from, { text: "JID do contato." }, { quoted: info });
        try {
            await conn.updateBlockStatus(q, "block");
            await conn.sendMessage(from, { text: `Bloqueado no WhatsApp: ${q}` }, { quoted: info });
        } catch (e) {
            logger.logErro("blockwa", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.unblockwa = {
    description: "Desbloqueia o contato no WhatsApp",
    usage: "unblockwa <jid>",
    execute: async (conn, from, info, args, q, isDono) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!q) return conn.sendMessage(from, { text: "JID do contato." }, { quoted: info });
        try {
            await conn.updateBlockStatus(q, "unblock");
            await conn.sendMessage(from, { text: `Desbloqueado no WhatsApp: ${q}` }, { quoted: info });
        } catch (e) {
            logger.logErro("unblockwa", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.presence = {
    description: "Define presenca (typing, available, unavailable)",
    usage: "presence <typing|available|unavailable>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!q || !["typing", "available", "unavailable"].includes(q)) {
            return conn.sendMessage(from, { text: "Use: typing, available, unavailable" }, { quoted: info });
        }
        try {
            if (typeof conn.sendPresenceUpdate !== 'function') {
                return conn.sendMessage(from, { text: "Presenca indisponivel neste canal." }, { quoted: info });
            }
            await conn.sendPresenceUpdate(q, from);
            await conn.sendMessage(from, { text: `Presenca: ${q}` }, { quoted: info });
        } catch (e) {
            logger.logErro("presence", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

module.exports = { commands };