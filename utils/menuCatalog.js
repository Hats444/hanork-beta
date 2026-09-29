// utils/menuCatalog.js
// Catalogo unico de menus — WhatsApp (listas) e Telegram (inline)
// Cada item: name, desc, usage, platforms, needsArgs
// Menus (ON/OFF): titulos via previewText (fonte Hanork); IDs internos ASCII.
// Comandos/usage ficam literais (usuario copia/cola).

const HANORK_API_HUB_CMDS = new Set([
  'hanork', 'hanorkapi', 'hanorkinfo', 'zt', 'ztinfo',
  'menu_hanorkdownloads', 'menu_hanorkfigurinhas', 'menu_hanorkpesquisas'
]);
const HANORK_READY_CAT_IDS = new Set([
  'hanork_downloads', 'hanork_figurinhas', 'hanork_pesquisas'
]);

function filterHanorkHubItems(items) {
  return (items || []).filter((it) => HANORK_API_HUB_CMDS.has(String(it.name)));
}

const { previewText, stripAccents } = require('./typography');
const { applyLivePrefix } = require('./configManager');

/** Titulo de menu — fonte visual Hanork (mono), sem acento; IDs internos intactos */
function menuHeading(input) {
  return previewText(String(input || '').trim());
}

/** Rank de hierarquia (espelha registeredCommands / permissionManager) */
const MENU_LEVEL_RANK = { user: 1, vip: 2, adm: 2, owner: 3, platform_admin: 4 };

function resolveCmdLevel(name) {
  try {
    const { getCommandMinLevel } = require('../core/router/registeredCommands');
    if (typeof getCommandMinLevel === 'function') return getCommandMinLevel(name);
  } catch (_) { /* registry ainda nao carregado */ }
  try {
    const { getCommandConfig } = require('../core/router/universalRouter');
    const cfg = getCommandConfig(name);
    if (cfg?.permission) return cfg.permission;
  } catch (_) { /* ignore */ }
  try {
    const { permissionFor, byCmd } = require('../core/zt/catalog');
    const entry = byCmd(name);
    if (entry?.nsfw || ['consultas', 'cassino', 'nsfw', 'tinder'].includes(entry?.category)) {
      return 'owner';
    }
    const p = permissionFor(name);
    if (p) return p;
  } catch (_) { /* catalogo ausente */ }
  return 'owner';
}

function roleCanSee(role, minLevel, opts = {}) {
  try {
    const { canUseCommand, normalizeRole } = require('./permissionEngine');
    const actor = role === 'group_admin' ? 'adm' : normalizeRole(role);
    const isGroupAdmin = !!(opts.isGroupAdmin || role === 'group_admin' || role === 'adm');
    return canUseCommand(actor, minLevel, { isGroupAdmin });
  } catch (_) {
    const have = MENU_LEVEL_RANK[role] || 0;
    const need = MENU_LEVEL_RANK[minLevel] || MENU_LEVEL_RANK.owner;
    return have >= need;
  }
}

/** VIP+admin nativo DESTE grupo ve itens adm. Sem ctx = so o papel da sessao. */
function viewerAccessOpts(ctx) {
  if (!ctx) return {};
  try {
    const { isGroupAdminActor } = require('./commandGate');
    if (isGroupAdminActor(ctx)) return { isGroupAdmin: true };
  } catch (_) { /* */ }
  if (ctx.isGroup && (ctx.isAdmin || ctx.authRole === 'group_admin' || ctx.authRole === 'adm')) {
    return { isGroupAdmin: true };
  }
  return {};
}

/**
 * Role para menus: TELEGRAM_ADMIN_IDS vira platform_admin tambem no WA
 * (senao o dono da sessao fica "owner" e some Travas/Exploits).
 */
function resolveMenuViewerRole(ctx = null, telegramUserId = null) {
  const tg =
    telegramUserId ||
    ctx?.telegramUserId ||
    null;
  try {
    const { isAdmin } = require('./userManager');
    if (tg && isAdmin(tg)) return 'platform_admin';
  } catch (_) { /* ignore */ }
  if (ctx?.authRole === 'platform_admin') return 'platform_admin';
  if (ctx?.authRole === 'group_admin' || ctx?.authRole === 'adm') return 'adm';
  if (ctx?.authRole) return ctx.authRole;
  if (ctx?.isOwner) return 'owner';
  if (ctx?.isVip) return 'vip';
  if (ctx?.authRole === 'user' || ctx?.isUser) return 'user';
  return 'user';
}

function filterItemsByRole(items, role, opts = {}) {
  const list = (items || []).filter((it) => !it.hidden);
  if (!role) return list;
  return list.filter((it) =>
    roleCanSee(role, it.permission || resolveCmdLevel(it.name), opts)
  );
}

/** Categoria visivel se sobrar algum item para o role */
function categoryVisibleForRole(cat, role, opts = {}) {
  if (!cat) return false;
  if (!role) return true;
  if (cat.platformAdminOnly && !roleCanSee(role, 'platform_admin', opts)) return false;
  return filterItemsByRole(cat.items, role, opts).length > 0;
}

const CATALOG = [
  {
    id: 'geral',
    title: 'Geral',
    desc: 'Menu, status, tutorial',
    items: [
      { name: 'menu', desc: 'Abre o menu principal', usage: 'menu' },
      { name: 'menu_dono', desc: 'Tudo que o dono da sessao pode usar', usage: 'menu_dono', permission: 'owner' },
      { name: 'menu_adm', desc: 'Tudo que o admin do grupo pode usar', usage: 'menu_adm', permission: 'adm' },
      { name: 'ping', desc: 'Mostra se o bot esta respondendo', usage: 'ping' },
      { name: 'stats', desc: 'Resumo de uso do bot', usage: 'stats' },
      { name: 'comandos', desc: 'Lista os comandos', usage: 'comandos [categoria]' },
      { name: 'tutorial', desc: 'Passo a passo pra comecar', usage: 'tutorial' },
      { name: 'start', desc: 'Checklist da loja: admin, protecao, divulgacao', usage: 'start' },
      { name: 'novidades', desc: 'O que mudou recentemente', usage: 'novidades' },
      { name: 'sobre', desc: 'O que e o bot', usage: 'sobre' },
      { name: 'comprar', desc: 'Bot aberto', usage: 'comprar', hidden: true },
      { name: 'minhaconta', desc: 'Bot aberto', usage: 'minhaconta', hidden: true },
      { name: 'suporte', desc: 'Bot aberto', usage: 'suporte', hidden: true },
      { name: 'planos', desc: 'Bot aberto', usage: 'planos', hidden: true },
      { name: 'dono', desc: 'Quem opera este bot', usage: 'dono' },
      { name: 'nivel', desc: 'Seu nivel de uso', usage: 'nivel' },
      { name: 'evolucao', desc: 'Painel de nivel e metas', usage: 'evolucao' },
      { name: 'desbloqueios', desc: 'O que seu nivel libera', usage: 'desbloqueios' },
      { name: 'rank', desc: 'Ranking de uso', usage: 'rank' },
      { name: 'meujid', desc: 'Mostra seu numero neste WhatsApp', usage: 'meujid', platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'downloads',
    title: 'Downloads',
    desc: 'Baixa video e musica (YouTube, TikTok, Instagram...)',
    items: [
      { name: 'download', desc: 'Menu de downloads', usage: 'download' },
      { name: 'play', desc: 'Audio YouTube', usage: 'play <musica ou link>', needsArgs: true },
      { name: 'ytmp3', desc: 'Alias de play', usage: 'ytmp3 <musica ou link>', needsArgs: true },
      { name: 'mp3', desc: 'Alias de play', usage: 'mp3 <musica ou link>', needsArgs: true },
      { name: 'yt', desc: 'Alias de play', usage: 'yt <musica ou link>', needsArgs: true },
      { name: 'ytaudio', desc: 'Alias de play', usage: 'ytaudio <musica ou link>', needsArgs: true },
      { name: 'playvideo', desc: 'Video YouTube', usage: 'playvideo <nome ou link>', needsArgs: true },
      { name: 'ytmp4', desc: 'Alias playvideo', usage: 'ytmp4 <nome ou link>', needsArgs: true },
      { name: 'playvid', desc: 'Alias playvideo', usage: 'playvid <nome ou link>', needsArgs: true },
      { name: 'ytv', desc: 'Alias playvideo', usage: 'ytv <nome ou link>', needsArgs: true },
      { name: 'ytvideo', desc: 'Alias playvideo', usage: 'ytvideo <nome ou link>', needsArgs: true },
      { name: 'tiktok', desc: 'Video TikTok (instavel — API de cima falha)', usage: 'tiktok <link>', needsArgs: true },
      { name: 'tt', desc: 'Alias tiktok', usage: 'tt <link>', needsArgs: true },
      { name: 'tk', desc: 'Alias tiktok', usage: 'tk <link>', needsArgs: true },
      { name: 'instagram', desc: 'Midia Instagram (instavel — API de cima falha)', usage: 'instagram <link>', needsArgs: true },
      { name: 'ig', desc: 'Alias instagram', usage: 'ig <link>', needsArgs: true },
      { name: 'insta', desc: 'Alias instagram', usage: 'insta <link>', needsArgs: true },
      { name: 'facebook', desc: 'Video Facebook', usage: 'facebook <link>', needsArgs: true },
      { name: 'fb', desc: 'Alias facebook', usage: 'fb <link>', needsArgs: true },
      { name: 'spotify', desc: 'Audio Spotify', usage: 'spotify <link ou nome>', needsArgs: true },
      { name: 'soundcloud', desc: 'Audio SoundCloud', usage: 'soundcloud <link ou nome>', needsArgs: true },
      { name: 'sc', desc: 'Alias soundcloud', usage: 'sc <link ou nome>', needsArgs: true },
      { name: 'mediafire', desc: 'Arquivo MediaFire', usage: 'mediafire <link>', needsArgs: true },
      { name: 'mf', desc: 'Alias mediafire', usage: 'mf <link>', needsArgs: true },
      { name: 'twitter', desc: 'Midia Twitter/X', usage: 'twitter <link>', needsArgs: true },
      { name: 'x', desc: 'Alias twitter', usage: 'x <link>', needsArgs: true },
      { name: 'kwai', desc: 'Video Kwai', usage: 'kwai <link>', needsArgs: true },
      { name: 'threads', desc: 'Midia Threads', usage: 'threads <link>', needsArgs: true },
      { name: 'capcut', desc: 'Modelo CapCut', usage: 'capcut <link>', needsArgs: true },
      { name: 'pinterest', desc: 'Midia Pinterest', usage: 'pinterest <link>', needsArgs: true },
      { name: 'pin', desc: 'Alias pinterest', usage: 'pin <link>', needsArgs: true },
      { name: 'ytsearch', desc: 'Buscar no YouTube', usage: 'ytsearch <termo>', needsArgs: true },
      { name: 'ephoto', desc: 'Logo / texto em estilo (lista)', usage: 'ephoto [estilo] [texto]' },
      { name: 'flux', desc: 'Gera imagem (flux)', usage: 'flux <prompt>', needsArgs: true },
      { name: 'nano', desc: 'Edita foto (nano-banana)', usage: 'nano <prompt> (responda foto)', needsArgs: true },
      { name: 'edits', desc: 'Edita foto (DeepAI)', usage: 'edits <prompt> (responda foto)', needsArgs: true },
      { name: 'upscale', desc: 'Aumenta resolucao da foto', usage: 'upscale (responda foto)' },
      { name: 'tourl', desc: 'Sobe midia e devolve URL', usage: 'tourl (responda midia)' },
      { name: 'shazam', desc: 'Identifica musica', usage: 'shazam (responda audio)' }
    ]
  },
  {
    id: 'hanorkapi',
    title: 'Hanork API',
    desc: 'Uma entrada: categorias da API (lista clicavel)',
    items: [
      { name: 'hanork', desc: 'Conversa com a IA (VIP/dono)', usage: 'hanork <mensagem>', needsArgs: true },
      { name: 'grok', desc: 'Pergunta pra IA (VIP)', usage: 'grok <pergunta>', needsArgs: true, permission: 'vip' },
      { name: 'fdc', desc: 'Fato desconhecido', usage: 'fdc' },
      { name: 'hanorkapi', desc: 'Lista as ferramentas extras', usage: 'hanorkapi' },
      { name: 'hanorkinfo', desc: 'Explica um comando extra', usage: 'hanorkinfo <cmd>', needsArgs: true },
      { name: 'menu_hanorkdownloads', desc: 'Downloads extras', usage: 'menu_hanorkdownloads' },
      { name: 'menu_hanorkpesquisas', desc: 'Pesquisas extras', usage: 'menu_hanorkpesquisas' },
      { name: 'menu_hanorkmontagem', desc: 'API Montagem', usage: 'menu_hanorkmontagem' },
      { name: 'menu_hanorklogos', desc: 'API Logos', usage: 'menu_hanorklogos' },
      { name: 'menu_hanorkanimes', desc: 'API Animes', usage: 'menu_hanorkanimes' },
      { name: 'menu_hanorkwallpapers', desc: 'API Wallpapers', usage: 'menu_hanorkwallpapers' },
      { name: 'figurinha', desc: 'Posta figurinha no canal (lista)', usage: 'figurinha', platforms: ['whatsapp'], permission: 'vip' },
      { name: 'menu_hanorkfigurinhas', desc: 'API Figurinhas (legado)', usage: 'menu_hanorkfigurinhas' },
      { name: 'menu_hanorkcanvas', desc: 'API Canvas', usage: 'menu_hanorkcanvas' },
      { name: 'menu_hanorkias', desc: 'API IA (use {p}hanork)', usage: 'menu_hanorkias' },
      { name: 'menu_hanorkdoramas', desc: 'API Doramas', usage: 'menu_hanorkdoramas' },
      { name: 'menu_hanorkmangas', desc: 'API Mangas', usage: 'menu_hanorkmangas' },
      { name: 'menu_hanorkanichin', desc: 'API Anichin/animes', usage: 'menu_hanorkanichin' },
      { name: 'menu_hanorkencontrei', desc: 'API Encontrei/Pobreflix', usage: 'menu_hanorkencontrei' },
      { name: 'menu_hanorkmcpedl', desc: 'API MCPEDL', usage: 'menu_hanorkmcpedl' },
      { name: 'menu_hanorkoutros', desc: 'API Outros (HD, tradutor...)', usage: 'menu_hanorkoutros' },
      { name: 'menu_hanorkjogos', desc: 'API Jogos', usage: 'menu_hanorkjogos' },
      { name: 'menu_hanorkupload', desc: 'API Upload', usage: 'menu_hanorkupload' },
      { name: 'menu_hanorkconsultas', desc: 'API Consultas (owner)', usage: 'menu_hanorkconsultas' },
      { name: 'menu_hanorktinder', desc: 'API Tinder (owner)', usage: 'menu_hanorktinder' }
    ]
  },
  {
    id: 'consultas',
    title: 'Consultas',
    desc: 'CEP/CNPJ/IP, ficha rapida e dossie (dono/VIP)',
    items: [
      { name: 'menu_consultas', desc: 'Lista todas as consultas', usage: 'menu_consultas', permission: 'vip' },
      { name: 'consulta', desc: 'Consultar por tipo', usage: 'consulta <tipo> <valor>', needsArgs: true, permission: 'vip' },
      { name: 'cpf', desc: 'Ficha basica pelo CPF', usage: 'cpf <11 digitos>', needsArgs: true, permission: 'vip' },
      { name: 'cpfcompleto', desc: 'Ficha completa pelo CPF', usage: 'cpfcompleto <11 digitos>', needsArgs: true, permission: 'vip' },
      { name: 'nome', desc: 'Achar CPF pelo nome', usage: 'nome <nome completo>', needsArgs: true, permission: 'vip' },
      { name: 'telefone', desc: 'Telefone + endereco', usage: 'telefone <ddd+numero>', needsArgs: true, permission: 'vip' },
      { name: 'placa', desc: 'Veiculo pela placa', usage: 'placa <ABC1D23>', needsArgs: true, permission: 'vip' },
      { name: 'cpffull', desc: 'Dossie completo pelo CPF', usage: 'cpffull <11 digitos>', needsArgs: true, permission: 'vip' },
      { name: 'buscanome', desc: 'Busca CPF pelo nome (filtros)', usage: 'buscanome <nome completo>', needsArgs: true, permission: 'vip' },
      { name: 'celular', desc: 'Cadastros pelo celular (dossie)', usage: 'celular <ddd+numero>', needsArgs: true, permission: 'vip' },
      { name: 'placafull', desc: 'Veiculo completo pela placa', usage: 'placafull <ABC1D23>', needsArgs: true, permission: 'vip' },
      { name: 'cep', desc: 'Endereco pelo CEP', usage: 'cep <8 digitos>', needsArgs: true, permission: 'vip' },
      { name: 'cnpj', desc: 'Dados da empresa', usage: 'cnpj <14 digitos>', needsArgs: true, permission: 'vip' },
      { name: 'cnpjfull', desc: 'CNPJ completo (quadro societario)', usage: 'cnpjfull <14 digitos>', needsArgs: true, permission: 'vip' },
      { name: 'ip', desc: 'Geo/ASN de IP', usage: 'ip <ipv4>', needsArgs: true, permission: 'vip' },
      { name: 'ttkstalk', desc: 'Perfil TikTok', usage: 'ttkstalk <user>', needsArgs: true, permission: 'vip' },
      { name: 'infoff', desc: 'Info Free Fire (UID)', usage: 'infoff <uid>', needsArgs: true, permission: 'vip' },
      { name: 'likeff', desc: 'Likes Free Fire (VIP)', usage: 'likeff <uid> [regiao]', needsArgs: true, permission: 'vip' },
      ...(() => {
        try {
          const mind7 = require('../services/mind7Client');
          if (typeof mind7.isEnabled === 'function' && !mind7.isEnabled()) return [];
          const { MODULES } = require('../services/mind7Catalog');
          const skip = new Set(['cpffull', 'buscanome', 'celular', 'placafull', 'cnpjfull', 'menu_consultas']);
          return MODULES.filter((m) => !m.unavailable && !skip.has(m.cmds[0])).map((m) => ({
            name: m.cmds[0],
            desc: String(m.desc || m.cmds[0]),
            usage: m.usage || `${m.cmds[0]} <valor>`,
            needsArgs: m.need !== 'optional',
            permission: 'vip'
          }));
        } catch (_) {
          return [];
        }
      })()
    ]
  },
  {
    id: 'webia',
    title: 'Web',
    desc: 'google, deepsearch, analisar, sitecheck',
    items: [
      { name: 'google', desc: 'Busca web', usage: 'google <termo>', needsArgs: true },
      { name: 'pesquisar', desc: 'Alias google', usage: 'pesquisar <termo>', needsArgs: true },
      { name: 'deepsearch', desc: 'Busca profunda IA', usage: 'deepsearch <termo>', needsArgs: true },
      { name: 'analisar', desc: 'Analisa fonte N', usage: 'analisar <numero>', needsArgs: true },
      { name: 'relatorio', desc: 'Relatorio IA', usage: 'relatorio' },
      { name: 'glista', desc: 'Lista resultados', usage: 'glista' },
      { name: 'gopen', desc: 'Abre resultado N', usage: 'gopen <numero>', needsArgs: true },
      { name: 'gcopy', desc: 'Copia link N', usage: 'gcopy <numero>', needsArgs: true },
      { name: 'glimpar', desc: 'Limpa pesquisa', usage: 'glimpar' },
      { name: 'sitecheck', desc: 'Checagem tecnica de site (DNS, TLS, CDN, stack, portas)', usage: 'sitecheck <dominio|url>', needsArgs: true, permission: 'vip' },
      { name: 'checarsite', desc: 'Alias sitecheck', usage: 'checarsite <dominio|url>', needsArgs: true, permission: 'vip' }
    ]
  },
  {
    id: 'github',
    title: 'GitHub',
    desc: 'gitsearch, repo',
    items: [
      { name: 'gitsearch', desc: 'Buscar repos', usage: 'gitsearch <termo>', needsArgs: true },
      { name: 'github', desc: 'Alias gitsearch', usage: 'github <termo>', needsArgs: true },
      { name: 'repo', desc: 'Detalhes autor/repo', usage: 'repo <autor/repo>', needsArgs: true }
    ]
  },
  {
    id: 'divulgacao',
    title: 'Divulgacao',
    desc: 'Broadcast e config',
    items: [
      { name: 'divmenu', desc: 'Menu divulgacao', usage: 'divmenu', platforms: ['whatsapp'] },
      { name: 'divslots', desc: 'ADM: menu unico CTA+Status (#1/#2 editar/midia/enviar/auto)', usage: 'divslots', platforms: ['whatsapp'] },
      { name: 'divslot', desc: 'ADM: ativa slot e abre painel CTA/Status', usage: 'divslot cta 2', platforms: ['whatsapp'] },
      { name: 'divulgar', desc: 'ADM: CTA/status com link de grupo sempre atual', usage: 'divulgar cta|status|setgrupo', platforms: ['whatsapp'] },
      { name: 'divauto', desc: 'Liga/desliga divulgacao automatica', usage: 'divauto on|off', platforms: ['whatsapp'] },
      { name: 'divconfigauto', desc: 'Tempo auto fixo 15m-24h (2h/3h/6h/12h). Aleatorio e msgs so se ligar no painel', usage: 'divconfigauto [cta|texto|pay|status] 12h|2h|aleatorio 60 180|msgs on|off', platforms: ['whatsapp'] },
      { name: 'divconfigautomodos', desc: 'Liga/desliga cada tipo do auto (ciclos independentes)', usage: 'divconfigautomodos cta on|off', platforms: ['whatsapp'] },
      { name: 'divcriagrupo', desc: 'Cria grupos ja marcados pra divulgacao', usage: 'divcriagrupo 3 Nome', platforms: ['whatsapp'] },
      { name: 'divautocriar', desc: 'Cria grupos quando a lista cair abaixo do minimo', usage: 'divautocriar on|off', platforms: ['whatsapp'] },
      { name: 'divconfigmingrupos', desc: 'Minimo de grupos de divulgacao', usage: 'divconfigmingrupos 5', platforms: ['whatsapp'] },
      { name: 'divconfigcriagrupo', desc: 'Nome-base e lote da criacao automatica', usage: 'divconfigcriagrupo 3 Nome', platforms: ['whatsapp'] },
      { name: 'div', desc: 'Texto: varios links + mencoes', usage: 'div [qtd] [delay]', platforms: ['whatsapp'] },
      { name: 'menu_dk', desc: 'Menu do DK: o que esta gravado', usage: 'menu_dk', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'dk', desc: 'Neste grupo: so a bolha de pagamento, 1x ou dk N (so dono)', usage: 'dk | dk 9', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'entrardk', desc: 'Entra no grupo aberto, manda pagamento, sai e entra de novo', usage: 'entrardk 7 <link>', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'dkpay', desc: 'Alias de msgdk', usage: 'dkpay <texto ou link>', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'msgdkpay', desc: 'Alias de msgdk', usage: 'msgdkpay <texto ou link>', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'msgdk', desc: 'Texto do pagamento do DK (so o link troca o convite no texto)', usage: 'msgdk <texto ou link>', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'dklink', desc: 'Alias de msgdk', usage: 'dklink <link>', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'fotodk', desc: 'Adiciona foto na lista do status DK', usage: 'fotodk', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'listfotodk', desc: 'Lista as fotos do status DK', usage: 'listfotodk', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'rmfotodk', desc: 'Remove foto n do status DK', usage: 'rmfotodk 1', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'dkmidia', desc: 'Midia do modo repeticao (responda)', usage: 'dkmidia', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'videodk', desc: 'Video do modo repeticao (responda)', usage: 'videodk', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'apagardk', desc: 'Apaga so a midia do modo repeticao', usage: 'apagardk', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'qtddk', desc: 'Quantas vezes o entrar manda no total', usage: 'qtddk 7', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'divbotao', desc: 'CTA: texto + botao + link', usage: 'divbotao [qtd] [delay]', platforms: ['whatsapp'] },
      { name: 'divpay', desc: 'Pagamento: pix/pay + mencoes', usage: 'divpay [qtd]', platforms: ['whatsapp'] },
      { name: 'divmark', desc: 'Alias do texto (mencoes ja vem)', usage: 'divmark [qtd]', platforms: ['whatsapp'] },
      { name: 'divfull', desc: 'Completa: usa o modo salvo da config', usage: 'divfull [qtd]', platforms: ['whatsapp'] },
      { name: 'divstatus', desc: 'Status close friends', usage: 'divstatus [qtd]', platforms: ['whatsapp'] },
      { name: 'divcf', desc: 'Close friends', usage: 'divcf [qtd]', platforms: ['whatsapp'] },
      { name: 'divconfirmar', desc: 'Confirmar divulgacao', usage: 'divconfirmar', platforms: ['whatsapp'] },
      { name: 'divcta', desc: 'Configurar CTA (texto + ate 2 botoes/links)', usage: 'divcta [texto | botao | url | botao2 | url2]', platforms: ['whatsapp'] },
      { name: 'fotodivulcta', desc: 'Foto do cartao CTA', usage: 'fotodivulcta (responda imagem)', platforms: ['whatsapp'] },
      { name: 'msgdivul', desc: 'Texto normal (varios links)', usage: 'msgdivul <texto>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'msgdivulpay', desc: 'Texto da divulgacao de pagamento', usage: 'msgdivulpay <texto>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'msgdivulstatus', desc: 'Texto da divulgacao de status', usage: 'msgdivulstatus <texto>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'fotodivul', desc: 'Foto do texto normal', usage: 'fotodivul (responda imagem)', platforms: ['whatsapp'] },
      { name: 'fotodivulstatus', desc: 'Foto do status', usage: 'fotodivulstatus (responda imagem)', platforms: ['whatsapp'] },
      { name: 'videodivulstatus', desc: 'Video do status', usage: 'videodivulstatus (responda video)', platforms: ['whatsapp'] },
      { name: 'videodivul', desc: 'Definir video', usage: 'videodivul', platforms: ['whatsapp'] },
      { name: 'gifdivul', desc: 'Definir gif', usage: 'gifdivul', platforms: ['whatsapp'] },
      { name: 'audiodivul', desc: 'Definir audio', usage: 'audiodivul', platforms: ['whatsapp'] },
      { name: 'documentodivul', desc: 'Definir documento', usage: 'documentodivul', platforms: ['whatsapp'] },
      { name: 'apagardivul', desc: 'Apagar midia/texto', usage: 'apagardivul', platforms: ['whatsapp'] },
      { name: 'previewdivul', desc: 'Preview', usage: 'previewdivul', platforms: ['whatsapp'] },
      { name: 'divconfig', desc: 'Config divulgacao', usage: 'divconfig', platforms: ['whatsapp'] },
      { name: 'divhelp', desc: 'Help divulgacao', usage: 'divhelp', platforms: ['whatsapp'] },
      { name: 'addgrupo', desc: 'Marca/desmarca grupo divulgacao', usage: 'addgrupo [on|off]', platforms: ['whatsapp'] },
      { name: 'grupos', desc: 'Gerenciador: fila de convites + entrar/sair', usage: 'grupos', platforms: ['whatsapp'] },
      { name: 'grupolista', desc: 'Lista paginada dos grupos ativos', usage: 'grupolista [pagina]', platforms: ['whatsapp'] },
      { name: 'grupoconfig', desc: 'Limites e teto de grupos (X / max)', usage: 'grupoconfig [max N]', platforms: ['whatsapp'] },
      { name: 'grupoentrar', desc: 'Entra em N convites e cadastra na divulgacao', usage: 'grupoentrar [N|max]', platforms: ['whatsapp'] },
      { name: 'gruposair', desc: 'Sai de N grupos da lista (confirma)', usage: 'gruposair [N]', platforms: ['whatsapp'] },
      { name: 'removergrupo', desc: 'Remove grupo da lista', usage: 'removergrupo', platforms: ['whatsapp'] },
      { name: 'divgrupos', desc: 'Gerenciar grupos', usage: 'divgrupos', platforms: ['whatsapp'] },
      { name: 'divajuda', desc: 'Ajuda divulgacao', usage: 'divajuda', platforms: ['whatsapp'] },
      { name: 'bandeja', desc: 'Edita status de grupo V2 (texto/foto/video)', usage: 'bandeja texto <legenda> | foto | video | ver | limpar', platforms: ['whatsapp'] },
      { name: 'postbandeja', desc: 'Envia a bandeja V2 (membros, todos ou canal)', usage: 'postbandeja [membros|todos|canal]', platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'grupos',
    title: 'Grupos',
    desc: 'Admin de grupo',
    items: [
      { name: 'creategroup', desc: 'Criar grupo', usage: 'creategroup <nome>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'add', desc: 'Add participantes', usage: 'add <jid>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'remove', desc: 'Remover membros', usage: 'remove <jid>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'promote', desc: 'Promover admin', usage: 'promote <jid>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'demote', desc: 'Rebaixar admin', usage: 'demote <jid>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'groupinfo', desc: 'Info do grupo', usage: 'groupinfo', platforms: ['whatsapp'] },
      { name: 'groupid', desc: 'ID do grupo', usage: 'groupid', platforms: ['whatsapp'] },
      { name: 'groupinvite', desc: 'Link convite', usage: 'groupinvite', platforms: ['whatsapp'] },
      { name: 'linkgp', desc: 'Link do grupo no formato completo (com query da atualizacao)', usage: 'linkgp', platforms: ['whatsapp'] },
      { name: 'revokeinvite', desc: 'Revogar link', usage: 'revokeinvite', platforms: ['whatsapp'] },
      { name: 'groupname', desc: 'Alterar nome', usage: 'groupname <nome>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'groupdesc', desc: 'Alterar descricao', usage: 'groupdesc <texto>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'leave', desc: 'Sair do grupo', usage: 'leave', platforms: ['whatsapp'] },
      { name: 'sairgp', desc: 'Alias de leave', usage: 'sairgp', platforms: ['whatsapp'] },
      { name: 'entrargp', desc: 'Entra no grupo pelo link de convite', usage: 'entrargp <link>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'entrargrupo', desc: 'Alias de entrargp', usage: 'entrargrupo <link>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'joingp', desc: 'Alias de entrargp', usage: 'joingp <link>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'sairgps', desc: 'Sai de um grupo da lista (por numero)', usage: 'sairgps [n]', platforms: ['whatsapp'] },
      { name: 'setgroupname', desc: 'Set nome grupo', usage: 'setgroupname <nome>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'setgroupdesc', desc: 'Set desc grupo', usage: 'setgroupdesc <texto>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'setgrouppp', desc: 'Set foto grupo', usage: 'setgrouppp', platforms: ['whatsapp'] },
      { name: 'clearuser', desc: 'Alias de deletar (ate 50 msgs, sem ban)', usage: 'clearuser (responda, marque ou mencione)', platforms: ['whatsapp'] },
      { name: 'clearall', desc: 'Apagar varias msgs', usage: 'clearall', platforms: ['whatsapp'] },
      { name: 'bna', desc: 'Apaga msgs + remove do grupo', usage: 'bna (responda)', platforms: ['whatsapp'] },
      { name: 'deletar', desc: 'Apaga ate 50 msgs do alvo (reply/mencao). Nao bane', usage: 'deletar (responda, marque ou mencione)', platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'antiflood',
    title: 'Seguranca',
    desc: 'Painel: o que cada protecao faz (apaga/ban)',
    items: [
      { name: 'modhelp', desc: 'Ajuda: como ativar/desativar anti-flood', usage: 'modhelp' },
      { name: 'gpseguranca', desc: 'Painel: cada item ON/OFF + o que faz', usage: 'gpseguranca', platforms: ['whatsapp'] },
      { name: 'protecoes', desc: 'Alias do painel de protecoes', usage: 'protecoes', platforms: ['whatsapp'] },
      { name: 'protecoesativas', desc: 'Lista SO o que esta ON e pode apagar/ban', usage: 'protecoesativas', platforms: ['whatsapp'] },
      { name: 'protecoeshelp', desc: 'Explica 1 protecao (ex: antilink)', usage: 'protecoeshelp <nome>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'modenable', desc: 'Liga anti-flood (flood → apaga+ban)', usage: 'modenable', platforms: ['whatsapp'] },
      { name: 'moddisable', desc: 'Desliga anti-flood neste grupo', usage: 'moddisable', platforms: ['whatsapp'] },
      { name: 'modstatus', desc: 'Abre o mesmo painel de seguranca', usage: 'modstatus', platforms: ['whatsapp'] },
      { name: 'modlist', desc: 'Listar grupos com anti-flood ON', usage: 'modlist' },
      { name: 'bna', desc: 'Apaga msgs + remove do grupo', usage: 'bna (responda)', platforms: ['whatsapp'] },
      { name: 'ban', desc: 'Remove membro', usage: 'ban (responda|jid)', platforms: ['whatsapp'] },
      { name: 'bantmp', desc: 'Remove por um tempo e reentra sozinho', usage: 'bantmp 1h (responda ou @)', platforms: ['whatsapp'] },
      { name: 'promover', desc: 'Da admin', usage: 'promover (responda|jid)', platforms: ['whatsapp'] },
      { name: 'rebaixar', desc: 'Tira admin', usage: 'rebaixar (responda|jid)', platforms: ['whatsapp'] },
      { name: 'seradm', desc: 'Vira admin neste grupo (dono/VIP)', usage: 'seradm', platforms: ['whatsapp'] },
      { name: 'sermembro', desc: 'Vira membro neste grupo (dono/VIP)', usage: 'sermembro', platforms: ['whatsapp'] },
      { name: 'fechargp', desc: 'Fecha o grupo agora, ou numa hora (22:00 / 4h)', usage: 'fechargp [22:00|4h]', platforms: ['whatsapp'] },
      { name: 'abrirgp', desc: 'Abre o grupo agora, ou numa hora (08:00 / 4h)', usage: 'abrirgp [08:00|4h]', platforms: ['whatsapp'] },
      { name: 'fecharas', desc: 'Fecha o grupo numa hora (uma vez)', usage: 'fecharas 22:00 | fecharas 4h', platforms: ['whatsapp'] },
      { name: 'fechargrupo', desc: 'Alias fechargp', usage: 'fechargrupo', platforms: ['whatsapp'] },
      { name: 'abrirgrupo', desc: 'Alias abrirgp', usage: 'abrirgrupo', platforms: ['whatsapp'] },
      { name: 'cita', desc: 'Repete a msg respondida mencionando o grupo (ignora adm)', usage: 'cita (responda) [texto]', platforms: ['whatsapp'] },
      { name: 'limpar', desc: 'Limpeza visual do chat', usage: 'limpar', platforms: ['whatsapp'] },
      { name: 'listfake', desc: 'Lista DDI estrangeiro', usage: 'listfake', platforms: ['whatsapp'] },
      { name: 'banfake', desc: 'Apaga msgs + remove fakes (DDI != 55)', usage: 'banfake | banfake all', platforms: ['whatsapp'] },
      { name: 'banfakeall', desc: 'Banfake em todos os grupos', usage: 'banfakeall', platforms: ['whatsapp'] },
      { name: 'antinotas', desc: 'ON: apaga nota/evento de comunidade', usage: 'antinotas on|off', platforms: ['whatsapp'] },
      { name: 'bangp', desc: 'ON: bot IGNORA o grupo inteiro', usage: 'bangp on|off', platforms: ['whatsapp'] },
      { name: 'autosticker', desc: 'ON: foto vira figurinha sozinha', usage: 'autosticker on|off', platforms: ['whatsapp'] },
      ...(() => {
        try {
          const { isAntipornoFeatureOn } = require('./moderation');
          if (typeof isAntipornoFeatureOn === 'function' && !isAntipornoFeatureOn()) return [];
        } catch (_) { /* show */ }
        return [{ name: 'antiporno', desc: 'ON: NSFW → avisa/apaga/ban (API)', usage: 'antiporno on|off', platforms: ['whatsapp'] }];
      })(),
      { name: 'antiatkstatus', desc: 'ON: proto status GP de ataque → apaga+ban (nao mencao)', usage: 'antiatkstatus on|off', platforms: ['whatsapp'] },
      { name: 'antiatkinvisivel', desc: 'ON: viewOnce+crash → apaga+ban (nao visu normal)', usage: 'antiatkinvisivel on|off', platforms: ['whatsapp'] },
      { name: 'antiatkpagamento', desc: 'ON: ataque PIX nativo → apaga+ban', usage: 'antiatkpagamento on|off', platforms: ['whatsapp'] },
      { name: 'antiatkcrash', desc: 'ON: crash/trava → apaga+ban', usage: 'antiatkcrash on|off', platforms: ['whatsapp'] },
      { name: 'antiatkpoll', desc: 'ON: enquete ataque → apaga+ban', usage: 'antiatkpoll on|off', platforms: ['whatsapp'] },
      { name: 'antiatkmencao', desc: 'ON: mencao em massa → apaga+ban', usage: 'antiatkmencao on|off', platforms: ['whatsapp'] },
      { name: 'antiatkreacao', desc: 'ON: flood de reacoes → apaga+ban', usage: 'antiatkreacao on|off', platforms: ['whatsapp'] },
      { name: 'antiatkedicao', desc: 'ON: storm de edicao → apaga+ban', usage: 'antiatkedicao on|off', platforms: ['whatsapp'] },
      { name: 'surfpayment', desc: 'ON: apaga pagamento scam (lib)', usage: 'surfpayment on|off', platforms: ['whatsapp'] },
      { name: 'surfgroupstatus', desc: 'ON: apaga status de grupo; flood remove', usage: 'surfgroupstatus on|off', platforms: ['whatsapp'] },
      { name: 'surfforwardspoof', desc: 'ON: apaga encaminhado falso WA', usage: 'surfforwardspoof on|off', platforms: ['whatsapp'] },
      { name: 'surfmetai', desc: 'ON: apaga wrapper Meta AI estranho', usage: 'surfmetai on|off', platforms: ['whatsapp'] },
      { name: 'surfnativeflow', desc: 'ON: bloqueia payment/call/otp flow', usage: 'surfnativeflow on|off', platforms: ['whatsapp'] },
      { name: 'antiataque', desc: 'Liga/desliga 8 vetores antiatk', usage: 'antiataque on|off', platforms: ['whatsapp'] },
      { name: 'presetprotecao', desc: 'Preset loja|divulgacao|fechado', usage: 'presetprotecao loja', platforms: ['whatsapp'] },
      { name: 'antiadmin', desc: 'Anti-roubo de grupo (X9 + revert). Liga no grupo: antiadmin on', usage: 'antiadmin on|off', platforms: ['whatsapp'] },
      { name: 'antiroubo', desc: 'Alias antiadmin', usage: 'antiroubo on|off', platforms: ['whatsapp'] },
      { name: 'antiadminaudit', desc: 'X9: grava promote/demote no historico', usage: 'antiadminaudit on|off', platforms: ['whatsapp'] },
      { name: 'antiadminrevert', desc: 'Reverte rebaixamento nao autorizado', usage: 'antiadminrevert on|off', platforms: ['whatsapp'] },
      { name: 'antiadminalert', desc: 'Alerta de promote/demote (destino no painel)', usage: 'antiadminalert on|off', platforms: ['whatsapp'] },
      { name: 'antiadmindest', desc: 'Destino do alerta: grupo, pv do dono GP, ambos, pv da sessao ou so log', usage: 'antiadmindest grupo|pv|ambos|dono|silencioso', platforms: ['whatsapp'] },
      { name: 'antiadminsilent', desc: 'X9 so log/SQL, sem mensagem no grupo', usage: 'antiadminsilent on|off', platforms: ['whatsapp'] },
      { name: 'antiadmindetect', desc: 'Detecta rajada de acoes admin na janela', usage: 'antiadmindetect on|off', platforms: ['whatsapp'] },
      { name: 'antiadminlimite', desc: 'Quantas acoes na janela = ataque (toque troca 3/5/8/10/15)', usage: 'antiadminlimite <n>', platforms: ['whatsapp'] },
      { name: 'antiadminjanela', desc: 'Janela em segundos da deteccao (toque troca 5/10/15/30/60)', usage: 'antiadminjanela <seg>', platforms: ['whatsapp'] },
      { name: 'donogrupo', desc: 'Dono nativo/registrado do grupo (nao e .dono)', usage: 'donogrupo', platforms: ['whatsapp'] },
      { name: 'listgpowner', desc: 'Lista dono nativo + registrado + confiaveis', usage: 'listgpowner', platforms: ['whatsapp'] },
      { name: 'transferirdono', desc: 'Transfere owner registrado do grupo', usage: 'transferirdono @user', platforms: ['whatsapp'] },
      { name: 'addgpowner', desc: 'Adiciona owner confiavel do grupo', usage: 'addgpowner @user', platforms: ['whatsapp'] },
      { name: 'removegpowner', desc: 'Remove owner confiavel do grupo', usage: 'removegpowner @user', platforms: ['whatsapp'] },
      { name: 'historicoadmin', desc: 'Historico paginado de promote/demote', usage: 'historicoadmin [n]', platforms: ['whatsapp'] },
      { name: 'protecaototal', desc: 'Alias do painel anti-ataque', usage: 'protecaototal', platforms: ['whatsapp'] },
      { name: 'banghost', desc: 'Remove ghosts (poucas msgs)', usage: 'banghost <n>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'revelar', desc: 'Revela visu/foto no PV (so dono; frases crl/oloco/taquipariu/ihal sem prefixo)', usage: 'crl | oloco | taquipariu | ihal (responda)', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'anticall', desc: 'ON: bloqueia quem ligar no bot', usage: 'anticall on|off', platforms: ['whatsapp'] },
      { name: 'antipv', desc: 'ON (padrao): ignora PV e da block. Dono/VIP passam', usage: 'antipv on|off', platforms: ['whatsapp'] },
      { name: 'antipv2', desc: 'ON (padrao): ignora PV e da block', usage: 'antipv2 on|off', platforms: ['whatsapp'] },
      { name: 'antipv3', desc: 'ON (padrao): ignora PV; so dono/VIP passam', usage: 'antipv3 on|off', platforms: ['whatsapp'] },
      { name: 'msgantipv', desc: 'Desligado: anti-PV nao manda recado, so bloqueia', usage: 'msgantipv <texto>|off', platforms: ['whatsapp'] },
      { name: 'odelete', desc: 'ON: protecoes apagam a msg ofensora (default OFF)', usage: 'odelete on|off', platforms: ['whatsapp'] },
      { name: 'antidelete', desc: 'ON neste grupo: recupera msg apagada por membro (default OFF)', usage: 'antidelete on|off', platforms: ['whatsapp'] },
      { name: 'pvseguranca', desc: 'Status anti-pv/call da sessao', usage: 'pvseguranca', platforms: ['whatsapp'] },
      { name: 'antilink', desc: 'ON: apaga qualquer link (adm ok)', usage: 'antilink on|off', platforms: ['whatsapp'] },
      { name: 'antilinkhard', desc: 'ON: apaga link E remove membro', usage: 'antilinkhard on|off', platforms: ['whatsapp'] },
      { name: 'antilinkgp', desc: 'ON: so apaga convite chat.whatsapp.com', usage: 'antilinkgp on|off', platforms: ['whatsapp'] },
      { name: 'antilinkeasy', desc: 'ON: apaga link (modo leve)', usage: 'antilinkeasy on|off', platforms: ['whatsapp'] },
      { name: 'antichannel', desc: 'ON: apaga link de canal/newsletter', usage: 'antichannel on|off', platforms: ['whatsapp'] },
      { name: 'antipayment', desc: 'ON: apaga SO bolha PIX nativa (nao texto)', usage: 'antipayment on|off', platforms: ['whatsapp'] },
      { name: 'anticatalogo', desc: 'ON: apaga catalogo/produto Business', usage: 'anticatalogo on|off', platforms: ['whatsapp'] },
      { name: 'antistatus', desc: 'ON: apaga status no grupo; flood remove', usage: 'antistatus on|off', platforms: ['whatsapp'] },
      { name: 'antipalavrao', desc: 'ON: apaga msg com palavrao da lista', usage: 'antipalavrao on|off', platforms: ['whatsapp'] },
      { name: 'antiimg', desc: 'ON: apaga foto de nao-admin', usage: 'antiimg on|off', platforms: ['whatsapp'] },
      { name: 'antivideo', desc: 'ON: apaga video de nao-admin', usage: 'antivideo on|off', platforms: ['whatsapp'] },
      { name: 'antiaudio', desc: 'ON: apaga audio de nao-admin', usage: 'antiaudio on|off', platforms: ['whatsapp'] },
      { name: 'antisticker', desc: 'ON: apaga figurinha de nao-admin', usage: 'antisticker on|off', platforms: ['whatsapp'] },
      { name: 'antidoc', desc: 'ON: apaga PDF/arquivo de nao-admin', usage: 'antidoc on|off', platforms: ['whatsapp'] },
      { name: 'antiloc', desc: 'ON: apaga localizacao', usage: 'antiloc on|off', platforms: ['whatsapp'] },
      { name: 'antictt', desc: 'ON: apaga cartao de contato', usage: 'antictt on|off', platforms: ['whatsapp'] },
      { name: 'bemvindo', desc: 'ON: BV personalizavel (texto/foto/fig/audio)', usage: 'bemvindo on|off', platforms: ['whatsapp'] },
      { name: 'autoapresentar', desc: 'OFF por padrao. ON so neste grupo: membro novo fala em 90s ou e removido', usage: 'autoapresentar on|off', platforms: ['whatsapp'] },
      { name: 'saiu', desc: 'ON: saida personalizavel (texto/foto/fig/audio)', usage: 'saiu on|off', platforms: ['whatsapp'] },
      { name: 'legendabv', desc: 'Texto de entrada (@user @grupo #hora#)', usage: 'legendabv <texto>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'fotobv', desc: 'Foto de entrada (responda)', usage: 'fotobv (responda)', platforms: ['whatsapp'] },
      { name: 'figbv', desc: 'Fig de entrada (responda)', usage: 'figbv (responda)', platforms: ['whatsapp'] },
      { name: 'audiobv', desc: 'Audio de entrada (responda)', usage: 'audiobv (responda)', platforms: ['whatsapp'] },
      { name: 'fotosaida', desc: 'Foto de saida (responda)', usage: 'fotosaida (responda)', platforms: ['whatsapp'] },
      { name: 'figsaida', desc: 'Fig de saida (responda)', usage: 'figsaida (responda)', platforms: ['whatsapp'] },
      { name: 'audiosaida', desc: 'Audio de saida (responda)', usage: 'audiosaida (responda)', platforms: ['whatsapp'] },
      { name: 'bvstatus', desc: 'O que esta no bem-vindo deste grupo', usage: 'bvstatus', platforms: ['whatsapp'] },
      { name: 'tabela', desc: 'Cardapio do grupo', usage: 'tabela', platforms: ['whatsapp'] },
      { name: 'settabela', desc: 'Define o cardapio', usage: 'settabela <texto>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'nota', desc: 'Recado fixo do grupo', usage: 'nota [texto]', platforms: ['whatsapp'] },
      { name: 'sorteio', desc: 'Sorteio por nomes ou reacao', usage: 'sorteio Ana, Bia | sorteio reacao', platforms: ['whatsapp'] },
      { name: 'atividade', desc: 'Quem mais fala', usage: 'atividade', platforms: ['whatsapp'] },
      { name: 'inativos', desc: 'Quem pouco fala', usage: 'inativos [n]', platforms: ['whatsapp'] },
      { name: 'horariogrupo', desc: 'Abre/fecha todo dia', usage: 'horariogrupo 08:00 18:00', platforms: ['whatsapp'] },
      { name: 'autoaceitar', desc: 'Aceita pedido de entrada sozinho', usage: 'autoaceitar on|off', platforms: ['whatsapp'] },
      { name: 'autoaceitartempo', desc: 'Espera entre aceites automaticos', usage: 'autoaceitartempo 10s', platforms: ['whatsapp'] },
      { name: 'x9config', desc: 'Avisa mudanca de nome, desc, foto ou fechamento', usage: 'x9config on|off', platforms: ['whatsapp'] },
      { name: 'convidar', desc: 'Manda o link do grupo no PV', usage: 'convidar (responda ou @)', platforms: ['whatsapp'] },
      { name: 'ausente', desc: 'Marca ausencia', usage: 'ausente [texto]|off', platforms: ['whatsapp'] },
      { name: 'figquote', desc: 'Fig com texto', usage: 'figquote <texto>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'tomp3', desc: 'Audio/video em mp3', usage: 'tomp3 (responda)', platforms: ['whatsapp'] },
      { name: 'audiofx', desc: 'Efeito no audio', usage: 'audiofx grave|agudo|rapido|lento|eco', platforms: ['whatsapp'] },
      { name: 'tts', desc: 'Texto em audio', usage: 'tts <texto>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'reagircanal', desc: 'Reage msg de canal', usage: 'reagircanal <link> <emoji>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'boti', desc: 'Liga/desliga comandos pra todos', usage: 'boti on|off', platforms: ['whatsapp'] },
      { name: 'boton', desc: 'Liga comandos pra todos', usage: 'boton', platforms: ['whatsapp'] },
      { name: 'botoff', desc: 'So o dono usa comando', usage: 'botoff', platforms: ['whatsapp'] },
      { name: 'botion', desc: 'Alias boton', usage: 'botion', platforms: ['whatsapp'] },
      { name: 'botioof', desc: 'Alias botoff', usage: 'botioof', platforms: ['whatsapp'] },
      { name: 'legendasaiu', desc: 'Texto saida', usage: 'legendasaiu <texto>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'limiteflood', desc: 'ON: apaga msg acima do limitec', usage: 'limiteflood on|off', platforms: ['whatsapp'] },
      { name: 'limitec', desc: 'Define max chars (com limiteflood)', usage: 'limitec <n>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'antifloodsticker', desc: 'ON: apaga flood de figurinhas (N|off)', usage: 'antifloodsticker <n>|off', platforms: ['whatsapp'] },
      { name: 'mute', desc: 'Silencia membro: APAGA msgs dele', usage: 'mute <jid|responda>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'desmute', desc: 'Remove mute', usage: 'desmute <jid|responda>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'mutelist', desc: 'Lista quem esta mutado (msgs apagadas)', usage: 'mutelist', platforms: ['whatsapp'] },
      { name: 'listanegra', desc: 'Ban global: apaga msgs do alvo no cache, tira de todos os grupos, lista negra', usage: 'listanegra  (sem alvo = ajuda)', platforms: ['whatsapp'] },
      { name: 'banall', desc: 'Ban global: 50 msgs + kick em todos os grupos + lista negra. Aviso leva o link de pagamento.', usage: 'banall  (responda / @ / numero)', platforms: ['whatsapp'] },
      { name: 'tirardalista', desc: 'Remove da lista negra global (alias unbanall)', usage: 'tirardalista <@|numero|responda>', platforms: ['whatsapp'] },
      { name: 'unbanall', desc: 'Alias tirardalista', usage: 'unbanall <@|numero|responda>', platforms: ['whatsapp'] },
      { name: 'listban', desc: 'Ver lista negra global', usage: 'listban', platforms: ['whatsapp'] },
      { name: 'adv', desc: 'Advertencia (kick no limiar)', usage: 'adv <jid|responda>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'rmadv', desc: 'Limpa advertencias', usage: 'rmadv <jid|responda>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'listadv', desc: 'Lista advertencias', usage: 'listadv', platforms: ['whatsapp'] },
      { name: 'addlistabranca', desc: 'Lista branca: pode mandar link', usage: 'addlistabranca <jid|responda>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'rmlistabranca', desc: 'Remove lista branca', usage: 'rmlistabranca <jid|responda>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'listabranca', desc: 'Ver lista branca antilink', usage: 'listabranca', platforms: ['whatsapp'] },
      { name: 'antifake', desc: 'ON: remove DDI != 55 ao entrar', usage: 'antifake on|off', platforms: ['whatsapp'] },
      { name: 'soadm', desc: 'OFF (padrao): so admin usa comando no grupo', usage: 'soadm on|off', platforms: ['whatsapp'] },
      { name: 'onlyadm', desc: 'Alias soadm', usage: 'onlyadm on|off', platforms: ['whatsapp'] },
      { name: 'admcmd', desc: 'Alias soadm', usage: 'admcmd on|off', platforms: ['whatsapp'] },
      { name: 'blockgp', desc: 'Alias soadm', usage: 'blockgp on|off', platforms: ['whatsapp'] },
      { name: 'autodown', desc: 'ON: baixa sozinho links YT/TT/IG', usage: 'autodown on|off', platforms: ['whatsapp'] },
      { name: 'autodownload', desc: 'Alias autodown', usage: 'autodownload on|off', platforms: ['whatsapp'] },
      { name: 'grupodivulgacao', desc: 'Alias addgrupo', usage: 'grupodivulgacao [on|off]', platforms: ['whatsapp'] },
      { name: 'divgrupo', desc: 'Alias addgrupo', usage: 'divgrupo [on|off]', platforms: ['whatsapp'] },
      { name: 'painel', desc: 'Abre painel de protecoes', usage: 'painel', platforms: ['whatsapp'] },
      { name: 'painelprotecoes', desc: 'Alias painel', usage: 'painelprotecoes', platforms: ['whatsapp'] },
      { name: 'statusprotecoes', desc: 'Alias protecoes / painel', usage: 'statusprotecoes', platforms: ['whatsapp'] },
      { name: 'listprotecoes', desc: 'Alias protecoes / painel', usage: 'listprotecoes', platforms: ['whatsapp'] },
      { name: 'banir', desc: 'Alias ban', usage: 'banir (responda|jid)', platforms: ['whatsapp'] },
      { name: 'kick', desc: 'Alias ban', usage: 'kick (responda|jid)', platforms: ['whatsapp'] },
      { name: 'antilingp', desc: 'Alias antilinkgp', usage: 'antilingp on|off', platforms: ['whatsapp'] },
      { name: 'antidocumento', desc: 'Alias antidoc', usage: 'antidocumento on|off', platforms: ['whatsapp'] },
      { name: 'anticontato', desc: 'Alias antictt', usage: 'anticontato on|off', platforms: ['whatsapp'] },
      { name: 'antichannell', desc: 'Alias antichannel', usage: 'antichannell on|off', platforms: ['whatsapp'] },
      { name: 'antimencao', desc: 'Alias antistatus (legado)', usage: 'antimencao on|off', platforms: ['whatsapp'] },
      { name: 'bv', desc: 'Alias bemvindo', usage: 'bv on|off', platforms: ['whatsapp'] },
      { name: 'antiporn', desc: 'Alias antiporno', usage: 'antiporn on|off', platforms: ['whatsapp'] },
      { name: 'antistatusatk', desc: 'Alias antiatkstatus', usage: 'antistatusatk on|off', platforms: ['whatsapp'] },
      { name: 'antiinvisivel', desc: 'Alias antiatkinvisivel', usage: 'antiinvisivel on|off', platforms: ['whatsapp'] },
      { name: 'antipagamentoatk', desc: 'Alias antiatkpagamento', usage: 'antipagamentoatk on|off', platforms: ['whatsapp'] },
      { name: 'anticrash', desc: 'Alias antiatkcrash', usage: 'anticrash on|off', platforms: ['whatsapp'] },
      { name: 'anticrashgp', desc: 'Alias antiatkcrash', usage: 'anticrashgp on|off', platforms: ['whatsapp'] },
      { name: 'antipollatk', desc: 'Alias antiatkpoll', usage: 'antipollatk on|off', platforms: ['whatsapp'] },
      { name: 'antimencaomassa', desc: 'Alias antiatkmencao', usage: 'antimencaomassa on|off', platforms: ['whatsapp'] },
      { name: 'antireacao', desc: 'Alias antiatkreacao', usage: 'antireacao on|off', platforms: ['whatsapp'] },
      { name: 'antiedicao', desc: 'Alias antiatkedicao', usage: 'antiedicao on|off', platforms: ['whatsapp'] },
      { name: 'antiattack', desc: 'Alias antiataque', usage: 'antiattack', platforms: ['whatsapp'] },
      { name: 'antiligar', desc: 'Alias anticall', usage: 'antiligar on|off', platforms: ['whatsapp'] },
      { name: 'antiligacao', desc: 'Alias anticall', usage: 'antiligacao on|off', platforms: ['whatsapp'] },
      { name: 'revelarvisu', desc: 'Alias revelar (stealth)', usage: 'crl | oloco | taquipariu | ihal', platforms: ['whatsapp'] },
      { name: 'abrirvisu', desc: 'Alias revelar (stealth)', usage: 'crl | oloco | taquipariu | ihal', platforms: ['whatsapp'] },
      { name: 'crl', desc: 'Revelar visu (stealth)', usage: 'crl (responda)', platforms: ['whatsapp'] },
      { name: 'oloco', desc: 'Revelar visu (stealth)', usage: 'oloco (responda)', platforms: ['whatsapp'] },
      { name: 'taquipariu', desc: 'Revelar visu (stealth)', usage: 'taquipariu (responda)', platforms: ['whatsapp'] },
      { name: 'ihal', desc: 'Revelar visu/foto (stealth)', usage: 'ihal (responda)', platforms: ['whatsapp'] },
      { name: 'listabrancagrupo', desc: 'Alias listabranca', usage: 'listabrancagrupo', platforms: ['whatsapp'] },
      { name: 'addlistabrancagp', desc: 'Alias addlistabranca', usage: 'addlistabrancagp (responda)', platforms: ['whatsapp'] },
      { name: 'rmvlistabrancagp', desc: 'Alias rmlistabranca', usage: 'rmvlistabrancagp (responda)', platforms: ['whatsapp'] },
      { name: 'listanegrag', desc: 'Alias listanegra / banall', usage: 'listanegrag (responda)', platforms: ['whatsapp'] },
      { name: 'unbangp', desc: 'Alias bangp off', usage: 'unbangp', platforms: ['whatsapp'] },
      { name: 'antifloodhelp', desc: 'Alias modhelp', usage: 'antifloodhelp' },
      { name: 'intentrouter', desc: 'Intent router status/on/off', usage: 'intentrouter status|on|off' }
    ]
  },
  {
    id: 'nuke',
    title: 'Nuke',
    desc: 'Nuke configuravel do grupo',
    items: [
      { name: 'nuke', desc: 'Executar nuke', usage: 'nuke', platforms: ['whatsapp'] },
      { name: 'nukeconfig', desc: 'Ver config nuke', usage: 'nukeconfig', platforms: ['whatsapp', 'telegram'] },
      { name: 'nukename', desc: 'Config nome pos-nuke', usage: 'nukename <nome>', needsArgs: true, platforms: ['whatsapp', 'telegram'] },
      { name: 'nukedesc', desc: 'Config desc pos-nuke', usage: 'nukedesc <texto>', needsArgs: true, platforms: ['whatsapp', 'telegram'] },
      { name: 'nukemsg', desc: 'Config msg pos-nuke', usage: 'nukemsg <texto>', needsArgs: true, platforms: ['whatsapp', 'telegram'] },
      { name: 'nukeimg', desc: 'Config imagem nuke', usage: 'nukeimg', platforms: ['whatsapp', 'telegram'] },
      { name: 'nukeid', desc: 'Nuke por ID do grupo', usage: 'nukeid <gid@g.us>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'nukeas', desc: 'Alias nuke', usage: 'nukeas', platforms: ['whatsapp'] },
      { name: 'nukereset', desc: 'Reset config nuke', usage: 'nukereset', platforms: ['whatsapp', 'telegram'] }
    ]
  },
  {
    id: 'mensagens',
    title: 'Mensagens',
    desc: 'figurinha canal, sticker, midia...',
    items: [
      { name: 'figurinha', desc: 'Lista + posta N figurinhas no canal', usage: 'figurinha [N] [cat] | qtd N', platforms: ['whatsapp'], permission: 'vip' },
      { name: 'figurinhas', desc: 'Aleatoria 1 no canal', usage: 'figurinhas', platforms: ['whatsapp'], permission: 'vip' },
      { name: 'figurinhas2', desc: 'Aleatoria 2 no canal', usage: 'figurinhas2', platforms: ['whatsapp'], permission: 'vip' },
      { name: 'text', desc: 'Enviar texto', usage: 'text <texto>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'msgdir', desc: 'Msg dirigida Valley (1/N/todos)', usage: 'msgdir grupo | alvo | texto', platforms: ['whatsapp'] },
      { name: 'pv', desc: 'Alias msgdir (estilo Valley)', usage: 'pv grupo@g.us | numero | texto', platforms: ['whatsapp'] },
      { name: 'msg', desc: 'Alias msgdir no grupo', usage: 'msg @user texto', platforms: ['whatsapp'] },
      { name: 'invisivel', desc: 'Alias msgdir', usage: 'invisivel grupo | alvo | texto', platforms: ['whatsapp'] },
      { name: 'image', desc: 'Enviar imagem', usage: 'image <url>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'video', desc: 'Enviar video', usage: 'video <url>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'audio', desc: 'Enviar audio', usage: 'audio <url>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'document', desc: 'Enviar documento', usage: 'document <url>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'sticker', desc: 'Criar figurinha (img/video 10s)', usage: 's (responda imagem)', platforms: ['whatsapp'] },
      { name: 's', desc: 'Alias sticker', usage: 's (responda imagem)', platforms: ['whatsapp'] },
      { name: 'f', desc: 'Alias sticker', usage: 'f (responda imagem)', platforms: ['whatsapp'] },
      { name: 'toimg', desc: 'Sticker para imagem', usage: 'toimg (responda sticker)', platforms: ['whatsapp'] },
      { name: 'filtroigdark', desc: 'P&B dark (contraste alto, estilo Instagram)', usage: 'filtroigdark (responda foto)', platforms: ['whatsapp'] },
      { name: 'roubar', desc: 'Renomear pack sticker', usage: 'roubar pack/autor', platforms: ['whatsapp'], needsArgs: true },
      { name: 't', desc: 'Teu pack/autor na fig. Foto com t na legenda (ou reply) ja vira figurinha com o T e o selo do canal. Sem prefixo tambem.', usage: 't | t pack/autor (fig, foto ou video 10s)', platforms: ['whatsapp'] },
      { name: 'sett', desc: 'Salva o T (pack/autor)', usage: 'sett pack/autor', platforms: ['whatsapp'] },
      { name: 'meut', desc: 'Mostra o T salvo', usage: 'meut', platforms: ['whatsapp'] },
      { name: 'stickerinfo', desc: 'ID/hash da figurinha (responda). Nao bane.', usage: 'stickerinfo (responda)', platforms: ['whatsapp'] },
      { name: 'figban', desc: 'Bloqueia essa fig no envio do bot (responda). So dono.', usage: 'figban (responda)', platforms: ['whatsapp'] },
      { name: 'figunban', desc: 'Tira fig da lista de bloqueio', usage: 'figunban (responda)|hash', platforms: ['whatsapp'] },
      { name: 'figbanall', desc: 'Marca fig como trigger de banall (responda). So dono.', usage: 'figbanall (responda)', platforms: ['whatsapp'] },
      { name: 'figbanlist', desc: 'Lista figs bloqueadas nesta sessao', usage: 'figbanlist', platforms: ['whatsapp'] },
      { name: 'attp', desc: 'Figurinha de texto', usage: 'attp <texto>', platforms: ['whatsapp'], needsArgs: true },
      { name: 'ususticker', desc: 'Foto de perfil em figurinha', usage: 'ususticker @user', platforms: ['whatsapp'] },
      { name: 'stickerpack', desc: 'Sticker pack', usage: 'stickerpack nome|autor', platforms: ['whatsapp'] },
      { name: 'avatarsticker', desc: 'Figurinha avatar', usage: 'avatarsticker', platforms: ['whatsapp'] },
      { name: 'album', desc: 'Album multi midia', usage: 'album <url1,url2>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'edit', desc: 'Editar mensagem', usage: 'edit <texto> (responda)', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'delete', desc: 'Apagar mensagem', usage: 'delete (responda)', platforms: ['whatsapp'] },
      { name: 'react', desc: 'Reagir', usage: 'react <emoji> (responda)', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'forward', desc: 'Encaminhar', usage: 'forward (responda)', platforms: ['whatsapp'] },
      { name: 'dissecar', desc: 'Disseca msg/reply/mencao/numero/canal/grupo (tudo do Zap)', usage: 'dissecar [jid|numero|link] | responda | @', platforms: ['whatsapp'] },
      { name: 'inspect', desc: 'Alias dissecar', usage: 'inspect <jid|link>', platforms: ['whatsapp'] },
      { name: 'raiox', desc: 'Alias dissecar', usage: 'raiox <jid|link>', platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'interativos',
    title: 'Interativos',
    desc: 'botoes, listas, carousel',
    items: [
      { name: 'buttons', desc: 'Botoes', usage: 'buttons titulo | op1,op2', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'list', desc: 'Lista', usage: 'list titulo | op1,op2', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'carousel', desc: 'Carrossel', usage: 'carousel ...', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'buttonv2', desc: 'ButtonV2 Builder', usage: 'buttonv2', platforms: ['whatsapp'] },
      { name: 'carouselbuilder', desc: 'Carousel Builder', usage: 'carouselbuilder', platforms: ['whatsapp'] },
      { name: 'copybutton', desc: 'Botao copiar', usage: 'copybutton texto | codigo', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'urlbutton', desc: 'Botao URL', usage: 'urlbutton texto | url | label', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'flow', desc: 'WhatsApp Flow', usage: 'flow <id> <token>', needsArgs: true, platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'canais',
    title: 'Canais',
    desc: 'newsletter / channel',
    items: [
      { name: 'createchannel', desc: 'Criar canal', usage: 'createchannel <nome>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'followchannel', desc: 'Seguir canal', usage: 'followchannel <jid>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'unfollowchannel', desc: 'Deixar de seguir', usage: 'unfollowchannel <jid>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'channelinfo', desc: 'Info canal', usage: 'channelinfo <jid>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'channelpost', desc: 'Postar no canal padrao (ou all / ids de parceiro)', usage: 'channelpost [texto] | all | <id,id> | <jid|link> [texto]', needsArgs: false, platforms: ['whatsapp'] },
      { name: 'channelparceiros', desc: 'Lista canais parceiros', usage: 'channelparceiros', platforms: ['whatsapp'] },
      { name: 'channelparceiroadd', desc: 'Cadastra canal parceiro', usage: 'channelparceiroadd <link|jid> [fixa|troca] [dono]', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'channelparceiroedit', desc: 'Edita parceiro (dono/tipo/status)', usage: 'channelparceiroedit <id> dono|tipo|status <valor>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'channelparceirooff', desc: 'Desativa parceiro (mantem historico)', usage: 'channelparceirooff <id>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'channelstatus', desc: 'Status de canal (24h, aba Status)', usage: 'channelstatus [jid] <texto>', platforms: ['whatsapp'] },
      { name: 'channelsubscribers', desc: 'Inscritos', usage: 'channelsubscribers <jid>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'deletechannel', desc: 'Excluir canal', usage: 'deletechannel <jid>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'channelid', desc: 'Config ID canal', usage: 'channelid <id>', needsArgs: true, platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'botoes',
    title: 'Botoes',
    desc: 'Modo interativo ou encaminhada de canal',
    items: [
      { name: 'buttonson', desc: 'Ativar botoes (ON)', usage: 'buttonson', platforms: ['whatsapp'] },
      { name: 'buttonsoff', desc: 'Desativar botoes (OFF = encaminhada)', usage: 'buttonsoff', platforms: ['whatsapp'] },
      { name: 'togglebuttons', desc: 'Alternar ON/OFF', usage: 'togglebuttons', platforms: ['whatsapp'] },
      { name: 'buttonmode', desc: 'Ver status atual', usage: 'buttonmode', platforms: ['whatsapp'] },
      { name: 'forwardon', desc: 'Forward canal ON', usage: 'forwardon', platforms: ['whatsapp'] },
      { name: 'forwardoff', desc: 'Forward canal OFF', usage: 'forwardoff', platforms: ['whatsapp'] },
      { name: 'forwardstatus', desc: 'Status forward', usage: 'forwardstatus', platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'config',
    title: 'Config',
    desc: 'prefix, owners, blacklist',
    items: [
      { name: 'setprefix', desc: 'Alterar prefixo', usage: 'setprefix <p>', needsArgs: true },
      { name: 'prefixo', desc: 'Mostra o prefixo desta sessao', usage: 'prefixo', platforms: ['whatsapp'] },
      { name: 'prefixhint', desc: 'Aviso de prefixo com botao (padrao OFF). on liga, off desliga', usage: 'prefixhint on|off', platforms: ['whatsapp'] },
      { name: 'ia', desc: 'Liga/desliga toda a IA (Intent/chat/dicas). Padrao OFF', usage: 'ia on|off|status', platforms: ['whatsapp'] },
      { name: 'addowner', desc: 'Add dono (numero, reply ou @)', usage: 'addowner (responda | @ | numero)' },
      { name: 'removeowner', desc: 'Remover dono (numero, reply ou @)', usage: 'removeowner (responda | @ | numero)' },
      { name: 'listowners', desc: 'Listar donos', usage: 'listowners' },
      { name: 'checkmind7', desc: 'Checa o login das consultas extras', usage: 'checkmind7 <email> <senha>' },
      { name: 'addvip', desc: 'Add VIP (numero, reply ou @)', usage: 'addvip (responda | @ | numero)' },
      { name: 'tirarvip', desc: 'Tira VIP (numero, reply ou @)', usage: 'tirarvip (responda | @ | numero)' },
      { name: 'removevip', desc: 'Alias de tirarvip', usage: 'removevip (responda | @ | numero)' },
      { name: 'vipall', desc: 'VIP pra todos do grupo', usage: 'vipall', platforms: ['whatsapp'] },
      { name: 'removervipall', desc: 'Tira VIP de todos do grupo', usage: 'removervipall', platforms: ['whatsapp'] },
      { name: 'listvips', desc: 'Listar VIPs', usage: 'listvips' },
      { name: 'addblacklist', desc: 'Add blacklist', usage: 'addblacklist <jid>', needsArgs: true },
      { name: 'removeblacklist', desc: 'Rem blacklist', usage: 'removeblacklist <jid>', needsArgs: true },
      { name: 'listblacklist', desc: 'Listar blacklist', usage: 'listblacklist' },
      { name: 'forwardclear', desc: 'Limpar forward', usage: 'forwardclear', platforms: ['whatsapp'] },
      { name: 'evoadmin', desc: 'Painel A/B + top cmds evolucao', usage: 'evoadmin', permission: 'owner' },
      { name: 'evoconfig', desc: 'Liga/desliga evolucao', usage: 'evoconfig on|off|…', permission: 'owner' },
      { name: 'evoreset', desc: 'Reset evolucao de um user', usage: 'evoreset me|<jid>', permission: 'owner' },
      { name: 'blockk', desc: 'Banir user do bot pra sempre (so sessao admin)', usage: 'blockk <id>', permission: 'platform_admin' },
      { name: 'unblockk', desc: 'Libera user banido por id (so sessao admin)', usage: 'unblockk <id>', permission: 'platform_admin' },
      { name: 'usuarios', desc: 'Lista quem falou com o bot (so sessao admin)', usage: 'usuarios [pagina]', permission: 'platform_admin' },
      { name: 'block', desc: 'Bloqueia user de usar cmds (reply/@/numero)', usage: 'block (responda | @ | numero)', platforms: ['whatsapp'] },
      { name: 'unblock', desc: 'Libera user pra usar cmds', usage: 'unblock (responda | @ | numero | indice | all)', platforms: ['whatsapp'] },
      { name: 'unblockall', desc: 'Libera todos os bloqueados de cmds', usage: 'unblockall', platforms: ['whatsapp'] },
      { name: 'blocklist', desc: 'Lista bloqueados de cmds (botoes pra liberar)', usage: 'blocklist', platforms: ['whatsapp'] },
      { name: 'bloquearcmd', desc: 'Desliga um comando em todos os grupos (todos menos o dono)', usage: 'bloquearcmd <comando>', platforms: ['whatsapp'] },
      { name: 'desbloquearcmd', desc: 'Liga de novo um comando em todos os grupos', usage: 'desbloquearcmd <comando>', platforms: ['whatsapp'] },
      { name: 'listablockcmd', desc: 'Lista comandos desligados nesta sessao', usage: 'listablockcmd', platforms: ['whatsapp'] },
      { name: 'tentativasinjecao', desc: 'Log de tentativas de injecao (dono)', usage: 'tentativasinjecao', platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'perfil',
    title: 'Perfil',
    desc: 'nome, bio, foto, block',
    items: [
      { name: 'setname', desc: 'Alterar nome', usage: 'setname <nome>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'setbio', desc: 'Alterar bio', usage: 'setbio <texto>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'setprofilepic', desc: 'Alterar foto', usage: 'setprofilepic <url>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'block', desc: 'Bloqueia user de usar cmds (reply/@/numero)', usage: 'block (responda | @ | numero)', platforms: ['whatsapp'] },
      { name: 'unblock', desc: 'Libera user pra usar cmds de novo', usage: 'unblock (responda | @ | numero | indice | all)', platforms: ['whatsapp'] },
      { name: 'unblockall', desc: 'Libera todos os bloqueados de cmds', usage: 'unblockall', platforms: ['whatsapp'] },
      { name: 'blocklist', desc: 'Lista quem nao pode usar cmds', usage: 'blocklist', platforms: ['whatsapp'] },
      { name: 'presence', desc: 'Presenca', usage: 'presence <typing|available>', needsArgs: true, platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'status',
    title: 'Status',
    desc: 'status WA / grupo',
    items: [
      { name: 'status', desc: 'Enviar status', usage: 'status <texto>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'statuspost', desc: 'Bandeja do grupo (membros|todos) ou status de canal', usage: 'statuspost [membros|todos|canal] <texto>', platforms: ['whatsapp'] },
      { name: 'paypost', desc: 'Cobranca nativa igual o statuspost: membros veem, admin nao. todos = todo mundo', usage: 'paypost [membros|todos] <texto>', platforms: ['whatsapp'] },
      { name: 'groupstatus', desc: 'Bandeja do grupo: texto/foto/video', usage: 'groupstatus [membros|todos] <texto>', platforms: ['whatsapp'] },
      { name: 'channelstatus', desc: 'Status de canal (24h)', usage: 'channelstatus [jid] <texto>', platforms: ['whatsapp'] },
      { name: 'closefriends', desc: 'Bandeja so membros + close friends', usage: 'closefriends <texto>', platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'enquetes',
    title: 'Enquetes',
    desc: 'poll',
    items: [
      { name: 'poll', desc: 'Criar enquete', usage: 'poll pergunta | op1,op2', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'pollresult', desc: 'Resultado (responda)', usage: 'pollresult', platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'agenda',
    title: 'Agendamentos',
    desc: 'schedule',
    items: [
      { name: 'schedule', desc: 'Agendar msg', usage: 'schedule <YYYY-MM-DD HH:mm> <texto>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'schedulelist', desc: 'Listar', usage: 'schedulelist', platforms: ['whatsapp'] },
      { name: 'schedulecancel', desc: 'Cancelar', usage: 'schedulecancel <id>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'scheduleclear', desc: 'Limpar todos', usage: 'scheduleclear', platforms: ['whatsapp'] }
    ]
  },
  {
    id: 'twilio',
    title: 'Twilio',
    desc: 'sms, otp, call, email',
    items: [
      { name: 'twiliomenu', desc: 'Menu Twilio', usage: 'twiliomenu' },
      { name: 'sms', desc: 'Enviar SMS', usage: 'sms <numero> <msg>', needsArgs: true },
      { name: 'otp', desc: 'Enviar OTP', usage: 'otp <numero> [sms|call]', needsArgs: true },
      { name: 'call', desc: 'Chamada TTS', usage: 'call <numero> <msg>', needsArgs: true },
      { name: 'email', desc: 'Email SendGrid', usage: 'email <dest> <assunto> <corpo>', needsArgs: true }
    ]
  },
  {
    id: 'admin',
    title: 'Admin',
    desc: 'logs, sessao, restart',
    hidden: true,
    items: [
      { name: 'menu_adm', desc: 'Menu Adm (grupo + sessao do dono)', usage: 'menu_adm' },
      { name: 'menu_admin', desc: 'Alias do Menu Adm', usage: 'menu_admin' },
      { name: 'logs', desc: 'Ver logs', usage: 'logs [n]' },
      { name: 'clearsession', desc: 'Limpar sessao', usage: 'clearsession', platforms: ['whatsapp'] },
      { name: 'repairsession', desc: 'Reparar sessao', usage: 'repairsession', platforms: ['whatsapp'] },
      { name: 'backupsession', desc: 'Backup sessao', usage: 'backupsession', platforms: ['whatsapp'] },
      { name: 'exportsession', desc: 'Exportar sessao', usage: 'exportsession', platforms: ['whatsapp'] },
      { name: 'importsession', desc: 'Importar sessao', usage: 'importsession', platforms: ['whatsapp'] },
      { name: 'restoresession', desc: 'Restaurar backup', usage: 'restoresession <path>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'badmac', desc: 'Bad MAC check', usage: 'badmac [clear]', platforms: ['whatsapp'] },
      { name: 'rr', desc: 'Reiniciar bot', usage: 'rr' },
      { name: 'pair', desc: 'Pairing code', usage: 'pair <numero>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'pairstatus', desc: 'Status pairing', usage: 'pairstatus', platforms: ['whatsapp'] },
      { name: 'paircancel', desc: 'Cancelar pairing', usage: 'paircancel', platforms: ['whatsapp'] },
      { name: 'addai', desc: 'Add Meta AI grupo', usage: 'addai', platforms: ['whatsapp'] },
      { name: 'host', desc: 'Menu host Raikken', usage: 'host' },
      { name: 'hoststatus', desc: 'CPU/RAM/disco da host', usage: 'hoststatus' },
      { name: 'hostrestart', desc: 'Restart container host', usage: 'hostrestart' },
      { name: 'hostconsole', desc: 'Console da host', usage: 'hostconsole' },
      { name: 'hostls', desc: 'Listar arquivos host', usage: 'hostls [pasta]' },
      { name: 'hostbackups', desc: 'Backups da host', usage: 'hostbackups' },
      { name: 'osint', desc: 'OSINT etico (dominio, nome, @user, email, GitHub). Sem alvo = exemplos.', usage: 'osint  |  osint exemplo.com  |  osint joao silva  |  osint @fulano', permission: 'owner' }
    ]
  },
  {
    id: 'tools',
    title: 'Ferramentas',
    desc: 'loop, fake, etc',
    items: [
      { name: 'startloop', desc: 'Iniciar loop', usage: 'startloop [ms] [tipo] [msg]', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'stoploop', desc: 'Parar loop', usage: 'stoploop', platforms: ['whatsapp'] },
      { name: 'statusloop', desc: 'Status loop', usage: 'statusloop', platforms: ['whatsapp'] },
      { name: 'adddest', desc: 'Add destinatario', usage: 'adddest <numero>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'remdest', desc: 'Rem destinatario', usage: 'remdest <numero>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'lista', desc: 'Listar destinos', usage: 'lista', platforms: ['whatsapp'] },
      { name: 'fakemsg', desc: 'Fake edit (responda) ou fakechat texto|resposta', usage: 'fakemsg <texto> | fakemsg a|b', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'fakechat', desc: 'Alias fakemsg com | (bolha citada falsa)', usage: 'fakechat texto fake|resposta', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'fake', desc: 'Fake edit midia', usage: 'fake <legenda>', needsArgs: true, platforms: ['whatsapp'] },
      { name: 'cotacao', desc: 'Dolar / euro / BTC em BRL', usage: 'cotacao [USD|EUR|BTC]' },
      { name: 'encurta', desc: 'Encurta URL', usage: 'encurta <url>', needsArgs: true },
      { name: 'qr', desc: 'Gera QR Code', usage: 'qr <texto>', needsArgs: true },
      { name: 'lerqr', desc: 'Le QR de uma foto', usage: 'lerqr (responda foto)' },
      { name: 'calc', desc: 'Calculadora', usage: 'calc <expressao>', needsArgs: true },
      { name: 'walink', desc: 'Monta link wa.me', usage: 'walink <numero> [texto]', needsArgs: true },
      { name: 'placar', desc: 'Placar de jogo / time', usage: 'placar <time>', needsArgs: true },
      { name: 'forca', desc: 'Jogo da forca', usage: 'forca [letra]' },
      { name: 'ppt', desc: 'Pedra papel tesoura', usage: 'ppt pedra|papel|tesoura', needsArgs: true },
      { name: 'dado', desc: 'Rola um dado', usage: 'dado' },
      { name: 'roleta', desc: 'Sorteia um nome', usage: 'roleta a | b | c', needsArgs: true },
      { name: 'minado', desc: 'Campo minado 5x5', usage: 'minado [A1]' },
      { name: 'plantar', desc: 'Planta, rega e colhe', usage: 'plantar | regar | colher' },
      { name: 'casar', desc: 'Casa com alguem (marque)', usage: 'casar @alguem' },
      { name: 'beijar', desc: 'Beija (marque ou responda)', usage: 'beijar @alguem' },
      { name: 'flerte', desc: 'Flerte aleatorio', usage: 'flerte [@alguem]' },
      { name: 'eununca', desc: 'Eu nunca', usage: 'eununca' },
      { name: 'vdb', desc: 'Verdade ou desafio', usage: 'vdb verdade|desafio' },
      { name: 'piada', desc: 'Piada curta', usage: 'piada' }
    ]
  },
  {
    id: 'exploits',
    title: 'Travas',
    desc: 'Crash, atraso, travazap (dono da sessao)',
    items: [
      // permission owner: dono da sessao ve no menu (gate de execucao ja libera dono)
      { name: 'menu_exploits', desc: 'Abrir menu de travas', usage: 'menu_exploits', platforms: ['whatsapp'], permission: 'owner' },
      { name: 'bugchat', desc: 'Bug chat', usage: 'bugchat <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'crashios', desc: 'Crash iOS', usage: 'crashios <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'atraso', desc: 'Atraso / trava', usage: 'atraso <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'atraso_status', desc: 'Atraso status', usage: 'atraso_status <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'nullatraso', desc: 'Null atraso', usage: 'nullatraso <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'atraso2', desc: 'Atraso 2 (carousel)', usage: 'atraso2 <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'convite', desc: 'Convite bugado', usage: 'convite <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'carrinho', desc: 'Carrinho bugado', usage: 'carrinho <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'sistema', desc: 'Sistema bug', usage: 'sistema <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'sistema2', desc: 'Sistema 2', usage: 'sistema2 <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'fotobutton', desc: 'Foto button', usage: 'fotobutton <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'listloc', desc: 'List location', usage: 'listloc <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'wppexe', desc: 'Congelar WPP Exe', usage: 'wppexe <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'wppweb', desc: 'Congelar WPP Web', usage: 'wppweb <numero>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'crashgp', desc: 'Crash grupo', usage: 'crashgp <gid>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'atrasogp', desc: 'Atraso grupo', usage: 'atrasogp <gid>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'fotogp', desc: 'Foto bug grupo', usage: 'fotogp <gid>', needsArgs: true, platforms: ['whatsapp'], permission: 'owner' },
      { name: 'travazap', desc: 'Travazap', usage: 'travazap <texto> [n]', needsArgs: true, permission: 'owner' },
      { name: 'ddos', desc: 'Stress test ab', usage: 'ddos <url> [n] [c]', needsArgs: true, permission: 'owner' },
      { name: 'crash', desc: 'Simular crash', usage: 'crash', permission: 'owner' },
      { name: 'cancelar', desc: 'Cancelar step', usage: 'cancelar', platforms: ['whatsapp'], permission: 'owner' }
    ]
  },
  {
    id: 'host',
    title: 'Host',
    desc: 'Painel, restart, arquivos, backup',
    items: [
      { name: 'host', desc: 'Menu host', usage: 'host' },
      { name: 'hostmenu', desc: 'Alias menu host', usage: 'hostmenu' },
      { name: 'raikken', desc: 'Alias menu host', usage: 'raikken' },
      { name: 'hoststatus', desc: 'CPU/RAM/disco', usage: 'hoststatus' },
      { name: 'hostinfo', desc: 'Alias status', usage: 'hostinfo' },
      { name: 'hoststart', desc: 'Ligar container', usage: 'hoststart' },
      { name: 'hoststop', desc: 'Parar container', usage: 'hoststop' },
      { name: 'hostrestart', desc: 'Reiniciar container', usage: 'hostrestart' },
      { name: 'hostkill', desc: 'Kill processo', usage: 'hostkill' },
      { name: 'hostcmd', desc: 'Comando no console', usage: 'hostcmd <cmd>', needsArgs: true },
      { name: 'hostconsole', desc: 'Console da host', usage: 'hostconsole' },
      { name: 'hostls', desc: 'Listar arquivos', usage: 'hostls [pasta]' },
      { name: 'hostcat', desc: 'Ler arquivo', usage: 'hostcat <arquivo>', needsArgs: true },
      { name: 'hostwrite', desc: 'Escrever arquivo', usage: 'hostwrite <arq> <txt>', needsArgs: true },
      { name: 'hostmkdir', desc: 'Criar pasta', usage: 'hostmkdir <pasta>', needsArgs: true },
      { name: 'hostrm', desc: 'Remover arquivo', usage: 'hostrm <path>', needsArgs: true },
      { name: 'hostrename', desc: 'Renomear', usage: 'hostrename <a> <b>', needsArgs: true },
      { name: 'hostcp', desc: 'Copiar', usage: 'hostcp <a> <b>', needsArgs: true },
      { name: 'hostzip', desc: 'Zipar', usage: 'hostzip <path>', needsArgs: true },
      { name: 'hostunzip', desc: 'Deszipar', usage: 'hostunzip <zip>', needsArgs: true },
      { name: 'hostpull', desc: 'Baixar URL na host', usage: 'hostpull <url>', needsArgs: true },
      { name: 'hostdl', desc: 'Download arquivo', usage: 'hostdl <path>', needsArgs: true },
      { name: 'hostbackups', desc: 'Listar backups', usage: 'hostbackups' },
      { name: 'hostbackup', desc: 'Criar backup', usage: 'hostbackup [nome]' },
      { name: 'hostbackupdel', desc: 'Apagar backup', usage: 'hostbackupdel <id>', needsArgs: true },
      { name: 'hostbackuprestore', desc: 'Restaurar backup', usage: 'hostbackuprestore <id>', needsArgs: true },
      { name: 'hostnet', desc: 'Rede / portas', usage: 'hostnet' },
      { name: 'hoststartup', desc: 'Vars de startup', usage: 'hoststartup' },
      { name: 'hostsetvar', desc: 'Setar var startup', usage: 'hostsetvar <k> <v>', needsArgs: true },
      { name: 'hostactivity', desc: 'Activity log', usage: 'hostactivity' },
      { name: 'hostdb', desc: 'DB info', usage: 'hostdb' },
      { name: 'hostusers', desc: 'Users painel', usage: 'hostusers' },
      { name: 'hostschedules', desc: 'Schedules', usage: 'hostschedules' },
      { name: 'hostaccount', desc: 'Conta painel', usage: 'hostaccount' },
      { name: 'hostservers', desc: 'Lista servers', usage: 'hostservers' },
      { name: 'hostapikeys', desc: 'API keys', usage: 'hostapikeys' },
      { name: 'hostrenameserver', desc: 'Renomear server', usage: 'hostrenameserver <nome>', needsArgs: true },
      { name: 'hostreinstall', desc: 'Reinstall server', usage: 'hostreinstall' }
    ]
  }
];

const DIV_AUTO_CMDS = [
  'divauto',
  'divconfigauto',
  'divconfigautomodos',
  'divcriagrupo',
  'divautocriar',
  'divconfigmingrupos',
  'divconfigcriagrupo'
];
const DIV_AUTO_SET = new Set(DIV_AUTO_CMDS);

function pinDivulgacaoAutoItems(catalog) {
  const cat = (catalog || []).find((c) => c && c.id === 'divulgacao');
  if (!cat || !Array.isArray(cat.items)) return;
  const autoMap = new Map();
  const rest = [];
  for (const it of cat.items) {
    const n = String(it.name || '');
    if (DIV_AUTO_SET.has(n)) autoMap.set(n, it);
    else rest.push(it);
  }
  const auto = DIV_AUTO_CMDS.map((n) => autoMap.get(n)).filter(Boolean);
  const menu = rest.filter((i) => i.name === 'divmenu');
  const gm = rest.filter((i) => i.name === 'grupos');
  const other = rest.filter((i) => i.name !== 'divmenu' && i.name !== 'grupos');
  cat.items = [...menu, ...gm, ...auto, ...other];
}

// Taxonomia unica: remapeia CATALOG bruto → categorias de topo (1 cmd = 1 cat)
const {
  rebuildCatalog,
  CATEGORY_ENTRY: TAX_ENTRY,
  MENU_CAT_ORDER: TAX_ORDER
} = require('./menuTaxonomy');
const CATALOG_RAW = CATALOG;
const CATALOG_REBUILT = rebuildCatalog(CATALOG_RAW);
// Mutate in place so existing `const CATALOG` bindings... wait, CATALOG is const array - we need to replace contents
CATALOG.length = 0;
for (const c of CATALOG_REBUILT) CATALOG.push(c);
pinDivulgacaoAutoItems(CATALOG);

/** Comandos nativos no Telegram (slash), sem precisar sessao WA */
const TG_NATIVE_CMDS = new Set([
  'menu', 'ping', 'stats', 'comandos', 'tutorial', 'novidades',
  'sobre', 'dono', 'comprar', 'planos', 'preco', 'ownerinfo',
  'download', 'play', 'ytmp3', 'playvideo', 'ytmp4', 'tiktok', 'instagram', 'facebook', 'spotify', 'soundcloud', 'mediafire', 'twitter', 'kwai', 'threads', 'capcut', 'pinterest', 'ytsearch',
  'menu_consultas', 'consulta',
  'google', 'pesquisar', 'deepsearch', 'analisar', 'relatorio', 'glista', 'gopen', 'gcopy', 'glimpar',
  'gitsearch', 'github', 'repo',
  'twiliomenu', 'sms', 'otp', 'call', 'email',
  'setprefix', 'addowner', 'removeowner', 'listowners',
  'addvip', 'removevip', 'tirarvip', 'listvips',
  'addblacklist', 'removeblacklist', 'listblacklist',
  'logs', 'rr', 'travazap', 'ddos', 'crash',
  // Hanork API (catalogo + menus) — nativo no TG via shim
  'hanork', 'hanorkinfo', 'zt', 'ztinfo',
  'menu_hanorkdownloads', 'menu_hanorkpesquisas', 'menu_hanorkmontagem', 'menu_hanorklogos',
  'menu_hanorkanimes', 'menu_hanorkwallpapers', 'menu_hanorkfigurinhas', 'menu_hanorkcanvas',
  'menu_hanorkias', 'menu_hanorkdoramas', 'menu_hanorkmangas', 'menu_hanorkanichin',
  'menu_hanorkencontrei', 'menu_hanorkmcpedl', 'menu_hanorkoutros', 'menu_hanorkjogos', 'menu_hanorkupload',
  'menu_hanorkconsultas', 'menu_hanorktinder',
  // Config nuke no TG (execucao nuke continua [WA])
  'nukename', 'nukedesc', 'nukemsg', 'nukeimg', 'nukeconfig', 'nukereset',
  'grupos', 'grupolista', 'grupoconfig', 'grupoentrar', 'gruposair', 'divgrupos'
]);

/** Label TG: nativo se estiver no set OU for cmd do catalogo Hanork API */
function isTelegramNativeLabel(name) {
  const n = String(name || '').toLowerCase();
  if (TG_NATIVE_CMDS.has(n)) return true;
  if (n.startsWith('menu_hanork') || n.startsWith('menu_zt')) return true;
  try {
    const { getCommand } = require('../commands');
    const cmd = getCommand(n);
    return !!(cmd && cmd.ztEntry);
  } catch (_) {
    return false;
  }
}

function findItem(name) {
  const n = String(name || '');
  if (!n) return null;
  let apiHit = null;
  for (const cat of CATALOG) {
    const it = (cat.items || []).find((i) => i.name === n);
    if (!it) continue;
    const hit = { ...it, categoryId: cat.id, categoryTitle: cat.title, platformAdminOnly: !!cat.platformAdminOnly };
    if (isHanorkApiSubcategory(cat)) {
      if (!apiHit) apiHit = hit;
      continue;
    }
    return hit;
  }
  return apiHit;
}

function forPlatform(platform) {
  return CATALOG.map((cat) => ({
    ...cat,
    items: (cat.items || []).filter((it) => {
      const plats = it.platforms || ['whatsapp', 'telegram'];
      return plats.includes(platform);
    })
  })).filter((cat) => cat.items.length > 0);
}

function getCategory(id) {
  return CATALOG.find((c) => c.id === id) || null;
}

/** Label visual: prefixo + comando na frente (menus WA/TG/texto) */
function cmdFront(prefix, name, usage) {
  const p = prefix || '.';
  const n = String(name || '').trim().replace(/^[.\/!#•$]+/, '');
  if (!n) return p;
  const u = String(usage || n).trim().replace(/^[.\/!#•$]+/, '');
  if (u === n || u.startsWith(`${n} `) || u.startsWith(`${n}<`) || u.startsWith(`${n}(`)) {
    return `${p}${u}`;
  }
  return `${p}${n}`;
}

function waSectionsForMain(prefix = '.', viewerRole = null, opts = {}) {
  const p = prefix || '.';
  // Estilo GitHub: varias sections de ate 9 cats na MESMA mensagem (1 send)
  const priority = [
    'downloads', 'consultas', 'figurinhas', 'ia',
    'grupo_seg', 'grupo_mod', 'grupo_entrada', 'grupo_config',
    'divulgacao', 'diversao', 'utilidades', 'admin', 'exploits'
  ];
  const cats = rootMenuCategories('whatsapp', viewerRole, opts).filter((c) => c.id !== 'geral');
  const ordered = [
    ...priority.map((id) => cats.find((c) => c.id === id)).filter(Boolean),
    ...cats.filter((c) => !priority.includes(c.id))
  ];
  const chunks = [];
  for (let i = 0; i < ordered.length; i += 9) {
    chunks.push(ordered.slice(i, i + 9));
  }
  if (!chunks.length) return [];
  return chunks.map((chunk, idx) => ({
    title: chunks.length > 1 ? (idx === 0 ? 'Categorias' : 'Mais categorias') : 'Categorias',
    rows: chunk.map((cat) => {
      const entry = categoryEntryCommand(cat);
      const tip = entry ? cmdFront(p, entry) : `${p}comandos`;
      return {
        title: String(cat.title || cat.id),
        description: stripAccents(`${tip} — ${cat.desc || ''}`).slice(0, 72),
        id: `menu_cat_${cat.id}`
      };
    })
  }));
}

/**
 * Chunk por section (estilo GH). Uma mensagem pode ter N sections;
 * cliente WA pode mostrar so ~10 rows totais — ainda assim 1 send (sem flood 1/N).
 */
const WA_LIST_MAX_ROWS = 10;

function categoryItemsForWa(catId, viewerRole = null, opts = {}) {
  const cat = getCategory(catId);
  if (!cat) return [];
  let items = (cat.items || []).filter((it) => !(it.platforms) || it.platforms.includes('whatsapp'));
  items = filterItemsByRole(items, viewerRole, opts);
  if (String(catId).startsWith('hanork_') && catId !== 'hanorkapi') {
    if (!HANORK_READY_CAT_IDS.has(catId)) return [];
  }
  if (catId === 'ia' || catId === 'hanorkapi') {
    items = filterHanorkHubItems(items);
  }
  return items;
}

/** Nome curto so na UI (ID interno permanece). */
function displayCmdLabel(name) {
  const n = String(name || '').trim();
  if (n.startsWith('menu_hanork')) {
    const short = n.slice('menu_hanork'.length);
    return short || n;
  }
  if (n.startsWith('menu_')) return n.slice(5) || n;
  return n;
}

function rowFromCatalogItem(it, prefix = '.') {
  const p = prefix || '.';
  const label = displayCmdLabel(it.name);
  const front = cmdFront(p, it.name, it.usage);
  const n = String(it.name || '');
  let id;
  if (n === 'grupos' || n === 'divgrupos') id = 'gm_home';
  else if (n === 'grupolista') id = 'gm_active';
  else if (n === 'grupoconfig') id = 'gm_limits';
  else if (n === 'grupoentrar') id = 'gm_join_1';
  else if (n === 'gruposair') id = 'gm_leave_1';
  else if (n === 'menu_dono' || n === 'menudono' || n === 'menu_adm' || n === 'menuadm' || n === 'menu_dk' || n === 'dkmenu' || n === 'menudk') id = `cmd_${n}`;
  else if (n.startsWith('menu_')) id = `menu_cat_${MENU_ID_TO_CAT[n] || n}`;
  else id = `cmd_${n}`;
  return {
    title: `${p}${label}`.slice(0, 24),
    description: stripAccents(applyLivePrefix(it.desc || front || '', p)).slice(0, 72),
    id
  };
}

/** Sections multiplas na mesma lista (1 mensagem). */
function waSectionsForCategory(catId, prefix = '.', viewerRole = null, maxItems = WA_LIST_MAX_ROWS, opts = {}) {
  const cat = getCategory(catId);
  if (!cat) return null;
  const items = categoryItemsForWa(catId, viewerRole, opts);
  if (!items.length) return null;

  const per = Math.min(WA_LIST_MAX_ROWS, Math.max(1, maxItems));
  const chunkToSections = (list, firstTitle, moreTitle) => {
    const chunks = [];
    for (let i = 0; i < list.length; i += per) chunks.push(list.slice(i, i + per));
    return chunks.map((chunk, idx) => ({
      title: chunks.length > 1
        ? (idx === 0 ? firstTitle : moreTitle)
        : firstTitle,
      rows: chunk.map((it) => rowFromCatalogItem(it, prefix))
    }));
  };

  if (catId === 'consultas') {
    const ficha = new Set(['cpf', 'cpfcompleto', 'nome', 'telefone', 'placa']);
    const dossie = new Set(['cpffull', 'buscanome', 'celular', 'placafull', 'cnpjfull']);
    const extra = new Set(['cep', 'cnpj', 'ip', 'ttkstalk', 'infoff', 'likeff']);
    const buckets = { Ficha: [], Dossie: [], Extra: [], Mais: [] };
    for (const it of items) {
      const n = String(it.name || '');
      if (n === 'menu_consultas' || n === 'consulta') continue;
      if (ficha.has(n)) buckets.Ficha.push(it);
      else if (dossie.has(n)) buckets.Dossie.push(it);
      else if (extra.has(n)) buckets.Extra.push(it);
      else buckets.Mais.push(it);
    }
    const sections = [];
    for (const title of ['Ficha', 'Dossie', 'Extra', 'Mais']) {
      if (!buckets[title].length) continue;
      sections.push(...chunkToSections(buckets[title], title, `${title} 2`));
    }
    return sections.length ? sections : null;
  }

  if (catId === 'divulgacao') {
    const auto = [];
    const rest = [];
    for (const it of items) {
      if (DIV_AUTO_SET.has(String(it.name))) auto.push(it);
      else rest.push(it);
    }
    auto.sort((a, b) => DIV_AUTO_CMDS.indexOf(a.name) - DIV_AUTO_CMDS.indexOf(b.name));
    const sections = [];
    if (auto.length) {
      sections.push({
        title: 'Automatica',
        rows: auto.map((it) => rowFromCatalogItem(it, prefix))
      });
    }
    sections.push(...chunkToSections(rest, String(cat.title || catId), 'Mais'));
    return sections.length ? sections : null;
  }

  return chunkToSections(items, String(cat.title || catId), 'Mais');
}

/**
 * Compat: devolve array de pages; preferir waSectionsForCategory em 1 send.
 */
function waSectionPagesForCategory(catId, prefix = '.', viewerRole = null, opts = {}) {
  const sections = waSectionsForCategory(catId, prefix, viewerRole, WA_LIST_MAX_ROWS, opts);
  if (!sections || !sections.length) return [];
  // Uma "page" = todas as sections (1 mensagem)
  return [sections];
}

function tgMainButtons(isAdminUser, isPlatformAdmin, viewerRole = 'user', opts = {}) {
  const L = (t) => stripAccents(String(t || '')).trim();
  const hasSession = !!(opts && opts.hasSession);
  const productTier = String((opts && opts.productTier) || '').toLowerCase();
  let canDiv = false;
  try {
    const { hasTier } = require('../services/billing/logic');
    canDiv = hasTier(productTier || 'free', 'pro');
  } catch (_) { canDiv = false; }
  const isOwner = !!(
    isAdminUser ||
    isPlatformAdmin ||
    viewerRole === 'owner' ||
    viewerRole === 'platform_admin'
  );
  if (isOwner) canDiv = true;
  const isVipLike = viewerRole === 'vip' || canDiv;
  let paywallOn = true;
  try {
    paywallOn = require('./paywall').isPaywallActive({
      telegramUserId: opts.telegramUserId || opts.userId || ''
    });
  } catch (_) { /* */ }
  const btns = [];
  if (isAdminUser || isPlatformAdmin) {
    btns.push([{ text: L('Painel'), callback_data: 'menu_admin' }]);
    btns.push([
      { text: L('Conectar'), callback_data: 'menu_sessions' },
      { text: L('Contas'), callback_data: 'admin_list_all' }
    ]);
    btns.push([{ text: L('Usuarios'), callback_data: 'admin_list_users' }]);
    if (paywallOn) {
      btns.push([{ text: L('Comprar / Planos'), callback_data: 'bill_home' }]);
    }
  } else {
    if (paywallOn && !isOwner && !isVipLike && !hasSession) {
      btns.push([{ text: L('Comprar'), callback_data: 'bill_home' }]);
    }
    btns.push([{ text: L('Conectar'), callback_data: 'menu_sessions' }]);
    if (hasSession) {
      btns.push([{ text: L('Proteger grupo'), callback_data: 'shop_protect' }]);
    }
  }
  if (canDiv) {
    btns.push([{ text: L('Divulgacao'), callback_data: 'menu_divulgacao' }]);
  }
  if (isOwner || isVipLike) {
    btns.push([{ text: L('Cuidar dos grupos'), callback_data: 'gm_home' }]);
  }
  if (isOwner) {
    btns.push([{ text: L('Configuracao'), callback_data: 'admin_config' }]);
    btns.push([{ text: L('Nuke'), callback_data: 'menu_nuke' }]);
  }
  if (paywallOn && !(isAdminUser || isPlatformAdmin)) {
    btns.push([{ text: L('Comprar'), callback_data: 'bill_home' }]);
    btns.push([{ text: L('Suporte'), callback_data: 'bill_suporte' }]);
  }
  btns.push([{ text: L('Fechar'), callback_data: 'close' }]);
  return btns;
}

/** Legado: menu "mais" nao polui mais — so volta */
function tgMoreButtons(_isPlatformAdmin) {
  const L = (t) => stripAccents(String(t || '')).trim();
  return [[{ text: L('Voltar'), callback_data: 'menu_main' }]];
}

function tgCategoryKeyboard(catId, prefixHint = '.', viewerRole = 'owner', opts = {}) {
  const cat = getCategory(catId);
  if (!cat) return [[{ text: 'Voltar', callback_data: 'menu_main' }]];
  let items = filterItemsByRole(cat.items || [], viewerRole, opts);

  // Hub API: so categorias ja usadas de verdade (resto do catalogo continua registrado)
  if (catId === 'ia' || catId === 'hanorkapi') {
    items = filterHanorkHubItems(items);
  }

  // Inline keyboard TG: ~100 botoes. Menus grandes = hubs menu_* + amostra
  const MAX_BTNS = 48;
  if (items.length > MAX_BTNS) {
    const hubs = items.filter((it) => String(it.name).startsWith('menu_'));
    if (hubs.length) {
      items = hubs.slice(0, MAX_BTNS);
    } else {
      items = items.slice(0, MAX_BTNS);
    }
  }
  const btns = [];
  for (let i = 0; i < items.length; i += 2) {
    const row = [];
    const a = items[i];
    const prefA = '/';
    const tagA = isTelegramNativeLabel(a.name) ? '' : ' [WA]';
    const cbA = String(a.name).startsWith('menu_hanork')
      ? `tg_cat_${MENU_ID_TO_CAT[a.name] || a.name}`
      : `tg_cmd_${a.name}`;
    row.push({
      text: `${prefA}${a.name}${tagA}`.slice(0, 64),
      callback_data: cbA
    });
    if (items[i + 1]) {
      const b = items[i + 1];
      const prefB = '/';
      const tagB = isTelegramNativeLabel(b.name) ? '' : ' [WA]';
      const cbB = String(b.name).startsWith('menu_hanork')
        ? `tg_cat_${MENU_ID_TO_CAT[b.name] || b.name}`
        : `tg_cmd_${b.name}`;
      row.push({
        text: `${prefB}${b.name}${tagB}`.slice(0, 64),
        callback_data: cbB
      });
    }
    btns.push(row);
  }
  if (isHanorkApiSubcategory(catId)) {
    btns.push([{ text: 'Voltar API', callback_data: 'tg_cat_hanorkapi' }]);
  }
  btns.push([{ text: 'Voltar', callback_data: 'menu_main' }]);
  return btns;
}

function tgCategoryText(catId, prefixHint = '.') {
  const cat = getCategory(catId);
  if (!cat) return stripAccents('Categoria nao encontrada.');
  const hint = fillPrefixHint(CATEGORY_HINTS[catId] || '', '/');
  const lines = [
    menuHeading(cat.title),
    stripAccents(cat.desc || ''),
    hint ? stripAccents(hint) : '',
    '',
    stripAccents(`Comandos (${(cat.items || []).length}) — digite /comando`)
  ].filter(Boolean);
  for (const it of (cat.items || [])) {
    const tag = isTelegramNativeLabel(it.name) ? '' : ' [WA]';
    const desc = stripAccents(it.desc || '').slice(0, 42);
    const front = `${cmdFront('/', it.name, it.usage)}${tag}`;
    lines.push(desc ? `${front} — ${desc}` : front);
  }
  return lines.join('\n');
}

function textMenuFallback(platform = 'whatsapp', prefix = '.', viewerRole = null, opts = {}) {
  const p = platform === 'telegram' ? '/' : (prefix || '.');
  // Lista longa (.comandos): root + hub API (sem expandir 750 cmds ZT)
  const cats = [
    ...rootMenuCategories(platform, viewerRole, opts),
    ...CATALOG.filter((c) => isHanorkApiSubcategory(c) && (!viewerRole || categoryVisibleForRole(c, viewerRole, opts)))
  ];
  const seen = new Set();
  const lines = [];
  lines.push(menuHeading('Hanork — lista de comandos'));
  lines.push(stripAccents(`Prefixo: ${p}`));
  lines.push(stripAccents(`API: ${p}hanorkapi (categorias interativas)`));
  lines.push('');

  for (const cat of cats) {
    let items = filterItemsByRole(cat.items || [], viewerRole, opts);
    if (!items.length) continue;
    // Subcategoria API: so a entrada menu_hanork* (nao todos os endpoints)
    if (isHanorkApiSubcategory(cat)) {
      items = items.filter((it) => String(it.name).startsWith('menu_hanork')).slice(0, 1);
      if (!items.length) continue;
    }
    if (cat.id === 'ia' || cat.id === 'hanorkapi') {
      items = filterHanorkHubItems(items);
    }
    lines.push(menuHeading(String(cat.title || cat.id).toUpperCase()));
    for (const it of items) {
      seen.add(it.name);
      const tag = platform === 'telegram' && !isTelegramNativeLabel(it.name) ? ' [WA]' : '';
      const front = cmdFront(p, it.name, it.usage);
      const desc = stripAccents(applyLivePrefix(it.desc || '', p)).slice(0, 48);
      lines.push(`${front}${tag}${desc ? ` — ${desc}` : ''}`);
    }
    lines.push('');
  }

  if (!viewerRole || viewerRole === 'owner' || viewerRole === 'platform_admin') {
    try {
      const { listCommands } = require('../commands');
      const missing = listCommands().filter((n) => !seen.has(n) && !String(n).startsWith('step_'));
      if (missing.length) {
        lines.push(menuHeading('OUTROS'));
        for (const name of missing.sort()) {
          if (viewerRole && !roleCanSee(viewerRole, resolveCmdLevel(name), opts)) continue;
          lines.push(`${p}${name}`);
        }
        lines.push('');
      }
    } catch (_) {}
  }

  lines.push(stripAccents(`Voltar: ${p}menu`));
  return lines.join('\n');
}

/**
 * Comando que abre a categoria (fluxo estilo Zero Two: .menu → .download → cmds).
 * Preferir menu_* / painel dedicado quando existir.
 */
const CATEGORY_ENTRY = {
  ...TAX_ENTRY,
  // legado / aliases de entrada
  mensagens: 'menu_utilidades',
  antiflood: 'gpseguranca',
  grupos: 'grupos',
  hanorkapi: 'hanork',
  webia: 'menu_diversao',
  github: 'menu_diversao',
  nuke: 'nuke',
  interativos: 'menu_utilidades',
  canais: 'menu_utilidades',
  botoes: 'buttonmode',
  config: 'menu_adm',
  admin: 'menu_adm',
  perfil: 'menu_utilidades',
  status: 'menu_utilidades',
  enquetes: 'menu_diversao',
  agenda: 'menu_utilidades',
  twilio: 'menu_utilidades',
  tools: 'menu_diversao',
  host: 'host'
};

/** Ordem amigavel no menu principal (taxonomia unica) */
const MENU_CAT_ORDER = TAX_ORDER.length
  ? TAX_ORDER
  : [
      'geral', 'downloads', 'consultas', 'figurinhas', 'ia',
      'grupo_mod', 'grupo_seg', 'grupo_entrada', 'grupo_config', 'divulgacao',
      'diversao', 'utilidades', 'admin', 'exploits'
    ];

/** Categorias Hanork API (hanork_*) — NAO aparecem no menu principal */
function isHanorkApiSubcategory(catOrId) {
  const id = typeof catOrId === 'string' ? catOrId : catOrId?.id;
  return String(id || '').startsWith('hanork_');
}

/** So categorias do root (ordem MENU_CAT_ORDER) — sem poluir com 21 buckets ZT */
function rootMenuCategories(platform = 'whatsapp', viewerRole = null, opts = {}) {
  const allowed = new Set(MENU_CAT_ORDER);
  let cats = forPlatform(platform).filter(
    (c) => allowed.has(c.id) && !isHanorkApiSubcategory(c) && !c.hidden && c.id !== 'admin'
  );
  if (viewerRole) cats = cats.filter((c) => categoryVisibleForRole(c, viewerRole, opts));
  const r = String(viewerRole || '');
  if (r === 'user') {
    const hide = new Set(['hanorkapi', 'ia', 'consultas', 'divulgacao', 'exploits', 'admin']);
    cats = cats.filter((c) => !hide.has(c.id));
  } else if (r === 'vip') {
    const hide = new Set(['hanorkapi', 'ia', 'exploits', 'admin']);
    cats = cats.filter((c) => !hide.has(c.id));
  }
  return sortCatsForMenu(cats);
}

function categoryEntryCommand(cat) {
  if (!cat) return null;
  return CATEGORY_ENTRY[cat.id] || cat.items?.[0]?.name || null;
}

function sortCatsForMenu(cats) {
  const rank = new Map(MENU_CAT_ORDER.map((id, i) => [id, i]));
  return [...cats].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : 100;
    const rb = rank.has(b.id) ? rank.get(b.id) : 100;
    if (ra !== rb) return ra - rb;
    return String(a.title || a.id).localeCompare(String(b.title || b.id));
  });
}

/**
 * Indice de categorias (igual GitHub / fluxo ZT):
 * .menu → categorias → digite o cmd da categoria pra ver os cmds.
 */
function textMenuCompact(platform = 'whatsapp', prefix = '.', viewerRole = null, opts = {}) {
  const p = platform === 'telegram' ? '/' : (prefix || '.');
  const cats = rootMenuCategories(platform, viewerRole, opts);

  const lines = [
    menuHeading('Hanork'),
    menuHeading(`Prefixo: ${p}`),
    '',
    menuHeading('Abra uma categoria digitando o comando:')
  ];

  for (const cat of cats) {
    if (cat.id === 'geral') continue;
    const entry = categoryEntryCommand(cat);
    if (!entry) continue;
    const title = menuHeading(cat.title || cat.id);
    const short = displayCmdLabel(entry);
    lines.push(menuHeading(`${p}${short}  ${cat.title || cat.id}`));
  }

  lines.push('');
  lines.push(menuHeading('Mais usados:'));
  lines.push(menuHeading(`${p}play <musica>`));
  lines.push(menuHeading(`${p}tiktok <link>`));
  lines.push(menuHeading(`${p}instagram <link>`));
  lines.push(menuHeading(`${p}ping`));
  // Unico painel de seguranca = .gpseguranca (dono, adm, ou vip que tambem e admin deste grupo)
  if (!viewerRole || roleCanSee(viewerRole, 'adm', opts)) {
    lines.push(menuHeading(`${p}menu_adm  Menu Adm`));
    lines.push(menuHeading(`${p}gpseguranca  Grupo Seg`));
  }
  lines.push(menuHeading(`${p}figurinha  Figurinhas`));
  if (!viewerRole || roleCanSee(viewerRole, 'owner', opts)) {
    lines.push(menuHeading(`${p}menu_dk  Menu DK`));
    lines.push(menuHeading(`${p}menu_dono  Menu Dono`));
    lines.push(menuHeading(`${p}menu_exploits  Travas`));
    lines.push(menuHeading(`${p}host  Host`));
  }
  lines.push('');
  lines.push(menuHeading(`Lista completa: ${p}comandos`));
  lines.push(menuHeading(`Voltar aqui: ${p}menu`));
  return lines.join('\n');
}

/** Dicas extras por categoria — use {p} para o prefixo atual do Zap */
const CATEGORY_HINTS = {
  downloads: 'Baixa midia. Ex: {p}play nome da musica',
  ia: 'Pergunta pra IA: {p}hanork sua pergunta · Mais ferramentas: {p}hanorkapi',
  hanorkapi: 'Abra uma categoria. Chat: {p}hanork pergunta',
  figurinhas: 'No canal: {p}figurinha · Figurinha rapida: {p}s (responda a foto)',
  grupo_seg: 'No grupo: {p}gpseguranca. Anti-roubo: {p}antiroubo / {p}donogrupo',
  grupo_mod: 'Ban, mute, mencionar. Ex: {p}ban (responda) · {p}bantmp 1h · {p}cita (responda)',
  grupo_entrada: 'Pedidos: {p}aceitar / {p}recusar · Auto: {p}autoaceitar on · {p}autoconvite on',
  consultas: '{p}menu_consultas lista tudo. Ficha: {p}cpf {p}nome {p}telefone {p}placa',
  diversao: 'Jogos e busca. Ex: {p}google termo · {p}forca',
  utilidades: 'QR, conta, cotacao. Ex: {p}qr texto · {p}calc 12*8',
  grupo_config: 'Nome, link, abrir e fechar. Ex: {p}groupinfo · {p}fechargp · {p}fecharas 22:00',
  antiflood: 'No grupo: {p}gpseguranca. O que esta ligado: {p}protecoesativas',
  nuke: 'CUIDADO: remove membros. Configure antes com {p}nukeconfig',
  grupos: 'Admin do grupo ou dono da sessao. Responda a mensagem ou informe o numero.',
  divulgacao: 'Divulgacao em massa: {p}divmenu. DK (isolado): {p}menu_dk {p}dk {p}entrardk',
  webia: 'Busca na internet. Ex: {p}google termo',
  mensagens: 'Figurinhas no canal: {p}figurinha · Criar: {p}s (responda foto)',
  interativos: 'Botoes e listas. Precisa de botoes ligados.',
  canais: 'Canais do WhatsApp. Ex: {p}createchannel nome',
  botoes: 'ON = menus com lista. OFF = texto.',
  config: 'Prefixo, donos, VIP, lista negra, canal.',
  admin: 'Menu Adm do grupo. Ex: {p}menu_adm',
  tools: 'Utilitarios.',
  exploits: 'Travas — so o dono da plataforma. Uso indevido pode banir o numero. Ex: {p}atraso numero',
  host: 'Controle da maquina. Ex: {p}hoststatus',
  github: 'Busca repositorios. Ex: {p}gitsearch hanork',
  twilio: 'SMS e ligacao — precisa estar configurado.',
  perfil: 'Nome, foto e recado do WhatsApp.',
  status: 'Status do WhatsApp (stories).',
  enquetes: 'Cria enquetes no chat.',
  agenda: 'Agenda mensagens.',
  geral: 'Atalhos: {p}menu {p}ping {p}sobre'
};

function fillPrefixHint(template, prefix = '.') {
  const p = prefix || '.';
  return applyLivePrefix(String(template || ''), p);
}

/** Alias menu_* (handler antigo) → id do catalogo */
const MENU_ID_TO_CAT = {
  menu_downloads: 'downloads',
  menu_hanorkapi: 'ia',
  menu_zerotwo: 'ia',
  menu_ia: 'ia',
  menu_nuke: 'grupo_mod',
  menu_grupos: 'grupo_config',
  menu_grupo_mod: 'grupo_mod',
  menu_grupo_seg: 'grupo_seg',
  menu_grupo_entrada: 'grupo_entrada',
  menu_grupo_config: 'grupo_config',
  menu_divulgar: 'divulgacao',
  menu_divulgacao: 'divulgacao',
  menu_interativos: 'utilidades',
  menu_mensagens: 'utilidades',
  menu_utilidades: 'utilidades',
  menu_diversao: 'diversao',
  menu_canais: 'utilidades',
  menu_botoes: 'utilidades',
  menu_admin: 'admin',
  menu_adm: 'admin',
  menu_tools: 'diversao',
  menu_exploits: 'exploits',
  menu_travas: 'exploits',
  menu_enquetes: 'diversao',
  menu_agendamentos: 'utilidades',
  menu_perfil: 'utilidades',
  menu_git: 'diversao',
  menu_status: 'utilidades',
  menu_twilio: 'utilidades',
  menu_antiflood: 'grupo_seg',
  menu_seguranca: 'grupo_seg',
  menu_consultas: 'consultas',
  menu_webia: 'diversao',
  menu_config: 'admin',
  menu_host: 'admin',
  menu_raikken: 'admin',
  menu_figurinhas: 'figurinhas'
};

/** Injeta 1 categoria por bucket do catalogo Hanork API (todos os cmds, sem corte). */
function injectHanorkApiCategories() {
  try {
    const { cmdsByCategory, categories } = require('../core/zt/catalog');
    const TITLES = {
      downloads: 'API Downloads',
      pesquisas: 'API Pesquisas',
      montagem: 'API Montagem',
      logos: 'API Logos',
      animes: 'API Animes',
      wallpapers: 'API Wallpapers',
      figurinhas: 'API Figurinhas',
      canvas: 'API Canvas',
      ias: 'API IA',
      doramas: 'API Doramas',
      mangas: 'API Mangas',
      anichin: 'API Anichin',
      encontrei: 'API Encontrei',
      mcpedl: 'API MCPEDL',
      outros: 'API Outros',
      jogos: 'API Jogos',
      upload: 'API Upload',
      consultas: 'API Consultas',
      nsfw: 'API NSFW',
      cassino: 'API Cassino',
      tinder: 'API Tinder'
    };

    const hubIdx = CATALOG.findIndex((c) => c.id === 'ia' || c.id === 'hanorkapi');
    const orderHub = Math.max(MENU_CAT_ORDER.indexOf('ia'), MENU_CAT_ORDER.indexOf('hanorkapi'));
    const newIds = [];
    let insertAt = hubIdx >= 0 ? hubIdx + 1 : CATALOG.length;

    for (const cat of categories()) {
      try {
        const { ztCategoryAllowed } = require('./contentGates');
        if (!ztCategoryAllowed(cat)) continue;
      } catch (_) { /* flag ausente = segue */ }
      const id = `hanork_${cat}`;
      if (CATALOG.some((c) => c.id === id)) continue;
      const entries = cmdsByCategory(cat);
      const ownerCat = /^(nsfw|cassino|consultas|tinder)$/.test(cat);
      const items = [
        {
          name: `menu_hanork${cat}`,
          desc: `Lista completa (${entries.length})`,
          usage: `menu_hanork${cat}`,
          permission: ownerCat ? 'owner' : 'user'
        },
        ...entries.map((e) => {
          const need = (e.params || []).filter(
            (p) => p.required && (p.from === 'text' || p.from === 'args' || p.from === 'query' || !p.from)
          );
          const usageBits = [e.cmd, ...need.map((p) => `<${p.name}>`)];
          let perm = e.permission || 'user';
          if (ownerCat || e.nsfw) perm = 'owner';
          return {
            name: e.cmd,
            desc: String(e.menuLabel || e.cmd).slice(0, 72),
            usage: usageBits.join(' '),
            needsArgs: need.length > 0,
            permission: perm
          };
        }).filter((it) => {
          const n = String(it.name || '');
          if (!n || n.startsWith('menu_hanork')) return true;
          return !CATALOG.some((c) => !String(c.id || '').startsWith('hanork_')
            && (c.items || []).some((x) => x.name === n));
        })
      ];
      const block = {
        id,
        title: TITLES[cat] || `API ${cat}`,
        desc: `${entries.length} comandos Hanork API`,
        items
      };
      CATALOG.splice(insertAt, 0, block);
      insertAt += 1;
      newIds.push(id);
      CATEGORY_ENTRY[id] = `menu_hanork${cat}`;
      MENU_ID_TO_CAT[`menu_hanork${cat}`] = id;
      MENU_ID_TO_CAT[`menu_zt${cat}`] = id;
      CATEGORY_HINTS[id] =
        `{p}menu_hanork${cat} lista todos · use {p}<cmd> direto (${entries.length} cmds)`;
    }

    if (newIds.length && orderHub >= 0) {
      // categorias ficam no catalogo (acessiveis via hub), SEM poluir o menu principal
      // MENU_CAT_ORDER nao recebe newIds — so 'hanorkapi' no root
    }
  } catch (e) {
    try {
      const logger = require('../logger');
      logger.logAviso(`[menuCatalog] inject Hanork API: ${e.message}`);
    } catch (_) { /* ignore */ }
  }
}

injectHanorkApiCategories();

/** Submenu OFF — lista limpa de comandos (estilo ZT, sem ornamento) */
function textCategoryCompact(catId, prefix = '.', viewerRole = null, opts = {}) {
  const p = prefix || '.';
  const cat = getCategory(catId);
  if (!cat) return null;
  let items = filterItemsByRole(cat.items || [], viewerRole, opts);
  if (String(catId).startsWith('hanork_') && catId !== 'hanorkapi' && !HANORK_READY_CAT_IDS.has(catId)) {
    return menuHeading('Categoria da API ainda nao esta no menu. Use .play / .tiktok / .hanork.');
  }
  if (catId === 'ia' || catId === 'hanorkapi') {
    items = filterHanorkHubItems(items);
  }
  if (!items.length) {
    return menuHeading('Nenhum comando disponivel no seu nivel nesta categoria.');
  }
  const hint = fillPrefixHint(CATEGORY_HINTS[catId] || cat.desc || '', p);
  const lines = [
    menuHeading(String(cat.title || catId)),
    menuHeading(`Prefixo: ${p}`)
  ];
  if (hint) {
    lines.push(menuHeading(hint));
  }
  lines.push(menuHeading(`Comandos: ${items.length}`));
  lines.push('');

  for (const it of items) {
    const label = displayCmdLabel(it.name);
    const front = `${p}${label}`;
    const desc = stripAccents(applyLivePrefix(it.desc || '', p)).slice(0, 56);
    lines.push(menuHeading(desc ? `${front} — ${desc}` : front));
  }

  lines.push('');
  if (isHanorkApiSubcategory(catId)) {
    lines.push(menuHeading(`Voltar API: ${p}hanorkapi`));
  }
  lines.push(menuHeading(`Voltar: ${p}menu`));
  return lines.join('\n');
}

function buildCategoryIntro(catId, prefix = '.') {
  const p = prefix || '.';
  const cat = getCategory(catId);
  if (!cat) return menuHeading('Categoria nao encontrada.');
  const hint = fillPrefixHint(CATEGORY_HINTS[catId] || '', p);
  return [
    menuHeading(String(cat.title || catId)),
    menuHeading(`Prefixo: ${p}`),
    hint ? menuHeading(hint) : '',
    '',
    menuHeading('Toque na lista ou digite o comando com o prefixo.')
  ].filter(Boolean).join('\n');
}

/**
 * Painel unificado — **1 mensagem** com a lista completa (texto).
 * Nao pagina em N listas interativas (WA limita 10 rows; multi-envio = flood/ban).
 * Se botoes ON e a categoria cabe em <=10 cmds, manda 1 lista clicavel em vez do texto.
 * antiflood → securityMenu dedicado.
 */
async function sendCategoryPanel(conn, {
  catId,
  chatId,
  quoted,
  telegramUserId,
  sessionId,
  isGroup = false,
  viewerRole = null,
  viewerCtx = null,
  isGroupAdmin = false
} = {}) {
  if (!catId) return null;
  if (catId === 'admin') {
    const { sendRoleMenu } = require('./roleMenus');
    return sendRoleMenu(conn, {
      from: chatId,
      info: quoted,
      telegramUserId,
      sessionId,
      isGroup,
      isOwner: viewerRole === 'owner' || viewerRole === 'platform_admin',
      authRole: viewerRole,
      ...(viewerCtx || {})
    }, 'adm');
  }
  const accessOpts = viewerCtx ? viewerAccessOpts(viewerCtx) : { isGroupAdmin: !!isGroupAdmin };
  if (isGroupAdmin) accessOpts.isGroupAdmin = true;

  if (catId === 'divulgacao') {
    try {
      const { divulgacaoUiTarget } = require('./divulgacaoReply');
      const t = divulgacaoUiTarget({
        from: chatId,
        isGroup: !!isGroup || String(chatId || '').endsWith('@g.us'),
        info: quoted,
        sender: quoted?.key?.participant || quoted?.participant,
        senderAlt: quoted?.key?.participantAlt || quoted?.key?.remoteJidAlt,
        telegramUserId
      }, conn);
      chatId = t.jid;
      quoted = t.quoted;
      if (t.redirected) isGroup = false;
    } catch (_) { /* UI segue no chat original */ }
  }

  // Painel dedicado de seguranca (toggles + status) — dono / adm deste grupo / vip+admin
  if (catId === 'grupo_seg' || catId === 'antiflood') {
    if (viewerRole && !roleCanSee(viewerRole, 'adm', accessOpts)) {
      const { sendButtonlessFallback } = require('../helpers');
      return sendButtonlessFallback(conn, chatId, {
        text: stripAccents('Painel de seguranca: dono da sessao ou admin deste grupo (bot tambem admin).'),
        quoted,
        telegramUserId,
        sessionId
      });
    }
    const { sendSecurityPanel } = require('./securityMenu');
    return sendSecurityPanel(conn, {
      chatId,
      quoted,
      telegramUserId,
      sessionId,
      isGroup: !!isGroup || String(chatId || '').endsWith('@g.us'),
      groupId: String(chatId || '').endsWith('@g.us') ? chatId : null
    });
  }

  const cat = getCategory(catId);
  if (!cat) return null;

  const { sendInteractiveList, sendButtonlessFallback } = require('../helpers');
  const { areButtonsOn } = require('./sessionRegistry');
  const { displayPrefix } = require('./configManager');
  const sid = sessionId || conn?._sessionId;
  const prefix = conn?._isTelegramShim
    ? '/'
    : displayPrefix(telegramUserId || conn?._telegramUserId);
  const fullText = textCategoryCompact(catId, prefix, viewerRole, accessOpts);

  const buttonsOn = areButtonsOn(sid, telegramUserId) && !conn?._isTelegramShim;

  // OFF: texto da categoria (todos os cmds)
  if (!buttonsOn) {
    return sendButtonlessFallback(conn, chatId, {
      text: fullText,
      quoted,
      telegramUserId,
      sessionId: sid
    });
  }

  const items = categoryItemsForWa(catId, viewerRole, accessOpts);
  if (!items.length) {
    return sendButtonlessFallback(conn, chatId, {
      text: stripAccents('Nenhum comando disponivel no seu nivel nesta categoria.'),
      quoted,
      telegramUserId,
      sessionId: sid
    });
  }

  // ON: 1 mensagem com todas as sections (estilo GitHub — sem flood 1/N)
  const sections = waSectionsForCategory(catId, prefix, viewerRole, WA_LIST_MAX_ROWS, accessOpts);
  if (!sections || !sections.length) {
    return sendButtonlessFallback(conn, chatId, {
      text: fullText,
      quoted,
      telegramUserId,
      sessionId: sid
    });
  }

  try {
    return await sendInteractiveList(
      conn,
      chatId,
      buildCategoryIntro(catId, prefix) || fullText,
      sections,
      'Hanork Bot',
      quoted,
      'menu.jpg',
      telegramUserId,
      sid
    );
  } catch (e) {
    try {
      const logger = require('../logger');
      logger.logAviso(`[MENU] cat=${catId} nativo falhou (${e.message}) — texto`);
    } catch (_) { /* ignore */ }
    return sendButtonlessFallback(conn, chatId, {
      text: fullText,
      quoted,
      telegramUserId,
      sessionId: sid,
      useChannel: false
    });
  }
}

function resolveMenuCatId(menuId) {
  if (!menuId) return null;
  if (String(menuId).startsWith('menu_cat_')) return String(menuId).replace('menu_cat_', '');
  return MENU_ID_TO_CAT[menuId] || null;
}

/** Texto compacto a partir de sections de lista (botoes OFF) — 1 mensagem */
function textFromSections(title, sections, prefix = '.') {
  const p = prefix || '.';
  const lines = [menuHeading(String(title || 'MENU').trim()), ''];
  for (const s of sections || []) {
    if (s.title) lines.push(menuHeading(stripAccents(s.title)));
    for (const r of s.rows || []) {
      const { looksLikeCallbackId, stripRawIndex } = require('./typography');
      const rawTitle = stripRawIndex(r.title || r.label || '');
      const cmd = String(r.id || '').replace(/^(cmd_|menu_cat_|menu_|div_)/, '');
      const name = rawTitle && !looksLikeCallbackId(rawTitle) ? rawTitle : (cmd || 'opcao');
      const desc = stripAccents(r.description || '').slice(0, 48);
      const label = String(name).startsWith(p) ? name : `${p}${name}`;
      lines.push(desc ? `${label} — ${desc}` : label);
    }
    lines.push('');
  }
  lines.push(stripAccents(`Voltar: ${p}menu`));
  return lines.join('\n').trim();
}

/** Divide menu longo em partes (limite seguro WA ~3500-4000 chars) */
function textMenuChunks(platform = 'whatsapp', prefix = '.', maxLen = 3500) {
  const { splitTextParts } = require('./textChunks');
  return splitTextParts(textMenuFallback(platform, prefix), maxLen);
}

module.exports = {
  resolveMenuViewerRole,
  CATALOG,
  CATEGORY_ENTRY,
  CATEGORY_HINTS,
  fillPrefixHint,
  MENU_ID_TO_CAT,
  TG_NATIVE_CMDS,
  isTelegramNativeLabel,
  MENU_LEVEL_RANK,
  MENU_CAT_ORDER,
  rootMenuCategories,
  isHanorkApiSubcategory,
  forPlatform,
  getCategory,
  findItem,
  categoryEntryCommand,
  cmdFront,
  resolveCmdLevel,
  menuHeading,
  roleCanSee,
  viewerAccessOpts,
  filterItemsByRole,
  categoryVisibleForRole,
  categoryEntryCommand,
  waSectionsForMain,
  waSectionsForCategory,
  waSectionPagesForCategory,
  categoryItemsForWa,
  displayCmdLabel,
  rowFromCatalogItem,
  WA_LIST_MAX_ROWS,
  DIV_AUTO_CMDS,
  tgMainButtons,
  tgMoreButtons,
  tgCategoryKeyboard,
  tgCategoryText,
  textMenuFallback,
  textMenuCompact,
  textCategoryCompact,
  buildCategoryIntro,
  sendCategoryPanel,
  resolveMenuCatId,
  textFromSections,
  textMenuChunks,
  splitTextParts: (...args) => require('./textChunks').splitTextParts(...args),
  MENU_ID_TO_CAT,
  CATEGORY_ENTRY
};
