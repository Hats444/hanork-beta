// core/intent/providerPool.js
// Pool intercalado: todas as IAs de TEXTO da Zero Two + Ollama no final.
// Fonte viva 18/08: https://zero-two-apis.store/docs (IAS 29) + GET /api/ia2/modelos
// Nao entra: imagem/video/tts (animagine, flux, sdxl, gptvideo, toanime, tts, removebg, tohd)

'use strict';

const crypto = require('crypto');
const logger = require('../../logger');
const { getJson } = require('../../services/zerotwoClient');
const { pickTextField } = require('../zt/responseFormat');
const { classifyCommandIntent, isIntentOnCooldown, getOllamaHealth } = require('../../services/ollamaService');
const { wrapPoolPrompt } = require('./hanorkPersona');
const { sanitizeAiOutput } = require('../../utils/brandSanitize');

const GLOBAL_RPM = parseInt(process.env.INTENT_ZT_RPM || '55', 10);
const CIRCUIT_FAILS = parseInt(process.env.INTENT_CIRCUIT_FAILS || '3', 10);
const CIRCUIT_COOLDOWN_MS = parseInt(process.env.INTENT_CIRCUIT_COOLDOWN_MS || '30000', 10);
const HARD_COOLDOWN_MS = parseInt(process.env.INTENT_HARD_COOLDOWN_MS || String(10 * 60 * 1000), 10);
const INTENT_CACHE_TTL_MS = parseInt(process.env.INTENT_CACHE_TTL_MS || '90000', 10);
const THROTTLE_DELAY_MS = parseInt(process.env.INTENT_THROTTLE_DELAY_MS || '1200', 10);
const MAX_TRIES = parseInt(process.env.INTENT_MAX_REMOTE_TRIES || '6', 10);
const SECOND_PASS_TRIES = parseInt(process.env.INTENT_SECOND_PASS_TRIES || '8', 10);
let lastPoolFailLogAt = 0;

/**
 * Catalogo texto ia2 (zero-two-apis.store /api/ia2/modelos → texto).
 * Ordem: modelos que responderam no probe primeiro; resto do catalogo depois.
 */
const IA2_TEXT_MODELS = [
  'chatgpt_5_5',
  'geminipro',
  'gpt4o_mini',
  'llama33',
  'deepseek_r1',
  'claude',
  'qwencoder',
  'mistral',
  'chatgpt_auto',
  'chatgpt_5_3',
  'chatgpt_5_mini',
  'chatgpt_5_3_mini',
  'gpt4o',
  'gpt4',
  'gpt35',
  'gpt',
  'claudesonnet',
  'gemini',
  'llama31',
  'qwen',
  'deepseek',
  'copilot',
  'apertus',
  'chateverywhere',
  'jeeves',
  'krishna',
  'overchat',
  'quillbot',
  'turboseek'
];

const CORE_TEXT = [
  // /api/ia/zerotwo e persona Darling da API (Lucas), nao Hanork — nao vai primeiro.
  { id: 'gpt-classic', path: '/api/ia/gpt', param: 'query', timeout: 12000, supportsImage: false }
];

function buildRemoteProviders() {
  const ia2 = IA2_TEXT_MODELS.map((id) => ({
    id: `ia2-${id}`,
    path: `/api/ia2/${id}`,
    param: 'texto',
    timeout: 14000,
    supportsImage: false
  }));
  return [...CORE_TEXT, ...ia2];
}

const REMOTE_PROVIDERS = buildRemoteProviders();

let rrIndex = 0;
const circuit = new Map(); // id -> { fails, until, hard }
const intentCache = new Map(); // hash -> { text, at }
const globalWindow = []; // timestamps ms
let globalRlUntil = 0;

function isRateLimitMessage(msg) {
  return /rate-limit|muitas requisi|429/i.test(String(msg || ''));
}

function isGlobalRateLimitedApi() {
  return Date.now() < globalRlUntil;
}

function markGlobalRateLimit(ms = 90000) {
  const until = Date.now() + Math.max(15000, ms);
  if (until > globalRlUntil) globalRlUntil = until;
  logger.logAviso(`[IntentPool] GLOBAL rate-limit ${Math.round((globalRlUntil - Date.now()) / 1000)}s — para de martelar`);
}

function normalizeCacheKey(text) {
  return crypto.createHash('sha1').update(String(text || '').trim().toLowerCase()).digest('hex');
}

function isCircuitOpen(id) {
  const c = circuit.get(id);
  if (!c) return false;
  if (c.until && Date.now() < c.until) return true;
  if (c.until && Date.now() >= c.until) {
    circuit.set(id, { fails: 0, until: 0, hard: false });
    return false;
  }
  return false;
}

function isHardCircuit(id) {
  const c = circuit.get(id);
  return !!(c && c.hard && c.until && Date.now() < c.until);
}

function isHardFailMessage(msg) {
  return /402|quota|pagamento|saldo|cr[eé]dito|credito|todos os m[eé]todos de ia falharam/i.test(String(msg || ''));
}

function markProviderFail(id, err) {
  const msg = String(err || '');
  if (isRateLimitMessage(msg)) {
    markGlobalRateLimit();
  }
  if (isHardFailMessage(msg)) {
    circuit.set(id, { fails: 0, until: Date.now() + HARD_COOLDOWN_MS, hard: true });
    logger.logAviso(`[IntentPool] circuit HARD ${id} ${Math.round(HARD_COOLDOWN_MS / 1000)}s (${msg.slice(0, 60)})`);
    return;
  }
  const prev = circuit.get(id) || { fails: 0, until: 0, hard: false };
  const fails = prev.fails + 1;
  if (fails >= CIRCUIT_FAILS) {
    circuit.set(id, { fails: 0, until: Date.now() + CIRCUIT_COOLDOWN_MS, hard: false });
    logger.logAviso(`[IntentPool] circuit OPEN ${id} ${Math.round(CIRCUIT_COOLDOWN_MS / 1000)}s (${msg.slice(0, 60)})`);
  } else {
    circuit.set(id, { fails, until: 0, hard: false });
  }
}

function markProviderOk(id) {
  circuit.set(id, { fails: 0, until: 0, hard: false });
}

function pruneGlobalWindow(now = Date.now()) {
  const cutoff = now - 60000;
  while (globalWindow.length && globalWindow[0] < cutoff) globalWindow.shift();
}

function globalRateLimited() {
  pruneGlobalWindow();
  return globalWindow.length >= GLOBAL_RPM;
}

function trackGlobalRequest() {
  globalWindow.push(Date.now());
  pruneGlobalWindow();
}

async function throttleIfNeeded() {
  pruneGlobalWindow();
  if (globalWindow.length >= GLOBAL_RPM - 2) {
    await new Promise((r) => setTimeout(r, THROTTLE_DELAY_MS));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nextRemoteProviders() {
  const healthy = REMOTE_PROVIDERS.filter((p) => !isCircuitOpen(p.id));
  const pool = healthy.length ? healthy : REMOTE_PROVIDERS.filter((p) => !isHardCircuit(p.id));
  if (!pool.length) return [];
  const start = rrIndex % pool.length;
  rrIndex = (rrIndex + 1) % 1000000;
  const ordered = [];
  for (let i = 0; i < pool.length; i++) {
    ordered.push(pool[(start + i) % pool.length]);
  }
  return ordered;
}

function allRemotesOnCooldown() {
  return REMOTE_PROVIDERS.every((p) => isCircuitOpen(p.id));
}

/**
 * Sidecar Qwen 0.5B nao gera JSON de comando — se entrar no NLU vira prosa
 * generica ("Claro, posso ajudar") e o bot nao executa o pedido.
 * Chat livre ainda pode usar. Force NLU com OLLAMA_NLU=1.
 */
function skipOllamaForMode(mode) {
  if (mode !== 'function') return false;
  if (/^(1|true|on|yes)$/i.test(String(process.env.OLLAMA_NLU || '').trim())) return false;
  try {
    const sc = require('../../services/ollamaSidecar');
    if (typeof sc.isReady === 'function' && sc.isReady()) return true;
  } catch (_) { /* */ }
  const sidecarFlag = String(process.env.OLLAMA_SIDECAR ?? '').trim();
  if (sidecarFlag && !/^(0|false|off|no|disabled)$/i.test(sidecarFlag)) return true;
  return false;
}

async function callRemoteProvider(provider, prompt) {
  await throttleIfNeeded();
  if (globalRateLimited()) {
    const err = new Error('global_rate_limit');
    err.code = 'GLOBAL_RL';
    throw err;
  }
  const params = { [provider.param || 'query']: prompt };
  const data = await getJson(provider.path, params, provider.timeout || 14000);
  const text = sanitizeAiOutput(pickTextField(data) || '');
  if (!text) {
    throw new Error('resposta_vazia');
  }
  trackGlobalRequest();
  markProviderOk(provider.id);
  return text;
}

async function callOllama(prompt, opts = {}) {
  if (isIntentOnCooldown()) return null;
  const text = await classifyCommandIntent(prompt, opts);
  if (text) trackGlobalRequest();
  return text;
}

/**
 * Tenta ate maxTries providers. Nao aborta o lote no throttle global — espera e segue.
 */
async function tryRemoteBatch(providers, prompt, { maxTries, tried, ignoreSoftCircuit = false } = {}) {
  const seen = tried || new Set();
  const limit = Math.max(1, maxTries || MAX_TRIES);
  let lastErr = null;
  let n = 0;

  for (const p of providers) {
    if (n >= limit) break;
    if (isGlobalRateLimitedApi()) break;
    if (seen.has(p.id)) continue;
    if (isHardCircuit(p.id)) continue;
    if (!ignoreSoftCircuit && isCircuitOpen(p.id)) continue;
    try {
      const text = sanitizeAiOutput(await callRemoteProvider(p, prompt));
      if (!text) throw new Error('resposta_vazia');
      seen.add(p.id);
      return { text, provider: p.id, lastErr: null, tried: seen };
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      if (e.code === 'GLOBAL_RL') {
        logger.logAviso('[IntentPool] throttle global — espera e tenta outra IA');
        await sleep(THROTTLE_DELAY_MS);
        continue;
      }
      seen.add(p.id);
      n += 1;
      markProviderFail(p.id, msg.slice(0, 80));
      if (Date.now() - lastPoolFailLogAt > 120_000) {
        lastPoolFailLogAt = Date.now();
        logger.logAviso(`[IntentPool] fail ${p.id}: ${msg.slice(0, 100)}`);
      }
      if (isRateLimitMessage(msg)) break;
    }
  }
  return { text: null, provider: null, lastErr, tried: seen };
}

/**
 * Completa prompt — round-robin remotos, Ollama, 2a passada nas IAs restantes.
 * Sempre injeta persona Hanork (hanorkPersona.js). Use opts.mode='function' pro FC/JSON.
 * @returns {Promise<{ text: string|null, provider: string|null, cached?: boolean }>}
 */
async function completeIntentPrompt(prompt, opts = {}) {
  const mode = opts.mode === 'function' ? 'function' : 'chat';
  const fullPrompt = wrapPoolPrompt(prompt, { mode, compact: true });
  const cacheKey = normalizeCacheKey(`${mode}|${fullPrompt}`);
  const cached = intentCache.get(cacheKey);
  if (cached && Date.now() - cached.at < INTENT_CACHE_TTL_MS) {
    return { text: cached.text, provider: cached.provider, cached: true };
  }

  const remotes = nextRemoteProviders();
  const tryCap = Math.max(1, Number(opts.maxTries) || MAX_TRIES);
  const first = isGlobalRateLimitedApi()
    ? { text: null, provider: null, lastErr: new Error('API em rate-limit (muitas requisicoes).'), tried: new Set() }
    : await tryRemoteBatch(remotes, fullPrompt, { maxTries: tryCap });
  if (first.text) {
    intentCache.set(cacheKey, { text: first.text, provider: first.provider, at: Date.now() });
    logger.logInfo(`[IntentPool] OK provider=${first.provider} mode=${mode}`);
    return { text: first.text, provider: first.provider, cached: false };
  }

  // Fallback Ollama: sidecar 0.5B NAO classifica comando (JSON). So chat.
  if (!skipOllamaForMode(mode) && opts.skipOllama !== true) {
    try {
      const ol = getOllamaHealth();
      if (ol && ol.enabled && !ol.hardOffline) {
        const text = sanitizeAiOutput(await callOllama(fullPrompt, opts) || '');
        if (text) {
          intentCache.set(cacheKey, { text, provider: 'ollama', at: Date.now() });
          logger.logInfo(`[IntentPool] OK provider=ollama (fallback) mode=${mode}`);
          return { text, provider: 'ollama', cached: false };
        }
      }
    } catch (e) {
      logger.logAviso(`[IntentPool] Ollama fallback fail: ${e.message}`);
    }
  } else if (mode === 'function') {
    logger.logInfo('[IntentPool] Ollama pulado no NLU (sidecar 0.5B nao classifica comando)');
  }

  // 2a passada: outras IAs do catalogo, ignora circuit curto (402 HARD continua pulado)
  const skipSecond =
    opts.skipSecondPass === true ||
    isGlobalRateLimitedApi() ||
    isRateLimitMessage(first.lastErr && first.lastErr.message);
  const retryList = skipSecond ? [] : REMOTE_PROVIDERS.filter((p) => !isHardCircuit(p.id));
  const second = retryList.length
    ? await tryRemoteBatch(retryList, fullPrompt, {
      maxTries: SECOND_PASS_TRIES,
      tried: first.tried,
      ignoreSoftCircuit: true
    })
    : { text: null, provider: null, lastErr: first.lastErr, tried: first.tried };
  if (second.text) {
    intentCache.set(cacheKey, { text: second.text, provider: second.provider, at: Date.now() });
    logger.logInfo(`[IntentPool] OK provider=${second.provider} mode=${mode} pass=2`);
    return { text: second.text, provider: second.provider, cached: false };
  }

  const lastErr = second.lastErr || first.lastErr;
  if (Date.now() - lastPoolFailLogAt > 120_000) {
    lastPoolFailLogAt = Date.now();
    logger.logInfo(`[IntentPool] todos providers falharam (${lastErr?.message || 'unknown'})`);
  }
  return { text: null, provider: null, cached: false };
}

function circuitWaitSec() {
  let max = 0;
  const now = Date.now();
  if (globalRlUntil > now) max = Math.max(max, globalRlUntil - now);
  for (const p of REMOTE_PROVIDERS) {
    const c = circuit.get(p.id);
    if (c && c.until > now) max = Math.max(max, c.until - now);
  }
  return Math.ceil(max / 1000);
}

function getPoolHealth() {
  pruneGlobalWindow();
  const ol = getOllamaHealth();
  const ollamaReady = !!(ol.enabled && ol.available && !ol.hardOffline && !ol.cooldownActive);
  return {
    remoteCount: REMOTE_PROVIDERS.length,
    ia2TextModels: IA2_TEXT_MODELS.length,
    globalRpm: GLOBAL_RPM,
    globalUsedLastMin: globalWindow.length,
    allRemotesCooldown: allRemotesOnCooldown() || isGlobalRateLimitedApi(),
    ollamaCooldown: !ollamaReady,
    waitSec: circuitWaitSec(),
    circuits: REMOTE_PROVIDERS.map((p) => ({
      id: p.id,
      open: isCircuitOpen(p.id),
      hard: isHardCircuit(p.id),
      fails: (circuit.get(p.id) || {}).fails || 0
    })),
    cacheSize: intentCache.size
  };
}

function clearIntentCache() {
  intentCache.clear();
}

module.exports = {
  REMOTE_PROVIDERS,
  IA2_TEXT_MODELS,
  completeIntentPrompt,
  allRemotesOnCooldown,
  globalRateLimited,
  getPoolHealth,
  clearIntentCache,
  isCircuitOpen,
  wrapPoolPrompt: require('./hanorkPersona').wrapPoolPrompt,
  HANORK_SYSTEM_PROMPT: require('./hanorkPersona').HANORK_SYSTEM_PROMPT
};
