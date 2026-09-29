// core/router/registeredCommands.js
// Auto-migra TODOS os comandos de commands/ para o Universal Router
// Hierarquia: platform_admin > owner > (vip | adm; vip+admin nativo deste grupo usa adm) > user
// Default seguro = owner. Moderacao de UM grupo = adm (nao dono do bot).

const { registerCommand, listRegisteredCommands, getCommandConfig } = require('./universalRouter');
const { migrateCommand } = require('./commandAdapter');
const { listCommands } = require('../../commands/index');

/** Comandos so WhatsApp (grupo / baileys) — config nuke pode no TG tambem */
const WA_ONLY = new Set([
    'nuke', 'nukeid', 'nukeas',
    'creategroup', 'add', 'remove', 'promote', 'demote', 'leave', 'sairgp', 'sairdogp', 'sairgps', 'entrargp', 'entrargrupo', 'joingp', 'groupinfo', 'groupid',
    'groupinvite', 'linkgp', 'linkgrupo', 'grouplink', 'revokeinvite', 'groupname', 'groupdesc', 'setgroupname', 'setgroupdesc',
    'pair', 'paircancel', 'pairstatus',
    'createchannel', 'deletechannel', 'followchannel', 'unfollowchannel',
    'channelpost', 'channelsubscribers',
    'channelparceiros', 'channelparceiroadd', 'channelparceiroedit', 'channelparceirooff',
    'parceiros', 'listparceiros', 'addparceiro', 'editparceiro', 'offparceiro',
    'figurinha', 'figcanal', 'figurinhas', 'figurinhas2', 'filtroigdark', 'filtroigdark',
    'stickerinfo', 'figban', 'figunban', 'figbanall', 'figbanlist',
    't', 'sett', 'meut', 'editt',
    'div', 'dk', 'entrardk', 'menu_dk', 'dkmenu', 'menudk', 'msgdk', 'dklink', 'fotodk', 'videodk', 'apagardk', 'qtddk',
    'dkpay', 'msgdkpay', 'dkmidia', 'rmfotodk', 'listfotodk',
    'divpay', 'divmark', 'divstatus', 'divcf', 'divfull', 'divconfirmar',
    'divauto', 'divconfigauto', 'divconfigautomodos', 'divcriagrupo',
    'divslots', 'divslot', 'divulgar',
    'divautocriar', 'divconfigmingrupos', 'divconfigcriagrupo',
    'bugchat', 'crashios', 'crashgp', 'travazap',
    'modenable', 'moddisable', 'modstatus', 'gpseguranca',
    'protecoes', 'protecoesativas', 'protecoeshelp', 'oquestaon', 'protecoeson',
    'antilink', 'antilinkhard', 'antifake', 'soadm', 'onlyadm', 'soadmin',
    'bna', 'band', 'deletar', 'deleta', 'apaga', 'apagar', 'ban', 'kick', 'banir', 'promover', 'rebaixar',
    'seradm', 'sermembro', 'viraradm', 'virarmembro',
    'fechargp', 'abrirgp', 'fechargrupo', 'abrirgrupo', 'gpfechar', 'gpabrir', 'groupclose', 'groupopen',
    'cita', 'hidetag', 'totag', 'tagall', 'marcar', 'limpar', 'listfake', 'banfake', 'banfakeall', 'banghost',
    'antilinkgp', 'antilinkeasy', 'antiimg', 'antivideo', 'antiaudio', 'antisticker',
    'antidoc', 'antiloc', 'antictt', 'antichannel', 'antipayment', 'anticatalogo',
    'antistatus', 'antipalavrao', 'bemvindo', 'saiu', 'autodown', 'antinotas',
    'autoapresentar', 'autoapres',
    'bangp', 'unbangp', 'autosticker', 'antiporno', 'antiataque', 'protecaototal', 'limiteflood', 'mute', 'desmute',
    'tabela', 'settabela', 'nota', 'sorteio', 'atividade', 'inativos', 'horariogrupo',
    'fotobv', 'figbv', 'audiobv', 'fotosaida', 'figsaida', 'audiosaida', 'bvstatus',
    'ausente', 'boti', 'boton', 'botoff', 'botion', 'botioof', 'botof', 'botoof', 'botoofdf', 'ligabot', 'desligabot',
    'figquote', 'tomp3', 'audiofx', 'tts', 'reagircanal',
    'listanegra', 'adv', 'revelar', 'revelarvisu', 'abrirvisu', 'crl', 'oloco', 'taquipariu', 'caralho', 'porra', 'krl', 'ihal',
    'banall', 'unbanall', 'tirardalista', 'listban', 'listanegrag',
    'autoconvite', 'aceitar', 'recusar', 'aceitarall', 'recusarall', 'pedidosentrada',
    'autoaceitar', 'autoaceitartempo', 'attacc', 'setattacc', 'x9config', 'bantmp', 'fecharas', 'convidar',
    'bloquearcmd', 'desbloquearcmd', 'listablockcmd', 'bloquearcomando', 'desbloquearcomando', 'comandosblock',
    'desligarcmd', 'ligarcmd',
    'msgantipv',
    'grupoentrar', 'gruposair',
    'antiadmin', 'antiadminaudit', 'antiadminrevert', 'antiadminalert', 'antiadmindest', 'antiadminsilent',
    'antiadmindetect', 'antiadminlimite', 'antiadminjanela', 'antiroubo',
    'transferirdono', 'addgpowner', 'removegpowner', 'adddonogp', 'removedonogp',
    'add_perm', 'add_dono_gp',
    'odelete', 'preapagar', 'predelete', 'antidelete', 'antidel',
    'surfpayment', 'surfgroupstatus', 'surfforwardspoof', 'surfmetai', 'surfbizfake',
    'surfphishad', 'surfnativeflow', 'surfviewonce', 'surfcapmentions', 'surfcapmedia',
    'surffakepoll', 'surfsettingsflood'
]);

/**
 * USER — cotidiano, sem alterar sistema / sem PII / sem broadcast
 */
const USER_OK = new Set([
    // Geral / menus
    'menu', 'ping', 'stats', 'comandos', 'tutorial', 'start', 'novidades', 'changelog', 'oquemudou',
    'status', 'meujid', 'help', 'ajuda',
    'menu_geral', 'menu_downloads', 'menu_webintelligence', 'menu_figurinhas',
    'menu_messages', 'menu_mensagens', 'menu_tools', 'menu_webia', 'menu_git',
    'menu_enquetes', 'menu_perfil',
    'menu_grupo_mod', 'menu_grupo_entrada', 'menu_grupo_config', 'menu_diversao', 'menu_utilidades',
    'menu_ia', 'menu_hanorkapi',
    'hanorkapi', 'hanorkinfo',
    // Downloads (+ aliases seguros)
    'download', 'downloads', 'play', 'ytmp3', 'mp3', 'yt', 'ytaudio', 'playaudio',
    'playvideo', 'playvid', 'ytmp4', 'ytv', 'ytvideo',
    'tiktok', 'tt', 'tk', 'tkdl', 'instagram', 'ig', 'insta', 'igdl', 'igvideo', 'instagram2', 'igpost',
    'facebook', 'fb', 'spotify', 'spotifu', 'spotfy', 'spottify', 'spotifyy', 'soundcloud', 'sc', 'scloud',
    'mediafire', 'mf', 'twitter', 'twtdl', 'x', 'kwai', 'threads', 'thdl', 'capcut',
    'pinterest', 'pindl', 'pinmp4', 'pinterestmp4', 'ytsearch',
    // Figurinhas / midia leve
    's', 'f', 'sticker', 'stiker', 'fig', 'st', 'stk',
    'figquote', 'tomp3', 'audiofx', 'tts',
    'tabela', 'nota', 'prefixo', 'prefix',
    't', 'sett', 'meut', 'editt',
    'fsticker', 'fstiker', 'toimg', 'toimage', 'filtroigdark', 'filtroigdark',
    'roubar', 'take', 'attp', 'stickerpack', 'avatarsticker',
    'ususticker', 'us',
    // Mensagens / enquetes (efeito so no chat do pedido)
    'text', 'image', 'album', 'react', 'poll', 'pollresult', 'list',
    // Web basica
    'google', 'pesquisar', 'web', 'search', 'googlelista',
    // Info leitura
    'groupinfo', 'groupid', 'channelid', 'channelinfo',
    // Cancela step proprio (nao e exploit)
    'cancelar',
    // Entrada de membros (gate real = admin do grupo no execute)
    'autoconvite', 'aceitar', 'recusar', 'aceitarall', 'recusarall', 'pedidosentrada',
    // Evolucao usuario
    'nivel', 'evolucao', 'evo', 'desbloqueios', 'rank', 'ranking', 'evoleader',
    // Zone — user
    'ephoto', 'logo', 'logos', 'flux', 'tourl',
    'cotacao', 'dolar', 'encurta', 'encurtar', 'qr', 'qrcode', 'lerqr',
    'calc', 'calcular', 'walink', 'wame', 'fdc', 'fatos', 'placar',
    'forca', 'ppt', 'jokenpo', 'dado', 'roleta', 'minado',
    'plantar', 'regar', 'colher',
    'casar', 'namoro', 'beijar', 'flerte',
    'eununca', 'vdb', 'vdd', 'verdade', 'piada',
    'sobre', 'dono', 'comprar', 'planos', 'preco', 'ownerinfo',
    'minhaconta', 'meuplano', 'meupagamento', 'suporte',
    'vincular', 'vincularconta', 'baixarbot', 'meubot', 'afiliado', 'indicar'
]);

/**
 * VIP — valor agregado / custo maior, sem config do bot
 */
const VIP_OK = new Set([
    'deepsearch', 'analisar', 'ganalisar', 'relatorio',
    'gitsearch', 'github', 'repos', 'repo',
    // Figurinhas → canal (posta no newsletter do dono)
    'figurinha', 'figcanal', 'figurinhas', 'figurinhas2',
    // IA unificada + aliases (nao dono)
    'hanork',
    'statuspost', 'groupstatus', 'channelstatus', 'closefriends',
    'menu_status',
    'paypost', 'pagamentopost', 'postpay',
    // Consultas — dono + VIP + quem pagou o plano/bot
    'menu_consultas', 'consultas', 'consulta', 'cep', 'cnpj', 'ip',
    'ttkstalk', 'tiktokstalk', 'infoff', 'ffinfo',
    'cpf', 'cpfbasico', 'cpfcompleto', 'cpf2', 'nome', 'placa', 'telefone', 'tel',
    'fone', 'cpf3',
    'cpffull', 'buscanome', 'celular', 'placafull', 'cnpjfull', 'donoemail',
    'parentes', 'score', 'cnh', 'consultapix', 'fotos', 'fotocnh',
    // Divulgacao — quem pagou (VIP/plano/bot) usa no WhatsApp da sessao
    'div', 'divbotao', 'divctaenvio', 'divcta2', 'divpay', 'divmark', 'divstatus', 'divstatus2', 'divcf', 'divfull', 'divconfirmar',
    'divenviar', 'editarcta2', 'editarstatus2', 'horariocta', 'horariocta2',
    'divstop', 'parardiv', 'divparar', 'stopdiv',
    'msgdivul', 'msgdivulpay', 'msgdivulstatus', 'fotodivul', 'fotodivulcta', 'fotodivulstatus', 'videodivulstatus', 'ctafoto', 'divctafoto', 'fotodivcta', 'fotocta', 'divfotocta', 'apagafotodivulcta',
    'videodivul', 'gifdivul', 'audiodivul', 'documentodivul',
    'apagardivul', 'previewdivul', 'divmenu', 'divhelp', 'divajuda', 'divcta',
    'divslots', 'divslot', 'divulgar',
    'div_cta_wizard', 'div_cta_texto', 'div_cta_label', 'div_cta_url', 'div_cta_label2', 'div_cta_url2', 'div_cta_btn2_rm',
    'addgrupo', 'removergrupo', 'divgrupos',
    'divconfig', 'divconfigmodo', 'divconfigstatus', 'divconfigqtd',
    'divconfigdelaymsg', 'divconfigdelaygrupo', 'divconfigordem', 'divconfigrepetir',
    'divconfigmidia', 'div_config_texto', 'div_config_pay', 'div_config_midia', 'div_config_status_texto',
    'div_ver_grupos', 'div_limpar_grupos', 'div_modo_todos', 'div_modo_especificos',
    'divauto', 'divconfigauto', 'divconfigautomodos', 'divcriagrupo',
    'divautocriar', 'divconfigmingrupos', 'divconfigcriagrupo',
    'bandeja', 'postbandeja',
    // Zone — custo de API
    'grok', 'grokia', 'nano', 'nanobanana', 'edits', 'editarimg',
    'upscale', 'shazam', 'likeff', 'curtirff',
    // Pre-apagar / anti-delete (Duda) — dono + VIP + IDM
    'odelete', 'preapagar', 'predelete', 'antidelete', 'antidel',
    // Anti-roubo / dono GP — toggle: dono sessao, dono nativo/registrado ou VIP
    'antiadmin', 'antiadminaudit', 'antiadminrevert', 'antiadminalert', 'antiadmindest', 'antiadminsilent',
    'antiadmindetect', 'antiadminlimite', 'antiadminjanela', 'antiroubo',
    'donogrupo', 'listgpowner', 'historicoadmin', 'gpowner', 'antiroubodiag', 'antiroubostatus',
    'seradm', 'sermembro', 'viraradm', 'virarmembro',
    // .sitecheck — varredura tecnica de site. VIP e liberado (e mais leve que
    // o .osint, que e owner: aqui so ha superficie publica do site, sem dado
    // de pessoa/vazamento). ADM DE GRUPO NAO ENTRA de proposito: `adm` no
    // permissionEngine significa "moderacao de UM grupo"; dar recon externo a
    // admin de grupo permitiria varredura de alvo por terceiros.
    'sitecheck', 'checarsite'
]);

/**
 * Exigem dono (owner da sessão) — nunca afrouxar sensiveis
 */
const OWNER_ONLY = new Set([
    // Nuke
    'nuke', 'nukeid', 'nukeas', 'nukename', 'nukedesc', 'nukemsg', 'nukeimg', 'nukeconfig', 'nukereset',
    // Sessao / admin
    'clearsession', 'repairsession', 'badmac', 'rr', 'clearlogs', 'clearall', 'clearuser',
    'addai', 'logs', 'backupsession', 'restoresession', 'exportsession', 'importsession',
    // Host Raikken / Pterodactyl
    'menu_exploits', 'menu_travas', 'menu_host', 'menu_raikken',
    'host', 'hostmenu', 'raikken', 'hoststatus', 'hostinfo', 'hostres',
    'hoststart', 'hoststop', 'hostrestart', 'hostkill',
    'hostcmd', 'hostconsole', 'hostclog',
    'hostls', 'hostcat', 'hostread', 'hostwrite', 'hostmkdir', 'hostrm',
    'hostrename', 'hostcp', 'hostzip', 'hostunzip', 'hostpull', 'hostdl',
    'hostbackups', 'hostbackup', 'hostbackupdel', 'hostbackuprestore',
    'hostnet', 'hoststartup', 'hostsetvar', 'hostactivity',
    'hostdb', 'hostusers', 'hostschedules',
    'hostaccount', 'hostservers', 'hostapikeys',
    'hostrenameserver', 'hostreinstall',
    'osint',
    'health', 'pedidos',
    'grupos', 'grupolista', 'grupoconfig', 'grupoentrar', 'gruposair',
    // Config botoes / forward
    'buttonson', 'buttonsoff', 'togglebuttons', 'buttonmode',
        'setprefix', 'prefixhint', 'dicaprefixo', 'avisoprefixo', 'addowner', 'removeowner', 'listowners',
        'ia', 'ai', 'iaon', 'iaoff', 'iais', 'artificial',
        'addvip', 'removevip', 'tirarvip', 'remvip', 'delvip', 'rmvip', 'listvips',
        'vipall', 'addvipall', 'removervipall', 'rmvipall', 'delvipall',
        'adddono', 'removedono', 'deldono',
    'addblacklist', 'removeblacklist', 'listblacklist',
    // Seguranca grupo
    'modenable', 'moddisable', 'modstatus', 'modlist', 'modhelp', 'gpseguranca', 'antifloodhelp',
    'protecoes', 'protecoesativas', 'protecoeshelp', 'oquestaon', 'protecoeson',
    'antilink', 'antilinkhard', 'antilinkgp', 'antilinkeasy', 'antilingp',
    'antifake', 'soadm', 'onlyadm', 'soadmin',
    'antiimg', 'antivideo', 'antiaudio', 'antisticker', 'antidoc', 'antiloc', 'antictt',
    'antichannel', 'antichannell', 'antipayment', 'anticatalogo', 'antistatus', 'antipalavrao',
    'bemvindo', 'saiu', 'welcome', 'bv', 'legendabv', 'legendasaiu',
    'autoapresentar', 'autoapres',
    'autodown', 'autodownload', 'antinotas', 'bangp', 'unbangp', 'autosticker', 'antiporno', 'antiporn',
    'boti', 'boton', 'botoff', 'botion', 'botioof', 'botof', 'botoof', 'botoofdf', 'ligabot', 'desligabot', 'reagircanal',
    'antiataque', 'protecaototal', 'antiattack', 'presetprotecao', 'presetseg',
    'limiteflood', 'limitec', 'antifloodsticker',
    'surfpayment', 'surfgroupstatus', 'surfforwardspoof', 'surfmetai', 'surfbizfake',
    'surfphishad', 'surfnativeflow', 'surfviewonce', 'surfcapmentions', 'surfcapmedia',
    'surffakepoll', 'surfsettingsflood',
    'mute', 'desmute', 'mutelist', 'listanegra', 'tirardalista', 'listban',
    'banall', 'unbanall', 'listanegrag',
    'stickerinfo', 'figban', 'figunban', 'figbanall', 'figbanlist',
    'adv', 'rmadv', 'listadv', 'addlistabranca', 'rmlistabranca', 'listabranca',
    'bna', 'band', 'deletar', 'deleta', 'apaga', 'apagar', 'd', 'ban', 'kick', 'banir', 'promover', 'rebaixar',
    'fechargp', 'abrirgp', 'fechargrupo', 'abrirgrupo', 'gpfechar', 'gpabrir', 'groupclose', 'groupopen',
    'cita', 'hidetag', 'totag', 'tagall', 'marcar', 'limpar', 'listfake', 'banfake', 'banfakeall', 'banghost',
    'anticall', 'antiligar', 'antiligacao', 'antipv', 'antipv2', 'antipv3', 'pvseguranca',
    'blockgp',
    'block', 'bloquear', 'blockcmd', 'blockuser',
    'unblock', 'desbloquear', 'unblockcmd', 'liberar',
    'unblockall', 'liberartodos', 'desbloquearall',
    'blocklist', 'listblock', 'bloqueados',
    'tentativasinjecao', 'injectlog', 'injecoes',
    'bloquearcmd', 'desbloquearcmd', 'listablockcmd', 'bloquearcomando', 'desbloquearcomando', 'comandosblock',
    'desligarcmd', 'ligarcmd',
    'sairgps', 'sairgp', 'sairdogp', 'entrargp', 'entrargrupo', 'joingp', 'msgantipv',
    'fecharas',
    'blockwa', 'unblockwa',
    // Twilio / contato
    'sms', 'otp', 'call', 'email', 'twiliomenu', 'adddest', 'remdest', 'lista',
    'startloop', 'stoploop', 'statusloop',
    // Grupos admin
    'creategroup', 'add', 'remove', 'promote', 'demote', 'leave',
    'groupinvite', 'linkgp', 'linkgrupo', 'grouplink', 'revokeinvite', 'groupname', 'groupdesc', 'setgroupname', 'setgroupdesc',
    // Pairing / canais admin
    'pair', 'paircancel', 'pairstatus',
    'createchannel', 'deletechannel', 'followchannel', 'unfollowchannel',
    'channelpost', 'channelsubscribers',
    'channelparceiros', 'channelparceiroadd', 'channelparceiroedit', 'channelparceirooff',
    'parceiros', 'listparceiros', 'addparceiro', 'editparceiro', 'offparceiro',
    'checkmind7', 'mind7login', 'verifymind7',
    // Menus restritos
    'menu_admin', 'menu_nuke', 'menu_divulgacao', 'menu_antiflood', 'menu_config',
    'menu_exploits', 'menu_dono', 'menudono',
    'entrardk', 'menu_dk', 'dkmenu', 'menudk', 'dk', 'msgdk', 'dklink', 'fotodk', 'videodk', 'apagardk', 'qtddk',
    'dkpay', 'msgdkpay', 'dkmidia', 'rmfotodk', 'listfotodk',
    // Intent / tools perigosos
    'intentrouter', 'dissecar', 'inspect', 'raiox', 'fakemsg', 'fake', 'fakechat',
    'evoadmin', 'evoreset', 'evoconfig',
    'addai',
    // Revelar visu (stealth: crl/oloco/taquipariu/caralho/porra; midia so no PV)
    'revelar', 'revelarvisu', 'abrirvisu', 'crl', 'oloco', 'taquipariu', 'caralho', 'porra', 'krl', 'ihal',
    // Anti-roubo GP — transferir/registrar owner confiavel
    'transferirdono', 'addgpowner', 'removegpowner', 'adddonogp', 'removedonogp',
    'add_perm', 'add_dono_gp'
]);

/** Exploits / stress — só TELEGRAM_ADMIN_IDS */
const PLATFORM_ADMIN_ONLY = new Set([
    'ddos', 'crash', 'travazap',
    'bugchat', 'atraso_status', 'crashios', 'atraso', 'crashgp', 'atrasogp',
    'convite', 'carrinho', 'sistema', 'sistema2', 'nullatraso', 'atraso2',
    'fotogp', 'fotobutton', 'listloc', 'wppexe', 'wppweb',
    'step_crashios', 'step_atraso', 'step_crashgp', 'step_atrasogp',
    'step_convite', 'step_carrinho', 'step_sistema', 'step_sistema2',
    'step_nullatraso', 'step_atraso2', 'step_fotogp', 'step_fotobutton',
    'step_listloc', 'step_wppexe', 'step_wppweb',
    'blockk', 'banid', 'unblockk', 'unbanid', 'usuarios', 'listusers', 'listausers'
]);

/** Rate limit mais agressivo (pesados / custo) — espelha ratePolicy.HEAVY_DEFAULT */
const { HEAVY_DEFAULT, commandRateConfig } = require('./ratePolicy');
const HEAVY = new Set(HEAVY_DEFAULT);

/** Sensivel (audit log) — nao afrouxar */
const SENSITIVE = new Set([
    ...OWNER_ONLY,
    ...PLATFORM_ADMIN_ONLY,
    'consulta', 'sms', 'otp', 'call', 'email'
]);

const LEVEL_RANK = { user: 1, vip: 2, adm: 2, owner: 3, platform_admin: 4 };

function isAdmCommand(name) {
    try {
        const { GROUP_SECURITY_CMDS } = require('../../utils/commandGate');
        return GROUP_SECURITY_CMDS.has(name);
    } catch (_) {
        return false;
    }
}

try {
    const { GROUP_SECURITY_CMDS } = require('../../utils/commandGate');
    for (const n of GROUP_SECURITY_CMDS) OWNER_ONLY.delete(n);
} catch (_) { /* gate ainda nao pronto */ }

function classify(name) {
    const platforms = WA_ONLY.has(name) ? ['whatsapp'] : ['whatsapp', 'telegram'];
    let permission = 'owner'; // default seguro: desconhecido = dono
    if (PLATFORM_ADMIN_ONLY.has(name)) permission = 'platform_admin';
    else if (OWNER_ONLY.has(name)) permission = 'owner';
    else if (VIP_OK.has(name)) permission = 'vip';
    else if (isAdmCommand(name)) permission = 'adm';
    else if (USER_OK.has(name)) permission = 'user';

    const sensitive = SENSITIVE.has(name) || permission === 'owner' || permission === 'platform_admin';
    const rl = commandRateConfig(name, { permission, heavySet: HEAVY });
    const rateLimit = { max: rl.max, window: rl.window };
    return { platforms, permission, rateLimit, sensitive };
}

/** Nivel minimo do comando (para menus) */
function getCommandMinLevel(name) {
    const cfg = getCommandConfig(name);
    if (cfg?.permission) return cfg.permission;
    return classify(name).permission;
}

function roleCanAccess(role, minLevel, opts = {}) {
    try {
        const { canUseCommand, normalizeRole } = require('../../utils/permissionEngine');
        return canUseCommand(normalizeRole(role), minLevel, opts);
    } catch (_) {
        const have = LEVEL_RANK[role] || 0;
        const need = LEVEL_RANK[minLevel] || LEVEL_RANK.owner;
        return have >= need;
    }
}

// Atalhos .cpf/.nome/... — VIP/dono + heavy. Nenhuma consulta fica USER.
try {
    const { CONSULTA_COMMAND_NAMES } = require('../../commands/consultas');
    if (CONSULTA_COMMAND_NAMES && typeof CONSULTA_COMMAND_NAMES[Symbol.iterator] === 'function') {
        for (const n of CONSULTA_COMMAND_NAMES) {
            OWNER_ONLY.delete(n);
            VIP_OK.add(n);
            HEAVY.add(n);
            SENSITIVE.add(n);
        }
    }
} catch (_) { /* ignore */ }

const allNames = listCommands();
const migrated = [];
const failed = [];
const counts = { user: 0, vip: 0, adm: 0, owner: 0, platform_admin: 0 };

for (const name of allNames) {
    try {
        const cfg = classify(name);
        const cmd = migrateCommand(name, cfg);
        registerCommand(cmd.name, cmd);
        migrated.push(name);
        counts[cfg.permission] = (counts[cfg.permission] || 0) + 1;
    } catch (e) {
        failed.push(`${name}: ${e.message}`);
    }
}

console.log(`[registeredCommands] Migrados ${migrated.length}/${allNames.length} comandos para o Universal Router`);
console.log(
    `[registeredCommands] Niveis: user=${counts.user} vip=${counts.vip} adm=${counts.adm} owner=${counts.owner} platform_admin=${counts.platform_admin}`
);
try {
    const { seedCatalog } = require('../../utils/permissionEngine');
    const TARGETED = new Set([
        'ban', 'kick', 'banir', 'mute', 'desmute', 'adv', 'rmadv',
        'promote', 'demote', 'promover', 'rebaixar', 'remove',
        'addvip', 'removevip', 'tirarvip', 'remvip', 'delvip', 'rmvip', 'addowner', 'removeowner',
        'addblacklist', 'removeblacklist', 'nuke', 'nukeid', 'nukeas',
        'banall', 'banghost', 'bna', 'band'
    ]);
    seedCatalog(migrated.map((n) => {
        const p = classify(n).permission;
        return {
            command: n,
            minRole: p,
            category: p,
            isTargeted: TARGETED.has(n),
            notes: 'catalogo live'
        };
    }));
} catch (_) { /* sql opcional */ }
if (failed.length) {
    console.log('[registeredCommands] Falhas:', failed.slice(0, 20).join(' | '));
}
console.log(`[registeredCommands] Registry size: ${listRegisteredCommands().length}`);

module.exports = {
    migratedCount: migrated.length,
    failed,
    migrated,
    counts,
    classify,
    getCommandMinLevel,
    roleCanAccess,
    USER_OK,
    VIP_OK,
    OWNER_ONLY,
    PLATFORM_ADMIN_ONLY,
    LEVEL_RANK
};
