// services/webSearchService.js
// Busca web em tempo real — usa searchCache + searchRanker (T9)
const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../logger');
const searchCache = require('./searchCache');
const { rankAndDedup } = require('./searchRanker');

const SEARCH_TIMEOUT = parseInt(process.env.SEARCH_TIMEOUT || '15000', 10);
const MAX_RESULTS_PER_QUERY = parseInt(process.env.MAX_RESULTS_PER_QUERY || '10', 10);
const MAX_PAGES_TO_FETCH = parseInt(process.env.MAX_PAGES_TO_FETCH || '5', 10);

function isBlockedUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (hostname.endsWith('.local')) return true;
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    return false;
  } catch {
    return true;
  }
}

async function searchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
  try {
    const { data } = await axios.get(url, {
      timeout: SEARCH_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const $ = cheerio.load(data, { xmlMode: true });
    const results = [];
    $('item').each((i, el) => {
      if (results.length >= MAX_RESULTS_PER_QUERY) return false;
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const desc = $(el).find('description').text().replace(/<[^>]*>/g, '').trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const sourceName = $(el).find('source').text().trim();
      const sourceUrl = $(el).find('source').attr('url') || '';
      if (title && link && !isBlockedUrl(link)) {
        results.push({
          title,
          url: link,
          description: desc,
          source: 'google_news',
          date: pubDate,
          sourceName,
          sourceUrl
        });
      }
    });
    return results;
  } catch (e) {
    logger.logErro('[SEARCH] Google News', e.message);
    return [];
  }
}

async function searchWeb(query) {
  const { enforceSearchQuery } = require('../utils/searchQueryLimit');
  const q = enforceSearchQuery(query);
  if (!q) return [];
  const cacheKey = q.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached) {
    logger.logInfo(`[SEARCH] Cache hit para: ${q}`);
    return cached;
  }

  logger.logInfo(`[SEARCH] Buscando: ${q}`);
  const results = await searchGoogleNews(q);
  const ranked = rankAndDedup(results, q).slice(0, MAX_RESULTS_PER_QUERY);

  searchCache.set(cacheKey, ranked);
  logger.logInfo(`[SEARCH] ${ranked.length} resultados para: ${q}`);
  return ranked;
}

async function searchMultiple(queries) {
  let pLimit;
  try {
    pLimit = require('p-limit');
  } catch {
    pLimit = (n) => (fn) => fn();
  }
  const limit = pLimit(3);
  const tasks = (queries || []).map((q) => limit(() => searchWeb(q)));
  const results = await Promise.allSettled(tasks);
  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) all.push(...r.value);
  }
  return rankAndDedup(all, (queries || []).join(' '));
}

module.exports = {
  searchWeb,
  searchMultiple,
  isBlockedUrl,
  SEARCH_TIMEOUT,
  MAX_RESULTS_PER_QUERY,
  MAX_PAGES_TO_FETCH
};
