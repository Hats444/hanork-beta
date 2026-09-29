'use strict';
/**
 * Clique de botao/lista:
 * - so a sessao que MANDOU o menu processa (2 chips no mesmo grupo nao competem)
 * - debounce 2s no mesmo id (WA manda o clique 2x e o toggle desfaz)
 */
const { jidNormalizedUser } = require('@systemzero/baileys');

const MENU_TTL_MS = 45 * 60 * 1000;
const DEBOUNCE_MS = 2000;
const CLICK_CLAIM_MS = 45_000;
const menuIds = new Map(); // `${bot}|${id}` -> expiresAt
const joinAlerts = new Map(); // `${bot}|${gid}` -> expiresAt
const panelOps = new Map(); // `${bot}|${chat}|${person}` -> expiresAt
const claimedClicks = new Map(); // waMessageId -> { bot, at }
const globalDebounce = new Map(); // `${chat}|${sender}|${btnId}` -> ts

function botKey(conn) {
  return String(conn?.user?.id || conn?.user?.jid || conn?._sessionId || '').split(':')[0];
}

function pruneMenuIds() {
  const now = Date.now();
  for (const map of [menuIds, joinAlerts, panelOps]) {
    for (const [id, exp] of map) {
      if (exp < now) map.delete(id);
    }
    while (map.size > 4000) {
      const first = map.keys().next().value;
      map.delete(first);
    }
  }
  for (const [id, rec] of claimedClicks) {
    if (!rec || now - rec.at > CLICK_CLAIM_MS) claimedClicks.delete(id);
  }
  while (claimedClicks.size > 4000) {
    const first = claimedClicks.keys().next().value;
    claimedClicks.delete(first);
  }
  for (const [k, ts] of globalDebounce) {
    if (now - ts > DEBOUNCE_MS * 8) globalDebounce.delete(k);
  }
}

function otherChipHasMenu(conn) {
  const b = botKey(conn);
  if (!b) return false;
  const prefix = `${b}|`;
  for (const map of [menuIds, joinAlerts, panelOps]) {
    for (const k of map.keys()) {
      if (k.includes('|') && !k.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** 2 chips no mesmo grupo: so o primeiro processa este clique WA. */
function claimWaClick(conn, info) {
  const mid = String(info?.key?.id || '').trim();
  if (!mid) return true;
  pruneMenuIds();
  const b = botKey(conn);
  const now = Date.now();
  const prev = claimedClicks.get(mid);
  if (prev && prev.bot && b && prev.bot !== b && now - prev.at < CLICK_CLAIM_MS) {
    return false;
  }
  claimedClicks.set(mid, { bot: b || '?', at: now });
  return true;
}

function rememberJoinAlert(conn, groupJid) {
  const b = botKey(conn);
  const g = String(groupJid || '');
  if (!b || !g.endsWith('@g.us')) return;
  pruneMenuIds();
  joinAlerts.set(`${b}|${g}`, Date.now() + MENU_TTL_MS);
}

function sentJoinAlertHere(conn, groupJid) {
  const b = botKey(conn);
  const g = String(groupJid || '');
  if (!b || !g) return false;
  const exp = joinAlerts.get(`${b}|${g}`);
  if (!exp) return false;
  if (exp < Date.now()) {
    joinAlerts.delete(`${b}|${g}`);
    return false;
  }
  return true;
}

function personKey(jid) {
  return String(jid || '').split(':')[0].trim().toLowerCase();
}

function rememberPanelOperator(conn, chatJid, senderJid) {
  const b = botKey(conn);
  const chat = String(chatJid || '');
  const person = personKey(senderJid);
  if (!b || !chat || !person) return;
  pruneMenuIds();
  panelOps.set(`${b}|${chat}|${person}`, Date.now() + MENU_TTL_MS);
}

function isPanelOperator(conn, chatJid, senderJid, extraIds = []) {
  const b = botKey(conn);
  const chat = String(chatJid || '');
  if (!b || !chat) return false;
  const ids = [senderJid, ...(Array.isArray(extraIds) ? extraIds : [])].map(personKey).filter(Boolean);
  const now = Date.now();
  for (const person of ids) {
    const k = `${b}|${chat}|${person}`;
    const exp = panelOps.get(k);
    if (!exp) continue;
    if (exp < now) {
      panelOps.delete(k);
      continue;
    }
    return true;
  }
  try {
    const { sameParticipant } = require('./moderation');
    const prefix = `${b}|${chat}|`;
    for (const [k, exp] of panelOps) {
      if (!k.startsWith(prefix) || exp < now) continue;
      const stored = k.slice(prefix.length);
      if (ids.some((id) => sameParticipant(id, stored))) return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

function rememberMenuId(id, conn) {
  const s = String(id || '').trim();
  const b = botKey(conn);
  if (!s || s.length < 4) return;
  pruneMenuIds();
  const key = b ? `${b}|${s}` : s;
  menuIds.set(key, Date.now() + MENU_TTL_MS);
}

function isRememberedMenuId(id, conn) {
  const s = String(id || '').trim();
  if (!s) return false;
  const b = botKey(conn);
  const key = b ? `${b}|${s}` : s;
  const exp = menuIds.get(key);
  if (!exp) return false;
  if (exp < Date.now()) {
    menuIds.delete(key);
    return false;
  }
  return true;
}

function hasSentMenuThisBoot(conn) {
  const b = botKey(conn);
  if (!b) return menuIds.size > 0;
  const prefix = `${b}|`;
  for (const k of menuIds.keys()) {
    if (k.startsWith(prefix)) return true;
  }
  return false;
}

function clickContextInfo(message) {
  if (!message || typeof message !== 'object') return {};
  return (
    message.interactiveResponseMessage?.contextInfo ||
    message.buttonsResponseMessage?.contextInfo ||
    message.listResponseMessage?.contextInfo ||
    message.templateButtonReplyMessage?.contextInfo ||
    {}
  );
}

function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us');
}

/**
 * O menu clicado foi enviado por ESTE socket?
 * PV: sim (1:1 com este numero). Grupo: precisa de prova (stanzaId nosso ou participant = bot).
 */
function isOwnMenuClick(conn, info, message) {
  const remote = String(info?.key?.remoteJid || '');
  if (!isGroupJid(remote)) return true;

  const ctxInfo = clickContextInfo(message);
  const stanzaId = String(ctxInfo.stanzaId || ctxInfo.stanzaID || '').trim();
  if (stanzaId && isRememberedMenuId(stanzaId, conn)) return true;

  const quotedKey = info?.quoted?.key || message?.quoted?.key;
  if (quotedKey?.fromMe) return true;

  const botJid = conn?.user?.id || conn?.user?.jid || conn?.user?.lid || '';
  const botLid = conn?.user?.lid || conn?.authState?.creds?.me?.lid || '';
  const menuSender = ctxInfo.participant || ctxInfo.participantPn || ctxInfo.participantAlt || '';
  if (botJid && menuSender) {
    try {
      const { sameParticipant } = require('./moderation');
      if (sameParticipant(menuSender, botJid)) return true;
      if (sameParticipant(menuSender, jidNormalizedUser(botJid))) return true;
      if (botLid && sameParticipant(menuSender, botLid)) return true;
    } catch (_) { /* ignore */ }
    // Participant do menu e de outro chip — nao processa
    return false;
  }

  // Cliente sem participant: so processa se ainda nao mandamos menu (boot) ou se o id bate
  return !hasSentMenuThisBoot(conn);
}

/**
 * Clique do painel .gpseguranca (nativeFlow muitas vezes vem sem stanzaId).
 */
function isGeneralNavClick(btnId) {
  return /^(stats|stats_refresh|ping|menu|menu_stats|menu_comandos)$/i.test(String(btnId || ''));
}

function isFailOpenPanelClick(btnId) {
  const id = String(btnId || '');
  if (isGeneralNavClick(id)) return true;
  if (/^(gm_|div_|osint_|cmd_grupos)/i.test(id)) return true;
  if (/^cmd_(menu_dk|dkmenu|menudk|dkpay|msgdkpay|msgdk|fotodk|listfotodk|rmfotodk|dkmidia|videodk|apagardk|qtddk|entrardk|dk)$/i.test(id)) {
    return true;
  }
  return isGpsegurancaClick(id);
}

function isGpsegurancaClick(btnId) {
  const id = String(btnId || '');
  if (/^(protset_|ps_|info_|prot_atk_)/i.test(id)) return true;
  if (!/^cmd_/i.test(id)) return false;
  const name = id.slice(4);
  if (/^(menu|protecoesativas|gpseguranca|modenable|moddisable|modlist|odelete|anticall|antipv|antipv2|antipv3)$/i.test(name)) {
    return true;
  }
  try {
    const { findSecurityItem } = require('./securityMenu');
    return !!findSecurityItem(id) || !!findSecurityItem(name);
  } catch (_) {
    return /^cmd_(anti|surf|bemvindo|saiu|auto|bangp|limite|mute|desmute|adv|ban|kick|cita|limpar|list|soadm|onlyadm|blockgp|dono|transf|add|rem|hist|fechar|abrir|promov|rebaix|welcome|legenda|preset)/i.test(id);
  }
}

/**
 * @returns {{ handle: boolean, reason?: string }}
 */
function shouldHandleInteractiveClick(conn, info, sessionState, opts = {}) {
  const { unwrapWaMessage, extractInteractiveId } = require('../contextParser');
  const message = unwrapWaMessage(info?.message) || info?.message || {};
  const btnId = String(opts.buttonId || extractInteractiveId(message) || '').trim();
  if (!btnId) return { handle: false, reason: 'empty_id' };

  if (/^join_(accept|reject)/i.test(btnId)) {
    let ours = isOwnMenuClick(conn, info, message);
    if (!ours) {
      const remote = String(info?.key?.remoteJid || '');
      if (sentJoinAlertHere(conn, remote)) ours = true;
    }
    if (!ours) {
      const ctxInfo = clickContextInfo(message);
      const menuSender = ctxInfo.participant || ctxInfo.participantPn || '';
      const botJid = conn?.user?.id || conn?.user?.jid || conn?.user?.lid || '';
      if (botJid && menuSender) {
        try {
          const { sameParticipant } = require('./moderation');
          if (sameParticipant(menuSender, botJid)) ours = true;
        } catch (_) { /* ignore */ }
      }
    }
    if (!ours) return { handle: false, reason: 'not_our_join_alert' };
    if (!claimWaClick(conn, info)) return { handle: false, reason: 'other_chip_click' };
    return { handle: true };
  }

  const ownMenu = isOwnMenuClick(conn, info, message);
  if (!ownMenu) {
    // Painel do dono (gm/div): clique nativo muitas vezes vem sem stanzaId/participant.
    // Fail-open so neste chip se ELE mandou o painel; senao o 2o chip compete no IQ.
    if (!isFailOpenPanelClick(btnId)) {
      return { handle: false, reason: 'not_our_menu' };
    }
    const sender = String(info?.key?.participant || info?.key?.remoteJid || '');
    const extras = [
      info?.key?.participantPn,
      info?.key?.participantAlt,
      info?.key?.senderPn,
      info?.key?.remoteJidAlt
    ];
    const panelHere = hasSentMenuThisBoot(conn)
      || isPanelOperator(conn, info?.key?.remoteJid, sender, extras);
    if (!panelHere && otherChipHasMenu(conn)) {
      return { handle: false, reason: 'other_chip_menu' };
    }
  }

  if (!claimWaClick(conn, info)) return { handle: false, reason: 'other_chip_click' };

  const chat = String(info?.key?.remoteJid || '');
  const sender = String(info?.key?.participant || info?.key?.remoteJid || '');
  const key = `${chat}|${sender}|${btnId}`;
  if (!sessionState.buttonDebounce) sessionState.buttonDebounce = new Map();
  const now = Date.now();
  const debounceMs = /^(div_confirm_iniciar_|div_tipo_)/i.test(btnId) || btnId === 'div_iniciar'
    ? 8000
    : /^(protset_|ps_|cmd_modenable|cmd_moddisable|cmd_antilink|cmd_anti)/i.test(btnId)
      ? 4500
      : DEBOUNCE_MS;
  const prevLocal = sessionState.buttonDebounce.get(key) || 0;
  const prevGlobal = globalDebounce.get(key) || 0;
  if (now - prevLocal < debounceMs || now - prevGlobal < debounceMs) {
    return { handle: false, reason: 'debounce' };
  }
  sessionState.buttonDebounce.set(key, now);
  globalDebounce.set(key, now);
  if (sessionState.buttonDebounce.size > 400) {
    for (const [k, ts] of sessionState.buttonDebounce) {
      if (now - ts > DEBOUNCE_MS * 4) sessionState.buttonDebounce.delete(k);
    }
  }
  return { handle: true, reason: ownMenu ? undefined : 'owner_panel_failopen' };
}

module.exports = {
  rememberMenuId,
  isRememberedMenuId,
  rememberJoinAlert,
  sentJoinAlertHere,
  rememberPanelOperator,
  isPanelOperator,
  shouldHandleInteractiveClick,
  isOwnMenuClick,
  isGpsegurancaClick,
  isGeneralNavClick,
  DEBOUNCE_MS
};
