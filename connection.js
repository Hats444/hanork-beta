const {
  makeWASocket,
  useMultiFileAuthState,
  getBestWaVersion,
  DisconnectReason,
  Browsers,
  getDevice,
} = require('@systemzero/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const logger = require('./logger');
const { delay, uptime } = require('./utils');
const { getStats } = require('./cache');
const { sessionExists, clearSession, repairSession, backupSession } = require('./sessionManager');
const { updateSessionStatus, getSessionDir, getSession } = require('./utils/sessionRegistry');
const { ensureUserDir, isAdmin } = require('./utils/userManager');

const MAX_RECONNECT_ATTEMPTS = 25;
/** 401 Connection Failure seguidos — depois disso pede re-pair (creds invalidas) */
const MAX_AUTH_FAILURE_RECONNECTS = 2;
const RECONNECT_DELAY = 8000;
const BACKUP_INTERVAL = 3600000;

/** Evita reconexoes paralelas (connectionReplaced / loop) */
const liveSockets = new Map();
const reconnectPending = new Set();
/** Geracao do socket vivo — close de socket antigo nao reagenda reconnect */
const socketGeneration = new Map();
/** Contador global por sessao (sobrevive a novo connectMultiSession) */
const reconnectAttemptBySession = new Map();
const authFailureBySession = new Map();
/** Graceful shutdown (SIGINT/SIGTERM) — nao reagendar reconnect */
let processShuttingDown = false;

function setProcessShuttingDown(value = true) {
  processShuttingDown = !!value;
  if (processShuttingDown) {
    for (const sid of [...reconnectPending]) {
      try { cancelSessionReconnect(sid); } catch (_) { /* ignore */ }
    }
  }
}

function isProcessShuttingDown() {
  return processShuttingDown;
}

function isLiveConnection(conn) {
  if (!conn || !conn._sessionId) return true;
  return liveSockets.get(conn._sessionId) === conn;
}

function endLiveSocket(sessionId, { forceClose = true } = {}) {
  const prev = liveSockets.get(sessionId);
  if (!prev) return;
  liveSockets.delete(sessionId);
  if (!forceClose) return;
  // clearInterval ANTES de removeAllListeners — senao o close handler nunca roda
  // e o watchdog de 60s vira timer orfao ate o processo morrer.
  try {
    if (prev._watchdogTimer) {
      clearInterval(prev._watchdogTimer);
      prev._watchdogTimer = null;
    }
  } catch (_) { /* ignore */ }
  try {
    if (prev._credsBackupTimer) {
      clearTimeout(prev._credsBackupTimer);
      prev._credsBackupTimer = null;
    }
  } catch (_) { /* ignore */ }
  try {
    prev.ev?.removeAllListeners?.();
  } catch (_) { /* ignore */ }
  try {
    if (typeof prev.end === 'function') prev.end(undefined);
    else if (typeof prev.ws?.close === 'function') prev.ws.close();
  } catch (_) { /* ignore */ }
}

function cancelSessionReconnect(sessionId) {
  reconnectPending.delete(sessionId);
  socketGeneration.set(sessionId, (socketGeneration.get(sessionId) || 0) + 1);
  endLiveSocket(sessionId);
}

/** Encerra todos os sockets live (ex.: TG 409) sem depender do Map do Telegram. */
function endAllLiveSockets() {
  for (const sid of [...liveSockets.keys()]) {
    try { endLiveSocket(sid); } catch (_) { /* ignore */ }
  }
}

function isTransientDisconnect(statusCode, errorMsg) {
  const msg = String(errorMsg || '').toLowerCase();
  if (msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('socket hang up')) {
    return true;
  }
  if (msg.includes('restart required')) return true;
  const code = Number(statusCode);
  return (
    code === DisconnectReason.connectionClosed ||
    code === DisconnectReason.connectionLost ||
    code === DisconnectReason.timedOut ||
    code === DisconnectReason.restartRequired ||
    code === DisconnectReason.unavailableService ||
    code === DisconnectReason.badSession ||
    code === 428 ||
    code === 408 ||
    code === 500 ||
    code === 503 ||
    code === 515 ||
    Number.isNaN(code)
  );
}

function isPermanentDisconnect(statusCode) {
  const code = Number(statusCode);
  return (
    code === DisconnectReason.loggedOut ||
    code === DisconnectReason.forbidden ||
    code === DisconnectReason.multideviceMismatch ||
    code === DisconnectReason.connectionReplaced ||
    code === 401 ||
    code === 403 ||
    code === 411 ||
    code === 440
  );
}

function sessionStillRegistered(sessionId) {
  try {
    const { getSession } = require('./utils/sessionRegistry');
    return !!getSession(sessionId);
  } catch (_) {
    return false;
  }
}

async function scheduleSessionReconnect(sessionId, telegramUserId, connectionMethod, phoneNumber, attempt = 1) {
  if (processShuttingDown) {
    logger.logInfo(`[${sessionId}] reconnect ignorado — process shutting down`);
    return;
  }
  if (!sessionStillRegistered(sessionId)) {
    logger.logInfo(`[${sessionId}] reconnect cancelado — sessao removida do registry`);
    cancelSessionReconnect(sessionId);
    return;
  }
  try {
    const { getSession } = require('./utils/sessionRegistry');
    const s = getSession(sessionId);
    const lastErr = String((s && s.lastError) || '');
    if (
      (s && s.needsRepair === true) ||
      /Forbidden \(403\)|403 Forbidden|401 persistente|Logged out \(401\)|Multidevice mismatch|Logged Out|QR refs attempts ended/i.test(lastErr)
    ) {
      logger.logAviso(`[${sessionId}] reconnect cancelado — precisa re-pair (${lastErr.slice(0, 60) || 'needsRepair'})`);
      cancelSessionReconnect(sessionId);
      return;
    }
  } catch (_) { /* segue */ }
  if (reconnectPending.has(sessionId)) return;
  if (attempt > MAX_RECONNECT_ATTEMPTS) {
    logger.logErro(`[ALERTA] Sessao ${sessionId}: falha na reconexao (max tentativas).`);
    try {
      const { updateSessionStatus } = require('./utils/sessionRegistry');
      updateSessionStatus(sessionId, 'error', { lastError: 'Max reconnect attempts' });
    } catch (_) { /* sessao apagada */ }
    try {
      sessionEvents.emit('session-failed', {
        sessionId,
        telegramUserId,
        reason: 'max_reconnect_attempts'
      });
      sessionEvents.emit('session-needs-repair', {
        sessionId,
        telegramUserId,
        reason: 'max_reconnect_attempts'
      });
    } catch (_) { /* notify opcional */ }
    return;
  }
  reconnectPending.add(sessionId);
  // backoff exponencial com teto + jitter (evita thundering herd e ban por flood de connect)
  const base = Math.min(120000, RECONNECT_DELAY * Math.pow(1.45, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 4000);
  const delayTime = Math.round(base + jitter);
  if (attempt >= 3) {
    logger.logAviso(
      `[ALERTA] Sessao ${sessionId} instavel: reconexao #${attempt} em ${Math.round(delayTime / 1000)}s`
    );
  }
  logger.logInfo(`[${sessionId}] Tentativa ${attempt} em ${Math.round(delayTime / 1000)}s...`);
  try {
    const { updateSessionStatus } = require('./utils/sessionRegistry');
    updateSessionStatus(sessionId, 'connecting', { reconnectAttempts: attempt });
  } catch (_) {
    reconnectPending.delete(sessionId);
    logger.logInfo(`[${sessionId}] reconnect abortado — sessao nao existe mais`);
    return;
  }
  await delay(delayTime);
  reconnectPending.delete(sessionId);
  if (processShuttingDown) {
    logger.logInfo(`[${sessionId}] reconnect abortado apos delay — shutting down`);
    return;
  }
  if (!sessionStillRegistered(sessionId)) {
    logger.logInfo(`[${sessionId}] reconnect cancelado apos delay — sessao removida`);
    return;
  }
  try {
    await connectMultiSession({
      sessionId,
      telegramUserId,
      connectionMethod: connectionMethod || 'telegram',
      phoneNumber: undefined // restore por creds — nunca re-pedir pairing no reconnect
    });
  } catch (e) {
    logger.logErro(`[${sessionId}] reconnect fail: ${e.message}`);
    // Remove do reconnectPending antes de tentar novamente para evitar lock duplo
    reconnectPending.delete(sessionId);
    if (!sessionStillRegistered(sessionId)) return;
    await scheduleSessionReconnect(sessionId, telegramUserId, connectionMethod, phoneNumber, attempt + 1);
  }
}

/** Eventos de ciclo de vida do socket (telegramBot sincroniza activeConnections) */
const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(100);

function emitNeedsRepair(sessionId, telegramUserId, reason) {
  try {
    sessionEvents.emit('session-needs-repair', {
      sessionId,
      telegramUserId,
      reason: String(reason || 'auth')
    });
  } catch (_) { /* ignore */ }
}

function hasLiveSocketForUser(telegramUserId) {
  const uid = String(telegramUserId || '');
  if (!uid) return false;
  try {
    const { getUserSessions } = require('./utils/sessionRegistry');
    for (const s of getUserSessions(uid) || []) {
      const conn = liveSockets.get(s.sessionId);
      if (conn && conn.user) return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

function detectDevice(jid) {
  if (!jid) return 'Desconhecido';
  try {
    const device = getDevice(jid);
    if (device && device !== 'unknown') {
      const map = {
        android: 'Android',
        ios: 'iOS',
        web: 'Web WhatsApp',
        desktop: 'WhatsApp Desktop',
        tablet: 'Tablet',
        business: 'WhatsApp Business',
      };
      return map[device] || device;
    }
  } catch {}
  const match = jid.match(/:(\d+)@/);
  if (match) {
    const suffix = match[1];
    const suffixMap = {
      '16': 'Android',
      '22': 'iOS',
      '23': 'Android',
      '24': 'Android',
      '21': 'Web WhatsApp',
      '41': 'Desktop',
      '51': 'Tablet',
    };
    return suffixMap[suffix] || `Dispositivo (${suffix})`;
  }
  if (jid.includes('@lid')) return 'Dispositivo Vinculado';
  return 'Smartphone';
}

async function connect(options = {}) {
  const { sessionId, telegramUserId, connectionMethod = 'auto', phoneNumber } = options;
  if (sessionId && telegramUserId) {
    return connectMultiSession({ sessionId, telegramUserId, connectionMethod, phoneNumber });
  }
  return connectLegacy();
}

async function connectMultiSession({ sessionId, telegramUserId, connectionMethod, phoneNumber }) {
  if (!sessionId || !telegramUserId) {
    throw new Error('sessionId e telegramUserId sao obrigatorios');
  }

  if (!sessionStillRegistered(sessionId)) {
    logger.logInfo(`[${sessionId}] connect abortado — sessao removida do registry`);
    return null;
  }

  const gen = (socketGeneration.get(sessionId) || 0) + 1;
  socketGeneration.set(sessionId, gen);
  endLiveSocket(sessionId, { forceClose: true });

  ensureUserDir(telegramUserId);
  const sessionDir = getSessionDir(sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  updateSessionStatus(sessionId, 'connecting');
  repairSession(sessionId, true);

  const { version } = await getBestWaVersion();
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const conn = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    // false reduz churn de presence que o WA usa pra derrubar linked device
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 500,
    maxMsgRetryCount: 3,
    emitOwnEvents: true,
    fireInitQueries: true,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
    cachedGroupMetadata: (jid) => {
      try {
        return require('./utils/groupMetaCache').cachedGroupMetadataFn(jid);
      } catch (_) {
        return undefined;
      }
    },
  });

  conn._sessionId = sessionId;
  conn._telegramUserId = telegramUserId;
  conn._socketGen = gen;
  liveSockets.set(sessionId, conn);

  try {
    const { patchConnSendMessage } = require('./utils/waSendPatch');
    patchConnSendMessage(conn);
  } catch (e) {
    logger.logAviso(`[${sessionId}] waSendPatch: ${e.message}`);
  }

  try {
    require('./utils/groupMetaCache').attachToConn(conn);
  } catch (e) {
    logger.logAviso(`[${sessionId}] groupMetaPatch: ${e.message}`);
  }

  try {
    const { applyOutboundGate } = require('./utils/outboundGate');
    applyOutboundGate(conn);
  } catch (e) {
    logger.logAviso(`[${sessionId}] outboundGate: ${e.message}`);
  }

  try {
    const { bindPaymentGuard, hasPaymentMessage } = require('@systemzero/baileys');
    if (typeof bindPaymentGuard === 'function' && typeof hasPaymentMessage === 'function') {
      conn._paymentGuardCleanup = bindPaymentGuard(conn, {
        isPaymentMessage: hasPaymentMessage,
        onDetect: (d) => {
          try {
            logger.logAviso(
              `[paymentGuard] type=${d?.type || '?'} jid=${String(d?.remoteJid || d?.key?.remoteJid || '').slice(0, 28)}`
            );
            const { inspectInboundStealth } = require('./utils/moderation');
            const key = d?.key || {
              remoteJid: d?.remoteJid,
              participant: d?.participant || d?.author || d?.sender,
              participantAlt: d?.participantAlt || d?.participantPn || d?.senderPn,
              participantPn: d?.participantPn || d?.senderPn,
              id: d?.id || d?.messageId,
              fromMe: false
            };
            const wrapped = {
              key,
              message: d?.message || d?.content || d?.msg || null,
              participant: d?.participant || d?.author,
              author: d?.author
            };
            inspectInboundStealth(conn, wrapped, telegramUserId, sessionId, {
              sender: key.participant || d?.participant || d?.author || d?.sender,
              senderAlt: key.participantAlt || d?.participantPn,
              fromGuard: true
            }).catch(() => {});
          } catch (_) { /* ignore */ }
        },
        treatDecryptFailureAsSuspicious: false
      });
    }
  } catch (e) {
    logger.logAviso(`[${sessionId}] paymentGuard: ${e.message}`);
  }

  // Notifica painel/handlers imediatamente (inclui reconexões internas)
  try {
    sessionEvents.emit('socket-ready', { sessionId, telegramUserId, conn });
  } catch (e) {
    logger.logAviso(`[${sessionId}] emit socket-ready: ${e.message}`);
  }

  let pairingRequested = false;
  let qrFallback = false;
  let pairingAlreadyRequested = false;
  const isRestore = (connectionMethod === 'telegram' && !phoneNumber);

  if (connectionMethod === 'pairing' && phoneNumber && !pairingAlreadyRequested) {
    try {
      await delay(3000);
      logger.logInfo(`[${sessionId}] Solicitando Pairing Code para ${phoneNumber}...`);
      const code = await conn.requestPairingCode(phoneNumber);
      logger.logSucesso(`[${sessionId}] Pairing Code: ${code}`);
      conn._pairingCode = code;
      pairingRequested = true;
      pairingAlreadyRequested = true;
    } catch (e) {
      logger.logErro(`[${sessionId}] Falha no Pairing Code: ${e.message}`);
      logger.logAviso(`[${sessionId}] Usando QR Code como fallback.`);
      qrFallback = true;
    }
  } else if (connectionMethod === 'qr') {
    qrFallback = true;
  }

  let lastMsgTime = Date.now();
  let watchdogStrikes = 0;
  conn.ev.on('messages.upsert', () => { lastMsgTime = Date.now(); watchdogStrikes = 0; });
  conn._messageUpsertListener = () => { lastMsgTime = Date.now(); watchdogStrikes = 0; };
  conn._watchdogMetrics = {
    lastProcessed: Date.now(),
    lastCommand: Date.now(),
    updateProcessed() { this.lastProcessed = Date.now(); lastMsgTime = Date.now(); watchdogStrikes = 0; },
    updateCommand() { this.lastCommand = Date.now(); lastMsgTime = Date.now(); watchdogStrikes = 0; }
  };
  const WATCHDOG_MS = Number(process.env.HANORK_SOCKET_WATCHDOG_MS || 240000);
  const watchdogTimer = setInterval(() => {
    if (liveSockets.get(sessionId) !== conn) return;
    const quiet = Date.now() - lastMsgTime;
    if (quiet < WATCHDOG_MS) {
      watchdogStrikes = 0;
      return;
    }
    logger.logAviso(`[WATCHDOG] socket quiet ${Math.round(quiet / 1000)}s session=${sessionId}`);
    Promise.resolve()
      .then(() => (typeof conn.sendPresenceUpdate === 'function' ? conn.sendPresenceUpdate('available') : null))
      .then(() => { watchdogStrikes = 0; })
      .catch((e) => {
        watchdogStrikes += 1;
        logger.logAviso(`[WATCHDOG] ping fail: ${e.message} strikes=${watchdogStrikes}`);
        if (watchdogStrikes >= 2) {
          logger.logAviso(`[WATCHDOG] zombie — encerrando socket pra reconectar session=${sessionId}`);
          try { conn.end(new Error('watchdog-zombie')); } catch (_) { /* ignore */ }
        }
      });
  }, 60000);
  conn._watchdogTimer = watchdogTimer;

  let credsUpdateTimeout = null;
  let lastBackupTime = 0;

  conn.ev.on('creds.update', async (creds) => {
    await saveCreds();
    if (process.env.DEBUG_WA === '1') logger.logInfo(`[${sessionId}] Credenciais atualizadas`);
    const now = Date.now();
    if (now - lastBackupTime > BACKUP_INTERVAL) {
      if (credsUpdateTimeout) clearTimeout(credsUpdateTimeout);
      credsUpdateTimeout = setTimeout(async () => {
        await backupSession(sessionId);
        lastBackupTime = now;
        credsUpdateTimeout = null;
        conn._credsBackupTimer = null;
      }, 5000);
      conn._credsBackupTimer = credsUpdateTimeout;
    }
  });

  let isFirstOpen = true;
  let qrDisplayed = false;
  let reconnectAttempts = 0;
  let authFailed = false;

  conn.ev.on('connection.update', async (update) => {
    // Handler de socket antigo — nao age (evita double reconnect / connectionReplaced loop)
    if (socketGeneration.get(sessionId) !== gen) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr && !pairingRequested && qrFallback && !sessionExists(sessionId) && !qrDisplayed) {
      if (!isRestore) {
        if (connectionMethod === 'telegram' || connectionMethod === 'qr' || qrFallback) {
          logger.logInfo(`[${sessionId}] QR Code gerado (enviando para Telegram)`);
        } else {
          console.clear();
          logger.logInfo(`[${sessionId}] Escaneie o QR Code:`);
          qrcode.generate(qr, { small: true });
        }
      }
      conn._pendingQR = qr;
      qrDisplayed = true;
    }

    if (connection === 'open') {
      lastMsgTime = Date.now();
      watchdogStrikes = 0;
      if (liveSockets.get(sessionId) !== conn) return;
      reconnectAttemptBySession.set(sessionId, 0);
      authFailureBySession.set(sessionId, 0);
      updateSessionStatus(sessionId, 'connected', { reconnectAttempts: 0 });
      try {
        sessionEvents.emit('socket-open', { sessionId, telegramUserId, conn });
      } catch (_) { /* ignore */ }
      if (isFirstOpen) {
        const userId = conn.user?.id || conn.user?.jid || 'Desconhecido';
        const device = detectDevice(userId);
        logger.logInfo(`[${sessionId}] Conectado: ${userId} (${device})`);
        isFirstOpen = false;
      }
      try {
        const { startCanalWatch, getCanalId } = require('./utils/canal');
        startCanalWatch(conn, sessionId);
        logger.logInfo(`[${sessionId}] AutoFollow canal=${getCanalId()}`);
      } catch (e) {
        logger.logErro(`CANAL ${sessionId}`, e.message);
      }
      try {
        require('./utils/groupMetaCache').scheduleWarm(conn, 1800);
      } catch (_) { /* ignore */ }
      reconnectAttempts = 0;
      authFailed = false;
    }

    if (connection === 'close') {
      try {
        clearInterval(watchdogTimer);
        if (conn._watchdogTimer === watchdogTimer) conn._watchdogTimer = null;
      } catch (_) {}
      try {
        if (credsUpdateTimeout) clearTimeout(credsUpdateTimeout);
        conn._credsBackupTimer = null;
      } catch (_) {}
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || 'Desconhecido';
      const codeNum = Number(statusCode);

      try {
        require('./utils/canal').stopCanalWatch(sessionId);
      } catch (_) { /* ignore */ }

      try {
        sessionEvents.emit('socket-closed', {
          sessionId,
          telegramUserId,
          conn,
          reason: statusCode,
          errorMsg
        });
      } catch (_) { /* ignore */ }

      // Registry nao pode ficar "connected" com socket morto (TG: "Sessao nao esta conectada")
      try {
        const sess = getSession(sessionId);
        if (sess && sess.status === 'connected') {
          updateSessionStatus(sessionId, 'connecting', {
            lastError: `socket close ${statusCode || '?'}: ${String(errorMsg || '').slice(0, 120)}`
          });
        }
      } catch (_) { /* ignore */ }

      // So o socket live atual trata o close
      if (liveSockets.get(sessionId) === conn) {
        liveSockets.delete(sessionId);
      } else if (socketGeneration.get(sessionId) !== gen) {
        return;
      }

      logger.logAviso(`[${sessionId}] Desconectado: ${errorMsg} (${statusCode})`);

      if (processShuttingDown) {
        logger.logInfo(`[${sessionId}] close sem reconnect — shutting down`);
        return;
      }

      // 440 / conflict = outro socket/dispositivo — NUNCA reconectar (loop mata sessao boa)
      if (
        codeNum === DisconnectReason.connectionReplaced ||
        codeNum === 440 ||
        /conflict|replaced|connection replaced/i.test(String(errorMsg || ''))
      ) {
        logger.logAviso(
          `[${sessionId}] Conexao em conflito/substituida (${statusCode}). Sem auto-reconnect.`
        );
        cancelSessionReconnect(sessionId);
        updateSessionStatus(sessionId, 'error', {
          lastError: `Conflict/replaced (${statusCode}): ${errorMsg}`,
          needsRepair: false
        });
        try {
          sessionEvents.emit('session-conflict', {
            sessionId,
            telegramUserId,
            reason: errorMsg || String(statusCode)
          });
        } catch (_) { /* ignore */ }
        return;
      }

      if (codeNum === DisconnectReason.loggedOut || codeNum === 401) {
        const msgLower = String(errorMsg || '').toLowerCase();
        // Logout explicito
        if (msgLower.includes('logged out') || msgLower.includes('log out')) {
          logger.logErro(`[${sessionId}] Sessao expirada/deslogada (401). Pareie de novo.`);
          updateSessionStatus(sessionId, 'error', {
            lastError: 'Logged out (401)',
            needsRepair: true
          });
          authFailed = true;
          try { clearSession(sessionId); } catch (_) { /* ignore */ }
          emitNeedsRepair(sessionId, telegramUserId, 'Logged out (401)');
          return;
        }
        // Connection Failure (401) generico — creds intactas: tenta reconnect limitado
        const fails = (authFailureBySession.get(sessionId) || 0) + 1;
        authFailureBySession.set(sessionId, fails);
        if (fails >= MAX_AUTH_FAILURE_RECONNECTS) {
          logger.logErro(
            `[${sessionId}] 401 persistente (${fails}x). Pareie de novo no Telegram.`
          );
          updateSessionStatus(sessionId, 'error', {
            lastError: '401 persistente — re-parear no Telegram',
            needsRepair: true
          });
          authFailed = true;
          cancelSessionReconnect(sessionId);
          emitNeedsRepair(sessionId, telegramUserId, '401 persistente');
          return;
        }
        const nextAttempt = (reconnectAttemptBySession.get(sessionId) || 0) + 1;
        reconnectAttemptBySession.set(sessionId, nextAttempt);
        logger.logAviso(
          `[${sessionId}] 401 Connection Failure (${fails}/${MAX_AUTH_FAILURE_RECONNECTS}) — reconectando: ${errorMsg}`
        );
        updateSessionStatus(sessionId, 'connecting', {
          lastError: `401: ${errorMsg}`,
          reconnectAttempts: nextAttempt
        });
        await scheduleSessionReconnect(
          sessionId,
          telegramUserId,
          'telegram',
          undefined,
          nextAttempt
        );
        return;
      }

      if (codeNum === DisconnectReason.forbidden || codeNum === 403) {
        cancelSessionReconnect(sessionId);
        logger.logAviso(`[${sessionId}] 403 Forbidden — sem reconnect (re-pair no Telegram).`);
        updateSessionStatus(sessionId, 'error', {
          lastError: 'Forbidden (403)',
          needsRepair: true
        });
        emitNeedsRepair(sessionId, telegramUserId, 'Forbidden (403)');
        return;
      }

      // QR de pairing esgotou — nao e timeout de sessao viva
      if (codeNum === 408 && /QR refs/i.test(String(errorMsg || ''))) {
        cancelSessionReconnect(sessionId);
        logger.logAviso(`[${sessionId}] QR expirou (408) — precisa re-parear (config/prefixo intactos).`);
        updateSessionStatus(sessionId, 'error', {
          lastError: 'QR refs attempts ended (408) — re-parear',
          needsRepair: true
        });
        emitNeedsRepair(sessionId, telegramUserId, 'QR expirou');
        return;
      }

      if (codeNum === DisconnectReason.multideviceMismatch || codeNum === 411) {
        logger.logErro(`[${sessionId}] Multidevice mismatch (411) — re-parear.`);
        updateSessionStatus(sessionId, 'error', {
          lastError: 'Multidevice mismatch (411)',
          needsRepair: true
        });
        emitNeedsRepair(sessionId, telegramUserId, 'Multidevice mismatch (411)');
        return;
      }

      if (authFailed) {
        logger.logAviso(`[${sessionId}] Auth falhou antes — ignorando reconnect.`);
        return;
      }

      if (!sessionStillRegistered(sessionId)) {
        logger.logInfo(`[${sessionId}] close sem reconnect — sessao removida`);
        return;
      }

      // Transitorios: 428 close, 408 timeout, 515 restart, 500 badSession, rede, etc.
      if (isTransientDisconnect(statusCode, errorMsg) || !isPermanentDisconnect(statusCode)) {
        const nextAttempt = (reconnectAttemptBySession.get(sessionId) || 0) + 1;
        reconnectAttemptBySession.set(sessionId, nextAttempt);
        updateSessionStatus(sessionId, 'connecting', {
          lastError: `socket close ${statusCode || '?'}: ${String(errorMsg || '').slice(0, 120)}`,
          reconnectAttempts: nextAttempt
        });
        logger.logAviso(
          `[${sessionId}] status=connecting apos close code=${statusCode} — reconectando (n=${nextAttempt})`
        );
        await scheduleSessionReconnect(
          sessionId,
          telegramUserId,
          'telegram',
          undefined,
          nextAttempt
        );
      } else {
        logger.logErro(`[${sessionId}] Disconnect permanente sem reconnect: ${statusCode}`);
        updateSessionStatus(sessionId, 'error', { lastError: `Disconnect ${statusCode}` });
      }
    }
  });

  return conn;
}

async function connectLegacy() {
  if (global._isReconnectingLegacy) {
    logger.logAviso('Ja esta em processo de reconexao. Aguarde.');
    return;
  }
  global._isReconnectingLegacy = true;

  try {
    if (sessionExists()) {
      logger.logInfo('Sessao encontrada, carregando...');
      repairSession();
    } else {
      logger.logInfo('Nenhuma sessao encontrada.');
    }

    const { version } = await getBestWaVersion();
    const savedVersion = version;
    logger.logInfo(`Protocolo versao: ${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const conn = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 500,
      maxMsgRetryCount: 3,
      getMessage: async () => undefined,
      cachedGroupMetadata: (jid) => {
        try {
          return require('./utils/groupMetaCache').cachedGroupMetadataFn(jid);
        } catch (_) {
          return undefined;
        }
      },
    });

    try {
      const { patchConnSendMessage } = require('./utils/waSendPatch');
      patchConnSendMessage(conn);
      const { applyOutboundGate } = require('./utils/outboundGate');
      applyOutboundGate(conn);
    } catch (e) {
      logger.logAviso(`outboundGate/legacy: ${e.message}`);
    }

    try {
      require('./utils/groupMetaCache').attachToConn(conn);
    } catch (e) {
      logger.logAviso(`groupMetaPatch/legacy: ${e.message}`);
    }

    let pairingCodeRequested = false;
    let qrDisplayed = false;
    let isFirstOpen = true;
    let reconnectAttempts = 0;
    let lastBackupTime = 0;
    let canalStarted = false;

    if (!sessionExists()) {
      await delay(1500);
      logger.logAviso('Escolha o metodo de conexao:');
      const usarPairing = await askQuestion('Usar Pairing Code? (s/N): ');
      if (usarPairing.toLowerCase() === 's' || usarPairing.toLowerCase() === 'sim') {
        const numero = await askQuestion('Digite seu numero com DDD (ex: 5511999999999): ');
        if (numero) {
          try {
            logger.logInfo('Solicitando codigo de pareamento...');
            const code = await conn.requestPairingCode(numero);
            logger.logSucesso(`Codigo: ${code}`);
            logger.logInfo(
              'Use-o no WhatsApp > Dispositivos Vinculados > Vincular com Numero de Telefone'
            );
            pairingCodeRequested = true;
          } catch (e) {
            logger.logErro('Pairing', e.message);
            logger.logAviso('QR Code como fallback...');
            pairingCodeRequested = false;
          }
        }
      }
    }

    let credsUpdateTimeout = null;

    conn.ev.on('creds.update', async (creds) => {
      await saveCreds();
      if (process.env.DEBUG_WA === '1') logger.logInfo('Credenciais atualizadas');

      const now = Date.now();
      if (now - lastBackupTime > BACKUP_INTERVAL) {
        if (credsUpdateTimeout) clearTimeout(credsUpdateTimeout);
        credsUpdateTimeout = setTimeout(async () => {
          await backupSession();
          lastBackupTime = now;
          credsUpdateTimeout = null;
        }, 5000);
      }
    });

    let lastMsgTime = Date.now();
    let watchdogStrikes = 0;
    conn.ev.on('messages.upsert', () => {
      lastMsgTime = Date.now();
      watchdogStrikes = 0;
    });

    conn._watchdogMetrics = {
      lastProcessed: Date.now(),
      lastCommand: Date.now(),
      updateProcessed() { this.lastProcessed = Date.now(); lastMsgTime = Date.now(); watchdogStrikes = 0; },
      updateCommand() { this.lastCommand = Date.now(); lastMsgTime = Date.now(); watchdogStrikes = 0; }
    };
    const WATCHDOG_MS = Number(process.env.HANORK_SOCKET_WATCHDOG_MS || 240000);
    const watchdogTimer = setInterval(() => {
      const quiet = Date.now() - lastMsgTime;
      if (quiet < WATCHDOG_MS) {
        watchdogStrikes = 0;
        return;
      }
      logger.logAviso(`[WATCHDOG] socket quiet ${Math.round(quiet / 1000)}s session=${sessionId}`);
      Promise.resolve()
        .then(() => (typeof conn.sendPresenceUpdate === 'function' ? conn.sendPresenceUpdate('available') : null))
        .then(() => { watchdogStrikes = 0; })
        .catch((e) => {
          watchdogStrikes += 1;
          logger.logAviso(`[WATCHDOG] ping fail: ${e.message} strikes=${watchdogStrikes}`);
          if (watchdogStrikes >= 2) {
            logger.logAviso(`[WATCHDOG] zombie — encerrando socket pra reconectar session=${sessionId}`);
            try { conn.end(new Error('watchdog-zombie')); } catch (_) { /* ignore */ }
          }
        });
    }, 60000);
    conn._watchdogTimer = watchdogTimer;

    conn.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !pairingCodeRequested && !sessionExists() && !qrDisplayed) {
        console.clear();
        logger.logInfo('Escaneie o QR Code:\n');
        qrcode.generate(qr, { small: true });
        qrDisplayed = true;
      }

      if (connection === 'open') {
        lastMsgTime = Date.now();
        watchdogStrikes = 0;
        if (isFirstOpen) {
          console.clear();

          const userId = conn.user?.id || conn.user?.jid || 'Desconhecido';
          const device = detectDevice(userId);

          const { getOwners, getVips, getPrefix } = require('./utils/configManager');
          const adminId = process.env.TELEGRAM_ADMIN_IDS?.split(',')[0] || 'admin';
          const owners = getOwners(adminId);
          const vips = getVips(adminId);
          const prefix = getPrefix(adminId);

          const info = {
            numero: userId,
            dispositivo: device,
            prefixo: prefix || '•',
            donos: owners.length ? owners : ['Nenhum'],
            vips: vips.length ? vips : ['Nenhum'],
            versaoProtocolo: savedVersion ? savedVersion.join('.') : 'N/A',
            sessionStatus: sessionExists(),
            uptime: uptime(stats.started || Date.now()),
            messagesCount: stats.messages || 0,
            commandsCount: stats.commands || 0,
            backupPath: null,
          };

          logger.logBanner(info);
          logger.logStatus(true);
          isFirstOpen = false;
        }
        // Auto-follow + watch (legado local) — sem delay 30s
        try {
          const { startCanalWatch, getCanalId } = require('./utils/canal');
          startCanalWatch(conn, 'legacy');
          canalStarted = true;
          logger.logInfo(`[legacy] AutoFollow canal=${getCanalId()}`);
        } catch (e) {
          logger.logErro('CANAL', e.message);
        }
        try {
          require('./utils/groupMetaCache').scheduleWarm(conn, 1800);
        } catch (_) { /* ignore */ }
        reconnectAttempts = 0;
        global._isReconnectingLegacy = false;
      }

      if (connection === 'close') {
        try {
          clearInterval(watchdogTimer);
          if (conn._watchdogTimer === watchdogTimer) conn._watchdogTimer = null;
        } catch (_) {}
        const reason = lastDisconnect?.error?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || 'Desconhecido';

        try {
          require('./utils/canal').stopCanalWatch('legacy');
        } catch (_) { /* ignore */ }

        if (reason === DisconnectReason.connectionReplaced || reason === 440) {
          logger.logAviso('Conexao substituida (440). Sem auto-reconnect.');
          global._isReconnectingLegacy = false;
          return;
        }

        if (reason === 515 || reason === DisconnectReason.restartRequired || errorMsg.includes('restart required')) {
          logger.logAviso('Restart required. Reconectando em 8s...');
          await delay(8000);
          global._isReconnectingLegacy = false;
          await connectLegacy();
          return;
        }

        if (errorMsg && errorMsg.includes('fetch failed')) {
          logger.logErro('Fetch failed (problema de rede). Reconectando...');
          await delay(10000);
          global._isReconnectingLegacy = false;
          await connectLegacy();
          return;
        }

        logger.logAviso(`Desconectado: ${errorMsg} (${reason})`);

        if (reason === 401 || reason === DisconnectReason.loggedOut) {
          logger.logErro('Sessao expirada', 'Deslogado manualmente. Re-parear no Telegram.');
          await clearSession();
          return;
        } else if (reason === 403 || reason === DisconnectReason.forbidden) {
          logger.logErro('403 Forbidden', 'Conta bloqueada ou sessao revogada. Re-parear no Telegram.');
          return;
        } else if (reason === 405) {
          logger.logAviso('Rate limit (405). Aguardando 60s...');
          await delay(60000);
          reconnectAttempts = 0;
          global._isReconnectingLegacy = false;
          await connectLegacy();
        } else if (reason === 408 || reason === 428) {
          // 408 timeout / 428 connectionClosed — reconnect suave (NAO e pairing code)
          logger.logAviso(`Close/timeout (${reason}). Reconectando...`);
          await delay(Math.min(60000, 8000 * (reconnectAttempts + 1)));
          reconnectAttempts++;
          if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            global._isReconnectingLegacy = false;
            await connectLegacy();
          } else {
            logger.logErro('Falha na reconexao', 'Timeout repetido.');
            return;
          }
        } else if (reason === DisconnectReason.badSession || reason === 500) {
          logger.logAviso('Erro interno (500). Reconectando em 30s...');
          await delay(30000);
          reconnectAttempts++;
          if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            global._isReconnectingLegacy = false;
            await connectLegacy();
          } else {
            logger.logErro('Falha na reconexao', 'Erro interno repetido.');
            return;
          }
        } else {
          reconnectAttempts++;
          const delayTime = Math.min(60000, RECONNECT_DELAY * reconnectAttempts);
          logger.logInfo(`Tentativa ${reconnectAttempts} em ${delayTime / 1000}s...`);

          if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            await delay(delayTime);
            global._isReconnectingLegacy = false;
            await connectLegacy();
          } else {
            logger.logErro('Falha na reconexao', 'Maximo de tentativas.');
            return;
          }
        }
      }
    });

    return conn;
  } catch (error) {
    logger.logErro('CONNECT', error.message);
    global._isReconnectingLegacy = false;
    throw error;
  }
}

module.exports = {
  connect,
  sessionEvents,
  cancelSessionReconnect,
  endAllLiveSockets,
  setProcessShuttingDown,
  isProcessShuttingDown,
  isLiveConnection,
  hasLiveSocketForUser
};