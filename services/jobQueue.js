// services/jobQueue.js
// T5: Bull/Redis quando REDIS_URL disponivel; fallback in-process

const logger = require('../logger');

let bullQueue = null;
let mode = 'inprocess'; // 'bull' | 'inprocess'
const localHandlers = new Map();
const localPending = [];
let localRunning = 0;
const LOCAL_CONCURRENCY = parseInt(process.env.HANORK_JOB_CONCURRENCY || '5', 10);

async function initJobQueue() {
  const redisUrl = process.env.REDIS_URL
    || (process.env.REDIS_HOST
      ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || '6379'}`
      : null);

  if (!redisUrl || process.env.ENABLE_BULL === '0') {
    mode = 'inprocess';
    logger.logInfo('[JOBQUEUE] Modo in-process (sem Redis/Bull)');
    return { mode };
  }

  try {
    const Bull = require('bull');
    bullQueue = new Bull('hanork-jobs', redisUrl, {
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 2,
        backoff: { type: 'exponential', delay: 2000 }
      }
    });

    bullQueue.process(LOCAL_CONCURRENCY, async (job) => {
      const handler = localHandlers.get(job.data.type);
      if (!handler) throw new Error(`Handler ausente: ${job.data.type}`);
      return handler(job.data.payload, job);
    });

    bullQueue.on('error', (err) => {
      logger.logErro('[JOBQUEUE] Bull error', err.message);
    });

    mode = 'bull';
    logger.logInfo(`[JOBQUEUE] Bull ativo em ${redisUrl.replace(/:[^:@]+@/, ':***@')}`);
    return { mode };
  } catch (e) {
    mode = 'inprocess';
    bullQueue = null;
    logger.logAviso(`[JOBQUEUE] Falha Bull (${e.message}) — fallback in-process`);
    return { mode, error: e.message };
  }
}

function registerJobHandler(type, fn) {
  localHandlers.set(type, fn);
}

async function drainLocal() {
  while (localRunning < LOCAL_CONCURRENCY && localPending.length) {
    const job = localPending.shift();
    localRunning++;
    Promise.resolve()
      .then(() => {
        const handler = localHandlers.get(job.type);
        if (!handler) throw new Error(`Handler ausente: ${job.type}`);
        return handler(job.payload, null);
      })
      .then(job.resolve, job.reject)
      .finally(() => {
        localRunning--;
        drainLocal();
      });
  }
}

/**
 * Enfileira job. Retorna Promise com resultado do handler.
 */
function enqueue(type, payload = {}, opts = {}) {
  if (mode === 'bull' && bullQueue) {
    return bullQueue.add({ type, payload }, {
      priority: opts.priority || 5,
      timeout: opts.timeout || 120000
    }).then((job) => job.finished());
  }

  return new Promise((resolve, reject) => {
    localPending.push({ type, payload, resolve, reject });
    if (localPending.length > parseInt(process.env.HANORK_JOB_PENDING_MAX || '200', 10)) {
      const dropped = localPending.shift();
      dropped.reject(new Error('Fila de jobs cheia (backpressure)'));
    }
    drainLocal();
  });
}

function getQueueStats() {
  return {
    mode,
    localPending: localPending.length,
    localRunning,
    bull: mode === 'bull'
  };
}

async function closeJobQueue() {
  if (bullQueue) {
    try {
      await bullQueue.close();
    } catch (_) { /* ignore */ }
    bullQueue = null;
  }
}

module.exports = {
  initJobQueue,
  registerJobHandler,
  enqueue,
  getQueueStats,
  closeJobQueue
};
