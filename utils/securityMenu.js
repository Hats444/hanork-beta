// utils/securityMenu.js — painel Anti-flood / Seguranca (botoes ON = lista; OFF = texto util)
'use strict';

const { stripAccents } = require('./typography');
const {
  formatGroupSecurityStatus,
  getGroupSecurity,
  getOwnerSecurity,
  isModerationActive,
  getGroupLists,
  getAntipornoHealth
} = require('./moderation');
const { areButtonsOn } = require('./sessionRegistry');
const { displayPrefix, applyLivePrefix } = require('./configManager');

function antipornoKeyReady() {
  return !!(String(
    process.env.HANORK_API_KEY ||
    process.env.ZEROTWO_API_KEY ||
    process.env.HANORK_API_KEY ||
    process.env.ZEROTWO_API_KEY ||
    ''
  ).trim());
}

function antipornoUi() {
  try {
    if (typeof getAntipornoHealth === 'function') return getAntipornoHealth();
  } catch (_) { /* ignore */ }
  if (!antipornoKeyReady()) {
    return {
      state: 'no_key',
      label: 'SEM CHAVE',
      explain: 'SEM CHAVE: toggle nao analisa midia. Coloque HANORK_API_KEY no .env'
    };
  }
  return {
    state: 'unknown',
    label: 'INDISPONIVEL',
    explain: 'Classifica so foto. Se a API estiver morta, o toggle nao apaga.'
  };
}

function itemUiLabel(it) {
  if (it.name === 'antiporno') {
    const h = antipornoUi();
    if (h.state === 'disabled') return 'Anti-porno (INDISPONIVEL)';
    if (h.state === 'no_key') return 'Anti-porno (precisa chave)';
    if (h.state === 'down') return 'Anti-porno (API morta)';
    if (h.state === 'unknown') return 'Anti-porno (INDISPONIVEL)';
  }
  return it.label;
}

function itemUiExplain(it) {
  if (it.name === 'antiporno') return antipornoUi().explain;
  return it.explain;
}

function antipornoStateWord(flags) {
  if (!flags.antiporno) return '';
  const h = antipornoUi();
  if (h.label) return h.label;
  return 'ON';
}

/**
 * Toggles clicaveis no menu.
 * explain = o que faz + acao (cabe em ~72 chars na lista WA)
 * actionHint = delete|ban|kick|ignore|msg|download|sticker|gate|admin
 */
const SECURITY_ITEMS = [
  {
    section: 'Gates (sempre ON)',
    items: [
      {
        id: 'info_outbound',
        name: 'info_outbound',
        info: true,
        label: 'Outbound gate',
        explain: 'Bloqueia armas do bot (crash/rich). Sempre ON',
        actionHint: 'gate'
      },
      {
        id: 'info_infra',
        name: 'info_infra',
        info: true,
        label: 'Infra gate',
        explain: 'Trava canal/sistema perigoso. Sempre ON',
        actionHint: 'gate'
      }
    ]
  },
  {
    section: 'Anti-flood',
    items: [
      {
        id: 'cmd_modenable',
        name: 'modenable',
        label: 'Anti-flood',
        explain: 'ON: flood de msgs suspeitas → so APAGA (nao remove membro)',
        actionHint: 'delete'
      },
      {
        id: 'cmd_moddisable',
        name: 'moddisable',
        label: 'Anti-flood',
        explain: 'OFF: desliga anti-flood (apaga)',
        actionHint: 'delete'
      },
      {
        id: 'cmd_modlist',
        name: 'modlist',
        action: true,
        label: 'Listar grupos',
        explain: 'Mostra grupos com anti-flood ON',
        actionHint: 'admin'
      }
    ]
  },
  {
    section: 'Links e canal',
    items: [
      {
        id: 'cmd_antilink',
        name: 'antilink',
        flag: 'antilink',
        label: 'Anti-link',
        explain: 'ON: apaga qualquer link (adm/lista branca ok)',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antilinkeasy',
        name: 'antilinkeasy',
        flag: 'antilinkEasy',
        label: 'Anti-link easy',
        explain: 'ON: apaga link (modo leve, menos rigor)',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antilinkhard',
        name: 'antilinkhard',
        flag: 'antilinkHard',
        label: 'Anti-link HARD',
        explain: 'ON: apaga link E REMOVE o membro',
        actionHint: 'kick'
      },
      {
        id: 'cmd_antilinkgp',
        name: 'antilinkgp',
        flag: 'antilinkGp',
        label: 'Anti-link GP',
        explain: 'ON: so apaga convite chat.whatsapp.com',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antichannel',
        name: 'antichannel',
        flag: 'antichannel',
        label: 'Anti-canal',
        explain: 'ON: apaga link de canal/newsletter',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antipayment',
        name: 'antipayment',
        flag: 'antipayment',
        label: 'Anti-pagamento',
        explain: 'ON: apaga PIX nativo (ate embrulhado em status/viewOnce). Dirigido (so alguns veem) → apaga+remove se antiatkpagamento tambem estiver ON',
        actionHint: 'delete'
      }
    ]
  },
  {
    section: 'Midia',
    items: [
      {
        id: 'cmd_antiimg',
        name: 'antiimg',
        flag: 'antiimg',
        label: 'Anti-imagem',
        explain: 'ON: apaga foto de nao-admin',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antivideo',
        name: 'antivideo',
        flag: 'antivideo',
        label: 'Anti-video',
        explain: 'ON: apaga video de nao-admin',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antiaudio',
        name: 'antiaudio',
        flag: 'antiaudio',
        label: 'Anti-audio',
        explain: 'ON: apaga audio/ptt de nao-admin',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antisticker',
        name: 'antisticker',
        flag: 'antisticker',
        label: 'Anti-sticker',
        explain: 'ON: apaga figurinha de nao-admin',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antidoc',
        name: 'antidoc',
        flag: 'antidoc',
        label: 'Anti-documento',
        explain: 'ON: apaga PDF/arquivo de nao-admin',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antiloc',
        name: 'antiloc',
        flag: 'antiloc',
        label: 'Anti-local',
        explain: 'ON: apaga localizacao compartilhada',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antictt',
        name: 'antictt',
        flag: 'antictt',
        label: 'Anti-contato',
        explain: 'ON: apaga cartao de contato',
        actionHint: 'delete'
      }
    ]
  },
  {
    section: 'Extra',
    items: [
      {
        id: 'cmd_anticatalogo',
        name: 'anticatalogo',
        flag: 'anticatalogo',
        label: 'Anti-catalogo',
        explain: 'ON: apaga produto/catalogo WA Business',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antistatus',
        name: 'antistatus',
        flag: 'antistatus',
        label: 'Anti-status',
        explain: 'ON: apaga status no grupo (bandeja + texto com statusSourceType 4) e mencao invisivel (mentionedJid sem @ no texto). Combo pay/status 2/90s REMOVE. Ban no 1o proto = Atk status GP',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antipalavrao',
        name: 'antipalavrao',
        flag: 'antipalavrao',
        label: 'Anti-palavrao',
        explain: 'ON: apaga msg com palavrao da lista',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antifake',
        name: 'antifake',
        flag: 'antifake',
        label: 'Anti-fake',
        explain: 'ON: remove quem entra com DDI != 55',
        actionHint: 'kick'
      },
      {
        id: 'cmd_soadm',
        name: 'soadm',
        flag: 'soadm',
        label: 'So-admin',
        explain: 'ON: so admin usa comando neste grupo (default OFF)',
        actionHint: 'ignore'
      },
      {
        id: 'cmd_autodown',
        name: 'autodown',
        flag: 'autodown',
        label: 'Auto-download',
        explain: 'ON: baixa sozinho links YT/TT/IG',
        actionHint: 'download'
      },
      {
        id: 'cmd_antinotas',
        name: 'antinotas',
        flag: 'antinotas',
        label: 'Anti-notas',
        explain: 'ON: apaga nota/evento/pin de comunidade',
        actionHint: 'delete'
      },
      {
        id: 'cmd_bangp',
        name: 'bangp',
        flag: 'bangp',
        label: 'Bangp',
        explain: 'ON: bot IGNORA o grupo por completo',
        actionHint: 'ignore'
      },
      {
        id: 'cmd_autosticker',
        name: 'autosticker',
        flag: 'autosticker',
        label: 'Auto-sticker',
        explain: 'ON: foto vira figurinha automatico',
        actionHint: 'sticker'
      },
      {
        id: 'cmd_antiporno',
        name: 'antiporno',
        flag: 'antiporno',
        label: 'Anti-porno',
        explain: 'ON: foto NSFW → avisa/apaga/ban (API). Video nao. Sem chave ou API morta = no-op',
        actionHint: 'ban'
      },
      {
        id: 'cmd_addgrupo',
        name: 'addgrupo',
        flag: 'grupoDivulgacao',
        label: 'Grupo divulgacao',
        explain: 'ON: marca grupo pra Divulgacao',
        actionHint: 'admin'
      },
      {
        id: 'cmd_bemvindo',
        name: 'bemvindo',
        flag: 'bemvindo',
        label: 'Bem-vindo',
        explain: 'ON: manda o BV que voce montou (texto/foto/fig/audio). Sem frase padrao.',
        actionHint: 'msg'
      },
      {
        id: 'cmd_autoapresentar',
        name: 'autoapresentar',
        flag: 'autoapresentar',
        label: 'Auto-apresentar',
        explain: 'Default OFF. ON so neste grupo: membro novo fala em 90s ou e removido. Nao vaza pra outros grupos',
        actionHint: 'kick'
      },
      {
        id: 'cmd_saiu',
        name: 'saiu',
        flag: 'saiu',
        label: 'Aviso saida',
        explain: 'ON: manda a saida que voce montou. Sem frase padrao.',
        actionHint: 'msg'
      },
      {
        id: 'cmd_autoconvite',
        name: 'autoconvite',
        flag: 'autoconvite',
        label: 'Autoconvite',
        explain: 'ON: alerta pedido de entrada neste grupo. Default OFF',
        actionHint: 'msg'
      },
      {
        id: 'cmd_autoaceitar',
        name: 'autoaceitar',
        flag: 'autoaceitar',
        label: 'Auto-aceitar',
        explain: 'ON: aceita pedido de entrada sozinho neste grupo. Tempo: autoaceitartempo',
        actionHint: 'msg'
      },
      {
        id: 'cmd_x9config',
        name: 'x9config',
        flag: 'x9config',
        label: 'Aviso de config',
        explain: 'ON: avisa no grupo quando mudam nome, desc, foto ou fechamento',
        actionHint: 'msg'
      },
      {
        id: 'cmd_limiteflood',
        name: 'limiteflood',
        flag: 'limiteflood',
        label: 'Limite chars',
        explain: 'ON: apaga msg muito longa (limitec)',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antifloodsticker',
        name: 'antifloodsticker',
        flag: 'antifloodsticker',
        label: 'Flood sticker',
        explain: 'ON: apaga flood de figurinhas (limite N)',
        actionHint: 'delete'
      }
    ]
  },
  {
    section: 'Superficies Baileys',
    items: [
      {
        id: 'cmd_surfpayment',
        name: 'surfpayment',
        flag: 'surfPayment',
        label: 'Anti-pay scam',
        explain: 'ON: apaga tipo pagamento nativo (nao texto da div)',
        actionHint: 'delete'
      },
      {
        id: 'cmd_surfgroupstatus',
        name: 'surfgroupstatus',
        flag: 'surfGroupStatus',
        label: 'Anti-status GP',
        explain: 'ON: apaga status de grupo (proto V1/V2 e cartao). Flood (3 em ~90s) remove. Ban no 1o proto = Atk status GP',
        actionHint: 'delete'
      },
      {
        id: 'cmd_surfforwardspoof',
        name: 'surfforwardspoof',
        flag: 'surfForwardSpoof',
        label: 'Anti-fwd spoof',
        explain: 'ON: apaga encaminhado falso WhatsApp',
        actionHint: 'delete'
      },
      {
        id: 'cmd_surfmetai',
        name: 'surfmetai',
        flag: 'surfMetaAi',
        label: 'Anti-Meta AI',
        explain: 'ON: apaga wrapper Meta AI estranho',
        actionHint: 'delete'
      },
      {
        id: 'cmd_surfbizfake',
        name: 'surfbizfake',
        flag: 'surfBizFake',
        label: 'Anti-biz fake',
        explain: 'ON: apaga business falso 0@',
        actionHint: 'delete'
      },
      {
        id: 'cmd_surfphishad',
        name: 'surfphishad',
        flag: 'surfPhishAd',
        label: 'Anti-phish ad',
        explain: 'ON: apaga anuncio/phishing suspeito',
        actionHint: 'delete'
      },
      {
        id: 'cmd_surfnativeflow',
        name: 'surfnativeflow',
        flag: 'surfNativeFlow',
        label: 'Deny nativeFlow',
        explain: 'ON: bloqueia payment/call/otp flow',
        actionHint: 'delete'
      },
      {
        id: 'cmd_surfviewonce',
        name: 'surfviewonce',
        flag: 'surfViewOnce',
        label: 'Anti-viewOnce',
        explain: 'ON: so LOGA visu unica (nao abre)',
        actionHint: 'ignore'
      },
      {
        id: 'cmd_surfcapmentions',
        name: 'surfcapmentions',
        flag: 'surfCapMentions',
        label: 'Cap mentions',
        explain: 'ON: apaga mencao em massa (>=25); admins isentos',
        actionHint: 'delete'
      },
      {
        id: 'cmd_surfcapmedia',
        name: 'surfcapmedia',
        flag: 'surfCapMedia',
        label: 'Cap midia',
        explain: 'ON: apaga album/pack enorme',
        actionHint: 'delete'
      },
      {
        id: 'cmd_surffakepoll',
        name: 'surffakepoll',
        flag: 'surfFakePoll',
        label: 'Anti-fake poll',
        explain: 'ON: apaga resultado de enquete fake',
        actionHint: 'delete'
      },
      {
        id: 'cmd_surfsettingsflood',
        name: 'surfsettingsflood',
        flag: 'surfSettingsFlood',
        label: 'Sensor settings',
        explain: 'ON: detecta flood promote/remove',
        actionHint: 'ignore'
      }
    ]
  },
  {
    section: 'Anti-admin / X9',
    items: [
      {
        id: 'cmd_antiadmin',
        name: 'antiadmin',
        flag: 'antiadmin',
        label: 'Anti-roubo GP',
        explain: 'OFF default. ON: protege dono registrado e reverte rebaixamento nao autorizado',
        actionHint: 'admin'
      },
      {
        id: 'cmd_antiadminaudit',
        name: 'antiadminaudit',
        flag: 'antiadminAudit',
        label: 'X9 admin',
        explain: 'ON: grava promote/demote/remove no historico',
        actionHint: 'admin'
      },
      {
        id: 'cmd_antiadminrevert',
        name: 'antiadminrevert',
        flag: 'antiadminRevert',
        label: 'Reverter admin',
        explain: 'ON: restaura admin e rebaixa o autor nao confiavel',
        actionHint: 'admin'
      },
      {
        id: 'cmd_antiadminalert',
        name: 'antiadminalert',
        flag: 'antiadminAlert',
        label: 'Alerta admin',
        explain: 'OFF default. ON: avisa ataque (nao no grupo; destino no painel)',
        actionHint: 'admin'
      },
      {
        id: 'cmd_antiadmindest',
        name: 'antiadmindest',
        cycle: 'dest',
        label: 'Destino alerta',
        explain: 'Toque troca: so log / pv dono GP / pv sessao / grupo / ambos (default so log)',
        actionHint: 'admin'
      },
      {
        id: 'cmd_antiadminsilent',
        name: 'antiadminsilent',
        flag: 'antiadminSilent',
        label: 'X9 silencioso',
        explain: 'ON: so log/SQL. Liga = destino silencioso (sem msg)',
        actionHint: 'ignore'
      },
      {
        id: 'cmd_antiadmindetect',
        name: 'antiadmindetect',
        flag: 'antiadminDetect',
        label: 'Detecta rajada',
        explain: 'ON: várias acoes admin na janela = ataque',
        actionHint: 'admin'
      },
      {
        id: 'cmd_antiadminlimite',
        name: 'antiadminlimite',
        cycle: 'threshold',
        label: 'Limite ataque',
        explain: 'Toque troca 3/5/8/10/15 acoes na janela',
        actionHint: 'admin'
      },
      {
        id: 'cmd_antiadminjanela',
        name: 'antiadminjanela',
        cycle: 'window',
        label: 'Janela ataque',
        explain: 'Toque troca 5/10/15/30/60 segundos',
        actionHint: 'admin'
      }
    ]
  },
  {
    section: 'Dono do grupo',
    items: [
      {
        id: 'cmd_donogrupo',
        name: 'donogrupo',
        action: true,
        label: 'Ver dono GP',
        explain: 'Nativo/registrado/confiaveis. Nao e .dono (Sobre)',
        actionHint: 'admin'
      },
      {
        id: 'cmd_listgpowner',
        name: 'listgpowner',
        action: true,
        label: 'Lista confiaveis',
        explain: 'Mesmo status: nativo + registrado + lista',
        actionHint: 'admin'
      },
      {
        id: 'cmd_transferirdono',
        name: 'transferirdono',
        action: true,
        needsTarget: true,
        label: 'Transferir dono',
        explain: 'Responda a pessoa e toque. Venda de grupo',
        actionHint: 'admin'
      },
      {
        id: 'cmd_addgpowner',
        name: 'addgpowner',
        action: true,
        needsTarget: true,
        label: 'Add confiavel',
        explain: 'Responda a pessoa e toque. Nao vira dono principal',
        actionHint: 'admin'
      },
      {
        id: 'cmd_removegpowner',
        name: 'removegpowner',
        action: true,
        needsTarget: true,
        label: 'Tirar confiavel',
        explain: 'Responda a pessoa e toque para sair da lista',
        actionHint: 'admin'
      },
      {
        id: 'cmd_historicoadmin',
        name: 'historicoadmin',
        action: true,
        label: 'Historico admin',
        explain: 'Ultimas alteracoes admin (paginado)',
        actionHint: 'admin'
      }
    ]
  },
  {
    section: 'Anti-ataque',
    items: [
      {
        id: 'cmd_antiatkstatus',
        name: 'antiatkstatus',
        flag: 'antiatkstatus',
        label: 'Atk status GP',
        explain: 'ON: proto groupStatus (V1/V2) OU texto/midia com statusSourceType 4 → APAGA+BAN. Nao e mencao/repost de status',
        actionHint: 'ban'
      },
      {
        id: 'cmd_antiatkinvisivel',
        name: 'antiatkinvisivel',
        flag: 'antiatkinvisivel',
        label: 'Atk invisivel',
        explain: 'ON: viewOnce + payload de crash → APAGA+BAN. Visu unica normal nao remove',
        actionHint: 'ban'
      },
      {
        id: 'cmd_antiatkpagamento',
        name: 'antiatkpagamento',
        flag: 'antiatkpagamento',
        label: 'Atk pagamento',
        explain: 'ON: PIX nativo (visivel, status, viewOnce ou dirigido) → APAGA+BAN',
        actionHint: 'ban'
      },
      {
        id: 'cmd_antiatkcrash',
        name: 'antiatkcrash',
        flag: 'antiatkcrash',
        label: 'Atk crash',
        explain: 'ON: template/crash → APAGA+BAN',
        actionHint: 'ban'
      },
      {
        id: 'cmd_antiatkpoll',
        name: 'antiatkpoll',
        flag: 'antiatkpoll',
        label: 'Atk poll',
        explain: 'ON: enquete maliciosa (payload). Enquete normal nao remove',
        actionHint: 'ban'
      },
      {
        id: 'cmd_antiatkmencao',
        name: 'antiatkmencao',
        flag: 'antiatkmencao',
        label: 'Atk mencao',
        explain: 'ON: mencao massa (>=25) OU mencao invisivel (mentionedJid no proto com menos @ no texto) → APAGA+BAN',
        actionHint: 'ban'
      },
      {
        id: 'cmd_antiatkreacao',
        name: 'antiatkreacao',
        flag: 'antiatkreacao',
        label: 'Atk reacao',
        explain: 'ON: flood emoji → APAGA+BAN',
        actionHint: 'ban'
      },
      {
        id: 'cmd_antiatkedicao',
        name: 'antiatkedicao',
        flag: 'antiatkedicao',
        label: 'Atk edicao',
        explain: 'ON: storm de edit → APAGA+BAN',
        actionHint: 'ban'
      }
    ]
  },
  {
    section: 'Acoes',
    items: [
      { id: 'cmd_bna', name: 'bna', action: true, label: 'BNA', explain: 'Responda msg: apaga tudo + remove', actionHint: 'kick' },
      { id: 'cmd_ban', name: 'ban', action: true, label: 'Ban/Kick', explain: 'Responda ou jid: remove do grupo', actionHint: 'kick' },
      { id: 'cmd_banghost', name: 'banghost', action: true, label: 'Banghost', explain: 'Remove membros sem msgs', actionHint: 'kick' },
      { id: 'cmd_revelar', name: 'revelar', action: true, label: 'Revelar visu', explain: 'Responda visu unica: abre midia', actionHint: 'admin' },
      { id: 'cmd_promover', name: 'promover', action: true, label: 'Promover', explain: 'Da admin (responda/jid)', actionHint: 'admin' },
      { id: 'cmd_rebaixar', name: 'rebaixar', action: true, label: 'Rebaixar', explain: 'Tira admin (responda/jid)', actionHint: 'admin' },
      { id: 'cmd_seradm', name: 'seradm', action: true, label: 'Ser admin', explain: 'Voce vira admin (dono/VIP)', actionHint: 'admin' },
      { id: 'cmd_sermembro', name: 'sermembro', action: true, label: 'Ser membro', explain: 'Voce vira membro (dono/VIP)', actionHint: 'admin' },
      { id: 'cmd_fechargp', name: 'fechargp', action: true, label: 'Fechar grupo', explain: 'So admins podem falar. Com hora: fechargp 22:00', actionHint: 'admin' },
      { id: 'cmd_abrirgp', name: 'abrirgp', action: true, label: 'Abrir grupo', explain: 'Todos podem falar. Com hora: abrirgp 08:00', actionHint: 'admin' },
      { id: 'cmd_cita', name: 'cita', action: true, label: 'Cita', explain: 'Responda qualquer msg: repete o tipo com mencao', actionHint: 'admin' },
      { id: 'cmd_limpar', name: 'limpar', action: true, label: 'Limpar chat', explain: 'Limpeza visual do chat', actionHint: 'admin' },
      { id: 'cmd_listfake', name: 'listfake', action: true, label: 'Lista fake', explain: 'Lista membros DDI != 55', actionHint: 'admin' },
      { id: 'cmd_banfake', name: 'banfake', action: true, label: 'Ban fake', explain: 'Apaga msgs + remove DDI != 55 neste grupo', actionHint: 'kick' },
      { id: 'cmd_banfakeall', name: 'banfakeall', action: true, label: 'Ban fake ALL', explain: 'Mesmo em todos os grupos com fake', actionHint: 'kick' }
    ]
  },
  {
    section: 'Apagar msgs',
    items: [
      {
        id: 'cmd_odelete',
        name: 'odelete',
        ownerFlag: 'odelete',
        label: 'Pre-apagar',
        explain: 'ON: protecoes apagam a msg ofensora (kick segue). Default OFF',
        actionHint: 'delete'
      },
      {
        id: 'cmd_antidelete',
        name: 'antidelete',
        flag: 'antidelete',
        label: 'Anti-delete',
        explain: 'ON: reenvia a msg quando alguem apaga pra todos (ADM e voce tambem). Teste: mande um texto e apague',
        actionHint: 'msg'
      }
    ]
  },
  {
    section: 'PV / Ligacoes',
    items: [
      {
        id: 'cmd_anticall',
        name: 'anticall',
        ownerFlag: 'anticall',
        label: 'Anti-call',
        explain: 'ON: bloqueia quem ligar no bot',
        actionHint: 'ignore'
      },
      {
        id: 'cmd_antipv',
        name: 'antipv',
        ownerFlag: 'antipv',
        label: 'Anti-PV',
        explain: 'ON (padrao): avisa e bloqueia PV. Dono/VIP passam. Liga/desliga os 3',
        actionHint: 'ignore'
      },
      {
        id: 'cmd_antipv2',
        name: 'antipv2',
        ownerFlag: 'antipv2',
        label: 'Anti-PV2',
        explain: 'ON (padrao): avisa 1x no PV e bloqueia',
        actionHint: 'ignore'
      },
      {
        id: 'cmd_antipv3',
        name: 'antipv3',
        ownerFlag: 'antipv3',
        label: 'Anti-PV3',
        explain: 'ON (padrao): ignora PV — so dono/VIP passam',
        actionHint: 'ignore'
      }
    ]
  },
  {
    section: 'Listas',
    items: [
      { id: 'cmd_mutelist', name: 'mutelist', action: true, label: 'Lista mutados', explain: 'Quem esta mute (msgs apagadas)', actionHint: 'admin' },
      { id: 'cmd_listban', name: 'listban', action: true, label: 'Lista negra', explain: 'Global: ban ao falar/entrar em qualquer grupo', actionHint: 'kick' },
      { id: 'cmd_listadv', name: 'listadv', action: true, label: 'Advertencias', explain: 'Contagem de adv do grupo', actionHint: 'admin' },
      { id: 'cmd_listabranca', name: 'listabranca', action: true, label: 'Lista branca', explain: 'Isentos do anti-link', actionHint: 'admin' },
      { id: 'cmd_gpseguranca', name: 'gpseguranca', action: true, label: 'Painel de novo', explain: 'Reabre este painel', actionHint: 'admin' },
      { id: 'cmd_protecoesativas', name: 'protecoesativas', action: true, label: 'O que esta ON', explain: 'Lista o que APAGA/BAN agora', actionHint: 'admin' }
    ]
  }
];

function listTitle(label, state) {
  const base = stripAccents(String(label || ''))
    .replace(/[^\w\s.\-/]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const st = state ? ` - ${state}` : '';
  const full = `${base}${st}`;
  return [...full].slice(0, 24).join('');
}

function listDesc(text) {
  const s = stripAccents(String(text || ''))
    .replace(/[^\w\s.\-/:@|+]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, 72).join('');
}

function flagState(flags, flag) {
  if (!flag) return null;
  if (flag === 'antifloodsticker') return Number(flags.antifloodsticker) > 0 ? 'ON' : 'OFF';
  return flags[flag] ? 'ON' : 'OFF';
}

function antiAdminCycleWord(kind, groupId, telegramUserId) {
  let rec = null;
  try {
    rec = require('./groupTheftStore').peek(groupId, telegramUserId);
  } catch (_) { /* ignore */ }
  const logic = require('./groupTheftLogic');
  let flags = {};
  try {
    flags = groupId ? getGroupSecurity(groupId, telegramUserId) : {};
  } catch (_) { /* ignore */ }
  const f = require('./groupTheftGuard').flagsFromGroup(flags, rec);
  if (kind === 'dest') return logic.destLabelShort(f.dest);
  if (kind === 'threshold') return String(f.threshold);
  if (kind === 'window') return `${Math.max(1, Math.round(Number(f.windowMs) / 1000))}s`;
  return null;
}

function resolveItemState(it, flags, ownerFlags, groupId, telegramUserId) {
  if (it.info) return 'ON';
  if (it.cycle) return antiAdminCycleWord(it.cycle, groupId, telegramUserId);
  if (it.action) return null;
  if (it.name === 'modenable') return 'OFF';
  if (it.name === 'moddisable') return 'ON';
  if (it.flag) return flagState(flags, it.flag) || 'OFF';
  if (it.ownerFlag === 'antipv') {
    return (ownerFlags.antipv || ownerFlags.antipv2 || ownerFlags.antipv3) ? 'ON' : 'OFF';
  }
  if (it.ownerFlag) return ownerFlags[it.ownerFlag] ? 'ON' : 'OFF';
  return null;
}

/** Protecoes ON que apagam/banem/removem — pra dono ver o que esta agindo */
function buildActiveDangerSummary(groupId, telegramUserId) {
  if (!groupId) return 'Abra no grupo pra ver o que esta ON.';
  const flags = getGroupSecurity(groupId, telegramUserId);
  const floodOn = isModerationActive(groupId, telegramUserId);
  const lines = ['ATIVO AGORA (pode apagar/banir):'];
  let n = 0;

  if (floodOn) {
    lines.push('• Anti-flood — flood → apaga+ban');
    n++;
  }

  const ownerFlags = getOwnerSecurity(telegramUserId);
  if (ownerFlags.odelete) {
    lines.push('• Pre-apagar — protecoes apagam a msg ofensora');
    n++;
  }

  for (const sec of SECURITY_ITEMS) {
    for (const it of sec.items) {
      if (!it.flag) continue;
      if (!flags[it.flag]) continue;
      if (!['delete', 'ban', 'kick'].includes(it.actionHint)) continue;
      if (it.flag === 'antidelete') continue;
      lines.push(`• ${it.label} — ${it.explain.replace(/^ON:\s*/i, '')}`);
      n++;
    }
  }

  try {
    const lists = getGroupLists(groupId, telegramUserId) || {};
    const muteN = Array.isArray(lists.mutes) ? lists.mutes.length : 0;
    const blackN = Array.isArray(lists.blacklist) ? lists.blacklist.length : 0;
    if (muteN > 0) {
      lines.push(`• Mute — ${muteN} pessoa(s): msgs delas sao APAGADAS`);
      n++;
    }
    if (blackN > 0) {
      lines.push(`• Lista negra — ${blackN} pessoa(s): falar → ban`);
      n++;
    }
  } catch (_) { /* ignore */ }

  if (!n) {
    return applyLivePrefix([
      'Nenhuma protecao de APAGAR/BAN ligada neste grupo.',
      'Se msgs somem, veja mute/lista negra ou outro bot.',
      'Painel: {p}gpseguranca | Resumo: {p}protecoesativas'
    ].join('\n'), displayPrefix(telegramUserId));
  }

  lines.push('');
  lines.push('Admins e dono em geral sao isentos.');
  lines.push('Desligar: {p}gpseguranca (toque OFF) ou {p}NOME off');
  return applyLivePrefix(lines.join('\n'), displayPrefix(telegramUserId));
}

const WA_ROW_ID_MAX = 24;

function protsetRowId(name, want) {
  const n = String(name || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const w = String(want) === '0' ? '0' : '1';
  const full = `protset_${n}_${w}`;
  if (full.length <= WA_ROW_ID_MAX) return full;
  return `ps_${n}_${w}`;
}

function findSecurityItem(nameOrId) {
  const raw = String(nameOrId || '').trim();
  const key = raw.replace(/^cmd_/, '');
  const keyLower = key.toLowerCase();
  for (const sec of SECURITY_ITEMS) {
    for (const it of sec.items) {
      if (
        it.id === raw ||
        it.id === key ||
        it.id === `cmd_${key}` ||
        it.id === `info_${key.replace(/^info_/, '')}` ||
        it.name === key ||
        String(it.name || '').toLowerCase() === keyLower ||
        (it.flag && (it.flag === key || String(it.flag).toLowerCase() === keyLower)) ||
        (it.ownerFlag && (it.ownerFlag === key || String(it.ownerFlag).toLowerCase() === keyLower))
      ) {
        return { ...it, section: sec.section };
      }
    }
  }
  return null;
}

function buildItemHelpText(it, prefix = '.') {
  const p = prefix || '.';
  if (!it) return 'Protecao nao encontrada.';
  const acaoMap = {
    delete: 'APAGA a mensagem',
    ban: 'APAGA a mensagem e BAN/REMOVE o autor',
    kick: 'REMOVE o membro do grupo',
    ignore: 'Ignora / nao responde (nao apaga necessariamente)',
    msg: 'Envia mensagem automatica',
    download: 'Baixa midia automaticamente',
    sticker: 'Converte em figurinha',
    gate: 'Bloqueio interno do bot (sempre ligado)',
    admin: 'Ferramenta de admin (nao e toggle automatico)'
  };
  const lines = [
    String(it.label || it.name).toUpperCase(),
    `Secao: ${it.section || '?'}`,
    `O que faz: ${it.explain}`,
    `Acao: ${acaoMap[it.actionHint] || it.actionHint || '?'}`,
    it.info ? 'Estado: sempre ON (nao desliga)' : '',
    it.flag ? `Flag: ${it.flag} | Cmd: ${p}${it.name} on|off` : '',
    it.ownerFlag ? `Sessao: ${it.ownerFlag} | Cmd: ${p}${it.name} on|off` : '',
    it.cycle === 'dest'
      ? `Toque no painel troca o destino. grupo=chat | pv=dono GP | ambos | dono=pv da sessao | silencioso=so log. Cmd: ${p}antiadmindest grupo|pv|ambos|dono|silencioso`
      : '',
    it.cycle === 'threshold'
      ? `Toque troca 3/5/8/10/15. Cmd: ${p}antiadminlimite <n>`
      : '',
    it.cycle === 'window'
      ? `Toque troca 5/10/15/30/60s. Cmd: ${p}antiadminjanela <seg>`
      : '',
    it.action ? `Uso: ${p}${it.name}${it.needsTarget ? ' @user (ou responda a msg)' : ''}` : '',
    '',
    'Quem normalmente NAO e afetado: admins do grupo, dono, lista branca (anti-link).',
    `Ver tudo ON: ${p}protecoesativas | Painel: ${p}gpseguranca`
  ].filter(Boolean);
  return lines.join('\n');
}

function buildSecurityListSections(prefix, groupId, telegramUserId) {
  const p = prefix || '.';
  const flags = groupId ? getGroupSecurity(groupId, telegramUserId) : {};
  const ownerFlags = getOwnerSecurity(telegramUserId);
  const floodOn = groupId ? isModerationActive(groupId, telegramUserId) : false;

  const sections = [];
  for (const sec of SECURITY_ITEMS) {
    const rows = [];
    for (const it of sec.items) {
      if (it.name === 'modenable' && floodOn) continue;
      if (it.name === 'moddisable' && !floodOn) continue;
      if (it.name === 'modstatus') continue;
      if (it.name === 'antiporno') {
        try {
          const { isAntipornoFeatureOn } = require('./moderation');
          if (typeof isAntipornoFeatureOn === 'function' && !isAntipornoFeatureOn()) continue;
        } catch (_) { /* keep */ }
      }

      const stateWord = it.name === 'antiporno'
        ? (antipornoStateWord(flags) || resolveItemState(it, flags, ownerFlags, groupId, telegramUserId))
        : resolveItemState(it, flags, ownerFlags, groupId, telegramUserId);
      const label = (it.name === 'modenable' || it.name === 'moddisable')
        ? 'Anti-flood'
        : itemUiLabel(it);

      const title = listTitle(label, stateWord);
      let desc;
      if (it.info) {
        desc = listDesc(`SEMPRE ON | ${itemUiExplain(it)}`);
      } else if (it.cycle) {
        desc = listDesc(`${stateWord || '-'} | ${itemUiExplain(it)}`);
      } else if (it.action) {
        desc = listDesc(`${itemUiExplain(it)}`);
      } else {
        desc = listDesc(`${stateWord || 'OFF'} | ${itemUiExplain(it)}`);
      }
      // Clique do painel GRAVA o valor oposto (on/off), nao inverte.
      // WA manda o clique 2x: inverter desfazia o toggle.
      // Lista classica capava rowId em 24 chars — prefixo curto se passar.
      let rowId = it.id;
      if (!it.info && !it.action && !it.cycle && (it.flag || it.ownerFlag || it.name === 'modenable' || it.name === 'moddisable')) {
        const onNow = String(stateWord || '').toUpperCase() === 'ON';
        const want = onNow ? '0' : '1';
        if (it.name === 'modenable' || it.name === 'moddisable') {
          rowId = onNow ? 'cmd_moddisable' : 'cmd_modenable';
        } else {
          rowId = protsetRowId(it.name, want);
        }
      }
      rows.push({ title, description: desc, id: rowId });
    }
    if (!rows.length) continue;
    for (let i = 0; i < rows.length; i += 10) {
      const chunk = rows.slice(i, i + 10);
      const part = rows.length > 10 ? ` ${Math.floor(i / 10) + 1}` : '';
      sections.push({
        title: listTitle(`${sec.section}${part}`),
        rows: chunk
      });
    }
  }
  sections.push({
    title: listTitle('Navegacao'),
    rows: [
      {
        title: listTitle('O que esta ON'),
        description: listDesc('Lista o que apaga/ban agora'),
        id: 'cmd_protecoesativas'
      },
      {
        title: listTitle(`${p}menu`),
        description: listDesc('Voltar ao menu'),
        id: 'cmd_menu'
      }
    ]
  });
  return sections;
}

function buildSecurityTextMenu(prefix, groupId, telegramUserId, { isGroup = true } = {}) {
  const p = prefix || '.';
  const lines = [
    'SEGURANCA DO GRUPO',
    `Prefixo: ${p}`,
    'Toque no painel = liga/desliga (destino/limite/janela troca o valor).',
    'Anti-roubo: secoes Anti-admin / X9 e Dono do grupo.',
    'Admins em geral nao sao punidos.',
    ''
  ];

  const flags = (isGroup && groupId) ? getGroupSecurity(groupId, telegramUserId) : {};
  const ownerFlags = getOwnerSecurity(telegramUserId);
  const floodOn = (isGroup && groupId) ? isModerationActive(groupId, telegramUserId) : false;

  if (isGroup && groupId) {
    lines.push(buildActiveDangerSummary(groupId, telegramUserId));
    lines.push('');
    lines.push(formatGroupSecurityStatus(groupId, telegramUserId));
    lines.push('');
  } else {
    lines.push(applyLivePrefix('Entre no grupo e rode {p}gpseguranca la', p));
    lines.push('');
  }

  for (const sec of SECURITY_ITEMS) {
    lines.push(String(sec.section || '').toUpperCase());
    for (const it of sec.items) {
      if (it.name === 'modenable' && floodOn) continue;
      if (it.name === 'moddisable' && !floodOn) continue;
      if (it.name === 'modstatus') continue;

      const state = it.name === 'antiporno'
        ? (antipornoStateWord(flags) || resolveItemState(it, flags, ownerFlags, groupId, telegramUserId))
        : resolveItemState(it, flags, ownerFlags, groupId, telegramUserId);
      const label = (it.name === 'modenable' || it.name === 'moddisable') ? 'Anti-flood' : itemUiLabel(it);
      if (it.info) {
        lines.push(`${label} [ON] — ${itemUiExplain(it)}`);
      } else if (it.cycle) {
        lines.push(`${label} [${state || '-'}] — ${itemUiExplain(it)} (${p}${it.name})`);
      } else if (it.action) {
        lines.push(`${p}${it.name} — ${itemUiExplain(it)}`);
      } else if (state) {
        lines.push(`${label} [${state}] — ${itemUiExplain(it)} (${p}${it.name} on|off)`);
      } else {
        lines.push(`${p}${it.name} — ${itemUiExplain(it)}`);
      }
    }
    lines.push('');
  }

  lines.push('MEMBROS (responda a msg ou informe jid)');
  lines.push(`${p}mute / ${p}desmute — silencia (apaga msgs dele)`);
  lines.push(`${p}banall / ${p}listanegra — ban global + lista negra`);
  lines.push(`${p}tirardalista / ${p}unbanall — tira da lista negra`);
  lines.push(`${p}adv / ${p}rmadv — advertencia`);
  lines.push(`${p}bna — apaga msgs + remove`);
  lines.push('');
  lines.push(`Resumo do que esta ON: ${p}protecoesativas`);
  lines.push(`Voltar: ${p}menu`);

  return lines.join('\n');
}

function buildSecurityIntro(prefix, groupId, telegramUserId, isGroup, { skipStatus = false } = {}) {
  const p = prefix || '.';
  const lines = [
    'SEGURANCA',
    `Prefixo: ${p}`,
    'Cada item mostra ON/OFF (ou o valor atual) + o que faz.',
    'Toque liga/desliga. Destino/limite/janela: toque troca o valor.',
    'Anti-roubo: secoes Anti-admin / X9 e Dono do grupo.',
    ''
  ];
  if (!skipStatus && isGroup && groupId) {
    const floodOn = isModerationActive(groupId, telegramUserId);
    lines.push(`Anti-flood: ${floodOn ? 'ON (apaga+ban flood)' : 'OFF'}`);
    const danger = buildActiveDangerSummary(groupId, telegramUserId);
    // so as primeiras linhas do resumo no intro (evita corpo gigante)
    lines.push(...danger.split('\n').slice(0, 8));
  } else if (!(isGroup && groupId)) {
    lines.push('Abra este menu DENTRO do grupo');
  }
  lines.push('');
  lines.push(`Lista completa ON: ${p}protecoesativas`);
  lines.push(`Voltar: ${p}menu`);
  return lines.join('\n');
}

async function sendSecurityPanel(conn, {
  chatId,
  quoted,
  telegramUserId,
  sessionId,
  isGroup = false,
  groupId = null,
  skipIntroStatus = false
} = {}) {
  const { sendInteractiveList, sendButtonlessFallback } = require('../helpers');
  const sid = sessionId || conn?._sessionId;
  const prefix = displayPrefix(telegramUserId, {
    conn,
    platform: conn?._isTelegramShim ? 'telegram' : 'whatsapp'
  });
  const gid = groupId || (isGroup ? chatId : null);
  if (gid && telegramUserId) {
    try {
      await require('./groupTheftStore').load(gid, telegramUserId);
    } catch (_) { /* painel ainda abre */ }
  }

  const buttonsOn = areButtonsOn(sid, telegramUserId) && !conn?._isTelegramShim;
  const body = buildSecurityTextMenu(prefix, gid, telegramUserId, { isGroup: !!gid });

  if (!buttonsOn) {
    return sendButtonlessFallback(conn, chatId, {
      text: body,
      quoted,
      telegramUserId,
      sessionId: sid
    });
  }

  const intro = buildSecurityIntro(prefix, gid, telegramUserId, !!gid, {
    skipStatus: !!skipIntroStatus
  });
  const sections = buildSecurityListSections(prefix, gid, telegramUserId);
  if (!sections.length) {
    return sendButtonlessFallback(conn, chatId, {
      text: body,
      quoted,
      telegramUserId,
      sessionId: sid
    });
  }

  try {
    const { rememberPanelOperator } = require('./interactiveClickGuard');
    const sender = quoted?.key?.participant || quoted?.key?.remoteJid || '';
    if (sender) rememberPanelOperator(conn, chatId, sender);
  } catch (_) { /* clique do painel ainda tenta stanzaId */ }

  return sendInteractiveList(
    conn,
    chatId,
    intro,
    sections,
    'Hanork Seguranca',
    quoted,
    'menu.jpg',
    telegramUserId,
    sid
  );
}

module.exports = {
  SECURITY_ITEMS,
  buildSecurityTextMenu,
  buildSecurityListSections,
  buildSecurityIntro,
  buildActiveDangerSummary,
  findSecurityItem,
  buildItemHelpText,
  listTitle,
  sendSecurityPanel,
  protsetRowId
};
