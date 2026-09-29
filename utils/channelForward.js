// utils/channelForward.js
// Encaminhada de canal — mesmo padrao do Zero Two Beta (funciona nos downloads)
// Estado persistido em data/system/registry.json (campo forwardMode por sessao)
// FONTE UNICA do JID: utils/canal.js (CANAL_ID = baileys/canal.cjs)

const logger = require('../logger');
const {
  getSession,
  getAllSessions,
  updateSessionStatus
} = require('./sessionRegistry');
const { getCanalId, getCanalName, isLegacyCanalId } = require('./canal');

/** JID legado errado (causava "atualizacao encaminhada nao e valida") + hanork/infos antigo */
const LEGACY_BAD_CANAL_IDS = new Set([
  '120363428263139165@newsletter',
  '120363424111563088@newsletter'
]);

const sessionForwardMode = new Map();
let hydrated = false;

/**
 * Aceita so JID real: 120363...@newsletter
 * Rejeita codigo de convite (0029Vb...)
 */
function isValidNewsletterJid(jid) {
  return typeof jid === 'string' && /^\d{10,}@newsletter$/i.test(jid.trim());
}

function normalizeNewsletterJid(jid, fallback = getCanalId()) {
  const raw = String(jid || '').trim();
  if (
    isLegacyCanalId(raw) ||
    LEGACY_BAD_CANAL_IDS.has(raw.toLowerCase()) ||
    LEGACY_BAD_CANAL_IDS.has(raw)
  ) {
    logger.logAviso(
      `[FORWARD] JID legado invalido ${raw.slice(0, 40)} → ${getCanalId()}`
    );
    return getCanalId();
  }
  if (isValidNewsletterJid(raw)) return raw;
  if (raw && raw.includes('@newsletter')) {
    logger.logAviso(
      `[FORWARD] JID invalido (use numerico, nao convite 0029...): ${raw.slice(0, 48)} → fallback`
    );
  }
  const fb = fallback || getCanalId();
  return isValidNewsletterJid(fb) ? fb : getCanalId();
}

function hydrateFromRegistry() {
  if (hydrated) return;
  try {
    for (const s of getAllSessions()) {
      sessionForwardMode.set(s.sessionId, s.forwardMode === true);
    }
    hydrated = true;
    logger.logInfo(`[FORWARD] Cache hidratado: ${sessionForwardMode.size} sessao(oes)`);
  } catch (e) {
    logger.logErro('[FORWARD] Falha ao hidratar cache:', e.message);
  }
}

function persistForwardMode(sessionId, enabled) {
  const session = getSession(sessionId);
  if (!session) {
    logger.logAviso(`[FORWARD ${sessionId}] Sessao nao encontrada no registry — so cache RAM`);
    return false;
  }
  try {
    updateSessionStatus(sessionId, session.status || 'unknown', {
      forwardMode: !!enabled,
      forwardModeUpdatedAt: Date.now()
    });
    return true;
  } catch (e) {
    logger.logErro(`[FORWARD ${sessionId}] Persistencia falhou: ${e.message}`);
    return false;
  }
}

function shouldForwardAsChannel(sessionId) {
  if (!sessionId) return false;
  return isForwardModeEnabled(sessionId);
}

/**
 * Mesmo formato do Zero Two Beta (sendzerochannelText / downloads):
 * { forwardingScore, isForwarded, forwardedNewsletterMessageInfo: { newsletterJid, newsletterName } }
 * SEM serverMessageId, SEM forwardOrigin, SEM contentType — esses campos geram
 * "A atualizacao encaminhada nao e valida" no WhatsApp.
 */
function buildChannelContextInfo(newsletterJid = getCanalId(), newsletterName = getCanalName()) {
  const jid = normalizeNewsletterJid(newsletterJid);
  const name = newsletterName || getCanalName();
  return {
    forwardingScore: 999,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
      newsletterJid: jid,
      newsletterName: name
    }
  };
}

function injectChannelContext(content, newsletterJid, newsletterName) {
  if (!content || typeof content !== 'object') return content;
  const channelCtx = buildChannelContextInfo(newsletterJid, newsletterName);
  const prev = { ...(content.contextInfo || {}) };
  // Limpa campos que quebram (Zero Two nao usa)
  delete prev.forwardOrigin;
  if (prev.forwardedNewsletterMessageInfo) {
    delete prev.forwardedNewsletterMessageInfo.serverMessageId;
    delete prev.forwardedNewsletterMessageInfo.contentType;
  }
  return {
    ...content,
    contextInfo: {
      ...prev,
      forwardingScore: channelCtx.forwardingScore,
      isForwarded: true,
      forwardedNewsletterMessageInfo: {
        newsletterJid: channelCtx.forwardedNewsletterMessageInfo.newsletterJid,
        newsletterName: channelCtx.forwardedNewsletterMessageInfo.newsletterName
      }
    }
  };
}

function setForwardMode(sessionId, enabled) {
  hydrateFromRegistry();
  const on = !!enabled;
  sessionForwardMode.set(sessionId, on);
  const ok = persistForwardMode(sessionId, on);
  logger.logInfo(
    `[FORWARD ${sessionId}] Modo ${on ? 'OFF (encaminhado)' : 'ON (normal)'} ` +
    `${ok ? 'persistido' : 'apenas em memoria'}`
  );
}

function isForwardModeEnabled(sessionId) {
  hydrateFromRegistry();
  if (sessionForwardMode.has(sessionId)) {
    return sessionForwardMode.get(sessionId) === true;
  }
  const session = getSession(sessionId);
  const enabled = session?.forwardMode === true;
  sessionForwardMode.set(sessionId, enabled);
  return enabled;
}

function applyForwardMode(content, sessionId, opts = {}) {
  if (!content) return content;
  const force = opts.force === true;
  if (!force && !shouldForwardAsChannel(sessionId)) {
    return content;
  }
  const jid = normalizeNewsletterJid(opts.newsletterJid || getCanalId());
  const name = opts.newsletterName || getCanalName();
  logger.logInfo(`[FORWARD ${sessionId || 'n/a'}] Aplicando canal ZeroTwo-style ${jid}`);
  return injectChannelContext(content, jid, name);
}

/** Envia ja com selo de canal (igual .play). skipForward evita aplicar 2x no patch. */
async function sendAsChannel(conn, jid, content, options = {}) {
  const sid = conn?._sessionId || options.sessionId;
  const payload = applyForwardMode(content, sid, { force: true });
  const dest = String(jid || '');
  const kind = dest.includes('@lid')
    ? 'lid'
    : dest.endsWith('@g.us')
      ? 'group'
      : /@(s\.whatsapp\.net|c\.us)$/.test(dest)
        ? 'pn'
        : 'other';
  logger.logInfo(`[FORWARD ${sid || 'n/a'}] send kind=${kind}`);
  return conn.sendMessage(dest, payload, {
    skipForward: true,
    _hanorkTrusted: true,
    ...(options.quoted ? { quoted: options.quoted } : {})
  });
}

function clearForwardMode(sessionId) {
  hydrateFromRegistry();
  sessionForwardMode.set(sessionId, false);
  persistForwardMode(sessionId, false);
  sessionForwardMode.delete(sessionId);
  logger.logInfo(`[FORWARD ${sessionId}] Modo removido (persistido ON)`);
}

function getForwardModeStatus(sessionId) {
  return shouldForwardAsChannel(sessionId) ? 'OFF' : 'ON';
}

function restoreForwardModesFromRegistry() {
  hydrated = false;
  sessionForwardMode.clear();
  hydrateFromRegistry();
}

module.exports = {
  setForwardMode,
  isForwardModeEnabled,
  shouldForwardAsChannel,
  buildChannelContextInfo,
  injectChannelContext,
  applyForwardMode,
  sendAsChannel,
  clearForwardMode,
  getForwardModeStatus,
  restoreForwardModesFromRegistry,
  normalizeNewsletterJid,
  isValidNewsletterJid,
  /** live — sempre o CANAL_ID atual (env ou default) */
  get CHANNEL_JID() {
    return getCanalId();
  },
  get CHANNEL_NAME() {
    return getCanalName();
  },
  LEGACY_BAD_CANAL_IDS
};
