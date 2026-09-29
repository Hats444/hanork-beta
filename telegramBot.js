// telegramBot.js
require('dotenv').config();

const logger = require('./logger');
const path = require('path');
const fs = require('fs');
const { normalizeJid, resolveLid, getPhoneForLid, getLidForPhone } = require('./utils');
const { setForwardMode, isForwardModeEnabled, getForwardModeStatus, clearForwardMode } = require('./utils/channelForward');
const { processEvent } = require('./core/router/universalRouter');
require('./core/router/registeredCommands'); // Carregar comandos migrados
const { createTelegramBaileysShim, isHanorkApiCommand } = require('./utils/telegramBaileysShim');

/** Comandos com bot.onText dedicado — router com shim geraria envio duplo */
const TG_ONTEXT_HANDLED = new Set([
  'play', 'ytmp3', 'playvideo', 'ytmp4', 'playvid',
  'tiktok', 'instagram', 'ig', 'insta',
  'ytsearch', 'download', 'downloads',
  'facebook', 'fb', 'facevideo',
  'spotify', 'mediafire', 'twitter', 'x', 'twtdl',
  'kwai', 'threads', 'thdl', 'capcut', 'capcutmodel',
  'soundcloud', 'pinterest', 'pindl', 'pinmp4',
  'consulta', 'menu_consultas',
  'google', 'pesquisar', 'web', 'search',
  'deepsearch', 'analisar', 'ganalisar', 'relatorio',
  'glista', 'glist', 'googlelista', 'gopen', 'gcopy', 'glimpar',
  'menu', 'start', 'help', 'mysessions', 'admin', 'caixa', 'painel',
  'setprefix', 'listowners', 'listvips', 'listblacklist',
  'addowner', 'removeowner', 'addvip', 'removevip',
  'addblacklist', 'removeblacklist',
  'intentrouter',
  'sobre', 'dono', 'comprar', 'planos', 'preco', 'ownerinfo',
  'minhaconta', 'meuplano', 'meupagamento', 'suporte'
]);

/** So o que o Telegram realmente opera (botoes + slash nativos). O resto e WhatsApp. */
const TG_PANEL_COMMANDS = new Set([
  'start', 'help', 'connect', 'mysessions', 'admin', 'caixa', 'painel',
  'comprar', 'planos', 'preco', 'minhaconta', 'meuplano', 'meupagamento',
  'suporte', 'vincular', 'baixarbot', 'meubot', 'afiliado', 'indicar',
  'nukename', 'nukedesc', 'nukemsg', 'nukeimg', 'nukeconfig', 'nukereset',
  'nuke', 'nukeid', 'nukeas',
  'grupos', 'grupolista', 'grupoconfig', 'grupoentrar', 'gruposair', 'divgrupos',
  'setprefix', 'addowner', 'removeowner', 'listowners',
  'addvip', 'removevip', 'listvips',
  'addblacklist', 'removeblacklist', 'listblacklist',
  'autodivbot', 'sobre', 'dono', 'ownerinfo'
]);

// ========== LOCK DE INSTÂNCIA ÚNICA (P9) ==========
// Em Pterodactyl/Docker o PID é reutilizado (ex: lock diz 33, novo container tem npm no 33).
// Só bloqueia se o PID vivo for OUTRO node rodando index.js/telegramBot.js.
const LOCK_FILE = path.join(__dirname, 'data/.telegram_bot.lock');
let lockFileHandle = null;

function ensureDataDir() {
  const dir = path.dirname(LOCK_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/** true se o PID vivo parece o bot (node/npm). PID vivo + /proc ilegivel = NAO roubar. */
function isOurBotProcess(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  if (n === process.pid) return false;
  if (!pidAlive(n)) return false;
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      const output = execSync(`tasklist /FI "PID eq ${n}" /FO CSV /NH`, { encoding: 'utf8' });
      return /node\.exe/i.test(output);
    } catch (_) {
      return true;
    }
  }
  try {
    const cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').replace(/\0/g, ' ');
    if (/npm\s+(install|ci|update|audit)/i.test(cmd)) return false;
    if (/\b(node|npm|npx)\b/i.test(cmd)) return true;
    return false;
  } catch (_) {
    return true;
  }
}

function acquireInstanceLock(retriesLeft = 3) {
  ensureDataDir();
  try {
    lockFileHandle = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(lockFileHandle, `${process.pid}\n${Date.now()}\n`);
    logger.logInfo(`[LOCK] Instância única adquirida (PID: ${process.pid})`);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      let existingPid = 0;
      try {
        const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
        existingPid = parseInt(String(raw).split(/\r?\n/)[0], 10) || 0;
      } catch (readErr) {
        logger.logAviso(`[LOCK] Lock ilegivel (${readErr.message}) — removendo`);
        try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* */ }
        return acquireInstanceLock(retriesLeft);
      }

      if (existingPid && isOurBotProcess(existingPid)) {
        if (retriesLeft > 0) {
          logger.logAviso(
            `[LOCK] PID ${existingPid} ainda vivo — aguardando 1s (tentativas restantes: ${retriesLeft})`
          );
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
          } catch (_) {
            const end = Date.now() + 1000;
            while (Date.now() < end) { /* fallback */ }
          }
          return acquireInstanceLock(retriesLeft - 1);
        }
        logger.logAviso(`[LOCK] Instancia viva (PID ${existingPid}) — este processo sai (exit 0).`);
        return false;
      }

      logger.logAviso(
        `[LOCK] Lock orfao/reuso Docker (PID lock=${existingPid || '?'}) — removendo e seguindo`
      );
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch (unlinkErr) {
        logger.logErro(`[LOCK] Falha ao remover lock: ${unlinkErr.message}`);
        return false;
      }
      return acquireInstanceLock(retriesLeft);
    }
    logger.logErro(`[LOCK] Erro ao adquirir lock: ${e.message}`);
    return false;
  }
}

function releaseInstanceLock() {
  if (lockFileHandle !== null) {
    try {
      fs.closeSync(lockFileHandle);
      if (fs.existsSync(LOCK_FILE)) {
        fs.unlinkSync(LOCK_FILE);
      }
      logger.logInfo('[LOCK] Lock de instância liberado');
    } catch (e) {
      logger.logErro('[LOCK] Erro ao liberar lock:', e.message);
    }
    lockFileHandle = null;
  } else if (fs.existsSync(LOCK_FILE)) {
    // sem handle (crash parcial): tenta limpar se for nosso pid
    try {
      const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      const pid = parseInt(String(raw).split(/\r?\n/)[0], 10) || 0;
      if (!pid || pid === process.pid || !isOurBotProcess(pid)) {
        fs.unlinkSync(LOCK_FILE);
      }
    } catch (_) { /* */ }
  }
}

// Adquire lock ao iniciar (Docker-safe). Exit 0 = egg nao entra em crash-loop / host offline.
if (!acquireInstanceLock()) {
  logger.logAviso('LOCK', 'Outra instancia viva. Encerrando este processo (host continua).');
  process.exit(0);
}

// Libera lock ao encerrar (SIGINT/SIGTERM ficam só no index.js — shutdown único)
process.on('exit', () => {
  releaseInstanceLock();
});

// ========== CONFIGURAÇÃO DO CANAL OBRIGATÓRIO ==========
let REQUIRED_CHANNEL = process.env.TELEGRAM_CHANNEL_ID || null;
const CHANNEL_LINK = process.env.TELEGRAM_CHANNEL_LINK || null;
let CHANNEL_VALID = false;
const CHANNEL_RESOLVED_FLAG = path.join(__dirname, 'data/.channel_resolved');

// ========== CARREGAR IMAGEM DO MENU ==========
const ASSETS_PATH = path.join(__dirname, 'assets');
const MENU_IMAGE_PATH = path.join(ASSETS_PATH, 'menu.jpg');

let menuImageBuffer = null;
try {
  if (fs.existsSync(MENU_IMAGE_PATH)) {
    menuImageBuffer = fs.readFileSync(MENU_IMAGE_PATH);
    logger.logInfo('Imagem do menu carregada.');
  } else {
    logger.logAviso('Imagem do menu nao encontrada em assets/menu.jpg');
  }
} catch (e) {
  logger.logErro('MENU_IMAGE', e.message);
}

// ========== IMPORTAÇÃO ROBUSTA DO TELEGRAM BOT ==========
let TelegramBot;
try {
  const mod = require('node-telegram-bot-api');
  TelegramBot = (mod && mod.default && typeof mod.default === 'function') ? mod.default : mod;
} catch (e) {
  logger.logException('TG_LOAD', e);
  process.exit(1);
}
if (typeof TelegramBot !== 'function') {
  logger.logErro('TG_LOAD', `TelegramBot nao e um construtor. Tipo: ${typeof TelegramBot}`);
  process.exit(1);
}

// ========== IMPORTAÇÕES DOS MÓDULOS ==========
const { isAdmin, getUserMetadata, ensureUserDir } = require('./utils/userManager');
const { isBanned, banUser, unbanUser, listBanned, clearBanned } = require('./utils/banManager');
const { initDatabase, addClient, getClient, updateClientPrefix, setClientVip, setClientOwner, logCommandUsage, getUsageStats } = require('./utils/database');
const {
  getAllSessions, getUserSessions, registerSession, deleteSession,
  canAccessSession, updateSessionStatus, getSession, canCreateSession,
  loadRegistry, saveRegistry
} = require('./utils/sessionRegistry');
const { comandoConsulta, menuConsultas, CATEGORIES, executarConsulta, formatarResultado, getMenuConsultasTelegram, getMenuCategoriaTelegram, logConsulta, isTelegramGroupChat, isPiiConsultaTipo } = require('./commands/consultas');
const { webSearch, deepSearch, analyze, analyzeSpecific, generateReport, getState, clearState, checkOllama } = require('./services/webIntelligenceService');
const {
  playMedia,
  playVideoMedia,
  downloadTiktok,
  downloadInstagram,
  downloadFacebook,
  downloadSpotify,
  downloadMediafire,
  downloadTwitter,
  downloadKwai,
  downloadThreads,
  downloadCapcut,
  downloadSoundcloud,
  downloadPinterest,
  searchYoutube
} = require('./services/downloadService');
const { createTelegramStatus } = require('./utils/statusProgress');
const { formatReportBlock, formatStatusBlock, labelValue, toMono } = require('./utils/typography');
const { stripEmojis, sanitizeTelegramButtons, sanitizeReplyMarkup, safeTelegramButtonText } = require('./utils/noEmoji');
const { getSessionButtonMode, toggleSessionButtonMode, setSessionButtonMode, syncButtonsMode, areButtonsOn, toggleButtonsSynced } = require('./utils/sessionRegistry');
const { getConfig: getDivConfig, updateConfig: updateDivConfig, getGruposParaDivulgar, setModoGrupos, limparGrupos, adicionarGrupo, removerGrupo, saveTextoMediaBuffer, formatStatusSummary, formatSlotsSummary, setActiveSlot, getActiveSlot, isTrackReady, modoKey, SLOT_IDS, updateSlotPatch } = require('./utils/divulgacao');
const divulgacaoTelegramUi = require('./utils/divulgacaoTelegramUi');
const { getCommand } = require('./commands');
const {
  tgMainButtons,
  tgMoreButtons,
  tgCategoryKeyboard,
  tgCategoryText,
  findItem,
  TG_NATIVE_CMDS,
  resolveMenuViewerRole,
  getCategory
} = require('./utils/menuCatalog');
const { withConcurrency, debounce, throttle, withTimeout, withRetry, withPerformanceTracking } = require('./utils/performanceOptimizer');

// Gerenciadores de configuração
const {
  getConfig, updateConfig,
  getOwners, addOwner, removeOwner, listOwnersForDisplay, formatOwnersCaption,
  getVips, addVip, removeVip,
  formatOwnerLabel,
  getBlacklist, addBlacklist, removeBlacklist,
  getPrefix, setPrefix, formatPrefixStatus, getAcceptedPrefixes, applyLivePrefix, cmdExample
} = require('./utils/configManager');

// ===== IMPORTAÇÃO ROBUSTA DO CONNECT =====
let connect;
let sessionEvents = null;
try {
  const connModule = require('./connection');
  sessionEvents = connModule.sessionEvents || null;
  if (typeof connModule.connect === 'function') {
    connect = connModule.connect;
  } else if (typeof connModule === 'function') {
    connect = connModule;
  } else {
    const keys = Object.keys(connModule);
    for (const key of keys) {
      if (typeof connModule[key] === 'function') {
        connect = connModule[key];
        break;
      }
    }
    if (!connect) {
      logger.logErro('CONNECT_LOAD', 'Nenhuma funcao connect encontrada em connection.js');
      process.exit(1);
    }
  }
} catch (e) {
  logger.logException('CONNECT_LOAD', e);
  process.exit(1);
}
if (typeof connect !== 'function') {
  logger.logErro('CONNECT_LOAD', `connect nao e uma funcao. Tipo: ${typeof connect}`);
  process.exit(1);
}

// ===== IMPORTAÇÃO DOS HANDLERS =====
let setupHandlers, setupEventListeners;
try {
  const msgHandler = require('./handlers/messageHandler');
  setupHandlers = msgHandler.setupHandlers || msgHandler;
} catch (e) {
  logger.logException('MSG_HANDLER_LOAD', e);
  setupHandlers = () => {};
}
try {
  const evHandler = require('./handlers/eventHandler');
  setupEventListeners = evHandler.setupEventListeners || evHandler;
} catch (e) {
  logger.logException('EVENT_HANDLER_LOAD', e);
  setupEventListeners = () => {};
}
if (typeof setupHandlers !== 'function') setupHandlers = () => {};
if (typeof setupEventListeners !== 'function') setupEventListeners = () => {};

const QRCode = require('qrcode');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) {
  logger.logErro('TG_TOKEN', 'TELEGRAM_BOT_TOKEN nao definido no .env');
  process.exit(1);
}

// ========== CRIAÇÃO DO BOT TELEGRAM ==========
const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: false,
  request: { timeout: 8000 }
});
try {
  require('./utils/tgSendPatch').patchTelegramBot(bot);
} catch (e) {
  logger.logAviso(`[TG] tgSendPatch: ${e.message}`);
}

function tgShim(chatId, userId) {
  return createTelegramBaileysShim(bot, chatId, userId);
}

const { enforceSearchQuery } = require('./utils/searchQueryLimit');

async function tgTakeSearch(chatId, raw, emptyUso) {
  const q = String(raw || '').trim();
  if (!q) {
    if (emptyUso) await bot.sendMessage(chatId, emptyUso);
    return null;
  }
  try {
    return enforceSearchQuery(q);
  } catch (e) {
    await bot.sendMessage(chatId, e.message);
    return null;
  }
}

// Cache ID/username do proprio bot (anti-loop TG + mencao)
let cachedTgBotUsername = '';
(async () => {
  try {
    const { setCachedTgBotId } = require('./utils/selfMessageGuard');
    const me = await bot.getMe();
    if (me?.id) setCachedTgBotId(me.id);
    if (me?.username) {
      cachedTgBotUsername = String(me.username).replace(/^@/, '');
      process.env.TELEGRAM_BOT_USERNAME = cachedTgBotUsername;
    }
  } catch (e) {
    logger.logAviso(`[TG] getMe: ${e.message || e}`);
  }
})();

function ignoreIfTelegramSelf(msg) {
  try {
    const { shouldIgnoreTelegramMessage, getCachedTgBotId } = require('./utils/selfMessageGuard');
    const check = shouldIgnoreTelegramMessage(msg, getCachedTgBotId());
    if (check.ignore) {
      if (process.env.DEBUG_SELF_MSG === '1') {
        console.log(`[AUTH_SILENT] TG_SELF reason=${check.reason}`);
      }
      return true;
    }
  } catch (_) {}
  return false;
}
logger.logInfo('Bot Telegram criado (polling sob demanda).');

// Sem emoji em saidas (regra ulfi) — intercepta envios comuns
(() => {
  const wrapTextMethod = (methodName) => {
    const original = bot[methodName].bind(bot);
    bot[methodName] = async function (chatId, text, options = {}) {
      const cleanText = stripEmojis(typeof text === 'string' ? text : text);
      const opts = options && typeof options === 'object' ? { ...options } : {};
      if (opts.reply_markup) opts.reply_markup = sanitizeReplyMarkup(opts.reply_markup);
      if (opts.caption) opts.caption = stripEmojis(opts.caption);
      return original(chatId, cleanText, opts);
    };
  };
  wrapTextMethod('sendMessage');

  const origEdit = bot.editMessageText.bind(bot);
  bot.editMessageText = async function (text, options = {}) {
    const cleanText = stripEmojis(typeof text === 'string' ? text : String(text ?? ''));
    const opts = options && typeof options === 'object' ? { ...options } : {};
    if (opts.reply_markup) opts.reply_markup = sanitizeReplyMarkup(opts.reply_markup);
    return origEdit(cleanText, opts);
  };

  const origPhoto = bot.sendPhoto.bind(bot);
  bot.sendPhoto = async function (chatId, photo, options = {}) {
    const opts = options && typeof options === 'object' ? { ...options } : {};
    if (opts.caption) opts.caption = stripEmojis(opts.caption);
    if (opts.reply_markup) opts.reply_markup = sanitizeReplyMarkup(opts.reply_markup);
    return origPhoto(chatId, photo, opts);
  };

  const origCaption = bot.editMessageCaption.bind(bot);
  bot.editMessageCaption = async function (caption, options = {}) {
    const clean = stripEmojis(caption);
    const opts = options && typeof options === 'object' ? { ...options } : {};
    if (opts.reply_markup) opts.reply_markup = sanitizeReplyMarkup(opts.reply_markup);
    return origCaption(clean, opts);
  };

  const origAnswer = bot.answerCallbackQuery.bind(bot);
  bot.answerCallbackQuery = async function (callbackQueryId, options = {}) {
    const opts = options && typeof options === 'object' ? { ...options } : {};
    if (opts.text) opts.text = stripEmojis(opts.text);
    return origAnswer(callbackQueryId, opts);
  };

  const wrapMedia = (methodName) => {
    if (typeof bot[methodName] !== 'function') return;
    const original = bot[methodName].bind(bot);
    bot[methodName] = async function (chatId, media, options = {}) {
      const opts = options && typeof options === 'object' ? { ...options } : {};
      if (opts.caption) opts.caption = stripEmojis(opts.caption);
      if (opts.reply_markup) opts.reply_markup = sanitizeReplyMarkup(opts.reply_markup);
      return original(chatId, media, opts);
    };
  };
  wrapMedia('sendAudio');
  wrapMedia('sendVideo');
  wrapMedia('sendDocument');
})();

// ========== TRATAMENTO DE ERROS DE POLLING COM RETRY E BACKOFF (P9) ==========
let pollingRetryCount = 0;
let pollingStarted = false;
const MAX_POLLING_RETRIES = 5;
const POLLING_RETRY_DELAY = 5000; // 5 segundos inicial

async function startPollingWithRetry() {
  let retryDelay = POLLING_RETRY_DELAY;
  
  while (pollingRetryCount < MAX_POLLING_RETRIES) {
    try {
      logger.logInfo(`[TELEGRAM] Iniciando polling (tentativa ${pollingRetryCount + 1}/${MAX_POLLING_RETRIES})`);
      await bot.startPolling({
        restart: true,
        interval: 300,
        params: { timeout: 10 }
      });
      logger.logSucesso('[TELEGRAM] Polling iniciado com sucesso');
      pollingRetryCount = 0; // Reset contador em caso de sucesso
      return;
    } catch (e) {
      pollingRetryCount++;
      logger.logErro(`[TELEGRAM] Erro ao iniciar polling (tentativa ${pollingRetryCount}): ${e.message}`);
      
      if (pollingRetryCount >= MAX_POLLING_RETRIES) {
        logger.logErro('[TELEGRAM] Máximo de tentativas de polling atingido. Aguardando intervenção manual.');
        // Não encerra o processo, apenas para de tentar polling
        return;
      }
      
      logger.logInfo(`[TELEGRAM] Aguardando ${retryDelay}ms antes de nova tentativa...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 60000); // Backoff exponencial até 60s
    }
  }
}

/** Inicia polling uma vez (index.js / entrypoint). Require do módulo não dispara mais. */
async function startTelegramPolling() {
  if (pollingStarted) {
    logger.logInfo('[TELEGRAM] Polling já iniciado — ignorando chamada duplicada.');
    return;
  }
  pollingStarted = true;
  try {
    // Menu de comandos do BotFather (slash)
    try {
      const cmds = [
        { command: 'start', description: 'Menu principal' },
        { command: 'menu', description: 'Menu completo' },
        { command: 'help', description: 'Ajuda' },
        { command: 'connect', description: 'Conectar WhatsApp' },
        { command: 'novidades', description: 'O que mudou (publico)' },
        { command: 'status', description: 'O que mudou (publico)' },
        { command: 'afiliado', description: 'Seu link de indica' },
        { command: 'minhaconta', description: 'Sua conta / plano' },
        { command: 'caixa', description: 'Painel admin: sessoes, VIP, vendas' },
        { command: 'painel', description: 'Painel admin (sessoes/VIP/compras)' },
        { command: 'mysessions', description: 'Suas sessoes' },
        { command: 'download', description: 'Menu downloads' },
        { command: 'play', description: 'Audio YouTube' },
        { command: 'tiktok', description: 'Baixar TikTok' },
        { command: 'instagram', description: 'Baixar Instagram' },
        { command: 'ytsearch', description: 'Buscar YouTube' },
        { command: 'menu_consultas', description: 'Menu consultas' },
        { command: 'consulta', description: 'Consulta API' }
      ];
      await bot.setMyCommands(cmds);
    } catch (e) {
      logger.logAviso(`[TELEGRAM] setMyCommands: ${e.message}`);
    }
    await startPollingWithRetry();
  } catch (e) {
    pollingStarted = false;
    logger.logErro(`[TELEGRAM] Falha crítica ao iniciar polling: ${e.message}`);
    throw e;
  }
}

// Intercepta erros de polling
bot.on('polling_error', async (error) => {
  logger.logErro(`[TELEGRAM] Erro de polling: ${error.message || error.code || 'desconhecido'} | ${error.response?.body || 'no response body'} | ${error.response?.statusCode || 'no status code'}`);
  
  // Erro 409 (conflito) - outra instância rodando — para TG e encerra WA limpo
  // (antes: so stopPolling → sockets WA orfaos sem painel)
  if (error.code === 409 || (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict'))) {
    logger.logErro('[TELEGRAM] Conflito de polling (409) - outra instância do bot está rodando');
    logger.logErro('[TELEGRAM] Pare todas as instâncias do bot e mantenha apenas uma rodando');
    logger.logAviso('Conflito de polling (409). Outra instancia do bot esta rodando?');
    try {
      await bot.stopPolling();
      logger.logInfo('[TELEGRAM] Polling parado devido a conflito 409');
    } catch (e) {
      logger.logErro('[TELEGRAM] Erro ao parar polling:', e.message);
    }
    try {
      const { setProcessShuttingDown, endAllLiveSockets } = require('./connection');
      setProcessShuttingDown(true);
      endAllLiveSockets();
    } catch (e) {
      logger.logAviso(`[TELEGRAM] 409 cleanup WA: ${e.message || e}`);
    }
    // Egg/Pterodactyl sobe de novo; evita processo zumbi com WA sem TG
    setTimeout(() => {
      try { process.exit(1); } catch (_) { /* ignore */ }
    }, 1500).unref?.();
    return;
  }
  
  // Erros recuperáveis com retry automático (excluindo ETELEGRAM que pode ser 409)
  if (error.code === 'EFATAL' || error.message?.includes('fetch failed')) {
    logger.logAviso('[TELEGRAM] Erro recuperável detectado, tentando reconectar...');
    pollingRetryCount = 0;
    await startPollingWithRetry();
  }
  
  // ETELEGRAM sem 409 pode ser recuperável
  if (error.code === 'ETELEGRAM' && !error.message.includes('409 Conflict')) {
    logger.logAviso('[TELEGRAM] Erro ETELEGRAM recuperável detectado, tentando reconectar...');
    pollingRetryCount = 0;
    await startPollingWithRetry();
  }
});

// Polling NÃO inicia no require — index.js chama startTelegramPolling() após restore.
if (require.main === module) {
  startTelegramPolling().catch((e) => {
    logger.logErro(`[TELEGRAM] Falha crítica ao iniciar polling: ${e.message}`);
  });
}

// ========== NOTIFICACAO DE SESSAO CAIDA ==========
const SESSION_FAILURE_MESSAGES = {
  auth_401: 'Sua sessao do WhatsApp caiu (falha de autenticacao). Reconecte gerando um novo QR/codigo.',
  logged_out: 'Sua sessao do WhatsApp foi desconectada (logged out) pelo proprio WhatsApp. Reconecte novamente.',
  max_reconnect_attempts: 'Nao foi possivel restabelecer sua sessao do WhatsApp apos varias tentativas. Reconecte manualmente.'
};

const errorNotificationCache = new Map();
const ERROR_NOTIFY_COOLDOWN = 5 * 60 * 1000; // 5 minutos

// Cache para notificações de conexão (evita flooding)
const connectionNotificationCache = new Map();
const CONNECTION_NOTIFY_COOLDOWN = 60 * 1000; // 1 minuto para notificações de conexão (aumentado de 30s)

// Cache para rastrear estado anterior de conexão por sessão
const connectionStateCache = new Map();

function shouldNotifyError(telegramUserId, reason) {
  const key = `${telegramUserId}_${reason}`;
  const lastNotify = errorNotificationCache.get(key);
  const now = Date.now();
  if (lastNotify && (now - lastNotify) < ERROR_NOTIFY_COOLDOWN) {
    logger.logInfo(`[TELEGRAM] Notificação de erro ignorada (cooldown) - ${key}`);
    return false;
  }
  errorNotificationCache.set(key, now);
  return true;
}

async function notifyWhatsAppDown(telegramUserId, { kind, reason, sessionId, retry } = {}) {
  const uid = String(telegramUserId || '').trim();
  if (!uid || !bot) return;
  const down = require('./utils/sessionDownNotify');
  const k = down.kindFromReason(kind || reason);
  if (!down.allowNotice(uid, k)) return;
  const extraRows = [];
  try {
    if (isAdmin(uid)) extraRows.push([{ text: 'Health ops', callback_data: 'admin_health' }]);
    else extraRows.push([{ text: 'Suporte', callback_data: 'bill_suporte' }]);
  } catch (_) { /* ignore */ }
  const notice = down.buildNotice({ kind: k, sessionId, extraRows });
  try {
    const { upsertStickyText } = require('./utils/tgStickyNotice');
    const res = await upsertStickyText({
      chatId: uid,
      kvKey: `wa_down_${uid}`,
      text: notice.text,
      keyboard: notice.keyboard
    });
    if (!res) throw new Error('sticky vazio');
    logger.logInfo(`[TELEGRAM] aviso queda kind=${k}`);
  } catch (e) {
    down.clearNoticeCooldown(uid, k);
    logger.logAviso(`[TELEGRAM] aviso queda: ${e.message}`);
    if (!retry) {
      setTimeout(() => {
        notifyWhatsAppDown(uid, { kind: k, sessionId, retry: true }).catch(() => {});
      }, 12000);
    }
  }
}

function shouldNotifyConnection(telegramUserId, status, sessionId = null) {
  const key = `${telegramUserId}_${status}`;
  const lastNotify = connectionNotificationCache.get(key);
  const now = Date.now();
  
  // Verificar cooldown
  if (lastNotify && (now - lastNotify) < CONNECTION_NOTIFY_COOLDOWN) {
    logger.logInfo(`[TELEGRAM] Notificação de conexão ignorada (cooldown) - ${key}`);
    return false;
  }
  
  // Verificar se o estado realmente mudou (para evitar notificações duplicadas do mesmo estado)
  if (sessionId) {
    const stateKey = `${telegramUserId}_${sessionId}`;
    const previousState = connectionStateCache.get(stateKey);
    if (previousState === status) {
      logger.logInfo(`[TELEGRAM] Notificação de conexão ignorada (estado não mudou) - ${stateKey}: ${status}`);
      return false;
    }
    connectionStateCache.set(stateKey, status);
  }
  
  connectionNotificationCache.set(key, now);
  return true;
}

async function resolveJidOrLid(input, conn = null) {
  if (!input) return null;
  const raw = Array.isArray(input) ? input.join(' ') : String(input);
  let cleaned = raw.trim();
  if (!cleaned) return null;
  if (/@lid\b/i.test(cleaned)) {
    const first = cleaned.split(/\s+/)[0];
    const jid = resolveLid(first);
    return jid || first;
  }
  try {
    const { parseOwnerPhone, resolveWhatsAppJid } = require('./utils/phoneTarget');
    const parsed = parseOwnerPhone(cleaned);
    if (parsed?.jid) {
      const jid = await resolveWhatsAppJid(conn, parsed);
      return jid || parsed.jid;
    }
  } catch (e) {
    logger.logErro('RESOLVE_JID', e.message);
  }
  return null;
}

// ========== INICIALIZAÇÃO DO CANAL ==========
async function initChannel() {
  if (!REQUIRED_CHANNEL) {
    logger.logAviso('Verificacao de canal desabilitada. Configure TELEGRAM_CHANNEL_ID.');
    return;
  }

  const lookup = parseTgChannelRef(REQUIRED_CHANNEL) || REQUIRED_CHANNEL;
  const alreadyNumeric = /^-100\d+$/.test(String(REQUIRED_CHANNEL));
  if (alreadyNumeric) {
    CHANNEL_VALID = true;
    if (REQUIRED_CHANNELS[0]) REQUIRED_CHANNELS[0].username = String(REQUIRED_CHANNEL);
    logger.logInfo(`Canal obrigatorio: ${CHANNEL_LINK || REQUIRED_CHANNEL} (ID: ${REQUIRED_CHANNEL})`);
    return;
  }

  try {
    const chat = await bot.getChat(lookup);
    const resolvedId = chat.id;
    logger.logInfo(`Resolvido ID do canal ${lookup} -> ${resolvedId}`);
    REQUIRED_CHANNEL = resolvedId;
    CHANNEL_VALID = true;
    if (REQUIRED_CHANNELS[0] && resolvedId) {
      REQUIRED_CHANNELS[0].username = String(resolvedId);
    }
    logger.logInfo(`Canal obrigatorio: ${CHANNEL_LINK || REQUIRED_CHANNEL} (ID: ${REQUIRED_CHANNEL})`);

    const alreadyNotified = fs.existsSync(CHANNEL_RESOLVED_FLAG);
    if (!alreadyNotified && CHANNEL_LINK) {
      await notifyAdminsAboutChannel(resolvedId);
      fs.writeFileSync(CHANNEL_RESOLVED_FLAG, Date.now().toString());
      logger.logInfo('Notificacao do canal enviada aos admins (apenas uma vez).');
    }
  } catch (e) {
    // Ignora erros de rede/fetch - assume canal configurado manualmente
    if (e.message && (e.message.includes('fetch failed') || e.message.includes('EFATAL') || e.code === 'EFATAL')) {
      logger.logAviso(`CHECK_CHANNEL: Erro de rede ao verificar canal ${REQUIRED_CHANNEL}: ${e.message}`);
      logger.logInfo(`Canal obrigatorio: ${CHANNEL_LINK || REQUIRED_CHANNEL} (ID: ${REQUIRED_CHANNEL}) - usando configuração existente`);
      CHANNEL_VALID = true;
      return;
    }
    logger.logErro('CHANNEL_RESOLVE', `Nao foi possivel resolver o canal ${REQUIRED_CHANNEL}: ${e.message}`);
    REQUIRED_CHANNEL = null;
    CHANNEL_VALID = false;
  }
}

const activeConnections = new Map();
const statusMessages = {};
const chipOnlineHelloAt = new Map();
const menuMessages = {};
const statusChains = new Map();
const TG_STATUS_FILE = path.join(__dirname, 'data/tg_conn_status.json');
let restoreQuietUntil = 0;
const restoreSummaryTimers = new Map();

function persistStatusSlot(chatId) {
  try {
    ensureDataDir();
    let all = {};
    try { all = JSON.parse(fs.readFileSync(TG_STATUS_FILE, 'utf8')) || {}; } catch (_) {}
    const key = String(chatId);
    const rec = statusMessages[key];
    if (rec?.messageId) {
      all[key] = { messageId: rec.messageId, isPhoto: !!rec.isPhoto, at: Date.now() };
    } else {
      delete all[key];
    }
    fs.writeFileSync(TG_STATUS_FILE, JSON.stringify(all));
  } catch (_) { /* ignore */ }
}

function hydrateStatusSlots() {
  try {
    const all = JSON.parse(fs.readFileSync(TG_STATUS_FILE, 'utf8')) || {};
    const maxAge = 47 * 3600 * 1000;
    for (const [id, v] of Object.entries(all)) {
      if (v && v.messageId && (!v.at || Date.now() - v.at < maxAge)) {
        statusMessages[String(id)] = { messageId: v.messageId, isPhoto: !!v.isPhoto, lastEditAt: 0 };
      }
    }
  } catch (_) { /* ignore */ }
}

function bumpRestoreQuiet(ms = 90000) {
  restoreQuietUntil = Math.max(restoreQuietUntil, Date.now() + ms);
}

function inRestoreQuiet() {
  return Date.now() < restoreQuietUntil;
}

function scheduleConnSummary(telegramUserId) {
  const uid = String(telegramUserId || '').trim();
  if (!uid) return;
  const prev = restoreSummaryTimers.get(uid);
  if (prev) clearTimeout(prev);
  restoreSummaryTimers.set(uid, setTimeout(() => {
    restoreSummaryTimers.delete(uid);
    try {
      const sessions = getUserSessions(uid) || [];
      const up = sessions.filter((s) => s.status === 'connected').length;
      const err = sessions.filter((s) => s.status === 'error').length;
      const connecting = sessions.filter((s) => s.status === 'connecting').length;
      let text = 'WhatsApp: nenhuma sessao.';
      if (sessions.length) {
        text = `WhatsApp: ${up} no ar.`;
        if (connecting) text += ` ${connecting} conectando.`;
        if (err) text += ` ${err} precisa(m) parear de novo (nao conta como capacidade).`;
      }
      const hasSlot = !!statusMessages[uid]?.messageId;
      updateStatus(uid, text, {}, { allowCreate: !hasSlot }).catch(() => {});
    } catch (_) { /* ignore */ }
  }, 8000));
}

hydrateStatusSlots();
/** pendingArgs: userId -> { cmd, chatId, expires } */
const pendingTgCmds = new Map();
/** Aguardando numero pra pairing/QR — bloqueia Intent/consulta */
const pendingPairPhone = new Map(); // userId -> { method, chatId, expires }
/** Aguardando numero pra addowner/addvip/etc apos clique no menu */
const pendingConfigAction = new Map(); // userId -> { cmd, chatId, expires }
function pruneExpiredPairPending() {
  const now = Date.now();
  for (const [k, v] of pendingPairPhone.entries()) {
    if (!v || now > Number(v.expires || 0)) pendingPairPhone.delete(k);
  }
}
/** Cache curto: userId -> [{id, subject}] para picks de grupo no TG */
const tgGroupPickCache = new Map();

async function fetchUserWaGroups(userId) {
  const live = resolveLiveSession(userId);
  if (!live.conn) return { error: liveSessionErrorMessage(live.reason), groups: [] };
  try {
    const all = await live.conn.groupFetchAllParticipating();
    try { require('./utils/groupMetaCache').seedFromParticipating(all); } catch (_) { /* ignore */ }
    const groups = Object.values(all || {})
      .map((g, i) => {
        const id = String(g.id || '');
        const rawSubj = Buffer.isBuffer(g.subject)
          ? g.subject.toString('utf8')
          : (g.subject == null ? '' : String(g.subject));
        const subject = safeTelegramButtonText(
          rawSubj,
          40,
          `Grupo ${i + 1}`,
          { asciiOnly: true }
        );
        return { id, subject: `${i + 1}. ${subject}`.slice(0, 48) };
      })
      .slice(0, 30);
    tgGroupPickCache.set(String(userId), { groups, expires: Date.now() + 5 * 60 * 1000 });
    return { groups, conn: live.conn, sessionId: live.sessionId };
  } catch (e) {
    return { error: `Falha ao listar grupos: ${e.message}`, groups: [] };
  }
}

function groupPickKeyboard(userId, actionPrefix) {
  const cached = tgGroupPickCache.get(String(userId));
  if (!cached || Date.now() > cached.expires || !cached.groups.length) {
    return sanitizeTelegramButtons([[{ text: 'Voltar', callback_data: 'menu_main' }]]);
  }
  const btns = cached.groups.map((g, i) => [
    {
      text: safeTelegramButtonText(g.subject, 48, `Grupo ${i + 1}`, { asciiOnly: true }),
      callback_data: `${actionPrefix}${i}`
    }
  ]);
  btns.push([{ text: 'Voltar', callback_data: 'menu_main' }]);
  return sanitizeTelegramButtons(btns);
}

async function startNukeGroupPick(userId, chatId) {
  const res = await fetchUserWaGroups(userId);
  if (res.error) {
    await bot.sendMessage(chatId, res.error);
    return;
  }
  if (!res.groups.length) {
    await bot.sendMessage(chatId, 'Nenhum grupo encontrado na sessao WhatsApp.');
    return;
  }
  try {
    await bot.sendMessage(
      chatId,
      'ATENCAO: nuke remove participantes do grupo.\nEscolha o grupo:',
      { reply_markup: sanitizeReplyMarkup({ inline_keyboard: groupPickKeyboard(userId, 'nuke_run_') }) }
    );
  } catch (e) {
    const cached = tgGroupPickCache.get(String(userId));
    if (cached?.groups?.length) {
      cached.groups = cached.groups.map((g, i) => ({ ...g, subject: `Grupo ${i + 1}` }));
    }
    await bot.sendMessage(
      chatId,
      'ATENCAO: nuke remove participantes do grupo.\nEscolha o grupo (nomes simplificados):',
      { reply_markup: sanitizeReplyMarkup({ inline_keyboard: groupPickKeyboard(userId, 'nuke_run_') }) }
    );
  }
}

/** Baixa midia do Telegram para Buffer (API correta: fileId + dir ou getFileLink) */
async function downloadTelegramFileBuffer(fileId) {
  const tmpDir = path.join(__dirname, 'data', 'cache', 'tg_dl');
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const savedPath = await bot.downloadFile(fileId, tmpDir);
    const buf = await fs.promises.readFile(savedPath);
    try { fs.unlinkSync(savedPath); } catch (_) {}
    return buf;
  } catch (e) {
    const link = await bot.getFileLink(fileId);
    const res = await fetch(link);
    if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar midia TG`);
    return Buffer.from(await res.arrayBuffer());
  }
}

async function runWaCmdInGroup(userId, chatId, cmdName, groupJid, argsText = '') {
  const live = resolveLiveSession(userId);
  if (!live.conn) {
    await bot.sendMessage(chatId, liveSessionErrorMessage(live.reason));
    return;
  }
  const cmd = getCommand(cmdName);
  if (!cmd) {
    await bot.sendMessage(chatId, `Comando ${cmdName} nao encontrado.`);
    return;
  }
  if (tgDenyUnlessOwner(userId, `wa_run_${cmdName}`)) return;
  const selfJid = selfJidFromConn(live.conn);
  const groupId = typeof groupJid === 'string' ? groupJid : String(groupJid && (groupJid.id || groupJid.jid) || '');
  const ctx = {
    from: groupId,
    info: { key: { fromMe: true, remoteJid: groupId, participant: selfJid || undefined } },
    command: cmdName,
    text: String(argsText || '').trim(),
    args: String(argsText || '').trim().split(/\s+/).filter(Boolean),
    q: String(argsText || '').trim(),
    prefix: '/',
    platform: 'telegram',
    isTelegram: true,
    telegramUserId: userId,
    sessionId: live.sessionId,
    isGroup: String(groupId).endsWith('@g.us'),
    telegramChatId: chatId,
    sender: selfJid,
    botJid: selfJid,
    telegramNotify: async (text) => {
      try { await bot.sendMessage(chatId, String(text || '').slice(0, 3500)); } catch (_) {}
    },
    conn: live.conn
  };
  try {
    const { assertCommand } = require('./utils/commandGate');
    const gated = assertCommand(ctx, cmdName);
    if (!gated.ok) {
      await bot.sendMessage(chatId, 'Sem permissao para este comando.');
      return;
    }
  } catch (_) {
    await bot.sendMessage(chatId, 'Sem permissao para este comando.');
    return;
  }
  await bot.sendMessage(chatId, `Executando /${cmdName} em ${groupId}...`);
  try {
    if (cmd.useCtx) await cmd.execute(live.conn, ctx);
    else await cmd.execute(live.conn, groupId, ctx.info, ctx.args, ctx.text, true, true);
    await bot.sendMessage(chatId, `Comando ${cmdName} disparado. Veja no WhatsApp.`);
  } catch (e) {
    logger.logErro('TG_GROUP_CMD', e.message);
    await bot.sendMessage(chatId, `Erro: ${e.message}`);
  }
}

function selfJidFromConn(conn) {
  try {
    const { getUserJid } = require('./safeRelay');
    const j = getUserJid(conn);
    if (j && String(j).includes('@')) {
      return String(j).replace(/:\d+(?=@)/, '');
    }
  } catch (_) { /* ignore */ }
  const id = conn?.user?.id || conn?.user?.jid || conn?.authState?.creds?.me?.id || '';
  if (!id) return '';
  const s = String(id);
  if (s.includes('@lid') || s.includes('@s.whatsapp.net') || s.includes('@c.us')) {
    return s.replace(/:\d+(?=@)/, '');
  }
  const base = s.split(':')[0].split('@')[0];
  return base ? `${base}@s.whatsapp.net` : '';
}

/** Config nuke via Telegram (/nukename etc) — nao precisa sessao WA */
async function handleTgNukeConfig(userId, chatId, cmd, argsText = '') {
  const { getNukeConfig, setNukeConfig } = require('./utils/configManager');
  const text = String(argsText || '').trim();
  const cfg = getNukeConfig(userId) || {};

  if (cmd === 'nukeconfig') {
    await bot.sendMessage(
      chatId,
      `NUKE CONFIG\n\n` +
      `Nome: ${cfg.groupName || '(padrao)'}\n` +
      `Desc: ${cfg.groupDesc || '(padrao)'}\n` +
      `Msg: ${cfg.groupMessage || '(padrao)'}\n` +
      `Foto: ${cfg.groupImage ? 'definida' : 'nao'}\n\n` +
      `Telegram: /nukename /nukedesc /nukemsg /nukeimg /nukereset`
    );
    return true;
  }

  if (cmd === 'nukereset') {
    const { defaultNukeConfig } = require('./utils/configManager');
    setNukeConfig(userId, defaultNukeConfig());
    await bot.sendMessage(chatId, 'Nuke config resetada para o padrao.');
    return true;
  }

  if (cmd === 'nukename') {
    if (!text) {
      await bot.sendMessage(chatId, 'Uso: /nukename <nome>\nEx: /nukename by: hanork.');
      return true;
    }
    cfg.groupName = text;
    setNukeConfig(userId, cfg);
    await bot.sendMessage(chatId, `Nome do nuke definido: ${text}`);
    return true;
  }

  if (cmd === 'nukedesc') {
    if (!text) {
      await bot.sendMessage(chatId, 'Uso: /nukedesc <descricao>');
      return true;
    }
    cfg.groupDesc = text;
    setNukeConfig(userId, cfg);
    await bot.sendMessage(chatId, `Descricao do nuke definida: ${text}`);
    return true;
  }

  if (cmd === 'nukemsg') {
    if (!text) {
      await bot.sendMessage(chatId, 'Uso: /nukemsg <mensagem>');
      return true;
    }
    cfg.groupMessage = text;
    setNukeConfig(userId, cfg);
    await bot.sendMessage(chatId, `Mensagem do nuke definida: ${text}`);
    return true;
  }

  if (cmd === 'nukeimg') {
    pendingTgCmds.set(String(userId), {
      cmd: 'nukeimg',
      chatId,
      native: true,
      kind: 'nuke_photo',
      expires: Date.now() + 5 * 60 * 1000
    });
    await bot.sendMessage(chatId, 'Envie agora a foto (imagem) para o nuke.');
    return true;
  }

  return false;
}

async function executeWaCmdFromTelegram(userId, chatId, cmdName, argsText = '') {
  const item = findItem(cmdName);
  if (item?.platformAdminOnly && !isAdmin(userId)) {
    await bot.sendMessage(chatId, 'Comando restrito ao administrador da plataforma.');
    return;
  }

  // Nuke config: nativo no TG (nao precisa conn / nao PV) — antes do forceNative
  const nukeCfg = new Set(['nukename', 'nukedesc', 'nukemsg', 'nukeimg', 'nukeconfig', 'nukereset']);
  if (nukeCfg.has(cmdName)) {
    await handleTgNukeConfig(userId, chatId, cmdName, argsText);
    return;
  }
  // Nuke exec: seletor de grupo
  if (['nuke', 'nukeid', 'nukeas'].includes(cmdName)) {
    const gid = String(argsText || '').trim().split(/\s+/)[0] || '';
    if (gid.includes('@g.us')) {
      await runWaCmdInGroup(userId, chatId, 'nuke', gid, '');
      return;
    }
    await startNukeGroupPick(userId, chatId);
    return;
  }

  // Menus / utilitarios / Hanork API: NUNCA via sessao WA (evita crash JID/quoted)
  const forceNative = new Set([
    'menu', 'comandos', 'ping', 'stats', 'tutorial', 'novidades', 'changelog', 'oquemudou', 'status',
    'sobre', 'dono', 'comprar', 'planos', 'preco', 'ownerinfo', 'hanork', 'zt',
    'minhaconta', 'meuplano', 'baixarbot', 'meubot', 'vincular',
    'hanorkinfo', 'ztinfo'
  ]);
  if (
    forceNative.has(cmdName) ||
    String(cmdName).startsWith('menu_hanork') ||
    String(cmdName).startsWith('menu_zt') ||
    isHanorkApiCommand(cmdName, getCommand) ||
    (TG_NATIVE_CMDS.has(cmdName) && !nukeCfg.has(cmdName))
  ) {
    try {
      const fake = {
        message_id: Date.now(),
        chat: { id: chatId, type: 'private' },
        from: { id: userId },
        text: `/${cmdName}${argsText ? ` ${argsText}` : ''}`,
        date: Math.floor(Date.now() / 1000)
      };
      const { parsePrefixedCommand } = require('./utils/commandTextParse');
      fake._hanorkParsed = parsePrefixedCommand(fake.text, '/', { platform: 'telegram' });
      const routerResult = await processEvent(fake, 'telegram', tgShim(chatId, userId));
      if (routerResult?.error) {
        await bot.sendMessage(chatId, String(routerResult.error));
      }
      return;
    } catch (e) {
      logger.logErro('TG_FORCE_NATIVE', e.stack || e.message);
      await bot.sendMessage(chatId, `Erro: ${e.message}`);
      return;
    }
  }

  const live = resolveLiveSession(userId);
  if (!live.conn) {
    const usage = item?.usage || cmdName;
    await bot.sendMessage(
      chatId,
      `${liveSessionErrorMessage(live.reason)}\n\nEste comando roda no WhatsApp. Aqui no Telegram use /${String(usage).replace(/^[.\/!#•$*]+/, '')}`
    );
    return;
  }

  const cmd = getCommand(cmdName);
  if (!cmd) {
    await bot.sendMessage(chatId, `Comando ${cmdName} nao encontrado no registry.`);
    return;
  }

  const selfJid = selfJidFromConn(live.conn);
  if (!selfJid) {
    await bot.sendMessage(chatId, 'Sessao WA sem JID. Reconecte e tente de novo.');
    return;
  }

  const args = String(argsText || '').trim().split(/\s+/).filter(Boolean);
  const ctx = {
    from: selfJid,
    info: { key: { fromMe: true, remoteJid: selfJid, participant: selfJid || undefined } },
    command: cmdName,
    text: String(argsText || '').trim(),
    args,
    q: String(argsText || '').trim(),
    prefix: '/',
    platform: 'telegram',
    isTelegram: true,
    telegramUserId: userId,
    sessionId: live.sessionId,
    telegramChatId: chatId,
    sender: selfJid,
    botJid: selfJid,
    conn: live.conn
  };
  try {
    const { assertCommand } = require('./utils/commandGate');
    const gated = assertCommand(ctx, cmdName);
    if (!gated.ok) {
      await bot.sendMessage(chatId, 'Sem permissao para este comando.');
      return;
    }
  } catch (_) {
    await bot.sendMessage(chatId, 'Sem permissao para este comando.');
    return;
  }

  await bot.sendMessage(chatId, `Executando /${cmdName} na sessao WhatsApp...`);
  try {
    if (cmd.useCtx) {
      await cmd.execute(live.conn, ctx);
    } else {
      await cmd.execute(live.conn, selfJid, ctx.info, args, ctx.text, true, true);
    }
    await bot.sendMessage(chatId, `Comando ${cmdName} disparado. Veja o resultado no WhatsApp (PV do bot).`);
  } catch (e) {
    logger.logErro('TG_WA_CMD', e.stack || e.message);
    await bot.sendMessage(chatId, `Erro: ${e.message}`);
  }
}

async function handleTgCmdClick(userId, chatId, cmdName) {
  if (['comprar', 'planos', 'preco', 'minhaconta', 'meuplano', 'meupagamento', 'suporte', 'vincular', 'baixarbot', 'meubot'].includes(cmdName)) {
    const { handleTelegramBilling } = require('./commands/billing');
    const data = (cmdName === 'minhaconta' || cmdName === 'meuplano' || cmdName === 'meupagamento')
      ? 'bill_account'
      : cmdName === 'suporte' ? 'bill_suporte'
      : cmdName === 'vincular' ? 'bill_vincular'
      : (cmdName === 'baixarbot' || cmdName === 'meubot') ? 'bill_baixarbot'
      : 'bill_home';
    await handleTelegramBilling(bot, { chatId, userId, data });
    return;
  }
  const item = findItem(cmdName) || { name: cmdName, usage: cmdName, desc: cmdName, needsArgs: false };
  const isNative = TG_NATIVE_CMDS.has(cmdName) || isHanorkApiCommand(cmdName, getCommand);
  const nukeCfg = new Set(['nukename', 'nukedesc', 'nukemsg', 'nukeimg', 'nukeconfig', 'nukereset']);
  const nukeExec = new Set(['nuke', 'nukeid', 'nukeas']);

  // Shortcuts para menus TG ja existentes
  if (cmdName === 'download' || cmdName === 'downloads') {
    await bot.sendMessage(chatId, formatReportBlock('DOWNLOADS', [
      labelValue('/play', '<musica ou link YT>'),
      labelValue('/playvideo', '<nome ou link>'),
      labelValue('/tiktok', '<link>'),
      labelValue('/instagram', '<link>'),
      labelValue('/facebook', '<link>'),
      labelValue('/spotify', '<link ou nome>'),
      labelValue('/soundcloud', '<link ou nome>'),
      labelValue('/kwai', '<link>'),
      labelValue('/threads', '<link>'),
      labelValue('/capcut', '<link>'),
      labelValue('/pinterest', '<link>'),
      labelValue('/mediafire', '<link>'),
      labelValue('/twitter', '<link>'),
      labelValue('/ytsearch', '<termo>')
    ]), { reply_markup: { inline_keyboard: [[{ text: 'Voltar', callback_data: 'menu_main' }]] } });
    return;
  }
  if (cmdName === 'menu_consultas') {
    await showMenu(chatId, 'consultas', userId);
    return;
  }
  if (cmdName === 'divmenu') {
    await showMenu(chatId, 'divulgacao', userId);
    return;
  }
  if (['grupos', 'grupolista', 'grupoconfig', 'grupoentrar', 'gruposair', 'divgrupos'].includes(cmdName)) {
    if (tgDenyUnlessOwner(userId, `tg_cmd_${cmdName}`)) return;
    const tgGm = require('./utils/groupManager/telegramUi');
    if (cmdName === 'grupoentrar') {
      await tgGm.handleCallback(bot, { chatId, userId, data: 'gm_join_1' });
      return;
    }
    if (cmdName === 'gruposair') {
      await tgGm.handleCallback(bot, { chatId, userId, data: 'gm_leave_1' });
      return;
    }
    if (cmdName === 'grupolista') {
      await tgGm.handleCallback(bot, { chatId, userId, data: 'gm_active' });
      return;
    }
    if (cmdName === 'grupoconfig') {
      await tgGm.handleCallback(bot, { chatId, userId, data: 'gm_limits' });
      return;
    }
    await tgGm.sendPanel(bot, chatId, userId);
    return;
  }
  if (['google', 'pesquisar', 'deepsearch', 'analisar', 'relatorio', 'glista', 'gopen', 'gcopy', 'glimpar'].includes(cmdName)) {
    await showMenu(chatId, 'webintelligence', userId);
    return;
  }

  // Executar nuke: sempre via seletor de grupo (nunca PV)
  if (nukeExec.has(cmdName)) {
    await startNukeGroupPick(userId, chatId);
    return;
  }

  // Config nuke nativa: executa de verdade
  if (nukeCfg.has(cmdName)) {
    if (item.needsArgs) {
      pendingTgCmds.set(String(userId), {
        cmd: cmdName,
        chatId,
        native: true,
        kind: 'nuke_cfg',
        expires: Date.now() + 5 * 60 * 1000
      });
      await bot.sendMessage(
        chatId,
        `${item.name} — ${item.desc}\n\nDigite o texto agora (ou /${cmdName} <texto>):`
      );
      return;
    }
    await handleTgNukeConfig(userId, chatId, cmdName, '');
    return;
  }

  if (!isNative && !TG_PANEL_COMMANDS.has(cmdName)) {
    await bot.sendMessage(
      chatId,
      'Aqui no Telegram use /start ou /comprar (depois Conectar).'
    );
    return;
  }

  if (item.needsArgs) {
    const usageBare = String(item.usage || item.name || '').replace(/^[.\/!#•$*]+/, '');
    const hint = `Digite os argumentos (ou use /${usageBare}):`;
    pendingTgCmds.set(String(userId), { cmd: cmdName, chatId, native: isNative, expires: Date.now() + 5 * 60 * 1000 });
    await bot.sendMessage(chatId, `${item.name} — ${item.desc}\n\n${hint}`);
    return;
  }

  if (isNative) {
    // Nativos sem args: tentar slash-like via router fake text
    try {
      const fake = {
        message_id: Date.now(),
        chat: { id: chatId, type: 'private' },
        from: { id: userId },
        text: `/${cmdName}`,
        date: Math.floor(Date.now() / 1000)
      };
      const { parsePrefixedCommand } = require('./utils/commandTextParse');
      fake._hanorkParsed = parsePrefixedCommand(fake.text, '/', { platform: 'telegram' });
      const routerResult = await processEvent(fake, 'telegram', tgShim(chatId, userId));
      if (routerResult?.handled) {
        if (routerResult.error) {
          await bot.sendMessage(chatId, String(routerResult.error));
        }
        return;
      }
    } catch (e) {
      logger.logErro('TG_NATIVE_CLICK', e.message);
    }
    await bot.sendMessage(
      chatId,
      `${item.name} — ${item.desc}\n\nUse no Telegram: /${item.usage || item.name}`
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    'Aqui no Telegram use /start ou /comprar (depois Conectar).'
  );
}

// ========== WRAPPER SEGURO PARA answerCallbackQuery ==========
async function safeAnswerCallback(callbackQueryId, options = {}) {
  try {
    await Promise.race([
      bot.answerCallbackQuery(callbackQueryId, options),
      new Promise((resolve) => setTimeout(resolve, 800))
    ]);
  } catch (e) {
    // Ignora erros de callback expirado/inválido
    if (e.message && (e.message.includes('query is too old') || e.message.includes('query ID is invalid'))) {
      logger.logInfo(`[TELEGRAM] Callback expirado (${callbackQueryId}) - ignorado.`);
      return;
    }
    // Ignora erros de rede/fetch (EFATAL)
    if (e.message && (e.message.includes('fetch failed') || e.message.includes('EFATAL') || e.code === 'EFATAL')) {
      logger.logAviso(`[TELEGRAM] Erro de rede ao responder callback (${callbackQueryId}): ${e.message}`);
      return;
    }
    // Loga outros erros mas não relança para não interromper o bot
    logger.logErro('safeAnswerCallback', e.message);
  }
}

// ========== FUNÇÕES DE MENSAGEM COM IMAGEM ==========
// Sanitiza HTML para evitar erros de parse entities no Telegram
function sanitizeHtml(text) {
  if (!text || typeof text !== 'string') return text;
  
  // Remove tags HTML não suportadas pelo Telegram
  // Telegram suporta: <b>, <i>, <u>, <s>, <strike>, <code>, <pre>, <a>, <tg-spoiler>
  const allowedTags = ['b', 'i', 'u', 's', 'strike', 'code', 'pre', 'a', 'tg-spoiler'];
  
  // Remove tags não permitidas mantendo o conteúdo
  let sanitized = text.replace(/<(\w+)[^>]*>/gi, (match, tag) => {
    const lowerTag = tag.toLowerCase();
    if (allowedTags.includes(lowerTag)) {
      return match; // Mantém tag permitida
    }
    return ''; // Remove tag não permitida
  });
  
  // Fecha tags HTML que ficaram abertas após remoção
  // Remove tags de fechamento órfãs
  sanitized = sanitized.replace(/<\/(\w+)>/gi, (match, tag) => {
    const lowerTag = tag.toLowerCase();
    if (allowedTags.includes(lowerTag)) {
      return match; // Mantém tag de fechamento permitida
    }
    return ''; // Remove tag de fechamento não permitida
  });
  
  // Escapa caracteres especiais que podem causar problemas
  sanitized = sanitized.replace(/&(?!(amp|lt|gt|quot|apos);)/g, '&amp;');
  
  return sanitized;
}

async function sendMenuWithImage(chatId, text, buttons, extraOpts = {}) {
  chatId = String(chatId);
  const { clampText, TG_CAPTION_MAX } = require('./utils/statusProgress');
  const sanitizedText = clampText(sanitizeHtml(stripEmojis(text)), TG_CAPTION_MAX);
  const cleanButtons = sanitizeTelegramButtons(buttons);
  const opts = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: cleanButtons },
    ...extraOpts
  };
  if (opts.reply_markup) opts.reply_markup = sanitizeReplyMarkup(opts.reply_markup);

  const existing = menuMessages[chatId];
  if (existing && existing.isPhoto && !existing.isPixQr && existing.messageId && menuImageBuffer && Buffer.isBuffer(menuImageBuffer)) {
    try {
      await bot.editMessageCaption(sanitizedText, {
        chat_id: chatId,
        message_id: existing.messageId,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: cleanButtons }
      });
      menuMessages[chatId] = { messageId: existing.messageId, text: sanitizedText, isPhoto: true, lastEditAt: Date.now() };
      return { message_id: existing.messageId };
    } catch (e) {}
  }

  if (menuMessages[chatId] && menuMessages[chatId].messageId) {
    try {
      await bot.deleteMessage(chatId, menuMessages[chatId].messageId);
    } catch (e) {}
    delete menuMessages[chatId];
  }
  if (statusMessages[chatId] && statusMessages[chatId].messageId) {
    try {
      await bot.deleteMessage(chatId, statusMessages[chatId].messageId);
    } catch (e) {}
    delete statusMessages[chatId];
  }

  let sent;
  if (menuImageBuffer && Buffer.isBuffer(menuImageBuffer)) {
    sent = await bot.sendPhoto(chatId, menuImageBuffer, {
      caption: sanitizedText,
      ...opts
    });
  } else {
    const sendText = typeof bot._origSendMessage === 'function'
      ? bot._origSendMessage
      : bot.sendMessage.bind(bot);
    sent = await sendText(chatId, sanitizedText, { ...opts, _hanorkRawSend: true });
  }

  if (sent && sent.message_id) {
    menuMessages[chatId] = {
      messageId: sent.message_id,
      text: sanitizedText,
      isPhoto: !!menuImageBuffer,
      lastEditAt: Date.now()
    };
  }
  return sent;
}

async function sendPaymentQr(chatId, qrBuf, caption, rows) {
  chatId = String(chatId);
  const { clampText, TG_CAPTION_MAX } = require('./utils/statusProgress');
  const sanitizedText = clampText(sanitizeHtml(stripEmojis(caption || '')), TG_CAPTION_MAX);
  const cleanButtons = sanitizeTelegramButtons(rows || []);
  if (menuMessages[chatId] && menuMessages[chatId].messageId) {
    try { await bot.deleteMessage(chatId, menuMessages[chatId].messageId); } catch (_) {}
    delete menuMessages[chatId];
  }
  const sent = await bot.sendPhoto(chatId, qrBuf, {
    caption: sanitizedText,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: cleanButtons }
  });
  if (sent && sent.message_id) {
    menuMessages[chatId] = {
      messageId: sent.message_id,
      text: sanitizedText,
      isPhoto: true,
      isPixQr: true,
      lastEditAt: Date.now()
    };
  }
  return sent;
}

const DEFAULT_NAV_BUTTONS = [[
  { text: 'Voltar', callback_data: 'menu_main' },
  { text: 'Fechar', callback_data: 'close' }
]];

async function notify(chatId, text, extraOpts = {}) {
  const kb = extraOpts.reply_markup?.inline_keyboard || DEFAULT_NAV_BUTTONS;
  const menu = menuMessages[String(chatId)];
  if (menu && menu.messageId && !menu.isPixQr && !isConnStatusText(text)) {
    return sendMenuWithImage(chatId, text, kb, extraOpts);
  }
  const opts = {
    reply_markup: { inline_keyboard: kb },
    ...extraOpts
  };
  return updateStatus(chatId, text, opts);
}

async function updateStatus(chatId, text, extraOpts = {}, flags = {}) {
  const key = String(chatId);
  const prev = statusChains.get(key) || Promise.resolve();
  let run;
  const next = new Promise((resolve, reject) => {
    run = () => updateStatusRaw(key, text, extraOpts, flags).then(resolve, reject);
  });
  statusChains.set(key, prev.then(run, run).catch(() => {}));
  return next;
}

async function updateStatusRaw(chatId, text, extraOpts = {}, flags = {}) {
  chatId = String(chatId);
  const allowCreate = flags.allowCreate !== false;
  const sanitizedText = sanitizeHtml(text);
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: DEFAULT_NAV_BUTTONS }, ...extraOpts };
  const now = Date.now();
  const minGap = Number(process.env.HANORK_TG_STATUS_EDIT_MS || 1500);
  const rec = statusMessages[chatId] || {};
  if (rec.lastEditAt && now - rec.lastEditAt < minGap && rec.messageId) {
    rec.queuedText = sanitizedText;
    rec.queuedOpts = opts;
    rec.queuedFlags = flags;
    if (!rec.flushTimer) {
      rec.flushTimer = setTimeout(() => {
        const r = statusMessages[chatId];
        if (!r) return;
        r.flushTimer = null;
        const t = r.queuedText;
        const o = r.queuedOpts;
        const f = r.queuedFlags || {};
        r.queuedText = null;
        r.queuedOpts = null;
        r.queuedFlags = null;
        if (t) updateStatus(chatId, t, o, f).catch(() => {});
      }, minGap);
      statusMessages[chatId] = rec;
    }
    logger.logInfo('[TG-STATUS] queue');
    return;
  }

  if (statusMessages[chatId] && statusMessages[chatId].isPhoto && statusMessages[chatId].messageId) {
    try {
      await bot.editMessageCaption(sanitizedText, {
        chat_id: chatId,
        message_id: statusMessages[chatId].messageId,
        parse_mode: 'HTML',
        reply_markup: opts.reply_markup
      });
      statusMessages[chatId].text = sanitizedText;
      statusMessages[chatId].lastEditAt = Date.now();
      persistStatusSlot(chatId);
      logger.logInfo('[TG-STATUS] edit-caption');
      return;
    } catch (_) { /* tenta texto / substitui 1x */ }
  }

  const existingId = statusMessages[chatId]?.messageId;
  if (existingId) {
    try {
      await bot.editMessageText(sanitizedText, {
        chat_id: chatId,
        message_id: existingId,
        ...opts
      });
      statusMessages[chatId].text = sanitizedText;
      statusMessages[chatId].lastEditAt = Date.now();
      statusMessages[chatId].isPhoto = false;
      persistStatusSlot(chatId);
      logger.logInfo('[TG-STATUS] edit');
      return;
    } catch (e) {
      const msg = String(e.message || e);
      if (/not modified/i.test(msg)) {
        statusMessages[chatId].lastEditAt = Date.now();
        logger.logInfo('[TG-STATUS] edit-same');
        return;
      }
      if (/can't parse entities|parse entities/i.test(msg)) {
        try {
          const plain = sanitizedText.replace(/<[^>]+>/g, '');
          await bot.editMessageText(plain, {
            chat_id: chatId,
            message_id: existingId,
            reply_markup: opts.reply_markup
          });
          statusMessages[chatId].text = plain;
          statusMessages[chatId].lastEditAt = Date.now();
          statusMessages[chatId].isPhoto = false;
          persistStatusSlot(chatId);
          return;
        } catch (_) { /* cai no substitui 1x */ }
      }
      if (!/message to edit not found|MESSAGE_ID_INVALID|message can't be edited/i.test(msg)) {
        logger.logAviso(`[TELEGRAM] edit status falhou (${msg.slice(0, 80)}) — substitui 1x`);
        logger.logInfo('[TG-STATUS] replace-1x');
      }
      try { await bot.deleteMessage(chatId, existingId); } catch (_) {}
      delete statusMessages[chatId];
      persistStatusSlot(chatId);
    }
  }

  if (!allowCreate) {
    logger.logInfo('[TG-STATUS] skip-create');
    return;
  }

  try {
    let sent;
    if (menuImageBuffer && Buffer.isBuffer(menuImageBuffer)) {
      sent = await bot.sendPhoto(chatId, menuImageBuffer, {
        caption: sanitizedText,
        parse_mode: opts.parse_mode,
        reply_markup: opts.reply_markup
      });
      statusMessages[chatId] = {
        messageId: sent.message_id,
        text: sanitizedText,
        isPhoto: true,
        lastEditAt: Date.now()
      };
    } else {
      sent = await bot.sendMessage(chatId, sanitizedText, { ...opts, _hanorkStatusSend: true });
      statusMessages[chatId] = {
        messageId: sent.message_id,
        text: sanitizedText,
        isPhoto: false,
        lastEditAt: Date.now()
      };
    }
    persistStatusSlot(chatId);
    logger.logInfo('[TG-STATUS] send');
  } catch (err) {
    logger.logErro('updateStatus', err.message);
  }
}

function isConnStatusText(text) {
  return /whatsapp conectado|sessao do whatsapp|whatsapp caiu|conflito de conexao|precisa ser paread|conectando ao whatsapp|whatsapp:\s*\d+\s*\/\s*\d+\s*sessao|reconectando todas|reconexao concluida/i.test(
    String(text || '').replace(/<[^>]+>/g, '')
  );
}

if (!bot._hanorkConnGuard) {
  const origTgSend = bot.sendMessage.bind(bot);
  bot._origSendMessage = origTgSend;
  bot.sendMessage = async (chatId, text, options) => {
    const opts = options && typeof options === 'object' ? options : {};
    if (opts._hanorkStatusSend || opts._hanorkRawSend) return origTgSend(chatId, text, opts);
    if (isConnStatusText(text)) {
      logger.logInfo('[TG-STATUS] intercept-send');
      return updateStatus(chatId, text, opts, {
        allowCreate: !statusMessages[String(chatId)]?.messageId
      });
    }
    const extra = {};
    if (opts.parse_mode) extra.parse_mode = opts.parse_mode;
    const kb = opts.reply_markup && opts.reply_markup.inline_keyboard;
    if (Array.isArray(kb) && kb.length) {
      return sendMenuWithImage(chatId, text, kb, extra);
    }
    const existing = menuMessages[String(chatId)];
    if (existing && existing.messageId && !existing.isPixQr) {
      return sendMenuWithImage(chatId, text, DEFAULT_NAV_BUTTONS, extra);
    }
    return origTgSend(chatId, text, opts);
  };
  bot._hanorkConnGuard = true;
}

async function clearStatus(chatId) {
  chatId = String(chatId);
  if (statusMessages[chatId] && statusMessages[chatId].messageId) {
    try {
      await bot.deleteMessage(chatId, statusMessages[chatId].messageId);
    } catch (e) {}
    delete statusMessages[chatId];
    persistStatusSlot(chatId);
  }
}

// ========== SOCKET-READY: (RE)VINCULA HANDLERS E AVISA O USUARIO ==========
let isRestoring = false; // Evita notificações durante restauração inicial

if (sessionEvents && typeof sessionEvents.on === 'function') {
  sessionEvents.on('session-failed', async ({ sessionId, telegramUserId, reason }) => {
    try {
      try { require('./utils/opsMetrics').bump('sessionDead'); } catch (_) { /* ignore */ }
      await notifyWhatsAppDown(telegramUserId, { reason, sessionId });
    } catch (e) {
      logger.logErro('SESSION_FAILED_NOTIFY', e.message);
    }
  });

  sessionEvents.on('socket-ready', async ({ sessionId, telegramUserId, conn }) => {
    try {
      logger.logInfo(`[TELEGRAM] socket-ready recebido - sessionId=${sessionId}, telegramUserId=${telegramUserId}`);

      // CORREÇÃO CRÍTICA: Não ignorar socket-ready para conexões não autenticadas
      // Isso permite que handlers sejam registrados mesmo antes da autenticação completa
      // O problema anterior era que sessões em processo de Pairing Code ficavam sem handlers
      
      // Verifica se a conexão está realmente autenticada para notificação
      // NOTA: conn.authState?.creds?.registered pode falhar no fork SystemZero
      // porque o authState pode não estar exposto no formato esperado.
      // Usamos conn.user como indicador primário de autenticação.
      const isAuthenticated = !!conn.user;
      
      // Sempre vincula handlers; NUNCA marca connected aqui (so em socket-open)
      // Baileys pode ter creds.registered/user fantasma e cair em 401 logo em seguida
      activeConnections.set(sessionId, conn);
      setupHandlers(conn, sessionId, telegramUserId);
      setupEventListeners(conn, sessionId, telegramUserId);
      logger.logInfo(`[TELEGRAM] [${sessionId}] Handlers vinculados ao socket (autenticado=${isAuthenticated}).`);

      if (!isAuthenticated) {
        logger.logInfo(`[TELEGRAM] socket-ready: conexão ainda não autenticada para ${sessionId}, handlers vinculados mas status não alterado`);
      }
      updateSessionStatus(sessionId, 'connecting');
      return;
    } catch (e) {
      logger.logErro('SOCKET_READY_HANDLER', e.message);
    }
  });

  // Remove socket morto do Map (só se ainda for o mesmo objeto) — evita "conectado" fantasma
  sessionEvents.on('socket-closed', ({ sessionId, telegramUserId, conn, reason, errorMsg }) => {
    try {
      const current = activeConnections.get(sessionId);
      if (current && conn && current === conn) {
        activeConnections.delete(sessionId);
        logger.logInfo(`[TELEGRAM] socket-closed: removido ${sessionId} do Map (reason=${reason || errorMsg || '?'})`);
      } else if (current && !conn) {
        activeConnections.delete(sessionId);
      }
      try {
        const { hasLiveSocketForUser } = require('./connection');
        if (telegramUserId && !hasLiveSocketForUser(telegramUserId)) {
          require('./utils/divulgacaoAuto').stopScheduler(String(telegramUserId));
        }
      } catch (_) { /* ignore */ }
    } catch (e) {
      logger.logErro('SOCKET_CLOSED_HANDLER', e.message);
    }
  });

  sessionEvents.on('socket-open', async ({ sessionId, telegramUserId, conn }) => {
    try {
      if (!conn) return;
      activeConnections.set(sessionId, conn);
      setupHandlers(conn, sessionId, telegramUserId);
      setupEventListeners(conn, sessionId, telegramUserId);
      try {
        updateSessionStatus(sessionId, 'connected', { needsRepair: false, lastError: null });
      } catch (_) {
        updateSessionStatus(sessionId, 'connected');
      }
      logger.logInfo(`[TELEGRAM] socket-open: ${sessionId} viva no Map`);
      try {
        require('./utils/divulgacaoAuto').restartIfEnabled(telegramUserId, { catchUp: true });
      } catch (_) { /* ignore */ }

      // Nao grava LID/bot na lista de donos. Lista so muda com addowner/removeowner.
      try {
        const { rememberLidPhonePair } = require('./utils');
        const { addOwner, getOwners } = require('./utils/configManager');
        const rawId = conn.user?.id || conn.user?.jid || '';
        const phone = rawId ? String(rawId).split(':')[0].split('@')[0].replace(/\D/g, '') : '';
        const botJid = phone.length >= 10 ? `${phone}@s.whatsapp.net` : null;
        const botLid = conn.user?.lid || conn.authState?.creds?.me?.lid || '';
        if (botLid && botJid) rememberLidPhonePair(botLid, botJid);
        if (botJid) addOwner(telegramUserId, botJid);
        logger.logInfo(`[AUTH] owners n=${getOwners(telegramUserId).length} session=${sessionId}`);
        try {
          const sess = getSession(sessionId);
          if (!sess || typeof sess.buttonMode !== 'boolean') {
            setSessionButtonMode(sessionId, true);
          }
        } catch (_) { /* ignore */ }
      } catch (e) {
        logger.logAviso(`[AUTH] owners sync: ${e.message}`);
      }

      if (isRestoring || inRestoreQuiet()) {
        logger.logInfo('[TG-STATUS] quiet-open');
        bumpRestoreQuiet(20000);
        scheduleConnSummary(telegramUserId);
        return;
      }
      bumpRestoreQuiet(12000);
      logger.logInfo('[TG-STATUS] open-summary');
      scheduleConnSummary(telegramUserId);
      try {
        require('./utils/divulgacaoAuto').startScheduler(String(telegramUserId));
      } catch (_) { /* auto opcional */ }
      try {
        if (!isAdmin(telegramUserId)) {
          const k = String(sessionId || telegramUserId);
          const last = chipOnlineHelloAt.get(k) || 0;
          if (Date.now() - last > 6 * 3600 * 1000) {
            chipOnlineHelloAt.set(k, Date.now());
            const offer = require('./utils/productOffer');
            await bot.sendMessage(telegramUserId, offer.howToChipOnline(telegramUserId), {
              reply_markup: { inline_keyboard: offer.shopSetupKeyboard() }
            });
          }
        }
      } catch (_) { /* opcional */ }
      return;
    } catch (e) {
      logger.logErro('SOCKET_OPEN_HANDLER', e.message);
    }
  });

  sessionEvents.on('session-needs-repair', async ({ sessionId, telegramUserId, reason }) => {
    try {
      const uid = String(telegramUserId || '').trim();
      if (!uid) return;
      try { require('./utils/opsMetrics').bump('sessionDead'); } catch (_) { /* ignore */ }
      await notifyWhatsAppDown(uid, { reason, sessionId });
      try {
        const key = `dead:${sessionId}`;
        const now = Date.now();
        if (!global.__hanorkDeadAlert) global.__hanorkDeadAlert = new Map();
        const prev = global.__hanorkDeadAlert.get(key) || 0;
        if (now - prev > 30 * 60 * 1000) {
          global.__hanorkDeadAlert.set(key, now);
          const { formatSessionDeadShopText } = require('./utils/opsHealth');
          const { upsertStickyPhoto } = require('./utils/tgStickyNotice');
          const { ADMIN_IDS } = require('./utils/userManager');
          const caption = formatSessionDeadShopText(reason);
          for (const adminId of ADMIN_IDS || []) {
            await upsertStickyPhoto({
              chatId: adminId,
              kvKey: `session_dead_${String(sessionId || uid).slice(-12)}_${adminId}`,
              caption
            });
          }
        }
      } catch (_) { /* admin notify opcional */ }
    } catch (e) {
      logger.logAviso(`[TELEGRAM] session-needs-repair notify: ${e.message}`);
    }
  });

  sessionEvents.on('session-conflict', async ({ sessionId, telegramUserId, reason }) => {
    try {
      const uid = String(telegramUserId || '').trim();
      if (!uid) return;
      await notifyWhatsAppDown(uid, { kind: 'conflict', reason, sessionId });
    } catch (e) {
      logger.logAviso(`[TELEGRAM] session-conflict notify: ${e.message}`);
    }
  });
}

/** Prefere sessão com socket vivo; evita pegar 1ª do registry sem conn */
function connLooksLive(conn) {
  if (!conn) return false;
  try {
    const ws = conn.ws || conn.socket;
    if (ws && typeof ws.readyState === 'number' && ws.readyState !== 1) return false;
  } catch (_) { /* ws opcional */ }
  const u = conn.user || conn.authState?.creds?.me;
  return !!(u && (u.id || u.jid || u.lid));
}

function resolveLiveSession(userId) {
  const userSessions = getUserSessions(userId) || [];
  for (const s of userSessions) {
    const conn = activeConnections.get(s.sessionId);
    if (connLooksLive(conn)) {
      return { sessionId: s.sessionId, conn, session: s, reason: null };
    }
    if (conn && !connLooksLive(conn)) {
      logger.logAviso(`[TG] socket morto sid=${String(s.sessionId).slice(-8)} status=${s.status || '?'}`);
    }
  }
  const connecting = userSessions.find((s) => s.status === 'connecting');
  if (connecting) {
    return { sessionId: connecting.sessionId, conn: null, session: connecting, reason: 'connecting' };
  }
  const marked = userSessions.find((s) => s.status === 'connected');
  if (marked) {
    return { sessionId: marked.sessionId, conn: null, session: marked, reason: 'socket_missing' };
  }
  if (userSessions.length) {
    return { sessionId: userSessions[0].sessionId, conn: null, session: userSessions[0], reason: 'offline' };
  }
  return { sessionId: null, conn: null, session: null, reason: 'none' };
}

function liveSessionErrorMessage(reason) {
  switch (reason) {
    case 'connecting':
      return 'Ainda conectando. Espere uns segundos e tente de novo.';
    case 'socket_missing':
      return 'Marcado como conectado, mas ainda nao esta pronto. Espere ou toque em Reconectar.';
    case 'offline':
      return 'WhatsApp desligado. Conecte primeiro pelo menu.';
    case 'none':
    default:
      return 'Voce precisa conectar o WhatsApp primeiro.';
  }
}

// ========== VERIFICAÇÃO DE CANAL ==========
function parseTgChannelRef(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^-100\d+$/.test(s) || /^-\d{6,}$/.test(s)) return s;
  const fromUrl = s.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)/i);
  if (fromUrl) return `@${fromUrl[1]}`;
  if (s.startsWith('@')) return s;
  if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(s)) return `@${s}`;
  return s;
}

function channelFollowLabel(ch) {
  const link = String(ch && ch.link || '');
  const m = link.match(/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)/i);
  if (m) return `@${m[1]}`;
  const u = String(ch && ch.username || '');
  if (u.startsWith('@')) return u;
  if (/^-?\d+$/.test(u)) return 'canal oficial';
  return u ? `@${u}` : 'canal oficial';
}

function loadRequiredChannels() {
  const rows = [
    { username: process.env.TELEGRAM_CHANNEL_ID, link: CHANNEL_LINK },
    { username: process.env.TELEGRAM_CHANNEL_2_ID, link: process.env.TELEGRAM_CHANNEL_2_LINK }
  ];
  const out = [];
  for (const r of rows) {
    const username = parseTgChannelRef(r.username);
    const link = String(r.link || '').trim();
    if (!username || !link) continue;
    out.push({ username, link, label: channelFollowLabel({ username, link }) });
  }
  return out;
}

let REQUIRED_CHANNELS = loadRequiredChannels();

const CHANNEL_FOLLOW_OK_TTL_MS = 5 * 60 * 1000;
const channelFollowCache = new Map();

function clearChannelFollowCache(userId) {
  const prefix = `${userId}:`;
  for (const k of channelFollowCache.keys()) {
    if (k.startsWith(prefix)) channelFollowCache.delete(k);
  }
}

function channelQueryRefs(channel) {
  const refs = [];
  const push = (v) => {
    const s = parseTgChannelRef(v);
    if (s && !refs.includes(s)) refs.push(s);
  };
  push(channel && channel.username);
  push(channel && channel.link);
  if (REQUIRED_CHANNEL && /^-100\d+$/.test(String(REQUIRED_CHANNEL))) {
    push(REQUIRED_CHANNEL);
  }
  return refs;
}

async function checkUserFollowsChannel(userId, channelUsername) {
  return checkChannelMembership(userId, { username: channelUsername });
}

async function getChatMemberTimed(chatRef, userId, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      bot.getChatMember(chatRef, userId),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkChannelMembership(userId, channel, opts = {}) {
  const force = !!opts.force;
  const refs = typeof channel === 'object' ? channelQueryRefs(channel) : [parseTgChannelRef(channel)];
  if (!refs.length) return true;

  const cacheKey = `${userId}:${refs[0]}`;
  if (!force) {
    const hit = channelFollowCache.get(cacheKey);
    if (hit && hit.ok && Date.now() - hit.ts < CHANNEL_FOLLOW_OK_TTL_MS) return true;
  }

  let lastErr = '';
  for (const ref of refs) {
    try {
      const member = await getChatMemberTimed(ref, userId, 5000);
      const status = String(member && member.status || '');
      const ok = ['member', 'administrator', 'creator', 'restricted'].includes(status);
      logger.logInfo(`[CHANNEL] check ref=${ref} status=${status || 'vazio'} ok=${ok ? 1 : 0}`);
      if (ok) {
        channelFollowCache.set(cacheKey, { ok: true, ts: Date.now() });
        return true;
      }
      lastErr = status || 'not-member';
    } catch (error) {
      const msg = String(error && error.message ? error.message : error);
      lastErr = msg;
      if (/bot is not a member|not a member of the (?:chat|channel)|chat not found|CHAT_ADMIN_REQUIRED|not enough rights/i.test(msg)) {
        logger.logAviso(`[CHANNEL] bot nao consulta ${ref}: ${msg.slice(0, 80)} — libera`);
        channelFollowCache.set(cacheKey, { ok: true, ts: Date.now() });
        return true;
      }
      if (msg === 'timeout') {
        logger.logAviso(`[CHANNEL] timeout ${ref}`);
        continue;
      }
      logger.logAviso(`[CHANNEL] erro ${ref}: ${msg.slice(0, 100)}`);
    }
  }

  logger.logAviso(`[CHANNEL] nao segue refs=${refs.join(',')} last=${String(lastErr).slice(0, 60)}`);
  return false;
}

async function ensureChannelFollow(chatId, userId, opts = {}) {
  if (REQUIRED_CHANNELS.length === 0) return true;
  if (isAdmin(userId)) return true;
  try {
    if (getUserSessions(userId).length > 0) return true;
  } catch (_) { /* ignore */ }

  if (opts.force) clearChannelFollowCache(userId);

  const notFollowed = [];
  for (const channel of REQUIRED_CHANNELS) {
    const follows = await checkChannelMembership(userId, channel, opts);
    if (!follows) notFollowed.push(channel);
  }

  if (notFollowed.length === 0) return true;

  const keyboard = [];
  for (const channel of notFollowed) {
    keyboard.push([{ text: `Seguir ${channel.label || channelFollowLabel(channel)}`, url: channel.link }]);
  }
  keyboard.push([{ text: 'Ja segui — verificar', callback_data: 'check_channel' }]);

  const channelsList = notFollowed.map((c) => channelFollowLabel(c)).join(', ');
  const blockMsg =
    `Acesso bloqueado\n\n` +
    `Pra usar o bot, segue o canal:\n` +
    `${channelsList}\n\n` +
    `Depois de seguir, toca em verificar.`;

  await sendMenuWithImage(chatId, blockMsg, keyboard);
  return false;
}

async function notifyAdminsAboutChannel(channelId) {
  if (!channelId || !CHANNEL_LINK) return;

  const adminIds = [];
  try {
    const registry = loadRegistry();
    if (registry && registry.admins) {
      for (const id of registry.admins) {
        if (id) adminIds.push(String(id));
      }
    }
  } catch (e) {}

  if (adminIds.length === 0) {
    const envAdmins = process.env.TELEGRAM_ADMIN_IDS ? process.env.TELEGRAM_ADMIN_IDS.split(',').map(id => id.trim()) : [];
    for (const id of envAdmins) {
      if (id && !adminIds.includes(id)) adminIds.push(id);
    }
  }

  if (adminIds.length === 0) return;

  const message =
    `📢 <b>ID do canal resolvido automaticamente</b>\n\n` +
    `O canal @${process.env.TELEGRAM_CHANNEL_ID} foi resolvido para o ID:\n` +
    `<code>${channelId}</code>\n\n` +
    `Para evitar futuras notificacoes, atualize seu arquivo .env com:\n` +
    `TELEGRAM_CHANNEL_ID=${channelId}\n\n` +
    `Link: ${CHANNEL_LINK}`;

  for (const adminId of adminIds) {
    try {
      await bot.sendMessage(adminId, message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: 'Abrir canal', url: CHANNEL_LINK }]]
        }
      });
    } catch (e) {}
  }
}

// ========== UTILITÁRIOS ==========
function getStatusIcon(status) {
  return status === 'connected' ? '[ON]' : status === 'connecting' ? '[..]' : '[OFF]';
}

function formatSession(s, showUser = false) {
  let text = `${getStatusIcon(s.status)} <b>${s.phone || s.sessionId.slice(0,8)}</b>`;
  text += `\n   Status: ${s.status}`;
  if (showUser) text += `\n   👤 ${s.telegramUserId}`;
  if (s.phone) text += `\n   📱 ${s.phone}`;
  text += `\n   📅 ${new Date(s.createdAt).toLocaleString()}`;
  return text;
}

function getUserDisplayName(userId) {
  try {
    const meta = getUserMetadata(userId);
    return meta.username || meta.first_name || `Usuario ${userId}`;
  } catch {
    return `Usuario ${userId}`;
  }
}

/** Dono TG = tem sessao WA nesta conta, ou TELEGRAM_ADMIN */
function tgIsSessionOwner(userId) {
  if (isAdmin(userId)) return true;
  try {
    return getUserSessions(userId).length > 0;
  } catch (_) {
    return false;
  }
}

function tgDenyUnlessOwner(userId, data) {
  if (tgIsSessionOwner(userId)) return false;
  console.log(`[AUTH_SILENT] TG btn=${data} user=${userId} | dono/sessao obrigatorio`);
  return true;
}

/** HANORK_OWNER_ONLY: so TELEGRAM_ADMIN. User comum nao recebe menu/compra. */
function tgDropIfOwnerOnly(userId) {
  try {
    const { isOwnerOnlyMode, isPlatformAdminId } = require('./utils/ownerOnlyMode');
    if (!isOwnerOnlyMode()) return false;
    if (isPlatformAdminId(userId) || isAdmin(userId)) return false;
    logger.logInfo(`[TELEGRAM] OWNER_ONLY drop user=${userId}`);
    return true;
  } catch (_) {
    return false;
  }
}

/** Pago (VIP) ou dono da sessao: monta DIV no Telegram mesmo sem chip online. Disparo ainda exige sessao. */
function tgCanUseDivMenu(userId) {
  if (tgIsSessionOwner(userId)) return true;
  const role = telegramMenuRole(userId);
  return role === 'vip' || role === 'platform_admin';
}

function telegramMenuRole(userId) {
  const uid = String(userId || '');
  if (isAdmin(uid)) return 'platform_admin';
  try {
    if ((getUserSessions(uid) || []).length > 0) return 'owner';
  } catch (_) { /* ignore */ }
  try {
    const vipIndex = require('./services/billing/vipIndex');
    if (vipIndex.tierOf('telegram', uid) !== 'free') return 'vip';
  } catch (_) { /* ignore */ }
  return 'user';
}

// ========== MENUS PRINCIPAIS ==========
const MENUS = {
  main: {
    text: (userId) => {
      const isAdminUser = isAdmin(userId);
      const name = getUserDisplayName(userId);
      const userSessions = getUserSessions(userId);
      const live = (userSessions || []).filter((s) => s.status === 'connected').length;
      let howTo = '';
      try {
        howTo = require('./utils/productOffer').howToUseWhatsApp(userId);
      } catch (_) { /* ignore */ }
      if (!isAdminUser) {
        try {
          const { storefrontText } = require('./utils/productOffer');
          return `${storefrontText()}\n\n${howTo}`;
        } catch (_) { /* cai no bloco admin */ }
      }
      return (
        `HANORK\n` +
        `${name}\n\n` +
        (isAdminUser ? 'Painel do dono: contas, VIP, compras e PIX\n' : '') +
        `Contas WhatsApp: ${userSessions.length} · ligadas: ${live}\n` +
        `\n${howTo}\n` +
        `\nEscolha uma opcao:`
      );
    },
    buttons: (userId) => {
      const isAdminUser = isAdmin(userId);
      const hasSession = getUserSessions(userId).length > 0;
      const role = telegramMenuRole(userId);
      let productTier = 'free';
      try {
        productTier = require('./services/billing/tiers').sessionProductTier({
          telegramUserId: userId,
          platform: 'telegram',
          isTelegram: true
        });
      } catch (_) { /* free */ }
      return tgMainButtons(isAdminUser, isAdminUser, role, {
        hasSession: hasSession || isAdminUser,
        productTier
      });
    }
  },
  mais: {
    text: 'HANORK\n\nMenu principal atualizado. Use as categorias do inicio.',
    buttons: (userId) => tgMoreButtons(isAdmin(userId))
  },
  sessions: {
    text: (userId) => {
      const sessions = getUserSessions(userId);
      if (sessions.length === 0) return '📭 <b>Voce nao tem nenhuma sessao.</b>';
      let t = '📱 <b>Suas Sessoes</b>\n\n';
      sessions.forEach((s, i) => {
        t += `${i+1}. ${formatSession(s)}\n`;
      });
      t += '\nClique em uma sessao para gerenciar.';
      return t;
    },
    buttons: (userId) => {
      const sessions = getUserSessions(userId);
      const btns = sessions.map(s => [
        { text: `${getStatusIcon(s.status)} ${s.phone || s.sessionId.slice(0,8)}`, callback_data: `session_${s.sessionId}` }
      ]);
      btns.push([{ text: '🔗 Conectar nova', callback_data: 'connect' }]);
      btns.push([{ text: '🔙 Voltar', callback_data: 'menu_main' }, { text: '❌ Fechar', callback_data: 'close' }]);
      return btns;
    }
  },
  session_detail: {
    text: (sessionId) => {
      const s = getSession(sessionId);
      if (!s) return '❌ Sessao nao encontrada.';
      const buttonMode = areButtonsOn(sessionId, s.telegramUserId);
      const modeText = buttonMode ? "ON" : "OFF";
      return `📱 <b>Detalhes</b>\n\n${formatSession(s, true)}\n\n<b>Modo Botoes:</b> ${modeText}\n\nO que fazer?`;
    },
    buttons: (sessionId, userId) => {
      const canManage = canAccessSession(userId, sessionId) || isAdmin(userId);
      if (!canManage) return [[{ text: '🔙 Voltar', callback_data: 'menu_sessions' }, { text: '❌ Fechar', callback_data: 'close' }]];
      const buttonMode = areButtonsOn(sessionId, userId);
      const modeText = buttonMode ? "Botoes ON" : "Botoes OFF";
      return [
        [{ text: '📊 Status', callback_data: `status_${sessionId}` }],
        [{ text: `🔘 ${modeText}`, callback_data: `toggle_buttons_${sessionId}` }],
        [{ text: '🔄 Reconectar', callback_data: `reconnect_${sessionId}` }],
        [{ text: '❌ Desconectar', callback_data: `disconnect_${sessionId}` }],
        [{ text: '🗑️ Deletar', callback_data: `delete_${sessionId}` }],
        [{ text: '📋 Copiar ID', copy_text: { text: sessionId } }],
        [{ text: '🔙 Voltar', callback_data: 'menu_sessions' }, { text: '❌ Fechar', callback_data: 'close' }],
      ];
    }
  },
  admin: {
    text: async () => {
      try {
        return await require('./utils/adminOpsPanel').formatOverview();
      } catch (e) {
        return `HANORK · PAINEL\n\nNao consegui montar o resumo: ${String(e.message || e).slice(0, 80)}`;
      }
    },
    buttons: () => {
      const all = getAllSessions();
      const total = all.length;
      const connected = all.filter(s => s.status === 'connected').length;
      const limit = require('./utils/sessionRegistry').MAX_SESSIONS;
      const ops = require('./utils/adminOpsPanel').nav('menu_admin');
      return [
        [{ text: `Sessoes ${connected}/${total} (teto ${limit})`, callback_data: 'admin_list_all' }],
        ...ops.slice(1, 3),
        [{ text: 'Listar usuarios', callback_data: 'admin_list_users' }],
        [{ text: 'Reconectar todas', callback_data: 'admin_reconnect_all' }],
        [{ text: 'Limpar invalidas', callback_data: 'admin_cleanup' }],
        [{ text: 'Logs', callback_data: 'admin_logs' }, { text: 'Config', callback_data: 'admin_config' }],
        [{ text: 'Atualizar', callback_data: 'menu_admin' }, { text: 'Voltar', callback_data: 'menu_main' }]
      ];
    }
  },
  admin_ops: {
    text: async () => require('./utils/adminOpsPanel').formatOverview(),
    buttons: () => require('./utils/adminOpsPanel').nav('admin_ops')
  },
  admin_vips: {
    text: async () => require('./utils/adminOpsPanel').formatVips(),
    buttons: () => require('./utils/adminOpsPanel').nav('admin_vips')
  },
  admin_sales: {
    text: async () => require('./utils/adminOpsPanel').formatSales(),
    buttons: () => require('./utils/adminOpsPanel').nav('admin_sales')
  },
  admin_pix: {
    text: async () => require('./utils/adminOpsPanel').formatPix(),
    buttons: () => require('./utils/adminOpsPanel').nav('admin_pix')
  },
  admin_health: {
    text: (userId) => {
      try {
        return require('./utils/opsHealth').formatOpsHealthText(userId);
      } catch (e) {
        return `Health indisponivel: ${String(e.message || e).slice(0, 120)}`;
      }
    },
    buttons: () => [
      [{ text: 'Atualizar', callback_data: 'admin_health' }],
      [{ text: 'Grupos protegidos', callback_data: 'admin_prot' }],
      [{ text: 'Limpar sessoes mortas', callback_data: 'admin_cleanup' }],
      [{ text: 'Voltar', callback_data: 'menu_admin' }, { text: 'Fechar', callback_data: 'close' }]
    ]
  },
  admin_prot: {
    text: async () => {
      try {
        const { summarizeProtectionsAsync } = require('./utils/protectionStore');
        const s = await summarizeProtectionsAsync();
        let metrics = '';
        try {
          metrics = '\n\n' + require('./utils/opsMetrics').formatDayReport();
        } catch (_) { /* ignore */ }
        return (
          `GRUPOS PROTEGIDOS\n\n` +
          `Com protecao ligada: ${s.groups}\n` +
          `Anti-roubo: ${s.antiadmin}\n` +
          `Anti-link: ${s.antilink}\n` +
          `Anti-ataque: ${s.antiatk}` +
          metrics
        );
      } catch (e) {
        return `Protecoes: ${String(e.message || e).slice(0, 120)}`;
      }
    },
    buttons: () => [
      [{ text: 'Atualizar', callback_data: 'admin_prot' }],
      [{ text: 'Health', callback_data: 'admin_health' }],
      [{ text: 'Voltar', callback_data: 'menu_admin' }, { text: 'Fechar', callback_data: 'close' }]
    ]
  },
  admin_list_all: {
    text: () => {
      try {
        return require('./utils/adminOpsPanel').formatSessions();
      } catch (_) {
        const all = getAllSessions();
        if (all.length === 0) return 'Nenhuma sessao.';
        let t = 'HANORK · SESSOES\n\n';
        all.slice(0, 18).forEach((s, i) => {
          t += `${i + 1}. ${formatSession(s)}\n`;
        });
        return t;
      }
    },
    buttons: () => require('./utils/adminOpsPanel').nav('admin_list_all')
  },
  admin_config: {
    text: (userId) => {
      const { formatPrefixStatus, getButtonsEnabled } = require('./utils/configManager');
      const owners = formatOwnersCaption(userId, { max: 6, sep: '\n' });
      const vips = getVips(userId);
      const blacklist = getBlacklist(userId);
      const sessions = getUserSessions(userId);
      const btnModes = sessions.map((s) => {
        const on = areButtonsOn(s.sessionId, userId);
        return `${s.phone || s.sessionId.slice(0, 8)}: ${on ? 'ON' : 'OFF'}`;
      });
      let t = `Suas Configuracoes\n\n`;
      t += `${formatPrefixStatus(userId)}\n\n`;
      t += `Botoes WA (padrao ON): ${areButtonsOn(sessions[0]?.sessionId, userId) ? 'ON' : 'OFF'}\n`;
      if (btnModes.length) t += `${btnModes.join('\n')}\n`;
      t += `\nDonos desta sessao:\n${owners}\n`;
      t += `VIPs: ${vips.length ? vips.map(formatOwnerLabel).join(', ') : 'Nenhum'}\n`;
      t += `Blacklist: ${blacklist.length ? blacklist.join(', ') : 'Nenhum'}\n\n`;
      t += `Escolha uma opcao para editar:`;
      return t;
    },
    buttons: () => [
      [{ text: 'Botoes WA ON/OFF', callback_data: 'menu_botoes' }],
      [{ text: 'Alterar Prefixo', callback_data: 'config_prefix' }],
      [{ text: 'Gerenciar Donos', callback_data: 'config_owners' }],
      [{ text: 'Gerenciar VIPs', callback_data: 'config_vips' }],
      [{ text: 'Gerenciar Blacklist', callback_data: 'config_blacklist' }],
      [{ text: 'Voltar', callback_data: 'menu_main' }, { text: 'Fechar', callback_data: 'close' }],
    ]
  },
  config_owners: {
    text: (userId) => {
      const owners = formatOwnersCaption(userId, { max: 8, sep: '\n' });
      return `Donos desta sessao\n\n${owners}\n\nUse /addowner numero ou /removeowner numero. So o chip desta sessao.`;
    },
    buttons: () => [
      [{ text: 'Adicionar Dono', callback_data: 'add_owner' }],
      [{ text: 'Remover Dono', callback_data: 'remove_owner' }],
      [{ text: 'Voltar', callback_data: 'admin_config' }, { text: 'Fechar', callback_data: 'close' }],
    ]
  },
  config_vips: {
    text: (userId) => {
      const vips = getVips(userId);
      return `VIPs\n\n${vips.length ? vips.map(formatOwnerLabel).join('\n') : 'Nenhum VIP cadastrado.'}\n\nUse /addvip numero ou /removevip numero.`;
    },
    buttons: () => [
      [{ text: '➕ Adicionar VIP', callback_data: 'add_vip' }],
      [{ text: '➖ Remover VIP', callback_data: 'remove_vip' }],
      [{ text: '🔙 Voltar', callback_data: 'admin_config' }, { text: '❌ Fechar', callback_data: 'close' }],
    ]
  },
  config_blacklist: {
    text: (userId) => {
      const blacklist = getBlacklist(userId);
      return `🚫 <b>Blacklist</b>\n\n${blacklist.length ? blacklist.join('\n') : 'Nenhum grupo na blacklist.'}\n\nUse /addblacklist &lt;code&gt;jid&lt;/code&gt; ou /removeblacklist &lt;code&gt;jid&lt;/code&gt; para gerenciar.`;
    },
    buttons: () => [
      [{ text: '➕ Adicionar a Blacklist', callback_data: 'add_blacklist' }],
      [{ text: '➖ Remover da Blacklist', callback_data: 'remove_blacklist' }],
      [{ text: '🔙 Voltar', callback_data: 'admin_config' }, { text: '❌ Fechar', callback_data: 'close' }],
    ]
  },
  help: {
    text: (userId) => {
      let t = 'Ajuda Hanork (Telegram)\n\n';
      t += '/start — vitrine (planos) ou menu se ja pagou\n';
      t += '/connect — conectar WhatsApp\n';
      t += '/mysessions — suas contas\n';
      t += '/comprar /planos /afiliado\n';
      t += '/menu /comandos /ping /help\n\n';
      t += 'Neste chat todos os comandos sao com /  (ex: /menu).\n';
      t += 'O Telegram e o painel. No WhatsApp o prefixo e o da sua sessao (troca com /setprefix).\n';
      return t;
    },
    buttons: () => [[{ text: 'Voltar', callback_data: 'menu_main' }, { text: 'Fechar', callback_data: 'close' }]]
  },
  antiflood: {
    text: (userId) => {
      try {
        const { listGroupsWithFlag } = require('./utils/protectionStore');
        const n = listGroupsWithFlag(userId, 'antiflood').length;
        return (
          `ANTI-FLOOD E SEGURANCA\n\n` +
          `Grupos com anti-flood ativo: ${n}\n\n` +
          `O que o anti-flood remove (membros comuns):\n` +
          `- view-once / mensagem invisivel\n` +
          `- flood de pagamento / PIX\n` +
          `- protocolo de status abusivo\n\n` +
          `Aqui no Telegram: listar / ativar / desativar anti-flood por grupo.\n` +
          `O painel completo de protecoes (antilink, anti-pv, etc) e no WhatsApp, no grupo.`
        );
      } catch {
        return 'ANTI-FLOOD / MODERACAO\n\nControle de anti-abuso por grupo.';
      }
    },
    buttons: () => [
      [{ text: 'Listar ativos', callback_data: 'af_list' }],
      [{ text: 'Ativar em grupo', callback_data: 'af_pick_on' }],
      [{ text: 'Desativar em grupo', callback_data: 'af_pick_off' }],
      [{ text: 'Voltar', callback_data: 'menu_main' }, { text: 'Fechar', callback_data: 'close' }]
    ]
  },
  botoes: {
    text: (userId) => {
      const sessions = getUserSessions(userId) || [];
      if (!sessions.length) {
        return 'BOTOES ON/OFF\n\nNenhuma sessao. Conecte o WhatsApp primeiro.\n\nON = menus com botoes\nOFF = encaminhada do canal oficial';
      }
      let t = 'BOTOES ON/OFF\n\nON = menus com botoes\nOFF = encaminhada do canal\n\nToque na sessao para alternar:\n\n';
      for (const s of sessions) {
        const mode = areButtonsOn(s.sessionId, userId) ? 'ON' : 'OFF';
        t += `${s.phone || s.sessionId.slice(0, 8)} → Botoes ${mode}\n`;
      }
      return t;
    },
    buttons: (userId) => {
      const sessions = getUserSessions(userId) || [];
      const btns = sessions.map((s) => {
        const mode = areButtonsOn(s.sessionId, userId) ? 'ON' : 'OFF';
        const label = `${s.phone || s.sessionId.slice(0, 8)}: ${mode} (tocar p/ alternar)`;
        return [{ text: label.slice(0, 64), callback_data: `toggle_buttons_${s.sessionId}` }];
      });
      if (!btns.length) {
        btns.push([{ text: 'Conectar WhatsApp', callback_data: 'connect' }]);
      }
      btns.push([{ text: 'Voltar', callback_data: 'menu_main' }, { text: 'Fechar', callback_data: 'close' }]);
      return btns;
    }
  },
  nuke: {
    text: (userId) => {
      try {
        const { getNukeConfig } = require('./utils/configManager');
        const c = getNukeConfig(userId) || {};
        return (
          `NUKE CONFIGURAVEL\n\n` +
          `Nome: ${c.groupName || '(padrao)'}\n` +
          `Desc: ${c.groupDesc || '(padrao)'}\n` +
          `Msg: ${c.groupMessage || '(padrao)'}\n` +
          `Foto: ${c.groupImage ? 'definida' : 'nao'}\n\n` +
          `Config aqui (so /):\n` +
          `/nukename /nukedesc /nukemsg /nukeimg /nukeconfig /nukereset\n\n` +
          `Executar: botao abaixo (escolhe o grupo)`
        );
      } catch {
        return 'NUKE CONFIGURAVEL\n\nConfigure e execute no WhatsApp.';
      }
    },
    buttons: () => [
      [{ text: 'Ver config', callback_data: 'nuke_show_cfg' }],
      [{ text: 'Reset config', callback_data: 'nuke_reset_cfg' }],
      [{ text: 'Executar em grupo', callback_data: 'nuke_pick_run' }],
      [{ text: 'Voltar', callback_data: 'menu_main' }, { text: 'Fechar', callback_data: 'close' }]
    ]
  },
  exploits: {
    text: 'Travas / Exploits\n\nUse com responsabilidade. Comandos no WhatsApp (prefixo da sessao).',
    buttons: () => [
      [{ text: 'Travas Individuais', callback_data: 'exploits_individuais' }],
      [{ text: 'Travas de Grupo', callback_data: 'exploits_grupo' }],
      [{ text: 'Modo Interativo', callback_data: 'exploits_interativo' }],
      [{ text: 'Legados', callback_data: 'exploits_legados' }],
      [{ text: 'Voltar', callback_data: 'menu_main' }, { text: 'Fechar', callback_data: 'close' }],
    ]
  },
  exploits_individuais: {
    text: 'Travas Individuais\n\nUse no WhatsApp com o prefixo configurado:\n\n' +
          '• crashios - Crash iOS\n' +
          '• atraso - Atraso (500x)\n' +
          '• nullatraso - Null Atraso\n' +
          '• atraso2 - Atraso 2 (carousel)\n' +
          '• convite - Convite bugado\n' +
          '• carrinho - Carrinho bugado\n' +
          '• sistema - Sistema bug\n' +
          '• sistema2 - Sistema 2 bug\n' +
          '• fotobutton - Foto button\n' +
          '• listloc - List location\n' +
          '• wppexe - Congelar WPP Exe\n' +
          '• wppweb - Congelar WPP Web',
    buttons: () => [[{ text: 'Voltar', callback_data: 'menu_exploits' }, { text: 'Fechar', callback_data: 'close' }]]
  },
  exploits_grupo: {
    text: 'Travas de Grupo\n\nUse no WhatsApp com o prefixo configurado:\n\n' +
          '• crashgp - Crash grupo\n' +
          '• atrasogp - Atraso grupo\n' +
          '• fotogp - Foto bug grupo',
    buttons: () => [[{ text: 'Voltar', callback_data: 'menu_exploits' }, { text: 'Fechar', callback_data: 'close' }]]
  },
  exploits_interativo: {
    text: 'Modo Interativo\n\nUse no WhatsApp com o prefixo configurado:\n\n' +
          '• step_crashios - Crash iOS interativo\n' +
          '• step_atraso - Atraso interativo\n' +
          '• step_crashgp - Crash GP interativo\n' +
          '• step_atrasogp - Atraso GP interativo\n' +
          '• step_convite - Convite interativo\n' +
          '• step_carrinho - Carrinho interativo\n' +
          '• step_sistema - Sistema interativo\n' +
          '• step_sistema2 - Sistema 2 interativo\n' +
          '• step_nullatraso - Null Atraso interativo\n' +
          '• step_atraso2 - Atraso 2 interativo\n' +
          '• step_fotogp - Foto GP interativo\n' +
          '• step_fotobutton - Foto button interativo\n' +
          '• step_listloc - List loc interativo\n' +
          '• step_wppexe - WPP Exe interativo\n' +
          '• step_wppweb - WPP Web interativo\n\n' +
          'Para cancelar, envie "cancelar"',
    buttons: () => [[{ text: 'Voltar', callback_data: 'menu_exploits' }, { text: 'Fechar', callback_data: 'close' }]]
  },
  exploits_legados: {
    text: 'Exploits Legados\n\nUse no WhatsApp com o prefixo configurado:\n\n' +
          '• bugchat - Bug de canal\n' +
          '• atraso_status - Atraso de status (500x)',
    buttons: () => [[{ text: 'Voltar', callback_data: 'menu_exploits' }, { text: 'Fechar', callback_data: 'close' }]]
  },
  webintelligence: {
    text: 'Busca Web com IA\n\n' +
          'Sistema de pesquisa em tempo real com analise inteligente usando Ollama.\n\n' +
          'Comandos disponiveis:\n' +
          '• /google <termo> - Busca normal\n' +
          '• /deepsearch <termo> - Busca profunda com IA\n' +
          '• /analisar <numero> - Analisa fonte especifica\n' +
          '• /relatorio - Relatorio consolidado\n' +
          '• /glista - Lista todos os resultados\n' +
          '• /gopen <numero> - Abre resultado\n' +
          '• /gcopy <numero> - Copia link\n' +
          '• /glimpar - Limpa pesquisa',
    buttons: () => [
      [{ text: 'Busca Normal', callback_data: 'web_google' }],
      [{ text: 'Busca Profunda (IA)', callback_data: 'web_deepsearch' }],
      [{ text: 'Analisar Fonte', callback_data: 'web_analisar' }],
      [{ text: 'Relatorio IA', callback_data: 'web_relatorio' }],
      [{ text: 'Listar Resultados', callback_data: 'web_glista' }],
      [{ text: 'Limpar Pesquisa', callback_data: 'web_glimpar' }],
      [{ text: 'Voltar', callback_data: 'menu_main' }, { text: 'Fechar', callback_data: 'close' }],
    ]
  },
  consultas: {
    text: (userId) => {
      return (
        'Menu de Consultas\n\n' +
        'Aqui no Telegram voce dispara a consulta pelo botao ou por comando:\n' +
        '/cpf  /nome  /menu_consultas\n\n' +
        'Escolha uma categoria:'
      );
    },
    buttons: () => {
      const btns = [];
      for (const [key, cat] of Object.entries(CATEGORIES)) {
        btns.push([{ text: cat.label, callback_data: `consulta_cat_${key}` }]);
      }
      btns.push([{ text: 'Voltar', callback_data: 'menu_main' }, { text: 'Fechar', callback_data: 'close' }]);
      return btns;
    }
  },
  divulgacao: {
    text: (userId) => divulgacaoTelegramUi.homeText(userId),
    buttons: (userId) => divulgacaoTelegramUi.homeButtons(userId)
  },
  div_slots: {
    text: (userId) => {
      if (!isAdmin(userId)) return 'Padroes so para ADMIN.';
      const config = getDivConfig(userId);
      return (
        formatSlotsSummary(config, userId) +
        '\n\nUm menu: editar · midia · enviar · auto · texto · tempo.\n' +
        'Editar grava no slot ativo (*). Cada sessao tem o proprio JSON — nao mistura com outro user.'
      );
    },
    buttons: (userId) => {
      if (!isAdmin(userId)) {
        return [[{ text: 'Voltar', callback_data: 'menu_divulgacao' }]];
      }
      const rows = [];
      for (const track of ['cta', 'status']) {
        const label = track === 'cta' ? 'CTA' : 'Status';
        for (const id of SLOT_IDS) {
          rows.push([
            { text: `${label}#${id} editar`, callback_data: `div_slot_set_${track}_${id}` },
            { text: `${label}#${id} midia`, callback_data: `div_slot_midia_${track}_${id}` }
          ]);
          rows.push([
            { text: `${label}#${id} enviar`, callback_data: `div_slot_send_${track}_${id}` },
            { text: `${label}#${id} auto`, callback_data: `div_slot_auto_${track}_${id}` }
          ]);
          rows.push([
            { text: `${label}#${id} texto`, callback_data: `div_slot_text_${track}_${id}` },
            { text: `${label}#${id} tempo`, callback_data: `div_slot_int_${track}_${id}` }
          ]);
        }
      }
      rows.push([{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }]);
      return rows;
    }
  },
  div_slot_track: {
    text: (payload) => {
      const userId = payload?.userId;
      if (!isAdmin(userId)) return 'Padroes so para ADMIN.';
      const config = getDivConfig(userId);
      return (
        'CTA + Status (padroes ADM)\n\n' +
        formatSlotsSummary(config, userId) +
        '\n\nUse o menu unico — nao ha submenu por trilha.'
      );
    },
    buttons: () => [
      [{ text: 'Abrir padroes', callback_data: 'div_slots' }],
      [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }]
    ]
  },
  div_config_msg: {
    text: (userId) => {
      const config = getDivConfig(userId);
      const configured = config.configurado ? 'Configurado' : 'Nao configurado';
      const hasMedia = config.midia ? 'Sim' : 'Nao';
      
      let t = 'Configurar Mensagem\n\n';
      t += `Status: ${configured}\n`;
      t += `Midia: ${hasMedia}\n`;
      t += `Texto: ${config.texto ? config.texto.substring(0, 50) + '...' : 'Nenhum'}\n\n`;
      t += 'Escolha uma opcao:';
      return t;
    },
    buttons: () => [
      [{ text: 'Definir Texto', callback_data: 'div_set_text' }],
      [{ text: 'Enviar Imagem', callback_data: 'div_send_image' }],
      [{ text: 'Enviar Video', callback_data: 'div_send_video' }],
      [{ text: 'Enviar GIF', callback_data: 'div_send_gif' }],
      [{ text: 'Enviar Audio', callback_data: 'div_send_audio' }],
      [{ text: 'Enviar Documento', callback_data: 'div_send_doc' }],
      [{ text: 'Limpar Midia', callback_data: 'div_clear_media' }],
      [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }],
    ]
  },
  div_config_grupos: {
    text: (userId) => {
      const grupos = getGruposParaDivulgar(userId);
      const gruposList = grupos.grupos || [];
      
      let t = 'Grupos de divulgacao\n\n';
      t += `Na lista: ${gruposList.length}\n\n`;
      t += 'So estes grupos recebem a divulgacao.\n';
      t += 'No Telegram: /addgrupo (ou /addgrupo off) no grupo do WhatsApp, depois de parear.\n\n';
      t += 'Escolha uma opcao:';
      return t;
    },
    buttons: () => [
      [{ text: 'Gerenciar Grupos', callback_data: 'gm_home' }],
      [{ text: 'Limpar Lista', callback_data: 'div_limpar_grupos' }],
      [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }],
    ]
  },
  div_config_auto: {
    text: (userId) => {
      const config = getDivConfig(userId);
      const { formatAutoSummary } = require('./utils/divulgacaoAuto');
      return 'Divulgacao automatica\n\n' + formatAutoSummary(config) + '\n\nEscolha:';
    },
    buttons: (userId) => {
      const config = getDivConfig(userId);
      const autoOn = !!config.autoEnabled;
      const msgsOn = config.autoMsgEnabled === true;
      return [
        [{ text: autoOn ? 'Auto ON (desligar)' : 'Auto OFF (ligar)', callback_data: autoOn ? 'div_tg_auto_off' : 'div_tg_auto_on' }],
        [{ text: 'Tempo 2h', callback_data: 'div_tg_int_120' }, { text: '3h', callback_data: 'div_tg_int_180' }, { text: '6h', callback_data: 'div_tg_int_360' }],
        [{ text: '12h', callback_data: 'div_tg_int_720' }, { text: '24h', callback_data: 'div_tg_int_1440' }, { text: '30 min', callback_data: 'div_tg_int_30' }],
        [{ text: 'Aleatorio 1-2h', callback_data: 'div_tg_rand_60_120' }, { text: '2-4h', callback_data: 'div_tg_rand_120_240' }],
        [{ text: msgsOn ? 'Msgs ON (desligar)' : 'Msgs OFF (ligar)', callback_data: msgsOn ? 'div_tg_msgs_off' : 'div_tg_msgs_on' }],
        [{ text: 'A cada 25', callback_data: 'div_tg_msgs_25' }, { text: '50', callback_data: 'div_tg_msgs_50' }, { text: '100', callback_data: 'div_tg_msgs_100' }],
        [{ text: 'Minimo 15 min', callback_data: 'div_tg_mingap_15' }, { text: '30 min', callback_data: 'div_tg_mingap_30' }],
        [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }]
      ];
    }
  },
  div_config_opts: {
    text: (userId) => {
      const config = getDivConfig(userId);
      
      let t = 'Configurar Opcoes\n\n';
      t += `Quantidade: ${config.quantidade}x\n`;
      t += `Delay Mensagens: ${config.delayMsg}ms\n`;
      t += `Delay Grupos: ${config.delayGrupo}ms\n`;
      t += `Repetir: ${config.repetir ? 'Sim' : 'Nao'}\n`;
      t += `Ordem: ${config.ordem || 'sequencial'}\n\n`;
      t += 'Escolha uma opcao:';
      return t;
    },
    buttons: () => [
      [{ text: 'Quantidade', callback_data: 'div_set_qtd' }],
      [{ text: 'Delay Mensagens', callback_data: 'div_set_delay_msg' }],
      [{ text: 'Delay Grupos', callback_data: 'div_set_delay_grupo' }],
      [{ text: 'Repetir', callback_data: 'div_toggle_repetir' }],
      [{ text: 'Ordem', callback_data: 'div_set_ordem' }],
      [{ text: 'Voltar', callback_data: 'menu_divulgacao' }, { text: 'Fechar', callback_data: 'close' }],
    ]
  }
};

Object.assign(MENUS, divulgacaoTelegramUi.extraMenus);

async function showMenu(chatId, menuName, userId, extraData = null) {
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;

  const menu = MENUS[menuName];
  if (!menu) {
    await bot.sendMessage(chatId, '❌ Menu nao encontrado.');
    return;
  }

  let text = typeof menu.text === 'function' ? menu.text(extraData || userId) : menu.text;
  if (text && typeof text.then === 'function') text = await text;
  const buttons = typeof menu.buttons === 'function' ? menu.buttons(extraData || userId) : menu.buttons;

  await sendMenuWithImage(chatId, text, buttons);
}

// ========== HANDLER DE CALLBACK ==========
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  if (!msg) {
    logger.logAviso('[TELEGRAM] Callback sem mensagem');
    return;
  }
  const chatId = msg.chat.id;
  const userId = callbackQuery.from.id;
  if (tgDropIfOwnerOnly(userId)) {
    try { await safeAnswerCallback(callbackQuery.id); } catch (_) {}
    return;
  }
  const username = callbackQuery.from.username || callbackQuery.from.first_name || 'sem nome';
  const data = callbackQuery.data;

  logger.logInfo(`[TELEGRAM] Callback recebido: ${data} de ${username} (${userId})`);
  logger.logBotao('TELEGRAM_CALLBACK', data, username);

  // Responde imediatamente para evitar timeout
  await safeAnswerCallback(callbackQuery.id);

  try {

  // Verificar banimento
  if (isBanned(userId)) {
    await bot.sendMessage(chatId, '🚫 <b>Voce esta banido do bot.</b>', { parse_mode: 'HTML' });
    return;
  }

  // ---- Botao de copiar Pairing Code ----
  if (data && data.startsWith('copy_pairing_')) {
    const code = data.replace('copy_pairing_', '');
    await bot.sendMessage(chatId, `📋 <b>Codigo:</b> <code>${code}</code>`, { parse_mode: 'HTML' });
    return;
  }

  if (data === 'check_channel') {
    try {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Checando canal...' });
    } catch (_) { /* ignore */ }
    const follows = await ensureChannelFollow(chatId, userId, { force: true });
    if (follows) {
      try {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Canal ok' });
      } catch (_) { /* ignore */ }
      await showMenu(chatId, 'main', userId);
    }
    return;
  }

  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) {
    return;
  }

  // Nuke / grupos: dono da sessao. DIV: dono ou pagante (editar sem chip; disparo exige sessao).
  if (
    data === 'menu_nuke' ||
    data === 'menu_grupos' ||
    String(data).startsWith('nuke_') ||
    String(data).startsWith('gm_')
  ) {
    if (tgDenyUnlessOwner(userId, data)) return;
  }
  if (data === 'menu_divulgacao' || String(data).startsWith('div_')) {
    if (!tgCanUseDivMenu(userId)) {
      console.log(`[AUTH_SILENT] TG btn=${data} user=${userId} | div/vip obrigatorio`);
      return;
    }
  }

  if (await divulgacaoTelegramUi.handleCallback({
    bot,
    chatId,
    userId,
    data,
    showMenu,
    pendingTgCmds,
    downloadTelegramFileBuffer,
    getCommand,
    resolveLiveSession,
    liveSessionErrorMessage,
    selfJidFromConn,
    logger,
    sendMenuWithImage
  })) return;

  // ===== NAVEGAÇÃO =====
  if (data === 'menu_main') {
    await showMenu(chatId, 'main', userId);
    return;
  }
  if (data === 'menu_mais') {
    await showMenu(chatId, 'mais', userId);
    return;
  }
  if (data === 'menu_sessions') {
    await showMenu(chatId, 'sessions', userId);
    return;
  }
  if (data === 'menu_admin') {
    if (!isAdmin(userId)) {
      return;
    }
    await showMenu(chatId, 'admin', userId);
    return;
  }
  {
    const roleHit = String(data || '').match(/^(menu_dono|menu_adm)(?:_p(\d+))?$/);
    if (roleHit) {
      const kind = roleHit[1] === 'menu_dono' ? 'dono' : 'adm';
      const page = Number(roleHit[2] || 0) || 0;
      const role = telegramMenuRole(userId);
      const isOwner = role === 'owner' || role === 'platform_admin' || isAdmin(userId);
      if (kind === 'dono' && !isOwner) return;
      if (kind === 'adm' && !isOwner && role !== 'vip') return;
      try {
        const { tgPayload } = require('./utils/roleMenus');
        const payload = tgPayload(kind, userId, page);
        await sendMenuWithImage(chatId, payload.text, payload.keyboard);
      } catch (e) {
        await notify(chatId, `Nao abri o menu: ${String(e.message || e).slice(0, 80)}`);
      }
      return;
    }
  }
  if (data === 'menu_help') {
    await showMenu(chatId, 'help', userId);
    return;
  }

  if (data === 'menu_antiflood') {
    await showMenu(chatId, 'antiflood', userId);
    return;
  }
  if (data === 'menu_botoes') {
    await showMenu(chatId, 'botoes', userId);
    return;
  }
  if (data === 'menu_nuke') {
    if (tgDenyUnlessOwner(userId, data)) return;
    await showMenu(chatId, 'nuke', userId);
    return;
  }

  if (data === 'shop_later') {
    await bot.sendMessage(chatId, 'Quando quiser: menu → Proteger grupo.');
    return;
  }
  if (data === 'shop_protect') {
    const res = await fetchUserWaGroups(userId);
    if (res.error) {
      await bot.sendMessage(chatId, res.error);
      return;
    }
    if (!res.groups.length) {
      await bot.sendMessage(
        chatId,
        'Ainda nao estou em nenhum grupo.\nMe adiciona no grupo da loja (como admin) e toca Proteger grupo de novo.'
      );
      return;
    }
    await bot.sendMessage(
      chatId,
      'Qual grupo e a loja? (eu preciso ser admin la)',
      { reply_markup: sanitizeReplyMarkup({ inline_keyboard: groupPickKeyboard(userId, 'shop_g_') }) }
    );
    return;
  }
  if (data.startsWith('shop_g_')) {
    const idx = parseInt(data.slice(7), 10);
    const cached = tgGroupPickCache.get(String(userId));
    const g = cached && Date.now() <= cached.expires ? cached.groups?.[idx] : null;
    if (!g) {
      await bot.sendMessage(chatId, 'Selecao expirou. Toque em Proteger grupo de novo.');
      return;
    }
    try {
      const { applyProtectionPreset } = require('./utils/protectionStore');
      const r = await applyProtectionPreset(g.id, 'loja', String(userId), String(userId));
      if (!r.ok) {
        await bot.sendMessage(chatId, r.message || 'Nao deu pra aplicar a protecao.');
        return;
      }
      await bot.sendMessage(
        chatId,
        `Pronto. Preset loja ligado em ${g.subject}.\nAntilink e anti-roubo ativos.\nConfirma que eu sou admin no grupo — senao nao apago link.`
      );
    } catch (e) {
      await bot.sendMessage(chatId, `Falha ao proteger: ${e.message}`);
    }
    return;
  }

  // Anti-flood actions
  if (data === 'af_list') {
    const { listGroupsWithFlag } = require('./utils/protectionStore');
    const list = listGroupsWithFlag(userId, 'antiflood');
    await bot.sendMessage(
      chatId,
      list.length
        ? `Grupos com anti-flood ATIVO (${list.length}):\n\n${list.join('\n')}`
        : 'Nenhum grupo com anti-flood ativo.'
    );
    return;
  }
  if (data === 'af_pick_on' || data === 'af_pick_off') {
    const res = await fetchUserWaGroups(userId);
    if (res.error) {
      await bot.sendMessage(chatId, res.error);
      return;
    }
    if (!res.groups.length) {
      await bot.sendMessage(chatId, 'Nenhum grupo encontrado na sessao WhatsApp.');
      return;
    }
    const prefix = data === 'af_pick_on' ? 'af_on_' : 'af_off_';
    await bot.sendMessage(
      chatId,
      data === 'af_pick_on' ? 'Escolha o grupo para ATIVAR anti-flood:' : 'Escolha o grupo para DESATIVAR anti-flood:',
      { reply_markup: sanitizeReplyMarkup({ inline_keyboard: groupPickKeyboard(userId, prefix) }) }
    );
    return;
  }
  if (data.startsWith('af_on_') || data.startsWith('af_off_')) {
    const on = data.startsWith('af_on_');
    const idx = parseInt(data.replace(on ? 'af_on_' : 'af_off_', ''), 10);
    const cached = tgGroupPickCache.get(String(userId));
    const g = cached?.groups?.[idx];
    if (!g) {
      await bot.sendMessage(chatId, 'Selecao expirada. Abra o menu Anti-flood de novo.');
      return;
    }
    const { setGroupSecurityFlag } = require('./utils/moderation');
    await setGroupSecurityFlag(g.id, userId, 'antiflood', on, String(userId));
    await bot.sendMessage(chatId, `Anti-flood ${on ? 'ATIVADO' : 'DESATIVADO'} em:\n${g.subject}\n${g.id}`);
    await showMenu(chatId, 'antiflood', userId);
    return;
  }

  // Nuke actions
  if (data === 'nuke_show_cfg') {
    if (tgDenyUnlessOwner(userId, data)) return;
    try {
      const { getNukeConfig } = require('./utils/configManager');
      const c = getNukeConfig(userId) || {};
      await bot.sendMessage(
        chatId,
        `NUKE CONFIG\n\n` +
        `Nome: ${c.groupName || '(padrao)'}\n` +
        `Desc: ${c.groupDesc || '(padrao)'}\n` +
        `Msg: ${c.groupMessage || '(padrao)'}\n` +
        `Foto: ${c.groupImage ? 'definida' : 'nao'}\n\n` +
        `No Telegram:\n` +
        `/nukename <nome>\n` +
        `/nukedesc <texto>\n` +
        `/nukemsg <texto>\n` +
        `/nukeimg (depois envie a foto)\n` +
        `/nukereset`
      );
    } catch (e) {
      await bot.sendMessage(chatId, `Erro ao ler config: ${e.message}`);
    }
    return;
  }
  if (data === 'nuke_reset_cfg') {
    if (tgDenyUnlessOwner(userId, data)) return;
    try {
      const { setNukeConfig, defaultNukeConfig } = require('./utils/configManager');
      setNukeConfig(userId, defaultNukeConfig());
      await bot.sendMessage(chatId, 'Nuke config resetada para o padrao.');
    } catch (e) {
      await bot.sendMessage(chatId, `Erro ao resetar: ${e.message}`);
    }
    return;
  }
  if (data === 'nuke_pick_run') {
    if (tgDenyUnlessOwner(userId, data)) return;
    await startNukeGroupPick(userId, chatId);
    return;
  }
  if (data.startsWith('nuke_run_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    const idx = parseInt(data.replace('nuke_run_', ''), 10);
    const cached = tgGroupPickCache.get(String(userId));
    const g = cached?.groups?.[idx];
    if (!g) {
      await bot.sendMessage(chatId, 'Selecao expirada. Abra o menu Nuke de novo.');
      return;
    }
    await runWaCmdInGroup(userId, chatId, 'nuke', g.id, '');
    return;
  }

  // Catalogo WA nao e menu do Telegram
  if (data && data.startsWith('tg_cat_')) {
    await bot.sendMessage(
      chatId,
      'Comandos de grupo/Zap ficam no WhatsApp.\nAqui no Telegram: /comprar e depois Conectar.'
    );
    return;
  }
  if (data && data.startsWith('tg_cmd_')) {
    const cmdName = data.replace('tg_cmd_', '');
    await handleTgCmdClick(userId, chatId, cmdName);
    return;
  }
  if (data && data.startsWith('bill_')) {
    try {
      const { handleTelegramBilling } = require('./commands/billing');
      await handleTelegramBilling(bot, { chatId, userId, data });
    } catch (e) {
      logger.logAviso(`[TG] billing: ${e.message}`);
      await bot.sendMessage(chatId, 'Nao consegui abrir o pagamento agora. Tente /comprar');
    }
    return;
  }

  if (data === 'close') {
    try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
    if (menuMessages[String(chatId)]?.messageId === msg.message_id) {
      delete menuMessages[String(chatId)];
    }
    return;
  }
  if (data === 'admin_config') {
    await showMenu(chatId, 'admin_config', userId);
    return;
  }
  if (data === 'config_owners') {
    await showMenu(chatId, 'config_owners', userId);
    return;
  }
  if (data === 'config_vips') {
    await showMenu(chatId, 'config_vips', userId);
    return;
  }
  if (data === 'config_blacklist') {
    await showMenu(chatId, 'config_blacklist', userId);
    return;
  }
  if (data === 'menu_exploits' || data === 'menu_travas' ||
      data === 'exploits_individuais' || data === 'exploits_grupo' ||
      data === 'exploits_interativo' || data === 'exploits_legados') {
    console.log(`[AUTH_SILENT] TG exploits removido btn=${data} user=${userId}`);
    return;
  }
  if (data === 'menu_host' || data === 'menu_raikken') {
    await notify(
      chatId,
      'HOST RAIKKEN\n\nNeste chat:\n' +
        applyLivePrefix('{p}host — menu\n{p}hoststatus\n{p}hostrestart\n{p}hostconsole\n{p}hostls\n{p}hostbackups', '/')
    );
    return;
  }

  // ===== AÇÕES DE CONFIGURAÇÃO (solicitar entrada) =====
  if (data === 'add_owner' || data === 'remove_owner' ||
      data === 'add_vip' || data === 'remove_vip' ||
      data === 'add_blacklist' || data === 'remove_blacklist') {
    const actionMap = {
      'add_owner': { cmd: 'addowner', label: 'dono' },
      'remove_owner': { cmd: 'removeowner', label: 'dono' },
      'add_vip': { cmd: 'addvip', label: 'VIP' },
      'remove_vip': { cmd: 'removevip', label: 'VIP' },
      'add_blacklist': { cmd: 'addblacklist', label: 'blacklist' },
      'remove_blacklist': { cmd: 'removeblacklist', label: 'blacklist' },
    };
    const action = actionMap[data];
    if (!action) return;
    pendingPairPhone.delete(String(userId));
    pendingConfigAction.set(String(userId), {
      cmd: action.cmd,
      chatId: String(chatId),
      expires: Date.now() + 3 * 60 * 1000
    });
    await notify(
      chatId,
      `Manda o numero agora (qualquer formato):\n` +
        `<code>+55 41 99214-2464</code>\n` +
        `<code>(41) 99214-2464</code>\n` +
        `<code>41992142464</code>\n\n` +
        `Ou usa /${action.cmd} e o numero na mesma linha.`
    );
    return;
  }

  if (data === 'config_prefix') {
    await notify(
      chatId,
      `${formatPrefixStatus(userId)}\n\n` +
      `Trocar no Telegram: /setprefix &lt;novo&gt; (max 2 chars)\n` +
      `No WhatsApp: use o prefixo da sessao + setprefix (ex: no Telegram /setprefix .)\n` +
      `Aceita ponto, barra, asterisco, numero, letra.\n` +
      `Ex: /setprefix !   /setprefix *   /setprefix /\n\n` +
      `Neste chat do Telegram o comando continua sempre com /.`
    );
    return;
  }

  // ===== CONNECT =====
  if (data === 'connect') {
    if (!canCreateSession()) {
      await notify(chatId, 'Limite de sessoes atingido. Apague uma sessao antes de parear.');
      return;
    }
    try {
      const ram = require('./utils/memoryWatch').pairBlockReason();
      if (ram) {
        await notify(chatId, ram);
        return;
      }
    } catch (_) { /* ignore */ }
    const existingUserSessions = getUserSessions(userId);
    if (existingUserSessions.length > 0) {
      const existingId = existingUserSessions[0].sessionId;
      await sendMenuWithImage(chatId,
        '⚠️ <b>Voce ja possui uma sessao.</b>\n\nCada usuario pode ter apenas 1 sessao WhatsApp por vez. Para conectar um novo numero, apague a sessao atual primeiro.',
        [
          [{ text: '📱 Ver sessao atual', callback_data: `session_${existingId}` }],
          [{ text: '🗑️ Apagar e criar nova', callback_data: `replace_session_${existingId}` }],
          [{ text: '🔙 Cancelar', callback_data: 'menu_main' }],
        ]
      );
      return;
    }
    await clearStatus(chatId);
    await sendMenuWithImage(chatId, '🔗 Escolha o metodo de conexao:', [
      [{ text: '🔢 Pairing Code', callback_data: 'method_pairing' }],
      [{ text: '📷 QR Code', callback_data: 'method_qr' }],
      [{ text: '🔙 Voltar', callback_data: 'menu_main' }],
    ]);
    return;
  }

  // ===== MÉTODOS DE CONEXÃO =====
  if (data === 'method_pairing' || data === 'method_qr') {
    try {
      const ram = require('./utils/memoryWatch').pairBlockReason();
      if (ram) {
        await notify(chatId, ram);
        return;
      }
    } catch (_) { /* ignore */ }
    const method = data === 'method_pairing' ? 'pairing' : 'qr';
    await clearStatus(chatId);
    pendingPairPhone.set(String(userId), {
      method,
      chatId,
      expires: Date.now() + 5 * 60 * 1000
    });
    await bot.sendMessage(
      chatId,
      `Digite seu numero com DDD (ex: 5511999999999) para ${method === 'pairing' ? 'Pairing Code' : 'QR Code'}.\n\n` +
        `So digite o numero — nao e consulta.`
    );
    return;
  }

  // ===== SESSÃO ESPECÍFICA =====
  if (data.startsWith('session_')) {
    const sessionId = data.replace('session_', '');
    await showMenu(chatId, 'session_detail', userId, sessionId);
    return;
  }

  // ===== AÇÕES DA SESSÃO =====
  if (data.startsWith('disconnect_')) {
    const sessionId = data.replace('disconnect_', '');
    if (!canAccessSession(userId, sessionId) && !isAdmin(userId)) {
      return;
    }
    const conn = activeConnections.get(sessionId);
    if (conn) {
      try {
        if (typeof conn.end === 'function') await conn.end();
        activeConnections.delete(sessionId);
        updateSessionStatus(sessionId, 'disconnected');
        await safeAnswerCallback(callbackQuery.id, { text: '✅ Desconectada.' });
        logger.logSucesso(`[TELEGRAM] Sessao ${sessionId} desconectada por ${username} (${userId})`);
        return showMenu(chatId, 'session_detail', userId, sessionId);
      } catch (e) {
        await safeAnswerCallback(callbackQuery.id, { text: `❌ Erro: ${e.message}`, show_alert: true });
        logger.logErro('TELEGRAM_disconnect', e.message);
      }
    } else {
      await safeAnswerCallback(callbackQuery.id, { text: 'ℹ️ Sessao nao esta ativa.' });
    }
    return;
  }

  if (data.startsWith('reconnect_')) {
    const sessionId = data.replace('reconnect_', '');
    if (!canAccessSession(userId, sessionId) && !isAdmin(userId)) {
      await safeAnswerCallback(callbackQuery.id, { text: '🚫 Permissao negada.', show_alert: true });
      return;
    }
    const session = getSession(sessionId);
    if (!session) {
      await safeAnswerCallback(callbackQuery.id, { text: '❌ Sessao nao encontrada.', show_alert: true });
      return;
    }
    const oldConn = activeConnections.get(sessionId);
    if (oldConn) {
      try { if (typeof oldConn.end === 'function') await oldConn.end(); } catch {}
      activeConnections.delete(sessionId);
    }
    try {
      const { cancelSessionReconnect } = require('./connection');
      cancelSessionReconnect(sessionId);
    } catch (_) { /* ignore */ }
    updateSessionStatus(sessionId, 'connecting', {
      needsRepair: false,
      lastError: null,
      reconnectAttempts: 0
    });
    await safeAnswerCallback(callbackQuery.id, { text: '🔄 Reconectando...' });
    logger.logInfo(`[TELEGRAM] Reconectando sessao ${sessionId} para ${username} (${userId})`);
    // 'telegram' = restore por creds (nao pede pairing/QR de novo)
    await startWhatsAppSession(session.telegramUserId, sessionId, chatId, 'telegram');
    setTimeout(() => showMenu(chatId, 'session_detail', userId, sessionId), 3000);
    return;
  }

  if (data.startsWith('delete_')) {
    const sessionId = data.replace('delete_', '');
    if (!canAccessSession(userId, sessionId) && !isAdmin(userId)) {
      await safeAnswerCallback(callbackQuery.id, { text: '🚫 Permissao negada.', show_alert: true });
      return;
    }
    try {
      // Primeiro desconectar se houver conexão ativa
      const oldConn = activeConnections.get(sessionId);
      if (oldConn) {
        try { if (typeof oldConn.end === 'function') await oldConn.end(); } catch (err) {
          logger.logAviso(`[TELEGRAM] Erro ao desconectar ao deletar: ${err.message}`);
        }
        activeConnections.delete(sessionId);
      }
      
      // Deletar sessão
      deleteSession(sessionId);
      try { clearForwardMode(sessionId); } catch (_) { /* ignore */ }
      await safeAnswerCallback(callbackQuery.id, { text: '✅ Removida.' });
      logger.logSucesso(`[TELEGRAM] Sessao ${sessionId} removida por ${username} (${userId})`);
      return showMenu(chatId, 'sessions', userId);
    } catch (e) {
      await safeAnswerCallback(callbackQuery.id, { text: `❌ Erro: ${e.message}`, show_alert: true });
      logger.logErro('TELEGRAM_delete', e.message);
    }
    return;
  }

  if (data.startsWith('toggle_buttons_')) {
    const sessionId = data.replace('toggle_buttons_', '');
    if (!canAccessSession(userId, sessionId) && !isAdmin(userId)) {
      await safeAnswerCallback(callbackQuery.id, { text: '🚫 Permissao negada.', show_alert: true });
      return;
    }
    try {
      const newMode = syncButtonsMode(userId, !areButtonsOn(sessionId, userId), sessionId);
      const modeText = newMode ? "ON (com botoes)" : "OFF (encaminhada de canal)";
      await safeAnswerCallback(callbackQuery.id, { text: `Modo alterado: ${modeText}` });
      logger.logInfo(`[TELEGRAM] Modo de botoes alterado para ${sessionId}: ${modeText} por ${username}`);
      // Volta pro painel Botoes (atalho) se existir; senao detalhe da sessao
      try {
        await showMenu(chatId, 'botoes', userId);
      } catch (_) {
        await showMenu(chatId, 'session_detail', userId, sessionId);
      }
      return;
    } catch (e) {
      await safeAnswerCallback(callbackQuery.id, { text: `❌ Erro: ${e.message}`, show_alert: true });
      logger.logErro('TELEGRAM_toggle_buttons', e.message);
    }
    return;
  }

  if (data.startsWith('replace_session_')) {
    const sessionId = data.replace('replace_session_', '');
    if (!canAccessSession(userId, sessionId) && !isAdmin(userId)) {
      await safeAnswerCallback(callbackQuery.id, { text: '🚫 Permissao negada.', show_alert: true });
      return;
    }
    try {
      const oldConn = activeConnections.get(sessionId);
      if (oldConn) {
        try { if (typeof oldConn.end === 'function') await oldConn.end(); } catch {}
        activeConnections.delete(sessionId);
      }
      try {
        const { cancelSessionReconnect } = require('./connection');
        cancelSessionReconnect(sessionId);
      } catch (_) { /* ignore */ }
      deleteSession(sessionId);
      try { clearForwardMode(sessionId); } catch (_) { /* ignore */ }
      logger.logSucesso(`[TELEGRAM] Sessao ${sessionId} apagada para substituição por ${username} (${userId})`);
      await sendMenuWithImage(chatId, '✅ Sessao anterior apagada.\n\n🔗 Escolha o metodo de conexao:', [
        [{ text: '🔢 Pairing Code', callback_data: 'method_pairing' }],
        [{ text: '📷 QR Code', callback_data: 'method_qr' }],
        [{ text: '🔙 Voltar', callback_data: 'menu_main' }],
      ]);
      } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (/n[aã]o encontrada/i.test(msg)) {
        logger.logAviso(`TELEGRAM_replace_session: ${msg}`);
        try {
          await sendMenuWithImage(chatId, 'Sessao ja nao existia. Escolha o metodo:', [
            [{ text: 'Pairing Code', callback_data: 'method_pairing' }],
            [{ text: 'QR Code', callback_data: 'method_qr' }],
            [{ text: 'Voltar', callback_data: 'menu_main' }],
          ]);
        } catch (_) {}
      } else {
        logger.logErro('TELEGRAM_replace_session', msg);
      }
    }
    return;
  }

  if (data.startsWith('copy_')) {
    const sessionId = data.replace('copy_', '');
    await bot.sendMessage(chatId, `📋 <b>ID da sessao:</b> <code>${sessionId}</code>`, { parse_mode: 'HTML' });
    return;
  }

  if (data.startsWith('status_')) {
    const sessionId = data.replace('status_', '');
    const s = getSession(sessionId);
    if (!s) {
      return;
    }
    await notify(chatId, `📊 <b>Status da Sessao</b>\n\n${formatSession(s, true)}`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Voltar', callback_data: `session_${sessionId}` }, { text: '❌ Fechar', callback_data: 'close' }]] }
    });
    return;
  }

  // ===== ADMIN =====
  if (data === 'admin_stats' || data === 'admin_ops') {
    if (!isAdmin(userId)) return;
    await showMenu(chatId, 'admin_ops', userId);
    return;
  }
  if (data === 'admin_vips') {
    if (!isAdmin(userId)) return;
    await showMenu(chatId, 'admin_vips', userId);
    return;
  }
  if (data === 'admin_sales') {
    if (!isAdmin(userId)) return;
    await showMenu(chatId, 'admin_sales', userId);
    return;
  }
  if (data === 'admin_pix') {
    if (!isAdmin(userId)) return;
    await showMenu(chatId, 'admin_pix', userId);
    return;
  }
  if (data === 'admin_health') {
    if (!isAdmin(userId)) return;
    await showMenu(chatId, 'admin_health', userId);
    return;
  }
  if (data === 'admin_prot') {
    if (!isAdmin(userId)) return;
    await showMenu(chatId, 'admin_prot', userId);
    return;
  }
  if (data === 'admin_list_all') {
    if (!isAdmin(userId)) return;
    await showMenu(chatId, 'admin_list_all', userId);
    return;
  }
  if (data === 'admin_list_users') {
    const all = getAllSessions();
    const users = {};
    all.forEach(s => {
      if (!users[s.telegramUserId]) users[s.telegramUserId] = [];
      users[s.telegramUserId].push(s);
    });
    let text = '👥 <b>Usuarios e sessoes</b>\n\n';
    for (const [uid, sessions] of Object.entries(users)) {
      const meta = getUserMetadata(uid);
      text += `👤 ${uid} (${meta.role}) – ${sessions.length} sessao(oes)\n`;
      sessions.forEach(s => {
        text += `   ${getStatusIcon(s.status)} ${s.phone || s.sessionId.slice(0,8)}\n`;
      });
      text += '\n';
    }
    await notify(chatId, text, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Voltar', callback_data: 'menu_admin' }, { text: '❌ Fechar', callback_data: 'close' }]] }
    });
    return;
  }

  if (data === 'admin_reconnect_all') {
    if (!isAdmin(userId)) {
      return;
    }
    const all = getAllSessions();
    let count = 0;
    
    // CORREÇÃO: Só notificar sobre reconexão se não estiver em cooldown
    if (shouldNotifyConnection(userId, 'reconnect_all')) {
      await updateStatus(chatId, `🔄 Reconectando todas as sessoes... (${all.length} encontradas)`);
    } else {
      logger.logInfo(`[TELEGRAM] Notificação de reconexão ignorada (cooldown)`);
    }
    
    for (const s of all) {
      if (s.status === 'connected' || s.status === 'connecting') continue;
      try {
        const conn = await connect({
          sessionId: s.sessionId,
          telegramUserId: s.telegramUserId,
          connectionMethod: 'telegram',
        });
        if (conn) {
          activeConnections.set(s.sessionId, conn);
          setupHandlers(conn, s.sessionId, s.telegramUserId);
          setupEventListeners(conn, s.sessionId, s.telegramUserId);
          updateSessionStatus(s.sessionId, 'connected');
          count++;
        }
      } catch (e) {
        logger.logErro(`ReconnectAll ${s.sessionId}`, e.message);
      }
    }
    
    // CORREÇÃO: Só notificar conclusão se não estiver em cooldown
    if (shouldNotifyConnection(userId, 'reconnect_complete')) {
      await updateStatus(chatId, `✅ Reconexao concluida: ${count} sessoes reconectadas.`);
    } else {
      logger.logInfo(`[TELEGRAM] Notificação de conclusão ignorada (cooldown)`);
    }
    
    setTimeout(() => showMenu(chatId, 'admin', userId), 2000);
    return;
  }

  // ===== CONSULTAS =====
  if (data === 'menu_consultas') {
    await showMenu(chatId, 'consultas', userId);
    return;
  }

  // ===== DOWNLOADS =====
  if (data === 'menu_downloads_tg') {
    await bot.sendMessage(chatId, formatReportBlock('DOWNLOADS', [
      labelValue('play', '/play <musica ou link YT>'),
      labelValue('tiktok', '/tiktok <link>'),
      labelValue('instagram', '/instagram <link>'),
      labelValue('ytsearch', '/ytsearch <termo>'),
      labelValue('menu', '/download'),
      '',
      'Neste chat: /play /tiktok /instagram /download'
    ]), {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Voltar', callback_data: 'menu_main' }]
        ]
      }
    });
    return;
  }

  // ===== WEB INTELLIGENCE =====
  if (data === 'menu_webintelligence') {
    await showMenu(chatId, 'webintelligence', userId);
    return;
  }

  if (data === 'web_google') {
    pendingTgCmds.set(String(userId), {
      cmd: '__web_google__',
      chatId,
      native: true,
      expires: Date.now() + 5 * 60 * 1000
    });
    await bot.sendMessage(chatId, 'Digite o termo para busca:');
    return;
  }

  if (data === 'web_deepsearch') {
    pendingTgCmds.set(String(userId), {
      cmd: '__web_deep__',
      chatId,
      native: true,
      expires: Date.now() + 5 * 60 * 1000
    });
    await bot.sendMessage(chatId, 'Digite o termo para deepsearch:');
    return;
  }

  if (data === 'web_analisar') {
    await bot.sendMessage(chatId, 'Digite o numero da fonte para analisar:');
    const analisarHandler = async (analisarMsg) => {
      bot.removeListener('message', analisarHandler);
      const num = parseInt(analisarMsg.text.trim());
      if (!num) return;
      try {
        await bot.sendChatAction(chatId, 'typing');
        const result = await analyzeSpecific(userId, num);
        if (result.error) {
          await bot.sendMessage(chatId, result.error);
          return;
        }
        let text = `🤖 <b>Analise IA</b>\n\n📄 <b>Fonte:</b> ${result.result.title}\n🔗 <b>URL:</b> ${result.result.url}\n\n`;
        if (result.analysis.error) {
          text += `⚠️ Ollama offline.\n\n${(result.page.content || '').slice(0, 1500)}`;
        } else if (result.analysis.answer) {
          text += result.analysis.answer;
        }
        await bot.sendMessage(chatId, sanitizeHtml(text), { parse_mode: 'HTML' });
      } catch (e) {
        await bot.sendMessage(chatId, `Erro: ${e.message}`);
      }
    };
    bot.on('message', analisarHandler);
    return;
  }

  if (data === 'web_relatorio') {
    try {
      await bot.sendChatAction(chatId, 'typing');
      const result = await generateReport(userId);
      if (result.error) {
        await bot.sendMessage(chatId, result.error);
        return;
      }
      let text = `📊 <b>Relatorio IA</b>\n\n`;
      if (result.analysis.error) {
        text += `⚠️ Ollama offline.\n\n`;
      } else if (result.analysis.answer) {
        text += `${result.analysis.answer}\n\n`;
      }
      if (result.analysis.sources_used && result.analysis.sources_used.length > 0) {
        text += `📚 <b>Fontes:</b>\n`;
        result.analysis.sources_used.forEach((s, i) => { text += `${i + 1}. ${s}\n`; });
      }
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
      await bot.sendMessage(chatId, `Erro: ${e.message}`);
    }
    return;
  }

  if (data === 'web_glista') {
    const state = getState(userId);
    if (!state.results || state.results.length === 0) {
      await bot.sendMessage(chatId, 'Nenhuma pesquisa salva. Use /google primeiro.');
      return;
    }
    let text = `📚 <b>Todos os Resultados</b>\n\n`;
    state.results.forEach((r, i) => { text += `${i + 1}. ${r.title}\n🔗 ${r.url}\n\n`; });
    await bot.sendMessage(chatId, sanitizeHtml(text), { parse_mode: 'HTML' });
    return;
  }

  if (data === 'web_glimpar') {
    clearState(userId);
    await bot.sendMessage(chatId, 'Pesquisa limpa.');
    return;
  }

  if (data.startsWith('consulta_cat_')) {
    const catKey = data.replace('consulta_cat_', '');
    const category = CATEGORIES[catKey];
    if (!category) {
      await notify(chatId, '❌ Categoria nao encontrada');
      return;
    }

    let text = `📋 <b>${category.label}</b>\n\n`;
    const btns = [];
    
    for (const endpoint of category.endpoints) {
      text += `/consulta ${endpoint} &lt;valor&gt;\n`;
      btns.push([{ text: endpoint, callback_data: `consulta_exec_${endpoint}` }]);
    }
    
    text += '\nExemplo: /consulta cpf 12345678901';
    btns.push([{ text: '🔙 Voltar', callback_data: 'menu_consultas' }, { text: '❌ Fechar', callback_data: 'close' }]);
    
    await notify(chatId, text, {
      reply_markup: { inline_keyboard: btns }
    });
    return;
  }

  if (data.startsWith('consulta_exec_')) {
    const endpoint = data.replace('consulta_exec_', '');
    const noParam = endpoint === 'gerar_cpf' || endpoint === 'gerar_cc';
    const { createTelegramStatus } = require('./utils/statusProgress');
    if (isTelegramGroupChat(chatId, msg.chat) && isPiiConsultaTipo(endpoint)) {
      await notify(chatId, 'Consulta de dados so no privado. Abre o PV comigo e manda de novo.');
      return;
    }

    if (noParam) {
      const status = await createTelegramStatus(bot, chatId, 'CONSULTA');
      const result = await executarConsulta(endpoint, '', 'telegram', userId, null, status, {
        isGroup: isTelegramGroupChat(chatId, msg.chat)
      });
      if (result?.imageUrl) {
        try { await bot.sendPhoto(chatId, result.imageUrl, { caption: 'Foto da consulta' }); } catch (_) {}
      }
      return;
    }

    pendingTgCmds.set(String(userId), {
      cmd: `__consulta__${endpoint}`,
      chatId,
      native: true,
      expires: Date.now() + 5 * 60 * 1000
    });
    await bot.sendMessage(chatId, sanitizeHtml(`Digite o valor para <b>${endpoint}</b>:\n\nExemplo: 12345678901`), { parse_mode: 'HTML' });
    return;
  }

  // ===== DIVULGACAO =====
  if (data === 'menu_divulgacao') {
    if (!tgCanUseDivMenu(userId)) return;
    await showMenu(chatId, 'divulgacao', userId);
    return;
  }

  if (data === 'div_slots') {
    if (tgDenyUnlessOwner(userId, data)) return;
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, 'Padroes so para ADMIN Telegram.');
      return;
    }
    await showMenu(chatId, 'div_slots', userId);
    return;
  }

  if (String(data).startsWith('div_slot_track_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, 'Padroes so para ADMIN Telegram.');
      return;
    }
    await showMenu(chatId, 'div_slots', userId);
    return;
  }

  if (String(data).startsWith('div_slot_set_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    if (!isAdmin(userId)) return;
    const m = String(data).match(/^div_slot_set_(cta|status)_([12])$/);
    if (!m) return;
    setActiveSlot(userId, m[1], Number(m[2]));
    await bot.sendMessage(
      chatId,
      `Edicao ${m[1]} → slot ${m[2]}. Textos/midia do Zap e do Telegram gravam neste slot.\n` +
        (m[1] === 'cta'
          ? 'No WhatsApp use o painel CTA (mesmo do #1). Aqui: Texto #N ou envie midia depois de Midia #N.'
          : 'No WhatsApp use o painel Status (mesmo do #1). Aqui: Texto #N ou Midia #N.')
    );
    await showMenu(chatId, 'div_slots', userId);
    return;
  }

  if (String(data).startsWith('div_slot_midia_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    if (!isAdmin(userId)) return;
    const m = String(data).match(/^div_slot_midia_(cta|status)_([12])$/);
    if (!m) return;
    const track = m[1];
    const slot = Number(m[2]);
    setActiveSlot(userId, track, slot);
    await bot.sendMessage(
      chatId,
      `Midia ${track}#${slot} ativo.\nEnvie agora uma foto ou video. Grava neste slot.`
    );
    const mediaHandler = async (mediaMsg) => {
      if (String(mediaMsg?.from?.id) !== String(userId)) return;
      const photo = mediaMsg.photo && mediaMsg.photo[mediaMsg.photo.length - 1];
      const video = mediaMsg.video;
      const fileId = photo?.file_id || video?.file_id;
      if (!fileId) return;
      bot.removeListener('message', mediaHandler);
      try {
        const buffer = await downloadTelegramFileBuffer(fileId);
        const kind = video ? 'video' : 'image';
        const meta = {
          tipo: kind,
          mimetype: video ? 'video/mp4' : 'image/jpeg'
        };
        if (track === 'cta') {
          const { saveCtaMediaBuffer } = require('./utils/divulgacao');
          saveCtaMediaBuffer(userId, buffer, meta);
        } else {
          const { saveStatusMediaBuffer } = require('./utils/divulgacao');
          saveStatusMediaBuffer(userId, buffer, meta);
        }
        await bot.sendMessage(chatId, `Midia salva em ${track}#${slot} (${kind}).`);
      } catch (e) {
        await bot.sendMessage(chatId, `Falha ao salvar midia: ${e.message || e}`);
      }
      await showMenu(chatId, 'div_slots', userId);
    };
    bot.on('message', mediaHandler);
    return;
  }

  if (String(data).startsWith('div_slot_send_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    if (!isAdmin(userId)) return;
    const m = String(data).match(/^div_slot_send_(cta|status)_([12])$/);
    if (!m) return;
    await bot.sendMessage(
      chatId,
      `Envio ${m[1]}#${m[2]}: use o WhatsApp (botao Enviar no painel padroes) ou .divbotao / .divstatus com o slot ativo.\n` +
        `Ativei o slot ${m[2]} pra edicao.`
    );
    setActiveSlot(userId, m[1], Number(m[2]));
    await showMenu(chatId, 'div_slots', userId);
    return;
  }

  if (String(data).startsWith('div_slot_auto_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    if (!isAdmin(userId)) return;
    const m = String(data).match(/^div_slot_auto_(cta|status)_([12])$/);
    if (!m) return;
    const { toggleModo, restartIfEnabled, normalizeModo } = require('./utils/divulgacaoAuto');
    const key = modoKey(m[1], Number(m[2]));
    const config = getDivConfig(userId);
    const modos = toggleModo(config.autoModos, key, null);
    updateDivConfig(userId, { autoModos: modos, autoModoIndex: 0 });
    const on = modos.includes(normalizeModo(key));
    restartIfEnabled(userId, on
      ? { tipos: [key], armMissing: true }
      : { tipos: [key] });
    await bot.sendMessage(chatId, `Auto ${m[1]}#${m[2]}: ${on ? 'ON' : 'OFF'}`);
    await showMenu(chatId, 'div_slots', userId);
    return;
  }

  if (String(data).startsWith('div_slot_int_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    if (!isAdmin(userId)) return;
    const m = String(data).match(/^div_slot_int_(cta|status)_([12])$/);
    if (!m) return;
    await bot.sendMessage(chatId, `Tempo do slot ${m[1]}#${m[2]} — escolha:`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '30m', callback_data: `div_tg_slotint_${m[1]}_${m[2]}_30` },
            { text: '2h', callback_data: `div_tg_slotint_${m[1]}_${m[2]}_120` },
            { text: '6h', callback_data: `div_tg_slotint_${m[1]}_${m[2]}_360` }
          ],
          [
            { text: '12h', callback_data: `div_tg_slotint_${m[1]}_${m[2]}_720` },
            { text: '24h', callback_data: `div_tg_slotint_${m[1]}_${m[2]}_1440` }
          ],
          [{ text: 'Voltar padroes', callback_data: 'div_slots' }]
        ]
      }
    });
    return;
  }

  if (String(data).startsWith('div_tg_slotint_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    if (!isAdmin(userId)) return;
    const m = String(data).match(/^div_tg_slotint_(cta|status)_([12])_(\d+)$/);
    if (!m) return;
    const { patchIntervalByTipo, restartIfEnabled, formatIntervalLabel, normalizeModo } = require('./utils/divulgacaoAuto');
    const tipo = normalizeModo(modoKey(m[1], Number(m[2])));
    const minutes = parseInt(m[3], 10);
    const config = getDivConfig(userId);
    updateDivConfig(userId, patchIntervalByTipo(config, minutes, [tipo]));
    restartIfEnabled(userId, { catchUp: true, tipos: [tipo] });
    await bot.sendMessage(chatId, `Tempo ${tipo}: ${formatIntervalLabel(minutes)}.`);
    await showMenu(chatId, 'div_slots', userId);
    return;
  }

  if (String(data).startsWith('div_slot_text_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    if (!isAdmin(userId)) return;
    const m = String(data).match(/^div_slot_text_(cta|status)_([12])$/);
    if (!m) return;
    const track = m[1];
    const slot = Number(m[2]);
    setActiveSlot(userId, track, slot);
    const hint = track === 'cta'
      ? 'Envie: texto do CTA (ou texto | botao | https://link)'
      : 'Envie o texto de status deste slot:';
    await bot.sendMessage(chatId, hint);
    const textHandler = async (textMsg) => {
      if (String(textMsg?.from?.id) !== String(userId)) return;
      const texto = String(textMsg?.text || textMsg?.caption || '').trim();
      if (!texto) return;
      bot.removeListener('message', textHandler);
      if (track === 'cta') {
        const parts = texto.split('|').map((s) => s.trim()).filter(Boolean);
        const patch = { texto: parts[0] || texto };
        if (parts[1]) patch.label = parts[1].slice(0, 20);
        if (parts[2]) patch.url = parts[2];
        updateSlotPatch(userId, track, slot, patch);
      } else {
        updateSlotPatch(userId, track, slot, { textoStatus: texto });
      }
      await bot.sendMessage(chatId, `Salvo em ${track}#${slot}.\n${texto.substring(0, 120)}${texto.length > 120 ? '...' : ''}`);
      await showMenu(chatId, 'div_slots', userId);
    };
    bot.on('message', textHandler);
    return;
  }

  if (data === 'menu_grupos' || String(data).startsWith('gm_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    try {
      const tgGm = require('./utils/groupManager/telegramUi');
      const handled = await tgGm.handleCallback(bot, {
        chatId,
        userId,
        data,
        messageId: msg.message_id
      });
      if (!handled) await tgGm.sendPanel(bot, chatId, userId);
    } catch (e) {
      logger.logAviso(`[gm-tg] ${String(e.message || e).slice(0, 140)}`);
      await bot.sendMessage(chatId, `Erro no gerenciador: ${String(e.message || e).slice(0, 120)}`);
    }
    return;
  }

  if (data === 'div_config_msg') {
    await showMenu(chatId, 'div_config_msg', userId);
    return;
  }

  if (data === 'div_config_grupos') {
    await showMenu(chatId, 'div_config_grupos', userId);
    return;
  }

  if (data === 'div_config_opts') {
    await showMenu(chatId, 'div_config_opts', userId);
    return;
  }

  if (data === 'div_config_auto') {
    if (tgDenyUnlessOwner(userId, data)) return;
    await showMenu(chatId, 'div_config_auto', userId);
    return;
  }

  if (data === 'div_tg_auto_on' || data === 'div_tg_auto_off') {
    if (tgDenyUnlessOwner(userId, data)) return;
    const { restartIfEnabled } = require('./utils/divulgacaoAuto');
    const on = data.endsWith('_on');
    updateDivConfig(userId, { autoEnabled: on });
    restartIfEnabled(userId, { forceAll: true, armMissing: true });
    await showMenu(chatId, 'div_config_auto', userId);
    return;
  }

  if (String(data).startsWith('div_tg_int_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    const n = parseInt(data.slice('div_tg_int_'.length), 10);
    const { patchIntervalByTipo, restartIfEnabled, formatIntervalLabel } = require('./utils/divulgacaoAuto');
    const config = getDivConfig(userId);
    updateDivConfig(userId, patchIntervalByTipo(config, n, null));
    restartIfEnabled(userId, { catchUp: true, forceAll: true });
    await showMenu(chatId, 'div_config_auto', userId);
    return;
  }

  if (String(data).startsWith('div_tg_rand_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    const m = data.slice('div_tg_rand_'.length).match(/^(\d+)_(\d+)$/);
    if (m) {
      const { patchRandomByTipo, restartIfEnabled, formatIntervalLabel } = require('./utils/divulgacaoAuto');
      const config = getDivConfig(userId);
      updateDivConfig(userId, patchRandomByTipo(config, { min: Number(m[1]), max: Number(m[2]) }, null));
      restartIfEnabled(userId, { catchUp: true, forceAll: true });
    }
    await showMenu(chatId, 'div_config_auto', userId);
    return;
  }

  if (data === 'div_tg_msgs_on' || data === 'div_tg_msgs_off') {
    if (tgDenyUnlessOwner(userId, data)) return;
    const on = data.endsWith('_on');
    updateDivConfig(userId, on
      ? { autoMsgEnabled: true, autoMsgOptIn: true }
      : { autoMsgEnabled: false });
    await showMenu(chatId, 'div_config_auto', userId);
    return;
  }

  if (String(data).startsWith('div_tg_msgs_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    const n = parseInt(data.slice('div_tg_msgs_'.length), 10);
    if (Number.isFinite(n)) {
      const { clampMsgEvery } = require('./utils/divulgacaoAuto');
      updateDivConfig(userId, { autoMsgEvery: clampMsgEvery(n) });
    }
    await showMenu(chatId, 'div_config_auto', userId);
    return;
  }

  if (String(data).startsWith('div_tg_mingap_')) {
    if (tgDenyUnlessOwner(userId, data)) return;
    const n = parseInt(data.slice('div_tg_mingap_'.length), 10);
    const { clampMinGap, formatIntervalLabel } = require('./utils/divulgacaoAuto');
    updateDivConfig(userId, { autoMinGapMin: clampMinGap(n) });
    await showMenu(chatId, 'div_config_auto', userId);
    return;
  }

  if (data === 'div_start') {
    if (tgDenyUnlessOwner(userId, data)) return;
    const live = resolveLiveSession(userId);
    if (!live.conn) {
      await bot.sendMessage(chatId, liveSessionErrorMessage(live.reason));
      return;
    }

    const config = getDivConfig(userId);
    const grupos = getGruposParaDivulgar(userId);
    const qtd = config.quantidade || 1;
    const delayMsg = config.delayMsg || 3000;

    if (!config.texto) {
      await bot.sendMessage(chatId, 'Texto nao configurado. Use Configurar mensagem primeiro.');
      return;
    }
    if (!(grupos.grupos || []).length) {
      await bot.sendMessage(chatId, 'Nenhum grupo na lista. Use addgrupo no WhatsApp.');
      return;
    }

    const modoTexto = `${(grupos.grupos || []).length} grupos na lista`;

    await bot.sendMessage(
      chatId,
      `CONFIRMAR DIVULGACAO\n\n` +
      `Tipo: Normal\n` +
      `Grupos: ${modoTexto}\n` +
      `Quantidade: ${qtd}x\n` +
      `Delay: ${delayMsg}ms\n` +
      `Texto: ${(config.texto || '').slice(0, 80)}${(config.texto || '').length > 80 ? '...' : ''}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Confirmar', callback_data: `div_tg_confirm_normal_${qtd}_${delayMsg}` }],
            [{ text: 'Cancelar', callback_data: 'menu_divulgacao' }]
          ]
        }
      }
    );
    return;
  }

  if (data.startsWith('div_tg_confirm_')) {
    const live = resolveLiveSession(userId);
    if (!live.conn) {
      await bot.sendMessage(chatId, liveSessionErrorMessage(live.reason));
      return;
    }
    const rest = data.replace('div_tg_confirm_', '');
    const parts = rest.split('_');
    const tipo = parts[0] || 'normal';
    const qtd = parseInt(parts[1], 10) || 1;
    const delayMsg = parseInt(parts[2], 10) || 3000;

    const selfJid = selfJidFromConn(live.conn);

    if (!selfJid) {
      await bot.sendMessage(chatId, 'Sessao WA sem JID do bot. Reconecte e tente de novo.');
      return;
    }

    const divConfirm = getCommand('divconfirmar');
    if (!divConfirm) {
      await bot.sendMessage(chatId, 'Comando divconfirmar nao encontrado.');
      return;
    }

    await bot.sendMessage(chatId, 'Iniciando divulgacao... aguarde.');
    try {
      await divConfirm.execute(live.conn, {
        from: selfJid,
        info: null,
        id: `div_confirm_iniciar_${tipo}_${qtd}_${delayMsg}`,
        text: '',
        args: [],
        telegramUserId: userId,
        sessionId: live.sessionId,
        isOwner: true,
        isVip: true,
        telegramChatId: chatId
      });
      await bot.sendMessage(chatId, 'Divulgacao iniciada. Acompanhe nos grupos WhatsApp.');
    } catch (e) {
      logger.logErro('DIV_TG_CONFIRM', e.message);
      const pub = /undefined|item-not-found/i.test(String(e.message || ''))
        ? 'Falha ao enviar no WhatsApp. Tente de novo.'
        : String(e.message || e).slice(0, 180);
      await bot.sendMessage(chatId, `Erro ao iniciar divulgacao: ${pub}`);
    }
    return;
  }

  if (data === 'div_stop') {
    const live = resolveLiveSession(userId);
    if (!live.conn) {
      await bot.sendMessage(chatId, liveSessionErrorMessage(live.reason));
      return;
    }

    const selfJid = selfJidFromConn(live.conn);

    const divStopCmd = getCommand('divstop');
    if (divStopCmd) {
      try {
        await divStopCmd.execute(live.conn, {
          from: selfJid || live.sessionId,
          info: null,
          text: '',
          telegramUserId: userId,
          sessionId: live.sessionId,
          isOwner: true,
          isVip: true
        });
        await bot.sendMessage(chatId, 'Divulgacao parada via Telegram.');
      } catch (e) {
        logger.logErro('DIV_STOP', e.message);
        await bot.sendMessage(chatId, `Erro ao parar divulgacao: ${e.message}`);
      }
    } else {
      await bot.sendMessage(chatId, 'Comando divstop nao encontrado.');
    }
    return;
  }

  if (data === 'div_status') {
    const config = getDivConfig(userId);
    const { isModoOn } = require('./utils/divulgacaoAuto');
    const statusAuto = isModoOn(config, 'status') ? 'ON' : 'OFF';
    const grupos = getGruposParaDivulgar(userId);
    const gruposCount = grupos.grupos ? grupos.grupos.length : 0;
    
    const statusMsg =
      `Status da Divulgacao\n\n` +
      `Status auto: ${statusAuto}\n` +
      `${formatStatusSummary(config)}\n` +
      `Modo: ${config.modoPrincipal || 'normal'}\n` +
      `Grupos: ${gruposCount}\n` +
      `Quantidade: ${config.quantidade}x\n` +
      `Delay Mensagens: ${config.delayMsg}ms\n` +
      `Delay Grupos: ${config.delayGrupo}ms\n` +
      `Repetir: ${config.repetir ? 'Sim' : 'Nao'}`;
    await updateStatus(chatId, statusMsg);
    return;
  }

  // ===== CONFIGURAR TEXTO =====
  if (data === 'div_set_text') {
    await bot.sendMessage(chatId, 'Envie o texto da divulgacao:');
    
    const textHandler = async (textMsg) => {
      const texto = String(textMsg?.text || textMsg?.caption || '').trim();
      if (!texto) return; // ignora sticker/foto/etc ate vir texto
      bot.removeListener('message', textHandler);
      
      updateDivConfig(userId, { texto, configurado: true });
      await bot.sendMessage(chatId, `Texto salvo!\n\n${texto.substring(0, 100)}${texto.length > 100 ? '...' : ''}`);
      await showMenu(chatId, 'div_config_msg', userId);
    };
    
    bot.on('message', textHandler);
    return;
  }

  // ===== ENVIAR IMAGEM =====
  if (data === 'div_send_image') {
    await bot.sendMessage(chatId, 'Envie a imagem da divulgacao:');
    
    const imageHandler = async (msg) => {
      if (!msg.photo) {
        return;
      }
      
      bot.removeListener('message', imageHandler);
      
      try {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const buffer = await downloadTelegramFileBuffer(fileId);
        
        saveTextoMediaBuffer(userId, buffer, {
          tipo: 'image',
          mimetype: 'image/jpeg'
        });
        
        await bot.sendMessage(chatId, 'Imagem salva!');
        await showMenu(chatId, 'div_config_msg', userId);
      } catch (e) {
        logger.logErro('DIV_SEND_IMAGE', e.message);
        await bot.sendMessage(chatId, `Erro ao salvar imagem: ${e.message}`);
      }
    };
    
    bot.on('message', imageHandler);
    return;
  }

  // ===== ENVIAR VIDEO =====
  if (data === 'div_send_video') {
    await bot.sendMessage(chatId, 'Envie o video da divulgacao:');
    
    const videoHandler = async (msg) => {
      if (!msg.video) {
        return;
      }
      
      bot.removeListener('message', videoHandler);
      
      try {
        const fileId = msg.video.file_id;
        const buffer = await downloadTelegramFileBuffer(fileId);
        
        saveTextoMediaBuffer(userId, buffer, {
          tipo: 'video',
          mimetype: 'video/mp4'
        });
        
        await bot.sendMessage(chatId, 'Video salvo!');
        await showMenu(chatId, 'div_config_msg', userId);
      } catch (e) {
        logger.logErro('DIV_SEND_VIDEO', e.message);
        await bot.sendMessage(chatId, `Erro ao salvar video: ${e.message}`);
      }
    };
    
    bot.on('message', videoHandler);
    return;
  }

  // ===== ENVIAR GIF =====
  if (data === 'div_send_gif') {
    await bot.sendMessage(chatId, 'Envie o GIF da divulgacao:');
    
    const gifHandler = async (msg) => {
      if (!msg.animation) {
        return;
      }
      
      bot.removeListener('message', gifHandler);
      
      try {
        const fileId = msg.animation.file_id;
        const buffer = await downloadTelegramFileBuffer(fileId);
        
        saveTextoMediaBuffer(userId, buffer, {
          tipo: 'gif',
          mimetype: 'video/mp4'
        });
        
        await bot.sendMessage(chatId, 'GIF salvo!');
        await showMenu(chatId, 'div_config_msg', userId);
      } catch (e) {
        logger.logErro('DIV_SEND_GIF', e.message);
        await bot.sendMessage(chatId, `Erro ao salvar GIF: ${e.message}`);
      }
    };
    
    bot.on('message', gifHandler);
    return;
  }

  // ===== ENVIAR AUDIO =====
  if (data === 'div_send_audio') {
    await bot.sendMessage(chatId, 'Envie o audio da divulgacao:');
    
    const audioHandler = async (msg) => {
      if (!msg.audio) {
        return;
      }
      
      bot.removeListener('message', audioHandler);
      
      try {
        const fileId = msg.audio.file_id;
        const buffer = await downloadTelegramFileBuffer(fileId);
        
        saveTextoMediaBuffer(userId, buffer, {
          tipo: 'audio',
          mimetype: 'audio/mpeg'
        });
        
        await bot.sendMessage(chatId, 'Audio salvo!');
        await showMenu(chatId, 'div_config_msg', userId);
      } catch (e) {
        logger.logErro('DIV_SEND_AUDIO', e.message);
        await bot.sendMessage(chatId, `Erro ao salvar audio: ${e.message}`);
      }
    };
    
    bot.on('message', audioHandler);
    return;
  }

  // ===== ENVIAR DOCUMENTO =====
  if (data === 'div_send_doc') {
    await bot.sendMessage(chatId, 'Envie o documento da divulgacao:');
    
    const docHandler = async (msg) => {
      if (!msg.document) {
        return;
      }
      
      bot.removeListener('message', docHandler);
      
      try {
        const fileId = msg.document.file_id;
        const buffer = await downloadTelegramFileBuffer(fileId);
        
        saveTextoMediaBuffer(userId, buffer, {
          tipo: 'document',
          mimetype: msg.document.mime_type || 'application/pdf',
          fileName: msg.document.file_name || null
        });
        
        await bot.sendMessage(chatId, 'Documento salvo!');
        await showMenu(chatId, 'div_config_msg', userId);
      } catch (e) {
        logger.logErro('DIV_SEND_DOC', e.message);
        await bot.sendMessage(chatId, `Erro ao salvar documento: ${e.message}`);
      }
    };
    
    bot.on('message', docHandler);
    return;
  }

  // ===== LIMPAR MIDIA =====
  if (data === 'div_clear_media') {
    updateDivConfig(userId, {
      midia: null,
      midiaFile: null,
      midiaTipo: null,
      midiaMimetype: null,
      legenda: ''
    });
    await bot.sendMessage(chatId, 'Midia removida!');
    await showMenu(chatId, 'div_config_msg', userId);
    return;
  }

  // ===== MODO GRUPOS (legado: sempre lista) =====
  if (data === 'div_modo_todos' || data === 'div_modo_especificos') {
    setModoGrupos(userId, 'especificos');
    await bot.sendMessage(chatId, 'Divulgacao so nos grupos da lista.\nUse addgrupo no WhatsApp.');
    await showMenu(chatId, 'div_config_grupos', userId);
    return;
  }

  if (data === 'div_limpar_grupos') {
    limparGrupos(userId);
    await bot.sendMessage(chatId, 'Lista de grupos limpa!');
    await showMenu(chatId, 'div_config_grupos', userId);
    return;
  }

  // ===== CONFIGURAR OPCOES =====
  if (data === 'div_set_qtd') {
    await bot.sendMessage(chatId, 'Envie a quantidade (ex: 5):');
    
    const qtdHandler = async (msg) => {
      const raw = String(msg?.text || '').trim();
      if (!raw) return;
      bot.removeListener('message', qtdHandler);
      const qtd = parseInt(raw, 10);
      
      if (isNaN(qtd) || qtd < 1) {
        await bot.sendMessage(chatId, 'Quantidade invalida. Use um numero maior que 0.');
        return;
      }
      
      updateDivConfig(userId, { quantidade: qtd });
      await bot.sendMessage(chatId, `Quantidade definida: ${qtd}x`);
      await showMenu(chatId, 'div_config_opts', userId);
    };
    
    bot.on('message', qtdHandler);
    return;
  }

  if (data === 'div_set_delay_msg') {
    await bot.sendMessage(chatId, 'Envie o delay de mensagens em ms (ex: 3000):');
    
    const delayMsgHandler = async (msg) => {
      const raw = String(msg?.text || '').trim();
      if (!raw) return;
      bot.removeListener('message', delayMsgHandler);
      const delay = parseInt(raw, 10);
      
      if (isNaN(delay) || delay < 100) {
        await bot.sendMessage(chatId, 'Delay invalido. Use um numero maior que 100ms.');
        return;
      }
      
      updateDivConfig(userId, { delayMsg: delay });
      await bot.sendMessage(chatId, `Delay de mensagens definido: ${delay}ms`);
      await showMenu(chatId, 'div_config_opts', userId);
    };
    
    bot.on('message', delayMsgHandler);
    return;
  }

  if (data === 'div_set_delay_grupo') {
    await bot.sendMessage(chatId, 'Envie o delay de grupos em ms (ex: 2000):');
    
    const delayGrupoHandler = async (msg) => {
      const raw = String(msg?.text || '').trim();
      if (!raw) return;
      bot.removeListener('message', delayGrupoHandler);
      const delay = parseInt(raw, 10);
      
      if (isNaN(delay) || delay < 100) {
        await bot.sendMessage(chatId, 'Delay invalido. Use um numero maior que 100ms.');
        return;
      }
      
      updateDivConfig(userId, { delayGrupo: delay });
      await bot.sendMessage(chatId, `Delay de grupos definido: ${delay}ms`);
      await showMenu(chatId, 'div_config_opts', userId);
    };
    
    bot.on('message', delayGrupoHandler);
    return;
  }

  if (data === 'div_toggle_repetir') {
    const config = getDivConfig(userId);
    const novoValor = !config.repetir;
    updateDivConfig(userId, { repetir: novoValor });
    await bot.sendMessage(chatId, `Repetir: ${novoValor ? 'Sim' : 'Nao'}`);
    await showMenu(chatId, 'div_config_opts', userId);
    return;
  }

  if (data === 'div_set_ordem') {
    await bot.sendMessage(chatId, 'Escolha a ordem:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Sequencial', callback_data: 'div_ordem_sequencial' }],
          [{ text: 'Aleatorio', callback_data: 'div_ordem_aleatorio' }],
          [{ text: 'Voltar', callback_data: 'div_config_opts' }],
        ]
      }
    });
    return;
  }

  if (data === 'div_ordem_sequencial') {
    updateDivConfig(userId, { ordem: 'sequencial' });
    await bot.sendMessage(chatId, 'Ordem definida: Sequencial');
    await showMenu(chatId, 'div_config_opts', userId);
    return;
  }

  if (data === 'div_ordem_aleatorio') {
    updateDivConfig(userId, { ordem: 'aleatorio' });
    await bot.sendMessage(chatId, 'Ordem definida: Aleatorio');
    await showMenu(chatId, 'div_config_opts', userId);
    return;
  }

  if (data === 'admin_cleanup') {
    if (!isAdmin(userId)) {
      await safeAnswerCallback(callbackQuery.id, { text: '🚫 Acesso negado.', show_alert: true });
      return;
    }
    const { getSessionDir } = require('./utils/sessionRegistry');
    const registry = loadRegistry();
    const all = registry.sessions || [];
    const invalidos = [];
    const validos = [];
    for (const s of all) {
      if (s.status === 'connected' || s.status === 'connecting') {
        validos.push(s);
        continue;
      }
      try {
        const credsPath = path.join(getSessionDir(s.sessionId), 'creds.json');
        if (fs.existsSync(credsPath) && fs.statSync(credsPath).size > 0) {
          JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
          validos.push(s);
        } else {
          invalidos.push(s);
        }
      } catch (e) {
        invalidos.push(s);
      }
    }
    for (const s of invalidos) {
      try {
        const dir = getSessionDir(s.sessionId);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        activeConnections.delete(s.sessionId);
      } catch (e) {
        logger.logErro(`ADMIN_CLEANUP ${s.sessionId}`, e.message);
      }
    }
    registry.sessions = validos;
    saveRegistry(registry);
    logger.logSucesso(`[TELEGRAM] Limpeza manual: ${invalidos.length} sessao(oes) invalida(s) removida(s) por ${username} (${userId})`);
    await safeAnswerCallback(callbackQuery.id, { text: `🧹 ${invalidos.length} sessao(oes) invalida(s) removida(s).`, show_alert: true });
    await showMenu(chatId, 'admin', userId);
    return;
  }

  if (data === 'admin_logs') {
    if (!isAdmin(userId)) {
      return;
    }
    try {
      const errPath = typeof logger.getErrorLogFilePath === 'function' ? logger.getErrorLogFilePath() : null;
      const botPath = typeof logger.getLogFilePath === 'function' ? logger.getLogFilePath() : null;
      const logPath = (errPath && fs.existsSync(errPath) && fs.statSync(errPath).size > 0)
        ? errPath
        : botPath;
      if (!logPath || !fs.existsSync(logPath)) {
        await bot.sendMessage(chatId, 'Pasta de logs vazia.');
        return;
      }
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const tail = lines.slice(-40).join('\n');
      const trecho = tail.length > 3500 ? tail.slice(tail.length - 3500) : tail;
      const nomeArquivo = path.basename(logPath);
      const safe = trecho.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await bot.sendMessage(chatId, '<b>Ultimas linhas (' + nomeArquivo + '):</b>\n\n<pre>' + safe + '</pre>', { parse_mode: 'HTML' });
    } catch (e) {
      logger.logException('ADMIN_LOGS', e);
    }
    return;
  }

  } catch (err) {
    logger.logException('TELEGRAM_CALLBACK', err);
    try {
      await safeAnswerCallback(callbackQuery.id, { text: `❌ Erro: ${err.message}`, show_alert: true });
    } catch (e2) {
      logger.logException('TELEGRAM_CALLBACK_ANSWER', e2);
    }
  }
});

// ========== COMANDOS DE CONFIGURAÇÃO VIA TEXTO ==========
const configCommands = {
  setprefix: async (userId, chatId, args) => {
    const novo = args[0];
    if (!novo || novo.length > 2) {
      await notify(chatId, '❌ Use: /setprefix &lt;prefixo&gt; (maximo 2 caracteres)\nEx: /setprefix .  /setprefix *  /setprefix /');
      return;
    }
    if (!setPrefix(userId, novo)) {
      await notify(chatId, '❌ Nao foi possivel alterar o prefixo.');
      return;
    }
    await notify(
      chatId,
      `Prefixo WhatsApp: <code>${novo}</code>\n` +
      `Telegram: / (fixo)\n` +
      `${formatPrefixStatus(userId)}`
    );
  },
  addowner: async (userId, chatId, args, conn) => {
    const jid = await resolveJidOrLid(args, conn);
    if (!jid) {
      return notify(
        chatId,
        'Numero invalido. Manda com ou sem espaco, traco ou +55.\nEx: /addowner +55 41 99214-2464'
      );
    }
    const label = formatOwnerLabel(jid);
    if (addOwner(userId, jid)) {
      await notify(chatId, `Dono adicionado: <code>${label}</code>\nJa pode usar os cmds de dono neste chip.`);
    } else {
      await notify(chatId, `Ja esta na lista de donos: <code>${label}</code>`);
    }
  },
  removeowner: async (userId, chatId, args, conn) => {
    const jid = await resolveJidOrLid(args, conn);
    if (!jid) return notify(chatId, '❌ JID invalido.');
    if (removeOwner(userId, jid)) {
      await notify(chatId, `✅ Dono removido: <code>${jid}</code>`);
    } else {
      await notify(chatId, `ℹ️ Nao estava na lista de donos.`);
    }
  },
  addvip: async (userId, chatId, args, conn) => {
    const jid = await resolveJidOrLid(args, conn);
    if (!jid) return notify(chatId, '❌ JID invalido. Ex: /addvip +55 51 8205-2118');
    if (addVip(userId, jid)) {
      await notify(chatId, `✅ VIP adicionado: <code>${jid}</code>`);
    } else {
      await notify(chatId, `ℹ️ Ja esta na lista de VIPs.`);
    }
  },
  removevip: async (userId, chatId, args, conn) => {
    const jid = await resolveJidOrLid(args, conn);
    if (!jid) return notify(chatId, '❌ JID invalido.');
    if (removeVip(userId, jid)) {
      await notify(chatId, `✅ VIP removido: <code>${jid}</code>`);
    } else {
      await notify(chatId, `ℹ️ Nao estava na lista de VIPs.`);
    }
  },
  addblacklist: async (userId, chatId, args, conn) => {
    const jid = await resolveJidOrLid(args, conn);
    if (!jid) return notify(chatId, '❌ JID invalido.');
    if (addBlacklist(userId, jid)) {
      await notify(chatId, `✅ Grupo adicionado a blacklist: <code>${jid}</code>`);
    } else {
      await notify(chatId, `ℹ️ Ja esta na blacklist.`);
    }
  },
  removeblacklist: async (userId, chatId, args, conn) => {
    const jid = await resolveJidOrLid(args, conn);
    if (!jid) return notify(chatId, '❌ JID invalido.');
    if (removeBlacklist(userId, jid)) {
      await notify(chatId, `✅ Grupo removido da blacklist: <code>${jid}</code>`);
    } else {
      await notify(chatId, `ℹ️ Nao estava na blacklist.`);
    }
  },
  ban: async (userId, chatId, args) => {
    const targetId = args[0];
    if (!targetId) return notify(chatId, '❌ Use: /ban <id_do_usuario>');
    if (banUser(targetId)) {
      await notify(chatId, `✅ Usuario ${targetId} banido.`);
    } else {
      await notify(chatId, `ℹ️ Usuario ja esta banido.`);
    }
  },
  unban: async (userId, chatId, args) => {
    const targetId = args[0];
    if (!targetId) return notify(chatId, '❌ Use: /unban <id_do_usuario>');
    if (unbanUser(targetId)) {
      await notify(chatId, `✅ Usuario ${targetId} desbanido.`);
    } else {
      await notify(chatId, `ℹ️ Usuario nao estava banido.`);
    }
  },
  listbanned: async (userId, chatId) => {
    const banned = listBanned();
    await notify(chatId, `🚫 <b>Usuarios Banidos:</b>\n${banned.length ? banned.join('\n') : 'Nenhum'}`);
  },
  clearbanned: async (userId, chatId) => {
    if (clearBanned()) {
      await notify(chatId, `✅ Lista de banidos limpa.`);
    } else {
      await notify(chatId, `❌ Erro ao limpar lista de banidos.`);
    }
  }
};

// Registrar comandos de texto
for (const [cmd, handler] of Object.entries(configCommands)) {
  bot.onText(new RegExp(`^/${cmd}\\s+(.+)`), async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const args = match[1].trim();

    // Verificar banimento
    if (isBanned(userId)) {
      await notify(chatId, '🚫 <b>Voce esta banido do bot.</b>');
      return;
    }

    const ok = await ensureChannelFollow(chatId, userId);
    if (!ok) return;

    const userSessions = getUserSessions(userId);
    const ownActiveSession = userSessions.find((s) => activeConnections.has(s.sessionId));
    const conn = ownActiveSession ? activeConnections.get(ownActiveSession.sessionId) : null;

    try {
      await handler(userId, chatId, args, conn);
    } catch (e) {
      logger.logErro(`CMD ${cmd}`, e.message);
      await notify(chatId, `❌ Erro: ${e.message}`);
    }
  });
}

bot.onText(/^\/setprefix$/, async (msg) => {
  await notify(msg.chat.id, '📝 Use: /setprefix &lt;novo_prefixo&gt; (maximo 2 caracteres)');
});

bot.onText(/^\/listowners$/, async (msg) => {
  const userId = msg.from.id;
  const owners = formatOwnersCaption(userId, { max: 8, sep: '\n' });
  await notify(msg.chat.id, `Donos desta sessao:\n${owners}`);
});

bot.onText(/^\/listvips$/, async (msg) => {
  const userId = msg.from.id;
  const vips = getVips(userId);
  await notify(msg.chat.id, `VIPs:\n${vips.length ? vips.map(formatOwnerLabel).join('\n') : 'Nenhum'}`);
});

bot.onText(/^\/listblacklist$/, async (msg) => {
  const userId = msg.from.id;
  const blacklist = getBlacklist(userId);
  await notify(msg.chat.id, `🚫 <b>Blacklist:</b>\n${blacklist.length ? blacklist.join('\n') : 'Nenhum'}`);
});

const CONFIG_USAGE = {
  addowner: '📝 Use: /addowner &lt;numero ou JID&gt;',
  removeowner: '📝 Use: /removeowner &lt;numero ou JID&gt;',
  addvip: '📝 Use: /addvip &lt;numero ou JID&gt;',
  removevip: '📝 Use: /removevip &lt;numero ou JID&gt;',
  addblacklist: '📝 Use: /addblacklist &lt;numero ou JID&gt;',
  removeblacklist: '📝 Use: /removeblacklist &lt;numero ou JID&gt;',
  ban: '📝 Use: /ban &lt;id_do_usuario&gt;',
  unban: '📝 Use: /unban &lt;id_do_usuario&gt;',
  listbanned: '📝 Use: /listbanned',
  clearbanned: '📝 Use: /clearbanned',
};
for (const [cmd, usage] of Object.entries(CONFIG_USAGE)) {
  bot.onText(new RegExp(`^/${cmd}$`), async (msg) => {
    await notify(msg.chat.id, usage);
  });
}

// ========== FUNÇÃO startWhatsAppSession ==========
async function startWhatsAppSession(telegramUserId, sessionId, chatId, method = 'pairing', phoneNumber = null) {
  try {
    logger.logInfo(`[TELEGRAM] Iniciando sessao ${sessionId} para ${telegramUserId} (${method})`);
    try {
      updateSessionStatus(sessionId, 'connecting', {
        needsRepair: false,
        lastError: null,
        reconnectAttempts: 0
      });
    } catch (_) { /* sessao nova ainda nao no registry */ }

    // CORREÇÃO: Só notificar sobre conexão se não estiver em cooldown
    if (shouldNotifyConnection(telegramUserId, 'connecting_start')) {
      await updateStatus(chatId, `🔌 Conectando ao WhatsApp...\n📱 Numero: <b>${phoneNumber || 'indisponivel'}</b>\n⏳ Aguarde...`);
    } else {
      logger.logInfo(`[TELEGRAM] Notificação de conexão ignorada (cooldown) para ${sessionId}`);
    }

    const conn = await connect({
      sessionId,
      telegramUserId,
      connectionMethod: method,
      phoneNumber: method === 'pairing' ? phoneNumber : undefined
    });

    if (!conn) {
      throw new Error('Conexao retornou undefined');
    }

    activeConnections.set(sessionId, conn);
    // Handlers via sessionEvents.socket-ready (emitido em connection.js)

    if (method === 'pairing' && conn._pairingCode) {
      const code = conn._pairingCode;
      logger.logSucesso(`[TELEGRAM] Pairing Code para ${sessionId}: ${code}`);
      
      // CORREÇÃO: Só notificar sobre pairing code se não estiver em cooldown
      if (shouldNotifyConnection(telegramUserId, 'pairing_code', sessionId)) {
        await updateStatus(
          chatId,
          `🔢 <b>Pairing Code gerado com sucesso!</b>\n\n` +
          `📋 Codigo: <code>${code}</code>\n\n` +
          `📌 <b>Como usar:</b>\n` +
          `1. Abra o WhatsApp no seu celular\n` +
          `2. Va em <b>Dispositivos Vinculados</b>\n` +
          `3. Toque em <b>Vincular com Numero de Telefone</b>\n` +
          `4. Digite o codigo acima\n\n` +
          `🔄 O bot vai se conectar automaticamente quando voce finalizar o processo.\n` +
          `⏳ Aguarde... Isso pode levar alguns segundos.`,
          {
            reply_markup: {
              inline_keyboard: [
              [{ text: '📋 Copiar Codigo', copy_text: { text: code } }],
              [{ text: '🔙 Voltar ao Menu', callback_data: 'menu_main' }]
            ]
          }
        }
      );
      }
    } else if (method === 'qr') {
      let qrSent = false;
      const qrHandler = (update) => {
        if (update.qr && !qrSent) {
          qrSent = true;
          // CORREÇÃO: Só enviar QR code se não estiver em cooldown
          if (shouldNotifyConnection(telegramUserId, 'qr_code', sessionId)) {
            logger.logInfo(`[TELEGRAM] QR Code gerado para ${sessionId}`);
            sendQRCodeToTelegram(chatId, sessionId, update.qr);
          } else {
            logger.logInfo(`[TELEGRAM] QR Code gerado mas não enviado (cooldown) para ${sessionId}`);
          }
          conn.ev.off('connection.update', qrHandler);
        }
      };
      conn.ev.on('connection.update', qrHandler);
    }

    const closeHandler = (update) => {
      if (update.connection === 'close') {
        const errorMsg = update.lastDisconnect?.error?.message || 'Desconhecido';
        const reason = update.lastDisconnect?.error?.output?.statusCode;

        if (reason === 515 || errorMsg.includes('restart required')) {
          logger.logInfo(`[TELEGRAM] Ignorando notificação de desconexão (restart required) para ${sessionId}`);
          return;
        }

        if (reason == null && (!errorMsg || errorMsg === 'Desconhecido')) {
          logger.logAviso(`[TELEGRAM] close sem motivo session=${sessionId}`);
        } else {
          logger.logErro(`TELEGRAM_SESSION_CLOSE ${sessionId}`, `${errorMsg} (${reason})`);
        }
        if (reason === 408 && /QR refs/i.test(String(errorMsg || ''))) {
          try {
            updateSessionStatus(sessionId, 'error', {
              lastError: 'QR refs attempts ended (408) — re-parear',
              needsRepair: true
            });
          } catch (_) { /* ignore */ }
          if (!inRestoreQuiet() && shouldNotifyError(telegramUserId, `disconnect_${reason || 'unknown'}`)) {
            updateStatus(
              chatId,
              `Sessao desconectada: QR expirou. Tente conectar de novo.`
            ).catch(() => {});
          }
        }
      }
    };
    if (!conn._tgCloseHooked) {
      conn._tgCloseHooked = true;
      conn.ev.on('connection.update', closeHandler);
    }

    return conn;
  } catch (e) {
    const errorMsg = e.message || 'Erro desconhecido';
    let detail = '';
    if (errorMsg.includes('fetch failed')) {
      detail = '\n🌐 <b>Problema de rede.</b> Verifique sua conexao com a internet.';
    } else if (errorMsg.includes('Connection Closed')) {
      detail = '\n🔌 <b>Conexao fechada.</b> Tente novamente em alguns segundos.';
    }
    await updateStatus(chatId, `❌ <b>Erro ao conectar:</b> ${errorMsg}${detail}`);
    logger.logErro('TELEGRAM_startSession', e.message);
    updateSessionStatus(sessionId, 'error', { lastError: e.message });
    return null;
  }
}

async function sendQRCodeToTelegram(chatId, sessionId, qrCodeData) {
  try {
    const qrBuffer = await QRCode.toBuffer(qrCodeData);
    await bot.sendPhoto(chatId, qrBuffer, {
      caption: `📷 <b>QR Code para conectar</b>\n\n` +
               `📌 <b>Como usar:</b>\n` +
               `1. Abra o WhatsApp no celular\n` +
               `2. Va em <b>Dispositivos Vinculados</b>\n` +
               `3. Toque em <b>Vincular com QR Code</b>\n` +
               `4. Escaneie o codigo acima\n\n` +
               `🔄 O bot vai se conectar automaticamente.\n` +
               `⏳ Aguarde...`,
      parse_mode: 'HTML'
    });
    logger.logInfo(`[TELEGRAM] QR Code enviado para ${sessionId}`);
  } catch (e) {
    logger.logErro('TELEGRAM_QR', e.message);
    await bot.sendMessage(chatId, `❌ Erro ao gerar QR: ${e.message}`);
  }
}

// ========== COMANDOS DE TEXTO EXISTENTES ==========
bot.onText(/^\/(sobre|dono|ownerinfo)(?:@\w+)?$/i, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  try {
    const { buildSobreMenu, DEV_WA_CHAT, FREE_TELEGRAM, FREE_CATALOG } = require('./utils/productOffer');
    const text = buildSobreMenu({ prefix: '/', telegramUserId: userId });
    await bot.sendMessage(chatId, text, {
      reply_markup: sanitizeReplyMarkup({
        inline_keyboard: [
          [{ text: 'Comprar', callback_data: 'bill_home' }],
          [{ text: 'Abrir o bot', url: DEV_WA_CHAT }],
          [{ text: 'Telegram', url: FREE_TELEGRAM }],
          [{ text: 'Menu', callback_data: 'menu_main' }]
        ]
      })
    });
  } catch (e) {
    logger.logErro('TG_SOBRE', e.message);
    await bot.sendMessage(chatId, `Erro: ${e.message}`);
  }
});

bot.onText(/^\/(novidades|status|changelog|oquemudou)(?:@\w+)?$/i, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  try {
    const { formatPublicChangelog, containsSensitive } = require('./utils/publicChangelog');
    const text = formatPublicChangelog('/');
    if (containsSensitive(text)) {
      await bot.sendMessage(chatId, 'HANORK — o que mudou\n\nNotas publicas em revisao. Use /comprar para planos.');
      return;
    }
    await bot.sendMessage(chatId, text);
  } catch (e) {
    logger.logErro('TG_NOVIDADES', e.message);
    await bot.sendMessage(chatId, 'Nao consegui listar novidades agora.');
  }
});

bot.onText(/^\/(comprar|planos|preco|minhaconta|meuplano|suporte|baixarbot|meubot)(?:@\w+)?$/i, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  try {
    const { handleTelegramBilling } = require('./commands/billing');
    const cmd = String(msg.text || '').replace(/^\/+/, '').split(/[\s@]/)[0].toLowerCase();
    const data = cmd === 'minhaconta' || cmd === 'meuplano' ? 'bill_account'
      : cmd === 'suporte' ? 'bill_suporte'
      : (cmd === 'baixarbot' || cmd === 'meubot') ? 'bill_baixarbot'
      : 'bill_home';
    await handleTelegramBilling(bot, { chatId, userId, data });
  } catch (e) {
    logger.logErro('TG_COMPRAR', e.message);
    await bot.sendMessage(chatId, 'Nao consegui abrir planos agora.');
  }
});

bot.onText(/^\/vincular(?:@\w+)?(?:\s+(\S+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  try {
    const { handleTelegramBilling } = require('./commands/billing');
    await handleTelegramBilling(bot, { chatId, userId, data: 'bill_vincular', text: match && match[1] ? match[1] : '' });
  } catch (e) {
    logger.logErro('TG_VINCULAR', e.message);
    await bot.sendMessage(chatId, 'Nao consegui vincular agora.');
  }
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (tgDropIfOwnerOnly(userId)) return;
  const username = msg.from.username || msg.from.first_name || 'sem nome';
  logger.logInfo(`[TELEGRAM] /start | ${username} (${userId})`);
  try {
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  const payload = String(msg.text || '').trim().split(/\s+/)[1] || '';
  if (payload && !/^(comprar|start)$/i.test(payload)) {
    try {
      const store = require('./services/billing/store');
      await store.attachReferralFromTelegram(userId, payload);
    } catch (e) {
      logger.logAviso(`[TELEGRAM] referral: ${e.message}`);
    }
  }
  const wantStore =
    /^comprar$/i.test(payload) ||
    /^ref_/i.test(payload) ||
    (!payload && !isAdmin(userId));
  if (wantStore) {
    if (!payload && !isAdmin(userId)) {
      try {
        const store = require('./services/billing/store');
        const acc = await store.accountFor('telegram', String(userId));
        const paid = !!(acc.entitlement && acc.entitlement.status === 'active' && !store.isExpired(acc.entitlement.expires_at));
        if (paid) {
          await showMenu(chatId, 'main', userId);
          return;
        }
      } catch (_) { /* sem conta = vitrine */ }
    }
    try {
      const { handleTelegramBilling } = require('./commands/billing');
      await handleTelegramBilling(bot, { chatId, userId, data: 'bill_home' });
      return;
    } catch (e) {
      logger.logErro('TG_COMPRAR', e.message);
    }
  }
  await showMenu(chatId, 'main', userId);
  } catch (e) {
    logger.logErro('TG_START', e.message);
    try { await bot.sendMessage(chatId, 'Menu falhou. Manda /start de novo.'); } catch (_) {}
  }
});

bot.onText(/^\/(caixa|painel)(?:@\w+)?$/i, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, 'So admin.');
    return;
  }
  await showMenu(chatId, 'admin_ops', userId);
});

bot.onText(/^\/(afiliado|indicar|referral)(?:@\w+)?$/i, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  try {
    const { handleTelegramBilling } = require('./commands/billing');
    await handleTelegramBilling(bot, { chatId, userId, data: 'bill_afiliado' });
  } catch (e) {
    await bot.sendMessage(chatId, 'Nao consegui gerar o link agora.');
  }
});

bot.onText(/^\/autodivbot(?:@\w+)?(?:\s+(\S+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, 'So admin.');
    return;
  }
  const arg = String((match && match[1]) || '').toLowerCase();
  const job = require('./services/autoDivBot');
  if (arg === 'on' || arg === 'off') {
    const st = job.setOn(arg === 'on');
    const extra = st.summary ? `\n\n${st.summary}` : '';
    await bot.sendMessage(
      chatId,
      `Auto-divulgacao do bot (so sessao admin): ${st.on ? 'ON' : 'OFF'}\n` +
      `Usa a DIV que voce ja salvou (tempo, CTA, texto, grupos). Nao cria ciclo de 180 min.` +
      extra
    );
    return;
  }
  if (arg === 'now') {
    const r = await job.fireOnce();
    const extra = r.results && r.results.length
      ? '\n' + r.results.map((x) => {
        const who = x.admin ? `adm..${x.admin} ` : '';
        return `${who}${x.tipo}: ${x.ok ? 'ok' : (x.reason || 'falhou')}`;
      }).join('\n')
      : '';
    await bot.sendMessage(
      chatId,
      (r.ok ? `Disparo com a DIV salva (${job.adminIds().length} admin(s)).` : `Nao disparou: ${r.reason || 'off'}`) + extra
    );
    return;
  }
  const st = job.status();
  await bot.sendMessage(
    chatId,
    `autodivbot=${st.on ? 'ON' : 'OFF'}` +
    (st.intervalMin ? `\nintervalo da sua DIV: ${st.intervalMin} min` : '') +
    (st.summary ? `\n\n${st.summary}` : '') +
    `\n/autodivbot on|off|now`
  );
});

bot.onText(/^\/menu(?:@\w+)?(?:\s|$)/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  await showMenu(chatId, 'main', userId);
});

bot.onText(/\/mysessions/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  await showMenu(chatId, 'sessions', userId);
});

bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '🚫 Acesso negado.');
    return;
  }
  await showMenu(chatId, 'admin', userId);
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  await showMenu(chatId, 'help', userId);
});

bot.onText(/\/consulta (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  
  const args = match[1].trim().split(/\s+/);
  const endpoint = args[0]?.toLowerCase();
  const noParam = endpoint === 'gerar_cpf' || endpoint === 'gerar_cc' || endpoint === 'gerar-cpf' || endpoint === 'gerar-cc';

  if (!endpoint || (!noParam && args.length < 2)) {
    await bot.sendMessage(chatId, 'Uso: /consulta <endpoint> <valor>\n\nExemplos:\n/consulta cpf 12345678901\n/consulta nome Maria Silva\n\nUse /menu_consultas para ver os endpoints disponiveis.');
    return;
  }
  
  const value = noParam ? '' : args.slice(1).join(' ');
  if (isTelegramGroupChat(chatId, msg.chat) && isPiiConsultaTipo(endpoint)) {
    await bot.sendMessage(chatId, 'Consulta de dados so no privado. Abre o PV comigo e manda de novo.');
    return;
  }
  const { createTelegramStatus } = require('./utils/statusProgress');
  const status = await createTelegramStatus(bot, chatId, 'CONSULTA');
  const result = await executarConsulta(endpoint, value, 'telegram', userId, null, status, {
    isGroup: isTelegramGroupChat(chatId, msg.chat)
  });
  if (result?.imageUrl) {
    try { await bot.sendPhoto(chatId, result.imageUrl, { caption: 'Foto da consulta' }); } catch (_) {}
  }
});

bot.onText(/\/menu_consultas/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  await showMenu(chatId, 'consultas', userId);
});

bot.onText(/\/disconnect (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  const sessionId = match[1].trim();
  await bot.emit('callback_query', {
    id: 'fake',
    from: { id: userId },
    message: { chat: { id: chatId } },
    data: `disconnect_${sessionId}`
  });
});

bot.onText(/\/reconnect (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  const sessionId = match[1].trim();
  await bot.emit('callback_query', {
    id: 'fake',
    from: { id: userId },
    message: { chat: { id: chatId } },
    data: `reconnect_${sessionId}`
  });
});

bot.onText(/\/delete (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (tgDropIfOwnerOnly(userId)) return;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  const sessionId = match[1].trim();
  await bot.emit('callback_query', {
    id: 'fake',
    from: { id: userId },
    message: { chat: { id: chatId } },
    data: `delete_${sessionId}`
  });
});

// ========== UNIVERSAL ROUTER - PROCESSA COMANDOS MIGRADOS ==========
bot.on('message', async (msg) => {
  if (ignoreIfTelegramSelf(msg)) return;
  if (!msg.text) return;
  if (tgDropIfOwnerOnly(msg.from && msg.from.id)) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const { parsePrefixedCommand, isForeignPrefix } = require('./utils/commandTextParse');

  // Prefixo de Zap (. ! #) no TG nao e comando — so /
  if (isForeignPrefix(msg.text, '/', { platform: 'telegram' })) {
    logger.logInfo(
      `[TELEGRAM] ROUTER skip: prefixo estrangeiro (TG so /) user=${userId}`
    );
    return;
  }

  const parsed = parsePrefixedCommand(msg.text, '/', { platform: 'telegram' });
  if (!parsed.prefix || !parsed.command) return;

  if (['grupos', 'grupolista', 'grupoconfig', 'grupoentrar', 'gruposair'].includes(parsed.command)) {
    if (tgDenyUnlessOwner(userId, `/${parsed.command}`)) return;
    try {
      const tgGm = require('./utils/groupManager/telegramUi');
      const gm = require('./utils/groupManager');
      if (parsed.command === 'grupoconfig') {
        const parts = String(parsed.text || '').trim().split(/\s+/).filter(Boolean);
        const head = String(parts[0] || '').toLowerCase();
        if (head === 'max' || head === 'maxgrupos' || head === 'teto' || head === 'ocupacao') {
          const n = parseInt(parts[1], 10);
          if (!Number.isFinite(n) || n < 1) {
            await bot.sendMessage(chatId, 'Uso: /grupoconfig max 80 (1 a 500).');
            return;
          }
          const next = gm.saveLimits(String(userId), { maxTotalGroups: n });
          await bot.sendMessage(chatId, `Teto gravado: ${next.maxTotalGroups} grupos. Teto = para de entrar. Nao sai dos grupos sozinho. Auto-repor OFF nao entra sozinho.`);
        }
        await tgGm.handleCallback(bot, { chatId, userId, data: 'gm_limits' });
        return;
      }
      if (parsed.command === 'grupoentrar') {
        const raw = String(parsed.text || '').trim().toLowerCase();
        const n = raw === 'max' || raw === 'maximo' ? 'max' : (parseInt(raw, 10) || 1);
        await bot.sendMessage(chatId, `Entrando em ate ${n}…`);
        setImmediate(() => {
          let preferredSessionId;
          try {
            preferredSessionId = getLiveConnForUser(String(userId))?.sessionId;
          } catch (_) { /* ignore */ }
          gm.joinBatch(String(userId), n, { preferredSessionId, manual: true }).then(async (out) => {
            const snap = await gm.snapshot(String(userId));
            if (!out.ok) {
              if (out.reason === 'at-cap') {
                await bot.sendMessage(
                  chatId,
                  `Teto atingido. Grupos: ${out.activeGroups || snap.ocupacao} / ${out.maxTotal || snap.maxTotal}.`
                );
                return;
              }
              await bot.sendMessage(chatId, `Nada a entrar (${out.reason || 'sem capacidade'}). Pendentes: ${out.pending || 0}`);
              return;
            }
            const regFail = out.registryFailed || 0;
            const regHint = regFail ? `\n${regFail} no Zap mas nao na lista DIV. Use Reprocessar.` : '';
            await bot.sendMessage(
              chatId,
              `Entrou em ${out.done} grupo(s).\nLista DIV: ${out.divList != null ? out.divList : snap.ativos}\nGrupos no chip: ${snap.ocupacao}/${snap.maxTotal}${regHint}`
            );
          }).catch((e) => bot.sendMessage(chatId, `Erro: ${e.message}`).catch(() => {}));
        });
        return;
      }
      if (parsed.command === 'gruposair') {
        const n = parseInt(parsed.text, 10) || 1;
        await tgGm.handleCallback(bot, { chatId, userId, data: n === 5 ? 'gm_leave_5' : n === 10 ? 'gm_leave_10' : 'gm_leave_1' });
        return;
      }
      await handleTgCmdClick(userId, chatId, parsed.command);
    } catch (e) {
      logger.logErro('TG_GM', e.message);
      try { await bot.sendMessage(chatId, `Erro: ${e.message}`); } catch (_) {}
    }
    return;
  }

  // Config nuke nativo no TG (antes do router — evita WA_ONLY / conn null)
  const nukeCfgCmds = new Set(['nukename', 'nukedesc', 'nukemsg', 'nukeimg', 'nukeconfig', 'nukereset']);
  if (nukeCfgCmds.has(parsed.command)) {
    try {
      await handleTgNukeConfig(userId, chatId, parsed.command, parsed.text);
    } catch (e) {
      logger.logErro('TG_NUKE_CFG', e.message);
      try { await bot.sendMessage(chatId, `Erro: ${e.message}`); } catch (_) {}
    }
    return;
  }
  // /nuke no TG: seletor de grupo (nao "indisponivel")
  if (['nuke', 'nukeid', 'nukeas'].includes(parsed.command)) {
    const gid = String(parsed.text || '').trim().split(/\s+/)[0] || '';
    try {
      if (gid.includes('@g.us')) {
        await runWaCmdInGroup(userId, chatId, 'nuke', gid, '');
      } else {
        await startNukeGroupPick(userId, chatId);
      }
    } catch (e) {
      logger.logErro('TG_NUKE_RUN', e.message);
      try { await bot.sendMessage(chatId, `Erro: ${e.message}`); } catch (_) {}
    }
    return;
  }

  // Deixa bot.onText dedicado tratar (evita duplo envio com shim)
  if (TG_ONTEXT_HANDLED.has(parsed.command)) return;

  if (!TG_PANEL_COMMANDS.has(parsed.command)) {
    try {
      await bot.sendMessage(
        chatId,
        'Aqui no Telegram use /start ou /comprar (depois Conectar).'
      );
    } catch (_) { /* ignore */ }
    return;
  }

  // Tenta processar via router (injeta comando parseado no evento)
  try {
    const fake = {
      ...msg,
      text: msg.text,
      _hanorkParsed: parsed
    };
    const routerResult = await processEvent(fake, 'telegram', tgShim(chatId, userId));
    if (routerResult && routerResult.handled) {
      if (routerResult.error) {
        const errText = String(routerResult.error);
        const { isAuthDenialText } = require('./utils/authSilence');
        if (isAuthDenialText(errText)) {
          console.log(`[AUTH_SILENT] TG_ROUTER user=${userId} | ${errText}`);
        } else if (/rate\s*limit|aguarde|muitos comandos/i.test(errText)) {
          try {
            const { buildRateLimitText } = require('./utils/onboarding');
            const secMatch = errText.match(/(\d+)\s*s/i);
            await bot.sendMessage(chatId, buildRateLimitText(secMatch ? Number(secMatch[1]) : 5));
          } catch (_) { /* ignore */ }
        } else {
          try {
            const { toPublicError } = require('./core/router/errorHandler');
            logger.logUserFacingError('TG_ROUTER_ERROR', errText, { userId });
            await bot.sendMessage(chatId, toPublicError(errText));
          } catch (_) { /* ignore */ }
        }
        logger.logAviso(`[TELEGRAM] ROUTER_ERROR_USER - userId=${userId}, error=${routerResult.error}`);
      } else {
        logger.logInfo(`[TELEGRAM] ROUTER_HANDLED - userId=${userId}, text=${msg.text.substring(0, 30)}...`);
      }
      return;
    }
  } catch (routerError) {
    logger.logErro(`[TELEGRAM] ROUTER_ERROR - userId=${userId}, error=${routerError.message}`);
  }
});

// ========== RESTAURAR SESSÕES ==========
const restoreSkipLogged = new Set();
async function restoreAllSessions() {
  isRestoring = true;
  bumpRestoreQuiet(120000);

  try {
    const registry = loadRegistry();
    const all = registry.sessions || [];
    if (all.length === 0) {
      logger.logInfo('[TELEGRAM] Nenhuma sessao registrada.');
      return;
    }

    const validSessions = [];
    const invalidSessions = [];

    for (const s of all) {
      try {
        const sessionDir = require('./utils/sessionRegistry').getSessionDir(s.sessionId);
        const credsPath = path.join(sessionDir, 'creds.json');

        if (fs.existsSync(credsPath)) {
          const stats = fs.statSync(credsPath);
          if (stats.size > 0) {
            try {
              JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
              validSessions.push(s);
              continue;
            } catch (parseErr) {
              logger.logAviso(`Arquivo creds.json corrompido para sessão ${s.sessionId}`);
              invalidSessions.push(s);
              continue;
            }
          }
        }
        invalidSessions.push(s);
      } catch (err) {
        logger.logAviso(`Erro ao verificar sessão ${s.sessionId}: ${err.message}`);
        invalidSessions.push(s);
      }
    }

    const toRemove = invalidSessions.filter(s => s.status !== 'connected' && s.status !== 'connecting');
    if (toRemove.length > 0) {
      logger.logInfo(`[TELEGRAM] Removendo ${toRemove.length} sessoes invalidas.`);
      toRemove.forEach(s => {
        logger.logAviso(`Sessao ${s.sessionId} (${s.telegramUserId}) removida`);
        try {
          const sessionDir = require('./utils/sessionRegistry').getSessionDir(s.sessionId);
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) {}
      });
      registry.sessions = validSessions.concat(invalidSessions.filter(s => s.status === 'connected' || s.status === 'connecting'));
      saveRegistry(registry);
    } else {
      registry.sessions = all;
      saveRegistry(registry);
    }

    if (validSessions.length === 0) {
      logger.logInfo('[TELEGRAM] Nenhuma sessao valida para restaurar.');
      return;
    }

    logger.logInfo(`[TELEGRAM] Restaurando ${validSessions.length} sessoes em paralelo...`);
    
    const RESTORE_CONCURRENCY = 3;
    const restorePromises = [];
    const repairNotices = [];
    
    for (let i = 0; i < validSessions.length; i++) {
      const session = validSessions[i];
      const promise = (async () => {
        try {
          const lastErr = String(session.lastError || '');
          const needsRepair =
            session.needsRepair === true ||
            /401 persistente|re-parear|^401:|401 Connection Failure|Logged out \(401\)|Forbidden \(403\)|403 Forbidden|Multidevice mismatch|Logged Out|QR refs attempts ended/i.test(lastErr);
          if (needsRepair) {
            if (!restoreSkipLogged.has(session.sessionId)) {
              restoreSkipLogged.add(session.sessionId);
              logger.logAviso(
                `[TELEGRAM] Skip restore ${session.sessionId} — precisa re-pair (${lastErr.slice(0, 80) || 'needsRepair'})`
              );
            }
            try {
              require('./connection').cancelSessionReconnect(session.sessionId);
            } catch (_) { /* ignore */ }
            try {
              updateSessionStatus(session.sessionId, 'error', {
                needsRepair: true,
                lastError: lastErr || '401 — re-parear'
              });
            } catch (_) { /* ignore */ }
            repairNotices.push({ uid: session.telegramUserId, sessionId: session.sessionId });
            return;
          }
          logger.logInfo(`[TELEGRAM] Restaurando ${session.sessionId} (${session.telegramUserId})...`);
          const conn = await connect({
            sessionId: session.sessionId,
            telegramUserId: session.telegramUserId,
            connectionMethod: 'telegram',
          });
          if (conn) {
            // Handlers ja vinculados por sessionEvents.socket-ready (evita warn duplicado)
            activeConnections.set(session.sessionId, conn);
            logger.logSucesso(`[TELEGRAM] Sessao ${session.sessionId} restaurada (aguardando open).`);
          }
        } catch (e) {
          logger.logErro(`[TELEGRAM] Restore ${session.sessionId}`, e.message);
          updateSessionStatus(session.sessionId, 'error', { lastError: e.message });
        }
      })();
      
      restorePromises.push(promise);
      
      // Aguarda se atingir o limite de concorrência
      if ((i + 1) % RESTORE_CONCURRENCY === 0 || i === validSessions.length - 1) {
        await Promise.all(restorePromises);
        restorePromises.length = 0;
      }
    }

    const byUser = new Map();
    for (const n of repairNotices) {
      const uid = String(n.uid || '').trim();
      if (!uid) continue;
      const arr = byUser.get(uid) || [];
      arr.push(n.sessionId);
      byUser.set(uid, arr);
    }
    for (const [uid] of byUser) {
      try {
        await notifyWhatsAppDown(uid, { kind: 'auth' });
      } catch (_) { /* ignore */ }
    }
  } finally {
    isRestoring = false;
    bumpRestoreQuiet(90000);
  }
}

// Handler geral de mensagem para debug e comandos
bot.on('message', async (msg) => {
  try {
    if (ignoreIfTelegramSelf(msg)) return;
    if (tgDropIfOwnerOnly(msg.from && msg.from.id)) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || 'sem nome';
    const text = msg.text || '';

    try {
      const caption = String(msg.caption || '');
      const entityUrls = []
        .concat(msg.entities || [], msg.caption_entities || [])
        .map((e) => String(e && e.url || '').trim())
        .filter(Boolean);
      const ingestBlob = [text, caption, ...entityUrls].filter(Boolean).join('\n');
      if (ingestBlob && /chat\.whatsapp\.com|wa\.me\/g\/|whatsapp\.com\/(?:chat|invite)\//i.test(ingestBlob) && !text.startsWith('/')) {
        const gm = require('./utils/groupManager');
        setImmediate(() => {
          gm.ingestText({
            ownerKey: String(userId),
            text: ingestBlob,
            sourceJid: `tg:${chatId}`,
            sourceSession: '',
            notifyOwner: null
          }).catch((e) => {
            logger.logAviso(`[GROUP_INVITE] tg ingest: ${String(e.message || e).slice(0, 100)}`);
          });
        });
      }
    } catch (e) {
      logger.logAviso(`[GROUP_INVITE] tg ingest: ${String(e.message || e).slice(0, 100)}`);
    }

    // Pairing/QR: numero nao pode virar consulta Intent
    const pairPending = pendingPairPhone.get(String(userId));
    if (pairPending && text && !text.startsWith('/')) {
      if (Date.now() > pairPending.expires) {
        pendingPairPhone.delete(String(userId));
      } else if (String(pairPending.chatId) === String(chatId)) {
        pendingPairPhone.delete(String(userId));
        const { parsePhoneAndQty } = require('./utils/phoneTarget');
        const parsedPhone = parsePhoneAndQty(String(text).trim(), { defaultQty: 1, maxQty: 1 });
        const numero = parsedPhone?.digits || String(text).trim().replace(/[^0-9]/g, '');
        logger.logInfo(`[TELEGRAM] numero pairing recebido (**${String(numero).slice(-4)})`);
        if (!/^\d{8,15}$/.test(numero)) {
          await notify(chatId, 'Numero invalido. Use DDI + numero (ex: +1 2025551234 ou +55 11 999999999).');
          return;
        }
        const method = pairPending.method === 'qr' ? 'qr' : 'pairing';
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        try {
          registerSession(userId, sessionId, { connectionMethod: method, phoneNumber: numero });
          logger.logInfo(`[TELEGRAM] Sessao ${sessionId} registrada para ${username}`);
          if (shouldNotifyConnection(userId, 'connecting')) {
            await updateStatus(
              chatId,
              `Conectando <b>${numero}</b> via ${method === 'pairing' ? 'Pairing Code' : 'QR Code'}...\nAguarde...`
            );
          } else {
            logger.logInfo(`[TELEGRAM] Notificacao de conexao ignorada (cooldown) para ${sessionId}`);
          }
          await startWhatsAppSession(userId, sessionId, chatId, method, numero);
        } catch (e) {
          if (e.code === 'SESSION_LIMIT_PER_USER') {
            await updateStatus(
              chatId,
              'Voce ja possui uma sessao. Apague-a antes de criar uma nova (menu Sessoes → sua sessao → Deletar).'
            );
          } else if (e.code === 'SESSION_RAM') {
            await updateStatus(
              chatId,
              'RAM alta neste egg. Apague uma sessao ou aguarde pra parear.'
            );
          } else if (e.code === 'SESSION_LIMIT') {
            await updateStatus(chatId, 'Limite de sessoes atingido. Apague uma sessao antes de parear.');
          } else {
            await updateStatus(chatId, 'Erro ao iniciar conexao. Tente de novo.');
            logger.logErro('TELEGRAM_startSession', e.message);
            try { updateSessionStatus(sessionId, 'error', { lastError: 'start_failed' }); } catch {}
          }
          setTimeout(() => showMenu(chatId, 'sessions', userId), 3000);
        }
        return;
      }
    }
    if (pairPending && text && text.startsWith('/')) {
      // Comando explicito cancela espera do numero
      pendingPairPhone.delete(String(userId));
    }

    const cfgPending = pendingConfigAction.get(String(userId));
    if (cfgPending && text && !text.startsWith('/')) {
      if (Date.now() > Number(cfgPending.expires || 0)) {
        pendingConfigAction.delete(String(userId));
      } else if (String(cfgPending.chatId) === String(chatId)) {
        pendingConfigAction.delete(String(userId));
        const handler = configCommands[cfgPending.cmd];
        if (typeof handler === 'function') {
          const userSessions = getUserSessions(userId);
          const ownActiveSession = userSessions.find((s) => activeConnections.has(s.sessionId));
          const conn = ownActiveSession ? activeConnections.get(ownActiveSession.sessionId) : null;
          try {
            await handler(userId, chatId, text.trim(), conn);
          } catch (e) {
            logger.logErro(`CMD ${cfgPending.cmd}`, e.message);
            await notify(chatId, `Erro: ${e.message}`);
          }
          return;
        }
      }
    }
    if (cfgPending && text && text.startsWith('/')) {
      pendingConfigAction.delete(String(userId));
    }

    // Argumentos pendentes de tg_cmd_* / consulta
    const pending = pendingTgCmds.get(String(userId));

    if (pending && divulgacaoTelegramUi.isOurPending(pending)) {
      const handledDiv = await divulgacaoTelegramUi.handlePending({
        bot,
        chatId,
        userId,
        msg,
        pending,
        pendingTgCmds,
        showMenu,
        downloadTelegramFileBuffer,
        logger,
        sendMenuWithImage
      });
      if (handledDiv) return;
    }

    // Foto pendente de /nukeimg
    if (pending && pending.kind === 'nuke_photo' && msg.photo) {
      if (Date.now() > pending.expires) {
        pendingTgCmds.delete(String(userId));
      } else {
        pendingTgCmds.delete(String(userId));
        try {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          const buffer = await downloadTelegramFileBuffer(fileId);
          const { getNukeConfig, setNukeConfig } = require('./utils/configManager');
          const cfg = getNukeConfig(userId) || {};
          cfg.groupImage = buffer.toString('base64');
          setNukeConfig(userId, cfg);
          await bot.sendMessage(chatId, 'Foto do nuke definida com sucesso.');
        } catch (e) {
          logger.logErro('TG_NUKEIMG', e.message);
          await bot.sendMessage(chatId, `Erro ao salvar foto: ${e.message}`);
        }
      }
      return;
    }

    if (pending && text && !text.startsWith('/')) {
      if (Date.now() > pending.expires) {
        pendingTgCmds.delete(String(userId));
      } else {
        pendingTgCmds.delete(String(userId));
        if (String(pending.cmd || '').startsWith('__consulta__')) {
          const endpoint = pending.cmd.replace('__consulta__', '');
          if (isTelegramGroupChat(chatId, msg.chat) && isPiiConsultaTipo(endpoint)) {
            await bot.sendMessage(chatId, 'Consulta de dados so no privado. Abre o PV comigo e manda de novo.');
            return;
          }
          const { createTelegramStatus } = require('./utils/statusProgress');
          const status = await createTelegramStatus(bot, chatId, 'CONSULTA');
          const result = await executarConsulta(endpoint, text.trim(), 'telegram', userId, null, status, {
            isGroup: isTelegramGroupChat(chatId, msg.chat)
          });
          if (result?.imageUrl) {
            try { await bot.sendPhoto(chatId, result.imageUrl, { caption: 'Foto da consulta' }); } catch (_) {}
          }
          return;
        }
        if (pending.cmd === '__web_google__' || pending.cmd === '__web_deep__') {
          const q = await tgTakeSearch(chatId, text);
          if (!q) return;
          const isDeep = pending.cmd === '__web_deep__';
          const status = await createTelegramStatus(bot, chatId, isDeep ? 'DEEP SEARCH' : 'PESQUISA');
          try {
            await status.update('Buscando', q.slice(0, 80));
            const payload = isDeep ? await deepSearch(userId, q) : { results: await webSearch(userId, q) };
            const results = payload.results || [];
            if (!results.length) {
              await status.finish(formatStatusBlock('PESQUISA', [['Estado', 'nenhum resultado']]));
              return;
            }
            const rows = [
              labelValue('Consulta', q.slice(0, 60)),
              labelValue('Total', results.length),
              ''
            ];
            results.slice(0, 8).forEach((r, i) => {
              rows.push(`${i + 1}. ${String(r.title || '').slice(0, 70)}`);
              let url = String(r.url || '');
              if (url.length > 90) url = url.slice(0, 87) + '...';
              rows.push(url);
            });
            rows.push('', labelValue('Dica', isDeep ? '/relatorio' : '/analisar N'));
            await status.finish(formatReportBlock(isDeep ? 'DEEP SEARCH' : 'PESQUISA', rows));
          } catch (e) {
            await status.finish(formatStatusBlock('PESQUISA', [['Erro', String(e.message).slice(0, 120)]]));
          }
          return;
        }
        if (pending.native) {
          const nukeCfg = new Set(['nukename', 'nukedesc', 'nukemsg', 'nukeimg', 'nukeconfig', 'nukereset']);
          if (nukeCfg.has(pending.cmd) || pending.kind === 'nuke_cfg') {
            await handleTgNukeConfig(userId, chatId, pending.cmd, text);
          } else {
            // Outros nativos: reenvia como slash para o handler do router
            try {
              const fakeText = `/${pending.cmd} ${text}`.trim();
              const { parsePrefixedCommand } = require('./utils/commandTextParse');
              const parsed = parsePrefixedCommand(fakeText, '/', { platform: 'telegram' });
              const fake = { ...msg, text: fakeText, _hanorkParsed: parsed };
              const routerResult = await processEvent(fake, 'telegram', tgShim(chatId, userId));
              if (routerResult?.handled) {
                if (routerResult.error) await bot.sendMessage(chatId, String(routerResult.error));
              } else {
                await bot.sendMessage(chatId, `Use: /${pending.cmd} ${text}`);
              }
            } catch (e) {
              await bot.sendMessage(chatId, `Use: /${pending.cmd} ${text}`);
            }
          }
        } else if (['nuke', 'nukeid', 'nukeas'].includes(pending.cmd)) {
          await startNukeGroupPick(userId, chatId);
        } else {
          await bot.sendMessage(
            chatId,
            'Aqui no Telegram use /start ou /comprar (depois Conectar).'
          );
        }
        return;
      }
    }

    // Intent Router: texto livre (sem /)
    // Reply / @bot → Hanork IA (dono da sessao TG = owner)
    if (text && !msg.photo && !msg.document && !text.startsWith('/')) {
      try {
        const { getCachedTgBotId } = require('./utils/selfMessageGuard');
        const botId = getCachedTgBotId();
        const replyFrom = msg.reply_to_message?.from;
        const replyToBot =
          !!(replyFrom && (
            replyFrom.is_bot === true ||
            (botId && String(replyFrom.id) === String(botId))
          ));
        let mentionedBot = false;
        if (cachedTgBotUsername) {
          const uname = cachedTgBotUsername.toLowerCase();
          if (new RegExp(`@${uname}\\b`, 'i').test(text)) mentionedBot = true;
        }
        const entities = Array.isArray(msg.entities) ? msg.entities : [];
        if (!mentionedBot && botId) {
          mentionedBot = entities.some((e) => {
            if (e.type === 'text_mention' && e.user && String(e.user.id) === String(botId)) return true;
            if (e.type === 'mention' && cachedTgBotUsername) {
              const slice = text.slice(e.offset, e.offset + e.length).toLowerCase();
              return slice === `@${cachedTgBotUsername.toLowerCase()}`;
            }
            return false;
          });
        }
        if (replyToBot || mentionedBot) {
          const { executeHanorkChat } = require('./commands/hanorkChat');
          let rest = text;
          if (cachedTgBotUsername) {
            rest = rest.replace(new RegExp(`@${cachedTgBotUsername}\\b`, 'ig'), ' ').replace(/\s+/g, ' ').trim();
          }
          if (!rest && replyToBot) rest = 'oi';
          const live = resolveLiveSession(userId);
          const ctx = {
            from: String(chatId),
            sender: String(userId),
            text: rest,
            fullText: rest,
            info: { key: { remoteJid: String(chatId), fromMe: false, id: String(msg.message_id) }, message: { conversation: rest } },
            isOwner: true,
            isVip: true,
            telegramUserId: userId,
            sessionId: live.sessionId || null,
            platform: 'telegram',
            isGroup: msg.chat?.type === 'group' || msg.chat?.type === 'supergroup',
            _tgBot: bot
          };
          await executeHanorkChat(tgShim(chatId, userId), ctx);
          return;
        }
      } catch (hkTgErr) {
        logger.logAviso(`[TELEGRAM] HANORK_REPLY_ERROR: ${hkTgErr.message}`);
      }
    }

    // Intent Router: texto livre (sem /)
    if (text && !msg.photo && !msg.document) {
      if (pendingPairPhone.has(String(userId))) {
        return;
      }
      const { parsePrefixedCommand, isForeignPrefix } = require('./utils/commandTextParse');

      if (isForeignPrefix(text, '/', { platform: 'telegram' })) {
        logger.logInfo(
          `[TELEGRAM] Intent skip: prefixo estrangeiro (TG so /) user=${userId}`
        );
        return;
      }

      const asCmd = parsePrefixedCommand(text, '/', { platform: 'telegram' });
      if (asCmd.prefix) {
        // Comando explicito — deixa o handler do router / onText cuidar
        return;
      }

      try {
        const { processIntent } = require('./core/router/intent');
        const { normalizeEvent } = require('./core/router/eventNormalizer');
        const live = resolveLiveSession(userId);
        // Passar envelope { message } — msg crua do TG tambem e aceita pelo normalizer
        const normalized = normalizeEvent({ message: msg }, 'telegram', live.conn) || {
          platform: 'telegram',
          sessionId: live.sessionId || 'default',
          chatId: String(chatId),
          userId: String(userId),
          isGroup: msg.chat?.type === 'group' || msg.chat?.type === 'supergroup',
          text,
          fullText: text,
          prefix: '',
          command: '',
          args: [],
          raw: msg
        };
        normalized.command = '';
        normalized.prefix = '';
        normalized.fullText = text;
        normalized.text = text;
        // Nunca deixar chatId vazio (causa "bot/chatId ausente" no Intent)
        normalized.chatId = String(normalized.chatId || chatId || '');
        normalized.userId = String(normalized.userId || userId || '');
        normalized.raw = normalized.raw || msg;
        normalized.platform = 'telegram';

        const tgAuthRole = isAdmin(userId) ? 'platform_admin' : 'owner';
        const intentResult = await processIntent(normalized, {
          conn: live.conn || null,
          bot,
          chatId: String(chatId),
          telegramUserId: userId,
          authRole: tgAuthRole,
          executeWaCmd: (cmdName, argsText) => executeWaCmdFromTelegram(userId, chatId, cmdName, argsText)
        });
        if (intentResult?.handled) {
          if (intentResult.error) {
            try {
              const { buildRestrictedText, buildRateLimitText } = require('./utils/onboarding');
              const { displayPrefix } = require('./utils/configManager');
              if (intentResult.error === 'rate_limit') {
                await bot.sendMessage(chatId, buildRateLimitText((intentResult.retryAfter || 5000) / 1000));
              } else if (intentResult.error === 'paywall') {
                /* upsell ja enviado no Intent Router */
              } else if (intentResult.error === 'permission_denied') {
                await bot.sendMessage(chatId, buildRestrictedText(displayPrefix(userId, { platform: 'telegram' })));
              }
            } catch (_) {}
          }
          logger.logInfo(`[TELEGRAM] INTENT_HANDLED route=${intentResult.route} user=${userId}`);
          return;
        }

        // Tip so se quase acertou — conversa comum / min_level = so log
        try {
          if (intentResult?.miss?.reason !== 'min_level') {
            const { maybeSendIntentMissHint } = require('./utils/onboarding');
            const isGroup = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup';
            await maybeSendIntentMissHint(null, chatId, userId, {
              bot,
              isGroup,
              platform: 'telegram',
              text,
              sender: String(userId),
              candidates: intentResult?.miss?.candidates || [],
              topScore: intentResult?.miss?.topScore || 0,
              missReason: intentResult?.miss?.reason || ''
            });
          }
        } catch (_) {}
      } catch (intentErr) {
        logger.logAviso(`[TELEGRAM] INTENT_ERROR: ${intentErr.message}`);
      }
    }
    
    logger.logInfo(`[TELEGRAM] Mensagem recebida: ${text} de ${username} (${userId})`);
    
    // Se for comando /start, mostra menu
    if (text === '/start') {
      logger.logInfo(`[TELEGRAM] /start | ${username} (${userId})`);
      await showMenu(chatId, 'main', userId);
      return;
    }
    
    // Outros comandos são tratados pelos handlers específicos registrados acima
  } catch (e) {
    logger.logErro('TELEGRAM_MESSAGE_HANDLER', e.message);
  }
});

setTimeout(() => {
  initChannel().catch(() => {});
  initDatabase().catch(() => {});
}, 5000);

bot.onText(/^\/intentrouter(?:\s+(.+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  const { getIntentConfig, setIntentRouterEnabled } = require('./utils/configManager');
  const arg = String(match[1] || 'status').trim().toLowerCase();
  if (!arg || arg === 'status') {
    const cfg = getIntentConfig(userId);
    await bot.sendMessage(
      chatId,
      `Intent Router\n\nStatus: ${cfg.enabled ? 'ON' : 'OFF'}\n` +
        `NLU (Ollama): ${cfg.allowNlu !== false ? 'on' : 'off'}\n` +
        `minConfidence: ${cfg.minConfidence}\n` +
        `minConfidenceSensitive: ${cfg.minConfidenceSensitive ?? 0.93}\n` +
        `prefilterTopN: ${cfg.prefilterTopN ?? 10}\n` +
        `URLs: ${cfg.allowUrls ? 'on' : 'off'}\n` +
        `IDs: ${cfg.allowIdentifiers ? 'on' : 'off'}\n` +
        `Search: ${cfg.allowSearch ? 'on' : 'off'}\n\n` +
        `Uso: /intentrouter on|off`
    );
    return;
  }
  if (arg === 'on' || arg === 'off') {
    const cfg = setIntentRouterEnabled(userId, arg === 'on');
    await bot.sendMessage(chatId, `Intent Router ${cfg.enabled ? 'ativado' : 'desativado'}.`);
    return;
  }
  await bot.sendMessage(chatId, 'Uso: /intentrouter on|off|status');
});

// ========== COMANDOS DO TELEGRAM PARA MODO DE ENCAMINHAMENTO ==========
bot.onText(/\/forwardoff (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  
  const sessionId = match[1].trim();
  if (!sessionId) {
    await bot.sendMessage(chatId, 'Uso: /forwardoff <sessionId>');
    return;
  }
  
  setForwardMode(sessionId, true);
  try { setSessionButtonMode(sessionId, false); } catch (e) {
    logger.logAviso(`[FORWARD] sync buttonMode OFF: ${e.message}`);
  }
  await bot.sendMessage(chatId, `Modo OFF ativado para sessao ${sessionId}. Mensagens serao enviadas como encaminhadas do canal oficial.`);
});

bot.onText(/\/forwardon (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  
  const sessionId = match[1].trim();
  if (!sessionId) {
    await bot.sendMessage(chatId, 'Uso: /forwardon <sessionId>');
    return;
  }
  
  setForwardMode(sessionId, false);
  try { setSessionButtonMode(sessionId, true); } catch (e) {
    logger.logAviso(`[FORWARD] sync buttonMode ON: ${e.message}`);
  }
  await bot.sendMessage(chatId, `Modo ON ativado para sessao ${sessionId}. Mensagens serao enviadas normalmente com botoes interativos.`);
});

bot.onText(/\/forwardstatus (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  
  const sessionId = match[1].trim();
  if (!sessionId) {
    await bot.sendMessage(chatId, 'Uso: /forwardstatus <sessionId>');
    return;
  }
  
  const status = getForwardModeStatus(sessionId);
  const statusText = status === 'OFF' ? 'OFF (encaminhado)' : 'ON (normal)';
  await bot.sendMessage(chatId, `Modo de encaminhamento para sessao ${sessionId}: ${statusText}`);
});

bot.onText(/\/forwardclear (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  
  const sessionId = match[1].trim();
  if (!sessionId) {
    await bot.sendMessage(chatId, 'Uso: /forwardclear <sessionId>');
    return;
  }
  
  clearForwardMode(sessionId);
  await bot.sendMessage(chatId, `Modo de encaminhamento removido para sessao ${sessionId}. Mensagens serao enviadas normalmente.`);
});

// ========== COMANDOS DE BUSCA WEB ==========
bot.onText(/^\/(google|pesquisar|web|search)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;

  const query = await tgTakeSearch(chatId, match[2], 'Uso: /google <termo>');
  if (!query) return;

  const status = await createTelegramStatus(bot, chatId, 'PESQUISA');
  try {
    await status.update('Buscando', query.slice(0, 80));
    const results = await webSearch(userId, query);
    if (!results || results.length === 0) {
      await status.finish(formatStatusBlock('PESQUISA', [['Estado', 'nenhum resultado']]));
      return;
    }
    await status.update('Resultados', String(results.length));
    // Compacto: evita MESSAGE_TOO_LONG (URLs do Google News sao enormes)
    const rows = [
      labelValue('Consulta', query.slice(0, 60)),
      labelValue('Total', results.length),
      ''
    ];
    results.slice(0, 8).forEach((r, i) => {
      const title = String(r.title || 'sem titulo').slice(0, 70);
      let url = String(r.url || '');
      if (url.length > 90) url = url.slice(0, 87) + '...';
      rows.push(`${i + 1}. ${title}`);
      rows.push(url);
    });
    rows.push('');
    rows.push(labelValue('Dica', '/analisar N'));
    await status.finish(formatReportBlock('PESQUISA', rows));
  } catch (e) {
    logger.logErro('[TELEGRAM] google', e.message);
    await status.finish(formatStatusBlock('PESQUISA', [['Erro', String(e.message).slice(0, 120)]]));
  }
});

bot.onText(/^\/(deepsearch)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;

  const query = await tgTakeSearch(chatId, match[2], 'Uso: /deepsearch <termo>');
  if (!query) return;

  const status = await createTelegramStatus(bot, chatId, 'DEEP SEARCH');
  try {
    await status.setRows([['Estado', 'gerando queries'], ['Consulta', query.slice(0, 60)]]);
    const { results, queries } = await deepSearch(userId, query);
    await status.setRows([
      ['Estado', 'buscando'],
      ['Queries', (queries || []).join(' | ').slice(0, 120)]
    ]);
    if (!results || results.length === 0) {
      await status.finish(formatStatusBlock('DEEP SEARCH', [['Estado', 'nenhum resultado']]));
      return;
    }
    await status.update('Resultados', String(results.length));
    const rows = [
      labelValue('Consulta', query.slice(0, 60)),
      queries?.length ? labelValue('Queries', queries.join(' | ').slice(0, 100)) : null,
      labelValue('Total', results.length),
      ''
    ].filter((x) => x !== null);
    results.slice(0, 8).forEach((r, i) => {
      const title = String(r.title || 'sem titulo').slice(0, 70);
      let url = String(r.url || '');
      if (url.length > 90) url = url.slice(0, 87) + '...';
      rows.push(`${i + 1}. ${title}`);
      rows.push(url);
    });
    rows.push('');
    rows.push(labelValue('Dica', '/relatorio'));
    await status.finish(formatReportBlock('DEEP SEARCH', rows));
  } catch (e) {
    logger.logErro('[TELEGRAM] deepsearch', e.message);
    await status.finish(formatStatusBlock('DEEP SEARCH', [['Erro', String(e.message).slice(0, 120)]]));
  }
});

bot.onText(/^\/(analisar|ganalisar)\s+(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;

  const num = parseInt(match[2], 10);
  if (!num) {
    await bot.sendMessage(chatId, 'Uso: /analisar <numero>');
    return;
  }

  const status = await createTelegramStatus(bot, chatId, 'ANALISE');
  try {
    await status.update('Estado', `analisando fonte ${num}`);
    const result = await analyzeSpecific(userId, num);
    if (result.error) {
      await status.finish(formatStatusBlock('ANALISE', [['Erro', result.error]]));
      return;
    }
    const rows = [
      labelValue('Fonte', result.result.title),
      labelValue('URL', result.result.url),
      ''
    ];
    if (result.analysis.error) {
      rows.push('Ollama offline. Conteudo da pagina:');
      rows.push('');
      rows.push((result.page.content || '').slice(0, 1500));
    } else if (result.analysis.answer) {
      rows.push(result.analysis.answer);
    }
    await status.finish(formatReportBlock('ANALISE IA', rows));
  } catch (e) {
    logger.logErro('[TELEGRAM] analisar', e.message);
    await status.finish(formatStatusBlock('ANALISE', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(relatorio)/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;

  const status = await createTelegramStatus(bot, chatId, 'RELATORIO');
  try {
    await status.update('Estado', 'baixando fontes');
    const result = await generateReport(userId);
    if (result.error) {
      await status.finish(formatStatusBlock('RELATORIO', [['Erro', result.error]]));
      return;
    }
    await status.update('Estado', 'analisando com IA');
    const rows = [labelValue('Consulta', result.query || 'Pesquisa'), ''];
    if (result.analysis.error) {
      rows.push('Ollama offline. Resultados sem analise IA.');
    } else if (result.analysis.answer) {
      rows.push(result.analysis.answer);
    }
    if (result.analysis.sources_used?.length) {
      rows.push('');
      rows.push(toMono('Fontes'));
      result.analysis.sources_used.forEach((s, i) => rows.push(`${i + 1}. ${s}`));
    }
    await status.finish(formatReportBlock('RELATORIO IA', rows));
  } catch (e) {
    logger.logErro('[TELEGRAM] relatorio', e.message);
    await status.finish(formatStatusBlock('RELATORIO', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(glista|glist|googlelista)/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  
  const state = getState(userId);
  if (!state.results || state.results.length === 0) {
    await bot.sendMessage(chatId, 'Nenhuma pesquisa salva. Use /google ou /deepsearch primeiro.');
    return;
  }
  
  let text = `📚 <b>Todos os Resultados</b>\n\n`;
  state.results.forEach((r, i) => {
    text += `${i + 1}. ${r.title}\n`;
    text += `🔗 ${r.url}\n\n`;
  });
  
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

bot.onText(/^\/(gopen)\s+(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  
  const num = parseInt(match[2]);
  if (!num) {
    await bot.sendMessage(chatId, 'Uso: /gopen <numero>');
    return;
  }
  
  const state = getState(userId);
  if (!state.results || state.results.length === 0) {
    await bot.sendMessage(chatId, 'Nenhuma pesquisa salva. Use /google ou /deepsearch primeiro.');
    return;
  }
  
  const r = state.results[num - 1];
  if (!r) {
    await bot.sendMessage(chatId, `Resultado ${num} nao encontrado.`);
    return;
  }
  
  await bot.sendMessage(chatId, `🔗 <b>${r.title}</b>\n\n${r.url}`, { parse_mode: 'HTML' });
});

bot.onText(/^\/(gcopy)\s+(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  
  const num = parseInt(match[2]);
  if (!num) {
    await bot.sendMessage(chatId, 'Uso: /gcopy <numero>');
    return;
  }
  
  const state = getState(userId);
  if (!state.results || state.results.length === 0) {
    await bot.sendMessage(chatId, 'Nenhuma pesquisa salva. Use /google ou /deepsearch primeiro.');
    return;
  }
  
  const r = state.results[num - 1];
  if (!r) {
    await bot.sendMessage(chatId, `Resultado ${num} nao encontrado.`);
    return;
  }
  
  await bot.sendMessage(chatId, r.url);
});

bot.onText(/^\/(glimpar)/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  
  clearState(userId);
  await bot.sendMessage(chatId, 'Pesquisa limpa.');
});

// ========== DOWNLOADS (Hanork) ==========
bot.onText(/^\/(play|ytmp3)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;

  const query = await tgTakeSearch(chatId, match[2], 'Uso: /play <nome ou link YT>');
  if (!query) return;

  const status = await createTelegramStatus(bot, chatId, 'PLAY');
  try {
    await status.update('Buscando', query);
    const media = await playMedia(query);
    await status.setRows([
      ['Resultado encontrado', media.title],
      ['Duracao', media.duration || '-'],
      ['Estado', 'enviando audio']
    ]);
    await status.remove();
    const caption = formatReportBlock('PLAY', [
      labelValue('Titulo', media.title),
      labelValue('Duracao', media.duration || '-'),
      labelValue('Canal', media.channel || '-'),
      labelValue('Link', media.url)
    ]);
    await bot.sendAudio(chatId, media.audioBuffer, {
      caption,
      title: (media.title || 'audio').slice(0, 60),
      filename: `${(media.title || 'audio').slice(0, 40)}.mp3`
    });
  } catch (e) {
    logger.logErro('[TELEGRAM] play', e.message);
    const { friendlyMediaError } = require('./utils/onboarding');
    try {
      await status.finish(formatStatusBlock('PLAY', [['Erro', friendlyMediaError(e)]]));
    } catch (_) {
      await bot.sendMessage(chatId, friendlyMediaError(e));
    }
  }
});

bot.onText(/^\/(tiktok)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;

  const url = await tgTakeSearch(chatId, match[2], 'Uso: /tiktok <link>');
  if (!url) return;

  const status = await createTelegramStatus(bot, chatId, 'TIKTOK');
  try {
    await status.update('Baixando', url.slice(0, 80));
    const media = await downloadTiktok(url);
    await status.remove();
    const caption = formatReportBlock('TIKTOK', [
      labelValue('Titulo', media.title),
      labelValue('Autor', media.author || '-')
    ]);
    const { prepareDownloadMedia, isImageBuffer } = require('./services/stillAudioMux');
    const ready = await prepareDownloadMedia(media);
    if (ready.videoBuffer) {
      await bot.sendVideo(chatId, ready.videoBuffer, { caption });
    } else if (ready.imageBuffers?.length) {
      for (const buf of ready.imageBuffers) {
        await bot.sendPhoto(chatId, buf, { caption });
      }
    } else if (isImageBuffer(ready.mediaBuffer)) {
      await bot.sendPhoto(chatId, ready.mediaBuffer, { caption });
    } else {
      await bot.sendMessage(chatId, 'Midia nao encontrada no resultado.');
    }
  } catch (e) {
    logger.logErro('[TELEGRAM] tiktok', e.message);
    await status.finish(formatStatusBlock('TIKTOK', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(instagram|ig|insta)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;

  const url = await tgTakeSearch(chatId, match[2], 'Uso: /instagram <link>');
  if (!url) return;

  const status = await createTelegramStatus(bot, chatId, 'INSTAGRAM');
  try {
    await status.update('Baixando', url.slice(0, 80));
    const media = await downloadInstagram(url);
    await status.remove();
    if (!media.mediaBuffer) {
      await bot.sendMessage(chatId, 'Midia nao encontrada. API pode estar indisponivel.');
      return;
    }
    const caption = formatReportBlock('INSTAGRAM', [labelValue('Titulo', media.title)]);
    const { prepareDownloadMedia, isImageBuffer } = require('./services/stillAudioMux');
    const ready = await prepareDownloadMedia(media);
    if (ready.videoBuffer) {
      await bot.sendVideo(chatId, ready.videoBuffer, { caption });
    } else if (isImageBuffer(ready.mediaBuffer)) {
      await bot.sendPhoto(chatId, ready.mediaBuffer, { caption });
    } else if (ready.mediaBuffer) {
      await bot.sendVideo(chatId, ready.mediaBuffer, { caption });
    } else {
      await bot.sendMessage(chatId, 'Midia nao encontrada. API pode estar indisponivel.');
    }
  } catch (e) {
    logger.logErro('[TELEGRAM] instagram', e.message);
    await status.finish(formatStatusBlock('INSTAGRAM', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(ytsearch)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;

  const query = await tgTakeSearch(chatId, match[2], 'Uso: /ytsearch <termo>');
  if (!query) return;

  const status = await createTelegramStatus(bot, chatId, 'YT SEARCH');
  try {
    await status.update('Buscando', query);
    const list = await searchYoutube(query);
    if (!list.length) {
      await status.finish(formatStatusBlock('YT SEARCH', [['Estado', 'nenhum resultado']]));
      return;
    }
    const rows = [labelValue('Consulta', query), labelValue('Resultados', list.length), ''];
    list.slice(0, 8).forEach((r, i) => {
      rows.push(`${i + 1}. ${r.title}`);
      rows.push(`   ${r.duration || '-'} | ${r.url}`);
    });
    rows.push('', labelValue('Dica', '/play <nome>'));
    await status.finish(formatReportBlock('YT SEARCH', rows));
  } catch (e) {
    logger.logErro('[TELEGRAM] ytsearch', e.message);
    await status.finish(formatStatusBlock('YT SEARCH', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(download|downloads)$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  await bot.sendMessage(chatId, formatReportBlock('DOWNLOADS', [
    labelValue('/play', '<musica ou link YT>'),
    labelValue('/playvideo', '<nome ou link>'),
    labelValue('/tiktok', '<link>'),
    labelValue('/instagram', '<link>'),
    labelValue('/facebook', '<link>'),
    labelValue('/spotify', '<link ou nome>'),
    labelValue('/soundcloud', '<link ou nome>'),
    labelValue('/kwai', '<link>'),
    labelValue('/threads', '<link>'),
    labelValue('/capcut', '<link>'),
    labelValue('/pinterest', '<link>'),
    labelValue('/mediafire', '<link>'),
    labelValue('/twitter', '<link>'),
    labelValue('/ytsearch', '<termo>'),
    '',
    'Hanork API. Prefixo + comando na frente.'
  ]));
});

bot.onText(/^\/(playvideo|ytmp4|playvid)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  const query = await tgTakeSearch(chatId, match[2], 'Uso: /playvideo <nome ou link YT>');
  if (!query) return;
  const status = await createTelegramStatus(bot, chatId, 'PLAYVIDEO');
  try {
    await status.update('Buscando', query);
    const media = await playVideoMedia(query);
    await status.remove();
    const caption = formatReportBlock('PLAYVIDEO', [
      labelValue('Titulo', media.title),
      labelValue('Duracao', media.duration || '-'),
      labelValue('Link', media.url)
    ]);
    await bot.sendVideo(chatId, media.videoBuffer, { caption });
  } catch (e) {
    logger.logErro('[TELEGRAM] playvideo', e.message);
    await status.finish(formatStatusBlock('PLAYVIDEO', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(facebook|fb|facevideo)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  const url = await tgTakeSearch(chatId, match[2], 'Uso: /facebook <link>');
  if (!url) return;
  const status = await createTelegramStatus(bot, chatId, 'FACEBOOK');
  try {
    await status.update('Baixando', url.slice(0, 80));
    const media = await downloadFacebook(url);
    await status.remove();
    if (!media.mediaBuffer) {
      await bot.sendMessage(chatId, 'Video nao encontrado.');
      return;
    }
    await bot.sendVideo(chatId, media.mediaBuffer, {
      caption: formatReportBlock('FACEBOOK', [labelValue('Titulo', media.title)])
    });
  } catch (e) {
    logger.logErro('[TELEGRAM] facebook', e.message);
    await status.finish(formatStatusBlock('FACEBOOK', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(spotify)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  const query = await tgTakeSearch(chatId, match[2], 'Uso: /spotify <link ou nome>');
  if (!query) return;
  const status = await createTelegramStatus(bot, chatId, 'SPOTIFY');
  try {
    await status.update('Baixando', query.slice(0, 80));
    const media = await downloadSpotify(query);
    await status.remove();
    if (!media.audioBuffer) {
      await bot.sendMessage(chatId, 'Audio nao encontrado.');
      return;
    }
    const caption = formatReportBlock('SPOTIFY', [
      labelValue('Titulo', media.title),
      labelValue('Artista', media.artist || '-')
    ]);
    await bot.sendAudio(chatId, media.audioBuffer, {
      caption,
      title: (media.title || 'spotify').slice(0, 60),
      filename: `${(media.title || 'spotify').slice(0, 40)}.mp3`
    });
  } catch (e) {
    logger.logErro('[TELEGRAM] spotify', e.message);
    await status.finish(formatStatusBlock('SPOTIFY', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(mediafire)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  const url = await tgTakeSearch(chatId, match[2], 'Uso: /mediafire <link>');
  if (!url) return;
  const status = await createTelegramStatus(bot, chatId, 'MEDIAFIRE');
  try {
    await status.update('Baixando', url.slice(0, 80));
    const media = await downloadMediafire(url);
    await status.remove();
    const caption = formatReportBlock('MEDIAFIRE', [
      labelValue('Nome', media.filename),
      labelValue('Tamanho', media.filesize)
    ]);
    await bot.sendDocument(chatId, media.fileBuffer, { caption, filename: media.filename });
  } catch (e) {
    logger.logErro('[TELEGRAM] mediafire', e.message);
    await status.finish(formatStatusBlock('MEDIAFIRE', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(twitter|x|twtdl)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ok = await ensureChannelFollow(chatId, userId);
  if (!ok) return;
  const url = await tgTakeSearch(chatId, match[2], 'Uso: /twitter <link>');
  if (!url) return;
  const status = await createTelegramStatus(bot, chatId, 'TWITTER');
  try {
    await status.update('Baixando', url.slice(0, 80));
    const media = await downloadTwitter(url);
    await status.remove();
    const items = media.items?.length
      ? media.items
      : media.mediaBuffer
        ? [{ type: media.type, mediaBuffer: media.mediaBuffer }]
        : [];
    if (!items.length) {
      await bot.sendMessage(chatId, 'Midia nao encontrada.');
      return;
    }
    const caption = formatReportBlock('TWITTER', [labelValue('Titulo', media.title)]);
    for (const item of items) {
      if (item.type === 'video') await bot.sendVideo(chatId, item.mediaBuffer, { caption });
      else await bot.sendPhoto(chatId, item.mediaBuffer, { caption });
    }
  } catch (e) {
    logger.logErro('[TELEGRAM] twitter', e.message);
    await status.finish(formatStatusBlock('TWITTER', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(kwai)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!(await ensureChannelFollow(chatId, userId))) return;
  const url = await tgTakeSearch(chatId, match[2], 'Uso: /kwai <link>');
  if (!url) return;
  const status = await createTelegramStatus(bot, chatId, 'KWAI');
  try {
    await status.update('Baixando', url.slice(0, 80));
    const media = await downloadKwai(url);
    await status.remove();
    await bot.sendVideo(chatId, media.videoBuffer, {
      caption: formatReportBlock('KWAI', [labelValue('Titulo', media.title)])
    });
  } catch (e) {
    await status.finish(formatStatusBlock('KWAI', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(threads|thdl)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!(await ensureChannelFollow(chatId, userId))) return;
  const url = await tgTakeSearch(chatId, match[2], 'Uso: /threads <link>');
  if (!url) return;
  const status = await createTelegramStatus(bot, chatId, 'THREADS');
  try {
    await status.update('Baixando', url.slice(0, 80));
    const media = await downloadThreads(url);
    await status.remove();
    const caption = formatReportBlock('THREADS', [labelValue('Titulo', media.title)]);
    for (const item of media.items.slice(0, 6)) {
      if (item.type === 'video') await bot.sendVideo(chatId, item.mediaBuffer, { caption });
      else await bot.sendPhoto(chatId, item.mediaBuffer, { caption });
    }
  } catch (e) {
    await status.finish(formatStatusBlock('THREADS', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(capcut|capcutmodel)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!(await ensureChannelFollow(chatId, userId))) return;
  const url = await tgTakeSearch(chatId, match[2], 'Uso: /capcut <link>');
  if (!url) return;
  const status = await createTelegramStatus(bot, chatId, 'CAPCUT');
  try {
    await status.update('Baixando', url.slice(0, 80));
    const media = await downloadCapcut(url);
    await status.remove();
    await bot.sendVideo(chatId, media.videoBuffer, {
      caption: formatReportBlock('CAPCUT', [labelValue('Titulo', media.title)])
    });
  } catch (e) {
    await status.finish(formatStatusBlock('CAPCUT', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(soundcloud)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!(await ensureChannelFollow(chatId, userId))) return;
  const query = await tgTakeSearch(chatId, match[2], 'Uso: /soundcloud <link ou nome>');
  if (!query) return;
  const status = await createTelegramStatus(bot, chatId, 'SOUNDCLOUD');
  try {
    await status.update('Baixando', query.slice(0, 80));
    const media = await downloadSoundcloud(query);
    await status.remove();
    if (!media.audioBuffer) return bot.sendMessage(chatId, 'Audio nao encontrado.');
    await bot.sendAudio(chatId, media.audioBuffer, {
      caption: formatReportBlock('SOUNDCLOUD', [labelValue('Titulo', media.title)]),
      title: (media.title || 'soundcloud').slice(0, 60),
      filename: `${(media.title || 'soundcloud').slice(0, 40)}.mp3`
    });
  } catch (e) {
    await status.finish(formatStatusBlock('SOUNDCLOUD', [['Erro', e.message]]));
  }
});

bot.onText(/^\/(pinterest|pindl|pinmp4)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!(await ensureChannelFollow(chatId, userId))) return;
  const url = await tgTakeSearch(chatId, match[2], 'Uso: /pinterest <link>');
  if (!url) return;
  const status = await createTelegramStatus(bot, chatId, 'PINTEREST');
  try {
    await status.update('Baixando', url.slice(0, 80));
    const media = await downloadPinterest(url);
    await status.remove();
    const caption = formatReportBlock('PINTEREST', [labelValue('Titulo', media.title)]);
    if (media.type === 'video') await bot.sendVideo(chatId, media.mediaBuffer, { caption });
    else await bot.sendPhoto(chatId, media.mediaBuffer, { caption });
  } catch (e) {
    await status.finish(formatStatusBlock('PINTEREST', [['Erro', e.message]]));
  }
});

function getLiveConnForUser(telegramUserId) {
  const uid = String(telegramUserId || '');
  if (!uid) return null;
  try {
    const { getUserSessions } = require('./utils/sessionRegistry');
    for (const s of getUserSessions(uid) || []) {
      const conn = activeConnections.get(s.sessionId);
      if (conn && conn.user) return { conn, sessionId: s.sessionId };
    }
  } catch (_) { /* ignore */ }
  for (const [sessionId, conn] of activeConnections.entries()) {
    if (conn && conn.user && String(conn._telegramUserId || '') === uid) {
      return { conn, sessionId };
    }
  }
  return null;
}

module.exports = {
  bot,
  activeConnections,
  startWhatsAppSession,
  restoreAllSessions,
  releaseInstanceLock,
  startTelegramPolling,
  resolveLiveSession,
  getLiveConnForUser,
  pruneExpiredPairPending,
  sendMenuWithImage,
  sendPaymentQr,
  getMenuImageBuffer: () => menuImageBuffer
};