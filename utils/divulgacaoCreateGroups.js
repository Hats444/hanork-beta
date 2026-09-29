'use strict';
/**
 * Criacao automatica de grupos ja marcados pra divulgacao (mesmo fluxo do addgrupo).
 * Delay entre criações — nao rajada (anti rate-limit/ban).
 */
const logger = require('../logger');
const { delay } = require('../utils');
const { adicionarGrupo, getConfig, updateConfig, getGruposParaDivulgar } = require('./divulgacao');
const { setGroupSecurityFlag } = require('./moderation');

const MIN_DELAY_MS = 8000;
const DEFAULT_DELAY_MS = 15000;
const MAX_BATCH = 3;
const MAX_MIN_GROUPS = 8;
const MAX_NAME = 40;

function botSelfJid(conn) {
  const id = conn?.user?.id || conn?.user?.jid || '';
  if (!id) return '';
  const base = String(id).split(':')[0].split('@')[0];
  return base ? `${base}@s.whatsapp.net` : String(id);
}

function getLiveConnForUser(telegramUserId) {
  try {
    const { getLiveConnForUser: live } = require('../telegramBot');
    return typeof live === 'function' ? live(telegramUserId) : null;
  } catch (_) {
    return null;
  }
}

function clampCount(n, fallback = 1) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(MAX_BATCH, v);
}

function clampDelayMs(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v < MIN_DELAY_MS) return DEFAULT_DELAY_MS;
  return Math.min(30000, v);
}

function sanitizeBase(raw, fallback = 'Grupo') {
  const s = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return s || fallback;
}

function nextSeq(config) {
  const n = parseInt(config?.autoCreateSeq, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function markAsDivulgacao(telegramUserId, groupJid) {
  adicionarGrupo(telegramUserId, groupJid);
  return setGroupSecurityFlag(groupJid, telegramUserId, 'grupoDivulgacao', true);
}

async function createOneDivGroup(conn, telegramUserId, name) {
  const me = botSelfJid(conn);
  const participantes = me ? [me] : [];
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await conn.groupCreate(name, participantes);
      const groupId = result?.id || result?.gid || result?.jid;
      if (!groupId) throw new Error('grupo criado sem JID');
      await markAsDivulgacao(telegramUserId, groupId);
      logger.logInfo(`[DIV-CRIAR] marcado ${groupId} uid=${telegramUserId}`);
      return groupId;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      logger.logAviso(`[DIV-CRIAR] tentativa ${attempt}/2 "${name}": ${msg.slice(0, 120)}`);
      if (/rate-overlimit|forbidden|not-authorized/i.test(msg)) {
        if (attempt < 2) await delay(DEFAULT_DELAY_MS);
        else break;
      } else if (attempt < 2) {
        await delay(4000);
      }
    }
  }
  throw lastErr || new Error('falha ao criar grupo');
}

/**
 * Cria N grupos com delay, cada um ja na lista addgrupo + flag grupoDivulgacao.
 */
async function createDivGroupsBatch(conn, telegramUserId, opts = {}) {
  const uid = String(telegramUserId || '');
  const config = getConfig(uid);
  const count = clampCount(opts.count ?? config.autoCreateCount ?? 1);
  const base = sanitizeBase(opts.baseName ?? config.autoCreateName, 'Grupo');
  const wait = clampDelayMs(opts.delayMs ?? config.autoCreateDelayMs);
  let seq = nextSeq(config);
  const created = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    const name = `${base} #${seq}`;
    try {
      const jid = await createOneDivGroup(conn, uid, name);
      created.push({ jid, name });
      seq += 1;
      updateConfig(uid, { autoCreateSeq: seq });
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 120);
      errors.push({ name, error: msg });
      logger.logAviso(`[DIV-CRIAR] falhou "${name}": ${msg}`);
      if (/rate-overlimit|forbidden|connection closed/i.test(msg)) break;
    }
    if (i + 1 < count) await delay(wait);
  }
  return { created, errors, seq };
}

/**
 * Se autoCreateEnabled e lista < minimo, cria o suficiente (cap MAX_BATCH).
 */
async function maybeTopUpDivGroups(telegramUserId) {
  const uid = String(telegramUserId || '');
  const config = getConfig(uid);
  if (!config.autoCreateEnabled) return { ok: false, reason: 'off' };
  const min = Math.min(MAX_MIN_GROUPS, Math.max(0, parseInt(config.autoCreateMin, 10) || 0));
  if (min < 1) return { ok: false, reason: 'no-min' };
  const have = (getGruposParaDivulgar(uid).grupos || []).length;
  if (have >= min) return { ok: false, reason: 'enough', have, min };
  const need = Math.min(MAX_BATCH, min - have);
  const live = getLiveConnForUser(uid);
  if (!live?.conn) return { ok: false, reason: 'no-socket' };
  logger.logInfo(`[DIV-CRIAR] topup uid=${uid} have=${have} min=${min} need=${need}`);
  return createDivGroupsBatch(live.conn, uid, { count: need });
}

module.exports = {
  MAX_BATCH,
  MAX_MIN_GROUPS,
  DEFAULT_DELAY_MS,
  clampCount,
  sanitizeBase,
  markAsDivulgacao,
  createOneDivGroup,
  createDivGroupsBatch,
  maybeTopUpDivGroups
};
