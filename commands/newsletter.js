const logger = require("../logger");
const { safeRelayMessage } = require("../safeRelay");

const commands = {};

commands.createchannel = {
    description: "Cria um canal (newsletter)",
    usage: "createchannel <nome> [descricao]",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        const parts = q.split("|");
        const name = parts[0]?.trim();
        if (!name) return conn.sendMessage(from, { text: "Nome do canal." }, { quoted: info });
        const desc = parts[1]?.trim() || "";
        try {
            const result = await conn.newsletterCreate(name, desc);
            if (!result || result === null) {
                throw new Error("Falha ao criar canal. Verifique permissao ou limite de canais.");
            }
            const channelId = result.id || result.jid || result.gid || 'desconhecido';
            await conn.sendMessage(from, { text: `Canal criado: ${channelId}` }, { quoted: info });
        } catch (e) {
            logger.logErro("createchannel", e.message);
            console.error(`[createchannel] ${e.stack}`);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.deletechannel = {
    description: "Exclui um canal",
    usage: "deletechannel <jid do canal>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!q) return conn.sendMessage(from, { text: "JID do canal." }, { quoted: info });
        try {
            await conn.newsletterDelete(q);
            await conn.sendMessage(from, { text: "Canal excluido." }, { quoted: info });
        } catch (e) {
            logger.logErro("deletechannel", e.message);
            console.error(`[deletechannel] ${e.stack}`);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.followchannel = {
    description: "Segue um canal",
    usage: "followchannel <jid do canal>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!q) return conn.sendMessage(from, { text: "JID do canal." }, { quoted: info });
        try {
            await conn.newsletterFollow(q);
            await conn.sendMessage(from, { text: "Seguindo canal." }, { quoted: info });
        } catch (e) {
            logger.logErro("followchannel", e.message);
            console.error(`[followchannel] ${e.stack}`);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.unfollowchannel = {
    description: "Para de seguir um canal",
    usage: "unfollowchannel <jid do canal>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!q) return conn.sendMessage(from, { text: "JID do canal." }, { quoted: info });
        try {
            await conn.newsletterUnfollow(q);
            await conn.sendMessage(from, { text: "Deixou de seguir." }, { quoted: info });
        } catch (e) {
            logger.logErro("unfollowchannel", e.message);
            console.error(`[unfollowchannel] ${e.stack}`);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.channelinfo = {
    description: "Obtem metadados do canal (jid, link ou invite)",
    usage: "channelinfo <jid|link|invite>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!q) return conn.sendMessage(from, { text: "Informe jid@newsletter, link ou codigo do canal." }, { quoted: info });
        try {
            const { dissectTarget } = require("../utils/dissecarTarget");
            const result = await dissectTarget(conn, q.trim());
            if (result.type !== "newsletter") {
                return conn.sendMessage(from, { text: "Alvo nao e canal. Use dissecar para grupo/PV." }, { quoted: info });
            }
            const f = result.fields || {};
            const txt =
                `Canal: ${f.name || "?"}\n` +
                `ID: ${f.id || result.jid}\n` +
                `Invite: ${f.invite || "?"}\n` +
                `Link: ${f.inviteLink || "?"}\n` +
                `Inscritos: ${f.subscribers ?? "?"}\n` +
                `${f.description || ""}`;
            await conn.sendMessage(from, { text: txt }, { quoted: info });
        } catch (e) {
            logger.logErro("channelinfo", e.message);
            console.error(`[channelinfo] ${e.stack}`);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.channelsubscribers = {
    description: "Lista inscritos do canal",
    usage: "channelsubscribers <jid do canal>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        if (!q) return conn.sendMessage(from, { text: "JID do canal." }, { quoted: info });
        try {
            const subscribers = await conn.newsletterSubscribers(q);
            const txt = `Inscritos: ${subscribers.length}\n${subscribers.slice(0, 10).join("\n")}`;
            await conn.sendMessage(from, { text: txt }, { quoted: info });
        } catch (e) {
            logger.logErro("channelsubscribers", e.message);
            console.error(`[channelsubscribers] ${e.stack}`);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

const channelSendMod = require("../utils/channelSend");
const channelPartnersMod = require("../utils/channelPartners");
const divulgacaoJobMod = require("../utils/divulgacaoJob");
const typographyMod = require("../utils/typography");

function pickFn(mod, names) {
    for (let i = 0; i < names.length; i++) {
        const v = mod[names[i]];
        if (typeof v === "function") return v;
    }
    throw new Error("api ausente: " + names.join("|") + " tem=" + Object.keys(mod).join(","));
}

const resolveJid = pickFn(channelSendMod, ["resolveJid", "resolveJid"]);
const extractPayload = pickFn(channelSendMod, ["extractPayload", "extractPayload"]);
const postOne = pickFn(channelSendMod, ["postOne", "postOne"]);
const sendSleep = pickFn(channelSendMod, ["sleep", "sleep"]);
const formatReport = pickFn(typographyMod, ["formatReportBlock", "formatReportBlock"]);
const jobKeyFn = pickFn(divulgacaoJobMod, ["jobKey", "jobKey"]);
const tryStartFn = pickFn(divulgacaoJobMod, ["tryStart", "tryStart"]);
const shouldAbortFn = pickFn(divulgacaoJobMod, ["shouldAbort", "shouldAbort"]);
const markProgressFn = pickFn(divulgacaoJobMod, ["markProgress", "markProgress"]);
const finishJobFn = pickFn(divulgacaoJobMod, ["finish", "finish"]);
const listPartnersFn = pickFn(channelPartnersMod, ["listPartners", "listPartners"]);
const syncLiveFn = pickFn(channelPartnersMod, ["syncLiveNames", "syncLiveNames"]);
const parseIdsFn = pickFn(channelPartnersMod, ["parseIdList", "parseIdList"]);
const getByTargetFn = pickFn(channelPartnersMod, ["getByInviteOrJid", "getByInviteOrJid"]);
const seedFn = pickFn(channelPartnersMod, ["seedIfEmpty", "seedIfEmpty"]);
const addPartnerFn = pickFn(channelPartnersMod, ["addPartner", "addPartner"]);
const updatePartnerFn = pickFn(channelPartnersMod, ["updatePartner", "updatePartner"]);
const deactivateFn = pickFn(channelPartnersMod, ["deactivatePartner", "deactivatePartner"]);
const typeLabelFn = pickFn(channelPartnersMod, ["typeLabel", "typeLabel"]);

function usageChannelPost() {
    return formatReport("channelpost", [
        "channelpost [texto]  → canal padrao",
        "channelpost all [texto]",
        "channelpost <id,id> [texto]",
        "channelpost <link|jid> [texto]",
        "Sem alvo = teu canal (id ja gravado). So pede link/id se voce passar.",
        "Foto/video: envie junto ou responda a midia.",
        "all = todos os parceiros ativos."
    ]);
}

function defaultChannelJid(ctx) {
    try {
        const { getWhatsAppChannelId } = require("../utils/configManager");
        const jid = getWhatsAppChannelId((ctx && (ctx.telegramUserId || ctx.telegramUserId)) || '');
        if (jid) return jid;
    } catch (_) { /* ignore */ }
    try {
        return require("../utils/canal").getCanalId();
    } catch (_) {
        return "";
    }
}

function isChannelTargetToken(token) {
    const t = String(token || "").trim();
    if (!t) return false;
    const low = t.toLowerCase();
    if (low === "all" || low === "todos" || low === "parceiros" || low === "ativos") return true;
    if (/@newsletter$/i.test(t)) return true;
    if (/whatsapp\.com\/channel\//i.test(t)) return true;
    if (/^\d{10,}(@newsletter)?$/i.test(t)) return true;
    if (/^[\d,\s]+$/.test(t) && parseIdsFn(t).length) return true;
    if (/^[A-Za-z0-9_-]{16,}$/.test(t) && !/\s/.test(t)) return true;
    return false;
}

function chatId(ctx) { return ctx.from || ctx.from; }
function quotedInfo(ctx) { return ctx.info || ctx.info; }
function ownerOk(ctx) { return !!(ctx.isOwner || ctx.isOwner); }
function vipOk(ctx) { return !!(ctx.isVip || ctx.isVip || ownerOk(ctx)); }

async function replyBlock(conn, ctx, title, lines) {
    const text = formatReport(title, lines);
    try {
        await conn.sendMessage(chatId(ctx), { text: text }, { quoted: quotedInfo(ctx) });
        return;
    } catch (e) {
        logger.logAviso("channelpost reply: " + (e && e.message ? e.message : e));
    }
    try {
        const { resolveOwnerPrivateJid } = require("../utils/divulgacaoReply");
        const pv = resolveOwnerPrivateJid(ctx, conn);
        if (pv && String(pv) !== String(chatId(ctx))) {
            await conn.sendMessage(pv, { text: text });
        }
    } catch (_) { /* ignore */ }
}

async function resolvePostTargets(conn, first, rest) {
    const token = String(first || "").trim().toLowerCase();
    if (!token || token === "all" || token === "todos" || token === "parceiros" || token === "ativos") {
        const rows = await syncLiveFn(conn, await listPartnersFn(false));
        return { rows, caption: rest };
    }
    if (/^[\d,\s]+$/.test(token) && parseIdsFn(token).length) {
        const ids = new Set(parseIdsFn(token + (rest.match(/^[\d,\s]+/) ? " " + rest.split(/\s+/).filter((p) => /^\d+$/.test(p)).join(" ") : "")));
        const extraIds = parseIdsFn(rest);
        extraIds.forEach((n) => ids.add(n));
        const all = await syncLiveFn(conn, await listPartnersFn(true));
        const rows = all.filter((r) => ids.has(r.id));
        const caption = rest.replace(/^[\d,\s]+/, "").trim();
        return { rows, caption };
    }
    const found = await getByTargetFn(first);
    if (found) {
        const rows = await syncLiveFn(conn, [found]);
        return { rows, caption: rest };
    }
    const resolved = await resolveJid(conn, first);
    if (!resolved.ok) return { error: resolved.reason || "alvo invalido" };
    return {
        rows: [{ id: 0, jid: resolved.jid, name: resolved.name || first, invite: resolved.invite || "", link: first }],
        caption: rest
    };
}

commands.channelpost = {
    useCtx: true,
    description: "Posta texto/foto/video no canal ou nos parceiros ativos",
    usage: "channelpost [texto] | all | <id,id> | <link|jid> [texto]",
    execute: async (conn, ctx) => {
        if (!ownerOk(ctx) && !vipOk(ctx)) {
            return replyBlock(conn, ctx, "channelpost", ["Apenas dono/VIP."]);
        }
        const args = Array.isArray(ctx.args) ? ctx.args : String(ctx.text || "").trim().split(/\s+/).filter(Boolean);
        let first = args[0] || "";
        let rest = args.slice(1).join(" ").trim();
        let resolved;
        if (!isChannelTargetToken(first)) {
            const jid = defaultChannelJid(ctx);
            if (!jid) {
                return replyBlock(conn, ctx, "channelpost", ["Canal padrao nao configurado.", "Passe o link/jid uma vez ou use WHATSAPP_CANAL_ID."]);
            }
            resolved = {
                rows: [{ id: 0, jid, name: "canal padrao", invite: "", link: "" }],
                caption: args.join(" ").trim()
            };
        } else {
            try {
                resolved = await resolvePostTargets(conn, first, rest);
            } catch (e) {
                return replyBlock(conn, ctx, "channelpost", ["Falha ao resolver alvos: " + (e.message || e)]);
            }
        }
        if (resolved.error) return replyBlock(conn, ctx, "channelpost", [resolved.error]);
        const rows = (resolved.rows || []).filter((r) => r.jid || r.invite);
        if (!rows.length) {
            return replyBlock(conn, ctx, "channelpost", ["Nenhum canal alvo. Use channelparceiros e channelparceiroadd."]);
        }

        const payload = await extractPayload(conn, ctx, resolved.caption);
        if (!payload) {
            return replyBlock(conn, ctx, "channelpost", [
                "Nao achei texto/midia pra postar.",
                "Responda uma foto, video, texto ou o menu do bot.",
                "Canal nao aceita botao nativo — botoes de URL viram link no texto."
            ]);
        }
        const bytes = (payload.image && payload.image.length) || (payload.video && payload.video.length) || 0;
        if (bytes > 16 * 1024 * 1024) {
            return replyBlock(conn, ctx, "channelpost", ["Midia acima de 16MB. Comprime e tenta de novo."]);
        }

        const jobKey = jobKeyFn(ctx.telegramUserId, ctx.sessionId, "channelpost");
        const started = tryStartFn(jobKey, { tipo: "channelpost", grupos: rows.length });
        if (!started.ok) {
            return replyBlock(conn, ctx, "channelpost", ["Ja tem um disparo de canal rodando. Espera terminar."]);
        }

        const ok = [];
        const fail = [];
        try {
            for (let i = 0; i < rows.length; i++) {
                if (shouldAbortFn(jobKey)) {
                    fail.push({ name: "lote", reason: "abortado" });
                    break;
                }
                const row = rows[i];
                let jid = row.jid;
                if (!jid && row.invite) {
                    const r = await resolveJid(conn, row.invite);
                    if (r.ok) jid = r.jid;
                }
                const label = row.name || jid || ("#" + row.id);
                if (!jid) {
                    fail.push({ name: label, reason: "sem jid (siga o canal nesta sessao)" });
                    continue;
                }
                try {
                    if (typeof conn.newsletterFollow === "function") {
                        try { await conn.newsletterFollow(jid); } catch (_) { /* ja segue ou sem permissao */ }
                    }
                    await postOne(conn, jid, payload);
                    ok.push(label);
                } catch (e) {
                    fail.push({ name: label, reason: String(e.message || e).slice(0, 80) });
                }
                markProgressFn(jobKey, i + 1);
                if (i < rows.length - 1) await sendSleep(1400);
            }
        } finally {
            finishJobFn(jobKey);
        }

        const lines = [
            "ok " + ok.length + " / " + rows.length
        ];
        if (ok.length) lines.push("enviados: " + ok.join(", "));
        if (fail.length) {
            lines.push("falhas:");
            fail.forEach((f) => lines.push("- " + f.name + ": " + f.reason));
        }
        await replyBlock(conn, ctx, "channelpost", lines);
    }
};
commands.channelpost = commands.channelpost;

commands.channelparceiros = {
    useCtx: true,
    description: "Lista canais parceiros (nome vivo, dono, tipo, link)",
    usage: "channelparceiros",
    execute: async (conn, ctx) => {
        if (!ownerOk(ctx)) return replyBlock(conn, ctx, "parceiros", ["Apenas dono."]);
        await seedFn();
        const rows = await syncLiveFn(conn, await listPartnersFn(true));
        if (!rows.length) return replyBlock(conn, ctx, "parceiros", ["Nenhum parceiro."]);
        const lines = rows.map((r) => {
            const st = r.status === "active" ? "ativo" : "inativo";
            const dono = r.ownerName || "(dono em branco)";
            return "#" + r.id + " " + (r.name || r.invite) + " | " + dono + " | " + typeLabelFn(r.type) + " | " + st + "\n" + (r.link || r.jid);
        });
        await replyBlock(conn, ctx, "parceiros", lines);
    }
};
commands.parceiros = commands.channelparceiros;
commands.listparceiros = commands.channelparceiros;

commands.channelparceiroadd = {
    useCtx: true,
    description: "Cadastra canal parceiro (fixa ou troca pontual)",
    usage: "channelparceiroadd <link|jid> [fixa|troca] [dono]",
    execute: async (conn, ctx) => {
        if (!ownerOk(ctx)) return replyBlock(conn, ctx, "parceiro", ["Apenas dono."]);
        const args = ctx.args || [];
        const target = args[0];
        if (!target) {
            return replyBlock(conn, ctx, "parceiro", [
                "channelparceiroadd <link|jid> [fixa|troca] [nome do dono]"
            ]);
        }
        const type = (args[1] === "troca" || args[1] === "fixa") ? args[1] : "fixa";
        const ownerName = (args[1] === "troca" || args[1] === "fixa")
            ? args.slice(2).join(" ").trim()
            : args.slice(1).join(" ").trim();
        const resolved = await resolveJid(conn, target);
        try {
            const row = await addPartnerFn({
                invite: target,
                jid: resolved.ok ? resolved.jid : "",
                nameHint: resolved.name || "",
                ownerName: ownerName,
                type: type
            });
            await replyBlock(conn, ctx, "parceiro", [
                "salvo #" + row.id,
                "nome: " + (resolved.name || row.name || row.invite),
                "tipo: " + typeLabelFn(row.type),
                "link: " + row.link
            ]);
        } catch (e) {
            await replyBlock(conn, ctx, "parceiro", [e.message || String(e)]);
        }
    }
};
commands.addparceiro = commands.channelparceiroadd;

commands.channelparceiroedit = {
    useCtx: true,
    description: "Edita dono, tipo ou status do parceiro",
    usage: "channelparceiroedit <id> dono|tipo|status <valor>",
    execute: async (conn, ctx) => {
        if (!ownerOk(ctx)) return replyBlock(conn, ctx, "parceiro", ["Apenas dono."]);
        const args = ctx.args || [];
        const id = Number(args[0]);
        const field = String(args[1] || "").toLowerCase();
        const value = args.slice(2).join(" ").trim();
        if (!id || !field) {
            return replyBlock(conn, ctx, "parceiro", [
                "channelparceiroedit <id> dono <nome>",
                "channelparceiroedit <id> tipo fixa|troca",
                "channelparceiroedit <id> status active|inactive"
            ]);
        }
        const patch = {};
        if (field === "dono" || field === "owner") patch.ownerName = value;
        else if (field === "tipo" || field === "type") patch.type = value;
        else if (field === "status") patch.status = value === "ativo" ? "active" : (value === "inativo" ? "inactive" : value);
        else return replyBlock(conn, ctx, "parceiro", ["Campo invalido. Use dono, tipo ou status."]);
        const row = await updatePartnerFn(id, patch);
        if (!row) return replyBlock(conn, ctx, "parceiro", ["id nao encontrado"]);
        await replyBlock(conn, ctx, "parceiro", [
            "#" + row.id + " " + (row.name || row.invite),
            "dono: " + (row.ownerName || "(em branco)"),
            "tipo: " + typeLabelFn(row.type),
            "status: " + row.status
        ]);
    }
};
commands.editparceiro = commands.channelparceiroedit;

commands.channelparceirooff = {
    useCtx: true,
    description: "Desativa parceiro (mantem historico)",
    usage: "channelparceirooff <id>",
    execute: async (conn, ctx) => {
        if (!ownerOk(ctx)) return replyBlock(conn, ctx, "parceiro", ["Apenas dono."]);
        const id = Number((ctx.args && ctx.args[0]) || 0);
        if (!id) return replyBlock(conn, ctx, "parceiro", ["Informe o id. Veja channelparceiros."]);
        const row = await deactivateFn(id);
        if (!row) return replyBlock(conn, ctx, "parceiro", ["id nao encontrado"]);
        await replyBlock(conn, ctx, "parceiro", ["#" + row.id + " inativo. Historico mantido."]);
    }
};
commands.offparceiro = commands.channelparceirooff;

['channelpost', 'channelparceiros', 'channelparceiroadd', 'channelparceiroedit', 'channelparceirooff', 'parceiros', 'listparceiros', 'addparceiro', 'editparceiro', 'offparceiro'].forEach(function (name) {
    if (commands[name]) {
        commands[name]['useCtx'] = true;
        commands[name].useCtx = true;
    }
});

module.exports = { commands };