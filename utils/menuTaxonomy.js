'use strict';
/**
 * Taxonomia unica de menus (max 2 cliques: main → categoria → comando).
 * Cada comando em UMA categoria (primeira vitoria; aliases ficam com o primario).
 * Documentado em docs/AUDITORIA-VIVA.md.
 */

/** Categorias de topo (ordem do .menu) */
const TAXONOMY = [
  { id: 'geral', title: 'Geral', desc: 'Menu, status, tutorial, planos' },
  { id: 'downloads', title: 'Downloads', desc: 'Baixa video e musica' },
  { id: 'consultas', title: 'Consultas', desc: 'Busca de CPF, CEP, placa (dono e VIP)' },
  { id: 'figurinhas', title: 'Figurinhas', desc: 'Faz figurinha de foto e video' },
  { id: 'ia', title: 'IA', desc: 'Pergunta pra IA e ferramentas extras' },
  { id: 'grupo_mod', title: 'Moderacao', desc: 'Ban, mute, mencionar todos' },
  { id: 'grupo_seg', title: 'Protecao', desc: 'Antilink, anti-roubo, anti-ataque' },
  { id: 'grupo_entrada', title: 'Entrada', desc: 'Convite, bem-vindo, pedidos pra entrar' },
  { id: 'grupo_config', title: 'Grupo', desc: 'Nome, link, abrir e fechar' },
  { id: 'divulgacao', title: 'Divulgacao', desc: 'Envia propaganda nos grupos (dono/VIP)' },
  { id: 'diversao', title: 'Diversao', desc: 'Jogos, busca e enquetes' },
  { id: 'utilidades', title: 'Utilidades', desc: 'Mensagens, canais, agenda' },
  { id: 'admin', title: 'Administracao', desc: 'Dono, VIP, sessao e host' },
  { id: 'exploits', title: 'Travas', desc: 'So o dono da plataforma' }
];

/** Overrides explicitos (comando → categoria). Ganha de qualquer cat antiga. */
const CMD_OVERRIDE = {
  // Figurinhas (unico lugar)
  figurinha: 'figurinhas',
  figurinhas: 'figurinhas',
  figurinhas2: 'figurinhas',
  figcanal: 'figurinhas',
  sticker: 'figurinhas',
  s: 'figurinhas',
  f: 'figurinhas',
  toimg: 'figurinhas',
  filtroigdark: 'figurinhas',
  filtroigdark: 'figurinhas',
  channelpost: 'utilidades',
  channelparceiros: 'utilidades',
  channelparceiroadd: 'utilidades',
  channelparceiroedit: 'utilidades',
  channelparceirooff: 'utilidades',
  roubar: 'figurinhas',
  t: 'figurinhas',
  sett: 'figurinhas',
  meut: 'figurinhas',
  editt: 'figurinhas',
  stickerinfo: 'figurinhas',
  figban: 'figurinhas',
  figunban: 'figurinhas',
  figbanall: 'figurinhas',
  figbanlist: 'figurinhas',
  attp: 'figurinhas',
  ususticker: 'figurinhas',
  stickerpack: 'figurinhas',
  avatarsticker: 'figurinhas',
  menu_hanorkfigurinhas: 'figurinhas',

  // IA
  hanork: 'ia',
  hanorkapi: 'ia',
  hanorkinfo: 'ia',
  zt: 'ia',
  ztinfo: 'ia',

  // Grupo Moderacao
  ban: 'grupo_mod',
  bantmp: 'grupo_mod',
  kick: 'grupo_mod',
  banir: 'grupo_mod',
  kick: 'grupo_mod',
  bna: 'grupo_mod',
  deletar: 'grupo_mod',
  promover: 'grupo_mod',
  rebaixar: 'grupo_mod',
  seradm: 'grupo_mod',
  sermembro: 'grupo_mod',
  viraradm: 'grupo_mod',
  virarmembro: 'grupo_mod',
  promote: 'grupo_mod',
  demote: 'grupo_mod',
  remove: 'grupo_mod',
  add: 'grupo_mod',
  cita: 'grupo_mod',
  mute: 'grupo_mod',
  desmute: 'grupo_mod',
  mutelist: 'grupo_mod',
  listanegra: 'grupo_mod',
  banall: 'grupo_mod',
  tirardalista: 'grupo_mod',
  unbanall: 'grupo_mod',
  listban: 'grupo_mod',
  listanegrag: 'grupo_mod',
  adv: 'grupo_mod',
  rmadv: 'grupo_mod',
  listadv: 'grupo_mod',
  banghost: 'grupo_mod',
  clearuser: 'grupo_mod',
  clearall: 'grupo_mod',
  limpar: 'grupo_mod',
  nuke: 'grupo_mod',
  nukeid: 'grupo_mod',
  nukeas: 'grupo_mod',
  nukeconfig: 'grupo_mod',
  nukename: 'grupo_mod',
  nukedesc: 'grupo_mod',
  nukemsg: 'grupo_mod',
  nukeimg: 'grupo_mod',
  nukereset: 'grupo_mod',

  // Grupo Seguranca (painel)
  gpseguranca: 'grupo_seg',
  protecoes: 'grupo_seg',
  protecoesativas: 'grupo_seg',
  protecoeshelp: 'grupo_seg',
  modenable: 'grupo_seg',
  moddisable: 'grupo_seg',
  modstatus: 'grupo_seg',
  modlist: 'grupo_seg',
  modhelp: 'grupo_seg',
  antifloodhelp: 'grupo_seg',
  painel: 'grupo_seg',
  painelprotecoes: 'grupo_seg',
  statusprotecoes: 'grupo_seg',
  listprotecoes: 'grupo_seg',
  antiataque: 'grupo_seg',
  protecaototal: 'grupo_seg',
  antiattack: 'grupo_seg',
  antiadmin: 'grupo_seg',
  antiroubo: 'grupo_seg',
  antiadminaudit: 'grupo_seg',
  antiadminrevert: 'grupo_seg',
  antiadminalert: 'grupo_seg',
  antiadmindest: 'grupo_seg',
  antiadminsilent: 'grupo_seg',
  antiadmindetect: 'grupo_seg',
  antiadminlimite: 'grupo_seg',
  antiadminjanela: 'grupo_seg',
  donogrupo: 'grupo_seg',
  transferirdono: 'grupo_seg',
  addgpowner: 'grupo_seg',
  removegpowner: 'grupo_seg',
  listgpowner: 'grupo_seg',
  historicoadmin: 'grupo_seg',
  gpowner: 'grupo_seg',
  adddonogp: 'grupo_seg',
  removedonogp: 'grupo_seg',
  odelete: 'grupo_seg',
  preapagar: 'grupo_seg',
  predelete: 'grupo_seg',
  antidelete: 'grupo_seg',
  antidel: 'grupo_seg',
  antipv: 'grupo_seg',
  antipv2: 'grupo_seg',
  antipv3: 'grupo_seg',
  msgantipv: 'grupo_seg',
  anticall: 'grupo_seg',
  pvseguranca: 'grupo_seg',

  // Grupo Entrada
  bemvindo: 'grupo_entrada',
  bv: 'grupo_entrada',
  welcome: 'grupo_entrada',
  saiu: 'grupo_entrada',
  legendabv: 'grupo_entrada',
  fotobv: 'grupo_entrada',
  figbv: 'grupo_entrada',
  audiobv: 'grupo_entrada',
  fotosaida: 'grupo_entrada',
  figsaida: 'grupo_entrada',
  audiosaida: 'grupo_entrada',
  bvstatus: 'grupo_entrada',
  ausente: 'grupo_entrada',
  tabela: 'grupo_config',
  settabela: 'grupo_config',
  nota: 'grupo_config',
  horariogrupo: 'grupo_config',
  sorteio: 'grupo_mod',
  atividade: 'grupo_mod',
  inativos: 'grupo_mod',
  figquote: 'figurinhas',
  tomp3: 'utilidades',
  audiofx: 'utilidades',
  tts: 'utilidades',
  reagircanal: 'utilidades',
  boti: 'grupo_seg',
  boton: 'grupo_seg',
  botoff: 'grupo_seg',
  botion: 'grupo_seg',
  botioof: 'grupo_seg',
  legendasaiu: 'grupo_entrada',
  autoconvite: 'grupo_entrada',
  autoaceitar: 'grupo_entrada',
  autoaceitartempo: 'grupo_entrada',
  attacc: 'grupo_entrada',
  setattacc: 'grupo_entrada',
  x9config: 'grupo_config',
  convidar: 'grupo_entrada',
  aceitar: 'grupo_entrada',
  recusar: 'grupo_entrada',
  aceitarall: 'grupo_entrada',
  recusarall: 'grupo_entrada',
  pedidosentrada: 'grupo_entrada',
  antifake: 'grupo_entrada',
  listfake: 'grupo_entrada',
  banfake: 'grupo_entrada',
  banfakeall: 'grupo_entrada',
  groupinvite: 'grupo_entrada',
  linkgp: 'grupo_entrada',
  linkgrupo: 'grupo_entrada',
  grouplink: 'grupo_entrada',
  revokeinvite: 'grupo_entrada',

  // Grupo Config
  creategroup: 'grupo_config',
  groupinfo: 'grupo_config',
  groupid: 'grupo_config',
  groupname: 'grupo_config',
  groupdesc: 'grupo_config',
  setgroupname: 'grupo_config',
  setgroupdesc: 'grupo_config',
  setgrouppp: 'grupo_config',
  leave: 'grupo_config',
  saigp: 'grupo_config',
  sairdogp: 'grupo_config',
  saigps: 'grupo_config',
  fechargp: 'grupo_config',
  fechargrupo: 'grupo_config',
  gpfechar: 'grupo_config',
  groupclose: 'grupo_config',
  abrirgp: 'grupo_config',
  abrirgrupo: 'grupo_config',
  gpabrir: 'grupo_config',
  groupopen: 'grupo_config',
  fecharas: 'grupo_config',
  soadm: 'grupo_config',
  onlyadm: 'grupo_config',
  soadmin: 'grupo_config',
  admcmd: 'grupo_config',
  blockgp: 'grupo_config',

  // Divulgacao
  bandeja: 'divulgacao',
  postbandeja: 'divulgacao',
  grupodivulgacao: 'divulgacao',
  divgrupo: 'divulgacao',
  addgrupo: 'divulgacao',
  dk: 'divulgacao',
  entrardk: 'divulgacao',
  menu_dk: 'divulgacao',
  msgdk: 'divulgacao',
  fotodk: 'divulgacao',
  videodk: 'divulgacao',
  apagardk: 'divulgacao',
  qtddk: 'divulgacao',
  dkpay: 'divulgacao',
  msgdkpay: 'divulgacao',
  dkmidia: 'divulgacao',
  rmfotodk: 'divulgacao',
  listfotodk: 'divulgacao',
  grupos: 'divulgacao',
  grupolista: 'divulgacao',
  grupoconfig: 'divulgacao',
  grupoentrar: 'divulgacao',
  gruposair: 'divulgacao',
  removergrupo: 'divulgacao',
  divauto: 'divulgacao',
  divconfigauto: 'divulgacao',
  divconfigautomodos: 'divulgacao',
  divcriagrupo: 'divulgacao',
  divautocriar: 'divulgacao',
  divconfigmingrupos: 'divulgacao',
  divconfigcriagrupo: 'divulgacao',

  // Diversao
  google: 'diversao',
  pesquisar: 'diversao',
  deepsearch: 'diversao',
  analisar: 'diversao',
  relatorio: 'diversao',
  glista: 'diversao',
  gopen: 'diversao',
  gcopy: 'diversao',
  glimpar: 'diversao',
  gitsearch: 'diversao',
  github: 'diversao',
  repo: 'diversao',
  poll: 'diversao',
  pollresult: 'diversao',
  startloop: 'diversao',
  stoploop: 'diversao',
  statusloop: 'diversao',
  fakemsg: 'diversao',
  fakechat: 'diversao',
  fake: 'diversao',

  // Admin
  setprefix: 'admin',
  prefixo: 'admin',
  prefix: 'admin',
  addowner: 'admin',
  adddono: 'admin',
  removeowner: 'admin',
  removedono: 'admin',
  deldono: 'admin',
  listowners: 'admin',
  addvip: 'admin',
  removevip: 'admin',
  remvip: 'admin',
  delvip: 'admin',
  vipall: 'admin',
  addvipall: 'admin',
  removervipall: 'admin',
  rmvipall: 'admin',
  delvipall: 'admin',
  listvips: 'admin',
  addblacklist: 'admin',
  removeblacklist: 'admin',
  listblacklist: 'admin',
  evoadmin: 'admin',
  evoconfig: 'admin',
  evoreset: 'admin',
  block: 'admin',
  bloquear: 'admin',
  blockcmd: 'admin',
  bloquearcmd: 'admin',
  desbloquearcmd: 'admin',
  listablockcmd: 'admin',
  bloquearcomando: 'admin',
  unblock: 'admin',
  desbloquear: 'admin',
  liberar: 'admin',
  unblockall: 'admin',
  liberartodos: 'admin',
  desbloquearall: 'admin',
  blocklist: 'admin',
  listblock: 'admin',
  tentativasinjecao: 'admin',
  injectlog: 'admin',
  injecoes: 'admin',
  logs: 'admin',
  rr: 'admin',
  clearsession: 'admin',
  repairsession: 'admin',
  backupsession: 'admin',
  exportsession: 'admin',
  importsession: 'admin',
  restoresession: 'admin',
  badmac: 'admin',
  pair: 'admin',
  pairstatus: 'admin',
  paircancel: 'admin',
  addai: 'admin',
  menu_admin: 'admin',
  menu_dono: 'admin',
  menu_adm: 'grupo_mod',
  menudono: 'admin',
  menuadm: 'grupo_mod',
  intentrouter: 'admin',
  host: 'admin',
  hostmenu: 'admin',
  raikken: 'admin',
  osint: 'admin',
  autoapresentar: 'grupo_entrada',
  autoapres: 'grupo_entrada',

  // Zone — midia
  ephoto: 'downloads',
  logo: 'downloads',
  logos: 'downloads',
  flux: 'downloads',
  nano: 'downloads',
  nanobanana: 'downloads',
  edits: 'downloads',
  editarimg: 'downloads',
  upscale: 'downloads',
  tourl: 'downloads',
  shazam: 'downloads',

  // Zone — IA
  grok: 'ia',
  grokia: 'ia',
  fdc: 'ia',
  fatos: 'ia',

  // Zone — consultas publicas
  cep: 'consultas',
  cnpj: 'consultas',
  ip: 'consultas',
  ttkstalk: 'consultas',
  tiktokstalk: 'consultas',
  infoff: 'consultas',
  ffinfo: 'consultas',
  likeff: 'consultas',
  curtirff: 'consultas',

  // Zone — utilidades
  cotacao: 'utilidades',
  dolar: 'utilidades',
  encurta: 'utilidades',
  encurtar: 'utilidades',
  qr: 'utilidades',
  qrcode: 'utilidades',
  lerqr: 'utilidades',
  calc: 'utilidades',
  calcular: 'utilidades',
  walink: 'utilidades',
  wame: 'utilidades',
  placar: 'utilidades',

  // Billing / conta
  comprar: 'geral',
  planos: 'geral',
  preco: 'geral',
  sobre: 'geral',
  dono: 'geral',
  ownerinfo: 'geral',
  minhaconta: 'geral',
  meuplano: 'geral',
  meupagamento: 'geral',
  suporte: 'geral',
  vincular: 'geral',
  vincularconta: 'geral',
  baixarbot: 'geral',
  meubot: 'geral',
  health: 'admin',
  pedidos: 'admin',

  // Zone — diversao
  forca: 'diversao',
  ppt: 'diversao',
  jokenpo: 'diversao',
  dado: 'diversao',
  roleta: 'diversao',
  minado: 'diversao',
  plantar: 'diversao',
  regar: 'diversao',
  colher: 'diversao',
  casar: 'diversao',
  namoro: 'diversao',
  beijar: 'diversao',
  flerte: 'diversao',
  eununca: 'diversao',
  vdb: 'diversao',
  vdd: 'diversao',
  verdade: 'diversao',
  piada: 'diversao'
};

/** Mapeamento de categorias antigas → novas (quando sem override) */
const OLD_CAT_MAP = {
  geral: 'geral',
  downloads: 'downloads',
  consultas: 'consultas',
  hanorkapi: 'ia',
  webia: 'diversao',
  github: 'diversao',
  divulgacao: 'divulgacao',
  grupos: 'grupo_config',
  antiflood: 'grupo_seg',
  nuke: 'grupo_mod',
  mensagens: 'utilidades',
  interativos: 'utilidades',
  canais: 'utilidades',
  botoes: 'utilidades',
  config: 'admin',
  perfil: 'utilidades',
  status: 'utilidades',
  enquetes: 'diversao',
  agenda: 'utilidades',
  twilio: 'utilidades',
  admin: 'admin',
  tools: 'diversao',
  exploits: 'exploits',
  host: 'admin'
};

const CATEGORY_ENTRY = {
  geral: 'menu',
  downloads: 'download',
  consultas: 'menu_consultas',
  figurinhas: 'figurinha',
  ia: 'hanork',
  grupo_mod: 'menu_grupo_mod',
  grupo_seg: 'gpseguranca',
  grupo_entrada: 'menu_grupo_entrada',
  grupo_config: 'menu_grupo_config',
  divulgacao: 'divmenu',
  diversao: 'menu_diversao',
  utilidades: 'menu_utilidades',
  admin: 'menu_admin',
  exploits: 'menu_exploits'
};

const MENU_CAT_ORDER = TAXONOMY.map((t) => t.id);

function guessCategoryForTyped(typed) {
  const n = String(typed || '').toLowerCase().replace(/^\.+/, '').trim();
  if (!n) return null;
  if (CMD_OVERRIDE[n]) return CMD_OVERRIDE[n];
  if (n.startsWith('menu_hanork') || n.startsWith('hanork')) return 'ia';
  if (n.startsWith('host')) return 'admin';
  if (/^(anti|surf|limiteflood|limitec|autodown|autosticker|bangp|unbangp)/.test(n)) return 'grupo_seg';
  if (/^(play|tiktok|tt|ig|insta|spotify|facebook|yt|download|mediafire|kwai|pinterest|pin)/.test(n)) {
    return 'downloads';
  }
  if (/^(cpf|nome|placa|telefone|consulta|serasa|cep|cnpj|ip|ttkstalk|infoff|likeff)/.test(n)) return 'consultas';
  if (/^(fig|sticker|attp|roubar|toimg|filtroigdark|filtroigdark)/.test(n)) return 'figurinhas';
  if (/^(div|addgrupo|grupodiv|grupos|grupoentrar|gruposair|grupolista|grupoconfig)/.test(n)) return 'divulgacao';
  if (/^(ban|kick|mute|cita|nuke|bna)/.test(n)) return 'grupo_mod';
  if (/^(ephoto|flux|nano|edits|upscale|tourl|shazam)/.test(n)) return 'downloads';
  if (/^(forca|ppt|dado|roleta|minado|plantar|casar|eununca|piada|vdb)/.test(n)) return 'diversao';
  if (/^(cotacao|encurta|qr|calc|walink|placar|lerqr)/.test(n)) return 'utilidades';
  if (/^(grok|fdc|fatos)/.test(n)) return 'ia';
  return null;
}

/** Texto curto quando o user erra o comando — aponta o menu, sem lista de exemplos. */
function buildUnknownCommandHint(typed, prefix) {
  const p = prefix || '.';
  const cmd = String(typed || '').replace(/^\.+/, '');
  const catId = guessCategoryForTyped(cmd);
  const cat = TAXONOMY.find((t) => t.id === catId);
  const entry = catId ? (CATEGORY_ENTRY[catId] || 'menu') : 'menu';
  if (cat) {
    return (
      `Comando ${p}${cmd} nao existe.\n` +
      `Abre ${p}${entry} (${cat.title}) e ve o que tem la.\n` +
      `Ou ${p}menu pra todas as categorias.`
    );
  }
  return (
    `Comando ${p}${cmd} nao existe.\n` +
    `Abre ${p}menu e escolhe a categoria certa — os comandos estao la.`
  );
}

/**
 * Reconstroi CATALOG sob a taxonomia unica.
 * Preserva items hanork_* (subcats API) como hidden/attached.
 * @param {Array} sourceCatalog
 */
function rebuildCatalog(sourceCatalog) {
  const buckets = new Map();
  for (const t of TAXONOMY) {
    buckets.set(t.id, {
      id: t.id,
      title: t.title,
      desc: t.desc,
      items: [],
      platformAdminOnly: t.id === 'exploits' ? undefined : undefined
    });
  }
  // exploits keep platformAdminOnly from source if any
  const seen = new Set();
  const leftovers = [];

  for (const cat of sourceCatalog || []) {
    if (String(cat.id || '').startsWith('hanork_')) {
      leftovers.push(cat);
      continue;
    }
    for (const it of cat.items || []) {
      const name = String(it.name || '').toLowerCase();
      if (!name || seen.has(name)) continue;
      seen.add(name);

      let dest = CMD_OVERRIDE[name];
      if (!dest) dest = OLD_CAT_MAP[cat.id] || 'utilidades';
      // menu_hanork* → ia (exceto figurinhas ja no override)
      if (!CMD_OVERRIDE[name] && name.startsWith('menu_hanork')) dest = 'ia';
      // host* → admin
      if (!CMD_OVERRIDE[name] && name.startsWith('host')) dest = 'admin';
      // anti* toggles → grupo_seg
      if (
        !CMD_OVERRIDE[name] &&
        /^(anti|surf|limiteflood|limitec|autodown|autosticker|bangp|unbangp|addlistabranca|rmlistabranca|listabranca)/.test(name)
      ) {
        dest = 'grupo_seg';
      }

      const bucket = buckets.get(dest) || buckets.get('utilidades');
      bucket.items.push({ ...it });
    }
  }

  // Entrada cmds (podem nao existir no source ainda)
  const entradaExtras = [
    { name: 'autoconvite', desc: 'Alerta pedido de entrada (on/off por grupo)', usage: 'autoconvite on|off', platforms: ['whatsapp'] },
    { name: 'aceitar', desc: 'Aceita solicitacao mais recente', usage: 'aceitar', platforms: ['whatsapp'] },
    { name: 'recusar', desc: 'Recusa solicitacao mais recente', usage: 'recusar', platforms: ['whatsapp'] },
    { name: 'aceitarall', desc: 'Aceita todas as solicitacoes', usage: 'aceitarall', platforms: ['whatsapp'] },
    { name: 'recusarall', desc: 'Recusa todas as solicitacoes', usage: 'recusarall', platforms: ['whatsapp'] },
    { name: 'pedidosentrada', desc: 'Lista/atualiza pedidos pendentes', usage: 'pedidosentrada', platforms: ['whatsapp'] },
    { name: 'menu_grupo_entrada', desc: 'Menu entrada de membros', usage: 'menu_grupo_entrada', platforms: ['whatsapp'] },
    { name: 'menu_grupo_mod', desc: 'Menu moderacao', usage: 'menu_grupo_mod', platforms: ['whatsapp'] },
    { name: 'menu_grupo_config', desc: 'Menu config do grupo', usage: 'menu_grupo_config', platforms: ['whatsapp'] },
    { name: 'menu_diversao', desc: 'Menu diversao', usage: 'menu_diversao' },
    { name: 'menu_utilidades', desc: 'Menu utilidades', usage: 'menu_utilidades' },
    { name: 'menu_figurinhas', desc: 'Menu figurinhas', usage: 'menu_figurinhas', platforms: ['whatsapp'] }
  ];
  for (const it of entradaExtras) {
    const n = it.name.toLowerCase();
    if (seen.has(n)) continue;
    seen.add(n);
    let dest = 'grupo_entrada';
    if (n === 'menu_grupo_mod') dest = 'grupo_mod';
    else if (n === 'menu_grupo_config') dest = 'grupo_config';
    else if (n === 'menu_diversao') dest = 'diversao';
    else if (n === 'menu_utilidades') dest = 'utilidades';
    else if (n === 'menu_figurinhas') dest = 'figurinhas';
    else if (CMD_OVERRIDE[n]) dest = CMD_OVERRIDE[n];
    const bucket = buckets.get(dest) || buckets.get('utilidades');
    bucket.items.unshift(it);
  }

  // Mark exploits
  const exp = buckets.get('exploits');
  if (exp) exp.platformAdminOnly = false; // dono ve; gate real e permission owner

  const out = [...buckets.values()].filter((c) => c.items.length > 0);
  out.push(...leftovers);
  return out;
}

function taxonomyMappingDoc(catalog) {
  const lines = ['## Taxonomia de menus (referencia)', ''];
  lines.push('Regra: 1 comando → 1 categoria. Navegacao: menu → categoria → comando (max 2 cliques).', '');
  for (const cat of catalog) {
    if (String(cat.id || '').startsWith('hanork_')) continue;
    const names = (cat.items || []).map((i) => i.name).filter(Boolean);
    lines.push(`### ${cat.title} (\`${cat.id}\`) — ${names.length} cmds`);
    lines.push('');
    lines.push(names.map((n) => `\`${n}\``).join(', '));
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = {
  TAXONOMY,
  CMD_OVERRIDE,
  OLD_CAT_MAP,
  CATEGORY_ENTRY,
  MENU_CAT_ORDER,
  rebuildCatalog,
  taxonomyMappingDoc,
  guessCategoryForTyped,
  buildUnknownCommandHint
};
