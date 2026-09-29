// core/intent/intentJson.js
// Parser/validador JSON unico pro pool inteiro (remoto + Ollama).
// Nenhum provider tem logica propria de interpretacao.

'use strict';

const logger = require('../../logger');
const { completeIntentPrompt } = require('./providerPool');

const JSON_RETRY_SUFFIX =
  '\n\nIMPORTANTE: sua resposta anterior nao foi JSON valido.\n' +
  'Responda SOMENTE com um unico objeto JSON, sem texto antes ou depois, sem markdown.\n' +
  'Formatos aceitos:\n' +
  '{"tipo":"comando","comando":"nome","params":{}}\n' +
  '{"tipo":"resposta","texto":"..."}\n' +
  '{"tipo":"nao_encontrado"}';

/**
 * Extrai JSON de resposta (fences markdown, espacos, JSON embutido).
 */
function parseJsonLoose(text) {
  let raw = String(text || '').trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;

  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  };

  let body = m[0];
  let parsed = tryParse(body);
  if (parsed) return parsed;

  body = body
    .replace(/:\s*(-?\d+),(\d+)\b/g, ':$1.$2')
    .replace(/,\s*([}\]])/g, '$1');
  parsed = tryParse(body);
  if (parsed) return parsed;

  body = body
    .replace(/'/g, '"')
    .replace(/([{\s,])([A-Za-zÀ-ÿ_][\wÀ-ÿ]*)\s*:/g, '$1"$2":');
  return tryParse(body);
}

function unwrapCommandName(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const inner = v.command || v.comando || v.name || v.nome || v.cmd || null;
    if (inner && typeof inner === 'object') return unwrapCommandName(inner);
    return inner != null ? String(inner) : null;
  }
  return null;
}

/**
 * Normaliza payload de qualquer provider.
 * @returns {{ kind: 'command'|'chat'|'not_found', command?, confidence?, args?, text?, raw? }|null}
 */
function normalizeIntentPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const tipo = String(parsed.tipo || parsed.type || '').toLowerCase();
  if (
    tipo === 'nao_encontrado' ||
    tipo === 'não_encontrado' ||
    tipo === 'not_found' ||
    tipo === 'naoencontrado' ||
    parsed.not_found === true ||
    parsed.nao_encontrado === true
  ) {
    return { kind: 'not_found', raw: parsed };
  }

  if (tipo === 'resposta' || tipo === 'resposta_livre') {
    return { kind: 'chat', text: String(parsed.texto || parsed.text || '').trim(), raw: parsed };
  }

  let command = unwrapCommandName(
    parsed.command || parsed.comando || parsed.comando_identificado || parsed.nome
  );
  let confidence = parsed.confidence ?? parsed.confianca ?? parsed['confiança'];
  let args = parsed.args || parsed.params || parsed.parametros || parsed.argumentos || {};

  const identified = parsed.comando_identificado;
  if (identified && typeof identified === 'object' && !Array.isArray(identified)) {
    command = command || unwrapCommandName(identified);
    confidence = confidence ?? identified.confidence ?? identified.confianca;
    if (!args || (typeof args === 'object' && !Array.isArray(args) && !Object.keys(args).length)) {
      args = identified.args || identified.params || identified.argumentos || args;
    }
  }

  if (tipo === 'comando') {
    command = unwrapCommandName(parsed.comando || parsed.command || parsed.nome) || command;
    args = parsed.params || parsed.args || args || {};
  }

  const nested = parsed.classificacao || parsed.resultado || parsed.result;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    command = command || unwrapCommandName(nested.comando || nested.command || nested.comando_identificado);
    confidence = confidence ?? nested.confianca ?? nested.confidence;
    if (!args || (typeof args === 'object' && !Object.keys(args).length)) {
      args = nested.argumentos || nested.args || nested.params || {};
    }
  }

  if (command === 'null' || command === 'nenhum' || command === 'none' || command === '[object object]') {
    command = null;
  }
  if (command != null) command = String(command).trim().toLowerCase();

  // Sem comando e sem texto de resposta → not_found se o modelo sinalizou
  if (!command && !String(parsed.texto || parsed.text || '').trim() && tipo === '') {
    return { kind: 'command', command: null, confidence: 0, args: {}, raw: parsed };
  }

  return { kind: 'command', command, confidence, args, raw: parsed };
}

/**
 * Chama o pool em modo function e garante JSON parseavel (1 retry com reforco).
 * Comportamento identico independente do provider escolhido.
 *
 * @returns {Promise<{ norm: object|null, text: string|null, provider: string|null, retried: boolean }>}
 */
async function completeFunctionCall(taskPrompt, opts = {}) {
  const baseOpts = {
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.12,
    numPredict: opts.numPredict || 160,
    mode: 'function'
  };

  let res = await completeIntentPrompt(taskPrompt, {
    ...baseOpts,
    maxTries: opts.maxTries || 2,
    skipSecondPass: opts.skipSecondPass !== false
  });
  let text = res?.text || null;
  let provider = res?.provider || null;
  let parsed = parseJsonLoose(text);
  let norm = normalizeIntentPayload(parsed);
  let retried = false;

  if (!norm) {
    if (!provider && !text) {
      logger.logAviso('[IntentJson] pool vazio — sem retry (evita martelar a API)');
    } else {
      retried = true;
      logger.logAviso(`[IntentJson] JSON invalido provider=${provider || '?'} — retry reforco`);
      const retryPrompt = `${taskPrompt}${JSON_RETRY_SUFFIX}`;
      res = await completeIntentPrompt(retryPrompt, { ...baseOpts, temperature: 0.05 });
      text = res?.text || text;
      provider = res?.provider || provider;
      parsed = parseJsonLoose(text);
      norm = normalizeIntentPayload(parsed);
    }
  }

  // Sem JSON valido: NAO vira conversa. Modelo 0.5B/prosa virava
  // "Claro, posso ajudar" e o bot fingia que entendeu sem executar.
  if (!norm) {
    logger.logAviso(`[IntentJson] sem JSON provider=${provider || '?'} — deixa match local`);
  }

  return { norm, text, provider, retried, parsed };
}

module.exports = {
  parseJsonLoose,
  normalizeIntentPayload,
  completeFunctionCall,
  JSON_RETRY_SUFFIX
};
