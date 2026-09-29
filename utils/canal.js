// utils/canal.js — fonte unica do canal oficial (auto-follow + modo OFF)
// Preferir este modulo + WHATSAPP_CANAL_ID. Nao usar @systemzero/baileys/canal.cjs (legado hardcoded).
'use strict';

const logger = require('../logger');

/** JID numerico oficial — NAO duplicar literal em outros arquivos */
const CANAL_ID = '120363412971004933@newsletter';
const CANAL_NAME = 'תחילת הסוף';
/** Convite publico do canal תחילת הסוף */
const HANORK_CHANNEL_INVITE = '0029Vb98rNz96H4STInGBr2W';
const HANORK_CHANNEL_LINK = `https://whatsapp.com/channel/${HANORK_CHANNEL_INVITE}`;

/** hanork/infos e JIDs mortos — getCanalId() / encaminhada remapam pro atual */
const LEGACY_CANAL_IDS = new Set([
  '120363424111563088@newsletter',
  '120363428263139165@newsletter'
]);
const LEGACY_CANAL_INVITES = new Set([
  '0029VbCWEVRHgZWmoZrsdE3G'
]);

const followInFlight = new Set();
const checkTimers = new Map(); // sessionId -> intervalHandle

function isLegacyCanalId(jid) {
  const raw = String(jid || '').trim();
  if (!raw) return false;
  return LEGACY_CANAL_IDS.has(raw) || LEGACY_CANAL_IDS.has(raw.toLowerCase());
}

function getCanalId() {
  const env = String(process.env.WHATSAPP_CANAL_ID || '').trim();
  if (/^\d{10,}@newsletter$/i.test(env) && !isLegacyCanalId(env)) return env;
  return CANAL_ID;
}

function getCanalName() {
  const env = String(process.env.WHATSAPP_CANAL_NAME || '').trim();
  if (env && !/^hanork\/infos$/i.test(env)) return env;
  return CANAL_NAME;
}

function getCanalLink() {
  const env = String(process.env.WHATSAPP_CANAL_LINK || '').trim();
  if (/^https?:\/\/(?:www\.)?whatsapp\.com\/channel\/[A-Za-z0-9_-]+/i.test(env)) {
    const code = (env.match(/channel\/([A-Za-z0-9_-]+)/i) || [])[1] || '';
    if (!LEGACY_CANAL_INVITES.has(code)) return env;
  }
  return HANORK_CHANNEL_LINK;
}

function getCanalInviteCode() {
  const link = getCanalLink();
  const m = String(link).match(/channel\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : HANORK_CHANNEL_INVITE;
}

/** Texto publico curto (menu). Sem convite 0029 antigo. */
function formatCanalPublicText() {
  const name = getCanalName();
  const link = getCanalLink();
  const id = getCanalId();
  if (link) return `${name}\n${link}`;
  return `${name}\n${id}`;
}

/** Copy do canal (bio / post). Sem link no corpo — o convite fica no botao ou no header do Zap. */
function formatCanalAboutText() {
  return (
    'Se voce veio procurar logica, chegou no lugar errado.\n\n' +
    'Aqui a conversa e outra: quem te observa, o que ja vazou, e como nao misturar sua vida num so lugar.\n\n' +
    '• Como te acham mesmo quando voce acha que esta escondido\n' +
    '• Golpe, conversa maliciosa e o que da pra ver em publico\n' +
    '• VPN, Tor, proxy e como separar identidade — na pratica\n' +
    '• Vazamento, dark web e rastro digital. Sem enrolacao.\n\n' +
    'Todo dia tem post. Sem conversa fiada.'
  );
}

/** Troca JID/convite/nome do canal vendido pelo atual. Nao mexe em exploits. */
function rewriteLegacyCanalText(value) {
  if (value == null || typeof value !== 'string') return value;
  let out = value;
  const link = getCanalLink();
  const id = getCanalId();
  const name = getCanalName();
  const newCode = getCanalInviteCode();
  for (const inv of LEGACY_CANAL_INVITES) {
    const reUrl = new RegExp(
      `(?:https?:\\/\\/(?:www\\.)?)?(?:wa\\.me\\/channel\\/|whatsapp\\.com\\/channel\\/)${inv}`,
      'gi'
    );
    out = out.replace(reUrl, link);
    if (inv && newCode && inv !== newCode) {
      out = out.split(inv).join(newCode);
    }
  }
  for (const oldId of LEGACY_CANAL_IDS) {
    if (oldId) out = out.split(oldId).join(id);
  }
  out = out.replace(/\bhanork\s*\/\s*infos\.?\b/gi, name);
  return out;
}

function rewriteLegacyCanalInConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { cfg, changed: false };
  let changed = false;
  const str = (s) => {
    if (typeof s !== 'string') return s;
    const n = rewriteLegacyCanalText(s);
    if (n !== s) changed = true;
    return n;
  };
  for (const k of ['texto', 'textoStatus', 'textoPay']) {
    if (typeof cfg[k] === 'string') cfg[k] = str(cfg[k]);
  }
  const walkCta = (c) => {
    if (!c || typeof c !== 'object') return;
    for (const k of ['texto', 'url', 'url2', 'label', 'label2']) {
      if (typeof c[k] === 'string') c[k] = str(c[k]);
    }
  };
  walkCta(cfg.cta);
  if (cfg.divSlots && typeof cfg.divSlots === 'object') {
    for (const track of Object.keys(cfg.divSlots)) {
      const bag = cfg.divSlots[track];
      if (!bag || typeof bag !== 'object') continue;
      for (const id of Object.keys(bag)) {
        const slot = bag[id];
        if (!slot || typeof slot !== 'object') continue;
        for (const k of ['texto', 'textoStatus', 'url', 'url2', 'label', 'label2']) {
          if (typeof slot[k] === 'string') slot[k] = str(slot[k]);
        }
      }
    }
  }
  return { cfg, changed };
}

function getCheckIntervalMs() {
  const n = Number(process.env.CANAL_CHECK_INTERVAL_MS);
  if (Number.isFinite(n) && n >= 30000) return n;
  return 5 * 60 * 1000; // 5 min
}

/**
 * Segue o canal oficial (API Baileys newsletterFollow).
 * @returns {Promise<boolean>}
 */
async function followCanal(conn, canalId = getCanalId()) {
  try {
    if (!conn?.user) {
      logger.logAviso('[AutoFollow] Bot nao conectado — ignorando');
      return false;
    }
    const id = canalId || getCanalId();
    await conn.newsletterFollow(id);
    logger.logInfo(`[AutoFollow] Canal seguido: ${id}`);
    return true;
  } catch (e) {
    logger.logAviso(`[AutoFollow] Falha follow: ${e.message}`);
    return false;
  }
}

/**
 * Verifica se consegue ler metadata do canal (proxy de "seguindo"/acesso).
 * Usa newsletterMetadata('jid', id) — API correta do fork.
 */
async function isFollowingCanal(conn, canalId = getCanalId()) {
  try {
    if (!conn?.user || typeof conn.newsletterMetadata !== 'function') return false;
    const id = canalId || getCanalId();
    const meta = await conn.newsletterMetadata('jid', id);
    return !!meta;
  } catch (e) {
    return false;
  }
}

/**
 * Garante follow: se nao estiver seguindo, chama follow.
 * Concorrencia: 1 op por sessionId.
 */
async function ensureCanalFollow(conn, sessionId = 'default') {
  const key = String(sessionId || 'default');
  if (followInFlight.has(key)) return false;
  followInFlight.add(key);
  try {
    const id = getCanalId();
    const ok = await isFollowingCanal(conn, id);
    if (ok) {
      logger.logInfo(`[AutoFollow] OK ja segue/acessa ${id} session=${key}`);
      return true;
    }
    logger.logAviso(`[AutoFollow] Nao segue — tentando follow session=${key}`);
    return await followCanal(conn, id);
  } finally {
    followInFlight.delete(key);
  }
}

function stopCanalWatch(sessionId) {
  const key = String(sessionId || '');
  const t = checkTimers.get(key);
  if (t) {
    clearInterval(t);
    checkTimers.delete(key);
    logger.logInfo(`[AutoFollow] Watch parado session=${key}`);
  }
}

/**
 * Intervalo periodico por sessao + checagem imediata.
 */
function startCanalWatch(conn, sessionId) {
  const key = String(sessionId || 'default');
  stopCanalWatch(key);
  const ms = getCheckIntervalMs();

  const tick = async () => {
    try {
      if (!conn?.user) return;
      await ensureCanalFollow(conn, key);
    } catch (e) {
      logger.logAviso(`[AutoFollow] tick erro session=${key}: ${e.message}`);
    }
  };

  // imediato (apos open/reconnect)
  setTimeout(() => { tick(); }, 1500);

  const handle = setInterval(tick, ms);
  if (typeof handle.unref === 'function') handle.unref();
  checkTimers.set(key, handle);
  logger.logInfo(`[AutoFollow] Watch ativo session=${key} interval=${ms}ms canal=${getCanalId()}`);
}

module.exports = {
  CANAL_ID,
  CANAL_NAME,
  HANORK_CHANNEL_INVITE,
  HANORK_CHANNEL_LINK,
  LEGACY_CANAL_IDS,
  isLegacyCanalId,
  getCanalLink,
  getCanalInviteCode,
  getCanalId,
  getCanalName,
  formatCanalPublicText,
  formatCanalAboutText,
  rewriteLegacyCanalText,
  rewriteLegacyCanalInConfig,
  getCheckIntervalMs,
  followCanal,
  canal: followCanal, // alias do modulo baileys
  isFollowingCanal,
  ensureCanalFollow,
  startCanalWatch,
  stopCanalWatch
};
