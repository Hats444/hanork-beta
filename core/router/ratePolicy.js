// core/router/ratePolicy.js
// Politica unica de rate-limit (router + intent + classify)
'use strict';

/** Navegacao / UX — nao pode travar dono/admin no dia a dia */
const NAV_EXEMPT = new Set([
  'menu', 'ping', 'stats', 'help', 'ajuda', 'comandos', 'tutorial', 'novidades', 'changelog', 'oquemudou',
  'sobre', 'dono', 'comprar', 'planos', 'preco', 'ownerinfo', 'meujid', 'cancelar',
  'minhaconta', 'meuplano', 'meupagamento', 'suporte',
  'vincular', 'vincularconta', 'baixarbot', 'meubot',
  'nivel', 'evolucao', 'evo', 'desbloqueios', 'rank', 'ranking', 'evoleader',
  'modstatus', 'gpseguranca', 'modlist', 'modhelp', 'antifloodhelp',
  'protecoes', 'protecoesativas', 'protecoeshelp',
  'oquestaon', 'protecoeson',
  'listowners', 'listvips', 'listblacklist', 'divstatus', 'divgrupos', 'divhelp', 'divajuda', 'divmenu',
  'prefixo', 'prefix',
  'boton', 'botoff',
  'dk', 'entrardk', 'msgdk', 'dklink', 'dkpay', 'msgdkpay', 'menudk', 'dkmenu', 'menu_dk',
  'grupos', 'grupolista', 'grupoconfig',
  'hoststatus', 'hostinfo', 'hostmenu', 'raikken', 'host',
  'pairstatus', 'groupinfo', 'groupid', 'channelid', 'channelinfo',
  'groupinvite', 'linkgp', 'linkgrupo', 'grouplink',
  'menu_consultas', 'consultas', 'mind7', 'm7'
]);

/** Prefixos de painel / menu (UI) */
const NAV_PREFIXES = [
  'menu_',
  'info_', // gates info no painel
];

/** Pesados (API / custo) — limite mais baixo */
const HEAVY_DEFAULT = new Set([
  'google', 'pesquisar', 'web', 'search', 'deepsearch', 'analisar', 'ganalisar', 'relatorio',
  'consulta',
  'cpffull', 'buscanome', 'celular', 'placafull',
  'parentes', 'score',
  'div', 'dk', 'entrardk', 'divpay', 'divfull', 'divcf',
  'gitsearch', 'github', 'repos', 'repo',
  'play', 'ytmp3', 'mp3', 'yt', 'ytaudio', 'playaudio',
  'playvideo', 'playvid', 'ytmp4', 'ytv', 'ytvideo',
  'tiktok', 'tt', 'tk', 'tkdl', 'instagram', 'ig', 'insta', 'igdl', 'igvideo', 'instagram2', 'igpost',
  'facebook', 'fb', 'spotify', 'soundcloud', 'sc', 'scloud',
  // NOTA: 'sc' acima e o alias de SoundCloud (registrado no commands/downloads).
  // Por isso o atalho curto do sitecheck NAO e 'sc' — usaria o mesmo prefixo e
  // a NLU cairia em conflito. O atalho livre e 'checarsite'.
  'mediafire', 'mf', 'twitter', 'twtdl', 'x', 'kwai', 'threads', 'thdl', 'capcut',
  'pinterest', 'pindl', 'pinmp4', 'pinterestmp4',
  'download', 'downloads', 'ytsearch',
  'hanork', 'gpt', 'claude', 'figurinha', 'figcanal', 'figurinhas', 'figurinhas2',
  'osint',
  // .sitecheck: dispara ~20 checagens de rede (DNS+HTTP+TLS+10 portas+geo).
  // Entra como PESADO: limite bem menor que o default, senao queima cota das
  // fontes e o cooldown por usuario vira decoracao.
  // SEM o alias 'sc' de proposito: 'sc' ja e do SoundCloud em commands/downloads
  // e a NLU cairia em conflito (mesmo prefixo, comandos diferentes).
  'sitecheck', 'checarsite',
  'ephoto', 'flux', 'nano', 'nanobanana', 'edits', 'upscale', 'shazam',
  'grok', 'ttkstalk', 'infoff', 'likeff', 'tourl',
  'tts', 'tomp3', 'audiofx', 'figquote'
]);

function normalizeCmd(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^[.\/!#•]+/, '')
    .split(/\s+/)[0] || '';
}

function isNavExempt(commandName) {
  const c = normalizeCmd(commandName);
  if (!c) return false;
  if (NAV_EXEMPT.has(c)) return true;
  for (const p of NAV_PREFIXES) {
    if (c.startsWith(p)) return true;
  }
  // toggles de protecao no painel (on/off sem custo)
  if (/^(anti|auto|soadm|onlyadm|bangp|bemvindo|saiu|mute|desmute|aceitar|recusar|autoconvite|pedidosentrada|autoapresentar)/.test(c)) return true;
  return false;
}

function isHeavy(commandName, extraHeavySet = null) {
  const c = normalizeCmd(commandName);
  if (isNavExempt(c)) return false;
  if (HEAVY_DEFAULT.has(c)) return true;
  if (extraHeavySet && extraHeavySet.has(c)) return true;
  return false;
}

/**
 * Limite por comando.
 * @returns {{ max: number, window: number, skip: boolean, skipGlobal: boolean }}
 */
function commandRateConfig(commandName, { permission = 'user', heavySet = null } = {}) {
  const c = normalizeCmd(commandName);
  if (isNavExempt(c)) {
    return { max: 180, window: 60_000, skip: true, skipGlobal: true };
  }
  if (permission === 'platform_admin' && !isHeavy(c, heavySet)) {
    return { max: 60, window: 60_000, skip: false, skipGlobal: false };
  }
  if (isHeavy(c, heavySet)) {
    return { max: 12, window: 60_000, skip: false, skipGlobal: false };
  }
  if (permission === 'owner' && (c.startsWith('div') || c.startsWith('nuke'))) {
    return { max: 6, window: 60_000, skip: false, skipGlobal: false };
  }
  // default cotidiano
  return { max: 45, window: 60_000, skip: false, skipGlobal: false };
}

/** Global por papel (por minuto) */
function globalRateConfig(role = 'user') {
  const r = String(role || 'user');
  if (r === 'platform_admin' || r === 'owner') {
    return { max: 240, window: 60_000 };
  }
  if (r === 'vip') {
    return { max: 120, window: 60_000 };
  }
  return { max: 80, window: 60_000 };
}

/**
 * Evolution maxMult so afeta cmds caros — menu/admin nao sofrem throttle.
 */
function applyEvoMult(baseMax, maxMult, commandName) {
  const mult = Number(maxMult);
  if (!Number.isFinite(mult) || mult >= 0.999) return Math.max(1, baseMax);
  if (isNavExempt(commandName) || !isHeavy(commandName)) {
    return Math.max(1, baseMax);
  }
  return Math.max(1, Math.floor(baseMax * mult));
}

/** Fila de execucao: estes cmds passam na frente de play/download/NLU. */
const FAST_EXEC_EXTRA = new Set([
  'dk', 'menu_dk', 'dkmenu', 'menudk', 'dkpay', 'msgdk', 'dklink',
  'prefixhint', 'dicaprefixo', 'avisoprefixo',
  'ia', 'ai', 'iaon', 'iaoff',
  'dissecar', 'boton', 'botoff',
  't', 'sett', 'meut', 'editt', 's', 'sticker', 'fig',
  'cita', 'hidetag', 'marcar', 'totag', 'tagall', 'marcartodos',
  'linkgp', 'linkgrupo', 'grouplink', 'groupinvite',
  'seradm', 'sermembro', 'viraradm', 'virarmembro'
]);

function isFastExecCommand(commandName) {
  const c = normalizeCmd(commandName);
  if (!c) return false;
  if (isNavExempt(c)) return true;
  if (FAST_EXEC_EXTRA.has(c)) return true;
  if (c.startsWith('menu_') || c.startsWith('cmd_') || c.startsWith('info_')) return true;
  return false;
}

module.exports = {
  NAV_EXEMPT,
  HEAVY_DEFAULT,
  FAST_EXEC_EXTRA,
  normalizeCmd,
  isNavExempt,
  isHeavy,
  isFastExecCommand,
  commandRateConfig,
  globalRateConfig,
  applyEvoMult
};
