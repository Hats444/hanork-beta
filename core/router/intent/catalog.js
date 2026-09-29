// core/router/intent/catalog.js
// Indice: menuCatalog (fonte principal) + comandos de commands/index ausentes no menu
// Cobertura TOTAL Intent Router (prompt hanork-intent-router-total)

const { CATALOG } = require('../../../utils/menuCatalog');
const { isSensitiveCommand } = require('./sensitive');

/** Frases PT → comandos (boost no prefiltro + atalho local) */
const PHRASE_ALIASES = {
  nuke: [
    'apaga esse grupo', 'apagar grupo', 'apaga o grupo', 'destruir grupo',
    'explodir grupo', 'nuke', 'limpa o grupo todo', 'menu nuke', 'menu de nuke'
  ],
  nukeconfig: ['config do nuke', 'configuracao nuke', 'ver nuke', 'abrir nuke'],
  remove: ['remove esse membro', 'remover membro', 'banir', 'tira ele do grupo', 'kick'],
  ban: ['banir do grupo', 'kickar', 'expulsar do grupo', 'remove do grupo'],
  bantmp: ['ban temporario', 'banir por um tempo', 'kick temporario', 'bantmp'],
  bloquearcmd: ['desligar comando', 'bloquear comando', 'comando off'],
  fecharas: ['fechar as', 'fechar grupo as', 'fechar horario'],
  autoaceitar: ['aceitar automatico', 'auto aceitar entrada', 'attacc'],
  x9config: ['avisar mudanca do grupo', 'x9 config', 'aviso de nome'],
  convidar: ['mandar link no pv', 'convidar pro grupo', 'recrutar'],
  saigps: ['sair dos grupos', 'sair da lista de grupos'],
  msgantipv: ['mensagem anti pv', 'texto do anti pv'],
  block: [
    'bloquear comandos', 'bloquear user', 'nao deixa usar o bot',
    'block', 'bloquear numero'
  ],
  unblock: ['desbloquear comandos', 'liberar user do bot', 'unblock', 'desbloquear'],
  unblockall: ['liberar todos bloqueados', 'desbloquear todos', 'unblock all'],
  blockk: ['banir user do bot', 'banir id', 'blockk', 'banid'],
  unblockk: ['liberar user do bot', 'desbanir id', 'unblockk'],
  usuarios: ['listar usuarios do bot', 'lista de users', 'usuarios'],
  blocklist: ['lista de bloqueados', 'quem esta bloqueado do bot'],
  tentativasinjecao: ['tentativas de injecao', 'log de injecao', 'quem tentou jailbreak'],
  promover: ['promover admin', 'dar admin', 'tornar admin'],
  rebaixar: ['rebaixar admin', 'tirar admin', 'remover admin'],
  seradm: ['ser admin', 'virar admin', 'me torna admin'],
  sermembro: ['ser membro', 'virar membro', 'me torna membro'],
  bna: [
    'bna', 'band', 'apaga e remove', 'apagar e banir', 'deletar e remover',
    'apaga msgs e tira', 'ban e apaga'
  ],
  fechargp: ['fechar grupo', 'fecha o grupo', 'só admin fala', 'so admin fala'],
  fechargrupo: ['fechar o grupo', 'fechargrupo'],
  abrirgp: ['abrir grupo', 'abre o grupo', 'liberar grupo'],
  abrirgrupo: ['abrir o grupo', 'abrirgrupo'],
  cita: ['cita', 'citar mensagem', 'reenviar mencionando', 'repetir mensagem mencionando', 'marcar todos', 'mencionar todos', 'tagall'],
  limpar: ['limpar chat', 'limpar grupo visual', 'limpeza do chat'],
  listfake: ['lista fake', 'numeros estrangeiros', 'listar fake'],
  banfake: [
    'ban fake', 'banir fake', 'remover fakes', 'kick fake', 'banfake',
    'apagar fake', 'remover estrangeiros'
  ],
  banfakeall: [
    'ban fake all', 'banfake all', 'remover fakes todos grupos',
    'banir fake em todos', 'limpar fakes todos grupos'
  ],
  antinotas: ['anti notas', 'bloquear notas', 'antinotas'],
  bangp: ['banir grupo', 'bangp', 'silenciar grupo bot'],
  unbangp: ['desbanir grupo', 'unbangp', 'liberar grupo bot'],
  autosticker: ['auto sticker', 'autosticker', 'figurinha automatica'],
  antiporno: ['anti porno', 'antiporno', 'bloquear nsfw', 'anti nsfw'],
  antiataque: [
    'anti ataque', 'antiataque', 'status anti ataque', 'ver anti ataque',
    'protecao total status', 'listar anti ataque'
  ],
  protecaototal: ['protecao total', 'protecaototal', 'status protecao total'],
  antiatkstatus: [
    'anti ataque status', 'antiatkstatus', 'ban status grupo', 'anti status ataque',
    'bloquear status gp', 'anti mencao status'
  ],
  antiatkinvisivel: [
    'anti ataque invisivel', 'antiatkinvisivel', 'anti invisivel ataque',
    'ban view once', 'anti viewonce ataque'
  ],
  antiatkpagamento: [
    'anti ataque pagamento', 'antiatkpagamento', 'ban pix ataque', 'anti pix ataque'
  ],
  antiatkcrash: [
    'anti ataque crash', 'antiatkcrash', 'anticrash grupo', 'anti trava grupo',
    'bloquear crash gp'
  ],
  antiatkpoll: ['anti ataque poll', 'antiatkpoll', 'ban enquete ataque'],
  antiatkmencao: [
    'anti ataque mencao', 'antiatkmencao', 'anti mencao massa ataque', 'ban mencao massa ataque'
  ],
  protecoes: ['protecoes', 'status protecoes', 'listar protecoes', 'ver protecoes'],
  banghost: ['banir ghost', 'banghost', 'remover inativos', 'kick ghost'],
  // revelar: so frases bare crl/oloco/taquipariu (sem NLU)
  aceitar: ['aceitar pedido', 'aceitar solicitacao', 'aprovar entrada', 'aceitar convite grupo'],
  recusar: ['recusar pedido', 'recusar solicitacao', 'negar entrada'],
  aceitarall: ['aceitar todos pedidos', 'aprovar todas solicitacoes'],
  recusarall: ['recusar todos pedidos', 'negar todas solicitacoes'],
  pedidosentrada: ['pedidos de entrada', 'solicitacoes pendentes', 'quem pediu pra entrar'],
  autoconvite: ['alerta de convite', 'aviso pedido entrada', 'autoconvite'],
  anticall: ['anti call', 'anti ligacao', 'bloquear ligacao', 'anticall'],
  antipv: ['anti pv', 'bloquear privado', 'antipv'],
  antipv2: ['anti pv2', 'antipv2'],
  antipv3: ['anti pv3', 'antipv3', 'ignorar privado', 'pv so dono'],
  odelete: ['pre apagar', 'odelete', 'apagar ofensor', 'preapagar'],
  antidelete: ['anti delete', 'anti-delete', 'antidelete', 'antidel', 'recuperar apagada'],
  pvseguranca: ['seguranca do pv', 'status anti pv'],
  leave: ['sair do grupo', 'sai do grupo', 'deixar o grupo'],
  novidades: [
    'novidades', 'o que mudou', 'o que ha de novo', 'changelog',
    'o que tem de novo', 'atualizacoes do bot', 'ver novidades'
  ],
  tutorial: [
    'tutorial', 'como comecar', 'como usar o bot', 'ajuda inicial', 'como funciona o bot'
  ],
  hanork: [
    'hanork api', 'menu hanork', 'menu da api', 'comandos da api',
    'catalogo api', 'menu api hanork', 'menu hanork', 'menu zt'
  ],
  chatgpt: ['chatgpt', 'pergunta pro gpt', 'usar chatgpt'],
  gemini: ['gemini', 'google gemini'],
  removebg: ['remover fundo', 'remove fundo', 'removebg'],
  hd: ['deixar em hd', 'melhorar qualidade', 'upscale'],
  tradutor: ['traduzir', 'tradutor', 'translate'],
  host: ['host', 'raikken', 'painel da host', 'menu host', 'controlar host'],
  hoststatus: ['status da host', 'status host', 'cpu da host', 'ram da host'],
  hostrestart: ['reiniciar host', 'restart host', 'reinicia o servidor da host'],
  hostconsole: ['console da host', 'logs da host', 'ver console host'],
  hostls: ['arquivos da host', 'listar arquivos host'],
  hostbackups: ['backups da host', 'backup host'],
  modenable: [
    'ativa o anti flood', 'ativar antiflood', 'liga anti flood',
    'ativa antiflood', 'ligar moderacao', 'ativa moderacao',
    'ativar anti flood', 'liga o anti flood'
  ],
  moddisable: [
    'desativa o anti flood', 'desativar antiflood', 'desliga anti flood',
    'desliga antiflood', 'desligar moderacao', 'desativar anti flood'
  ],
  modstatus: [
    'status do anti flood', 'status antiflood', 'moderacao status',
    'menu antiflood', 'menu anti flood', 'menu de antiflood', 'abrir antiflood',
    'status da seguranca', 'seguranca do grupo'
  ],
  protecoes: [
    'ver protecoes', 'status protecoes', 'listar protecoes', 'quais protecoes ativas',
    'protecoes do grupo', 'painel protecoes'
  ],
  modhelp: [
    'ajuda anti flood', 'como ativar anti flood', 'como desativar anti flood',
    'ajuda antiflood', 'como funciona anti flood'
  ],
  gpseguranca: [
    'painel de seguranca', 'seguranca grupo', 'configurar seguranca',
    'protecao do grupo'
  ],
  antilink: [
    'ativa anti link', 'ativar antilink', 'liga anti link',
    'desativa anti link', 'anti link'
  ],
  antilinkhard: [
    'ativa anti link hard', 'ativar antilinkhard', 'anti link hard'
  ],
  antilinkgp: [
    'anti link gp', 'antilinkgp', 'bloquear convite', 'bloqueia link de grupo',
    'anti convite', 'bloquear link de convite'
  ],
  antilinkeasy: ['anti link easy', 'antilinkeasy', 'anti link facil'],
  antichannel: [
    'anti canal', 'bloquear canal', 'antichannel', 'bloqueia link de canal'
  ],
  antipayment: ['anti pagamento', 'antipayment', 'bloquear pix', 'anti pix'],
  anticatalogo: ['anti catalogo', 'anticatalogo', 'bloquear catalogo'],
  antistatus: ['anti status', 'antistatus', 'bloquear status'],
  antipalavrao: ['anti palavrao', 'antipalavrao', 'bloquear palavrao', 'filtro palavrao'],
  antiimg: ['anti imagem', 'bloquear imagem', 'antiimg', 'sem imagem'],
  antivideo: ['anti video', 'bloquear video', 'antivideo', 'sem video'],
  antiaudio: ['anti audio', 'bloquear audio', 'antiaudio'],
  antisticker: ['anti sticker', 'bloquear sticker', 'antisticker'],
  antidoc: ['anti documento', 'bloquear documento', 'antidoc'],
  antiloc: ['anti localizacao', 'bloquear localizacao', 'antiloc'],
  antictt: ['anti contato', 'bloquear contato', 'antictt'],
  bemvindo: ['ativa bem vindo', 'ativar bemvindo', 'bem vindo', 'boas vindas'],
  saiu: ['aviso de saida', 'ativa saiu', 'mensagem de saida'],
  legendabv: ['legenda bem vindo', 'texto bem vindo', 'legendabv'],
  fotobv: ['foto bem vindo', 'foto de entrada', 'fotobv'],
  figbv: ['fig bem vindo', 'figurinha de entrada', 'figbv'],
  audiobv: ['audio bem vindo', 'audio de entrada', 'audiobv'],
  tabela: ['tabela do grupo', 'cardapio', 'tabela'],
  nota: ['nota do grupo', 'recado do grupo', 'nota'],
  sorteio: ['sorteio', 'rifa', 'sortear'],
  horariogrupo: ['horario do grupo', 'abrir fechar grupo', 'horariogrupo'],
  mute: ['mutar', 'silenciar membro', 'mute'],
  desmute: ['desmutar', 'tirar mute', 'desmute'],
  listanegra: ['lista negra', 'adicionar lista negra', 'ban lista', 'banall', 'banir de todos os grupos'],
  banall: ['ban all', 'banir de todos', 'lista negra global'],
  tirardalista: ['tirar da lista negra', 'remover lista negra', 'unbanall'],
  adv: ['advertencia', 'dar advertencia', 'warn'],
  limiteflood: ['limite de caracteres', 'limiteflood', 'limite char'],
  antifake: [
    'ativa anti fake', 'ativar antifake', 'anti fake', 'bloquear estrangeiro'
  ],
  soadm: [
    'somente admin', 'so admin', 'so admins', 'comandos so admin',
    'ativar soadm', 'desativar soadm'
  ],
  buttonsoff: [
    'desliga os botoes', 'desligar botoes', 'desativa botoes',
    'desativar botoes', 'modo encaminhada', 'botoes off'
  ],
  buttonson: [
    'liga os botoes', 'ligar botoes', 'ativa botoes',
    'ativar botoes', 'botoes on', 'modo botoes'
  ],
  togglebuttons: ['alternar botoes', 'troca modo botoes'],
  buttonmode: [
    'status dos botoes', 'modo dos botoes',
    'menu botoes', 'menu de botoes', 'abrir botoes'
  ],
  forwardoff: ['desliga forward', 'forward off'],
  forwardon: ['liga forward', 'forward on'],
  consulta: [
    'consultar cpf', 'consulta cpf', 'busca cpf', 'consultar telefone',
    'consulta placa', 'fazer consulta',
    'puxa esse telefone', 'puxar telefone', 'consulta esse numero',
    'puxa o numero', 'consultar numero', 'serasa telefone', 'busca telefone'
  ],
  menu_consultas: [
    'menu de consultas', 'menu consultas', 'abrir consultas',
    'abre consultas', 'mostrar consultas'
  ],
  cpffull: ['dossie cpf', 'cpf completo dossie', 'puxar dossie'],
  buscanome: ['busca nome dossie', 'achar cpf pelo nome extra'],
  celular: ['consulta celular dossie', 'puxar celular cadastro'],
  placafull: ['placa completa dossie', 'consulta placa extra'],
  parentes: ['consulta parentes', 'puxar parentes'],
  consultapix: ['consulta pix', 'puxar chave pix'],
  play: [
    'baixa essa musica', 'baixar musica', 'tocar musica', 'baixa o audio',
    'quero ouvir', 'quero ouvir a musica', 'toca', 'toque', 'manda uma musica',
    'passa a musica', 'coloca a musica', 'play', 'ouvir musica',
    'queria tanto ouvir', 'queria ouvir uma musica', 'nossa queria ouvir',
    'pode tocar', 'poe uma musica', 'solta a musica', 'bota pra tocar'
  ],
  playvideo: [
    'baixa esse video', 'baixar video youtube', 'play video', 'manda o video',
    'baixa video do youtube', 'playvideo'
  ],
  tiktok: ['baixa esse tiktok', 'baixar tiktok', 'download tiktok'],
  instagram: ['baixa esse instagram', 'baixar instagram', 'baixa o reel', 'download ig'],
  facebook: ['baixa esse facebook', 'baixar facebook', 'download facebook', 'baixa fb'],
  spotify: ['baixa spotify', 'baixar spotify', 'musica spotify', 'spotifu', 'spotify'],
  soundcloud: ['baixa soundcloud', 'baixar soundcloud', 'soundcloud'],
  mediafire: ['baixa mediafire', 'baixar mediafire', 'download mediafire'],
  twitter: ['baixa twitter', 'baixar twitter', 'baixa x', 'download twitter'],
  kwai: ['baixa kwai', 'baixar kwai', 'download kwai'],
  threads: ['baixa threads', 'baixar threads', 'download threads'],
  capcut: ['baixa capcut', 'baixar capcut', 'download capcut'],
  pinterest: ['baixa pinterest', 'baixar pinterest', 'download pinterest'],
  autodown: ['ativa auto download', 'ativar autodown', 'auto download'],
  download: [
    'menu downloads', 'menu de downloads', 'menu download', 'abrir downloads',
    'abre downloads', 'mostrar downloads', 'fazer download'
  ],
  sticker: ['faz figurinha', 'criar sticker', 'faz um sticker', 'vira figurinha', 'faz a fig'],
  figurinha: ['figurinha canal', 'figurinhas canal', 'posta figurinha', 'figurinha no canal'],
  toimg: ['sticker pra imagem', 'converter figurinha', 'toimg', 'figurinha em foto'],
  filtroigdark: [
    'filtro preto e branco', 'filtro dark', 'filtro instagram dark',
    'preto e branco dark', 'filtroigdark', 'filtroigdark', 'filtro pb', 'pb dark'
  ],
  channelpost: [
    'posta no canal', 'postar no canal', 'publicar no canal',
    'divulgar nos canais parceiros', 'postar nos parceiros'
  ],
  channelparceiros: ['lista parceiros de canal', 'canais parceiros', 'listar parceiros'],
  attp: ['figurinha de texto', 'attp', 'sticker de texto'],
  roubar: ['roubar figurinha', 'renomear sticker', 'take sticker'],
  t: ['t figurinha', 'meu t', 'aplicar t', 'renomear com t'],
  ususticker: ['figurinha do perfil', 'sticker do perfil', 'foto de perfil figurinha'],
  ytsearch: ['busca no youtube', 'pesquisar no youtube'],
  google: [
    'pesquisa na web', 'busca no google', 'pesquisar google',
    'menu webia', 'menu web intelligence', 'menu de webia', 'abrir webia'
  ],
  deepsearch: ['busca profunda', 'pesquisa profunda', 'deep search'],
  ping: ['latencia', 'ta online', 'está online', 'ping'],
  nivel: ['meu nivel', 'qual meu nivel', 'meu xp', 'evolucao minha', 'quanto de xp'],
  evolucao: ['minha evolucao', 'painel evolucao', 'ver evolucao', 'progresso no bot'],
  rank: ['ranking evolucao', 'leaderboard', 'placar evolucao'],
  sobre: [
    'sobre', 'dono do bot', 'quem e o dono'
  ],
  comprar: ['comprar', 'quero o bot'],
  planos: ['planos'],
  minhaconta: ['minha conta'],
  suporte: ['suporte', 'abrir chamado'],
  stats: ['estatisticas', 'quanto eu tenho', 'meu saldo', 'status do bot', 'stats'],
  menu: [
    'abre o menu', 'abrir o menu', 'abrir menu', 'abre menu', 'mostrar menu',
    'mostra o menu', 'menu principal', 'manda o menu', 'me mostra o menu', 'menu'
  ],
  comandos: [
    'lista de comandos', 'listar comandos', 'todos os comandos',
    'mostrar comandos', 'menu comandos'
  ],
  divmenu: [
    'menu divulgacao', 'menu de divulgacao', 'abrir divulgacao',
    'abre divulgacao', 'mostrar divulgacao'
  ],
  div: ['fazer divulgacao', 'iniciar divulgacao', 'broadcast', 'divulgar'],
  dk: [
    'dk', 'postar dk', 'mandar dk no grupo'
  ],
  entrardk: [
    'entrar dk', 'entrardk', 'entrar no grupo e mandar dk'
  ],
  menu_dk: [
    'menu dk', 'menu do dk', 'abrir dk'
  ],
  divconfigauto: ['intervalo divulgacao', 'tempo automatico divulgacao', 'delay aleatorio divulgacao', 'divulgacao a cada 2 horas'],
  divcriagrupo: ['criar grupos de divulgacao', 'criar grupo divulgacao'],
  divbotao: ['divulgacao com botao', 'divulgacao cta', 'enviar cta'],
  divconfirmar: ['confirmar divulgacao', 'confirma a divulgacao'],
  divstatus: ['status da divulgacao'],
  paypost: ['postar pagamento', 'teste de pagamento', 'enviar cobranca no grupo'],
  addgrupo: ['adicionar grupo na divulgacao', 'add grupo divulgacao'],
  grupos: ['gerenciador de grupos', 'fila de convites', 'gerenciar grupos divulgacao', 'menu grupos', 'menu de grupos', 'abrir grupos'],
  grupoentrar: ['entrar em grupos pelo convite', 'entrar nos convites pendentes'],
  gruposair: ['sair de grupos da divulgacao'],
  setprefix: ['mudar prefixo', 'alterar prefixo', 'trocar prefixo'],
  prefixo: ['qual o prefixo', 'prefixo do bot', 'prefixo'],
  prefixhint: ['aviso de prefixo', 'dica de prefixo', 'ligar aviso prefixo'],
  vipall: ['dar vip pra todos', 'vip all', 'vip todos do grupo', 'liberar vip do grupo'],
  removervipall: ['tirar vip de todos', 'remover vip all', 'tira vip do grupo'],
  addvip: ['adicionar vip', 'dar vip', 'add vip', 'colocar vip'],
  tirarvip: ['tirar o vip', 'remover o vip', 'tira o vip dele'],
  creategroup: ['criar grupo', 'cria um grupo'],
  groupinfo: [
    'info do grupo', 'informacoes do grupo'
  ],
  groupinvite: ['gerar convite', 'groupinvite', 'convite do grupo'],
  linkgp: ['link do grupo', 'linkgp', 'link gp', 'link de convite', 'manda o link do grupo', 'copia o link'],
  gitsearch: [
    'busca no github', 'pesquisar github',
    'menu github', 'menu de github', 'abrir github'
  ],
  // logs: so frases EXPLICITAS — nunca "menu admin" (isso e menu_admin)
  logs: ['ver logs', 'mostrar logs', 'manda os logs', 'enviar logs'],
  menu_admin: [
    'menu admin', 'menu admins', 'menu de admin',
    'abrir admin', 'abre admin', 'menu administracao', 'menu sessao'
  ],
  menu_adm: [
    'menu adm', 'menu administrador', 'comandos de adm',
    'o que o adm pode usar', 'comandos do admin do grupo'
  ],
  menu_dono: [
    'menu dono', 'menu do dono', 'comandos de dono',
    'o que o dono pode usar', 'comandos do dono'
  ],
  menu_tools: ['menu tools', 'menu ferramentas', 'abrir ferramentas'],
  rr: ['reiniciar bot', 'restart', 'reinicia o bot'],
  twiliomenu: ['menu twilio', 'menu de twilio', 'abrir twilio'],
  // exploits / crash
  crash: ['simular crash', 'crashar o bot', 'forcar crash', 'dar crash'],
  crashios: ['crash ios', 'crashar ios', 'derrubar ios'],
  crashgp: ['crash grupo', 'crashar grupo', 'derrubar grupo'],
  travazap: ['travazap', 'trava zap', 'travar zap', 'flood mensagem'],
  ddos: ['ddos', 'stress test', 'ataque stress', 'ab stress'],
  bugchat: ['bug chat', 'bugar chat'],
  atraso: ['atraso status', 'bug atraso'],
  wppexe: ['congelar wpp', 'congelar whatsapp exe'],
  wppweb: ['congelar wpp web', 'congelar whatsapp web'],
  sistema: ['bug sistema', 'sistema bug'],
  convite: ['convite bugado', 'bug convite'],
  carrinho: ['carrinho bugado', 'bug carrinho']
};

/** Comandos de ACAO — nunca recebem alias auto "menu X" (evita menu admin → logs) */
const FORBID_MENU_ALIAS_TARGETS = new Set([
  'logs', 'rr', 'clearlogs', 'clearsession', 'repairsession', 'backupsession',
  'exportsession', 'importsession', 'restoresession', 'badmac', 'addai',
  'nuke', 'nukeid', 'nukeas', 'ddos', 'crash', 'travazap',
  'remove', 'leave', 'clearuser', 'clearall'
]);

/**
 * Gera frases "menu X" / "abrir X" para categorias do menuCatalog.
 * So aponta para entradas SEGURAS (menu_*, download, divmenu, etc).
 */
function buildCategoryMenuAliases() {
  const ENTRY_OVERRIDE = {
    downloads: 'download',
    consultas: 'menu_consultas',
    webia: 'google',
    divulgacao: 'divmenu',
    grupos: 'gerenciador de grupos',
    github: 'gitsearch',
    antiflood: 'modstatus',
    botoes: 'buttonmode',
    nuke: 'nukeconfig',
    admin: 'menu_adm',
    tools: 'menu_tools',
    geral: 'menu'
  };

  const out = {};
  for (const cat of CATALOG) {
    let entry = ENTRY_OVERRIDE[cat.id] || cat.items?.[0]?.name;
    if (!entry) continue;

    // Nunca ligar "menu <cat>" a comando de acao sensivel
    if (FORBID_MENU_ALIAS_TARGETS.has(entry) || (isSensitiveCommand(entry, cat.id) && !String(entry).startsWith('menu_'))) {
      const safe = (cat.items || []).find((i) => String(i.name).startsWith('menu_'));
      entry = ENTRY_OVERRIDE[cat.id] || safe?.name;
      if (!entry || FORBID_MENU_ALIAS_TARGETS.has(entry)) continue;
    }

    const id = String(cat.id || '').toLowerCase();
    // so primeira palavra do titulo (evita "admin / sessao")
    const titleWord = String(cat.title || id)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean)[0] || id;

    const phrases = [
      `menu ${id}`,
      `menu de ${id}`,
      `menu ${titleWord}`,
      `menu de ${titleWord}`,
      `abrir ${id}`,
      `abre ${id}`,
      `abrir ${titleWord}`,
      `abre ${titleWord}`,
      `mostrar ${titleWord}`,
      `abrir menu ${titleWord}`,
      `abre menu ${titleWord}`
    ];
    // plural comum
    if (titleWord === 'admin') {
      phrases.push('menu admins', 'menu adm', 'abrir admins', 'abre adm');
    }

    if (!out[entry]) out[entry] = [];
    for (const ph of phrases) {
      if (!out[entry].includes(ph)) out[entry].push(ph);
    }
  }
  return out;
}

function mergeAliases() {
  const merged = { ...PHRASE_ALIASES };
  const auto = buildCategoryMenuAliases();
  for (const [cmd, phrases] of Object.entries(auto)) {
    // Bloqueia merge de "menu *" em alvos proibidos
    if (FORBID_MENU_ALIAS_TARGETS.has(cmd)) continue;
    if (!merged[cmd]) merged[cmd] = [];
    for (const ph of phrases) {
      if (!merged[cmd].includes(ph)) merged[cmd].push(ph);
    }
  }
  // Garante que logs NAO tenha aliases de menu
  if (merged.logs) {
    merged.logs = merged.logs.filter((p) => !/^menu\b/i.test(p) && !/^abrir\s+admin/i.test(p));
  }
  return merged;
}

let MERGED_ALIASES = null;
function getPhraseAliases() {
  if (!MERGED_ALIASES) MERGED_ALIASES = mergeAliases();
  return MERGED_ALIASES;
}

const STOPWORDS = new Set([
  'a', 'o', 'os', 'as', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos',
  'e', 'ou', 'em', 'no', 'na', 'nos', 'nas', 'pra', 'para', 'por',
  'com', 'sem', 'que', 'eu', 'me', 'meu', 'minha', 'esse', 'essa',
  'este', 'esta', 'isso', 'aqui', 'ali', 'the', 'to', 'of', 'quero',
  'pode', 'faz', 'fazer', 'ver', 'veja', 'mostra', 'mostrar'
]);

let _cache = null;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function buildKeywords(item, cat) {
  const bag = new Set();
  for (const w of tokenize(item.name)) bag.add(w);
  for (const w of tokenize(item.desc || '')) bag.add(w);
  for (const w of tokenize(item.usage || '')) bag.add(w);
  for (const w of tokenize(cat?.title || cat?.id || '')) bag.add(w);
  bag.add(String(item.name).toLowerCase());
  const aliases = getPhraseAliases()[item.name] || [];
  for (const phrase of aliases) {
    for (const w of tokenize(phrase)) bag.add(w);
  }
  return [...bag];
}

function pushEntry(entries, seen, it, cat) {
  const name = String(it.name || '').trim();
  if (!name || seen.has(name)) return;
  seen.add(name);
  const category = cat?.id || 'extra';
  entries.push({
    command: name,
    category,
    description: it.desc || it.description || name,
    usage: it.usage || name,
    sensitive: isSensitiveCommand(name, category),
    keywords: buildKeywords(it, cat || { id: category, title: category }),
    phrases: getPhraseAliases()[name] || [],
    platforms: it.platforms || ['whatsapp', 'telegram'],
    needsArgs: !!it.needsArgs
  });
}

function buildCatalog(force = false) {
  if (_cache && !force) return _cache;
  if (force) {
    MERGED_ALIASES = null;
    _cache = null;
  }

  const entries = [];
  const seen = new Set();

  // 1) menuCatalog (fonte principal)
  for (const cat of CATALOG) {
    for (const it of cat.items || []) {
      pushEntry(entries, seen, it, cat);
    }
  }

  // 2) todo comando registrado em commands/index (cobertura total)
  try {
    const { listCommands, getCommand } = require('../../../commands');
    for (const name of listCommands()) {
      if (seen.has(name)) continue;
      const cmd = getCommand(name) || {};
      pushEntry(
        entries,
        seen,
        {
          name,
          desc: cmd.description || name,
          usage: cmd.usage || name,
          needsArgs: false,
          platforms: ['whatsapp', 'telegram']
        },
        { id: name.startsWith('step_') || /crash|ddos|bug|trava|atraso|exploit/i.test(name) ? 'exploits' : 'extra', title: 'extra' }
      );
    }
  } catch (_) {
    /* commands ainda nao carregados */
  }

  // 3) Universal Router registry (fonte viva — novos cmds entram sem rebuild manual)
  try {
    require('../registeredCommands');
    const { listRegisteredCommands, getCommandConfig } = require('../universalRouter');
    const { getCommandMinLevel } = require('../registeredCommands');
    let destructive = null;
    try {
      ({ isDestructiveConfirmCommand: destructive } = require('./safety'));
    } catch (_) { /* ignore */ }
    for (const name of listRegisteredCommands() || []) {
      if (seen.has(name)) {
        // Enriquecer entry ja vista com nivel do registry
        const ent = entries.find((e) => e.command === name);
        if (ent) {
          try {
            ent.permission = getCommandMinLevel(name);
            ent.destructive = destructive ? !!destructive(name) : !!ent.sensitive;
          } catch (_) { /* ignore */ }
        }
        continue;
      }
      const cfg = getCommandConfig(name) || {};
      const cmd = (() => {
        try {
          return require('../../../commands').getCommand(name) || {};
        } catch (_) {
          return {};
        }
      })();
      pushEntry(
        entries,
        seen,
        {
          name,
          desc: cmd.description || cfg.description || name,
          usage: cmd.usage || name,
          needsArgs: false,
          platforms: cfg.platforms || ['whatsapp', 'telegram']
        },
        { id: 'extra', title: 'extra' }
      );
      const ent = entries[entries.length - 1];
      if (ent) {
        try {
          ent.permission = getCommandMinLevel(name);
          ent.destructive = destructive ? !!destructive(name) : !!ent.sensitive;
        } catch (_) { /* ignore */ }
      }
    }
  } catch (_) {
    /* registry ainda frio no boot */
  }

  _cache = entries;
  return entries;
}

function getEntry(command) {
  return buildCatalog().find((e) => e.command === command) || null;
}

module.exports = {
  buildCatalog,
  getEntry,
  tokenize,
  PHRASE_ALIASES,
  getPhraseAliases,
  buildCategoryMenuAliases,
  STOPWORDS
};
