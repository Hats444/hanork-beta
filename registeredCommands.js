// core/router/registeredCommands.js
// Auto-migra TODOS os comandos de commands/ para o Universal Router
// Hierarquia: platform_admin > owner > vip > user (default seguro = owner)

const { registerCommand, listRegisteredCommands, getCommandConfig } = require('./universalRouter');
const { migrateCommand } = require('./commandAdapter');
const { listCommands } = require('../../commands/index');

/** Comandos so WhatsApp (grupo / baileys) — config nuke pode no TG tambem */
const WA_ONLY = new Set([
    'nuke', 'nukeid', 'nukeas',
    'creategroup', 'add', 'remove', 'promote', 'demote', 'leave', 'groupinfo', 'groupid',
    'groupinvite', 'revokeinvite', 'groupname', 'groupdesc', 'setgroupname', 'setgroupdesc',
    'pair', 'paircancel', 'pairstatus',
    'figurinha', 'figcanal', 'figurinhas', 'figurinhas2',
    'div', 'divpay', 'divmark', 'divstatus', 'divcf', 'divfull', 'divconfirmar',
    'bugchat', 'crashios', 'crashgp', 'travazap',
    'modenable', 'moddisable', 'modstatus', 'gpseguranca',
    'protecoes', 'protecoesativas', 'protecoeshelp', 'oquestaon', 'protecoeson',
    'antilink', 'antilinkhard', 'antifake', 'soadm', 'onlyadm',
    'bna', 'band', 'deletar', 'ban', 'kick', 'banir', 'promover', 'rebaixar',
    'fechargp', 'abrirgp', 'hidetag', 'limpar', 'listfake', 'banghost',
    'antilinkgp', 'antilinkeasy', 'antiimg', 'antivideo', 'antiaudio', 'antisticker',
    'antidoc', 'antiloc', 'antictt', 'antichannel', 'antipayment', 'anticatalogo',
    'antistatus', 'antipalavrao', 'bemvindo', 'saiu', 'autodown', 'antinotas',
    'bangp', 'autosticker', 'antiporno', 'antiataque', 'protecaototal', 'limiteflood', 'mute', 'desmute',
    'listanegra', 'adv', 'revelar', 'revelarvisu',
    'autoconvite', 'aceitar', 'recusar', 'aceitarall', 'recusarall', 'pedidosentrada'
]);

/**
 * USER — cotidiano, sem alterar sistema / sem PII / sem broadcast
 */
const USER_OK = new Set([
    // Geral / menus
    'menu', 'ping', 'stats', 'comandos', 'tutorial', 'novidades', 'changelog', 'oquemudou',
    'meujid', 'help', 'ajuda',
    'menu_geral', 'menu_downloads', 'menu_webintelligence', 'menu_figurinhas',
    'menu_messages', 'menu_mensagens', 'menu_tools', 'menu_webia', 'menu_git',
    'menu_enquetes', 'menu_status', 'menu_perfil',
    'menu_grupo_mod', 'menu_grupo_entrada', 'menu_grupo_config', 'menu_diversao', 'menu_utilidades',
    'menu_ia', 'menu_hanorkapi',
    // Downloads (+ aliases seguros)
    'download', 'downloads', 'play', 'ytmp3', 'mp3', 'yt', 'ytaudio', 'playaudio',
    'playvideo', 'playvid', 'ytmp4', 'ytv', 'ytvideo',
    'tiktok', 'tt', 'tk', 'tkdl', 'instagram', 'ig', 'insta', 'igdl', 'igvideo',
    'facebook', 'fb', 'spotify', 'soundcloud', 'sc', 'scloud',
    'mediafire', 'mf', 'twitter', 'twtdl', 'x', 'kwai', 'threads', 'thdl', 'capcut',
    'pinterest', 'pindl', 'pinmp4', 'pinterestmp4', 'ytsearch',
    // Figurinhas / midia leve
    's', 'f', 'sticker', 'stiker', 'fig', 'st', 'stk',
    'fsticker', 'fstiker', 'toimg', 'toimage',
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
    'nivel', 'evolucao', 'evo', 'desbloqueios', 'rank', 'ranking', 'evoleader'
]);

/**
 * VIP — valor agregado / custo maior, sem config do bot
 */
const VIP_OK = new Set([
    'deepsearch', 'analisar', 'ganalisar', 'relatorio',
    'revelar', 'revelarvisu', 'abrirvisu',
    'gitsearch', 'github', 'repos', 'repo',
    // Figurinhas → canal (posta no newsletter do dono)
    'figurinha', 'figcanal', 'figurinhas', 'figurinhas2',
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
    // Divulgacao
    'div', 'divbotao', 'divctaenvio', 'divpay', 'divmark', 'divstatus', 'divcf', 'divfull', 'divconfirmar',
    'divstop', 'parardiv', 'divparar', 'stopdiv',
    'msgdivul', 'msgdivulpay', 'fotodivul', 'fotodivulcta', 'ctafoto', 'divctafoto', 'apagafotodivulcta',
    'videodivul', 'gifdivul', 'audiodivul', 'documentodivul',
    'apagardivul', 'previewdivul', 'divmenu', 'divhelp', 'divajuda', 'divcta',
    'div_cta_wizard', 'div_cta_texto', 'div_cta_label', 'div_cta_url',
    'addgrupo', 'removergrupo', 'divgrupos',
    'divconfig', 'divconfigmodo', 'divconfigstatus', 'divconfigqtd',
    'divconfigdelaymsg', 'divconfigdelaygrupo', 'divconfigordem', 'divconfigrepetir',
    'divconfigmidia', 'div_config_texto', 'div_config_pay', 'div_config_midia',
    'div_ver_grupos', 'div_limpar_grupos', 'div_modo_todos', 'div_modo_especificos',
    // Config botoes / forward
    'forwardon', 'forwardoff', 'forwardstatus', 'forwardclear',
    'buttonson', 'buttonsoff', 'togglebuttons', 'buttonmode',
    'setprefix', 'addowner', 'removeowner', 'listowners', 'addvip', 'removevip', 'listvips',
    'addblacklist', 'removeblacklist', 'listblacklist',
    // Seguranca grupo
    'modenable', 'moddisable', 'modstatus', 'modlist', 'modhelp', 'gpseguranca', 'antifloodhelp',
    'protecoes', 'protecoesativas', 'protecoeshelp', 'oquestaon', 'protecoeson',
    'antilink', 'antilinkhard', 'antilinkgp', 'antilinkeasy', 'antilingp',
    'antifake', 'soadm', 'onlyadm',
    'antiimg', 'antivideo', 'antiaudio', 'antisticker', 'antidoc', 'antiloc', 'antictt',
    'antichannel', 'antichannell', 'antipayment', 'anticatalogo', 'antistatus', 'antipalavrao',
    'bemvindo', 'saiu', 'welcome', 'bv', 'legendabv', 'legendasaiu',
    'autodown', 'autodownload', 'antinotas', 'bangp', 'unbangp', 'autosticker', 'antiporno', 'antiporn',
    'antiataque', 'protecaototal', 'antiattack',
    'limiteflood', 'limitec', 'antifloodsticker',
    'mute', 'desmute', 'mutelist', 'listanegra', 'tirardalista', 'listban',
    'adv', 'rmadv', 'listadv', 'addlistabranca', 'rmlistabranca', 'listabranca',
    'bna', 'band', 'deletar', 'd', 'ban', 'kick', 'banir', 'promover', 'rebaixar',
    'fechargp', 'abrirgp', 'hidetag', 'totag', 'cita', 'limpar', 'listfake', 'banghost',
    'anticall', 'antiligar', 'antiligacao', 'antipv', 'antipv2', 'antipv3', 'pvseguranca',
    'blockgp',
    'block', 'bloquear', 'blockcmd', 'blockuser',
    'unblock', 'desbloquear', 'unblockcmd', 'liberar',
    'unblockall', 'liberartodos', 'desbloquearall',
    'blocklist', 'listblock', 'bloqueados',
    'tentativasinjecao', 'injectlog', 'injecoes',
    'blockwa', 'unblockwa',
    // Consultas PII
    'consulta', 'menu_consultas',
    // Twilio / contato
    'sms', 'otp', 'call', 'email', 'twiliomenu', 'adddest', 'remdest', 'lista',
    'startloop', 'stoploop', 'statusloop',
    // Grupos admin
    'creategroup', 'add', 'remove', 'promote', 'demote', 'leave',
    'groupinvite', 'revokeinvite', 'groupname', 'groupdesc', 'setgroupname', 'setgroupdesc',
    // Pairing / canais admin
    'pair', 'paircancel', 'pairstatus',
    'createchannel', 'deletechannel', 'followchannel', 'unfollowchannel',
    'channelpost', 'channelsubscribers',
    // Menus restritos
    'menu_admin', 'menu_nuke', 'menu_divulgacao', 'menu_antiflood', 'menu_config',
    'menu_exploits',
    // Intent / tools perigosos
    'intentrouter', 'dissecar', 'inspect', 'raiox', 'fakemsg', 'fake',
    'evoadmin', 'evoreset', 'evoconfig',
    'addai'
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
    'step_listloc', 'step_wppexe', 'step_wppweb'
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

const LEVEL_RANK = { user: 1, vip: 2, owner: 3, platform_admin: 4 };

function classify(name) {
    const platforms = WA_ONLY.has(name) ? ['whatsapp'] : ['whatsapp', 'telegram'];
    let permission = 'owner'; // default seguro: desconhecido = dono
    if (PLATFORM_ADMIN_ONLY.has(name)) permission = 'platform_admin';
    else if (OWNER_ONLY.has(name)) permission = 'owner';
    else if (VIP_OK.has(name)) permission = 'vip';
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

function roleCanAccess(role, minLevel) {
    const have = LEVEL_RANK[role] || 0;
    const need = LEVEL_RANK[minLevel] || LEVEL_RANK.owner;
    return have >= need;
}

// Atalhos .cpf/.nome/... — sempre owner + heavy (PII)
try {
    const { CONSULTA_COMMAND_NAMES } = require('../../commands/consultas');
    if (CONSULTA_COMMAND_NAMES && typeof CONSULTA_COMMAND_NAMES[Symbol.iterator] === 'function') {
        for (const n of CONSULTA_COMMAND_NAMES) {
            OWNER_ONLY.add(n);
            HEAVY.add(n);
            SENSITIVE.add(n);
        }
    }
} catch (_) { /* ignore */ }

const allNames = listCommands();
const migrated = [];
const failed = [];
const counts = { user: 0, vip: 0, owner: 0, platform_admin: 0 };

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
    `[registeredCommands] Niveis: user=${counts.user} vip=${counts.vip} owner=${counts.owner} platform_admin=${counts.platform_admin}`
);
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
