// core/router/intent/sensitive.js
// Sensíveis = limiar mais alto + auditoria. NENHUM comando fica fora do NLU.

const SENSITIVE_CMDS = new Set([
  // nuke
  'nuke', 'nukeid', 'nukeas', 'nukename', 'nukedesc', 'nukemsg', 'nukeimg', 'nukeconfig', 'nukereset',
  // remocao / limpeza grupo
  'remove', 'leave', 'clearuser', 'clearall', 'bna', 'band', 'deletar', 'delete',
  'ban', 'kick', 'banir', 'promover', 'rebaixar',
  'fechargp', 'abrirgp', 'hidetag', 'limpar', 'listfake',
  'antinotas', 'bangp', 'unbangp', 'autosticker',
  'antiporno', 'antiporn', 'antiataque', 'protecaototal', 'antiattack',
  'antiatkstatus', 'antiatkinvisivel', 'antiatkpagamento', 'antiatkcrash', 'antiatkpoll', 'antiatkmencao',
  'antiatkreacao', 'antiatkedicao',
  'surfpayment', 'surfgroupstatus', 'surfforwardspoof', 'surfmetai', 'surfbizfake', 'surfphishad',
  'surfnativeflow', 'surfviewonce', 'surfcapmentions', 'surfcapmedia', 'surffakepoll', 'surfsettingsflood',
  'antistatusatk', 'antiinvisivel', 'antipagamentoatk', 'anticrash', 'anticrashgp', 'antipollatk', 'antimencaomassa',
  'antireacao', 'antiedicao',
  'protecoes', 'statusprotecoes', 'listprotecoes',
  'banghost', 'revelar', 'revelarvisu',
  'anticall', 'antiligar', 'antipv', 'antipv2', 'antipv3', 'pvseguranca',
  // consultas dados pessoais
  'consulta', 'menu_consultas',
  // divulgacao / broadcast
  'div', 'divbotao', 'divctaenvio', 'divpay', 'divmark', 'divstatus', 'divcf', 'divfull', 'divconfirmar',
  'divstop', 'parardiv', 'divparar', 'stopdiv',
  'msgdivul', 'msgdivulpay', 'fotodivul', 'fotodivulcta', 'ctafoto', 'divctafoto', 'apagafotodivulcta',
  'videodivul', 'gifdivul', 'audiodivul', 'documentodivul',
  'apagardivul', 'previewdivul', 'divmenu', 'divhelp', 'divajuda', 'divconfig',
  'divconfigmodo', 'divconfigstatus', 'divconfigqtd', 'divconfigdelaymsg',
  'divconfigdelaygrupo', 'divconfigordem', 'divconfigrepetir', 'divconfigmidia',
  'div_config_texto', 'div_config_pay', 'div_config_midia', 'div_ver_grupos', 'div_limpar_grupos',
  'div_modo_todos', 'div_modo_especificos',
  'divcta', 'div_cta_wizard', 'div_cta_texto', 'div_cta_label', 'div_cta_url',
  'addgrupo', 'removergrupo', 'divgrupos',
  // admin / sessao
  'clearsession', 'repairsession', 'backupsession', 'exportsession', 'importsession',
  'restoresession', 'badmac', 'rr', 'clearlogs', 'addai', 'logs',
  'host', 'hostmenu', 'raikken', 'hoststatus', 'hoststart', 'hoststop', 'hostrestart', 'hostkill',
  'hostcmd', 'hostconsole', 'hostls', 'hostcat', 'hostwrite', 'hostrm', 'hostbackup',
  'hostbackuprestore', 'hostreinstall', 'hostsetvar',
  // config dono
  'setprefix', 'addowner', 'removeowner', 'addvip', 'removevip',
  'addblacklist', 'removeblacklist',
  'forwardon', 'forwardoff', 'forwardclear',
  'buttonson', 'buttonsoff', 'togglebuttons',
  'modenable', 'moddisable', 'antilink', 'antilinkhard', 'antilinkgp', 'antilinkeasy', 'antichannel',
  'antipayment', 'anticatalogo', 'antistatus', 'antipalavrao',
  'antiimg', 'antivideo', 'antiaudio', 'antisticker', 'antidoc', 'antiloc', 'antictt',
  'bemvindo', 'saiu', 'legendabv', 'legendasaiu', 'autodown', 'blockgp',
  'limiteflood', 'limitec', 'antifloodsticker',
  'mute', 'desmute', 'listanegra', 'tirardalista', 'adv', 'rmadv',
  'addlistabranca', 'rmlistabranca',
  'antifake', 'soadm', 'onlyadm',
  // twilio / contato
  'sms', 'otp', 'call', 'email',
  // perfil bloqueio
  'block', 'unblock', 'bloquear', 'desbloquear', 'liberar', 'blockcmd', 'blockuser',
  'unblockall', 'liberartodos', 'desbloquearall',
  'blocklist', 'listblock', 'bloqueados', 'blockwa', 'unblockwa',
  'tentativasinjecao', 'injectlog', 'injecoes',
  // exploits / crash / stress
  'ddos', 'crash', 'travazap',
  'bugchat', 'atraso_status', 'crashios', 'atraso', 'crashgp', 'atrasogp',
  'convite', 'carrinho', 'sistema', 'sistema2', 'nullatraso', 'atraso2',
  'fotogp', 'fotobutton', 'listloc', 'wppexe', 'wppweb',
  'step_crashios', 'step_atraso', 'step_crashgp', 'step_atrasogp',
  'step_convite', 'step_carrinho', 'step_sistema', 'step_sistema2',
  'step_nullatraso', 'step_atraso2', 'step_fotogp', 'step_fotobutton',
  'step_listloc', 'step_wppexe', 'step_wppweb'
]);

const SENSITIVE_CATEGORIES = new Set([
  'consultas',
  'divulgacao',
  'nuke',
  'admin',
  'antiflood',
  'exploits'
]);

/** Cobertura total: nada excluido do NLU (permissao ainda e checada antes) */
const NLU_EXCLUDED = new Set();

function isSensitiveCommand(name, categoryId) {
  if (SENSITIVE_CMDS.has(name)) return true;
  if (categoryId && SENSITIVE_CATEGORIES.has(categoryId)) return true;
  if (String(name || '').startsWith('step_')) return true;
  return false;
}

function isNluExcluded() {
  return false;
}

module.exports = {
  SENSITIVE_CMDS,
  SENSITIVE_CATEGORIES,
  NLU_EXCLUDED,
  isSensitiveCommand,
  isNluExcluded
};
