// utils/evolution/constants.js — niveis, pesos XP, familias, A/B
'use strict';

/** Schema version (bump + migrate no store se mudar shape) */
const SCHEMA_VERSION = 1;

/** Niveis progressivos (XP cumulativo) */
const LEVELS = [
  {
    id: 1,
    name: 'Semente',
    xp: 0,
    unlocks: ['base'],
    perks: []
  },
  {
    id: 2,
    name: 'Broto',
    xp: 40,
    unlocks: ['tips_on', 'view_nivel'],
    perks: ['tips']
  },
  {
    id: 3,
    name: 'Raiz',
    xp: 120,
    unlocks: ['reco_cmds', 'streak_visible'],
    perks: ['tips', 'reco']
  },
  {
    id: 4,
    name: 'Galho',
    xp: 280,
    unlocks: ['upsell_vip', 'daily_second_tip'],
    perks: ['tips', 'reco', 'upsell_vip']
  },
  {
    id: 5,
    name: 'Copa',
    xp: 550,
    unlocks: ['quota_burst_eligible', 'ab_advanced'],
    perks: ['tips', 'reco', 'upsell_vip', 'burst']
  },
  {
    id: 6,
    name: 'Floresta',
    xp: 1000,
    unlocks: ['upsell_pro', 'leaderboard'],
    perks: ['tips', 'reco', 'upsell_vip', 'burst', 'upsell_pro']
  },
  {
    id: 7,
    name: 'Lenda',
    xp: 1800,
    unlocks: ['prestige', 'badge_lenda'],
    perks: ['tips', 'reco', 'upsell_vip', 'burst', 'upsell_pro', 'prestige']
  }
];

/** XP por familia de comando (ok / fail / attempt) */
const FAMILY_XP = {
  sticker: { ok: 8, fail: 1 },
  download: { ok: 12, fail: 2 },
  consulta: { ok: 15, fail: 2 },
  ia: { ok: 20, fail: 3 },
  search: { ok: 10, fail: 2 },
  protecao: { ok: 25, fail: 1 },
  canal: { ok: 18, fail: 2 },
  div: { ok: 22, fail: 2 },
  menu: { ok: 2, fail: 0 },
  geral: { ok: 4, fail: 1 },
  midia: { ok: 6, fail: 1 },
  admin: { ok: 8, fail: 1 },
  other: { ok: 5, fail: 1 }
};

/** Bonus / penalidades */
const XP_RULES = {
  streakDay: 12,
  streakCap: 7,
  levelUpBonus: 15,
  firstOfDay: 5,
  diversityBonus: 4, // nova familia no dia
  conversionBonus: 30, // tip A/B → acao alvo
  failStreakPenalty: -8, // a cada 3 fails seguidos
  softCapPerCmdPerHour: 6, // alem disso XP cai 50%
  softCapXpMult: 0.5
};

/** Familias por nome de comando (exact + prefix helpers in classify) */
const CMD_FAMILY = {
  s: 'sticker', f: 'sticker', sticker: 'sticker', stiker: 'sticker', fig: 'sticker',
  st: 'sticker', stk: 'sticker', fsticker: 'sticker', toimg: 'sticker', toimage: 'sticker',
  roubar: 'sticker', take: 'sticker', attp: 'sticker', ususticker: 'sticker', us: 'sticker',
  play: 'download', ytmp3: 'download', mp3: 'download', yt: 'download', ytaudio: 'download',
  playaudio: 'download', playvideo: 'download', playvid: 'download', ytmp4: 'download',
  ytv: 'download', ytvideo: 'download', tiktok: 'download', tt: 'download', tk: 'download',
  instagram: 'download', ig: 'download', insta: 'download', facebook: 'download', fb: 'download',
  spotify: 'download', soundcloud: 'download', sc: 'download', mediafire: 'download', mf: 'download',
  twitter: 'download', x: 'download', kwai: 'download', threads: 'download', capcut: 'download',
  pinterest: 'download', pin: 'download', download: 'download', downloads: 'download', ytsearch: 'download',
  consulta: 'consulta', cpf: 'consulta', nome: 'consulta', telefone: 'consulta',
  hanork: 'ia', gpt: 'ia', claude: 'ia', deepsearch: 'ia', analisar: 'ia', ganalisar: 'ia', relatorio: 'ia',
  google: 'search', pesquisar: 'search', web: 'search', search: 'search', googlelista: 'search',
  antilink: 'protecao', antilinkhard: 'protecao', antifake: 'protecao', antiataque: 'protecao',
  protecaototal: 'protecao', antiporno: 'protecao', modenable: 'protecao', gpseguranca: 'protecao',
  modstatus: 'protecao', soadm: 'protecao',
  figurinha: 'canal', figcanal: 'canal', figurinhas: 'canal', figurinhas2: 'canal',
  div: 'div', divpay: 'div', divfull: 'div', divcf: 'div', addgrupo: 'div', divstatus: 'div',
  menu: 'menu', comandos: 'menu', tutorial: 'menu', help: 'menu', ajuda: 'menu',
  ping: 'geral', stats: 'geral', sobre: 'geral', comprar: 'geral', planos: 'geral',
  nivel: 'geral', evolucao: 'geral', rank: 'geral', desbloqueios: 'geral',
  text: 'midia', image: 'midia', album: 'midia', react: 'midia', poll: 'midia'
};

/** Cmds caros (quota / throttle) */
const COSTLY_CMDS = new Set([
  'deepsearch', 'analisar', 'ganalisar', 'relatorio', 'hanork', 'gpt', 'claude',
  'consulta', 'figurinha', 'figcanal', 'figurinhas', 'figurinhas2',
  'div', 'divpay', 'divfull', 'play', 'playvideo', 'tiktok', 'instagram'
]);

/** Variantes A/B de tips */
const TIP_VARIANTS = {
  upsell_vip: {
    A: (p) =>
      `Voce ja usa o Hanork de verdade.\nVIP libera falar natural: ${p}hanork\nPlanos: ${p}comprar`,
    B: (p) =>
      `Proximo nivel: IA + pesquisa profunda.\nAtive VIP e teste ${p}hanork oi\nOu ${p}planos`
  },
  upsell_pro: {
    A: (p) =>
      `Seu grupo ja esta maduro.\nPro: divulgacao + canal + multi-grupo.\nFale com o dono: ${p}sobre`,
    B: (p) =>
      `Falta pouco pro pacote completo.\nDivulgacao e protecao avancada no plano Pro.\n${p}comprar`
  },
  level_up: {
    A: (p, ctx) =>
      `Subiu de nivel: ${ctx.fromName} → ${ctx.toName} (Nv ${ctx.toId})\nVeja: ${p}nivel`,
    B: (p, ctx) =>
      `Evolucao: agora voce e ${ctx.toName}.\nDesbloqueios: ${p}desbloqueios`
  },
  streak: {
    A: (p, ctx) =>
      `Sequencia: ${ctx.streak} dia(s) ativos. Continue pra bonus de XP.\n${p}evolucao`,
    B: (p, ctx) =>
      `${ctx.streak}d seguidos no Hanork. Nao quebre a corrente.\nStatus: ${p}nivel`
  },
  reco: {
    A: (p, ctx) =>
      `Com base no seu uso, experimente: ${p}${ctx.cmd}\nMais: ${p}evolucao`,
    B: (p, ctx) =>
      `Quem usa como voce curte ${ctx.cmd}.\nTente ${p}${ctx.cmd} · ${p}rank`
  },
  fail_help: {
    A: (p, ctx) =>
      `Esse comando falhou algumas vezes.\nAlternativa estavel: ${p}${ctx.alt}\nAjuda: ${p}tutorial`,
    B: (p, ctx) =>
      `Dica: ${ctx.cmd} anda instavel.\nUse ${p}${ctx.alt} ou veja ${p}menu`
  }
};

/** Throttle tips (ms) */
const TIP_THROTTLE = {
  group: 240000,
  dm: 90000,
  level_up: 0,
  sameKind: 3600000
};

/** Fallbacks de download instavel → alternativa */
const FAIL_ALTS = {
  tiktok: 'play',
  tt: 'play',
  tk: 'play',
  instagram: 'play',
  ig: 'play',
  twitter: 'play',
  x: 'spotify',
  deepsearch: 'google',
  analisar: 'google'
};

module.exports = {
  SCHEMA_VERSION,
  LEVELS,
  FAMILY_XP,
  XP_RULES,
  CMD_FAMILY,
  COSTLY_CMDS,
  TIP_VARIANTS,
  TIP_THROTTLE,
  FAIL_ALTS
};
