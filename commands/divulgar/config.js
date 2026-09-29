const { requireSessionOwner } = require('../../utils/authorization');
// commands/divulgar/config.js
const logger = require("../../logger");
const { getConfig, updateConfig, limparConfig, isCtaReady, isTextoReady, isPayReady, isStatusReady, normalizeCtaUrl, parseCtaParts, formatCtaSummary, formatTracksSummary, formatSlotsSummary, formatStatusSummary, clampCtaLabel, ctaMissing, CTA_LABEL_MAX, getCtaImageBuffer, getTextoMediaBuffer, getStatusMediaBuffer, captureMediaFromCtx, saveTextoMediaBuffer, saveCtaImageBuffer, saveCtaMediaBuffer, saveStatusMediaBuffer, clearStatusMedia, unlinkMediaFile, ctaUrlButtons, isDivAdmin, setActiveSlot, getActiveSlot, isTrackReady, modoKey, SLOT_TRACKS, SLOT_IDS, applyViewConfig, parseTipoSlot, clampSlot, viewForActiveTrack } = require("../../utils/divulgacao");
const { sendDivulgacaoButtons: sendButtonsWithImage, sendDivulgacaoList, sendDivulgacaoMessage, pvReplyHint } = require("../../utils/divulgacaoReply");
const { getBlacklist } = require("../../utils/configManager");
const { setStep } = require("../../utils/stepHandlers");

const commands = {};

function extractQuotedText(ctx) {
    const quotedMsg = ctx.quoted?.message
        || ctx.info?.message?.extendedTextMessage?.contextInfo?.quotedMessage
        || ctx.info?.message?.imageMessage?.contextInfo?.quotedMessage;
    if (!quotedMsg) return '';
    return quotedMsg.conversation
        || quotedMsg.extendedTextMessage?.text
        || quotedMsg.imageMessage?.caption
        || quotedMsg.videoMessage?.caption
        || '';
}

function keepToken(text) {
    const t = String(text || '').trim().toLowerCase();
    return t === 'manter' || t === '-' || t === '.';
}

function ctaEditView(telegramUserId) {
    return viewForActiveTrack(telegramUserId, 'cta');
}

function statusEditView(telegramUserId) {
    return viewForActiveTrack(telegramUserId, 'status');
}

async function showCtaPanel(conn, ctx, notice = '') {
    const { slot, view } = ctaEditView(ctx.telegramUserId);
    const config = view;
    const has2 = ctaUrlButtons(config, ctx.telegramUserId).length >= 2;
    const adm = isDivAdmin(ctx.telegramUserId);
    const head = notice ? `${String(notice).trim()}\n\n` : '';
    let inviteHint = '';
    if (adm) {
      try {
        const { resolveInviteGroupJid, PLACEHOLDER } = require('../../utils/divulgacaoInviteLink');
        const jid = resolveInviteGroupJid({ telegramUserId: ctx.telegramUserId });
        inviteHint =
          `\nLink vivo: use ${PLACEHOLDER} no texto (ou botao \"Texto+link grupo\").\n` +
          `Grupo convite: ${jid || '(configure no painel)'}\n`;
      } catch (_) { /* ignore */ }
    }
    const { prefixFromCtx, applyLivePrefix } = require('../../utils/configManager');
    const p = prefixFromCtx(ctx);
    const msg = `${head}CTA DA DIVULGACAO — slot ${slot}${adm ? ' (edicao ativa)' : ''} (separado do texto normal)\n\n` +
        `${applyLivePrefix(formatCtaSummary(config), p)}\n` +
        inviteHint +
        `\n1 URL = 1 botao. 2 URLs = 2 botoes. Tudo editavel.\n` +
        `1a msg: mencoes (ignora admins). Invisivel: so o que falar.\n\n` +
        `Atalho:\n${p}divcta texto | botao1 | https://link1 | botao2 | https://link2\n` +
        `Foto: responda uma imagem com ${p}fotodivulcta`;

    const rows = [
        { id: "div_cta_wizard", label: "Configurar tudo" },
        { id: "div_cta_texto", label: "Editar texto" },
        { id: "div_cta_label", label: "Botao 1" },
        { id: "div_cta_url", label: "Link 1" },
        { id: "div_cta_label2", label: has2 ? "Editar botao 2" : "Add botao 2" }
    ];
    if (has2) {
        rows.push({ id: "div_cta_url2", label: "Editar link 2" });
        rows.push({ id: "div_cta_btn2_rm", label: "Tirar botao 2" });
    }
    rows.push(
        { id: "div_cta_foto", label: "Foto CTA" },
        { id: "div_cta_foto_remover", label: "Remover foto" },
        { id: "div_preview", label: "Preview" }
    );
    if (adm) {
        rows.push(
            { id: "div_invite_tpl_cta", label: "Texto+link grupo" },
            { id: "div_invite_setgrupo", label: "Grupo do convite" },
            { id: "div_invite_preview_cta", label: "Preview link vivo" }
        );
    }
    rows.push({ id: "div_config", label: "Voltar" });

    await sendButtonsWithImage(
        conn,
        ctx.from,
        msg,
        rows,
        "Hanork Bot",
        ctx.info,
        "menu.jpg",
        "CTA",
        "Clique abaixo",
        ctx.telegramUserId
    );
}

async function promptCtaPhase(conn, ctx, phase) {
    const { view: config, slot } = ctaEditView(ctx.telegramUserId);
    const draft = ctx.session.divCtaDraft || {};
    let msg = '';
    if (phase === 'texto' || phase === 'edit_texto') {
        const atual = draft.texto || config.cta?.texto || '';
        msg = `PASSO 1 — TEXTO DO CARTAO CTA (slot ${slot})\n\n` +
            `Esse texto aparece em cima do botao. NAO e o texto normal (msgdivul).\n` +
            (atual ? `Atual:\n${atual}\n\n` : '') +
            `Manda o texto agora (ou responda uma msg).\n` +
            (atual ? `Digite manter pra nao mudar.\n` : '') +
            `cancelar pra sair.`;
    } else if (phase === 'label' || phase === 'edit_label') {
        const atual = draft.label || config.cta?.label || '';
        msg = `PASSO 2 — TEXTO DO 1o BOTAO\n\n` +
            `Ex: Saiba mais / Entrar / Grupo\n` +
            `Max ${CTA_LABEL_MAX} caracteres.\n` +
            (atual ? `Atual: ${atual}\n\n` : '') +
            `Manda o texto do botao.\n` +
            (atual ? `Digite manter pra nao mudar.\n` : '') +
            `cancelar pra sair.`;
    } else if (phase === 'url' || phase === 'edit_url') {
        const atual = draft.url || config.cta?.url || '';
        msg = `PASSO 3 — LINK DO 1o BOTAO\n\n` +
            `Cole a URL (https://... ou wa.me/...)\n` +
            (atual ? `Atual: ${atual}\n\n` : '') +
            `Manda o link agora.\n` +
            (atual ? `Digite manter pra nao mudar.\n` : '') +
            `cancelar pra sair.`;
    } else if (phase === 'label2' || phase === 'edit_label2') {
        const atual = draft.label2 || config.cta?.label2 || '';
        msg = `PASSO 4 — 2o BOTAO (opcional)\n\n` +
            `Outro botao, outro link. Max ${CTA_LABEL_MAX} caracteres.\n` +
            (atual ? `Atual: ${atual}\n\n` : '') +
            `Manda o texto do 2o botao.\n` +
            `pular pra ficar so com 1 botao.\n` +
            (atual ? `Digite manter pra nao mudar.\n` : '') +
            `cancelar pra sair.`;
    } else {
        const atual = draft.url2 || config.cta?.url2 || '';
        msg = `PASSO 5 — LINK DO 2o BOTAO\n\n` +
            `Cole a 2a URL (https://... ou wa.me/...)\n` +
            (atual ? `Atual: ${atual}\n\n` : '') +
            `Manda o link agora.\n` +
            `pular pra tirar o 2o botao.\n` +
            (atual ? `Digite manter pra nao mudar.\n` : '') +
            `cancelar pra sair.`;
    }
    await sendDivulgacaoMessage(conn, ctx, { text: pvReplyHint(ctx, conn) + msg }, { quoted: ctx.info });
}

function ensureDivSession(ctx) {
    if (!ctx.session || typeof ctx.session !== 'object') {
        try {
            const { getConversationSession } = require('../../utils/conversationSession');
            ctx.session = getConversationSession(ctx.sessionId, ctx.sender);
        } catch (_) {
            ctx.session = { step: null };
        }
    }
    return ctx.session;
}

const MEDIA_LABEL = {
    image: 'imagem',
    video: 'video',
    gif: 'GIF',
    audio: 'audio',
    document: 'documento'
};

function mediaStepName(kind, slot) {
    if (slot === 'cta') return kind === 'video' ? 'awaiting_divctavideo' : 'awaiting_divctafoto';
    if (slot === 'status') return kind === 'video' ? 'awaiting_divstatusvideo' : 'awaiting_divstatusimage';
    if (kind === 'image') return 'awaiting_divimage';
    return 'awaiting_div' + kind;
}

async function promptAwaitMedia(conn, ctx, kind, slot) {
    ensureDivSession(ctx);
    setStep(ctx, mediaStepName(kind, slot));
    const what = slot === 'cta'
        ? (kind === 'video' ? 'video do CTA' : 'foto do CTA')
        : slot === 'status'
            ? ((MEDIA_LABEL[kind] || 'midia') + ' do status')
            : (MEDIA_LABEL[kind] || 'midia');
    await sendButtonsWithImage(
        conn,
        ctx.from,
        'Manda a ' + what + ' agora (ou responde uma).\n\nPode mandar direto, sem comando.\ncancelar pra sair.',
        [
            { id: 'div_config_midia', label: 'Voltar' },
            { id: 'div_menu', label: 'Menu' }
        ],
        'Hanork Bot',
        ctx.info,
        'menu.jpg',
        slot === 'cta' ? 'FOTO CTA' : 'MIDIA',
        'Clique abaixo',
        ctx.telegramUserId
    );
}

async function saveCapturedTexto(conn, ctx, kind) {
    const captured = await captureMediaFromCtx(ctx, kind);
    if (!captured) return false;
    saveTextoMediaBuffer(ctx.telegramUserId, captured.buffer, {
        tipo: captured.tipo,
        mimetype: captured.mimetype,
        fileName: captured.fileName,
        caption: captured.caption
    });
    await sendButtonsWithImage(
        conn,
        ctx.from,
        (MEDIA_LABEL[kind] || 'Midia') + ' salva!\nLegenda: ' + (captured.caption || 'Nenhuma'),
        [
            { id: 'div_config', label: 'Configurar' },
            { id: 'div_preview', label: 'Preview' },
            { id: 'div_menu', label: 'Voltar' }
        ],
        'Hanork Bot',
        ctx.info,
        kind === 'image' ? captured.buffer : 'menu.jpg',
        'MIDIA SALVA',
        'Clique abaixo',
        ctx.telegramUserId
    );
    return true;
}

async function saveCapturedStatus(conn, ctx, kind) {
    const captured = await captureMediaFromCtx(ctx, kind);
    if (!captured) return false;
    saveStatusMediaBuffer(ctx.telegramUserId, captured.buffer, {
        tipo: captured.tipo,
        mimetype: captured.mimetype,
        fileName: captured.fileName
    });
    await sendButtonsWithImage(
        conn,
        ctx.from,
        (MEDIA_LABEL[kind] || 'Midia') + ' do STATUS salva!',
        [
            { id: 'div_config_midia', label: 'Midias' },
            { id: 'div_config', label: 'Configurar' },
            { id: 'div_preview', label: 'Preview' }
        ],
        'Hanork Bot',
        ctx.info,
        kind === 'image' ? captured.buffer : 'menu.jpg',
        'STATUS MIDIA',
        'Clique abaixo',
        ctx.telegramUserId
    );
    return true;
}

async function saveCapturedCta(conn, ctx, kind = 'image') {
    const captured = await captureMediaFromCtx(ctx, kind);
    if (!captured) return false;
    saveCtaMediaBuffer(ctx.telegramUserId, captured.buffer, {
        tipo: captured.tipo || kind,
        mimetype: captured.mimetype
    });
    await sendButtonsWithImage(
        conn,
        ctx.from,
        (kind === 'video' ? 'Video' : 'Foto') + ' do CTA salva!\n\n' + formatCtaSummary(ctaEditView(ctx.telegramUserId).view),
        [
            { id: 'div_tipo_cta', label: 'Enviar CTA' },
            { id: 'div_preview', label: 'Preview' },
            { id: 'div_config_midia', label: 'Midias' }
        ],
        'Hanork Bot',
        ctx.info,
        kind === 'image' ? captured.buffer : 'menu.jpg',
        'CTA MIDIA',
        'Clique abaixo',
        ctx.telegramUserId
    );
    return true;
}

async function runMediaCommand(conn, ctx, kind, slot) {
    if (!(await requireSessionOwner(conn, ctx))) return;
    try {
        if (slot === 'cta') {
            if (await saveCapturedCta(conn, ctx, kind === 'video' ? 'video' : 'image')) return;
            return promptAwaitMedia(conn, ctx, kind === 'video' ? 'video' : 'image', 'cta');
        }
        if (slot === 'status') {
            if (await saveCapturedStatus(conn, ctx, kind)) return;
            return promptAwaitMedia(conn, ctx, kind, 'status');
        }
        if (await saveCapturedTexto(conn, ctx, kind)) return;
        return promptAwaitMedia(conn, ctx, kind, 'texto');
    } catch (e) {
        logger.logErro(slot === 'cta' ? 'fotodivulcta' : (kind + 'divul'), e.message);
        await sendDivulgacaoMessage(conn, ctx, { text: 'Erro: ' + e.message }, { quoted: ctx.info });
    }
}

function skipSecondCta(raw) {
    const t = String(raw || '').trim().toLowerCase();
    return ['pular', 'pula', 'nao', 'skip', 'nenhum', 'so1', 'so 1', 'sem'].includes(t);
}

function ctaDraftFrom(config) {
    const cta = config?.cta || {};
    return {
        texto: cta.texto || '',
        label: cta.label || '',
        url: cta.url || '',
        label2: cta.label2 || '',
        url2: cta.url2 || ''
    };
}

async function startCtaWizard(conn, ctx) {
    const session = ensureDivSession(ctx);
    const config = getConfig(ctx.telegramUserId);
    session.divCtaDraft = ctaDraftFrom(config);
    session.divCtaPhase = 'texto';
    setStep(ctx, 'awaiting_divcta');
    await promptCtaPhase(conn, ctx, 'texto');
}

async function startCtaEdit(conn, ctx, field) {
    const session = ensureDivSession(ctx);
    const config = getConfig(ctx.telegramUserId);
    session.divCtaDraft = ctaDraftFrom(config);
    const map = {
        label: 'edit_label',
        url: 'edit_url',
        label2: 'edit_label2',
        url2: 'edit_url2',
        texto: 'edit_texto'
    };
    const phase = map[field] || 'edit_texto';
    session.divCtaPhase = phase;
    setStep(ctx, 'awaiting_divcta');
    await promptCtaPhase(conn, ctx, phase);
}

async function startTextoPrompt(conn, ctx) {
    ensureDivSession(ctx);
    setStep(ctx, 'awaiting_divtexto');
    const config = getConfig(ctx.telegramUserId);
    const atual = String(config.texto || '').trim();
    await sendDivulgacaoMessage(conn, ctx, {
        text: pvReplyHint(ctx, conn) +
            'TEXTO NORMAL (separado do CTA e do pagamento)\n\n' +
            'Pode colar varios links.\n' +
            (atual ? `Atual:\n${atual}\n\n` : '') +
            'Manda o texto agora (ou responda uma msg).\n' +
            'cancelar pra sair.'
    }, { quoted: ctx.info });
}

async function startPayPrompt(conn, ctx) {
    ensureDivSession(ctx);
    setStep(ctx, 'awaiting_divpaytexto');
    const config = getConfig(ctx.telegramUserId);
    const atual = String(config.textoPay || '').trim();
    await sendDivulgacaoMessage(conn, ctx, {
        text: pvReplyHint(ctx, conn) +
            'TEXTO DO PAGAMENTO (separado do texto normal e do CTA)\n\n' +
            (atual ? `Atual:\n${atual}\n\n` : '') +
            'Manda o texto agora (ou responda uma msg).\n' +
            'cancelar pra sair.'
    }, { quoted: ctx.info });
}

async function startStatusPrompt(conn, ctx) {
    ensureDivSession(ctx);
    setStep(ctx, 'awaiting_divstatustexto');
    const { view: config, slot } = statusEditView(ctx.telegramUserId);
    const atual = String(config.textoStatus || '').trim();
    await sendDivulgacaoMessage(conn, ctx, {
        text: pvReplyHint(ctx, conn) +
            `TEXTO DO STATUS — slot ${slot} (separado do texto normal, CTA e pagamento)\n\n` +
            (atual ? `Atual:\n${atual}\n\n` : '') +
            'Manda o texto agora (ou responda uma msg).\n' +
            'Midia: menu Midias > Foto/Video status.\n' +
            'cancelar pra sair.'
    }, { quoted: ctx.info });
}

async function showStatusPanel(conn, ctx, notice = '') {
    if (!(await requireSessionOwner(conn, ctx))) return;
    const { isModoOn } = require('../../utils/divulgacaoAuto');
    const { view: config, slot } = statusEditView(ctx.telegramUserId);
    const autoOn = isModoOn(getConfig(ctx.telegramUserId), modoKey('status', slot));
    const adm = isDivAdmin(ctx.telegramUserId);
    const head = notice ? `${String(notice).trim()}\n\n` : '';
    let inviteHint = '';
    if (adm) {
      try {
        const { resolveInviteGroupJid, PLACEHOLDER } = require('../../utils/divulgacaoInviteLink');
        const jid = resolveInviteGroupJid({ telegramUserId: ctx.telegramUserId });
        inviteHint =
          `\nLink vivo no texto: ${PLACEHOLDER}\n` +
          `Grupo convite: ${jid || '(toque em Grupo do convite)'}\n`;
      } catch (_) { /* ignore */ }
    }
    const rows = [
            { id: 'div_config_status_texto', label: 'Texto status' },
            { id: 'div_midia_status_foto', label: 'Foto status' },
            { id: 'div_midia_status_video', label: 'Video status' },
            { id: 'div_midia_status_rm', label: 'Tirar midia' },
            { id: 'div_tipo_status', label: 'Enviar agora' },
            { id: 'div_config_auto', label: 'Automatico' }
    ];
    if (adm) {
      rows.push(
        { id: 'div_invite_tpl_status', label: 'Texto oficial+link' },
        { id: 'div_invite_setgrupo', label: 'Grupo do convite' },
        { id: 'div_invite_preview_status', label: 'Preview link vivo' }
      );
    }
    rows.push({ id: 'div_config', label: 'Voltar' });
    await sendButtonsWithImage(
        conn,
        ctx.from,
        `${head}STATUS DA DIVULGACAO — slot ${slot}${adm ? ' (edicao ativa)' : ''}\n\n` +
        `${formatStatusSummary(config)}\n` +
        inviteHint +
        `\nCiclo auto deste tipo: ${autoOn ? 'ON' : 'OFF'}\n` +
        `Texto e midia do status NAO mexem no texto/CTA/pay.\n` +
        `Enviar agora posta STATUS NORMAL na bandeja (todo mundo ve, inclusive admin).\n` +
        `Liga o ciclo em Automatico (Status ON). A contagem comeca na hora que ligar.`,
        rows,
        'Hanork Bot',
        ctx.info,
        'menu.jpg',
        'STATUS',
        'Clique abaixo',
        ctx.telegramUserId
    );
}

async function finishCtaSave(conn, ctx, draft) {
    const texto = String(draft.texto || '').trim();
    const label = clampCtaLabel(draft.label);
    const url = normalizeCtaUrl(draft.url);
    const label2 = clampCtaLabel(draft.label2);
    const url2 = normalizeCtaUrl(draft.url2);
    if (!texto || !label || !url) {
        await sendDivulgacaoMessage(conn, ctx, {
            text: `CTA incompleto. Falta: ${ctaMissing({ cta: { texto, label, url } }).join(', ')}`
        }, { quoted: ctx.info });
        return false;
    }
    const patch = { texto, label, url };
    if (label2 && url2) {
        patch.label2 = label2;
        patch.url2 = url2;
    } else {
        patch.label2 = '';
        patch.url2 = '';
    }
    updateConfig(ctx.telegramUserId, {
        cta: patch,
        configurado: true
    });
    if (ctx.session) {
        ctx.session.divCtaDraft = null;
        ctx.session.divCtaPhase = null;
    }
    await sendButtonsWithImage(
        conn,
        ctx.from,
        `CTA pronto!\n\n${formatCtaSummary({ cta: patch })}\n\n` +
        `Isso NAO altera o texto normal (msgdivul) nem o de pagamento.\n` +
        `1a msg: mencoes (ignora admins). Invisivel: so o que falar.\n` +
        `Foto: fotodivulcta (responda uma imagem)`,
        [
            { id: "div_tipo_cta", label: "Enviar CTA" },
            { id: "div_preview", label: "Preview" },
            { id: "gm_home", label: "Grupos" },
            { id: "div_config", label: "Configurar" }
        ],
        "Hanork Bot",
        ctx.info,
        "menu.jpg",
        "CTA SALVO",
        "Clique abaixo",
        ctx.telegramUserId
    );
    return true;
}

const stepHandlers = {
    async awaiting_divcta(conn, ctx, text) {
        const session = ensureDivSession(ctx);
        const phase = session.divCtaPhase || 'texto';
        const draft = session.divCtaDraft || {};
        const quoted = extractQuotedText(ctx);
        const raw = String(text || '').trim() || quoted;

        if (phase === 'texto' || phase === 'edit_texto') {
            if (keepToken(raw) && (draft.texto || getConfig(ctx.telegramUserId).cta?.texto)) {
                draft.texto = draft.texto || getConfig(ctx.telegramUserId).cta.texto;
            } else if (!raw) {
                await sendDivulgacaoMessage(conn, ctx, { text: 'Texto vazio. Manda de novo ou cancelar.' }, { quoted: ctx.info });
                return false;
            } else {
                draft.texto = raw;
            }
            session.divCtaDraft = draft;
            if (phase === 'edit_texto') {
                const probe = {
                    cta: {
                        texto: draft.texto,
                        label: draft.label,
                        url: draft.url,
                        label2: draft.label2,
                        url2: draft.url2
                    }
                };
                if (isCtaReady(probe)) return await finishCtaSave(conn, ctx, draft);
                session.divCtaPhase = clampCtaLabel(draft.label) ? 'url' : 'label';
                await promptCtaPhase(conn, ctx, session.divCtaPhase);
                return false;
            }
            session.divCtaPhase = 'label';
            await promptCtaPhase(conn, ctx, 'label');
            return false;
        }

        if (phase === 'label' || phase === 'edit_label') {
            if (keepToken(raw) && (draft.label || getConfig(ctx.telegramUserId).cta?.label)) {
                draft.label = clampCtaLabel(draft.label || getConfig(ctx.telegramUserId).cta.label);
            } else if (!raw) {
                await sendDivulgacaoMessage(conn, ctx, { text: 'Texto do botao vazio. Manda de novo ou cancelar.' }, { quoted: ctx.info });
                return false;
            } else {
                const clipped = clampCtaLabel(raw);
                if (!clipped) {
                    await sendDivulgacaoMessage(conn, ctx, { text: 'Texto do botao invalido.' }, { quoted: ctx.info });
                    return false;
                }
                if (clipped.length < raw.trim().length) {
                    await sendDivulgacaoMessage(conn, ctx, { text: `Botao cortado pra ${CTA_LABEL_MAX} caracteres: ${clipped}` }, { quoted: ctx.info });
                }
                draft.label = clipped;
            }
            session.divCtaDraft = draft;
            if (phase === 'edit_label') {
                const probe = {
                    cta: {
                        texto: draft.texto,
                        label: draft.label,
                        url: draft.url,
                        label2: draft.label2,
                        url2: draft.url2
                    }
                };
                if (isCtaReady(probe)) return await finishCtaSave(conn, ctx, draft);
                session.divCtaPhase = String(draft.texto || '').trim() ? 'url' : 'texto';
                await promptCtaPhase(conn, ctx, session.divCtaPhase);
                return false;
            }
            session.divCtaPhase = 'url';
            await promptCtaPhase(conn, ctx, 'url');
            return false;
        }

        if (phase === 'url' || phase === 'edit_url') {
            if (keepToken(raw) && (draft.url || getConfig(ctx.telegramUserId).cta?.url)) {
                draft.url = normalizeCtaUrl(draft.url || getConfig(ctx.telegramUserId).cta.url);
            } else {
                const url = normalizeCtaUrl(raw);
                if (!url) {
                    await sendDivulgacaoMessage(conn, ctx, { text: 'Link invalido. Cole uma URL (https://... ou wa.me/...) ou cancelar.' }, { quoted: ctx.info });
                    return false;
                }
                draft.url = url;
            }
            session.divCtaDraft = draft;
            if (phase === 'edit_url') return await finishCtaSave(conn, ctx, draft);
            session.divCtaPhase = 'label2';
            await promptCtaPhase(conn, ctx, 'label2');
            return false;
        }

        if (phase === 'label2' || phase === 'edit_label2') {
            if (skipSecondCta(raw)) {
                draft.label2 = '';
                draft.url2 = '';
                session.divCtaDraft = draft;
                return await finishCtaSave(conn, ctx, draft);
            }
            if (keepToken(raw) && (draft.label2 || getConfig(ctx.telegramUserId).cta?.label2)) {
                draft.label2 = clampCtaLabel(draft.label2 || getConfig(ctx.telegramUserId).cta.label2);
            } else if (!raw) {
                await sendDivulgacaoMessage(conn, ctx, { text: 'Texto do 2o botao vazio. Manda de novo, pular ou cancelar.' }, { quoted: ctx.info });
                return false;
            } else {
                const clipped = clampCtaLabel(raw);
                if (!clipped) {
                    await sendDivulgacaoMessage(conn, ctx, { text: 'Texto do 2o botao invalido.' }, { quoted: ctx.info });
                    return false;
                }
                if (clipped.length < raw.trim().length) {
                    await sendDivulgacaoMessage(conn, ctx, { text: `Botao cortado pra ${CTA_LABEL_MAX} caracteres: ${clipped}` }, { quoted: ctx.info });
                }
                draft.label2 = clipped;
            }
            session.divCtaDraft = draft;
            if (phase === 'edit_label2' && normalizeCtaUrl(draft.url2)) {
                return await finishCtaSave(conn, ctx, draft);
            }
            session.divCtaPhase = phase === 'edit_label2' ? 'edit_url2' : 'url2';
            await promptCtaPhase(conn, ctx, session.divCtaPhase);
            return false;
        }

        if (skipSecondCta(raw)) {
            draft.label2 = '';
            draft.url2 = '';
            session.divCtaDraft = draft;
            return await finishCtaSave(conn, ctx, draft);
        }
        if (keepToken(raw) && (draft.url2 || getConfig(ctx.telegramUserId).cta?.url2)) {
            draft.url2 = normalizeCtaUrl(draft.url2 || getConfig(ctx.telegramUserId).cta.url2);
        } else {
            const url2 = normalizeCtaUrl(raw);
            if (!url2) {
                await sendDivulgacaoMessage(conn, ctx, { text: '2o link invalido. Cole uma URL ou pular / cancelar.' }, { quoted: ctx.info });
                return false;
            }
            draft.url2 = url2;
        }
        session.divCtaDraft = draft;
        return await finishCtaSave(conn, ctx, draft);
    },
    async awaiting_divtexto(conn, ctx, text) {
        const quoted = extractQuotedText(ctx);
        const raw = String(text || '').trim() || quoted;
        if (!raw) {
            await sendDivulgacaoMessage(conn, ctx, { text: 'Texto vazio. Manda de novo ou cancelar.' }, { quoted: ctx.info });
            return false;
        }
        updateConfig(ctx.telegramUserId, { texto: raw, configurado: true });
        await sendButtonsWithImage(
            conn,
            ctx.from,
            `Texto normal salvo (nao mexe no CTA nem no pagamento).\n\n${raw}`,
            [
                { id: "div_tipo_normal", label: "Enviar texto" },
                { id: "div_preview", label: "Preview" },
                { id: "div_config", label: "Configurar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "TEXTO SALVO",
            "Clique abaixo",
            ctx.telegramUserId
        );
        return true;
    },
    async awaiting_divpaytexto(conn, ctx, text) {
        const quoted = extractQuotedText(ctx);
        const raw = String(text || '').trim() || quoted;
        if (!raw) {
            await sendDivulgacaoMessage(conn, ctx, { text: 'Texto vazio. Manda de novo ou cancelar.' }, { quoted: ctx.info });
            return false;
        }
        updateConfig(ctx.telegramUserId, { textoPay: raw, configurado: true });
        await sendButtonsWithImage(
            conn,
            ctx.from,
            `Texto de pagamento salvo (nao mexe no texto normal nem no CTA).\n\n${raw}`,
            [
                { id: "div_tipo_pay", label: "Enviar pagamento" },
                { id: "div_preview", label: "Preview" },
                { id: "div_config", label: "Configurar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "PAY SALVO",
            "Clique abaixo",
            ctx.telegramUserId
        );
        return true;
    },
    async awaiting_divstatustexto(conn, ctx, text) {
        const quoted = extractQuotedText(ctx);
        const raw = String(text || '').trim() || quoted;
        if (!raw) {
            await sendDivulgacaoMessage(conn, ctx, { text: 'Texto vazio. Manda de novo ou cancelar.' }, { quoted: ctx.info });
            return false;
        }
        updateConfig(ctx.telegramUserId, { textoStatus: raw, configurado: true });
        await sendButtonsWithImage(
            conn,
            ctx.from,
            `Texto do STATUS salvo (nao mexe no texto normal, CTA nem pagamento).\n\n${raw}`,
            [
                { id: 'div_tipo_status', label: 'Enviar status' },
                { id: 'div_midia_status_foto', label: 'Foto status' },
                { id: 'div_config', label: 'Configurar' }
            ],
            'Hanork Bot',
            ctx.info,
            'menu.jpg',
            'STATUS SALVO',
            'Clique abaixo',
            ctx.telegramUserId
        );
        return true;
    },
    async awaiting_divctafoto(conn, ctx) {
        if (await saveCapturedCta(conn, ctx, 'image')) return true;
        await sendDivulgacaoMessage(conn, ctx, { text: 'Precisa ser uma imagem. Manda de novo ou cancelar.' }, { quoted: ctx.info });
        return false;
    },
    async awaiting_divctavideo(conn, ctx) {
        if (await saveCapturedCta(conn, ctx, 'video')) return true;
        await sendDivulgacaoMessage(conn, ctx, { text: 'Precisa ser um video. Manda de novo ou cancelar.' }, { quoted: ctx.info });
        return false;
    },
    async awaiting_divimage(conn, ctx) {
        if (await saveCapturedTexto(conn, ctx, 'image')) return true;
        await sendDivulgacaoMessage(conn, ctx, { text: 'Precisa ser uma imagem. Manda de novo ou cancelar.' }, { quoted: ctx.info });
        return false;
    },
    async awaiting_divvideo(conn, ctx) {
        if (await saveCapturedTexto(conn, ctx, 'video')) return true;
        await sendDivulgacaoMessage(conn, ctx, { text: 'Precisa ser um video. Manda de novo ou cancelar.' }, { quoted: ctx.info });
        return false;
    },
    async awaiting_divgif(conn, ctx) {
        if (await saveCapturedTexto(conn, ctx, 'gif')) return true;
        await sendDivulgacaoMessage(conn, ctx, { text: 'Precisa ser um GIF (ou video). Manda de novo ou cancelar.' }, { quoted: ctx.info });
        return false;
    },
    async awaiting_divaudio(conn, ctx) {
        if (await saveCapturedTexto(conn, ctx, 'audio')) return true;
        await sendDivulgacaoMessage(conn, ctx, { text: 'Precisa ser um audio. Manda de novo ou cancelar.' }, { quoted: ctx.info });
        return false;
    },
    async awaiting_divdocument(conn, ctx) {
        if (await saveCapturedTexto(conn, ctx, 'document')) return true;
        await sendDivulgacaoMessage(conn, ctx, { text: 'Precisa ser um documento. Manda de novo ou cancelar.' }, { quoted: ctx.info });
        return false;
    },
    async awaiting_divstatusimage(conn, ctx) {
        if (await saveCapturedStatus(conn, ctx, 'image')) return true;
        await sendDivulgacaoMessage(conn, ctx, { text: 'Precisa ser uma imagem. Manda de novo ou cancelar.' }, { quoted: ctx.info });
        return false;
    },
    async awaiting_divstatusvideo(conn, ctx) {
        if (await saveCapturedStatus(conn, ctx, 'video')) return true;
        await sendDivulgacaoMessage(conn, ctx, { text: 'Precisa ser um video. Manda de novo ou cancelar.' }, { quoted: ctx.info });
        return false;
    }
};

// ========== CONFIGURAÇÃO BÁSICA ==========
commands.msgdivul = {
    useCtx: true,
    description: "Define o texto da divulgacao NORMAL (varios links)",
    usage: "msgdivul <texto>",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const quotedMsg = ctx.info?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        let texto = ctx.text;
        if (quotedMsg) {
            const quotedText = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || '';
            if (quotedText) texto = quotedText;
        }
        if (!texto) {
            ensureDivSession(ctx);
            setStep(ctx, 'awaiting_divtexto');
            return sendDivulgacaoMessage(conn, ctx, {
                text: 'Manda o TEXTO NORMAL agora (pode ter varios links).\nIsso NAO altera o CTA.\n\ncancelar pra sair.'
            }, { quoted: ctx.info });
        }
        updateConfig(ctx.telegramUserId, { texto, configurado: true });
        sendButtonsWithImage(
            conn,
            ctx.from,
            `Texto normal salvo!\n\n${texto}\n\nNao mexe no CTA nem no pagamento.`,
            [
                { id: "div_tipo_normal", label: "Enviar texto" },
                { id: "div_preview", label: "Preview" },
                { id: "div_config", label: "Configurar" },
                { id: "div_menu", label: "Voltar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "TEXTO SALVO",
            "Clique abaixo",
            ctx.telegramUserId
        );
    }
};

commands.msgdivulpay = {
    useCtx: true,
    description: "Define o texto da divulgacao de PAGAMENTO",
    usage: "msgdivulpay <texto>",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const quoted = extractQuotedText(ctx);
        const texto = String(ctx.text || '').trim() || quoted;
        if (!texto) {
            ensureDivSession(ctx);
            setStep(ctx, 'awaiting_divpaytexto');
            return sendDivulgacaoMessage(conn, ctx, {
                text: 'Manda o TEXTO DO PAGAMENTO agora.\nIsso NAO altera o texto normal nem o CTA.\n\ncancelar pra sair.'
            }, { quoted: ctx.info });
        }
        updateConfig(ctx.telegramUserId, { textoPay: texto, configurado: true });
        sendButtonsWithImage(
            conn,
            ctx.from,
            `Texto de pagamento salvo!\n\n${texto}`,
            [
                { id: "div_tipo_pay", label: "Enviar pagamento" },
                { id: "div_config", label: "Configurar" },
                { id: "div_menu", label: "Voltar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "PAY SALVO",
            "Clique abaixo",
            ctx.telegramUserId
        );
    }
};

commands.msgdivulstatus = {
    useCtx: true,
    description: "Define o texto da divulgacao de STATUS",
    usage: "msgdivulstatus <texto>",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const quoted = extractQuotedText(ctx);
        const texto = String(ctx.text || '').trim() || quoted;
        if (!texto) {
            return startStatusPrompt(conn, ctx);
        }
        updateConfig(ctx.telegramUserId, { textoStatus: texto, configurado: true });
        sendButtonsWithImage(
            conn,
            ctx.from,
            `Texto do STATUS salvo!\n\n${texto}\n\nNao mexe no texto normal, CTA nem pagamento.`,
            [
                { id: 'div_tipo_status', label: 'Enviar status' },
                { id: 'div_midia_status_foto', label: 'Foto status' },
                { id: 'div_config', label: 'Configurar' },
                { id: 'div_menu', label: 'Voltar' }
            ],
            'Hanork Bot',
            ctx.info,
            'menu.jpg',
            'STATUS SALVO',
            'Clique abaixo',
            ctx.telegramUserId
        );
    }
};

commands.fotodivulstatus = {
    useCtx: true,
    description: "Define a imagem do STATUS da divulgacao",
    usage: "fotodivulstatus (envie ou responda uma imagem)",
    execute: async (conn, ctx) => runMediaCommand(conn, ctx, 'image', 'status')
};
commands.videodivulstatus = {
    useCtx: true,
    description: "Define o video do STATUS da divulgacao",
    usage: "videodivulstatus (envie ou responda)",
    execute: async (conn, ctx) => runMediaCommand(conn, ctx, 'video', 'status')
};

commands.fotodivul = {
    useCtx: true,
    description: "Define a imagem da divulgacao",
    usage: "fotodivul (envie ou responda uma imagem)",
    execute: async (conn, ctx) => runMediaCommand(conn, ctx, 'image', 'texto')
};
commands.videodivul = {
    useCtx: true,
    description: "Define o video da divulgacao",
    usage: "videodivul (envie ou responda)",
    execute: async (conn, ctx) => runMediaCommand(conn, ctx, 'video', 'texto')
};

commands.gifdivul = {
    useCtx: true,
    description: "Define um GIF para divulgacao",
    usage: "gifdivul (envie ou responda)",
    execute: async (conn, ctx) => runMediaCommand(conn, ctx, 'gif', 'texto')
};

commands.audiodivul = {
    useCtx: true,
    description: "Define um audio para divulgacao",
    usage: "audiodivul (envie ou responda)",
    execute: async (conn, ctx) => runMediaCommand(conn, ctx, 'audio', 'texto')
};

commands.documentodivul = {
    useCtx: true,
    description: "Define um documento para divulgacao",
    usage: "documentodivul (envie ou responda)",
    execute: async (conn, ctx) => runMediaCommand(conn, ctx, 'document', 'texto')
};
commands.apagardivul = {
    useCtx: true,
    description: "Remove toda configuracao salva",
    usage: "apagardivul",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        limparConfig(ctx.telegramUserId);
        sendButtonsWithImage(
            conn,
            ctx.from,
            "Configuracao removida com sucesso!",
            [
                { id: "div_menu", label: "Voltar" },
                { id: "menu", label: "Menu" }
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

async function previewLiveView(conn, uid, view) {
    const out = view && typeof view === 'object'
        ? { ...view, cta: view.cta && typeof view.cta === 'object' ? { ...view.cta } : view.cta }
        : view;
    try {
        const inv = require('../../utils/divulgacaoInviteLink');
        const gid = inv.resolveInviteGroupJid({ telegramUserId: uid });
        const live = conn && gid ? await inv.fetchLiveInviteLink(conn, gid, { telegramUserId: uid }) : { ok: false };
        const url = live && live.ok ? live.url : '';
        const swap = (s) => {
            let t = String(s || '');
            if (url) t = t.split(inv.PLACEHOLDER).join(url);
            return t;
        };
        if (out.cta) {
            if (typeof inv.stripInviteFromText === 'function') {
                out.cta.texto = inv.stripInviteFromText(out.cta.texto || '');
            }
            if (url && /\{\{/.test(String(out.cta.url || ''))) out.cta.url = url;
            if (url && /\{\{/.test(String(out.cta.url2 || ''))) out.cta.url2 = url;
        }
        if (out.textoStatus) out.textoStatus = swap(out.textoStatus);
        if (out.texto) out.texto = swap(out.texto);
        if (out.textoPay) out.textoPay = swap(out.textoPay);
        try {
            const canal = require('../../utils/canal');
            if (typeof canal.rewriteLegacyCanalText === 'function') {
                if (out.textoStatus) out.textoStatus = canal.rewriteLegacyCanalText(out.textoStatus);
                if (out.texto) out.texto = canal.rewriteLegacyCanalText(out.texto);
                if (out.textoPay) out.textoPay = canal.rewriteLegacyCanalText(out.textoPay);
                if (out.cta && typeof out.cta === 'object') {
                    for (const k of ['texto', 'url', 'url2', 'label', 'label2']) {
                        if (typeof out.cta[k] === 'string') out.cta[k] = canal.rewriteLegacyCanalText(out.cta[k]);
                    }
                }
            }
        } catch (_) { /* preview sem remap de canal */ }
    } catch (_) { /* preview sem convite live */ }
    return out;
}

async function previewCtaBlock(conn, ctx, view, uid, title) {
    const live = await previewLiveView(conn, uid, view);
    if (!live || !live.cta) {
        await sendDivulgacaoMessage(conn, ctx, {
            text: `${title}\n\n(incompleto — falta texto, botao ou link)\n\n${formatCtaSummary(view)}`
        }, { quoted: ctx.info });
        return;
    }
    const ctaImg = getCtaImageBuffer(live, uid);
    try {
        await sendButtonsWithImage(
            conn,
            ctx.from,
            `${title}\n\n${live.cta.texto}`,
            ctaUrlButtons(live, uid),
            '',
            ctx.info,
            ctaImg,
            title,
            '',
            uid,
            null,
            ctx.sessionId,
            { forceNative: true, rawLabels: true }
        );
    } catch (e) {
        logger.logAviso('preview cta: ' + e.message);
        await sendDivulgacaoMessage(conn, ctx, {
            text: `${title}\n\n${live.cta.texto}\n\n` +
                ctaUrlButtons(live, uid).map((b, i) => `Botao ${i + 1}: ${b.label}\n${b.url}`).join('\n')
        }, { quoted: ctx.info });
    }
}

async function previewStatusBlock(conn, ctx, view, uid, title) {
    const live = await previewLiveView(conn, uid, view);
    const caption = `${title}\n\n${live.textoStatus || '(so midia)'}`;
    const pack = getStatusMediaBuffer(live, uid);
    try {
        if (pack && pack.tipo === 'image') {
            await sendDivulgacaoMessage(conn, ctx, { image: pack.buffer, caption }, { quoted: ctx.info });
        } else if (pack && (pack.tipo === 'video' || pack.tipo === 'gif')) {
            await sendDivulgacaoMessage(conn, ctx, {
                video: pack.buffer,
                gifPlayback: pack.tipo === 'gif',
                caption
            }, { quoted: ctx.info });
        } else {
            await sendDivulgacaoMessage(conn, ctx, { text: caption }, { quoted: ctx.info });
        }
    } catch (e) {
        logger.logAviso('preview status: ' + e.message);
    }
}

// ========== PREVIEW SEPARADO POR TIPO ==========
commands.previewdivul = {
    useCtx: true,
    description: "Mostra como a divulgacao ficara",
    usage: "previewdivul",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const uid = ctx.telegramUserId;
        const cfg = getConfig(uid);
        const adm = isDivAdmin(uid);
        try {
            const { hydrateAdminAffiliate } = require('../../utils/divulgacaoAdminDefaults');
            if (typeof hydrateAdminAffiliate === 'function') await hydrateAdminAffiliate(cfg, uid);
        } catch (_) { /* preview segue mesmo sem afiliado */ }

        const ctaSlots = adm ? SLOT_IDS : [1];
        const statusSlots = adm ? SLOT_IDS : [1];
        const ctaViews = ctaSlots.map((s) => ({ slot: s, view: applyViewConfig(cfg, 'cta', s) }));
        const statusViews = statusSlots.map((s) => ({ slot: s, view: applyViewConfig(cfg, 'status', s) }));
        const hasTexto = isTextoReady(cfg);
        const hasPay = isPayReady(cfg);
        const hasCta = ctaViews.some((x) => isCtaReady(x.view));
        const hasStatus = statusViews.some((x) => isStatusReady(x.view));
        if (!hasTexto && !hasCta && !hasPay && !hasStatus && !cfg.configurado) {
            return sendButtonsWithImage(
                conn,
                ctx.from,
                "Configure pelo menos um tipo: texto, CTA, pagamento ou status.",
                [
                    { id: "div_config_texto", label: "Texto" },
                    { id: "div_config_cta", label: "CTA" },
                    { id: "div_config_pay", label: "Pagamento" },
                    { id: "div_config_status", label: "Status" },
                    { id: "div_menu", label: "Voltar" }
                ],
                "Hanork Bot",
                ctx.info,
                "menu.jpg",
                "ERRO",
                "Clique abaixo",
                ctx.telegramUserId
            );
        }

        const ctaTitle = (s) => (s === 2 ? 'PREVIEW CTA #2 (grupo oficial)' : 'PREVIEW CTA #1 (venda do bot)');
        const statusTitle = (s) => (s === 2 ? 'PREVIEW STATUS #2 (venda do bot)' : 'PREVIEW STATUS #1 (grupo oficial)');
        for (const item of ctaViews) {
            await previewCtaBlock(conn, ctx, item.view, uid, ctaTitle(item.slot));
        }

        if (hasTexto) {
            try {
                const live = await previewLiveView(conn, uid, cfg);
                const caption = `PREVIEW TEXTO (venda do bot)\n\n${live.texto}`;
                const pack = getTextoMediaBuffer(live, uid);
                if (pack && pack.tipo === 'image') {
                    await sendDivulgacaoMessage(conn, ctx, { image: pack.buffer, caption }, { quoted: ctx.info });
                } else if (pack && (pack.tipo === 'video' || pack.tipo === 'gif')) {
                    await sendDivulgacaoMessage(conn, ctx, {
                        video: pack.buffer,
                        gifPlayback: pack.tipo === 'gif',
                        caption
                    }, { quoted: ctx.info });
                } else if (pack && pack.tipo === 'audio') {
                    await sendDivulgacaoMessage(conn, ctx, {
                        audio: pack.buffer,
                        mimetype: pack.mimetype || 'audio/mpeg'
                    }, { quoted: ctx.info });
                    await sendDivulgacaoMessage(conn, ctx, { text: caption }, { quoted: ctx.info });
                } else if (pack && pack.tipo === 'document') {
                    await sendDivulgacaoMessage(conn, ctx, {
                        document: pack.buffer,
                        fileName: pack.fileName || 'documento.pdf',
                        caption
                    }, { quoted: ctx.info });
                } else {
                    await sendDivulgacaoMessage(conn, ctx, { text: caption }, { quoted: ctx.info });
                }
            } catch (e) {
                logger.logAviso('preview texto: ' + e.message);
            }
        }

        if (hasPay) {
            try {
                const live = await previewLiveView(conn, uid, cfg);
                await sendDivulgacaoMessage(conn, ctx, {
                    text: `PREVIEW PAGAMENTO (venda do bot)\n\n${live.textoPay}`
                }, { quoted: ctx.info });
            } catch (_) { /* */ }
        }

        for (const item of statusViews) {
            await previewStatusBlock(conn, ctx, item.view, uid, statusTitle(item.slot));
        }

        const slotLine = adm
            ? `${formatSlotsSummary(cfg, uid)}\n\nCTA 1 e Status 2 = bot. CTA 2 e Status 1 = grupo.\n`
            : '';
        const actionRows = [
            { id: "div_tipo_normal", label: "Enviar texto" },
            { id: "div_tipo_cta", label: "Enviar CTA 1" },
            { id: "div_tipo_pay", label: "Enviar pagamento" },
            { id: "div_tipo_status", label: "Enviar status 1" }
        ];
        if (adm) {
            actionRows.push(
                { id: "div_slots", label: "CTA/Status #2" },
                { id: "div_slot_set_cta_1", label: "Editar CTA 1" },
                { id: "div_slot_set_cta_2", label: "Editar CTA 2" },
                { id: "div_slot_set_status_1", label: "Editar status 1" },
                { id: "div_slot_set_status_2", label: "Editar status 2" }
            );
        } else {
            actionRows.push(
                { id: "div_config_cta", label: "Editar CTA" },
                { id: "div_config_status", label: "Editar status" }
            );
        }
        actionRows.push(
            { id: "div_config_texto", label: "Editar texto" },
            { id: "div_config_pay", label: "Editar pagamento" },
            { id: "div_menu", label: "Voltar" }
        );
        await sendButtonsWithImage(
            conn,
            ctx.from,
            `*PREVIEW DA DIVULGACAO*\n\n` +
            `${slotLine}` +
            `No envio, so o tipo que voce escolher.\n\n` +
            `${adm ? '' : formatTracksSummary(cfg) + '\n\n'}` +
            `1a msg: mencoes (membros, ignora admins). Invisivel: so o que falar.`,
            actionRows,
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "ACOES",
            "Clique abaixo",
            ctx.telegramUserId
        );
    }
};
// ========== CTA ==========
commands.divcta = {
    useCtx: true,
    description: "Configura CTA: texto + ate 2 botoes com URL",
    usage: "divcta [texto | botao | url | botao2 | url2]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const raw = String(ctx.text || '').trim();
        if (!raw) {
            const { view } = ctaEditView(ctx.telegramUserId);
            if (isCtaReady(view)) return showCtaPanel(conn, ctx);
            return startCtaWizard(conn, ctx);
        }
        const parts = parseCtaParts(raw);
        if (!parts) {
            return startCtaWizard(conn, ctx);
        }
        const { view: current } = ctaEditView(ctx.telegramUserId);
        const texto = parts.texto || current.cta?.texto || '';
        const label = clampCtaLabel(parts.label);
        const url = normalizeCtaUrl(parts.url);
        const label2 = parts.label2 != null ? clampCtaLabel(parts.label2) : (current.cta?.label2 || '');
        const url2 = parts.url2 != null ? (normalizeCtaUrl(parts.url2) || '') : (current.cta?.url2 || '');
        if (!url) {
            return sendDivulgacaoMessage(conn, ctx, { text: "URL invalida. Use http:// ou https:// (ou wa.me/...)" }, { quoted: ctx.info });
        }
        if (!label) {
            return sendDivulgacaoMessage(conn, ctx, { text: "Texto do botao vazio." }, { quoted: ctx.info });
        }
        if (parts.label2 != null && parts.url2 != null && (!label2 || !normalizeCtaUrl(url2))) {
            return sendDivulgacaoMessage(conn, ctx, { text: "2o botao incompleto. Precisa texto e URL validos, ou deixe so 1 botao." }, { quoted: ctx.info });
        }
        if (!texto) {
            updateConfig(ctx.telegramUserId, { cta: { label, url, label2, url2 } });
            await sendButtonsWithImage(
                conn,
                ctx.from,
                `Botao e link salvos.\n\nBotao 1: ${label}\nLink 1: ${url}` +
                (label2 && url2 ? `\nBotao 2: ${label2}\nLink 2: ${url2}` : '') +
                `\n\nAinda falta o texto da mensagem.`,
                [
                    { id: "div_cta_texto", label: "Texto da mensagem" },
                    { id: "div_cta_wizard", label: "Configurar tudo" },
                    { id: "div_preview", label: "Preview" }
                ],
                "Hanork Bot",
                ctx.info,
                "menu.jpg",
                "CTA",
                "Clique abaixo",
                ctx.telegramUserId
            );
            return;
        }
        await finishCtaSave(conn, ctx, { texto, label, url, label2, url2 });
    }
};

commands.div_cta_wizard = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        await startCtaWizard(conn, ctx);
    }
};

commands.div_cta_texto = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        await startCtaEdit(conn, ctx, 'texto');
    }
};

commands.div_cta_label = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        await startCtaEdit(conn, ctx, 'label');
    }
};

commands.div_cta_url = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        await startCtaEdit(conn, ctx, 'url');
    }
};

commands.div_cta_label2 = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        await startCtaEdit(conn, ctx, 'label2');
    }
};

commands.div_cta_url2 = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        await startCtaEdit(conn, ctx, 'url2');
    }
};

commands.div_cta_btn2_rm = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        updateConfig(ctx.telegramUserId, { cta: { label2: '', url2: '' } });
        await showCtaPanel(conn, ctx);
    }
};

commands.fotodivulcta = {
    useCtx: true,
    description: "Define a imagem do cartao CTA",
    usage: "fotodivulcta (envie ou responda uma imagem)",
    execute: async (conn, ctx) => runMediaCommand(conn, ctx, 'image', 'cta')
};
commands.ctafoto = commands.fotodivulcta;
commands.divctafoto = commands.fotodivulcta;
commands.fotodivcta = commands.fotodivulcta;
commands.fotocta = commands.fotodivulcta;
commands.divfotocta = commands.fotodivulcta;

commands.apagafotodivulcta = {
    useCtx: true,
    description: "Remove a foto do CTA",
    usage: "apagafotodivulcta",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const cfg = getConfig(ctx.telegramUserId);
        if (!cfg.cta) {
            return sendDivulgacaoMessage(conn, ctx, { text: "CTA ainda nao configurado." }, { quoted: ctx.info });
        }
        try {
            const { unlinkMediaFile } = require('../../utils/divulgacao');
            unlinkMediaFile(ctx.telegramUserId, cfg.cta.midiaFile || 'div-cta.bin');
        } catch (_) { /* */ }
        updateConfig(ctx.telegramUserId, {
            cta: { midia: null, midiaFile: null, midiaTipo: null, midiaMimetype: null }
        });
        await showCtaPanel(conn, ctx);
    }
};

function mediaLabel(config) {
    const t = config?.midiaFile || config?.midia ? (config.midiaTipo || 'ok') : 'nao';
    const c = config?.cta?.midiaFile ? (config.cta.midiaTipo || 'foto') : 'nao';
    const s = config?.statusMidiaFile ? (config.statusMidiaTipo || 'ok') : 'nao';
    return `Texto: ${t} · CTA: ${c} · Status: ${s}`;
}

async function showMediaPanel(conn, ctx) {
    if (!(await requireSessionOwner(conn, ctx))) return;
    const config = getConfig(ctx.telegramUserId);
    const sessionId = ctx.sessionId || conn?._sessionId;
    await sendDivulgacaoList(
        conn,
        ctx.from,
        `MIDIAS DA DIVULGACAO\n\n` +
        `${mediaLabel(config)}\n\n` +
        `Texto, CTA e Status tem midia SEPARADA.\n` +
        `Toque, depois manda a foto/video (ou responde uma).`,
        [
            {
                title: 'Texto normal',
                rows: [
                    { id: 'div_midia_texto_foto', title: 'Foto texto', description: 'Imagem da msg normal' },
                    { id: 'div_midia_texto_video', title: 'Video texto', description: 'Video da msg normal' },
                    { id: 'div_midia_texto_audio', title: 'Audio texto', description: 'Audio da msg normal' },
                    { id: 'div_midia_texto_doc', title: 'Documento texto', description: 'PDF/arquivo da msg' },
                    { id: 'div_midia_texto_rm', title: 'Remover midia texto', description: 'Tira foto/video do texto' }
                ]
            },
            {
                title: 'CTA',
                rows: [
                    { id: 'div_midia_cta_foto', title: 'Foto CTA', description: 'Foto do cartao com botao' },
                    { id: 'div_midia_cta_video', title: 'Video CTA', description: 'Video junto do cartao' },
                    { id: 'div_midia_cta_rm', title: 'Remover midia CTA', description: 'Tira foto/video do CTA' }
                ]
            },
            {
                title: 'Status',
                rows: [
                    { id: 'div_midia_status_foto', title: 'Foto status', description: 'Imagem do status dirigido' },
                    { id: 'div_midia_status_video', title: 'Video status', description: 'Video do status dirigido' },
                    { id: 'div_midia_status_rm', title: 'Remover midia status', description: 'Tira foto/video so do status' },
                    { id: 'div_config', title: 'Voltar config', description: 'Menu configurar' }
                ]
            }
        ],
        'Hanork Bot',
        ctx.info,
        'menu.jpg',
        ctx.telegramUserId,
        sessionId,
        {
            listTitle: 'Trocar midia',
            extraButtons: [
                { id: 'div_preview', label: 'Preview' },
                { id: 'div_menu', label: 'Menu' }
            ]
        }
    );
}
commands.divmenu = {
    useCtx: true,
    description: "Menu de divulgacao",
    usage: "divmenu",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const { areButtonsOn } = require('../../utils/sessionRegistry');
        const sessionId = ctx.sessionId || conn?._sessionId;
        const buttonsOn = areButtonsOn(sessionId, ctx.telegramUserId);

        // Botoes OFF: catalogo texto com prefixo+cmd e explicacoes
        if (!buttonsOn) {
            const { sendCategoryPanel } = require('../../utils/menuCatalog');
            return sendCategoryPanel(conn, {
                catId: 'divulgacao',
                chatId: ctx.from,
                quoted: ctx.info,
                telegramUserId: ctx.telegramUserId,
                sessionId,
                isGroup: !!ctx.isGroup,
                viewerRole: ctx.authRole || (ctx.isOwner ? 'owner' : ctx.isVip ? 'vip' : 'user'),
                viewerCtx: ctx
            });
        }

        const config = getConfig(ctx.telegramUserId);
        const { prefixFromCtx, applyLivePrefix } = require('../../utils/configManager');
        const p = prefixFromCtx(ctx);
        const adm = isDivAdmin(ctx.telegramUserId);
        const summary = applyLivePrefix(
          adm
            ? `${formatSlotsSummary(config, ctx.telegramUserId)}\n\n${formatTracksSummary(config)}`
            : formatTracksSummary(config),
          p
        );
        const montarRows = adm
          ? [
              { id: 'div_slots', title: 'CTA + Status', description: 'Padroes #1/#2: editar, midia, enviar, auto' },
              { id: 'div_config_texto', title: 'Texto', description: 'Msg com varios links e mencoes' },
              { id: 'div_config_pay', title: 'Pagamento', description: 'Texto do pix/pagamento' },
              { id: 'div_config_midia', title: 'Midia', description: 'Foto/video de cada tipo' },
              { id: 'gm_home', title: 'Grupos', description: 'Fila de convites e entrar' }
            ]
          : [
              { id: 'div_config_texto', title: 'Texto', description: 'Msg com varios links e mencoes' },
              { id: 'div_config_cta', title: 'CTA', description: 'Cartao com botao e link' },
              { id: 'div_config_pay', title: 'Pagamento', description: 'Texto do pix/pagamento' },
              { id: 'div_config_status', title: 'Status', description: 'Texto e midia so do status' },
              { id: 'div_config_midia', title: 'Midia', description: 'Foto/video de cada tipo' },
              { id: 'gm_home', title: 'Grupos', description: 'Fila de convites e entrar' }
            ];

        await sendDivulgacaoList(
            conn,
            ctx.from,
            `SISTEMA DE DIVULGACAO\n\n` +
            `Texto, CTA, pagamento e status sao configs SEPARADAS.\n` +
            `Quem usa varios links no texto nao mexe no CTA, e vice-versa.\n\n` +
            `${summary}\n\n` +
            `Prefixo: ${p}\n\n` +
            `Fluxo: monta o tipo → marca grupos → preview → iniciar.\n` +
            `1a msg: mencoes (ignora admins). Invisivel: so o que falar.\n` +
            `Atalho CTA: ${p}divcta texto | botao | https://link | botao2 | https://link2`,
            [
                {
                    title: 'Enviar',
                    rows: [
                        { id: 'div_iniciar', title: 'Iniciar', description: 'Dispara agora: texto, CTA, pay ou status' },
                        { id: 'div_config_auto', title: 'Automatico', description: 'Ciclo sozinho nos grupos marcados' },
                        { id: 'div_preview', title: 'Preview', description: 'Mostra como a mensagem vai ficar' }
                    ]
                },
                {
                    title: 'Montar',
                    rows: montarRows
                },
                {
                    title: 'Mais',
                    rows: [
                        { id: 'div_config', title: 'Avancado', description: 'Delay, quantidade, ordem, repetir' },
                        { id: 'menu_cat_divulgacao', title: 'Comandos', description: `Lista ${p}div ${p}divbotao ${p}divpay ${p}divstatus` }
                    ]
                }
            ],
            'Hanork Bot',
            ctx.info,
            'menu.jpg',
            ctx.telegramUserId,
            sessionId,
            {
                listTitle: 'Abrir menu',
                extraButtons: [
                    { id: 'div_ajuda', label: 'Ajuda' },
                    { id: 'menu', label: 'Voltar' }
                ]
            }
        );
    }
};
commands.divulga = commands.divmenu;
commands.divulgacao = commands.divmenu;

// ========== CONFIGURAÇÕES ==========
commands.divconfig = {
    useCtx: true,
    description: "Configuracoes da divulgacao",
    usage: "divconfig",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        const modoText = config.modoPrincipal === 'pay'
            ? 'Pagamento'
            : config.modoPrincipal === 'cta'
                ? 'CTA'
                : config.modoPrincipal === 'status'
                    ? 'Status'
                    : 'Texto';
        const ordemMap = { sequencial: 'Sequencial', aleatoria: 'Aleatoria' };

        const msg = `CONFIGURACOES ATUAIS\n\n` +
            `Modo: ${modoText}\n` +
            `Quantidade: ${config.quantidade}x\n` +
            `Delay msgs: ${config.delayMsg}ms\n` +
            `Delay grupos: ${config.delayGrupo}ms\n` +
            `Ordem: ${ordemMap[config.ordem] || 'Sequencial'}\n` +
            `Repetir: ${config.repetir ? 'Sim' : 'Nao'}\n` +
            `Midias: ${mediaLabel(config)}\n` +
            `Invisivel: so o membro que falar (outros nao veem)\n\n` +
            `${formatTracksSummary(config)}\n` +
            `${require('../../utils/divulgacaoAuto').formatAutoSummary(config)}`;

        await sendDivulgacaoList(
            conn,
            ctx.from,
            msg,
            [
                {
                    title: 'Conteudo',
                    rows: [
                        { id: 'div_config_auto', title: 'Automatico', description: 'Ciclo sozinho' },
                        { id: 'div_config_texto', title: 'Texto', description: 'Msg com varios links' },
                        { id: 'div_config_cta', title: 'CTA', description: 'Cartao com botao' },
                        { id: 'div_config_pay', title: 'Pagamento', description: 'Texto do pix' },
                        { id: 'div_config_status', title: 'Status', description: 'Texto e midia do status' },
                        { id: 'div_config_modo', title: 'Modo', description: 'Texto / CTA / pay' }
                    ]
                },
                {
                    title: 'Midias',
                    rows: [
                        { id: 'div_config_midia', title: 'Trocar midias', description: 'Foto/video de texto, CTA e status' },
                        { id: 'div_midia_texto_foto', title: 'Foto texto', description: 'Imagem da msg normal' },
                        { id: 'div_midia_texto_video', title: 'Video texto', description: 'Video da msg normal' },
                        { id: 'div_midia_cta_foto', title: 'Foto CTA', description: 'Foto do cartao' },
                        { id: 'div_midia_status_foto', title: 'Foto status', description: 'Imagem do status' },
                        { id: 'div_midia_status_video', title: 'Video status', description: 'Video do status' }
                    ]
                },
                {
                    title: 'Envio',
                    rows: [
                        { id: 'div_config_qtd', title: 'Quantidade', description: `${config.quantidade}x` },
                        { id: 'div_config_delaymsg', title: 'Delay msgs', description: `${config.delayMsg}ms` },
                        { id: 'div_config_delaygrupo', title: 'Delay grupos', description: `${config.delayGrupo}ms` },
                        { id: 'gm_home', title: 'Grupos', description: 'Fila de convites e entrar' },
                        { id: 'div_iniciar', title: 'Iniciar', description: 'Dispara agora' },
                        { id: 'div_menu', title: 'Voltar', description: 'Menu divulgacao' }
                    ]
                }
            ],
            'Hanork Bot',
            ctx.info,
            'menu.jpg',
            ctx.telegramUserId,
            ctx.sessionId || conn?._sessionId,
            { listTitle: 'Configurar' }
        );
    }
};

commands.divconfigmodo = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        const modoAtual = config.modoPrincipal === 'pay'
            ? 'Pagamento'
            : config.modoPrincipal === 'cta'
                ? 'CTA'
                : config.modoPrincipal === 'status'
                    ? 'Status'
                    : 'Texto';

        const msg = `*MODO DE DIVULGACAO*\n\n` +
            `Modo atual: ${modoAtual}\n\n` +
            `Cada tipo tem config propria:\n` +
            `Texto = msgdivul (varios links)\n` +
            `CTA = cartao (texto + botao + link)\n` +
            `Pagamento = msgdivulpay\n` +
            `Status = msgdivulstatus + foto/video status\n\n` +
            `Status NAO usa o texto/midia dos outros. Liga o ciclo em Automatico.\n` +
            `Invisivel dirigido: 1 msg so pro membro que falar.\n\n` +
            `Escolha:`;

        await sendButtonsWithImage(
            conn,
            ctx.from,
            msg,
            [
                { id: "div_modo_texto", label: "Texto" },
                { id: "div_modo_cta", label: "CTA" },
                { id: "div_modo_pay", label: "Pagamento" },
                { id: "div_tipo_status", label: "Enviar status" },
                { id: "div_config_status", label: "Editar status" },
                { id: "div_config", label: "Voltar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "MODO",
            "Clique abaixo"
        );
    }
};

commands.divconfigstatus = {
    useCtx: true,
    execute: async (conn, ctx) => {
        await showStatusPanel(conn, ctx);
    }
};

commands.div_config_status_texto = {
    useCtx: true,
    description: "Editar texto da divulgacao de STATUS",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        await startStatusPrompt(conn, ctx);
    }
};

commands.divconfigqtd = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        await sendButtonsWithImage(
            conn,
            ctx.from,
            `Quantidade por grupo\n\nAtual: ${config.quantidade}x\n\nEscolha:`,
            [
                { id: "div_qtd_1", label: "1x" },
                { id: "div_qtd_2", label: "2x" },
                { id: "div_qtd_3", label: "3x" },
                { id: "div_qtd_5", label: "5x" },
                { id: "div_qtd_10", label: "10x" },
                { id: "div_qtd_personalizar", label: "Personalizar" },
                { id: "div_config", label: "Voltar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "QUANTIDADE",
            "Clique abaixo"
        );
    }
};

commands.divconfigdelaymsg = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        await sendButtonsWithImage(
            conn,
            ctx.from,
            `Delay entre mensagens\n\nAtual: ${config.delayMsg}ms\n\nEscolha:`,
            [
                { id: "div_delaymsg_500", label: "500ms" },
                { id: "div_delaymsg_1000", label: "1s" },
                { id: "div_delaymsg_2000", label: "2s" },
                { id: "div_delaymsg_3000", label: "3s" },
                { id: "div_delaymsg_5000", label: "5s" },
                { id: "div_delaymsg_10000", label: "10s" },
                { id: "div_delaymsg_personalizar", label: "Personalizar" },
                { id: "div_config", label: "Voltar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "DELAY MSGS",
            "Clique abaixo"
        );
    }
};

commands.divconfigdelaygrupo = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        await sendButtonsWithImage(
            conn,
            ctx.from,
            `Delay entre grupos\n\nAtual: ${config.delayGrupo}ms\n\nEscolha:`,
            [
                { id: "div_delaygrupo_0", label: "0s" },
                { id: "div_delaygrupo_2000", label: "2s" },
                { id: "div_delaygrupo_5000", label: "5s" },
                { id: "div_delaygrupo_10000", label: "10s" },
                { id: "div_delaygrupo_20000", label: "20s" },
                { id: "div_delaygrupo_30000", label: "30s" },
                { id: "div_delaygrupo_60000", label: "1min" },
                { id: "div_delaygrupo_personalizar", label: "Personalizar" },
                { id: "div_config", label: "Voltar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "DELAY GRUPOS",
            "Clique abaixo"
        );
    }
};

commands.divconfigordem = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        await sendButtonsWithImage(
            conn,
            ctx.from,
            `Ordem de envio\n\nAtual: ${config.ordem}\n\nEscolha:`,
            [
                { id: "div_ordem_sequencial", label: "Sequencial" },
                { id: "div_ordem_aleatoria", label: "Aleatoria" },
                { id: "div_config", label: "Voltar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "ORDEM",
            "Clique abaixo"
        );
    }
};

commands.divconfigrepetir = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        await sendButtonsWithImage(
            conn,
            ctx.from,
            `Repetir envio\n\nAtualmente: ${config.repetir ? 'Sim' : 'Nao'}\n\nPermitir repetir nos mesmos grupos?`,
            [
                { id: "div_repetir_on", label: "Sim" },
                { id: "div_repetir_off", label: "Nao" },
                { id: "div_config", label: "Voltar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "REPETIR",
            "Clique abaixo"
        );
    }
};

commands.divconfigmidia = {
    useCtx: true,
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const config = getConfig(ctx.telegramUserId);
        const temMidia = (config.midiaFile || config.midia) ? 'Sim' : 'Nao';
        const tipoMidia = config.midiaTipo || 'Nenhum';
        await sendButtonsWithImage(
            conn,
            ctx.from,
            `Gerenciar Midia\n\nStatus: ${temMidia}\nTipo: ${tipoMidia}\n${config.legenda ? 'Legenda: ' + config.legenda : ''}`,
            [
                { id: "div_midia_adicionar", label: "Adicionar" },
                { id: "div_midia_remover", label: "Remover" },
                { id: "div_config", label: "Voltar" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "MIDIA",
            "Clique abaixo"
        );
    }
};

// ========== AJUDA ==========
commands.divhelp = {
    useCtx: true,
    description: "Ajuda sobre o sistema de divulgacao",
    usage: "divhelp",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const prefix = require('../../utils/configManager').prefixFromCtx(ctx);
        const helpText = 
            `*SISTEMA DE DIVULGACAO*\n\n` +
            `Tres configs separadas — um nao usa o texto do outro.\n` +
            `Invisivel dirigido (so o alvo; outros nao veem).\n\n` +
            `*Texto normal (varios links):*\n` +
            `${prefix}msgdivul <texto>\n` +
            `${prefix}div [qtd] [delay] — envia o texto\n\n` +
            `*CTA (cartao com botao):*\n` +
            `${prefix}divcta — wizard (3 passos)\n` +
            `${prefix}divcta texto | botao | https://link | botao2 | https://link2\n` +
            `${prefix}divbotao [qtd] [delay] — envia o CTA\n\n` +
            `*Pagamento:*\n` +
            `${prefix}msgdivulpay <texto>\n` +
            `${prefix}divpay [qtd] [delay]\n\n` +
            `*Status (texto e midia proprios):*\n` +
            `${prefix}msgdivulstatus <texto>\n` +
            `${prefix}fotodivulstatus / videodivulstatus\n` +
            `${prefix}divstatus [qtd] [delay]\n\n` +
            `*Midia (texto / CTA / status separados):*\n` +
            `${prefix}fotodivulcta — foto do CTA\n` +
            `${prefix}fotodivul / videodivul / gifdivul / audiodivul / documentodivul\n` +
            `${prefix}apagardivul - Remove toda configuracao\n\n` +
            `*Visualizacao:*\n` +
            `${prefix}previewdivul - Mostra previa de cada tipo\n\n` +
            `*Outros envios:*\n` +
            `${prefix}divfull [qtd] [delay] - Completa (pagamento + status)\n\n` +
            `*Ajuda:*\n` +
            `${prefix}divhelp - Esta mensagem\n` +
            `${prefix}divmenu - Menu interativo`;
        await sendButtonsWithImage(
            conn,
            ctx.from,
            helpText,
            [
                { id: "div_menu", label: "Voltar" },
                { id: "menu", label: "Menu" }
            ],
            "Hanork Bot",
            ctx.info,
            "menu.jpg",
            "AJUDA",
            "Clique abaixo"
        );
    }
};

commands.divajuda = commands.divhelp;

// ========== COMANDOS RÁPIDOS PARA NOVOS USUÁRIOS ==========
commands.div_config_texto = {
    useCtx: true,
    description: "Configurar texto normal da divulgacao",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        await startTextoPrompt(conn, ctx);
    }
};

commands.div_config_pay = {
    useCtx: true,
    description: "Configurar texto da divulgacao de pagamento",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        await startPayPrompt(conn, ctx);
    }
};

commands.div_config_midia = {
    useCtx: true,
    description: "Menu rapido para configurar midia",
    execute: async (conn, ctx) => {
        await showMediaPanel(conn, ctx);
    }
};
commands.divconfigmidia = commands.div_config_midia;

function parseOnOff(args, text) {
    const tokens = [
        String((args && args[0]) || '').toLowerCase(),
        String(text || '').trim().split(/\s+/)[0].toLowerCase()
    ];
    for (const a of tokens) {
        if (['on', 'ligar', '1', 'true', 'sim'].includes(a)) return true;
        if (['off', 'desligar', '0', 'false', 'nao'].includes(a)) return false;
    }
    return null;
}

function rememberUiJid(ctx) {
    if (ctx?.telegramUserId && ctx.from && !String(ctx.from).endsWith('@g.us')) {
        updateConfig(ctx.telegramUserId, { lastUiJid: ctx.from });
    }
}

function autoTipoRow(modo, config) {
    const { isModoOn, tipoReady, MODO_LABEL, formatScheduleLabel } = require('../../utils/divulgacaoAuto');
    const on = isModoOn(config, modo);
    const ready = tipoReady(modo, config);
    const { tipo, slot } = parseTipoSlot(modo);
    const label = (MODO_LABEL[tipo] || tipo) + (slot > 1 ? ` #${slot}` : '');
    const tempo = formatScheduleLabel(config, modo);
    let description = on ? `Ciclo ${tempo}. Toque pra desligar so este` : `Tempo ${tempo}. Toque pra ligar so este`;
    if (tipo === 'full' && !on) description = `Mistura os tipos (${tempo}). Toque pra ligar so este`;
    if (!ready) description = on ? `Ligado · ${tempo}, mas falta configurar` : `Configura este tipo antes (${tempo})`;
    return {
        id: `div_auto_tipo_${String(modo).replace(/:(\d+)$/, '_$1')}`,
        title: `${label} — ${on ? 'ON' : 'OFF'} · ${tempo}`,
        description
    };
}

function autoTempoRow(modo, config) {
    const { MODO_LABEL, formatScheduleLabel } = require('../../utils/divulgacaoAuto');
    const { tipo, slot } = parseTipoSlot(modo);
    const label = (MODO_LABEL[tipo] || tipo) + (slot > 1 ? ` #${slot}` : '');
    const tempo = formatScheduleLabel(config, modo);
    return {
        id: `div_auto_tempo_${String(modo).replace(/:(\d+)$/, '_$1')}`,
        title: `Tempo ${label} — ${tempo}`,
        description: 'Toque pra escolher so deste tipo'
    };
}

async function showAutoIntervalPicker(conn, ctx, tipoRaw, notice = '') {
    const {
        normalizeModo, MODO_LABEL, formatScheduleLabel, formatEta,
        INTERVAL_PRESETS, ALL_MODOS, randomRangeForTipo, formatIntervalLabel
    } = require('../../utils/divulgacaoAuto');
    const tipo = normalizeModo(tipoRaw);
    if (!tipo) return showAutoPanel(conn, ctx, 'Tipo: texto, cta, pay, status.');
    rememberUiJid(ctx);
    const config = getConfig(ctx.telegramUserId);
    const p = require('../../utils/configManager').prefixFromCtx(ctx);
    const sessionId = ctx.sessionId || conn?._sessionId;
    const atual = formatScheduleLabel(config, tipo);
    const { tipo: baseTipo, slot: slotN } = parseTipoSlot(tipo);
    const nome = (MODO_LABEL[baseTipo] || baseTipo) + (slotN > 1 ? ` #${slotN}` : '');
    const idTipo = String(tipo).replace(/:(\d+)$/, '_$1');
    const head = notice ? `${String(notice).trim()}\n\n` : '';
    const rnd = randomRangeForTipo(config, tipo);
    const others = ALL_MODOS.filter((m) => m !== tipo)
        .map((m) => `${MODO_LABEL[m]} ${formatScheduleLabel(config, m)}`)
        .join(' · ');
    const msg =
        `${head}TEMPO — ${nome}\n\n` +
        `Atual deste tipo: ${atual}\n` +
        `Proximo disparo: ${formatEta(Number(config.autoNextAtByTipo?.[tipo] || 0))}\n` +
        `Os outros nao mudam: ${others}\n\n` +
        `Fixo: 15m, 30m, 1h, 2h, 3h, 6h, 12h, 24h.\n` +
        `Aleatorio grava o proximo horario (sobrevive restart).\n` +
        `${p}divconfigauto ${tipo} 2h\n` +
        `${p}divconfigauto ${tipo} aleatorio 60 180\n` +
        `${p}divconfigauto 30   = aplica em TODOS`;
    await sendDivulgacaoList(
        conn,
        ctx.from,
        msg,
        [
            {
                title: `Fixo ${nome}`,
                rows: INTERVAL_PRESETS.map((it) => ({
                    id: `div_auto_int_${idTipo}_${it.min}`,
                    title: it.label,
                    description: it.desc || 'So este tipo'
                }))
            },
            {
                title: 'Variacoes',
                rows: [
                    {
                        id: `div_auto_randpick_${idTipo}`,
                        title: rnd ? `Aleatorio ${formatIntervalLabel(rnd.min)}-${formatIntervalLabel(rnd.max)}` : 'Delay aleatorio',
                        description: rnd ? 'Toque pra mudar a faixa' : 'Sorteia e GRAVA o proximo horario'
                    },
                    {
                        id: 'div_auto_msgspick',
                        title: config.autoMsgEnabled === true ? `Msgs: a cada ${config.autoMsgEvery || 50}` : 'Msgs: OFF',
                        description: 'OFF por padrao. So dispara se voce ligar.'
                    },
                    {
                        id: 'div_auto_mingappick',
                        title: `Minimo ${formatIntervalLabel(config.autoMinGapMin || 15)}`,
                        description: 'Tempo minimo no mesmo grupo (anti-flood)'
                    },
                    { id: 'div_config_auto', title: 'Voltar auto', description: 'Painel automatico' }
                ]
            }
        ],
        'Hanork Bot',
        ctx.info,
        'menu.jpg',
        ctx.telegramUserId,
        sessionId
    );
}

async function showAutoRandomPicker(conn, ctx, tipoRaw, notice = '') {
    const {
        normalizeModo, MODO_LABEL, RANDOM_PRESETS, formatIntervalLabel,
        randomRangeForTipo, ALL_MODOS
    } = require('../../utils/divulgacaoAuto');
    const tipo = normalizeModo(tipoRaw) || null;
    rememberUiJid(ctx);
    const config = getConfig(ctx.telegramUserId);
    const p = require('../../utils/configManager').prefixFromCtx(ctx);
    const sessionId = ctx.sessionId || conn?._sessionId;
    const nome = tipo ? (MODO_LABEL[tipo] || tipo) : 'todos';
    const rnd = tipo ? randomRangeForTipo(config, tipo) : null;
    const head = notice ? `${String(notice).trim()}\n\n` : '';
    const alvo = tipo || 'todos';
    const msg =
        `${head}DELAY ALEATORIO — ${nome}\n\n` +
        `Atual: ${rnd ? `${formatIntervalLabel(rnd.min)} a ${formatIntervalLabel(rnd.max)}` : 'OFF (usa tempo fixo)'}\n` +
        `O proximo disparo e gravado. Restart NAO sorteia de novo.\n` +
        `${p}divconfigauto ${tipo || ''} aleatorio 60 180\n` +
        `${p}divconfigauto ${tipo || ''} aleatorio off`;
    const prefix = tipo || 'all';
    await sendDivulgacaoList(
        conn,
        ctx.from,
        msg,
        [
            {
                title: 'Faixa',
                rows: [
                    ...RANDOM_PRESETS.map((it) => ({
                        id: `div_auto_rand_${prefix}_${it.min}_${it.max}`,
                        title: it.label,
                        description: 'Grava o proximo horario agora'
                    })),
                    {
                        id: `div_auto_randoff_${prefix}`,
                        title: 'Desligar aleatorio',
                        description: 'Volta pro tempo fixo'
                    },
                    {
                        id: tipo ? `div_auto_tempo_${tipo}` : 'div_config_auto',
                        title: 'Voltar',
                        description: 'Tempo / auto'
                    }
                ]
            }
        ],
        'Hanork Bot',
        ctx.info,
        'menu.jpg',
        ctx.telegramUserId,
        sessionId
    );
}

async function showAutoMsgsPicker(conn, ctx, notice = '') {
    const { MSG_PRESETS, formatIntervalLabel, msgEveryOf } = require('../../utils/divulgacaoAuto');
    rememberUiJid(ctx);
    const config = getConfig(ctx.telegramUserId);
    const p = require('../../utils/configManager').prefixFromCtx(ctx);
    const sessionId = ctx.sessionId || conn?._sessionId;
    const on = config.autoMsgEnabled === true;
    const n = msgEveryOf(config);
    const head = notice ? `${String(notice).trim()}\n\n` : '';
    const msg =
        `${head}GATILHO POR MENSAGENS\n\n` +
        `Status: ${on ? 'ON' : 'OFF'} · a cada ${n} msgs NO GRUPO\n` +
        `OFF por padrao. O relogio (12h etc.) NAO usa isso.\n` +
        `Ligar aqui e o unico jeito de disparar por quantidade de msgs.\n` +
        `Escolher 25/50/100 so grava o numero; o gatilho continua OFF ate Ligar.\n` +
        `${p}divconfigauto msgs on|off\n` +
        `${p}divconfigauto msgs 50`;
    await sendDivulgacaoList(
        conn,
        ctx.from,
        msg,
        [
            {
                title: 'Msgs no grupo',
                rows: [
                    {
                        id: on ? 'div_auto_msgs_off' : 'div_auto_msgs_on',
                        title: on ? 'Desligar gatilho' : 'Ligar gatilho',
                        description: on ? 'So o relogio fica' : 'Conta msgs por grupo'
                    },
                    ...MSG_PRESETS.map((v) => ({
                        id: `div_auto_msgs_${v}`,
                        title: `A cada ${v} msgs`,
                        description: 'So grava o numero (nao liga o gatilho)'
                    })),
                    { id: 'div_auto_mingappick', title: `Minimo ${formatIntervalLabel(config.autoMinGapMin || 15)}`, description: 'Anti-flood no mesmo grupo' },
                    { id: 'div_config_auto', title: 'Voltar auto', description: 'Painel automatico' }
                ]
            }
        ],
        'Hanork Bot',
        ctx.info,
        'menu.jpg',
        ctx.telegramUserId,
        sessionId
    );
}

async function showAutoMinGapPicker(conn, ctx, notice = '') {
    const { MIN_GAP_PRESETS, formatIntervalLabel } = require('../../utils/divulgacaoAuto');
    rememberUiJid(ctx);
    const config = getConfig(ctx.telegramUserId);
    const p = require('../../utils/configManager').prefixFromCtx(ctx);
    const sessionId = ctx.sessionId || conn?._sessionId;
    const head = notice ? `${String(notice).trim()}\n\n` : '';
    const msg =
        `${head}TEMPO MINIMO NO GRUPO\n\n` +
        `Atual: ${formatIntervalLabel(config.autoMinGapMin || 15)}\n` +
        `O gatilho de msgs (se ligado) so dispara se esse tempo ja passou.\n` +
        `${p}divconfigauto min 15`;
    await sendDivulgacaoList(
        conn,
        ctx.from,
        msg,
        [
            {
                title: 'Minimo',
                rows: [
                    ...MIN_GAP_PRESETS.map((v) => ({
                        id: `div_auto_mingap_${v}`,
                        title: formatIntervalLabel(v),
                        description: 'Mesmo grupo, qualquer tipo'
                    })),
                    { id: 'div_config_auto', title: 'Voltar auto', description: 'Painel automatico' }
                ]
            }
        ],
        'Hanork Bot',
        ctx.info,
        'menu.jpg',
        ctx.telegramUserId,
        sessionId
    );
}

async function showAutoPanel(conn, ctx, notice = '') {
    const { formatAutoSummary, TOGGLE_MODOS } = require('../../utils/divulgacaoAuto');
    rememberUiJid(ctx);
    const config = getConfig(ctx.telegramUserId);
    const p = require('../../utils/configManager').prefixFromCtx(ctx);
    const sessionId = ctx.sessionId || conn?._sessionId;
    const autoOn = !!config.autoEnabled;
    const createOn = !!config.autoCreateEnabled;
    const adm = isDivAdmin(ctx.telegramUserId);
    const head = notice ? `${String(notice).trim()}\n\n` : '';
    const slotHint = adm
      ? `\nADM: CTA+Status ×2 no menu Padroes / ${p}divslots. Auto: cta:2, status:2.\n`
      : '';
    const msg =
        `${head}DIVULGACAO AUTOMATICA\n\n` +
        `${formatAutoSummary(config)}\n` +
        `Criar grupos: ${createOn ? 'ON' : 'OFF'}` +
        ` · lote ${config.autoCreateCount || 1}` +
        ` · min ${config.autoCreateMin || 0}` +
        ` · nome "${config.autoCreateName || 'Grupo'}"\n` +
        slotHint +
        `\nCada tipo liga/desliga sozinho e tem o PROPRIO tempo. Mudar CTA nao mexe no texto.\n` +
        `A contagem comeca na hora que ligar o tipo: primeiro envio so depois do intervalo inteiro.\n` +
        `Dois tipos no mesmo tempo (ex: 30 min) NAO saem no mesmo segundo.\n` +
        `Delay entre msgs/grupos (durante o envio) fica em Configurar > Envio — e outro ajuste.\n` +
        `Presets: 15m, 30m, 1h, 2h, 3h, 6h, 12h, 24h. Aleatorio grava o proximo horario.\n` +
        `Gatilho de msgs: OFF por padrao. So dispara se voce ligar no painel (nao antecipa o 12h).\n` +
        `15/30 min so pra teste. Grupo vivo: 12h ou 24h.\n` +
        `Minimo de grupos auto: no maximo 8, lote de 3 com delay — nao deixa o bot criar o dia inteiro.\n` +
        `Ligar/desligar ciclo: botoes ou ${p}divauto on|off\n` +
        `${p}divconfigauto cta 2h | texto 3h | 6h | 24h\n` +
        `${p}divconfigauto cta aleatorio 60 180\n` +
        `${p}divconfigauto msgs on|off | msgs 50 | min 15\n` +
        `${p}divconfigautomodos cta          = so CTA\n` +
        `${p}divconfigautomodos cta on|off  = liga/desliga CTA sem mexer nos outros\n` +
        `${p}divconfigautomodos todos|nenhum\n` +
        `${p}divcriagrupo 3 NomeBase\n` +
        `${p}divautocriar on|off\n` +
        `${p}divconfigmingrupos 5\n` +
        `${p}divconfigcriagrupo 3 Nome`;
    const extraSlotKeys = [];
    if (adm) {
      for (const track of ['cta', 'status']) {
        extraSlotKeys.push(modoKey(track, 2));
      }
    }
    const sections = [
        {
            title: 'Ciclo',
            rows: [
                {
                    id: autoOn ? 'div_auto_off' : 'div_auto_on',
                    title: `Auto — ${autoOn ? 'ON' : 'OFF'}`,
                    description: autoOn ? 'Toque pra desligar o ciclo' : 'Toque pra ligar o ciclo'
                },
                ...TOGGLE_MODOS.map((m) => autoTempoRow(m, config)),
                autoTempoRow('full', config),
                ...extraSlotKeys.slice(0, 4).map((m) => autoTempoRow(m, config)),
                {
                    id: 'div_auto_randpick_all',
                    title: 'Delay aleatorio',
                    description: 'Faixa min-max; proximo horario fica gravado'
                },
                {
                    id: 'div_auto_msgspick',
                    title: config.autoMsgEnabled === true
                        ? `Msgs: a cada ${config.autoMsgEvery || 50}`
                        : 'Msgs: OFF',
                    description: 'OFF por padrao. So dispara se voce ligar neste painel.'
                },
                {
                    id: 'div_auto_mingappick',
                    title: `Minimo ${config.autoMinGapMin || 15} min`,
                    description: 'Anti-flood no mesmo grupo'
                }
            ]
        },
        {
            title: 'Tipos',
            rows: [
                ...TOGGLE_MODOS.map((m) => autoTipoRow(m, config)),
                autoTipoRow('full', config),
                ...extraSlotKeys.map((m) => autoTipoRow(m, config)),
                { id: 'div_auto_modos_todos', title: 'Todos ON', description: 'Liga texto+CTA+pay+status' },
                { id: 'div_auto_modos_nenhum', title: 'Todos OFF', description: 'Desliga os tipos (completa fica)' },
                ...(adm
                  ? [{ id: 'div_slots', title: 'CTA + Status', description: 'Padroes #1/#2 no mesmo menu' }]
                  : [])
            ]
        },
        {
            title: 'Grupos',
            rows: [
                {
                    id: createOn ? 'div_autocriar_off' : 'div_autocriar_on',
                    title: `Criar gp — ${createOn ? 'ON' : 'OFF'}`,
                    description: createOn ? 'Toque pra desligar auto-criar' : 'Toque pra ligar auto-criar'
                },
                { id: 'div_criar_lote', title: 'Criar 3 grupos', description: `${p}divcriagrupo 3` },
                { id: 'div_auto_min_3', title: 'Minimo 3 grupos', description: `${p}divconfigmingrupos 3` },
                { id: 'div_auto_min_5', title: 'Minimo 5 grupos', description: `${p}divconfigmingrupos 5` },
                { id: 'div_config', title: 'Voltar config', description: `${p}divconfig` },
                { id: 'div_menu', title: 'Menu div', description: `${p}divmenu` }
            ]
        }
    ];
    await sendDivulgacaoList(
        conn,
        ctx.from,
        msg,
        sections,
        'Hanork Bot',
        ctx.info,
        'menu.jpg',
        ctx.telegramUserId,
        sessionId,
        {
            extraButtons: [
                { id: 'div_auto_on', label: 'Ligar auto' },
                { id: 'div_auto_off', label: 'Desligar auto' }
            ]
        }
    );
}

commands.divauto = {
    useCtx: true,
    description: "Liga/desliga divulgacao automatica",
    usage: "divauto on|off",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const { restartIfEnabled } = require('../../utils/divulgacaoAuto');
        const flag = parseOnOff(ctx.args, ctx.text);
        if (flag == null) return showAutoPanel(conn, ctx);
        const next = { autoEnabled: flag };
        if (ctx.from && !String(ctx.from).endsWith('@g.us')) next.lastUiJid = ctx.from;
        updateConfig(ctx.telegramUserId, next);
        restartIfEnabled(ctx.telegramUserId, { forceAll: true, armMissing: true });
        return showAutoPanel(
            conn,
            ctx,
            flag
                ? `Divulgacao automatica LIGADA. A contagem comeca agora; o primeiro envio espera o intervalo de cada tipo.`
                : `Divulgacao automatica DESLIGADA.`
        );
    }
};

commands.divconfigauto = {
    useCtx: true,
    description: "Intervalo da divulgacao automatica por tipo (fixo, aleatorio, msgs)",
    usage: "divconfigauto [tipo] <minutos|2h|3h|6h|12h|24h|aleatorio min max|msgs N|min N>",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const {
            parseDivconfigAutoArgs,
            formatIntervalLabel,
            restartIfEnabled,
            patchIntervalByTipo,
            patchRandomByTipo,
            clearRandomByTipo,
            clampMsgEvery,
            clampMinGap,
            ALL_MODOS,
            MODO_LABEL
        } = require('../../utils/divulgacaoAuto');
        rememberUiJid(ctx);
        const parsed = parseDivconfigAutoArgs(ctx.args);
        const uid = ctx.telegramUserId;
        const config = getConfig(uid);
        const tipos = parsed.tipo ? [parsed.tipo] : null;

        if (!parsed.kind || parsed.kind === 'panel') return showAutoPanel(conn, ctx);
        if (parsed.kind === 'picker') return showAutoIntervalPicker(conn, ctx, parsed.tipo);

        if (parsed.kind === 'random' && parsed.randomMin == null) {
            return showAutoRandomPicker(conn, ctx, parsed.tipo);
        }
        if (parsed.kind === 'random') {
            updateConfig(uid, patchRandomByTipo(config, { min: parsed.randomMin, max: parsed.randomMax }, tipos));
            restartIfEnabled(uid, { catchUp: true, tipos: tipos || ALL_MODOS, forceAll: !tipos });
            const nome = parsed.tipo ? (MODO_LABEL[parsed.tipo] || parsed.tipo) : 'TODOS os tipos';
            return showAutoPanel(
                conn,
                ctx,
                `Delay aleatorio ${nome}: ${formatIntervalLabel(parsed.randomMin)} a ${formatIntervalLabel(parsed.randomMax)}. Proximo horario gravado.`
            );
        }
        if (parsed.kind === 'random-off') {
            updateConfig(uid, clearRandomByTipo(config, tipos));
            restartIfEnabled(uid, { catchUp: true, tipos: tipos || ALL_MODOS, forceAll: !tipos });
            return showAutoPanel(conn, ctx, 'Delay aleatorio desligado. Voltou ao tempo fixo.');
        }

        if (parsed.kind === 'msgs' && parsed.msgs == null && parsed.msgsOn == null) {
            return showAutoMsgsPicker(conn, ctx);
        }
        if (parsed.kind === 'msgs') {
            const { patchMsgTrigger } = require('../../utils/divulgacaoAuto');
            const patch = patchMsgTrigger({
                enabled: parsed.msgsOn,
                every: parsed.msgs
            });
            updateConfig(uid, patch);
            const saved = getConfig(uid);
            const on = saved.autoMsgEnabled === true;
            let notice;
            if (parsed.msgsOn === false) notice = 'Gatilho de msgs DESLIGADO. Vale so o relogio (ex.: 12h).';
            else if (parsed.msgsOn === true) notice = `Gatilho de msgs LIGADO: a cada ${saved.autoMsgEvery || 50} msgs por grupo.`;
            else notice = `Quantidade gravada: a cada ${saved.autoMsgEvery || 50} msgs. Gatilho continua ${on ? 'ON' : 'OFF'} (precisa Ligar gatilho).`;
            return showAutoMsgsPicker(conn, ctx, notice);
        }

        if (parsed.kind === 'mingap' && parsed.minGap == null) {
            return showAutoMinGapPicker(conn, ctx);
        }
        if (parsed.kind === 'mingap') {
            const v = clampMinGap(parsed.minGap);
            updateConfig(uid, { autoMinGapMin: v });
            return showAutoMinGapPicker(conn, ctx, `Tempo minimo no mesmo grupo: ${formatIntervalLabel(v)}.`);
        }

        if (parsed.kind === 'interval' && parsed.minutes == null) return showAutoPanel(conn, ctx);
        if (parsed.tipo) {
            updateConfig(uid, patchIntervalByTipo(config, parsed.minutes, [parsed.tipo]));
            restartIfEnabled(uid, { catchUp: true, tipos: [parsed.tipo] });
            const nome = MODO_LABEL[parsed.tipo] || parsed.tipo;
            return showAutoPanel(
                conn,
                ctx,
                `Tempo ${nome}: ${formatIntervalLabel(parsed.minutes)}. Os outros tipos nao mudaram.`
            );
        }
        updateConfig(uid, patchIntervalByTipo(config, parsed.minutes, null));
        restartIfEnabled(uid, { catchUp: true, forceAll: true });
        return showAutoPanel(
            conn,
            ctx,
            `Tempo de TODOS os tipos: ${formatIntervalLabel(parsed.minutes)}.`
        );
    }
};

commands.divconfigautomodos = {
    useCtx: true,
    description: "Liga/desliga cada tipo do ciclo automatico (texto, CTA, pay, status)",
    usage: "divconfigautomodos cta on|off | texto | todos | nenhum",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const {
            parseModos,
            formatModos,
            toggleModo,
            normalizeModo,
            restartIfEnabled
        } = require('../../utils/divulgacaoAuto');
        const args = ctx.args || [];
        if (!args.length) return showAutoPanel(conn, ctx);
        rememberUiJid(ctx);
        const config = getConfig(ctx.telegramUserId);
        const last = String(args[args.length - 1] || '').toLowerCase();
        const wantMap = {
            on: true, ligar: true, '1': true, true: true, sim: true,
            off: false, desligar: false, '0': false, false: false, nao: false,
            toggle: null
        };
        if (args.length >= 2 && Object.prototype.hasOwnProperty.call(wantMap, last)) {
            const modoToken = args.slice(0, -1).join(' ');
            if (!normalizeModo(modoToken)) {
                return showAutoPanel(conn, ctx, 'Tipo: texto, cta, pay, status.');
            }
            const modos = toggleModo(config.autoModos, modoToken, wantMap[last]);
            updateConfig(ctx.telegramUserId, { autoModos: modos, autoModoIndex: 0 });
            const tipo = normalizeModo(modoToken);
            const ligado = modos.includes(tipo);
            restartIfEnabled(ctx.telegramUserId, ligado
                ? { tipos: [tipo], armTipos: [tipo], resetClock: true }
                : { tipos: [tipo] }
            );
            const nome = formatModos([tipo]);
            return showAutoPanel(
                conn,
                ctx,
                ligado
                    ? `${nome} LIGADO. Contagem comeca agora; primeiro envio depois do intervalo deste tipo.`
                    : `${nome} DESLIGADO. Tempo e outros tipos nao mudaram.`
            );
        }
        const raw = args.join(' ');
        const t = raw.toLowerCase().trim();
        if (t === 'nenhum' || t === 'none' || t === 'off') {
            updateConfig(ctx.telegramUserId, { autoModos: [], autoModoIndex: 0 });
            restartIfEnabled(ctx.telegramUserId);
            return showAutoPanel(conn, ctx, 'Nenhum tipo ativo. O ciclo nao envia ate ligar um tipo.');
        }
        const modos = parseModos(raw);
        if (!modos.length) {
            return showAutoPanel(
                conn,
                ctx,
                'Tipos: texto, cta, pay, status. Use on/off pra ligar um sem mexer nos outros. todos / nenhum.'
            );
        }
        updateConfig(ctx.telegramUserId, { autoModos: modos, autoModoIndex: 0 });
        const isTodos = t === 'todos' || t === 'all';
        restartIfEnabled(ctx.telegramUserId, {
            forceAll: true,
            armTipos: modos,
            resetClock: isTodos,
            stagger: modos.length > 1
        });
        return showAutoPanel(
            conn,
            ctx,
            `Tipos automaticos: ${formatModos(modos)}. Contagem comeca ao ligar; tipos com o mesmo tempo nao saem juntos.`
        );
    }
};

commands.divcriagrupo = {
    useCtx: true,
    description: "Cria N grupos e ja marca pra divulgacao",
    usage: "divcriagrupo [n] [nome-base]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const { createDivGroupsBatch, clampCount, sanitizeBase } = require('../../utils/divulgacaoCreateGroups');
        const args = ctx.args || [];
        if (!args.length) return showAutoPanel(conn, ctx);
        let count = 1;
        let nameParts = args;
        if (args[0] && /^\d+$/.test(args[0])) {
            count = clampCount(args[0]);
            nameParts = args.slice(1);
        }
        const base = sanitizeBase(nameParts.join(' ') || getConfig(ctx.telegramUserId).autoCreateName, 'Grupo');
        updateConfig(ctx.telegramUserId, { autoCreateCount: count, autoCreateName: base });
        await sendDivulgacaoMessage(conn, ctx, {
            text: `Criando ${count} grupo(s) "${base} #…" com delay anti-ban. Ja entram na lista de divulgacao.`
        });
        setImmediate(() => {
            createDivGroupsBatch(conn, ctx.telegramUserId, { count, baseName: base })
                .then(async (r) => {
                    const ok = (r.created || []).map((g) => g.name).join(', ') || '(nenhum)';
                    const fail = (r.errors || []).length ? `\nFalhas: ${r.errors.length}` : '';
                    await sendDivulgacaoMessage(conn, ctx, {
                        text: `Grupos criados e marcados: ${ok}${fail}`
                    });
                })
                .catch((e) => {
                    logger.logAviso(`divcriagrupo: ${e.message}`);
                });
        });
    }
};

commands.divautocriar = {
    useCtx: true,
    description: "Liga criacao automatica quando a lista cair abaixo do minimo",
    usage: "divautocriar on|off",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const flag = parseOnOff(ctx.args, ctx.text);
        if (flag == null) return showAutoPanel(conn, ctx);
        updateConfig(ctx.telegramUserId, { autoCreateEnabled: flag });
        return showAutoPanel(
            conn,
            ctx,
            flag
                ? 'Criacao automatica LIGADA. Quando a lista ficar abaixo do minimo, cria grupos ja marcados.'
                : `Criacao automatica DESLIGADA. ${require('../../utils/configManager').prefixFromCtx(ctx)}divcriagrupo continua manual.`
        );
    }
};

commands.divconfigmingrupos = {
    useCtx: true,
    description: "Minimo de grupos de divulgacao (top-up automatico)",
    usage: "divconfigmingrupos <n>",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        if (ctx.args?.[0] == null || ctx.args[0] === '') return showAutoPanel(conn, ctx);
        const n = Math.max(0, Math.min(8, parseInt(ctx.args[0], 10) || 0));
        updateConfig(ctx.telegramUserId, { autoCreateMin: n });
        return showAutoPanel(
            conn,
            ctx,
            `Minimo de grupos de divulgacao: ${n}` + (n ? ' (cria automaticamente se ligar auto-criar)' : '')
        );
    }
};

commands.divconfigcriagrupo = {
    useCtx: true,
    description: "Nome-base e lote da criacao automatica de grupos",
    usage: "divconfigcriagrupo [n] [nome]",
    execute: async (conn, ctx) => {
        if (!(await requireSessionOwner(conn, ctx))) return;
        const { clampCount, sanitizeBase } = require('../../utils/divulgacaoCreateGroups');
        const args = ctx.args || [];
        if (!args.length) return showAutoPanel(conn, ctx);
        const patch = {};
        if (/^\d+$/.test(args[0])) {
            patch.autoCreateCount = clampCount(args[0]);
            if (args.slice(1).join(' ').trim()) patch.autoCreateName = sanitizeBase(args.slice(1).join(' '));
        } else {
            patch.autoCreateName = sanitizeBase(args.join(' '));
        }
        const saved = updateConfig(ctx.telegramUserId, patch);
        return showAutoPanel(conn, ctx, `Lote: ${saved.autoCreateCount} · nome: ${saved.autoCreateName}`);
    }
};

module.exports = {
  commands,
  stepHandlers,
  startCtaWizard,
  startCtaEdit,
  startTextoPrompt,
  startPayPrompt,
  startStatusPrompt,
  showCtaPanel,
  showStatusPanel,
  showAutoPanel,
  showAutoIntervalPicker,
  showAutoRandomPicker,
  showAutoMsgsPicker,
  showAutoMinGapPicker,
  showMediaPanel,
  showSlotsPanel,
  showSlotTrackPanel,
  showSlotMediaPanel,
  handleInvitePanelAction,
  runMediaCommand
};

async function showSlotsPanel(conn, ctx, notice = '') {
  if (!isDivAdmin(ctx.telegramUserId)) {
    return showAutoPanel(conn, ctx, 'Padroes CTA/Status so para ADM Telegram.');
  }
  rememberUiJid(ctx);
  const config = getConfig(ctx.telegramUserId);
  const sessionId = ctx.sessionId || conn?._sessionId;
  const p = require('../../utils/configManager').prefixFromCtx(ctx);
  const { isModoOn } = require('../../utils/divulgacaoAuto');
  const head = notice ? `${String(notice).trim()}\n\n` : '';
  const trackLabel = { cta: 'CTA', status: 'Status' };
  const statusLines = [];
  for (const track of SLOT_TRACKS) {
    const active = getActiveSlot(config, track);
    for (const id of SLOT_IDS) {
      const ready = isTrackReady(config, track, id);
      const on = isModoOn(config, modoKey(track, id));
      const mark = id === active ? ' *edicao*' : '';
      statusLines.push(
        `${trackLabel[track]} #${id}: ${ready ? 'pronto' : 'vazio'} · auto ${on ? 'ON' : 'OFF'}${mark}`
      );
    }
  }
  const msg =
    `${head}CTA + STATUS (padroes ADM)\n\n` +
    `${statusLines.join('\n')}\n\n` +
    `Tudo num menu: editar · midia · enviar · auto (#1 padrao, #2 extra).\n` +
    `Editar abre o mesmo painel CTA/Status do #1, gravando no slot ativo (*).\n` +
    `Texto normal e pagamento ficam no Montar (1 unidade).\n` +
    `Link vivo: {{groupInviteLink}} no texto.\n` +
    `${p}divslots · ${p}divslot cta 2 · ${p}divconfigautomodos cta:2 on`;
  const sections = SLOT_TRACKS.map((track) => {
    const label = trackLabel[track];
    const active = getActiveSlot(config, track);
    const rows = [];
    for (const id of SLOT_IDS) {
      const star = id === active ? ' *' : '';
      rows.push({
        id: `div_slot_set_${track}_${id}`,
        title: `${label} #${id} editar${star}`,
        description: 'Ativa slot e abre config'
      });
      rows.push({
        id: `div_slot_midia_${track}_${id}`,
        title: `${label} #${id} midia`,
        description: 'Foto/video deste slot'
      });
      rows.push({
        id: `div_slot_send_${track}_${id}`,
        title: `${label} #${id} enviar`,
        description: 'Disparo manual deste slot'
      });
      rows.push({
        id: `div_slot_auto_${track}_${id}`,
        title: `${label} #${id} auto`,
        description: 'Liga/desliga ciclo deste slot'
      });
    }
    return { title: `${label} (#1 e #2)`, rows };
  });
  let inviteJid = '';
  try {
    inviteJid = require('../../utils/divulgacaoInviteLink').resolveInviteGroupJid({
      telegramUserId: ctx.telegramUserId
    });
  } catch (_) { /* ignore */ }
  sections.push({
    title: 'Link vivo',
    rows: [
      { id: 'div_invite_setgrupo', title: 'Grupo do convite', description: 'Marca o grupo oficial (no grupo ou JID)' },
      { id: 'div_invite_tpl_status', title: 'Status oficial+link', description: 'Aplica texto padrao com {{groupInviteLink}}' },
      { id: 'div_invite_tpl_cta', title: 'CTA texto+link grupo', description: 'Aplica texto CTA com placeholder' },
      { id: 'div_invite_preview_status', title: 'Preview status', description: 'Mostra com link live agora' },
      { id: 'div_invite_preview_cta', title: 'Preview CTA', description: 'Mostra com link live agora' }
    ]
  });
  sections.push({
    title: 'Atalhos',
    rows: [
      { id: 'div_config_auto', title: 'Automatico', description: 'Painel de tempos e ciclo' },
      { id: 'div_menu', title: 'Menu div', description: `${p}divmenu` }
    ]
  });
  await sendDivulgacaoList(
    conn,
    ctx.from,
    msg + `\nGrupo convite: ${inviteJid || '(nao configurado)'}`,
    sections,
    'Hanork Bot',
    ctx.info,
    'menu.jpg',
    ctx.telegramUserId,
    sessionId
  );
}

/** Compat: trilha avulsa redireciona pro menu unico CTA+Status. */
async function showSlotTrackPanel(conn, ctx, _trackRaw, notice = '') {
  return showSlotsPanel(conn, ctx, notice || 'Todos os padroes CTA/Status neste menu.');
}

/** Midia do slot ativo — mesmas acoes do painel midia, escopo CTA ou Status. */
async function showSlotMediaPanel(conn, ctx, trackRaw, notice = '') {
  if (!isDivAdmin(ctx.telegramUserId)) {
    return showSlotsPanel(conn, ctx, 'Padroes so para ADM.');
  }
  const track = String(trackRaw || '').toLowerCase() === 'status' ? 'status' : 'cta';
  rememberUiJid(ctx);
  const config = getConfig(ctx.telegramUserId);
  const sessionId = ctx.sessionId || conn?._sessionId;
  const active = getActiveSlot(config, track);
  const head = notice ? `${String(notice).trim()}\n\n` : '';
  const label = track === 'cta' ? 'CTA' : 'Status';
  const rows = track === 'cta'
    ? [
        { id: 'div_midia_cta_foto', title: 'Foto CTA', description: `Slot #${active}` },
        { id: 'div_midia_cta_video', title: 'Video CTA', description: `Slot #${active}` },
        { id: 'div_midia_cta_rm', title: 'Remover midia CTA', description: `Slot #${active}` }
      ]
    : [
        { id: 'div_midia_status_foto', title: 'Foto status', description: `Slot #${active}` },
        { id: 'div_midia_status_video', title: 'Video status', description: `Slot #${active}` },
        { id: 'div_midia_status_rm', title: 'Remover midia status', description: `Slot #${active}` }
      ];
  rows.push({ id: 'div_slots', title: 'Voltar padroes', description: 'Menu CTA + Status' });
  await sendDivulgacaoList(
    conn,
    ctx.from,
    `${head}MIDIA ${label} #${active}\n\n` +
      `Grava no slot ativo (*). Depois manda a foto/video (ou responde uma).`,
    [{ title: label, rows }],
    'Hanork Bot',
    ctx.info,
    'menu.jpg',
    ctx.telegramUserId,
    sessionId
  );
}

commands.divslots = {
  useCtx: true,
  description: 'ADM: menu unico CTA+Status (#1/#2)',
  usage: 'divslots',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    if (!isDivAdmin(ctx.telegramUserId)) {
      return showSlotsPanel(conn, ctx, 'Padroes so para ADMIN do Telegram.');
    }
    return showSlotsPanel(conn, ctx);
  }
};

/** Botoes ADM: grupo do convite + templates com {{groupInviteLink}} (mesmo painel DIV). */
async function handleInvitePanelAction(conn, ctx, action) {
  if (!(await requireSessionOwner(conn, ctx))) return true;
  if (!isDivAdmin(ctx.telegramUserId)) {
    await sendDivulgacaoMessage(conn, ctx, { text: 'So ADMIN Telegram.' }, { quoted: ctx.info });
    return true;
  }
  const inv = require('../../utils/divulgacaoInviteLink');
  const act = String(action || '');

  if (act === 'setgrupo') {
    let jid = '';
    if (String(ctx.from || '').endsWith('@g.us')) jid = String(ctx.from);
    else if (ctx.args && ctx.args[0]) jid = inv.normalizeGroupJid(ctx.args[0]);
    if (!jid) {
      await sendDivulgacaoMessage(conn, ctx, {
        text:
          'Grupo do convite\n\n' +
          'Entre no grupo oficial e toque de novo em \"Grupo do convite\",\n' +
          'ou mande: .divulgar setgrupo <jid>'
      }, { quoted: ctx.info });
      return true;
    }
    updateConfig(ctx.telegramUserId, { inviteGroupJid: jid, configurado: true });
    inv.invalidateInviteCache(jid);
    try {
      const live = await inv.fetchLiveInviteLink(conn, jid, { telegramUserId: ctx.telegramUserId });
      if (live.ok && live.url) {
        updateConfig(ctx.telegramUserId, { inviteLinkLast: live.url });
        await showSlotsPanel(conn, ctx, `Grupo do convite salvo:\n${jid}\nLink: ${live.url}`);
        return true;
      }
      logger.logAviso(`[DIV-INVITE] setgrupo sem link live: ${live.reason || live.detail || '?'}`);
    } catch (e) {
      logger.logAviso(`[DIV-INVITE] setgrupo: ${e.message}`);
    }
    await showSlotsPanel(conn, ctx, `Grupo do convite salvo:\n${jid}\n(link vivo indisponivel agora — bot precisa ser admin desse grupo)`);
    return true;
  }

  if (act === 'tpl_status') {
    const textoStatus = inv.templateStatusInvite();
    updateConfig(ctx.telegramUserId, { textoStatus, configurado: true });
    await showStatusPanel(conn, ctx, 'Texto oficial aplicado ({{groupInviteLink}}). Edite pelo botao Texto se quiser.');
    return true;
  }

  if (act === 'tpl_cta') {
    const prev = getConfig(ctx.telegramUserId).cta || {};
    const texto = inv.templateCtaInvite();
    const store = (() => {
      try {
        return require('../../utils/divulgacaoAdminDefaults').buyUrl();
      } catch (_) {
        try {
          return require('../../utils/productOffer').telegramStartLink('comprar');
        } catch (_) {
          return 'https://t.me/hanork_bot?start=comprar';
        }
      }
    })();
    updateConfig(ctx.telegramUserId, {
      cta: {
        texto,
        label: prev.label && !/catalogo|dono/i.test(String(prev.label)) ? prev.label : 'Abrir o bot',
        url: prev.url && !inv.hasInvitePlaceholder(prev.url) && !/wa\.me\/c\//i.test(String(prev.url))
          ? prev.url
          : store,
        label2: prev.label2 || '',
        url2: prev.url2 || ''
      },
      configurado: true
    });
    await showCtaPanel(conn, ctx, 'Texto completo de divulgacao aplicado (link do grupo vivo no fim). Foto/botao/URL editaveis aqui.');
    return true;
  }

  if (act === 'preview_status' || act === 'preview_cta') {
    const cfg = getConfig(ctx.telegramUserId);
    const raw =
      act === 'preview_status'
        ? String(cfg.textoStatus || inv.templateStatusInvite())
        : String(cfg.cta?.texto || inv.templateCtaInvite());
    const rendered = await inv.renderWithLiveInvite(conn, raw, {
      telegramUserId: ctx.telegramUserId,
      groupJid: cfg.inviteGroupJid
    });
    if (!rendered.ok) {
      await sendDivulgacaoMessage(conn, ctx, {
        text: rendered.message || inv.failMessage(rendered.reason)
      }, { quoted: ctx.info });
      return true;
    }
    await sendDivulgacaoMessage(conn, ctx, {
      text:
        `Preview (${rendered.cached ? 'cache curto' : 'live'}):\n\n` +
        rendered.text
    }, { quoted: ctx.info });
    return true;
  }

  return false;
}

commands.divenviar = {
  useCtx: true,
  description: 'ADM: menu enviar/editar todas as variantes (CTA1/2 Status1/2)',
  usage: 'divenviar',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    return showSlotsPanel(conn, ctx, 'Enviar ou editar cada variante (CTA/Status #1 e #2).');
  }
};
commands.editarcta2 = {
  useCtx: true,
  description: 'ADM: edita so o CTA #2 (texto/botao/link/midia)',
  usage: 'editarcta2',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    if (!isDivAdmin(ctx.telegramUserId)) {
      return showSlotsPanel(conn, ctx, 'CTA #2 so ADM.');
    }
    setActiveSlot(ctx.telegramUserId, 'cta', 2);
    return showCtaPanel(conn, ctx, 'Edicao CTA → slot 2 (nao mexe no CTA 1)');
  }
};
commands.editarstatus2 = {
  useCtx: true,
  description: 'ADM: edita so o Status #2',
  usage: 'editarstatus2',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    if (!isDivAdmin(ctx.telegramUserId)) {
      return showSlotsPanel(conn, ctx, 'Status #2 so ADM.');
    }
    setActiveSlot(ctx.telegramUserId, 'status', 2);
    return showStatusPanel(conn, ctx, 'Edicao Status → slot 2 (nao mexe no Status 1)');
  }
};
commands.horariocta2 = {
  useCtx: true,
  description: 'ADM: horario automatico so do CTA #2',
  usage: 'horariocta2 <minutos|2h>',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    ctx.args = ['cta:2', ...(ctx.args || [])];
    return commands.divconfigauto.execute(conn, ctx);
  }
};
commands.horariocta = {
  useCtx: true,
  description: 'Horario automatico do CTA #1',
  usage: 'horariocta <minutos|2h>',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    ctx.args = ['cta', ...(ctx.args || [])];
    return commands.divconfigauto.execute(conn, ctx);
  }
};
commands.divslot = {
  useCtx: true,
  description: 'ADM: ativa slot e abre o painel CTA/Status padrao',
  usage: 'divslot cta|status 1|2',
  execute: async (conn, ctx) => {
    if (!(await requireSessionOwner(conn, ctx))) return;
    if (!isDivAdmin(ctx.telegramUserId)) {
      return showSlotsPanel(conn, ctx, 'Padroes so para ADMIN do Telegram.');
    }
    const a = ctx.args || [];
    const trackMap = { cta: 'cta', status: 'status' };
    const track = trackMap[String(a[0] || '').toLowerCase()];
    const slot = clampSlot(a[1] || 1);
    if (!track) {
      return showSlotsPanel(conn, ctx, 'Use: divslot cta|status 1|2');
    }
    setActiveSlot(ctx.telegramUserId, track, slot);
    if (track === 'cta') {
      return showCtaPanel(conn, ctx, `Edicao CTA → slot ${slot}`);
    }
    return showStatusPanel(conn, ctx, `Edicao Status → slot ${slot}`);
  }
};