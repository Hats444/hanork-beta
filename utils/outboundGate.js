'use strict';
/**
 * Gates outbound OBRIGATORIOS — bot nao vira arma.
 * Sem toggle. Inventario: docs/AUDITORIA-VIVA.md (secao Baileys Zero §2/§7/§11).
 *
 * Uso interno: passar options._hanorkTrusted = true em relay/sendMessage
 * quando o fluxo for legitimo (safeRelay, div, Valley, exploits owner).
 */
const logger = require('../logger');

const HZXX_BLOCKED = Object.freeze([
  'handleAlbum',
  'handleEvent',
  'handlePayment',
  'handlePollResult',
  'handleGroupStory'
]);

const RICH_BLOCKED = Object.freeze([
  'sendPerplexity',
  'sendRich',
  'sendRichText',
  'sendRichCode',
  'sendRichList',
  'sendRichTable',
  'sendRichFull',
  'sendRichReels'
]);

const BLOCKED_SEND_KEYS = Object.freeze([
  'albumMessage',
  'pollResultMessage',
  'groupStatusMessage',
  'groupStatusMessageV2'
]);

/** Rate buckets: key → { n, t0 } */
const rateBuckets = new Map();

function rateAllow(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now - b.t0 > windowMs) {
    b = { n: 0, t0: now };
    rateBuckets.set(key, b);
  }
  b.n += 1;
  // poda periodica — buckets velhos sob churn de sessao
  if (rateBuckets.size > 400) {
    for (const [k, v] of rateBuckets) {
      if (!v || now - v.t0 > Math.max(windowMs, 120000)) rateBuckets.delete(k);
    }
  }
  return b.n <= max;
}

function deny(name, detail) {
  const err = new Error(`[outboundGate] ${name} blocked${detail ? `: ${detail}` : ''}`);
  err.code = 'OUTBOUND_GATE';
  logger.logAviso(err.message);
  throw err;
}

/** Remove so pessoa (PN/LID). Nunca grupo/canal/broadcast. */
function isKickableParticipant(j) {
  const s = String(j || '');
  if (!s) return false;
  if (s.endsWith('@g.us') || s.endsWith('@newsletter') || s.endsWith('@broadcast')) return false;
  return s.endsWith('@s.whatsapp.net') || s.endsWith('@lid') || s.endsWith('@c.us');
}

function stubAsync(name) {
  return async () => deny(name, 'disabled permanently');
}

function patchHzxx(conn) {
  const hz = conn.hzxx;
  if (!hz || typeof hz !== 'object') return;
  for (const m of HZXX_BLOCKED) {
    if (typeof hz[m] === 'function') {
      hz[m] = async () => deny(`hzxx.${m}`);
    }
  }
}

function patchRichHelpers(conn) {
  for (const name of RICH_BLOCKED) {
    if (typeof conn[name] === 'function') {
      conn[name] = stubAsync(name);
    }
  }
}

function stripUntrustedRelayOpts(opts) {
  const next = { ...(opts || {}) };
  delete next.filter;
  delete next.participant;
  delete next.statusJidList;
  delete next.additionalAttributes;
  delete next.additionalNodes;
  return next;
}

/**
 * @param {object} conn — socket Baileys
 */
function applyOutboundGate(conn) {
  if (!conn || conn._hanorkOutboundGated) return conn;

  patchHzxx(conn);
  patchRichHelpers(conn);

  // sendMessage: sem filter dirigido; sem content hzxx perigoso; payment so com allow
  if (typeof conn.sendMessage === 'function') {
    const origSend = conn.sendMessage.bind(conn);
    conn.sendMessage = async (jid, content, options = {}) => {
      const opts = { ...(options || {}) };
      const trusted = !!opts._hanorkTrusted;
      delete opts._hanorkTrusted;

      if (!trusted) {
        if (opts.filter) {
          logger.logAviso('[outboundGate] stripped sendMessage.filter');
          delete opts.filter;
        }
        if (content && typeof content === 'object') {
          for (const k of BLOCKED_SEND_KEYS) {
            if (content[k]) deny('sendMessage', k);
          }
          if (content.requestPaymentMessage && !opts._hanorkAllowPayment) {
            deny('sendMessage', 'requestPaymentMessage');
          }
        }
        // Rate midia generica (menus com foto usam upload — teto maior; trusted isento)
        const sid = conn._sessionId || 'na';
        if (!trusted && content && (content.image || content.video || content.document || content.audio)) {
          if (!rateAllow(`media:${sid}`, 80, 60_000)) {
            deny('sendMessage', 'media rate-limit');
          }
        }
      }

      return origSend(jid, content, opts);
    };
  }

  // relayMessage: opts dirigidos / attrs so com trust
  if (typeof conn.relayMessage === 'function') {
    const origRelay = conn.relayMessage.bind(conn);
    conn.relayMessage = async (jid, message, options = {}) => {
      const raw = { ...(options || {}) };
      const trusted = !!raw._hanorkTrusted || !!conn._hanorkOwnerRelay;
      delete raw._hanorkTrusted;
      delete raw._hanorkAllowPayment;

      const opts = trusted ? raw : stripUntrustedRelayOpts(raw);
      if (!trusted && (options?.filter || options?.participant || options?.statusJidList)) {
        logger.logAviso('[outboundGate] stripped untrusted relay directed opts');
      }

      const sid = conn._sessionId || 'na';
      // Fluxos internos (menu/list/safeRelay) nao competem com o teto anti-arma.
      // Sweep banall (apagar msgs do alvo) tambem nao: o teto 180 IQ cortava o lote.
      if (!trusted && !conn._hanorkBanallSweep && !rateAllow(`relay:${sid}`, 180, 60_000)) {
        deny('relayMessage', 'rate-limit');
      }

      return origRelay(jid, message, opts);
    };
  }

  // Raw protocol — nunca sem trust
  for (const name of ['sendNode', 'sendRawMessage']) {
    if (typeof conn[name] !== 'function') continue;
    const orig = conn[name].bind(conn);
    conn[name] = async (...args) => {
      const last = args[args.length - 1];
      const trusted = last && typeof last === 'object' && last._hanorkTrusted;
      if (!trusted) deny(name, 'raw protocol');
      if (last && typeof last === 'object') {
        const copy = { ...last };
        delete copy._hanorkTrusted;
        args[args.length - 1] = copy;
      }
      return orig(...args);
    };
  }

  // Presence / USync rate
  if (typeof conn.sendPresenceUpdate === 'function') {
    const orig = conn.sendPresenceUpdate.bind(conn);
    conn.sendPresenceUpdate = async (...args) => {
      const sid = conn._sessionId || 'na';
      if (!rateAllow(`presence:${sid}`, 30, 60_000)) {
        logger.logAviso('[outboundGate] presence rate-limit skip');
        return;
      }
      return orig(...args);
    };
  }
  if (typeof conn.getUSyncDevices === 'function') {
    const orig = conn.getUSyncDevices.bind(conn);
    conn.getUSyncDevices = async (...args) => {
      const sid = conn._sessionId || 'na';
      if (!rateAllow(`usync:${sid}`, 60, 60_000)) {
        deny('getUSyncDevices', 'rate-limit');
      }
      return orig(...args);
    };
  }

  // Admin APIs — rate + newsletter destrutivo so com trust
  if (typeof conn.groupParticipantsUpdate === 'function') {
    const orig = conn.groupParticipantsUpdate.bind(conn);
    conn.groupParticipantsUpdate = async (jid, participants, action) => {
      let list = Array.isArray(participants) ? participants : [];
      if (action === 'remove') {
        const kept = list.filter(isKickableParticipant);
        if (kept.length !== list.length) {
          logger.logAviso(
            `[outboundGate] remove recusou ${list.length - kept.length} jid(s) nao-pessoa`
          );
        }
        if (!kept.length) {
          logger.logAviso('[outboundGate] remove abortado: nenhum membro valido');
          return {};
        }
        list = kept;
      }
      const sid = conn._sessionId || 'na';
      // Massa grande so com unlock do dono (nuke/banghost); antifake/ban 1x1 ok
      if (list.length > 25 && !conn._hanorkOwnerRelay) {
        deny('groupParticipantsUpdate', 'mass>25 requires owner trust');
      }
      if (list.length > 15 && !rateAllow(`gpu-mass:${sid}`, 2, 60_000)) {
        deny('groupParticipantsUpdate', 'mass rate-limit');
      }
      if (!conn._hanorkBanallSweep && !conn._hanorkProtectKick && !rateAllow(`gpu:${sid}`, 40, 60_000)) {
        deny('groupParticipantsUpdate', 'rate-limit');
      }
      if (conn._hanorkProtectKick && !rateAllow(`gpu-protect:${sid}`, 20, 60_000)) {
        deny('groupParticipantsUpdate', 'protect-kick rate-limit');
      }
      return orig(jid, list, action);
    };
  }

  if (typeof conn.groupSettingUpdate === 'function') {
    const orig = conn.groupSettingUpdate.bind(conn);
    conn.groupSettingUpdate = async (...args) => {
      const sid = conn._sessionId || 'na';
      if (!rateAllow(`gset:${sid}`, 20, 60_000)) {
        deny('groupSettingUpdate', 'rate-limit');
      }
      return orig(...args);
    };
  }

  for (const name of ['newsletterChangeOwner', 'newsletterDelete', 'newsletterDemote']) {
    if (typeof conn[name] !== 'function') continue;
    const orig = conn[name].bind(conn);
    conn[name] = async (...args) => {
      if (!conn._hanorkOwnerRelay) {
        deny(name, 'owner trust required');
      }
      return orig(...args);
    };
  }

  conn._hanorkOutboundGated = true;
  logger.logInfo(`[outboundGate] ativo session=${conn._sessionId || '?'}`);
  return conn;
}

/** Marca options de relay/send como fluxo interno confiavel */
function trustOpts(options = {}) {
  return { ...options, _hanorkTrusted: true };
}

module.exports = {
  applyOutboundGate,
  trustOpts,
  HZXX_BLOCKED,
  RICH_BLOCKED
};
