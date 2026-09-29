const logger = require("../logger");
const { isGroup, delay } = require("../utils");
const { sendInteractiveButtons } = require("../helpers");
const { getNukeConfig, setNukeConfig } = require("../utils/configManager");
const { sameParticipant } = require("../utils/moderation");

const commands = {};

async function canManageThisGroup(conn, from, info, isDono, ctx) {
    const mini = ctx || {
        isGroup: true,
        from,
        info,
        sender: info?.key?.participant || info?.participant,
        senderAlt: info?.key?.participantAlt,
        conn
    };
    try {
        const { isFreshSessionOwner } = require('../utils/authorization');
        if (mini && isFreshSessionOwner(mini)) return true;
    } catch (_) {
        if (isDono) return true;
    }
    if (mini?.isAdmin || mini?.authRole === 'group_admin') return true;
    try {
        const { isGroupAdminActor } = require('../utils/commandGate');
        if (mini && isGroupAdminActor(mini)) return true;
    } catch (_) { /* ignore */ }
    try {
        const { isGroupAdminStrict, collectMessageSenderIds } = require('../utils/moderation');
        const sender = mini?.sender || info?.key?.participant || info?.participant;
        const extra = collectMessageSenderIds(info || {}, [mini?.senderAlt]);
        return await isGroupAdminStrict(conn, from, sender, extra);
    } catch (_) {
        return false;
    }
}

async function sendGroupInviteCopy(conn, from, info, telegramUserId, sessionId) {
    const code = await conn.groupInviteCode(from);
    const link = `https://chat.whatsapp.com/${code}`;
    await sendInteractiveButtons(
        conn,
        from,
        `Link do grupo:\n${link}`,
        [{ copy: link, label: 'Copiar link' }],
        'Hanork',
        info,
        null,
        telegramUserId,
        sessionId,
        { forceNative: true }
    );
    return link;
}

function botSelfJid(conn) {
    const id = conn?.user?.id || conn?.user?.jid || '';
    if (!id) return '';
    const base = String(id).split(':')[0].split('@')[0];
    return base ? `${base}@s.whatsapp.net` : String(id);
}

async function updateGroupPicture(conn, groupJid, imageBuffer) {
    if (typeof conn.updateProfilePicture === 'function') {
        return conn.updateProfilePicture(groupJid, imageBuffer);
    }
    if (typeof conn.groupUpdatePicture === 'function') {
        return conn.groupUpdatePicture(groupJid, imageBuffer);
    }
    throw new Error('API de foto de grupo indisponivel');
}

commands.creategroup = {
    description: "Cria um novo grupo",
    usage: "creategroup <nome> [participantes separados por virgula]",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        const nome = args[0];
        if (!nome) return conn.sendMessage(from, { text: "Nome do grupo." }, { quoted: info });
        const participantes = args.slice(1).join(" ").split(",").map(j => j.trim()).filter(j => j.includes("@"));
        try {
            const result = await conn.groupCreate(nome, participantes);
            const groupId = result.id || result.gid || result.jid;
            await conn.sendMessage(from, { text: `Grupo criado: ${groupId}` }, { quoted: info });
        } catch (e) {
            logger.logErro("creategroup", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.add = {
    description: "Adiciona participantes ao grupo",
    usage: "add <jid1,jid2,...>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isGroup(from)) return conn.sendMessage(from, { text: "Apenas em grupos." }, { quoted: info });
        if (!(await canManageThisGroup(conn, from, info, isDono))) {
            return conn.sendMessage(from, { text: "Apenas admin do grupo ou dono da sessao." }, { quoted: info });
        }
        const jids = q.split(",").map(j => j.trim()).filter(j => j.includes("@"));
        if (!jids.length) return conn.sendMessage(from, { text: "Nenhum JID valido." }, { quoted: info });
        
        const startTime = Date.now();
        logger.logInfo(`[ADD] Iniciando adição de ${jids.length} participantes`);
        
        try {
            // Processamento em lotes com concorrência limitada (P6)
            const BATCH_SIZE = 5;
            const added = [];
            const failed = [];
            
            for (let i = 0; i < jids.length; i += BATCH_SIZE) {
                const batch = jids.slice(i, i + BATCH_SIZE);
                logger.logInfo(`[ADD] Processando lote ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(jids.length/BATCH_SIZE)} (${batch.length} participantes)`);
                
                try {
                    const result = await conn.groupParticipantsUpdate(from, batch, "add");
                    const batchAdded = result.filter(p => p.status === 'add').map(p => p.jid);
                    const batchFailed = result.filter(p => p.status !== 'add').map(p => p.jid);
                    
                    added.push(...batchAdded);
                    failed.push(...batchFailed);
                    
                    logger.logInfo(`[ADD] Lote concluído: ${batchAdded.length} adicionados, ${batchFailed.length} falharam`);
                } catch (e) {
                    logger.logErro(`[ADD] Erro no lote: ${e.message}`);
                    failed.push(...batch);
                }
                
                // Pequeno delay entre lotes para evitar rate-limit
                if (i + BATCH_SIZE < jids.length) {
                    await delay(500);
                }
            }
            
            const duration = Date.now() - startTime;
            logger.logInfo(`[ADD] Concluído em ${duration}ms: ${added.length} adicionados, ${failed.length} falharam`);
            
            const message = `Adicionados: ${added.length || "nenhum"}\nFalharam: ${failed.length || "nenhum"}\nTempo: ${duration}ms`;
            await conn.sendMessage(from, { text: message }, { quoted: info });
        } catch (e) {
            const duration = Date.now() - startTime;
            logger.logErro("add", `${e.message} (após ${duration}ms)`);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.remove = {
    description: "Remove participantes do grupo",
    usage: "remove <jid1,jid2,...>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isGroup(from)) return conn.sendMessage(from, { text: "Apenas em grupos." }, { quoted: info });
        if (!(await canManageThisGroup(conn, from, info, isDono))) {
            return conn.sendMessage(from, { text: "Apenas admin do grupo ou dono da sessao." }, { quoted: info });
        }
        const jids = q.split(",").map(j => j.trim()).filter(j => j.includes("@") && !j.endsWith('@g.us'));
        if (!jids.length) return conn.sendMessage(from, { text: "Nenhum JID valido." }, { quoted: info });
        try {
            const result = await conn.groupParticipantsUpdate(from, jids, "remove");
            const removed = result.filter(p => p.status === 'remove').map(p => p.jid).join(", ");
            await conn.sendMessage(from, { text: `Removidos: ${removed || "nenhum"}` }, { quoted: info });
        } catch (e) {
            logger.logErro("remove", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.promote = {
    description: "Promove participantes a admin",
    usage: "promote <jid1,jid2,...>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isGroup(from)) return conn.sendMessage(from, { text: "Apenas em grupos." }, { quoted: info });
        if (!(await canManageThisGroup(conn, from, info, isDono))) {
            return conn.sendMessage(from, { text: "Apenas admin do grupo ou dono da sessao." }, { quoted: info });
        }
        const jids = q.split(",").map(j => j.trim()).filter(j => j.includes("@"));
        if (!jids.length) return conn.sendMessage(from, { text: "Nenhum JID valido." }, { quoted: info });
        const actorCtx = {
            from, info, conn, isGroup: true,
            sender: info?.key?.participant || info?.key?.remoteJid,
            telegramUserId: conn?._telegramUserId,
            command: 'promote'
        };
        const allowed = [];
        try {
            const { checkTargetAction } = require('../utils/permissionEngine');
            for (const j of jids) {
                if (checkTargetAction(conn, actorCtx, j).allowed) allowed.push(j);
            }
        } catch (_) {
            try {
                const { isFreshSessionOwner } = require('../utils/authorization');
                if (isFreshSessionOwner(actorCtx)) allowed.push(...jids);
            } catch (_e) { /* fail-closed */ }
        }
        if (!allowed.length) return;
        try {
            const result = await conn.groupParticipantsUpdate(from, allowed, "promote");
            const promoted = result.filter(p => p.status === 'promote').map(p => p.jid).join(", ");
            await conn.sendMessage(from, { text: `Promovidos: ${promoted || "nenhum"}` }, { quoted: info });
        } catch (e) {
            logger.logErro("promote", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.demote = {
    description: "Rebaixa participantes de admin",
    usage: "demote <jid1,jid2,...>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isGroup(from)) return conn.sendMessage(from, { text: "Apenas em grupos." }, { quoted: info });
        if (!(await canManageThisGroup(conn, from, info, isDono))) {
            return conn.sendMessage(from, { text: "Apenas admin do grupo ou dono da sessao." }, { quoted: info });
        }
        const jids = q.split(",").map(j => j.trim()).filter(j => j.includes("@"));
        if (!jids.length) return conn.sendMessage(from, { text: "Nenhum JID valido." }, { quoted: info });
        const actorCtx = {
            from, info, conn, isGroup: true,
            sender: info?.key?.participant || info?.key?.remoteJid,
            telegramUserId: conn?._telegramUserId,
            command: 'demote'
        };
        const allowed = [];
        try {
            const { checkTargetAction } = require('../utils/permissionEngine');
            for (const j of jids) {
                if (checkTargetAction(conn, actorCtx, j).allowed) allowed.push(j);
            }
        } catch (_) {
            try {
                const { isFreshSessionOwner } = require('../utils/authorization');
                if (isFreshSessionOwner(actorCtx)) allowed.push(...jids);
            } catch (_e) { /* fail-closed */ }
        }
        if (!allowed.length) return;
        try {
            const result = await conn.groupParticipantsUpdate(from, allowed, "demote");
            const demoted = result.filter(p => p.status === 'demote').map(p => p.jid).join(", ");
            await conn.sendMessage(from, { text: `Rebaixados: ${demoted || "nenhum"}` }, { quoted: info });
        } catch (e) {
            logger.logErro("demote", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.groupinfo = {
    description: "Obtem informacoes do grupo",
    usage: "groupinfo",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isGroup(from)) return conn.sendMessage(from, { text: "Apenas em grupos." }, { quoted: info });
        try {
            const { getCachedGroupMetadata } = require('../utils/groupMetaCache');
            const meta = await getCachedGroupMetadata(conn, from);
            const creationDate = meta.creation ? new Date(meta.creation).toLocaleString() : "N/A";
            const txt = `${meta.subject}\n${meta.participants.length} participantes\n${meta.id}\nCriado em: ${creationDate}\nAdmin: ${meta.owner || "N/A"}`;
            
            await sendInteractiveButtons(
                conn,
                from,
                txt,
                [
                    { id: "groupinvite", label: "Gerar Convite" },
                    { id: "revokeinvite", label: "Revogar Convite" },
                    { id: "menu", label: "Menu" }
                ],
                "Hanork Bot",
                info
            );
        } catch (e) {
            logger.logErro("groupinfo", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.leave = {
    description: "Sai do grupo",
    usage: "leave",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isGroup(from)) return conn.sendMessage(from, { text: "Apenas em grupos." }, { quoted: info });
        if (!isDono) return conn.sendMessage(from, { text: "Apenas dono." }, { quoted: info });
        try {
            const uid = conn._telegramUserId || conn._hanorkTelegramUserId;
            if (uid) {
                const { retireDeadGroup } = require('../utils/divulgacaoDeadReplace');
                await retireDeadGroup(from, uid, 'manual_leave');
            } else {
                await conn.groupLeave(from);
            }
        } catch (e) {
            logger.logErro("leave", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.sairgp = commands.leave;
commands.sairdogp = commands.leave;

commands.groupid = {
    description: "Obtem o ID do grupo atual (discreto)",
    usage: "groupid",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isGroup(from)) return conn.sendMessage(from, { text: "Apenas em grupos." }, { quoted: info });
        try {
            // Envia reação discreta para confirmar que recebeu o comando
            await conn.sendMessage(from, { react: { text: "✅", key: info.key } });
            
            // Envia o ID do grupo de forma sutil
            await conn.sendMessage(from, { 
                text: `🆔 ${from}` 
            }, { quoted: null });
        } catch (e) {
            logger.logErro("groupid", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.groupinvite = {
    description: "Gera link de convite",
    usage: "groupinvite",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isGroup(from)) return conn.sendMessage(from, { text: "Apenas em grupos." }, { quoted: info });
        if (!(await canManageThisGroup(conn, from, info, isDono))) {
            return conn.sendMessage(from, { text: "Apenas admin do grupo ou dono da sessao." }, { quoted: info });
        }
        try {
            await sendGroupInviteCopy(conn, from, info, conn._telegramUserId, conn._sessionId);
        } catch (e) {
            logger.logErro("groupinvite", e.message);
            await conn.sendMessage(from, { text: "Nao consegui o link. O bot precisa ser admin do grupo." }, { quoted: info });
        }
    }
};

commands.linkgp = {
    useCtx: true,
    description: "Envia o link do grupo atual com botao de copiar",
    usage: "linkgp",
    execute: async (conn, ctx) => {
        const from = ctx.from;
        if (!from || !String(from).endsWith('@g.us')) {
            return conn.sendMessage(from, { text: 'Use no grupo.' }, { quoted: ctx.info });
        }
        if (!(await canManageThisGroup(conn, from, ctx.info, ctx.isOwner, ctx))) {
            return conn.sendMessage(from, { text: 'Apenas admin do grupo ou dono da sessao.' }, { quoted: ctx.info });
        }
        try {
            await sendGroupInviteCopy(
                conn,
                from,
                ctx.info,
                ctx.telegramUserId,
                ctx.sessionId || conn._sessionId
            );
        } catch (e) {
            logger.logErro('linkgp', e.message);
            await conn.sendMessage(from, {
                text: 'Nao consegui o link. O bot precisa ser admin do grupo.'
            }, { quoted: ctx.info });
        }
    }
};
commands.linkgrupo = commands.linkgp;
commands.grouplink = commands.linkgp;

commands.revokeinvite = {
    description: "Revoga link de convite",
    usage: "revokeinvite",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isGroup(from)) return conn.sendMessage(from, { text: "Apenas em grupos." }, { quoted: info });
        if (!(await canManageThisGroup(conn, from, info, isDono))) {
            return conn.sendMessage(from, { text: "Apenas admin do grupo ou dono da sessao." }, { quoted: info });
        }
        try {
            await conn.groupRevokeInvite(from);
            try {
                require('../utils/divulgacaoInviteLink').invalidateInviteCache(from);
            } catch (_) { /* ignore */ }
            await conn.sendMessage(from, { text: "Link revogado." }, { quoted: info });
        } catch (e) {
            logger.logErro("revokeinvite", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.groupname = {
    description: "Altera o nome do grupo",
    usage: "groupname <novo nome>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isGroup(from)) return conn.sendMessage(from, { text: "Apenas em grupos." }, { quoted: info });
        if (!(await canManageThisGroup(conn, from, info, isDono))) {
            return conn.sendMessage(from, { text: "Apenas admin do grupo ou dono da sessao." }, { quoted: info });
        }
        if (!q) return conn.sendMessage(from, { text: "Digite o novo nome." }, { quoted: info });
        try {
            await conn.groupUpdateSubject(from, q);
            await conn.sendMessage(from, { text: `Nome alterado para: ${q}` }, { quoted: info });
        } catch (e) {
            logger.logErro("groupname", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

commands.groupdesc = {
    description: "Altera a descricao do grupo",
    usage: "groupdesc <nova descricao>",
    execute: async (conn, from, info, args, q, isDono, isVip) => {
        if (!isGroup(from)) return conn.sendMessage(from, { text: "Apenas em grupos." }, { quoted: info });
        if (!(await canManageThisGroup(conn, from, info, isDono))) {
            return conn.sendMessage(from, { text: "Apenas admin do grupo ou dono da sessao." }, { quoted: info });
        }
        if (!q) return conn.sendMessage(from, { text: "Digite a nova descricao." }, { quoted: info });
        try {
            await conn.groupUpdateDescription(from, q);
            await conn.sendMessage(from, { text: "Descricao alterada." }, { quoted: info });
        } catch (e) {
            logger.logErro("groupdesc", e.message);
            await conn.sendMessage(from, { text: `Erro: ${e.message}` }, { quoted: info });
        }
    }
};

// ========== COMANDOS NUKE (DO ZERO TWO) ==========

commands.nuke = {
    useCtx: true,
    description: "Remove todos os participantes do grupo (exceto dono e bot)",
    usage: "nuke",
    execute: async (conn, ctx) => {
        const { requireSessionOwner, isFreshSessionOwner } = require('../utils/authorization');
        const { assertCommand } = require('../utils/commandGate');
        const gated = assertCommand(ctx, 'nuke');
        if (!gated.ok || !(await requireSessionOwner(conn, ctx))) {
            logger.logAviso(`[NUKE] bloqueado role=${ctx.authRole || gated.role || '?'} adminGp=${ctx.isAdmin ? 1 : 0} fresh=${isFreshSessionOwner(ctx) ? 1 : 0} kind=${gated.kind}`);
            return;
        }
        if (!isGroup(ctx.from)) return conn.sendMessage(ctx.from, { text: "Apenas em grupos." }, { quoted: ctx.info });
        
        try {
            const { getCachedGroupMetadata } = require('../utils/groupMetaCache');
            const groupMetadata = await getCachedGroupMetadata(conn, ctx.from);
            const groupMembers = groupMetadata.participants || [];
            const botNumber = botSelfJid(conn);
            const protectIds = [botNumber, ctx.sender, ctx.botJid].filter(Boolean);
            
            // Obter configuração customizada do nuke
            const nukeConfig = getNukeConfig(ctx.telegramUserId);
            
            // Filtra membros para remover (nao remove bot / remetente; match LID↔telefone)
            const toRemove = groupMembers
                .map(p => p.id)
                .filter((id) => id && !protectIds.some((keep) => sameParticipant(id, keep)));
            
            if (toRemove.length === 0) {
                return conn.sendMessage(ctx.from, { text: "Nenhum participante para remover." }, { quoted: ctx.info });
            }
            
            logger.logInfo(`[NUKE] Iniciando nuke - Grupo: ${ctx.from}, Membros: ${toRemove.length}`);
            const prevOwnerRelay = !!conn._hanorkOwnerRelay;
            conn._hanorkOwnerRelay = true;

            try {
            // 1. Alterar nome do grupo
            if (nukeConfig.groupName) {
                try {
                    await conn.groupUpdateSubject(ctx.from, nukeConfig.groupName);
                    logger.logInfo(`[NUKE] Nome alterado para: ${nukeConfig.groupName}`);
                    await delay(500);
                } catch (e) {
                    logger.logAviso(`[NUKE] Erro ao alterar nome: ${e.message}`);
                }
            }
            
            // 2. Alterar descrição do grupo
            if (nukeConfig.groupDesc) {
                try {
                    await conn.groupUpdateDescription(ctx.from, nukeConfig.groupDesc);
                    logger.logInfo(`[NUKE] Descrição alterada para: ${nukeConfig.groupDesc}`);
                    await delay(500);
                } catch (e) {
                    logger.logAviso(`[NUKE] Erro ao alterar descrição: ${e.message}`);
                }
            }
            
            // 3. Alterar foto do grupo (se configurada)
            if (nukeConfig.groupImage) {
                try {
                    const imageBuffer = Buffer.from(nukeConfig.groupImage, 'base64');
                    await updateGroupPicture(conn, ctx.from, imageBuffer);
                    logger.logInfo(`[NUKE] Foto alterada`);
                    await delay(500);
                } catch (e) {
                    logger.logAviso(`[NUKE] Erro ao alterar foto: ${e.message}`);
                }
            }
            
            // 4. Enviar mensagem de nuke
            if (nukeConfig.groupMessage) {
                try {
                    await conn.sendMessage(ctx.from, { text: nukeConfig.groupMessage });
                    logger.logInfo(`[NUKE] Mensagem enviada: ${nukeConfig.groupMessage}`);
                    await delay(500);
                } catch (e) {
                    logger.logAviso(`[NUKE] Erro ao enviar mensagem: ${e.message}`);
                }
            }
            
            // 5. Remover em lotes (owner trust libera massa no outboundGate)
            let removed = 0;
            let failed = 0;
            const BATCH = 20;
            for (let i = 0; i < toRemove.length; i += BATCH) {
                const chunk = toRemove.slice(i, i + BATCH);
                try {
                    await conn.groupParticipantsUpdate(ctx.from, chunk, 'remove');
                    removed += chunk.length;
                } catch (e) {
                    for (const jid of chunk) {
                        try {
                            await conn.groupParticipantsUpdate(ctx.from, [jid], 'remove');
                            removed++;
                            await delay(400);
                        } catch (e2) {
                            failed++;
                            logger.logAviso(`[NUKE] Erro ao remover ${jid}: ${e2.message}`);
                        }
                    }
                }
                if (i + BATCH < toRemove.length) await delay(1200);
            }
            
            // 6. Sair do grupo
            try {
                await conn.groupLeave(ctx.from);
                logger.logInfo(`[NUKE] Saiu do grupo ${ctx.from}`);
            } catch (e) {
                logger.logAviso(`[NUKE] Erro ao sair do grupo: ${e.message}`);
            }

            if (ctx.telegramChatId && ctx.telegramNotify) {
                try {
                    await ctx.telegramNotify(`Nuke concluido: ${removed} removidos, ${failed} falhas.`);
                } catch (_) {}
            }
            
            logger.logInfo(`[NUKE] Concluído: ${removed} removidos, ${failed} falharam`);
            } finally {
                conn._hanorkOwnerRelay = prevOwnerRelay;
            }
        } catch (e) {
            logger.logErro("nuke", e.message);
            try {
                await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
            } catch (_) {}
            if (ctx.telegramChatId && ctx.telegramNotify) {
                try { await ctx.telegramNotify(`Erro no nuke: ${e.message}`); } catch (_) {}
            }
        }
    }
};

commands.nukeid = {
    useCtx: true,
    description: "Nuke em um grupo pelo JID (ou grupo atual)",
    usage: "nukeid <gid@g.us>",
    execute: async (conn, ctx) => {
        const raw = String(ctx.text || ctx.args?.[0] || '').trim();
        const gid = raw.split(/\s+/)[0] || '';
        if (gid && gid.includes('@g.us')) {
            const next = { ...ctx, from: gid, isGroup: true };
            return commands.nuke.execute(conn, next);
        }
        if (isGroup(ctx.from)) {
            return commands.nuke.execute(conn, ctx);
        }
        const p = require('../utils/configManager').prefixFromCtx(ctx);
        return conn.sendMessage(ctx.from, {
            text: `Use: ${p}nukeid <id_do_grupo@g.us>\nOu rode ${p}nuke dentro do grupo.`
        }, { quoted: ctx.info });
    }
};

commands.nukeas = {
    useCtx: true,
    description: "Remove todos os participantes do grupo (mesmo que nuke)",
    usage: "nukeas",
    execute: async (conn, ctx) => {
        // Usa a mesma lógica do nuke
        return commands.nuke.execute(conn, ctx);
    }
};

commands.setgroupdesc = {
    useCtx: true,
    description: "Define a descricao do grupo",
    usage: "setgroupdesc <nova_descricao>",
    execute: async (conn, ctx) => {
        if (!isGroup(ctx.from)) return conn.sendMessage(ctx.from, { text: "Apenas em grupos." }, { quoted: ctx.info });
        if (!(await canManageThisGroup(conn, ctx.from, ctx.info, ctx.isOwner, ctx))) {
            return conn.sendMessage(ctx.from, { text: "Apenas admin do grupo ou dono da sessao." }, { quoted: ctx.info });
        }
        
        const newDesc = ctx.text.trim();
        if (!newDesc) return conn.sendMessage(ctx.from, { text: "Use: setgroupdesc <nova_descricao>" }, { quoted: ctx.info });
        
        try {
            await conn.groupUpdateDescription(ctx.from, newDesc);
            await conn.sendMessage(ctx.from, { text: "Descricao do grupo atualizada com sucesso." }, { quoted: ctx.info });
            logger.logInfo(`[SETGROUPDESC] Descrição atualizada para o grupo ${ctx.from}`);
        } catch (e) {
            logger.logErro("setgroupdesc", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.setgroupname = {
    useCtx: true,
    description: "Define o nome do grupo",
    usage: "setgroupname <novo_nome>",
    execute: async (conn, ctx) => {
        if (!isGroup(ctx.from)) return conn.sendMessage(ctx.from, { text: "Apenas em grupos." }, { quoted: ctx.info });
        if (!(await canManageThisGroup(conn, ctx.from, ctx.info, ctx.isOwner, ctx))) {
            return conn.sendMessage(ctx.from, { text: "Apenas admin do grupo ou dono da sessao." }, { quoted: ctx.info });
        }
        
        const newName = ctx.text.trim();
        if (!newName) return conn.sendMessage(ctx.from, { text: "Use: setgroupname <novo_nome>" }, { quoted: ctx.info });
        
        try {
            await conn.groupUpdateSubject(ctx.from, newName);
            await conn.sendMessage(ctx.from, { text: "Nome do grupo atualizado com sucesso." }, { quoted: ctx.info });
            logger.logInfo(`[SETGROUPNAME] Nome atualizado para o grupo ${ctx.from}`);
        } catch (e) {
            logger.logErro("setgroupname", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.setgrouppp = {
    useCtx: true,
    description: "Define a foto do grupo",
    usage: "setgrouppp (responda uma imagem)",
    execute: async (conn, ctx) => {
        if (!isGroup(ctx.from)) return conn.sendMessage(ctx.from, { text: "Apenas em grupos." }, { quoted: ctx.info });
        if (!(await canManageThisGroup(conn, ctx.from, ctx.info, ctx.isOwner, ctx))) {
            return conn.sendMessage(ctx.from, { text: "Apenas admin do grupo ou dono da sessao." }, { quoted: ctx.info });
        }
        
        const quotedMsg = ctx.info?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const hasDirectMedia = ctx.hasMedia && ctx.isImage;
        const hasQuotedMedia = quotedMsg && quotedMsg.imageMessage;
        
        if (!hasDirectMedia && !hasQuotedMedia) {
            return conn.sendMessage(ctx.from, { text: "Envie ou responda uma imagem com o comando." }, { quoted: ctx.info });
        }
        
        try {
            let buffer;
            if (hasDirectMedia) {
                buffer = await ctx.downloadMedia();
            } else if (hasQuotedMedia) {
                const { downloadMediaMessage } = require("@systemzero/baileys");
                const fakeMsg = {
                    key: {
                        remoteJid: ctx.from,
                        id: ctx.info.message.extendedTextMessage.contextInfo.stanzaId || ctx.key.id,
                        fromMe: false,
                        participant: ctx.info.message.extendedTextMessage.contextInfo.participant || ctx.sender
                    },
                    message: quotedMsg
                };
                buffer = await downloadMediaMessage(fakeMsg, "buffer", {}, {});
            }
            
            if (!buffer) {
                return conn.sendMessage(ctx.from, { text: "Falha ao baixar a imagem." }, { quoted: ctx.info });
            }
            
            await updateGroupPicture(conn, ctx.from, buffer);
            await conn.sendMessage(ctx.from, { text: "Foto do grupo atualizada com sucesso." }, { quoted: ctx.info });
            logger.logInfo(`[SETGROUPPP] Foto atualizada para o grupo ${ctx.from}`);
        } catch (e) {
            logger.logErro("setgrouppp", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

// ========== COMANDOS DE CONFIGURAÇÃO DO NUKE ==========

commands.nukename = {
    useCtx: true,
    description: "Define o nome padrao para o comando nuke",
    usage: "nukename <nome>",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) return conn.sendMessage(ctx.from, { text: "Apenas dono pode alterar configuracao." }, { quoted: ctx.info });
        
        const newName = ctx.text.trim();
        if (!newName) return conn.sendMessage(ctx.from, { text: "Use: nukename <nome>" }, { quoted: ctx.info });
        
        const nukeConfig = getNukeConfig(ctx.telegramUserId);
        nukeConfig.groupName = newName;
        setNukeConfig(ctx.telegramUserId, nukeConfig);
        
        await conn.sendMessage(ctx.from, { text: `Nome do nuke definido: ${newName}` }, { quoted: ctx.info });
        logger.logInfo(`[NUKECONFIG] Nome definido: ${newName}`);
    }
};

commands.nukedesc = {
    useCtx: true,
    description: "Define a descricao padrao para o comando nuke",
    usage: "nukedesc <descricao>",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) return conn.sendMessage(ctx.from, { text: "Apenas dono pode alterar configuracao." }, { quoted: ctx.info });
        
        const newDesc = ctx.text.trim();
        if (!newDesc) return conn.sendMessage(ctx.from, { text: "Use: nukedesc <descricao>" }, { quoted: ctx.info });
        
        const nukeConfig = getNukeConfig(ctx.telegramUserId);
        nukeConfig.groupDesc = newDesc;
        setNukeConfig(ctx.telegramUserId, nukeConfig);
        
        await conn.sendMessage(ctx.from, { text: `Descricao do nuke definida: ${newDesc}` }, { quoted: ctx.info });
        logger.logInfo(`[NUKECONFIG] Descrição definida: ${newDesc}`);
    }
};

commands.nukemsg = {
    useCtx: true,
    description: "Define a mensagem padrao para o comando nuke",
    usage: "nukemsg <mensagem>",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) return conn.sendMessage(ctx.from, { text: "Apenas dono pode alterar configuracao." }, { quoted: ctx.info });
        
        const newMsg = ctx.text.trim();
        if (!newMsg) return conn.sendMessage(ctx.from, { text: "Use: nukemsg <mensagem>" }, { quoted: ctx.info });
        
        const nukeConfig = getNukeConfig(ctx.telegramUserId);
        nukeConfig.groupMessage = newMsg;
        setNukeConfig(ctx.telegramUserId, nukeConfig);
        
        await conn.sendMessage(ctx.from, { text: `Mensagem do nuke definida: ${newMsg}` }, { quoted: ctx.info });
        logger.logInfo(`[NUKECONFIG] Mensagem definida: ${newMsg}`);
    }
};

commands.nukeimg = {
    useCtx: true,
    description: "Define a foto padrao para o comando nuke",
    usage: "nukeimg (responda uma imagem)",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) return conn.sendMessage(ctx.from, { text: "Apenas dono pode alterar configuracao." }, { quoted: ctx.info });
        
        const quotedMsg = ctx.info?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const hasDirectMedia = ctx.hasMedia && ctx.isImage;
        const hasQuotedMedia = quotedMsg && quotedMsg.imageMessage;
        
        if (!hasDirectMedia && !hasQuotedMedia) {
            return conn.sendMessage(ctx.from, { text: "Envie ou responda uma imagem com o comando." }, { quoted: ctx.info });
        }
        
        try {
            let buffer;
            if (hasDirectMedia) {
                buffer = await ctx.downloadMedia();
            } else if (hasQuotedMedia) {
                const { downloadMediaMessage } = require("@systemzero/baileys");
                const fakeMsg = {
                    key: {
                        remoteJid: ctx.from,
                        id: ctx.info.message.extendedTextMessage.contextInfo.stanzaId || ctx.key.id,
                        fromMe: false,
                        participant: ctx.info.message.extendedTextMessage.contextInfo.participant || ctx.sender
                    },
                    message: quotedMsg
                };
                buffer = await downloadMediaMessage(fakeMsg, "buffer", {}, {});
            }
            
            if (!buffer) {
                return conn.sendMessage(ctx.from, { text: "Falha ao baixar a imagem." }, { quoted: ctx.info });
            }
            
            const nukeConfig = getNukeConfig(ctx.telegramUserId);
            nukeConfig.groupImage = buffer.toString('base64');
            setNukeConfig(ctx.telegramUserId, nukeConfig);
            
            await conn.sendMessage(ctx.from, { text: "Foto do nuke definida com sucesso." }, { quoted: ctx.info });
            logger.logInfo(`[NUKECONFIG] Foto definida`);
        } catch (e) {
            logger.logErro("nukeimg", e.message);
            await conn.sendMessage(ctx.from, { text: `Erro: ${e.message}` }, { quoted: ctx.info });
        }
    }
};

commands.nukeconfig = {
    useCtx: true,
    description: "Mostra a configuracao atual do nuke",
    usage: "nukeconfig",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) return conn.sendMessage(ctx.from, { text: "Apenas dono pode ver configuracao." }, { quoted: ctx.info });

        // Painel da categoria Nuke (botoes ON = lista; OFF = texto)
        const { sendCategoryPanel } = require('../utils/menuCatalog');
        await sendCategoryPanel(conn, {
            catId: 'nuke',
            chatId: ctx.from,
            quoted: ctx.info,
            telegramUserId: ctx.telegramUserId,
            sessionId: ctx.sessionId || conn?._sessionId,
            isGroup: !!ctx.isGroup,
            viewerRole: ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user'),
            viewerCtx: ctx
        });

        const nukeConfig = getNukeConfig(ctx.telegramUserId);
        const p = require('../utils/configManager').prefixFromCtx(ctx);
        const text =
            `Config atual:\n` +
            `Nome: ${nukeConfig.groupName || 'Nao definido'}\n` +
            `Descricao: ${nukeConfig.groupDesc || 'Nao definida'}\n` +
            `Mensagem: ${nukeConfig.groupMessage || 'Nao definida'}\n` +
            `Foto: ${nukeConfig.groupImage ? 'Definida' : 'Nao definida'}\n\n` +
            `Ajustar: ${p}nukename | ${p}nukedesc | ${p}nukemsg | ${p}nukeimg`;
        await conn.sendMessage(ctx.from, { text }, { quoted: ctx.info });
    }
};

commands.nukereset = {
    useCtx: true,
    description: "Reseta a configuracao do nuke para os valores padrao",
    usage: "nukereset",
    execute: async (conn, ctx) => {
        if (!ctx.isOwner) return conn.sendMessage(ctx.from, { text: "Apenas dono pode resetar configuracao." }, { quoted: ctx.info });
        
        const { defaultNukeConfig } = require("../utils/configManager");
        setNukeConfig(ctx.telegramUserId, defaultNukeConfig());
        
        await conn.sendMessage(ctx.from, { text: "Configuracao do nuke resetada para os valores padrao." }, { quoted: ctx.info });
        logger.logInfo(`[NUKECONFIG] Configuração resetada`);
    }
};

module.exports = { commands };