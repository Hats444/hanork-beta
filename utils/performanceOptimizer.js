// utils/performanceOptimizer.js
// Otimizações de performance para o bot

const pLimit = require('p-limit');
const logger = require('../logger');

// ========== CONCORRÊNCIA CONTROLADA ==========
// Limita operações simultâneas para não travar o event loop
const limit = pLimit(5); // Max 5 operações simultâneas

async function withConcurrency(tasks) {
  const limited = tasks.map(task => limit(() => task()));
  return Promise.allSettled(limited);
}

// ========== CACHE INTELIGENTE ==========
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// Limpa cache periodicamente
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of cache.entries()) {
    if (now - item.ts > CACHE_TTL) {
      cache.delete(key);
    }
  }
}, 60000); // Limpa a cada 1 minuto

// ========== DEBOUNCE PARA EVENTOS REPETIDOS ==========
function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

// ========== THROTTLE PARA EVENTOS FREQUENTES ==========
function throttle(fn, limit) {
  let inThrottle;
  return (...args) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

// ========== PROCESSAMENTO EM LOTE ==========
async function processBatch(items, processor, batchSize = 10) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await withConcurrency(
      batch.map(item => () => processor(item))
    );
    results.push(...batchResults.filter(r => r.status === 'fulfilled').map(r => r.value));
  }
  return results;
}

// ========== TIMEOUT PARA OPERAÇÕES LENTAS ==========
async function withTimeout(promise, timeoutMs, fallback = null) {
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, timeout]);
}

// ========== RETRY COM BACKOFF EXPONENCIAL ==========
async function withRetry(fn, maxRetries = 3, baseDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      const delay = baseDelay * Math.pow(2, i);
      logger.logAviso(`[PERF] Retry ${i + 1}/${maxRetries} em ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ========== MEMORY LEAK PREVENTION ==========
const weakMaps = new WeakMap();
let operationCount = 0;
const MAX_OPERATIONS_BEFORE_CLEANUP = 1000;

function trackOperation() {
  operationCount++;
  if (operationCount >= MAX_OPERATIONS_BEFORE_CLEANUP) {
    operationCount = 0;
    // Força garbage collection se disponível
    if (global.gc) {
      global.gc();
      logger.logInfo('[PERF] Garbage collection executado');
    }
    // Limpa caches antigos
    const now = Date.now();
    for (const [key, item] of cache.entries()) {
      if (now - item.ts > CACHE_TTL * 2) {
        cache.delete(key);
      }
    }
  }
}

// ========== OTIMIZAÇÃO DE MENSAGENS ==========
// Agrupa múltiplas mensagens em uma só quando possível
async function sendOptimizedMessage(bot, chatId, messages) {
  if (!Array.isArray(messages)) messages = [messages];
  
  // Se for apenas uma mensagem, envia diretamente
  if (messages.length === 1) {
    return await bot.sendMessage(chatId, messages[0]);
  }
  
  // Se for múltiplas, envia em lote com delay mínimo
  const results = [];
  for (const msg of messages) {
    const result = await bot.sendMessage(chatId, msg);
    results.push(result);
    await new Promise(resolve => setTimeout(resolve, 100)); // 100ms entre mensagens
  }
  return results;
}

// ========== PREPARAÇÃO DE DADOS ASSÍNCRONA ==========
// Pré-carrega dados frequentemente acessados
const preloadCache = new Map();

async function preloadData(key, loader) {
  const cached = getCached(`preload_${key}`);
  if (cached) return cached;
  
  const data = await loader();
  setCache(`preload_${key}`, data);
  return data;
}

// ========== MONITORAMENTO DE PERFORMANCE ==========
const performanceMetrics = {
  messageProcessTime: [],
  commandExecutionTime: [],
  apiCallTime: []
};

function recordMetric(category, time) {
  performanceMetrics[category].push(time);
  if (performanceMetrics[category].length > 100) {
    performanceMetrics[category].shift(); // Mantém apenas os últimos 100
  }
}

function getAverageTime(category) {
  const times = performanceMetrics[category];
  if (times.length === 0) return 0;
  return times.reduce((a, b) => a + b, 0) / times.length;
}

// ========== WRAPPER PARA COMANDOS COM MONITORAMENTO ==========
function withPerformanceTracking(fn, category = 'commandExecutionTime') {
  return async (...args) => {
    const start = Date.now();
    try {
      const result = await fn(...args);
      const time = Date.now() - start;
      recordMetric(category, time);
      trackOperation();
      return result;
    } catch (e) {
      const time = Date.now() - start;
      recordMetric(category, time);
      trackOperation();
      throw e;
    }
  };
}

module.exports = {
  withConcurrency,
  getCached,
  setCache,
  debounce,
  throttle,
  processBatch,
  withTimeout,
  withRetry,
  trackOperation,
  sendOptimizedMessage,
  preloadData,
  recordMetric,
  getAverageTime,
  withPerformanceTracking,
  performanceMetrics
};