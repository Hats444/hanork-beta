// core/router/intent/safety.js
// Gate AUTOMATICO apos a IA (Ollama) / atalho local classificar o comando.
// A NLU continua reconhecendo texto livre; este modulo impede falso positivo
// de virar acao destrutiva (logs, nuke, rr, etc).

const logger = require('../../../logger');
const { isSensitiveCommand } = require('./sensitive');
const { normalizeText, looksLikeMenuRequest } = require('../../../utils/phraseMatch');
const { CATEGORY_ENTRY } = require('../../../utils/menuCatalog');

/** Comandos que SAO menus / listas (seguros de abrir via NL) */
const SAFE_MENU_CMDS = new Set([
  'menu', 'menu_admin', 'menu_dono', 'menu_adm', 'menu_dk', 'menu_tools', 'menu_consultas', 'download', 'downloads',
  'divmenu', 'comandos', 'nukeconfig', 'modstatus', 'buttonmode', 'twiliomenu',
  'groupinfo', 'gitsearch', 'google', 'ping', 'stats', 'tutorial', 'relatorio', 'glista'
]);

/**
 * Familia destrutiva irreversivel: Intent Router exige confirmacao (sim/nao)
 * mesmo com confianca alta. Comando literal (.nuke) nao passa por aqui.
 */
const DESTRUCTIVE_CONFIRM_CMDS = new Set([
  'nuke', 'nukeid', 'nukeas', 'nukename', 'nukedesc', 'nukemsg', 'nukeimg',
  'ban', 'kick', 'banir', 'banall', 'unbanall', 'bangp', 'unbangp',
  'banfake', 'banfakeall', 'banghost', 'bna', 'band',
  'remove', 'clearuser', 'clearall', 'deletar', 'deleta', 'apaga', 'apagar', 'delete', 'limpar',
  'listanegra', 'leave', 'clearsession'
]);

function isDestructiveConfirmCommand(cmd) {
  const c = String(cmd || '').trim().toLowerCase();
  if (!c) return false;
  if (DESTRUCTIVE_CONFIRM_CMDS.has(c)) return true;
  if (c.startsWith('nuke') && c !== 'nukeconfig' && c !== 'nukereset') return true;
  return false;
}

/** Acoes que exigem verbo/intencao EXPLICITA no texto (nao so "menu admin") */
const EXPLICIT_ACTION_HINTS = {
  logs: /\b(ver|mostrar|manda|enviar|abre?\s+os?|quero\s+ver|pegar)\b.*\blogs\b|\blogs\b.*\b(aqui|agora|por\s+favor)\b|^(ver|mostrar|manda|enviar)\s+logs\b/i,
  rr: /\b(reinicia|reiniciar|restart|reboot)\b/i,
  nuke: /\b(apaga|apagar|destruir|explodir|nuke|limpa\s+o\s+grupo)\b/i,
  remove: /\b(remove|remover|banir|kick|tira)\b/i,
  clearsession: /\b(limpa|limpar|apaga|apagar)\b.*\b(sessao|session)\b/i,
  ddos: /\b(ddos|stress|ataque)\b/i,
  crash: /\b(crash|crashar|derrubar)\b/i,
  travazap: /\b(travazap|trava\s*zap|flood)\b/i,
  leave: /\b(sair|sai)\b.*\bgrupo\b/i,
  div: /\b(divulg|broadcast|disparar)\b/i,
  divconfirmar: /\b(confirma|confirmar)\b.*\bdivulg/i
};

/** Texto curto ambiguo → nunca executar acao sensivel */
const AMBIGUOUS_SHORT = /^(admin|admins|adm|logs|nuke|rr|config|opcoes|menu)$/i;

/** Mapa palavra do pedido → comando de MENU seguro */
const CATEGORY_HINTS = [
  [/admin|admins|\badm\b|sessao|session/, 'menu_admin'],
  [/download|baixar|midia/, 'download'],
  [/consulta|cpf|placa/, 'menu_consultas'],
  [/divulg|broadcast/, 'divmenu'],
  [/nuke/, 'nukeconfig'],
  [/antiflood|anti\s*flood|moderac/, 'modstatus'],
  [/bot[aã]o|botoes|forward|encaminhad/, 'buttonmode'],
  [/ferrament|tools/, 'menu_tools'],
  [/github|git/, 'gitsearch'],
  [/grupo|group/, 'groupinfo'],
  [/webia|web\s*intel|google|pesquisa/, 'google'],
  [/twilio|sms/, 'twiliomenu']
];

function isSafeMenuCommand(cmd) {
  const c = String(cmd || '');
  return SAFE_MENU_CMDS.has(c) || c.startsWith('menu_');
}

function resolveSafeMenuFromText(userText) {
  const t = normalizeText(userText);
  for (const [re, dest] of CATEGORY_HINTS) {
    if (re.test(t)) return dest;
  }
  // tenta id do CATEGORY_ENTRY
  for (const [catId, entry] of Object.entries(CATEGORY_ENTRY || {})) {
    if (t.includes(catId) || t.includes(`menu ${catId}`)) return entry;
  }
  return 'menu';
}

/** Toggles de seguranca: "antilinkgp on" / "antiimg off" ja e intencao clara */
const TOGGLE_SECURITY = /^(anti|mod|soadm|onlyadm|limiteflood|bemvindo|saiu|welcome|buttonsoff|buttonson)/i;

function hasExplicitActionHint(command, userText) {
  const cmd = String(command || '');
  const t = String(userText || '');
  const tNorm = normalizeText(t);
  const hint = EXPLICIT_ACTION_HINTS[cmd];
  if (hint) return hint.test(t);

  // Nome do comando + on/off (texto livre sem prefixo)
  const cmdNorm = normalizeText(cmd);
  if (cmdNorm && (tNorm === cmdNorm || tNorm.startsWith(`${cmdNorm} `))) {
    if (/\b(on|off|1|0|ativar|desativar|liga|ligar|desliga|desligar|sim|nao)\b/i.test(tNorm)) {
      return true;
    }
    // so o nome do toggle (ex: "antilinkgp") — dono pediu o comando
    if (TOGGLE_SECURITY.test(cmdNorm) && tNorm === cmdNorm) return true;
  }

  // generico: sensivel sem hint dedicado — exige verbo de acao
  return /\b(faz|fazer|executa|executar|roda|rodar|ativa|ativar|apaga|apagar|limpa|limpar|envia|enviar|manda|mostrar|ver|iniciar|confirma|banir|remove|on|off)\b/i.test(t);
}

/**
 * Aplica politica de seguranca AUTOMATICA sobre o resultado da IA/local.
 * @returns {{ command: string|null, confidence: number, blocked?: boolean, reason?: string, remapped?: boolean }}
 */
function applyIntentSafety(classified, userText, opts = {}) {
  if (!classified?.command) {
    return { command: null, confidence: 0, blocked: true, reason: 'no_command' };
  }

  let command = String(classified.command).trim().toLowerCase();
  let confidence = Number(classified.confidence) || 0;
  const text = String(userText || '');
  const tNorm = normalizeText(text);
  const sensitive = isSensitiveCommand(command, opts.category);

  // 1) Texto ambiguo curto ("admin", "logs") → so menu ou nada
  if (AMBIGUOUS_SHORT.test(tNorm.trim())) {
    if (tNorm === 'menu') {
      return { command: 'menu', confidence: Math.max(confidence, 0.95), remapped: true, reason: 'ambiguous_to_menu' };
    }
    if (/admin|adm/.test(tNorm)) {
      return { command: 'menu_adm', confidence: Math.max(confidence, 0.95), remapped: true, reason: 'ambiguous_admin' };
    }
    // "logs" sozinho: NAO executar — exige "ver logs"
    if (sensitive && !isSafeMenuCommand(command)) {
      logger.logAviso(`[IntentSafety] bloqueado texto ambiguo="${tNorm}" cmd=${command}`);
      return { command: null, confidence: 0, blocked: true, reason: 'ambiguous_short' };
    }
  }

  // 2) Pedido de MENU → nunca executar acao sensivel; remapeia pra menu_*
  if (looksLikeMenuRequest(text)) {
    if (!isSafeMenuCommand(command) || (sensitive && !isSafeMenuCommand(command))) {
      const safe = resolveSafeMenuFromText(text);
      logger.logAviso(`[IntentSafety] menu-request: ${command} → ${safe}`);
      return {
        command: safe,
        confidence: Math.max(confidence, 0.94),
        remapped: true,
        reason: 'menu_request_safe'
      };
    }
    // ja e menu seguro
    return { command, confidence: Math.max(confidence, 0.9), reason: 'menu_ok' };
  }

  // 3) Acao sensivel: exige hint explicito no texto do usuario
  if (sensitive && !isSafeMenuCommand(command)) {
    if (!hasExplicitActionHint(command, text)) {
      // Se parece categoria, abre menu; senao bloqueia
      const maybeMenu = resolveSafeMenuFromText(text);
      if (maybeMenu && maybeMenu !== 'menu' && CATEGORY_HINTS.some(([re]) => re.test(tNorm))) {
        logger.logAviso(`[IntentSafety] sensivel sem verbo → menu ${maybeMenu} (era ${command})`);
        return {
          command: maybeMenu,
          confidence: Math.max(confidence, 0.9),
          remapped: true,
          reason: 'sensitive_no_explicit_verb'
        };
      }
      logger.logAviso(`[IntentSafety] bloqueado sensivel sem intencao clara cmd=${command}`);
      return { command: null, confidence: 0, blocked: true, reason: 'sensitive_needs_explicit' };
    }
    // 4) Sensivel + explicito: confianca minima reforcada
    const minSens = typeof opts.minConfidenceSensitive === 'number' ? opts.minConfidenceSensitive : 0.93;
    if (confidence < minSens) {
      return { command: null, confidence, blocked: true, reason: 'sensitive_low_confidence' };
    }
    // 5) Nuke/ban/apagar via NLU: sempre pedir confirmacao (literal .cmd nao passa aqui)
    if (isDestructiveConfirmCommand(command)) {
      logger.logInfo(`[IntentSafety] needConfirm destructive cmd=${command} conf=${confidence}`);
      return {
        command,
        confidence,
        needConfirm: true,
        reason: 'destructive_nlu_confirm'
      };
    }
  }

  return { command, confidence, reason: 'pass' };
}

module.exports = {
  applyIntentSafety,
  isSafeMenuCommand,
  isDestructiveConfirmCommand,
  resolveSafeMenuFromText,
  hasExplicitActionHint,
  SAFE_MENU_CMDS,
  DESTRUCTIVE_CONFIRM_CMDS
};
