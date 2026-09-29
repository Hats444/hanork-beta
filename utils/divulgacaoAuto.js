'use strict';
/**
 * Ciclo automatico de divulgacao — um timer/job/lock POR TIPO.
 * O envio continua em commands/divulgar/div.js (fila, backoff, abort).
 * Tipos ON rodam em paralelo: CTA lento nao atrasa texto/status.
 */
const logger = require('../logger');
const divJob = require('./divulgacaoJob');
const {
  getConfig,
  updateConfig,
  resolveGruposDestino,
  isCtaReady,
  isTextoReady,
  isPayReady,
  isStatusReady,
  applyViewConfig,
  parseTipoSlot
} = require('./divulgacao');

const MIN_INTERVAL = 15;
const MAX_INTERVAL = 1440;
const DEFAULT_INTERVAL = 30;
const TOPUP_DEBOUNCE_MS = 20000;
const ARM_SLOT_MS = 5 * 60 * 1000;
const CATCHUP_GAP_MS = 90 * 1000;

const MODE_ALIAS = {
  texto: 'normal',
  normal: 'normal',
  cta: 'cta',
  botao: 'cta',
  pay: 'pay',
  pagamento: 'pay',
  status: 'status',
  cf: 'status',
  closefriends: 'status',
  full: 'full',
  completa: 'full'
};

const ALL_MODOS = ['normal', 'cta', 'pay', 'status', 'full'];
const TOGGLE_MODOS = ['normal', 'cta', 'pay', 'status'];

const MODO_LABEL = {
  normal: 'Texto',
  cta: 'CTA',
  pay: 'Pagamento',
  status: 'Status',
  full: 'Completa'
};

const timers = new Map();
const topupLocks = new Map();
const noSocketLogAt = new Map();
let handlerRegistered = false;

function userHasLiveSocket(uid) {
  try {
    return require('../connection').hasLiveSocketForUser(uid);
  } catch (_) {
    return false;
  }
}

function logNoSocketOnce(uid) {
  const id = String(uid || '');
  const now = Date.now();
  if (now - (noSocketLogAt.get(id) || 0) < 30 * 60 * 1000) return;
  noSocketLogAt.set(id, now);
  logger.logAviso(`[DIV-AUTO] sem socket vivo uid=${id.slice(0, 8)} (proximo aviso em 30min)`);
}

function clampInterval(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return DEFAULT_INTERVAL;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, v));
}

/** Aceita 30, 720, 12h, 24 horas. */
function parseIntervalArg(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return DEFAULT_INTERVAL;
  const hour = s.match(/^(\d+)\s*h(?:ora|oras)?s?$/);
  if (hour) return clampInterval(Number(hour[1]) * 60);
  return clampInterval(s);
}

function formatIntervalLabel(min) {
  const n = clampInterval(min);
  if (n % 1440 === 0) return n === 1440 ? '24 horas' : `${n / 1440} dias`;
  if (n % 60 === 0) return n === 60 ? '1 hora' : `${n / 60} horas`;
  return `${n} min`;
}

/** Com varios tipos ON, intervalo curto vira rajada no mesmo grupo. */
function recommendedMinInterval(modos) {
  const n = parseModos(modos).length;
  if (n >= 4) return 720;
  if (n >= 3) return 180;
  if (n >= 2) return 60;
  return MIN_INTERVAL;
}

function maybeBumpInterval(modos, currentMin) {
  const rec = recommendedMinInterval(modos);
  const cur = clampInterval(currentMin);
  if (cur < rec) return rec;
  return cur;
}

function normalizeModo(raw) {
  const s = String(raw || '').toLowerCase().trim();
  const m = s.match(/^(normal|texto|cta|botao|pay|pagamento|status|cf|closefriends|full|completa)(?::(\d+)|_(\d+))?$/);
  if (m) {
    let tipo = m[1];
    if (tipo === 'texto') tipo = 'normal';
    if (tipo === 'botao') tipo = 'cta';
    if (tipo === 'pagamento') tipo = 'pay';
    if (tipo === 'cf' || tipo === 'closefriends') tipo = 'status';
    if (tipo === 'completa') tipo = 'full';
    const slot = Number(m[2] || m[3] || 1);
    if (Number.isFinite(slot) && slot > 1) return `${tipo}:${slot}`;
    return tipo;
  }
  return MODE_ALIAS[s] || null;
}

/** `.divconfigauto 30` = todos; `.divconfigauto cta 12h` = so CTA. */
function parseDivconfigAutoArgs(args) {
  const a = (args || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!a.length) return { kind: 'panel', tipo: null, minutes: null };
  const low = a.map((x) => x.toLowerCase());

  const msgsIdx = low.findIndex((x) => x === 'msgs' || x === 'msg' || x === 'mensagens');
  if (msgsIdx >= 0) {
    const rest = a.slice(msgsIdx + 1);
    if (!rest.length) return { kind: 'msgs', tipo: null, msgs: null, msgsOn: null };
    const t = rest[0].toLowerCase();
    if (['on', 'ligar', '1', 'true', 'sim'].includes(t)) {
      return { kind: 'msgs', tipo: null, msgsOn: true };
    }
    if (['off', 'desligar', '0', 'false', 'nao'].includes(t)) {
      return { kind: 'msgs', tipo: null, msgsOn: false };
    }
    return { kind: 'msgs', tipo: null, msgs: parseInt(rest[0], 10) };
  }

  const minIdx = low.findIndex((x) => x === 'min' || x === 'mingap' || x === 'gap');
  if (minIdx >= 0) {
    const rest = a.slice(minIdx + 1);
    if (!rest.length) return { kind: 'mingap', tipo: null, minGap: null };
    return { kind: 'mingap', tipo: null, minGap: parseIntervalArg(rest[0]) };
  }

  const randIdx = low.findIndex((x) => x === 'aleatorio' || x === 'random' || x === 'rand');
  if (randIdx >= 0) {
    const before = a.slice(0, randIdx);
    const tipo = before.length ? normalizeModo(before[0]) : null;
    const rest = a.slice(randIdx + 1);
    if (!rest.length) return { kind: 'random', tipo, randomMin: null, randomMax: null };
    if (['off', 'desligar', '0'].includes(rest[0].toLowerCase())) {
      return { kind: 'random-off', tipo };
    }
    const min = parseIntervalArg(rest[0]);
    const max = rest[1] != null ? parseIntervalArg(rest[1]) : min;
    return {
      kind: 'random',
      tipo,
      randomMin: Math.min(min, max),
      randomMax: Math.max(min, max)
    };
  }

  if (a.length === 1) {
    const t = normalizeModo(a[0]);
    if (t) return { kind: 'picker', tipo: t, minutes: null };
    return { kind: 'interval', tipo: null, minutes: parseIntervalArg(a[0]) };
  }
  const t0 = normalizeModo(a[0]);
  const t1 = normalizeModo(a[1]);
  if (t0) return { kind: 'interval', tipo: t0, minutes: parseIntervalArg(a[1]) };
  if (t1) return { kind: 'interval', tipo: t1, minutes: parseIntervalArg(a[0]) };
  return { kind: 'interval', tipo: null, minutes: parseIntervalArg(a[0]) };
}

const INTERVAL_PRESETS = [
  { min: 15, label: '15 min', desc: 'Teste' },
  { min: 30, label: '30 min', desc: 'Teste' },
  { min: 60, label: '1 hora', desc: 'So este tipo' },
  { min: 120, label: '2 horas', desc: 'So este tipo' },
  { min: 180, label: '3 horas', desc: 'So este tipo' },
  { min: 360, label: '6 horas', desc: 'So este tipo' },
  { min: 720, label: '12 horas', desc: 'Grupo vivo' },
  { min: 1440, label: '24 horas', desc: 'Grupo vivo' }
];

const RANDOM_PRESETS = [
  { min: 30, max: 60, label: '30-60 min' },
  { min: 60, max: 120, label: '1-2h' },
  { min: 120, max: 240, label: '2-4h' },
  { min: 180, max: 360, label: '3-6h' }
];

const MSG_PRESETS = [25, 50, 100];
const MIN_GAP_PRESETS = [15, 30, 60];

function clampMsgEvery(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return 50;
  return Math.min(500, Math.max(5, v));
}

function clampMinGap(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return 15;
  return Math.min(MAX_INTERVAL, Math.max(5, v));
}

function msgEveryOf(config) {
  return clampMsgEvery(config?.autoMsgEvery || 50);
}

function patchMsgTrigger({ enabled, every } = {}) {
  const patch = {};
  if (enabled === true) {
    patch.autoMsgEnabled = true;
    patch.autoMsgOptIn = true;
  } else if (enabled === false) {
    patch.autoMsgEnabled = false;
  }
  if (every != null && Number.isFinite(Number(every))) {
    patch.autoMsgEvery = clampMsgEvery(every);
  }
  return patch;
}

function randomRangeForTipo(config, tipo) {
  const m = normalizeModo(tipo);
  const r = m && config?.autoRandomByTipo && typeof config.autoRandomByTipo === 'object'
    ? config.autoRandomByTipo[m]
    : null;
  if (!r || typeof r !== 'object') return null;
  const min = Number(r.min);
  const max = Number(r.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < 1) return null;
  return { min: clampInterval(min), max: clampInterval(max) };
}

function patchRandomByTipo(config, range, tipos) {
  const by = { ...(config?.autoRandomByTipo || {}) };
  const list = Array.isArray(tipos) && tipos.length ? tipos : ALL_MODOS.slice();
  const min = clampInterval(range && range.min);
  const max = clampInterval(range && range.max);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  for (const raw of list) {
    const t = normalizeModo(raw);
    if (t) by[t] = { min: lo, max: hi };
  }
  return { autoRandomByTipo: by };
}

function clearRandomByTipo(config, tipos) {
  const by = { ...(config?.autoRandomByTipo || {}) };
  const list = Array.isArray(tipos) && tipos.length
    ? tipos.map(normalizeModo).filter(Boolean)
    : ALL_MODOS.slice();
  for (const t of list) delete by[t];
  return { autoRandomByTipo: by };
}

function formatScheduleLabel(config, modo) {
  const rnd = randomRangeForTipo(config, modo);
  if (rnd) return `aleatorio ${formatIntervalLabel(rnd.min)}-${formatIntervalLabel(rnd.max)}`;
  return formatIntervalLabel(intervalForTipo(config, modo));
}

function formatEta(ts) {
  const n = Number(ts) || 0;
  if (!n) return 'ainda nao agendado';
  const d = n - Date.now();
  if (d <= 0) return 'agora';
  const min = Math.max(1, Math.round(d / 60000));
  return `em ${formatIntervalLabel(min)}`;
}

function parseModos(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map(normalizeModo).filter(Boolean))];
  }
  const t = String(raw || '').toLowerCase().trim();
  if (!t) return [];
  if (t === 'todos' || t === 'all') return TOGGLE_MODOS.slice();
  if (t === 'nenhum' || t === 'none' || t === 'off') return [];
  return [...new Set(t.split(/[,|+\s]+/).map(normalizeModo).filter(Boolean))];
}

function toggleModo(current, modo, want) {
  const m = normalizeModo(modo);
  if (!m) return parseModos(current);
  const set = new Set(parseModos(current));
  const on = want === true ? true : want === false ? false : !set.has(m);
  if (on) set.add(m);
  else set.delete(m);
  return [...set];
}

function isModoOn(config, modo) {
  const m = normalizeModo(modo);
  return !!m && parseModos(config?.autoModos).includes(m);
}

function tipoReady(tipo, config) {
  const parsed = parseTipoSlot(tipo);
  const view = applyViewConfig(config, parsed.tipo, parsed.slot);
  const t = parsed.tipo;
  if (t === 'cta') return isCtaReady(view);
  if (t === 'pay') return isPayReady(view);
  if (t === 'status') return isStatusReady(view);
  if (t === 'full') {
    return isTextoReady(view) || isCtaReady(view) || isPayReady(view) || isStatusReady(view);
  }
  return isTextoReady(view);
}

function formatModos(modos) {
  const list = parseModos(modos);
  if (!list.length) return '(nenhum)';
  return list.map((m) => MODO_LABEL[m] || m).join(', ');
}

function intervalForTipo(config, tipo) {
  const m = normalizeModo(tipo);
  const by = config?.autoIntervalByTipo;
  const n = m && by && typeof by === 'object' ? Number(by[m]) : NaN;
  if (Number.isFinite(n) && n > 0) return clampInterval(n);
  return clampInterval(config?.autoIntervalMin || DEFAULT_INTERVAL);
}

function patchIntervalByTipo(config, minutes, tipos) {
  const v = clampInterval(minutes);
  const by = { ...(config?.autoIntervalByTipo || {}) };
  const list = Array.isArray(tipos) && tipos.length ? tipos : ALL_MODOS.slice();
  for (const raw of list) {
    const t = normalizeModo(raw);
    if (t) by[t] = v;
  }
  for (const t of ALL_MODOS) {
    if (!Number.isFinite(Number(by[t])) || Number(by[t]) < 1) {
      by[t] = clampInterval(config?.autoIntervalMin || DEFAULT_INTERVAL);
    }
  }
  const patch = { autoIntervalByTipo: by };
  if (!tipos || !tipos.length) patch.autoIntervalMin = v;
  return patch;
}

function formatAutoSummary(config) {
  const on = config?.autoEnabled ? 'ON' : 'OFF';
  const enabled = parseModos(config?.autoModos);
  const rec = recommendedMinInterval(enabled);
  const lines = [`Auto: ${on} · cada tipo no seu relogio (conta a partir de ligar)`];
  const shorts = enabled.filter((m) => intervalForTipo(config, m) < rec);
  if (enabled.length >= 2 && shorts.length) {
    lines.push(
      `Aviso: ${shorts.map((m) => MODO_LABEL[m] || m).join(', ')} abaixo de ${formatIntervalLabel(rec)} com ${enabled.length} tipos ON (vira rajada).`
    );
  } else if (enabled.some((m) => intervalForTipo(config, m) <= 30)) {
    lines.push('15/30 min so pra teste. Grupo vivo: 12h ou 24h.');
  }
  for (const m of TOGGLE_MODOS) {
    const flag = enabled.includes(m) ? 'ON' : 'OFF';
    const ready = tipoReady(m, config) ? '' : ' (falta config)';
    lines.push(`${MODO_LABEL[m]}: ${flag} · ${formatIntervalLabel(intervalForTipo(config, m))}${enabled.includes(m) ? ready : ''}`);
  }
  if (enabled.includes('full')) {
    lines.push(`Completa: ON · ${formatIntervalLabel(intervalForTipo(config, 'full'))}${tipoReady('full', config) ? '' : ' (falta config)'}`);
  }
  return lines.join('\n');
}

function getLiveConnForUser(telegramUserId) {
  try {
    const { getLiveConnForUser: live } = require('../telegramBot');
    return typeof live === 'function' ? live(telegramUserId) : null;
  } catch (_) {
    return null;
  }
}

function timerKey(uid, tipo) {
  return `${uid}::${tipo}`;
}

function ensureJobHandler() {
  if (handlerRegistered) return;
  try {
    const { registerJobHandler } = require('../services/jobQueue');
    registerJobHandler('div-auto', async (payload) => {
      const tipo = normalizeModo(payload?.tipo);
      if (tipo) return runAutoCycleTipo(payload?.telegramUserId, tipo);
      return runAutoCycle(payload?.telegramUserId);
    });
    handlerRegistered = true;
  } catch (e) {
    logger.logAviso(`[DIV-AUTO] registerJobHandler: ${e.message}`);
  }
}

function clearTimer(key) {
  const t = timers.get(key);
  if (!t) return;
  const h = t.handle || t;
  clearInterval(h);
  clearTimeout(h);
  timers.delete(key);
}

function stopScheduler(telegramUserId) {
  const uid = String(telegramUserId || '');
  if (!uid) return;
  clearTimer(uid);
  for (const key of [...timers.keys()]) {
    if (key === uid || String(key).startsWith(`${uid}::`)) clearTimer(key);
  }
}

function enqueueTipo(uid, tipo) {
  if (!userHasLiveSocket(uid)) {
    logNoSocketOnce(uid);
    return;
  }
  try {
    const { enqueue } = require('../services/jobQueue');
    enqueue('div-auto', { telegramUserId: uid, tipo }, { timeout: 180000 }).catch((e) => {
      logger.logAviso(`[DIV-AUTO] enqueue ${tipo}: ${e.message}`);
      runAutoCycleTipo(uid, tipo).catch((err) => logger.logAviso(`[DIV-AUTO] tick ${tipo}: ${err.message}`));
    });
  } catch (e) {
    runAutoCycleTipo(uid, tipo).catch((err) => logger.logAviso(`[DIV-AUTO] tick ${tipo}: ${err.message}`));
  }
}

function tipoIndex(tipo) {
  const i = TOGGLE_MODOS.indexOf(tipo);
  return i >= 0 ? i : Math.max(0, ALL_MODOS.indexOf(tipo));
}

/** Comeca a contar AGORA. Nao dispara na hora. Varios tipos no mesmo clique ganham folga pra nao sair juntos. */
function armTipoClocks(uid, tipos, { reset = true, stagger = false } = {}) {
  const user = String(uid || '');
  const list = [...new Set((tipos || []).map(normalizeModo).filter(Boolean))];
  if (!user || !list.length) return;
  const cfg = getConfig(user);
  const lastBy = { ...(cfg.autoLastRunByTipo || {}) };
  const now = Date.now();
  let changed = false;
  list.forEach((tipo, i) => {
    if (!reset && Number(lastBy[tipo] || 0)) return;
    const iv = intervalForTipo(cfg, tipo) * 60 * 1000;
    const extra = stagger && list.length > 1
      ? i * Math.min(ARM_SLOT_MS, Math.max(60 * 1000, Math.floor(iv / Math.max(2, list.length))))
      : 0;
    lastBy[tipo] = now + extra;
    changed = true;
  });
  if (changed) updateConfig(user, { autoLastRunByTipo: lastBy });
}

/** Se dois tipos iam sair no mesmo segundo (mesmo intervalo + mesmo lastRun), empurra o mais tarde. */
function separateImminentClocks(uid, tipos) {
  const user = String(uid || '');
  const list = [...new Set((tipos || []).map(normalizeModo).filter(Boolean))];
  if (!user || list.length < 2) return;
  const cfg = getConfig(user);
  const lastBy = { ...(cfg.autoLastRunByTipo || {}) };
  const now = Date.now();
  const items = list.map((tipo) => {
    const iv = intervalForTipo(cfg, tipo) * 60 * 1000;
    const last = Number(lastBy[tipo] || 0) || now;
    return { tipo, iv, last, next: last + iv };
  }).sort((a, b) => a.next - b.next || tipoIndex(a.tipo) - tipoIndex(b.tipo));
  let changed = false;
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    const minGap = Math.min(ARM_SLOT_MS, Math.max(CATCHUP_GAP_MS, Math.floor(cur.iv / Math.max(2, list.length))));
    const gap = cur.next - prev.next;
    if (gap >= minGap) continue;
    const bump = minGap - gap;
    lastBy[cur.tipo] = cur.last + bump;
    cur.last += bump;
    cur.next += bump;
    changed = true;
  }
  if (changed) updateConfig(user, { autoLastRunByTipo: lastBy });
}

function nextTickDelayMs(uid, tipo, intervalMs) {
  const last = Number(getConfig(uid).autoLastRunByTipo?.[tipo] || 0);
  if (!last) return intervalMs;
  const elapsed = Date.now() - last;
  if (elapsed >= intervalMs) {
    return 8000 + tipoIndex(tipo) * CATCHUP_GAP_MS;
  }
  return Math.max(3000, intervalMs - elapsed);
}

function startTipoScheduler(uid, tipo, opts = {}) {
  const key = timerKey(uid, tipo);
  clearTimer(key);
  const config = getConfig(uid);
  const intervalMin = intervalForTipo(config, tipo);
  const ms = intervalMin * 60 * 1000;
  const tick = () => enqueueTipo(uid, tipo);
  const armInterval = () => {
    clearTimer(key);
    const handle = setInterval(tick, ms);
    handle.unref?.();
    timers.set(key, { handle, intervalMin, tipo });
  };
  const delayMs = nextTickDelayMs(uid, tipo, ms);
  const handle = setTimeout(() => {
    tick();
    armInterval();
  }, delayMs);
  handle.unref?.();
  timers.set(key, { handle, intervalMin, tipo });
  logger.logInfo(
    `[DIV-AUTO] scheduler uid=${uid} tipo=${tipo} interval=${intervalMin}min next=${Math.round(delayMs / 1000)}s`
  );
}

function startScheduler(telegramUserId, opts = {}) {
  const uid = String(telegramUserId || '');
  if (!uid) return false;
  const config = getConfig(uid);
  stopScheduler(uid);
  if (!config.autoEnabled) return false;
  if (!userHasLiveSocket(uid)) {
    logger.logInfo(`[DIV-AUTO] sem socket — nao agenda uid=${uid.slice(0, 8)}`);
    return false;
  }
  const modos = parseModos(config.autoModos);
  if (!modos.length) {
    logger.logInfo(`[DIV-AUTO] auto ON mas nenhum tipo ativo uid=${uid}`);
    return false;
  }
  ensureJobHandler();
  if (opts.armMissing) armTipoClocks(uid, modos, { reset: false, stagger: true });
  separateImminentClocks(uid, modos);
  for (const tipo of modos) {
    startTipoScheduler(uid, tipo, opts);
  }
  return true;
}

function syncSchedulers(telegramUserId, opts = {}) {
  const uid = String(telegramUserId || '');
  if (!uid) return false;
  const config = getConfig(uid);
  if (!config.autoEnabled) {
    stopScheduler(uid);
    return false;
  }
  if (!userHasLiveSocket(uid)) {
    stopScheduler(uid);
    return false;
  }
  const wanted = parseModos(config.autoModos);
  const force = new Set((opts.tipos || []).map(normalizeModo).filter(Boolean));
  ensureJobHandler();
  clearTimer(uid);
  for (const key of [...timers.keys()]) {
    if (!String(key).startsWith(`${uid}::`)) continue;
    const tipo = String(key).slice(uid.length + 2);
    if (!wanted.includes(tipo)) clearTimer(key);
  }
  if (!wanted.length) {
    logger.logInfo(`[DIV-AUTO] auto ON mas nenhum tipo ativo uid=${uid}`);
    return false;
  }
  for (const tipo of wanted) {
    const key = timerKey(uid, tipo);
    const cur = intervalForTipo(config, tipo);
    const t = timers.get(key);
    const mismatch = !!(t && t.intervalMin != null && t.intervalMin !== cur);
    const missing = !t;
    if (!opts.forceAll && !force.has(tipo) && !missing && !mismatch) continue;
    const tickOpts = { ...opts };
    if (missing && tickOpts.kickSoon == null && tickOpts.catchUp == null) tickOpts.catchUp = true;
    if (mismatch && tickOpts.kickSoon == null && tickOpts.catchUp == null) tickOpts.catchUp = true;
    startTipoScheduler(uid, tipo, tickOpts);
  }
  return true;
}

function restartIfEnabled(telegramUserId, opts = {}) {
  const uid = String(telegramUserId || '');
  const config = getConfig(uid);
  if (!config.autoEnabled) {
    stopScheduler(uid);
    return false;
  }
  if (Array.isArray(opts.armTipos) && opts.armTipos.length) {
    armTipoClocks(uid, opts.armTipos, {
      reset: opts.resetClock !== false,
      stagger: opts.stagger === true || opts.armTipos.length > 1
    });
  }
  const wanted = parseModos(getConfig(uid).autoModos);
  if (wanted.length > 1) separateImminentClocks(uid, wanted);
  if (opts.forceAll) return startScheduler(uid, opts);
  return syncSchedulers(uid, opts);
}

function restoreAllAutoSchedulers() {
  ensureJobHandler();
  try {
    const { getAllSessions } = require('./sessionRegistry');
    const seen = new Set();
    for (const s of getAllSessions() || []) {
      const uid = String(s.telegramUserId || '');
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      const cfg = getConfig(uid);
      if (cfg.autoEnabled) startScheduler(uid, { armMissing: true });
    }
  } catch (e) {
    logger.logAviso(`[DIV-AUTO] restore: ${e.message}`);
  }
}

async function maybeTopUpOnce(uid) {
  const now = Date.now();
  const prev = topupLocks.get(uid);
  if (prev && now - prev.at < TOPUP_DEBOUNCE_MS && prev.p) return prev.p;
  let p;
  try {
    const { maybeTopUpDivGroups } = require('./divulgacaoCreateGroups');
    p = maybeTopUpDivGroups(uid).catch((e) => {
      logger.logAviso(`[DIV-AUTO] topup grupos: ${e.message}`);
    });
  } catch (e) {
    logger.logAviso(`[DIV-AUTO] topup grupos: ${e.message}`);
    return null;
  }
  topupLocks.set(uid, { at: now, p });
  return p;
}

async function runAutoCycleTipo(telegramUserId, tipoRaw, opts = {}) {
  const uid = String(telegramUserId || '');
  const tipo = normalizeModo(tipoRaw);
  if (!uid || !tipo) return { ok: false, reason: 'no-uid' };
  const config = getConfig(uid);
  if (!opts.force && !config.autoEnabled) return { ok: false, reason: 'off' };
  if (!opts.force && !isModoOn(config, tipo)) return { ok: false, reason: 'tipo-off' };
  if (!tipoReady(tipo, config)) {
    logger.logAviso(`[DIV-AUTO] tipo=${tipo} sem config uid=${uid}`);
    return { ok: false, reason: 'not-ready' };
  }

  await maybeTopUpOnce(uid);

  const live = getLiveConnForUser(uid);
  if (!live?.conn) {
    logNoSocketOnce(uid);
    return { ok: false, reason: 'no-socket' };
  }

  const jobKey = divJob.jobKey(uid, live.sessionId, tipo);
  if (divJob.isRunning(jobKey)) {
    logger.logInfo(`[DIV-AUTO] skip tipo=${tipo} — este tipo ainda rodando uid=${uid}`);
    return { ok: false, reason: 'running' };
  }

  const dest = await resolveGruposDestino(live.conn, uid);
  if (!dest.length) {
    logger.logAviso(`[DIV-AUTO] nenhum grupo uid=${uid}`);
    return { ok: false, reason: 'no-groups' };
  }

  const lastBy = { ...(config.autoLastRunByTipo || {}) };
  lastBy[tipo] = Date.now();
  updateConfig(uid, {
    autoLastRun: Date.now(),
    autoLastRunByTipo: lastBy,
    lastUiJid: config.lastUiJid || null
  });

  const { startDivulgacaoFromConfig } = require('../commands/divulgar/div');
  const from = config.lastUiJid || null;
  const result = await startDivulgacaoFromConfig(live.conn, {
    telegramUserId: uid,
    sessionId: live.sessionId,
    tipo,
    from,
    info: null,
    source: 'auto',
    silentSkip: true
  });
  if (!result?.ok) {
    logger.logInfo(`[DIV-AUTO] nao disparou uid=${uid} tipo=${tipo} reason=${result?.reason || '?'}`);
  } else {
    logger.logInfo(`[DIV-AUTO] disparou uid=${uid} tipo=${tipo} grupos=${result.grupos}`);
  }
  return result;
}

async function runAutoCycle(telegramUserId) {
  const uid = String(telegramUserId || '');
  if (!uid) return { ok: false, reason: 'no-uid' };
  const config = getConfig(uid);
  if (!config.autoEnabled) return { ok: false, reason: 'off' };
  const modos = parseModos(config.autoModos);
  if (!modos.length) return { ok: false, reason: 'not-ready' };
  const results = await Promise.all(modos.map((tipo) => runAutoCycleTipo(uid, tipo)));
  const ok = results.filter((r) => r && r.ok);
  return { ok: ok.length > 0, results };
}

async function handleDivAutoJob(payload) {
  const tipo = normalizeModo(payload?.tipo);
  if (tipo) return runAutoCycleTipo(payload?.telegramUserId, tipo);
  return runAutoCycle(payload?.telegramUserId);
}

function noteGroupAttempt(telegramUserId, groupId, _tipo, opts = {}) {
  try {
    require('./divulgacaoDeadReplace').onDivGroupResult(telegramUserId, groupId, opts);
  } catch (e) {
    logger.logAviso(`[DIV-DEAD] note: ${e.message}`);
  }
}

module.exports = {
  MIN_INTERVAL,
  MAX_INTERVAL,
  DEFAULT_INTERVAL,
  ALL_MODOS,
  TOGGLE_MODOS,
  MODO_LABEL,
  INTERVAL_PRESETS,
  RANDOM_PRESETS,
  MSG_PRESETS,
  MIN_GAP_PRESETS,
  clampInterval,
  parseIntervalArg,
  parseDivconfigAutoArgs,
  formatIntervalLabel,
  formatScheduleLabel,
  formatEta,
  recommendedMinInterval,
  maybeBumpInterval,
  intervalForTipo,
  patchIntervalByTipo,
  patchRandomByTipo,
  clearRandomByTipo,
  randomRangeForTipo,
  clampMsgEvery,
  clampMinGap,
  msgEveryOf,
  patchMsgTrigger,
  normalizeModo,
  parseModos,
  toggleModo,
  isModoOn,
  formatModos,
  formatAutoSummary,
  tipoReady,
  armTipoClocks,
  separateImminentClocks,
  startScheduler,
  stopScheduler,
  restartIfEnabled,
  restoreAllAutoSchedulers,
  runAutoCycle,
  runAutoCycleTipo,
  handleDivAutoJob,
  noteGroupAttempt
};
