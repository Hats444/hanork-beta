// core/router/errorHandler.js
// Erros: detalhe SO em log; usuario nunca ve stack/tecnico

const logger = require('../../logger');

const PUBLIC_GENERIC =
  'Nao foi possivel concluir agora. Tente de novo em instantes.';

const PUBLIC_RATE =
  'Muitas acoes seguidas. Aguarde um momento e tente de novo.';

const PUBLIC_PERM =
  'Este comando e restrito.';

const PUBLIC_INPUT =
  'Argumentos invalidos. Confira o uso no menu.';

/**
 * Detecta texto tecnico que NAO deve ir pro WhatsApp/Telegram do cliente.
 */
function looksTechnical(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (
    /^(Erro:|Error:|TypeError|ReferenceError|SyntaxError|AggregateError)/im.test(t)
  ) {
    return true;
  }
  if (
    /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPERM|ENOENT|EACCES)\b/i.test(t)
  ) {
    return true;
  }
  if (
    /\b(rate-overlimit|rate overlimit|Connection Closed|statusCode|status code|axios|fetch failed|socket hang up|OUTBOUND_GATE|SQLITE|invalid ELF|node_modules|\/home\/container|C:\\Users|at Object\.|at Module\.|at async )/i.test(
      t
    )
  ) {
    return true;
  }
  if (/Permissao negada:/i.test(t)) return true;
  if (/Input invalido:/i.test(t)) return true;
  if (/Limite evolucionario:/i.test(t)) return true;
  if (/\[ROUTER\]|\[LOCK\]|\[sqlStore\]|\[outboundGate\]/i.test(t)) return true;
  if (/Erro ao (processar|enviar|executar|ler|gravar)/i.test(t) && /[:：]/.test(t)) {
    // "Erro ao X: detalhe tecnico"
    if (/Erro ao [^:]{0,40}:\s*\S+/i.test(t)) return true;
  }
  // stack-ish multi-line
  if (/\n\s+at\s+/.test(t)) return true;
  return false;
}

/**
 * Sanitiza erro (legado) — ainda pode vazar tecnico; preferir toPublicError.
 */
function sanitizeError(error) {
  if (!error) return 'Erro desconhecido';

  const errorMessage = typeof error === 'string' ? error : error.message || String(error);

  const sanitized = errorMessage
    .replace(/token[:\s][\w\-]+/gi, 'token:***')
    .replace(/password[:\s][\w\-]+/gi, 'password:***')
    .replace(/secret[:\s][\w\-]+/gi, 'secret:***')
    .replace(/api[_-]?key[:\s][\w\-]+/gi, 'api_key:***')
    .replace(/session[_-]?id[:\s][\w\-]+/gi, 'session_id:***')
    .replace(/jid[:\s][\w@\-\.]+/gi, 'jid:***')
    .replace(/\/[\w\-\/\.]+/g, '/[PATH]')
    .replace(/at [\w\-\/\.]+/g, 'at [FILE]')
    .replace(/C:\\[\w\\\-\.]+/g, 'C:\\[PATH]')
    .replace(/\/home\/[\w\/\-\.]+/g, '/home/[PATH]');

  const withoutStack = sanitized.split('\n').slice(0, 1).join('');
  const maxLength = 200;
  if (withoutStack.length > maxLength) {
    return withoutStack.substring(0, maxLength) + '...';
  }
  return withoutStack;
}

function formatErrorForLog(error, context = {}) {
  return {
    message: sanitizeError(error),
    originalMessage: error?.message || String(error),
    stack: error?.stack || '',
    context: {
      command: context.command || 'unknown',
      userId: context.userId || 'unknown',
      sessionId: context.sessionId || 'unknown',
      platform: context.platform || 'unknown'
    }
  };
}

function logInternalError(error, context = {}) {
  const logEntry = formatErrorForLog(error, context);
  logger.logException('[ROUTER ERROR]', error, {
    command: logEntry.context.command,
    userId: logEntry.context.userId,
    sessionId: logEntry.context.sessionId,
    platform: logEntry.context.platform,
    sanitized: logEntry.message
  });
}

/**
 * Mensagem segura pro cliente (nunca stack / never e.message cru).
 */
function getUserErrorMessage(error) {
  const raw = typeof error === 'string' ? error : error?.message || String(error || '');
  const low = raw.toLowerCase();

  if (/permiss|nao autorizado|apenas (dono|vip|admin)|restrit/i.test(low)) {
    return PUBLIC_PERM;
  }
  // rate-overlimit do Zap NAO e o user spamando comando
  if (/\brate-overlimit\b|overlimit/i.test(low) && !/muitos comandos/i.test(low)) {
    return 'O WhatsApp recusou o envio agora. Tente de novo em alguns segundos.';
  }
  if (/rate\s*limit|muitos comandos/i.test(low)) {
    return PUBLIC_RATE;
  }
  if (/input invalido|argumentos|uso:/i.test(low)) {
    return PUBLIC_INPUT;
  }
  if (/timeout|demorou/i.test(low)) {
    return 'A operacao demorou demais. Tente de novo.';
  }
  if (/network|econnrefused|enotfound|offline|connection closed/i.test(low)) {
    return 'Falha de conexao temporaria. Tente de novo.';
  }
  return PUBLIC_GENERIC;
}

/** Alias claro */
function toPublicError(error) {
  return getUserErrorMessage(error);
}

/**
 * Se o texto de saida parece erro tecnico, troca por generico e loga o original.
 * Mensagens de produto (menu, uso, dicas) passam intactas.
 */
function scrubUserFacingText(text, meta = {}) {
  const t = String(text || '');
  if (!looksTechnical(t)) return t;
  try {
    logger.logUserFacingError('SCRUBBED_OUTBOUND', t.slice(0, 2000), meta);
  } catch (_) { /* */ }
  return toPublicError(t);
}

/**
 * Log completo + retorna so texto publico.
 */
function handleCommandError(error, context = {}) {
  logInternalError(error, context);
  return getUserErrorMessage(error);
}

module.exports = {
  PUBLIC_GENERIC,
  PUBLIC_RATE,
  PUBLIC_PERM,
  PUBLIC_INPUT,
  looksTechnical,
  sanitizeError,
  formatErrorForLog,
  logInternalError,
  getUserErrorMessage,
  toPublicError,
  scrubUserFacingText,
  handleCommandError
};
