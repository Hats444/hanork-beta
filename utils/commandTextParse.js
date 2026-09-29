// utils/commandTextParse.js
// Extracao correta de comando + texto livre (string COMPLETA apos o comando)

/** Prefixos tipicos — so pra detectar "digitou o prefixo de outro bot", nunca aliases */
const KNOWN_PREFIX_CHARS = ['.', '/', '!', '#', '•', '$', '*', '>'];

/** Typos comuns de download/user — NUNCA aponta pra nuke/banall/addowner */
const CMD_ALIASES = {
  spotifu: 'spotify',
  spotfy: 'spotify',
  spotifyy: 'spotify',
  spottify: 'spotify',
  spoti: 'spotify',
  spotifydl: 'spotify',
  spotifydownload: 'spotify',
  yotube: 'play',
  youtub: 'play',
  paly: 'play',
  ply: 'play',
  instgram: 'instagram',
  instagran: 'instagram',
  insta: 'instagram',
  tiktoc: 'tiktok',
  tiktokk: 'tiktok'
};

const SAFE_TYPO_TARGETS = [
  'spotify', 'play', 'ytmp3', 'tiktok', 'instagram', 'facebook', 'soundcloud',
  'mediafire', 'twitter', 'pinterest', 'menu', 'ping', 'comandos', 'tutorial',
  'help', 'ajuda', 'sticker', 'figurinha'
];

function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const n = s.length;
  const m = t.length;
  if (!n) return m;
  if (!m) return n;
  const row = new Array(m + 1);
  for (let j = 0; j <= m; j++) row[j] = j;
  for (let i = 1; i <= n; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = row[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[m];
}

/** `spotifu` → `spotify`. Nao corrige rumo a comando de dono. */
function resolveKnownCommand(name) {
  const key = String(name || '').toLowerCase().replace(/-/g, '').trim();
  if (!key) return key;
  if (CMD_ALIASES[key]) return CMD_ALIASES[key];
  if (SAFE_TYPO_TARGETS.includes(key)) return key;
  let best = '';
  let bestD = 99;
  let ties = 0;
  for (const t of SAFE_TYPO_TARGETS) {
    if (Math.abs(t.length - key.length) > 2) continue;
    const d = levenshtein(key, t);
    if (d < bestD) {
      bestD = d;
      best = t;
      ties = 1;
    } else if (d === bestD) {
      ties += 1;
    }
  }
  if (best && ties === 1 && (bestD === 1 || (bestD === 2 && key.length >= 6))) return best;
  return key;
}

/**
 * Prefixo valido:
 * - Telegram: sempre `/` (fixo)
 * - WhatsApp: SO o prefixo da sessao (`.` e `$` nao se misturam)
 */
function resolvePrefixCandidates(userPrefix = '', opts = {}) {
  const platform = String(opts.platform || 'whatsapp').toLowerCase();
  if (platform === 'telegram') return ['/'];
  const primary = String(userPrefix || '').trim() || '.';
  return [primary];
}

/** t / sett / meut sem prefixo (token exato; nao pega "ta" / "to") */
const BARE_COMMANDS = new Set(['t', 'sett', 'meut', 'editt']);

function parseBareCommand(working, raw) {
  const w = String(working || '').trim();
  if (!w) return null;
  const sp = w.search(/\s/);
  const first = (sp === -1 ? w : w.slice(0, sp)).toLowerCase().replace(/-/g, '');
  if (!BARE_COMMANDS.has(first)) return null;
  const text = sp === -1 ? '' : w.slice(sp + 1).trim();
  const args = text ? text.split(/\s+/).filter(Boolean) : [];
  return { prefix: '', command: first, args, text, fullText: raw, bare: true };
}

/**
 * @param {string} fullText
 * @param {string} [userPrefix] - prefixo principal da config
 * @param {{ platform?: string }} [opts]
 * @returns {{ prefix: string, command: string, args: string[], text: string, fullText: string }}
 */
function parsePrefixedCommand(fullText, userPrefix = '', opts = {}) {
  const raw = String(fullText || '');
  let working = raw.trimStart();
  let prefix = '';

  for (const candidate of resolvePrefixCandidates(userPrefix, opts)) {
    if (candidate && working.startsWith(candidate)) {
      prefix = candidate;
      break;
    }
  }

  if (!prefix) {
    const inquiry = working.trim().toLowerCase();
    if (/^(?:>\s*)?(prefixo|prefix)$/.test(inquiry)) {
      return { prefix: '', command: 'prefixo', args: [], text: '', fullText: raw, bare: true };
    }
    const bare = parseBareCommand(working, raw);
    if (bare) return bare;
    return { prefix: '', command: '', args: [], text: '', fullText: raw };
  }

  const rest = working.slice(prefix.length).trim();
  if (!rest) {
    return { prefix, command: '', args: [], text: '', fullText: raw };
  }

  const sp = rest.search(/\s/);
  let command;
  let text;
  if (sp === -1) {
    command = rest.toLowerCase();
    text = '';
  } else {
    command = rest.slice(0, sp).toLowerCase();
    text = rest.slice(sp + 1).trim();
  }

  // `.anti-delete on` → antidelete (hifen no nome, nao no prefixo)
  command = command.replace(/-/g, '');
  command = resolveKnownCommand(command);

  const args = text ? text.split(/\s+/).filter(Boolean) : [];
  // `...` / `..` / `.$` nao e comando — trata como conversa, sem "nao reconhecido"
  if (!/^[a-z][a-z0-9_]{0,48}$/i.test(command)) {
    return { prefix: '', command: '', args: [], text: '', fullText: raw };
  }
  return { prefix, command, args, text, fullText: raw };
}

/**
 * Texto comeca com prefixo de OUTRO bot + nome de comando real.
 * `.ping` com config `$` → true. `...` → false (nao e comando).
 */
function isForeignPrefix(fullText, configuredPrefix, opts = {}) {
  const raw = String(fullText || '').trimStart();
  if (!raw) return false;
  const platform = String(opts.platform || 'whatsapp').toLowerCase();
  const configured = platform === 'telegram'
    ? '/'
    : (String(configuredPrefix || '').trim() || '.');
  const parsedOk = parsePrefixedCommand(raw, configured, { platform });
  if (parsedOk.prefix) return false;
  for (const p of KNOWN_PREFIX_CHARS) {
    if (!p || p === configured || !raw.startsWith(p)) continue;
    const rest = raw.slice(p.length).trim();
    const cmd = (rest.split(/\s/)[0] || '').toLowerCase();
    if (/^[a-z][a-z0-9_]{0,48}$/i.test(cmd)) return true;
  }
  return false;
}

/** Comandos cujo argumento e texto livre (query/frase) */
const FREE_TEXT_COMMANDS = new Set([
  'play', 'ytmp3', 'mp3', 'yt', 'ytaudio', 'playaudio',
  'playvideo', 'playvid', 'ytmp4', 'ytv', 'ytvideo',
  'ytsearch', 'download', 'downloads',
  'tiktok', 'tt', 'tk', 'instagram', 'ig', 'insta', 'igdl', 'igvideo', 'instagram2', 'igpost', 'igstory', 'ighighlights',
  'facebook', 'fb', 'spotify', 'spotifu', 'spotfy', 'soundcloud', 'sc',
  'mediafire', 'mf', 'twitter', 'twtdl', 'x',
  'kwai', 'threads', 'thdl', 'capcut', 'pinterest', 'pindl', 'pinmp4', 'pinterestmp4',
  'google', 'pesquisar', 'deepsearch', 'web', 'search',
  'gitsearch', 'github', 'repo', 'repos',
  'nukename', 'nukedesc', 'nukemsg',
  'msgdivul', 'msgdivulpay', 'msgdivulstatus', 'msgdk', 'dkpay', 'msgdkpay', 'setname', 'setbio', 'groupname', 'groupdesc',
  'setgroupname', 'setgroupdesc', 'text', 'fakemsg', 'fake',
  'status', 'statuspost', 'groupstatus', 'closefriends', 'paypost', 'pagamentopost', 'postpay',
  'bandeja', 'postbandeja',
  'creategroup', 'channelpost', 'edit', 'react', 'poll',
  'schedule', 'sms', 'otp', 'call', 'email', 'travazap',
  'consulta', 'nome', 'mae', 'analisar', 'gopen', 'gcopy',
  'addowner', 'removeowner', 'addvip', 'removevip',
  'likeff', 'curtirff', 'infoff'
]);

const QUERY_FILLERS = [
  {
    cmds: ['play', 'ytmp3'],
    re: /^(?:quero\s+(?:ouvir|tocar)|(?:vou\s+)?ouvir|toca(?:r)?|toque|manda(?:r)?|passa(?:r)?|coloca(?:r)?|p[oô]e|play|baixa(?:r)?(?:\s+(?:a|o|uma|um))?(?:\s+m[uú]sica)?|manda(?:\s+uma)?(?:\s+m[uú]sica)?)\s+(?:a\s+|o\s+|uma\s+|um\s+)?(?:m[uú]sica\s+)?/i
  },
  {
    cmds: ['google', 'pesquisar', 'web', 'search'],
    re: /^(?:pesquisa(?:r)?|busca(?:r)?|procura(?:r)?|google(?:r)?)\s+(?:no\s+|na\s+|por\s+)?(?:web\s+|google\s+|internet\s+)?/i
  },
  {
    cmds: ['deepsearch'],
    re: /^(?:busca\s+profunda|pesquisa\s+profunda|deep\s*search|deepsearch)\s+/i
  },
  {
    cmds: ['ytsearch'],
    re: /^(?:busca(?:r)?|pesquisa(?:r)?)\s+(?:no\s+)?(?:youtube|yt)\s+/i
  },
  {
    cmds: ['gitsearch', 'github'],
    re: /^(?:busca(?:r)?|pesquisa(?:r)?)\s+(?:no\s+)?github\s+/i
  },
  {
    cmds: ['tiktok'],
    re: /^(?:baixa(?:r)?|download)\s+(?:esse\s+|o\s+)?(?:tiktok|video)?\s*/i
  },
  {
    cmds: ['instagram'],
    re: /^(?:baixa(?:r)?|download)\s+(?:esse\s+|o\s+)?(?:instagram|reel|ig)?\s*/i
  }
];

/**
 * Extrai termo de busca removendo fillers de linguagem natural.
 * Se nao houver filler conhecido, devolve o texto original.
 */
function extractFreeTextArg(command, userText) {
  const raw = String(userText || '').trim();
  if (!raw) return '';
  const cmd = String(command || '').toLowerCase();
  for (const rule of QUERY_FILLERS) {
    if (!rule.cmds.includes(cmd)) continue;
    if (rule.re.test(raw)) {
      const out = raw.replace(rule.re, '').trim();
      return out || raw;
    }
  }
  // fallback generico: "comando X" no inicio
  const head = new RegExp(`^${cmd}\\s+`, 'i');
  if (head.test(raw)) return raw.replace(head, '').trim();
  return raw;
}

function isFreeTextCommand(name) {
  return FREE_TEXT_COMMANDS.has(String(name || '').toLowerCase());
}

/** Resolve argumento de texto livre a partir do ctx do handler */
function resolveCtxFreeText(ctx) {
  const direct = String(ctx?.text || ctx?.q || '').trim();
  if (direct) return direct;
  const fromArgs = Array.isArray(ctx?.args) ? ctx.args.join(' ').trim() : '';
  return fromArgs;
}

module.exports = {
  /** @deprecated use KNOWN_PREFIX_CHARS — mantido pra nao quebrar requires antigos */
  UNIVERSAL_PREFIXES: KNOWN_PREFIX_CHARS,
  KNOWN_PREFIX_CHARS,
  parsePrefixedCommand,
  parseBareCommand,
  BARE_COMMANDS,
  resolvePrefixCandidates,
  isForeignPrefix,
  FREE_TEXT_COMMANDS,
  extractFreeTextArg,
  isFreeTextCommand,
  resolveCtxFreeText,
  resolveKnownCommand
};
