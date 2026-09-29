'use strict';
/**
 * Uma divulgacao por dono+tipo, abortavel, sem travar o router.
 * Tipos diferentes NAO compartilham lock — CTA lento nao segura texto/status.
 */
const jobs = new Map();

function ownerKey(telegramUserId, sessionId) {
  return String(telegramUserId || sessionId || '').trim() || 'na';
}

function jobTipo(tipo) {
  const raw = String(tipo || 'normal').toLowerCase().trim();
  const m = raw.match(/^(normal|texto|cta|botao|pay|pagamento|status|cf|closefriends|full|completa)(?::(\d+))?$/);
  if (m) {
    let t = m[1];
    if (t === 'texto') t = 'normal';
    if (t === 'botao') t = 'cta';
    if (t === 'pagamento') t = 'pay';
    if (t === 'cf' || t === 'closefriends') t = 'status';
    if (t === 'completa') t = 'full';
    const slot = Math.min(3, Math.max(1, parseInt(m[2] || '1', 10) || 1));
    return slot <= 1 ? t : `${t}:${slot}`;
  }
  if (raw === 'closefriends' || raw === 'cf') return 'status';
  return raw || 'normal';
}

function jobKey(telegramUserId, sessionId, tipo) {
  return `${ownerKey(telegramUserId, sessionId)}::${jobTipo(tipo)}`;
}

function getJob(key) {
  return jobs.get(key) || null;
}

function isRunning(key) {
  const j = jobs.get(key);
  return !!(j && !j.done);
}

function listByOwner(telegramUserId, sessionId) {
  const prefix = `${ownerKey(telegramUserId, sessionId)}::`;
  const out = [];
  for (const [key, job] of jobs.entries()) {
    if (job && !job.done && String(key).startsWith(prefix)) {
      out.push({ key, job });
    }
  }
  return out;
}

function tryStart(key, meta = {}) {
  if (isRunning(key)) return { ok: false, job: jobs.get(key) };
  const job = {
    abort: false,
    done: false,
    startedAt: Date.now(),
    tipo: meta.tipo || 'normal',
    grupos: meta.grupos || 0,
    doneGrupos: 0,
    ...meta
  };
  jobs.set(key, job);
  return { ok: true, job };
}

function requestStop(key) {
  const j = jobs.get(key);
  if (!j || j.done) return false;
  j.abort = true;
  return true;
}

function requestStopAll(telegramUserId, sessionId) {
  let n = 0;
  for (const { key } of listByOwner(telegramUserId, sessionId)) {
    if (requestStop(key)) n++;
  }
  return n;
}

function shouldAbort(key) {
  const j = jobs.get(key);
  return !!(j && j.abort && !j.done);
}

function markProgress(key, doneGrupos) {
  const j = jobs.get(key);
  if (j) j.doneGrupos = doneGrupos;
}

function finish(key) {
  const j = jobs.get(key);
  if (j) {
    j.done = true;
    j.finishedAt = Date.now();
  }
}

module.exports = {
  ownerKey,
  jobTipo,
  jobKey,
  getJob,
  isRunning,
  listByOwner,
  tryStart,
  requestStop,
  requestStopAll,
  shouldAbort,
  markProgress,
  finish,
  jobKey: jobKey,
  tryStart: tryStart,
  shouldAbort: shouldAbort,
  markProgress: markProgress
};
module.exports['jobKey'] = jobKey;
module.exports['tryStart'] = tryStart;
module.exports['shouldAbort'] = shouldAbort;
module.exports['markProgress'] = markProgress;
module.exports['jobKey'] = jobKey;
module.exports['tryStart'] = tryStart;
module.exports['shouldAbort'] = shouldAbort;
module.exports['markProgress'] = markProgress;
