'use strict';

/**
 * Menu de divulgacao no Telegram = mesmo fluxo do WhatsApp (divmenu):
 * 4 trilhas (texto / CTA / pay / status), midia, preview, iniciar por tipo.
 * Prompts usam pendingTgCmds (nao bot.on('message') extra).
 */

const {
  getConfig: getDivConfig,
  updateConfig: updateDivConfig,
  getGruposParaDivulgar,
  formatTracksSummary,
  formatCtaSummary,
  formatTextoSummary,
  formatPaySummary,
  formatStatusSummary,
  formatSlotsSummary,
  isCtaReady,
  isTextoReady,
  isPayReady,
  isStatusReady,
  saveTextoMediaBuffer,
  saveCtaMediaBuffer,
  saveStatusMediaBuffer,
  clearStatusMedia,
  normalizeCtaUrl,
  clampCtaLabel,
  CTA_LABEL_MAX,
  isDivAdmin,
  setActiveSlot,
  updateSlotPatch
} = require('./divulgacao');
const { applyLivePrefix, cmdExample } = require('./configManager');

const PENDING_TTL = 5 * 60 * 1000;

function live(userId, text) {
  return applyLivePrefix(String(text || ''), '/');
}

function keepToken(text) {
  const t = String(text || '').trim().toLowerCase();
  return t === 'manter' || t === '-' || t === '.';
}

function skipToken(text) {
  const t = String(text || '').trim().toLowerCase();
  return ['pular', 'pula', 'nao', 'skip', 'nenhum', 'so1', 'so 1', 'sem'].includes(t);
}

function cancelToken(text) {
  const t = String(text || '').trim().toLowerCase();
  return t === 'cancelar' || t === 'cancel' || t === '/cancel';
}

function backKb(cb = 'menu_divulgacao') {
  return [[{ text: 'Voltar', callback_data: cb }, { text: 'Fechar', callback_data: 'close' }]];
}

function cancelKb() {
  return [[{ text: 'Cancelar', callback_data: 'div_prompt_cancel' }, { text: 'Fechar', callback_data: 'close' }]];
}

async function panel(deps, text, buttons) {
  const kb = buttons || backKb();
  if (typeof deps.sendMenuWithImage === 'function') {
    return deps.sendMenuWithImage(deps.chatId, text, kb);
  }
  return deps.bot.sendMessage(deps.chatId, text, { reply_markup: { inline_keyboard: kb } });
}

function isOurPending(pending) {
  if (!pending) return false;
  const cmd = String(pending.cmd || '');
  return cmd.startsWith('__div_') || pending.kind === 'div_media';
}

function setPending(pendingTgCmds, userId, chatId, patch) {
  pendingTgCmds.set(String(userId), {
    chatId,
    expires: Date.now() + PENDING_TTL,
    ...patch
  });
}

function extractTgMedia(msg) {
  if (!msg) return null;
  if (msg.photo && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { tipo: 'image', fileId: p.file_id, mimetype: 'image/jpeg' };
  }
  if (msg.animation) {
    return {
      tipo: 'gif',
      fileId: msg.animation.file_id,
      mimetype: msg.animation.mime_type || 'video/mp4',
      fileName: msg.animation.file_name
    };
  }
  if (msg.video) {
    return {
      tipo: 'video',
      fileId: msg.video.file_id,
      mimetype: msg.video.mime_type || 'video/mp4',
      fileName: msg.video.file_name
    };
  }
  if (msg.audio || msg.voice) {
    const a = msg.audio || msg.voice;
    return { tipo: 'audio', fileId: a.file_id, mimetype: a.mime_type || 'audio/ogg' };
  }
  if (msg.document) {
    return {
      tipo: 'document',
      fileId: msg.document.file_id,
      mimetype: msg.document.mime_type || 'application/octet-stream',
      fileName: msg.document.file_name
    };
  }
  return null;
}

function kindMatches(want, got) {
  if (!got) return false;
  if (want === 'any') return true;
  if (want === got) return true;
  if (want === 'gif' && got === 'video') return true;
  if (want === 'video' && got === 'gif') return true;
  if (want === 'image' && got === 'document') return true;
  return false;
}

function autoLine(userId) {
  try {
    const { isModoOn } = require('./divulgacaoAuto');
    const config = getDivConfig(userId);
    return isModoOn(config, 'status') || config.autoEnabled ? 'ON' : 'OFF';
  } catch (_) {
    const config = getDivConfig(userId);
    return config.autoEnabled ? 'ON' : 'OFF';
  }
}

function tracksBlock(userId) {
  const config = getDivConfig(userId);
  const adm = isDivAdmin(userId);
  const raw = adm
    ? `${formatSlotsSummary(config, userId)}\n\n${formatTracksSummary(config)}`
    : formatTracksSummary(config);
  return live(userId, raw);
}

function homeText(userId) {
  const config = getDivConfig(userId);
  const grupos = getGruposParaDivulgar(userId);
  const n = (grupos.grupos || []).length;
  return (
    'SISTEMA DE DIVULGACAO\n\n' +
    'Texto, CTA, pagamento e status sao configs SEPARADAS.\n' +
    'Quem usa varios links no texto nao mexe no CTA, e vice-versa.\n\n' +
    `${tracksBlock(userId)}\n\n` +
    'Neste chat os comandos sao com /  (ex: /divmenu /divcta)\n' +
    `Grupos na lista: ${n}\n` +
    `Automatico: ${autoLine(userId)}\n` +
    `Modo salvo: ${config.modoPrincipal || 'normal'}\n\n` +
    'Fluxo: monta o tipo → marca grupos → preview → iniciar.\n' +
    '1a msg: mencoes (ignora admins). Invisivel: so o que falar.\n\n' +
    'Os posts saem nos grupos do WhatsApp. Pareie em Conectar se o chip ainda nao esta online.\n' +
    `Atalho CTA: ${cmdExample(userId, 'divcta', { platform: 'telegram' })} texto | botao | https://link`
  );
}

function homeButtons(userId) {
  const rows = [
    [{ text: 'Iniciar', callback_data: 'div_start' }, { text: 'Preview', callback_data: 'div_preview' }],
    [{ text: 'Automatico', callback_data: 'div_config_auto' }, { text: 'Parar', callback_data: 'div_stop' }],
    [{ text: 'Texto', callback_data: 'div_track_texto' }, { text: 'CTA', callback_data: 'div_track_cta' }],
    [{ text: 'Pagamento', callback_data: 'div_track_pay' }, { text: 'Status', callback_data: 'div_track_status' }],
    [{ text: 'Midia', callback_data: 'div_track_midia' }, { text: 'Grupos', callback_data: 'gm_home' }]
  ];
  if (isDivAdmin(userId)) {
    rows.push([{ text: 'CTA + Status (#1/#2)', callback_data: 'div_slots' }]);
  }
  rows.push(
    [{ text: 'Avancado', callback_data: 'div_config_opts' }, { text: 'Ajuda', callback_data: 'div_ajuda' }],
    [{ text: 'Voltar', callback_data: 'menu_main' }, { text: 'Fechar', callback_data: 'close' }]
  );
  return rows;
}

function textoMenuText(userId) {
  const config = getDivConfig(userId);
  const hasMedia = !!(config.midiaFile || config.midia);
  return (
    'TRILHA TEXTO\n\n' +
    'Msg com varios links e mencoes. NAO e o CTA nem o status.\n\n' +
    `${live(userId, formatTextoSummary(config))}\n` +
    `Midia texto: ${hasMedia ? (config.midiaTipo || 'ok') : 'nao'}\n\n` +
    'Edite o texto, anexe midia e depois Iniciar → Texto.'
  );
}

function textoMenuButtons() {
  return [
    [{ text: 'Editar texto', callback_data: 'div_prompt_texto' }],
    [
      { text: 'Foto', callback_data: 'div_media_texto_image' },
      { text: 'Video', callback_data: 'div_media_texto_video' }
    ],
    [
      { text: 'GIF', callback_data: 'div_media_texto_gif' },
      { text: 'Audio', callback_data: 'div_media_texto_audio' }
    ],
    [{ text: 'Documento', callback_data: 'div_media_texto_document' }, { text: 'Limpar midia', callback_data: 'div_clear_texto' }],
    [{ text: 'Enviar este tipo', callback_data: 'div_pick_normal' }, { text: 'Preview', callback_data: 'div_preview' }],
    [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }]
  ];
}

function ctaMenuText(userId) {
  const config = getDivConfig(userId);
  return (
    'TRILHA CTA\n\n' +
    'Cartao com texto + botao + link. Separado do texto normal.\n' +
    '1 URL = 1 botao. 2 URLs = 2 botoes.\n\n' +
    `${live(userId, formatCtaSummary(config))}\n\n` +
    `Max do rotulo: ${CTA_LABEL_MAX} caracteres.`
  );
}

function ctaMenuButtons(userId) {
  const config = getDivConfig(userId);
  const has2 = !!(config?.cta?.label2 || config?.cta?.url2);
  const rows = [
    [{ text: 'Texto do cartao', callback_data: 'div_prompt_cta_texto' }],
    [{ text: 'Botao 1', callback_data: 'div_prompt_cta_label' }, { text: 'Link 1', callback_data: 'div_prompt_cta_url' }],
    [
      { text: has2 ? 'Editar botao 2' : 'Add botao 2', callback_data: 'div_prompt_cta_label2' },
      { text: 'Link 2', callback_data: 'div_prompt_cta_url2' }
    ]
  ];
  if (has2) {
    rows.push([{ text: 'Tirar botao 2', callback_data: 'div_cta_btn2_rm' }]);
  }
  rows.push(
    [{ text: 'Foto CTA', callback_data: 'div_media_cta_image' }, { text: 'Remover foto', callback_data: 'div_clear_cta' }],
    [{ text: 'Enviar CTA', callback_data: 'div_pick_cta' }, { text: 'Preview', callback_data: 'div_preview' }],
    [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }]
  );
  return rows;
}

function payMenuText(userId) {
  const config = getDivConfig(userId);
  return (
    'TRILHA PAGAMENTO\n\n' +
    'Texto do PIX/cobranca. Separado do texto e do CTA.\n\n' +
    live(userId, formatPaySummary(config))
  );
}

function payMenuButtons() {
  return [
    [{ text: 'Editar texto', callback_data: 'div_prompt_pay' }],
    [{ text: 'Enviar pagamento', callback_data: 'div_pick_pay' }, { text: 'Preview', callback_data: 'div_preview' }],
    [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }]
  ];
}

function statusMenuText(userId) {
  const config = getDivConfig(userId);
  return (
    'TRILHA STATUS\n\n' +
    'Texto e midia so do status. Nao usa o texto normal.\n\n' +
    live(userId, formatStatusSummary(config))
  );
}

function statusMenuButtons() {
  return [
    [{ text: 'Editar texto', callback_data: 'div_prompt_status' }],
    [
      { text: 'Foto', callback_data: 'div_media_status_image' },
      { text: 'Video', callback_data: 'div_media_status_video' }
    ],
    [{ text: 'Limpar midia', callback_data: 'div_clear_status' }],
    [{ text: 'Enviar status', callback_data: 'div_pick_status' }, { text: 'Preview', callback_data: 'div_preview' }],
    [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }]
  ];
}

function midiaMenuText(userId) {
  const config = getDivConfig(userId);
  const texto = config.midiaFile || config.midia ? (config.midiaTipo || 'ok') : 'nao';
  const cta = config?.cta?.midiaFile ? (config.cta.midiaTipo || 'foto') : 'nao';
  const status = config.statusMidiaFile ? (config.statusMidiaTipo || 'ok') : 'nao';
  return (
    'MIDIA POR TRILHA\n\n' +
    `Texto: ${texto}\n` +
    `CTA: ${cta}\n` +
    `Status: ${status}\n\n` +
    'Cada tipo tem a propria midia. Foto do CTA nao vai no texto.'
  );
}

function midiaMenuButtons() {
  return [
    [{ text: 'Foto texto', callback_data: 'div_media_texto_image' }, { text: 'Video texto', callback_data: 'div_media_texto_video' }],
    [{ text: 'Foto CTA', callback_data: 'div_media_cta_image' }],
    [{ text: 'Foto status', callback_data: 'div_media_status_image' }, { text: 'Video status', callback_data: 'div_media_status_video' }],
    [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }]
  ];
}

function ajudaText(userId) {
  return (
    'COMO USAR A DIVULGACAO\n\n' +
    'Aqui no Telegram voce monta as 4 trilhas (igual no Zap).\n' +
    'O disparo sai nos grupos do WhatsApp pareado.\n\n' +
    'Neste chat: /divmenu  /divcta  /addgrupo\n\n' +
    'Texto — mensagem com varios links + mencoes.\n' +
    'CTA — cartao com botao e link (1 ou 2 botoes).\n' +
    'Pagamento — texto do PIX/cobranca.\n' +
    'Status — texto + foto/video so do status.\n\n' +
    'Fluxo: edita a trilha → Grupos (/addgrupo) → Preview → Iniciar → escolhe o tipo.\n' +
    'Automatico cicla sozinho nos grupos marcados.\n' +
    'CTA + Status #1/#2 e so para admin Telegram.'
  );
}

function startPickText(userId) {
  const config = getDivConfig(userId);
  const grupos = getGruposParaDivulgar(userId);
  const n = (grupos.grupos || []).length;
  const mark = (ok, label) => `${label}: ${ok ? 'pronto' : 'incompleto'}`;
  return (
    'ESCOLHA O TIPO DE DIVULGACAO\n\n' +
    'Manda SO o tipo que voce clicar. Nao mistura texto+CTA+pay+status.\n\n' +
    `${tracksBlock(userId)}\n\n` +
    `${mark(isTextoReady(config), 'Texto')}\n` +
    `${mark(isCtaReady(config), 'CTA')}\n` +
    `${mark(isPayReady(config), 'Pagamento')}\n` +
    `${mark(isStatusReady(config), 'Status')}\n\n` +
    `Grupos na lista: ${n}\n` +
    (n ? 'Depois confirma quantidade e delay.' : 'Sem grupos: use addgrupo no WhatsApp (ou Gerenciar grupos).')
  );
}

function startPickButtons() {
  return [
    [{ text: 'Texto', callback_data: 'div_pick_normal' }, { text: 'CTA', callback_data: 'div_pick_cta' }],
    [{ text: 'Pagamento', callback_data: 'div_pick_pay' }, { text: 'Status', callback_data: 'div_pick_status' }],
    [{ text: 'Modo salvo', callback_data: 'div_pick_full' }],
    [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }]
  ];
}

const extraMenus = {
  div_track_texto: {
    text: textoMenuText,
    buttons: textoMenuButtons
  },
  div_config_msg: {
    text: textoMenuText,
    buttons: textoMenuButtons
  },
  div_track_cta: {
    text: ctaMenuText,
    buttons: ctaMenuButtons
  },
  div_track_pay: {
    text: payMenuText,
    buttons: payMenuButtons
  },
  div_track_status: {
    text: statusMenuText,
    buttons: statusMenuButtons
  },
  div_track_midia: {
    text: midiaMenuText,
    buttons: midiaMenuButtons
  },
  div_ajuda: {
    text: ajudaText,
    buttons: () => [
      [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }]
    ]
  },
  div_start_pick: {
    text: startPickText,
    buttons: startPickButtons
  }
};

const PROMPTS = {
  __div_texto__: {
    menu: 'div_track_texto',
    ask: 'Manda o texto da divulgacao agora.\nVarios links ok. cancelar pra sair. manter pra nao mudar.'
  },
  __div_pay__: {
    menu: 'div_track_pay',
    ask: 'Manda o texto de pagamento (PIX/cobranca).\ncancelar pra sair. manter pra nao mudar.'
  },
  __div_status__: {
    menu: 'div_track_status',
    ask: 'Manda o texto do status (nao usa o texto normal).\ncancelar pra sair. manter pra nao mudar.'
  },
  __div_cta_texto__: {
    menu: 'div_track_cta',
    ask: 'PASSO 1 — texto do cartao CTA (aparece em cima do botao).\nNao e o texto normal.\ncancelar / manter.'
  },
  __div_cta_label__: {
    menu: 'div_track_cta',
    ask: `PASSO 2 — texto do 1o botao (ex: Entrar / Grupo). Max ${CTA_LABEL_MAX}.\ncancelar / manter.`
  },
  __div_cta_url__: {
    menu: 'div_track_cta',
    ask: 'PASSO 3 — link do 1o botao (https://... ou wa.me/...).\ncancelar / manter.'
  },
  __div_cta_label2__: {
    menu: 'div_track_cta',
    ask: `PASSO 4 — 2o botao (opcional). Max ${CTA_LABEL_MAX}.\npular pra ficar so com 1. cancelar / manter.`
  },
  __div_cta_url2__: {
    menu: 'div_track_cta',
    ask: 'PASSO 5 — link do 2o botao.\npular pra tirar o 2o botao. cancelar / manter.'
  }
};

const PROMPT_BY_DATA = {
  div_prompt_texto: '__div_texto__',
  div_set_text: '__div_texto__',
  div_prompt_pay: '__div_pay__',
  div_prompt_status: '__div_status__',
  div_prompt_cta_texto: '__div_cta_texto__',
  div_prompt_cta_label: '__div_cta_label__',
  div_prompt_cta_url: '__div_cta_url__',
  div_prompt_cta_label2: '__div_cta_label2__',
  div_prompt_cta_url2: '__div_cta_url2__'
};

const MEDIA_ASK = {
  image: 'Manda a foto agora (ou um documento imagem).\ncancelar pra sair.',
  video: 'Manda o video agora.\ncancelar pra sair.',
  gif: 'Manda o GIF (animacao) agora.\ncancelar pra sair.',
  audio: 'Manda o audio agora.\ncancelar pra sair.',
  document: 'Manda o documento agora.\ncancelar pra sair.'
};

function tipoLabel(tipo) {
  if (tipo === 'cta') return 'CTA';
  if (tipo === 'pay') return 'Pagamento';
  if (tipo === 'status') return 'Status';
  if (tipo === 'full') return 'Modo salvo';
  return 'Texto';
}

function tipoReady(config, tipo) {
  if (tipo === 'cta') return isCtaReady(config);
  if (tipo === 'pay') return isPayReady(config);
  if (tipo === 'status') return isStatusReady(config);
  if (tipo === 'full') return isPayReady(config) || isTextoReady(config) || isCtaReady(config);
  return isTextoReady(config);
}

function tipoHint(tipo) {
  if (tipo === 'cta') return 'Configure texto, botao e link do CTA.';
  if (tipo === 'pay') return 'Configure o texto de pagamento.';
  if (tipo === 'status') return 'Configure texto e/ou midia do status.';
  if (tipo === 'full') return 'Modo salvo precisa de pelo menos uma trilha pronta.';
  return 'Configure o texto (trilha Texto).';
}

async function askPrompt(deps, cmd) {
  const spec = PROMPTS[cmd];
  if (!spec) return false;
  setPending(deps.pendingTgCmds, deps.userId, deps.chatId, { cmd });
  await panel(deps, spec.ask, cancelKb());
  return true;
}

async function askMedia(deps, track, tipo) {
  setPending(deps.pendingTgCmds, deps.userId, deps.chatId, {
    cmd: '__div_media__',
    kind: 'div_media',
    track,
    tipo
  });
  const where = track === 'cta' ? ' do CTA' : track === 'status' ? ' do status' : ' do texto';
  await panel(deps, (MEDIA_ASK[tipo] || MEDIA_ASK.image).replace(' agora', where + ' agora'), cancelKb());
  return true;
}

async function sendConfirm(deps, tipo) {
  const { chatId, userId, resolveLiveSession, liveSessionErrorMessage, showMenu } = deps;
  const liveSess = resolveLiveSession(userId);
  if (!liveSess.conn) {
    await panel(deps, liveSessionErrorMessage(liveSess.reason), backKb());
    return true;
  }
  const config = getDivConfig(userId);
  const grupos = getGruposParaDivulgar(userId);
  const n = (grupos.grupos || []).length;
  if (!n) {
    await panel(deps, live(userId, 'Nenhum grupo na lista. Use addgrupo no WhatsApp (ou Gerenciar grupos).'), [
      [{ text: 'Grupos', callback_data: 'gm_home' }, { text: 'Voltar', callback_data: 'menu_divulgacao' }]
    ]);
    return true;
  }
  if (!tipoReady(config, tipo)) {
    await panel(deps, tipoHint(tipo), backKb(
      tipo === 'cta' ? 'div_track_cta' :
      tipo === 'pay' ? 'div_track_pay' :
      tipo === 'status' ? 'div_track_status' :
      'div_track_texto'
    ));
    return true;
  }
  const qtd = config.quantidade || 1;
  const delayMsg = config.delayMsg || 3000;
  const snippet =
    tipo === 'cta' ? String(config.cta?.texto || '').slice(0, 80) :
    tipo === 'pay' ? String(config.textoPay || '').slice(0, 80) :
    tipo === 'status' ? String(config.textoStatus || '').slice(0, 80) :
    String(config.texto || '').slice(0, 80);
  await panel(
    deps,
    `CONFIRMAR DIVULGACAO\n\n` +
    `Tipo: ${tipoLabel(tipo)}\n` +
    `Grupos: ${n}\n` +
    `Quantidade: ${qtd}x\n` +
    `Delay: ${delayMsg}ms\n` +
    `Trecho: ${snippet || '(vazio)'}`,
    [
      [{ text: 'Confirmar', callback_data: `div_tg_confirm_${tipo}_${qtd}_${delayMsg}` }],
      [{ text: 'Cancelar', callback_data: 'menu_divulgacao' }]
    ]
  );
  return true;
}

async function runPreview(deps) {
  const { chatId, userId, getCommand, resolveLiveSession, selfJidFromConn, logger, showMenu } = deps;
  const liveSess = resolveLiveSession(userId);
  if (!liveSess.conn) {
    await panel(
      deps,
      'PREVIEW (texto)\n\nChip WhatsApp ainda nao esta online. Abaixo o que esta salvo:\n\n' +
      tracksBlock(userId) +
      '\n\nPareie em Conectar pra ver o cartao/midia no Zap.',
      backKb()
    );
    return true;
  }
  const previewCmd = getCommand('previewdivul');
  if (!previewCmd) {
    await panel(deps, tracksBlock(userId), backKb());
    return true;
  }
  const selfJid = selfJidFromConn(liveSess.conn);
  try {
    await previewCmd.execute(liveSess.conn, {
      from: selfJid || liveSess.sessionId,
      info: null,
      text: '',
      args: [],
      telegramUserId: userId,
      sessionId: liveSess.sessionId,
      isOwner: true,
      isVip: true,
      telegramChatId: chatId
    });
    await panel(deps, 'Preview enviado no WhatsApp.\n\n' + tracksBlock(userId), backKb());
  } catch (e) {
    if (logger && logger.logErro) logger.logErro('DIV_TG_PREVIEW', e.message);
    await panel(deps, 'Nao deu pra mandar o preview no Zap.\n\n' + tracksBlock(userId), backKb());
  }
  return true;
}

async function runConfirmStart(deps, data) {
  const { userId, getCommand, resolveLiveSession, liveSessionErrorMessage, selfJidFromConn, logger, showMenu, chatId } = deps;
  const liveSess = resolveLiveSession(userId);
  if (!liveSess.conn) {
    await panel(deps, liveSessionErrorMessage(liveSess.reason), backKb());
    return true;
  }
  const rest = String(data).replace('div_tg_confirm_', '');
  const parts = rest.split('_');
  const tipo = parts[0] || 'normal';
  const qtd = parseInt(parts[1], 10) || 1;
  const delayMsg = parseInt(parts[2], 10) || 3000;
  const selfJid = selfJidFromConn(liveSess.conn);
  if (!selfJid) {
    await panel(deps, 'Sessao WA sem JID do bot. Reconecte e tente de novo.', backKb());
    return true;
  }
  const divConfirm = getCommand('divconfirmar');
  if (!divConfirm) {
    await panel(deps, 'Comando divconfirmar nao encontrado.', backKb());
    return true;
  }
  await panel(deps, 'Iniciando divulgacao... aguarde.', backKb());
  try {
    await divConfirm.execute(liveSess.conn, {
      from: selfJid,
      info: null,
      id: `div_confirm_iniciar_${tipo}_${qtd}_${delayMsg}`,
      text: '',
      args: [],
      telegramUserId: userId,
      sessionId: liveSess.sessionId,
      isOwner: true,
      isVip: true,
      telegramChatId: chatId
    });
    await panel(deps, 'Divulgacao iniciada. Acompanhe nos grupos WhatsApp.', [
      [{ text: 'Parar', callback_data: 'div_stop' }, { text: 'Menu', callback_data: 'menu_divulgacao' }]
    ]);
  } catch (e) {
    if (logger && logger.logErro) logger.logErro('DIV_TG_CONFIRM', e.message);
    const pub = /undefined|item-not-found/i.test(String(e.message || ''))
      ? 'Falha ao enviar no WhatsApp. Tente de novo.'
      : String(e.message || e).slice(0, 180);
    await panel(deps, `Erro ao iniciar divulgacao: ${pub}`, backKb());
  }
  return true;
}

async function runStop(deps) {
  const { userId, getCommand, resolveLiveSession, liveSessionErrorMessage, selfJidFromConn, logger } = deps;
  const liveSess = resolveLiveSession(userId);
  if (!liveSess.conn) {
    await panel(deps, liveSessionErrorMessage(liveSess.reason), backKb());
    return true;
  }
  const divStopCmd = getCommand('divstop');
  if (!divStopCmd) {
    await panel(deps, 'Comando divstop nao encontrado.', backKb());
    return true;
  }
  try {
    await divStopCmd.execute(liveSess.conn, {
      from: selfJidFromConn(liveSess.conn) || liveSess.sessionId,
      info: null,
      text: '',
      telegramUserId: userId,
      sessionId: liveSess.sessionId,
      isOwner: true,
      isVip: true
    });
    await panel(deps, 'Divulgacao parada.', backKb());
  } catch (e) {
    if (logger && logger.logErro) logger.logErro('DIV_STOP', e.message);
    await panel(deps, `Erro ao parar: ${e.message}`, backKb());
  }
  return true;
}

async function handleCallback(deps) {
  const { data, chatId, userId, showMenu } = deps;
  if (!data) return false;

  if (data === 'div_prompt_cancel') {
    deps.pendingTgCmds.delete(String(userId));
    await showMenu(chatId, 'divulgacao', userId);
    return true;
  }

  if (data === 'div_ajuda') {
    await showMenu(chatId, 'div_ajuda', userId);
    return true;
  }
  if (data === 'div_track_texto' || data === 'div_config_msg') {
    await showMenu(chatId, 'div_track_texto', userId);
    return true;
  }
  if (data === 'div_track_cta' || data === 'div_config_cta') {
    await showMenu(chatId, 'div_track_cta', userId);
    return true;
  }
  if (data === 'div_track_pay' || data === 'div_config_pay') {
    await showMenu(chatId, 'div_track_pay', userId);
    return true;
  }
  if (data === 'div_track_status' || data === 'div_config_status') {
    await showMenu(chatId, 'div_track_status', userId);
    return true;
  }
  if (data === 'div_track_midia' || data === 'div_config_midia') {
    await showMenu(chatId, 'div_track_midia', userId);
    return true;
  }
  if (data === 'div_preview') {
    return runPreview(deps);
  }
  if (data === 'div_start') {
    await showMenu(chatId, 'div_start_pick', userId);
    return true;
  }
  if (data === 'div_pick_normal' || data === 'div_tipo_normal') return sendConfirm(deps, 'normal');
  if (data === 'div_pick_cta' || data === 'div_tipo_cta') return sendConfirm(deps, 'cta');
  if (data === 'div_pick_pay' || data === 'div_tipo_pay') return sendConfirm(deps, 'pay');
  if (data === 'div_pick_status' || data === 'div_tipo_status') return sendConfirm(deps, 'status');
  if (data === 'div_pick_full' || data === 'div_tipo_full') return sendConfirm(deps, 'full');

  const promptCmd = PROMPT_BY_DATA[data];
  if (promptCmd) return askPrompt(deps, promptCmd);

  const mediaM = String(data).match(/^div_media_(texto|cta|status)_(image|video|gif|audio|document)$/);
  if (mediaM) return askMedia(deps, mediaM[1], mediaM[2]);

  if (data === 'div_send_image') return askMedia(deps, 'texto', 'image');
  if (data === 'div_send_video') return askMedia(deps, 'texto', 'video');
  if (data === 'div_send_gif') return askMedia(deps, 'texto', 'gif');
  if (data === 'div_send_audio') return askMedia(deps, 'texto', 'audio');
  if (data === 'div_send_doc') return askMedia(deps, 'texto', 'document');

  if (data === 'div_clear_texto' || data === 'div_clear_media') {
    updateDivConfig(userId, {
      midia: null,
      midiaFile: null,
      midiaTipo: null,
      midiaMimetype: null,
      midiaNome: null
    });
    await showMenu(chatId, 'div_track_texto', userId);
    return true;
  }
  if (data === 'div_clear_cta' || data === 'div_cta_foto_remover') {
    updateDivConfig(userId, {
      cta: { midia: null, midiaFile: null, midiaTipo: null, midiaMimetype: null }
    });
    await showMenu(chatId, 'div_track_cta', userId);
    return true;
  }
  if (data === 'div_clear_status') {
    clearStatusMedia(userId);
    await showMenu(chatId, 'div_track_status', userId);
    return true;
  }
  if (data === 'div_cta_btn2_rm') {
    updateDivConfig(userId, { cta: { label2: '', url2: '' } });
    await showMenu(chatId, 'div_track_cta', userId);
    return true;
  }

  const slotTextM = String(data).match(/^div_slot_text_(cta|status)_([12])$/);
  if (slotTextM) {
    if (!isDivAdmin(userId)) return true;
    const track = slotTextM[1];
    const slot = Number(slotTextM[2]);
    setActiveSlot(userId, track, slot);
    const cmd = track === 'cta' ? '__div_slot_cta__' : '__div_slot_status__';
    setPending(deps.pendingTgCmds, userId, chatId, { cmd, track, slot });
    const hint = track === 'cta'
      ? `CTA#${slot} — envie o texto (ou texto | botao | https://link).\ncancelar pra sair.`
      : `Status#${slot} — envie o texto deste slot.\ncancelar pra sair.`;
    await panel(deps, hint, cancelKb());
    return true;
  }

  const slotMidiaM = String(data).match(/^div_slot_midia_(cta|status)_([12])$/);
  if (slotMidiaM) {
    if (!isDivAdmin(userId)) return true;
    const track = slotMidiaM[1];
    const slot = Number(slotMidiaM[2]);
    setActiveSlot(userId, track, slot);
    setPending(deps.pendingTgCmds, userId, chatId, {
      cmd: '__div_media__',
      kind: 'div_media',
      track,
      tipo: 'any',
      slot
    });
    await panel(deps, `Midia ${track}#${slot}. Envie foto ou video agora.\ncancelar pra sair.`, cancelKb());
    return true;
  }

  if (String(data).startsWith('div_tg_confirm_')) {
    return runConfirmStart(deps, data);
  }
  if (data === 'div_stop') {
    return runStop(deps);
  }
  if (data === 'div_status') {
    await showMenu(chatId, 'divulgacao', userId);
    return true;
  }

  return false;
}

function applyField(userId, cmd, raw) {
  const text = String(raw || '').trim();
  if (cmd === '__div_texto__') {
    updateDivConfig(userId, { texto: text, configurado: true });
    return { menu: 'div_track_texto', ok: 'Texto salvo.' };
  }
  if (cmd === '__div_pay__') {
    updateDivConfig(userId, { textoPay: text, configurado: true });
    return { menu: 'div_track_pay', ok: 'Texto de pagamento salvo.' };
  }
  if (cmd === '__div_status__') {
    updateDivConfig(userId, { textoStatus: text, configurado: true });
    return { menu: 'div_track_status', ok: 'Texto do status salvo.' };
  }
  if (cmd === '__div_cta_texto__') {
    updateDivConfig(userId, { cta: { texto: text }, configurado: true });
    return { menu: 'div_track_cta', ok: 'Texto do CTA salvo.' };
  }
  if (cmd === '__div_cta_label__') {
    const label = clampCtaLabel(text);
    if (!label) return { error: 'Texto do botao vazio. Manda de novo ou cancelar.' };
    updateDivConfig(userId, { cta: { label }, configurado: true });
    return { menu: 'div_track_cta', ok: 'Botao 1 salvo.' };
  }
  if (cmd === '__div_cta_url__') {
    const url = normalizeCtaUrl(text);
    if (!url) return { error: 'Link invalido. Cole https://... ou wa.me/... ou cancelar.' };
    updateDivConfig(userId, { cta: { url }, configurado: true });
    return { menu: 'div_track_cta', ok: 'Link 1 salvo.' };
  }
  if (cmd === '__div_cta_label2__') {
    const label2 = clampCtaLabel(text);
    if (!label2) return { error: 'Texto do 2o botao vazio. Manda de novo, pular ou cancelar.' };
    updateDivConfig(userId, { cta: { label2 }, configurado: true });
    return { menu: 'div_track_cta', ok: 'Botao 2 salvo. Agora o link 2.' };
  }
  if (cmd === '__div_cta_url2__') {
    const url2 = normalizeCtaUrl(text);
    if (!url2) return { error: '2o link invalido. Cole uma URL ou pular / cancelar.' };
    updateDivConfig(userId, { cta: { url2 }, configurado: true });
    return { menu: 'div_track_cta', ok: 'Link 2 salvo.' };
  }
  if (cmd === '__div_slot_cta__') {
    const parts = text.split('|').map((s) => s.trim()).filter(Boolean);
    const patch = { texto: parts[0] || text };
    if (parts[1]) patch.label = parts[1].slice(0, CTA_LABEL_MAX);
    if (parts[2]) patch.url = parts[2];
    return { menu: 'div_slots', ok: 'CTA do slot salvo.', slotPatch: patch };
  }
  if (cmd === '__div_slot_status__') {
    return { menu: 'div_slots', ok: 'Status do slot salvo.', slotPatch: { textoStatus: text } };
  }
  return null;
}

async function handlePending(deps) {
  const { userId, msg, pending, pendingTgCmds, showMenu, downloadTelegramFileBuffer, logger } = deps;
  if (!isOurPending(pending)) return false;
  if (Date.now() > Number(pending.expires || 0)) {
    pendingTgCmds.delete(String(userId));
    return false;
  }
  if (pending.chatId != null && String(pending.chatId) !== String(deps.chatId)) return false;

  const text = String(msg?.text || msg?.caption || '').trim();
  if (text && text.startsWith('/') && !cancelToken(text)) {
    pendingTgCmds.delete(String(userId));
    return false;
  }

  if (cancelToken(text)) {
    pendingTgCmds.delete(String(userId));
    await showMenu(deps.chatId, 'divulgacao', userId);
    return true;
  }

  if (pending.kind === 'div_media') {
    const media = extractTgMedia(msg);
    if (!media) {
      if (text) {
        await panel(deps, 'Manda a midia (nao texto). cancelar pra sair.', cancelKb());
        return true;
      }
      return false;
    }
    if (!kindMatches(pending.tipo || 'any', media.tipo)) {
      await panel(deps, `Essa midia nao e ${pending.tipo}. Manda de novo ou cancelar.`, cancelKb());
      return true;
    }
    pendingTgCmds.delete(String(userId));
    try {
      const buffer = await downloadTelegramFileBuffer(media.fileId);
      const meta = { tipo: media.tipo, mimetype: media.mimetype, fileName: media.fileName };
      if (pending.track === 'cta') {
        saveCtaMediaBuffer(userId, buffer, meta);
        await showMenu(deps.chatId, pending.slot ? 'div_slots' : 'div_track_cta', userId);
      } else if (pending.track === 'status') {
        saveStatusMediaBuffer(userId, buffer, meta);
        await showMenu(deps.chatId, pending.slot ? 'div_slots' : 'div_track_status', userId);
      } else {
        saveTextoMediaBuffer(userId, buffer, meta);
        await showMenu(deps.chatId, 'div_track_texto', userId);
      }
    } catch (e) {
      if (logger && logger.logErro) logger.logErro('DIV_TG_MEDIA', e.message);
      await panel(deps, `Erro ao salvar midia: ${e.message}`, cancelKb());
    }
    return true;
  }

  if (!text) return false;
  if (keepToken(text)) {
    pendingTgCmds.delete(String(userId));
    const spec = PROMPTS[pending.cmd];
    await showMenu(deps.chatId, (spec && spec.menu) || 'divulgacao', userId);
    return true;
  }

  if (pending.cmd === '__div_cta_label2__' && skipToken(text)) {
    pendingTgCmds.delete(String(userId));
    updateDivConfig(userId, { cta: { label2: '', url2: '' } });
    await showMenu(deps.chatId, 'div_track_cta', userId);
    return true;
  }
  if (pending.cmd === '__div_cta_url2__' && skipToken(text)) {
    pendingTgCmds.delete(String(userId));
    updateDivConfig(userId, { cta: { label2: '', url2: '' } });
    await showMenu(deps.chatId, 'div_track_cta', userId);
    return true;
  }

  const result = applyField(userId, pending.cmd, text);
  if (!result) return false;
  if (result.error) {
    await panel(deps, result.error, cancelKb());
    return true;
  }
  pendingTgCmds.delete(String(userId));
  if (result.slotPatch && pending.track && pending.slot) {
    updateSlotPatch(userId, pending.track, pending.slot, result.slotPatch);
  }
  if (pending.cmd === '__div_cta_label2__') {
    return askPrompt(deps, '__div_cta_url2__');
  }
  await showMenu(deps.chatId, result.menu, userId);
  return true;
}

module.exports = {
  homeText,
  homeButtons,
  extraMenus,
  handleCallback,
  handlePending,
  isOurPending,
  tracksBlock
};
