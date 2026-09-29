// services/webIntelligenceService.js
// Orquestra busca web + analise IA — estado via sessionStore (anti-vazamento)
const logger = require('../logger');
const { searchWeb, searchMultiple } = require('./webSearchService');
const { fetchMultiple, fetchPage } = require('./webFetchService');
const { generateSearchQueries, analyzeResults, analyzeSource, checkOllama } = require('./ollamaService');
const { sessionStore } = require('../core/router/sessionStore');

const STATE_TTL = parseInt(process.env.SEARCH_SESSION_TTL || '1800000', 10);

function resolveSessionId(sessionId) {
  return String(sessionId || 'default');
}

function resolveUserId(userId) {
  return String(userId || 'anon');
}

function getState(userId, sessionId = 'default') {
  const sid = resolveSessionId(sessionId);
  const uid = resolveUserId(userId);
  let state = sessionStore.get(sid, uid, 'websearch');
  if (!state || typeof state !== 'object') {
    state = { results: [], query: '', ts: Date.now() };
    sessionStore.set(sid, uid, 'websearch', state, STATE_TTL);
  }
  return state;
}

function setState(userId, data, sessionId = 'default') {
  const sid = resolveSessionId(sessionId);
  const uid = resolveUserId(userId);
  const state = { ...getState(userId, sessionId), ...data, ts: Date.now() };
  sessionStore.set(sid, uid, 'websearch', state, STATE_TTL);
  return state;
}

function clearState(userId, sessionId = 'default') {
  sessionStore.remove(resolveSessionId(sessionId), resolveUserId(userId), 'websearch');
}

async function webSearch(userId, query, sessionId = 'default') {
  const { enforceSearchQuery } = require('../utils/searchQueryLimit');
  const q = enforceSearchQuery(query);
  const results = await searchWeb(q);
  setState(userId, { results, query: q }, sessionId);
  return results;
}

async function deepSearch(userId, query, sessionId = 'default') {
  const { enforceSearchQuery } = require('../utils/searchQueryLimit');
  const q = enforceSearchQuery(query);
  const queries = await generateSearchQueries(q);
  logger.logInfo(`[DEEPSEARCH] Queries geradas: ${queries.join(' | ')}`);
  const results = await searchMultiple(queries);
  setState(userId, { results, query: q, queries }, sessionId);
  return { results, queries };
}

async function analyze(userId, query, results, sessionId = 'default') {
  const pages = await fetchMultiple(results);
  logger.logInfo(`[ANALYZE] ${pages.length} paginas buscadas`);
  const analysis = await analyzeResults(query, pages);
  return { analysis, pages };
}

async function analyzeSpecific(userId, index, sessionId = 'default') {
  const state = getState(userId, sessionId);
  if (!state.results || state.results.length === 0) {
    return { error: 'Nenhuma pesquisa salva. Use google/deepsearch primeiro.' };
  }
  const result = state.results[index - 1];
  if (!result) {
    return { error: `Resultado ${index} nao encontrado.` };
  }
  const page = await fetchPage(result.url);
  if (!page) {
    return { error: 'Nao foi possivel buscar a pagina.' };
  }
  const analysis = await analyzeSource(state.query, page);
  return { analysis, page, result };
}

async function generateReport(userId, sessionId = 'default') {
  const state = getState(userId, sessionId);
  if (!state.results || state.results.length === 0) {
    return { error: 'Nenhuma pesquisa salva. Use google/deepsearch primeiro.' };
  }
  const pages = await fetchMultiple(state.results);
  const analysis = await analyzeResults(state.query, pages);
  return { analysis, pages, results: state.results, query: state.query };
}

module.exports = {
  webSearch,
  deepSearch,
  analyze,
  analyzeSpecific,
  generateReport,
  getState,
  setState,
  clearState,
  checkOllama
};
