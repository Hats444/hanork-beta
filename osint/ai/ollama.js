'use strict';

const { SYSTEM } = require('./prompts');
const logger = require('../../logger');

function compactPayload(entities, evidence, skipped) {
  const ents = (entities || []).slice(0, 40).map((e) => ({
    type: e.entityType,
    value: String(e.value || '').slice(0, 120),
    status: e.status,
    sources: (e.sources || []).slice(0, 6),
    conf: e.confidence
  }));
  const ev = (evidence || []).slice(0, 40).map((x) => ({
    type: x.entityType,
    value: String(x.value || '').slice(0, 120),
    source: x.source,
    url: String(x.url || '').slice(0, 140)
  }));
  return JSON.stringify({
    entities: ents,
    evidence: ev,
    skipped: (skipped || []).slice(0, 18).map((s) => ({ name: s.name, reason: s.reason }))
  }).slice(0, 7000);
}

function userPrompt(payload, extra = '') {
  return (
    `${SYSTEM}\n` +
    (extra ? `${extra}\n` : '') +
    `Dados OSINT ja coletados (JSON). Interprete em portugues, tecnico, curto.\n` +
    `Nunca invente. Sem evidencia: "nao verificavel". Cite a fonte de cada fato.\n` +
    `Separe FATO (2+ fontes) de HIPOTESE.\nJSON:\n${payload}`
  );
}

async function generateLocal(prompt, temperature) {
  const ollama = require('../../services/ollamaService');
  if (!ollama.isOsintOllamaOn()) {
    return { ok: false, skipped: true, note: 'OSINT_OLLAMA=0' };
  }
  const up = await ollama.probeOllamaForOsint();
  if (!up) return { ok: false, skipped: true, note: 'Ollama local offline' };
  const axios = require('axios');
  const timeout = Math.min(Number(ollama.OLLAMA_TIMEOUT) || 60000, 12000);
  const res = await axios.post(
    `${ollama.OLLAMA_HOST}/api/generate`,
    {
      model: ollama.OLLAMA_MODEL,
      prompt,
      system: SYSTEM,
      stream: false,
      keep_alive: ollama.OLLAMA_KEEP_ALIVE,
      options: {
        num_ctx: Math.min(Number(ollama.OLLAMA_NUM_CTX) || 8192, 4096),
        temperature: temperature == null ? 0.15 : temperature,
        num_predict: 160
      }
    },
    { timeout }
  );
  const text = String(res.data?.response || '').trim().slice(0, 1800);
  if (!text) return { ok: false, skipped: true, note: 'Ollama local vazio' };
  return { ok: true, via: 'ollama', text };
}

async function generatePool(prompt) {
  const { completeIntentPrompt } = require('../../core/intent/providerPool');
  const out = await completeIntentPrompt(
    `TAREFA OSINT (nao e chat). ${prompt}`,
    { mode: 'chat' }
  );
  const text = String(out?.text || '').trim().slice(0, 1800);
  if (!text) return { ok: false, skipped: true, note: 'pool IA vazio' };
  return { ok: true, via: out.provider || 'pool', text };
}

async function generate(prompt, temperature) {
  try {
    const local = await generateLocal(prompt, temperature);
    if (local.ok) return local;
  } catch (e) {
    logger.logAviso(`[osint-ai] local: ${String(e.message || e).slice(0, 120)}`);
  }
  try {
    return await Promise.race([
      generatePool(prompt),
      new Promise((resolve) => {
        setTimeout(() => resolve({ ok: false, skipped: true, note: 'pool timeout' }), 10000);
      })
    ]);
  } catch (e) {
    logger.logAviso(`[osint-ai] pool: ${String(e.message || e).slice(0, 120)}`);
    return { ok: false, skipped: true, note: 'IA falhou — relatorio so com evidencias' };
  }
}

/**
 * Interpreta JSON ja coletado/verificado. Sem tool arbitraria.
 * Sempre tenta (OSINT_OLLAMA default ON), mesmo com OLLAMA_ENABLED=0 no Intent.
 */
async function analyze({ entities, evidence, skipped }) {
  const ollama = require('../../services/ollamaService');
  if (!ollama.isOsintOllamaOn()) {
    return { enabled: false, skipped: true, note: 'OSINT_OLLAMA=0', text: '' };
  }
  const payload = compactPayload(entities, evidence, skipped);
  if (!entities?.length && !evidence?.length) {
    return {
      enabled: true,
      skipped: false,
      via: 'none',
      note: 'sem evidencia coletada — nao verificavel',
      text: 'Nao verificavel: nenhuma evidencia publica coletada.'
    };
  }
  try {
    const first = await generate(userPrompt(payload));
    if (!first.ok) {
      return { enabled: true, skipped: true, note: first.note, text: '' };
    }
    return { enabled: true, skipped: false, via: first.via, text: first.text };
  } catch (e) {
    logger.logAviso(`[osint-ai] ${String(e.message || e).slice(0, 120)}`);
    return { enabled: true, skipped: true, note: 'IA falhou — relatorio so com evidencias', text: '' };
  }
}

module.exports = { analyze, generateLocal, generatePool };
