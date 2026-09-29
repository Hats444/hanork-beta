// services/webFetchService.js
// Busca paginas web + parser dedicado (T9)
const axios = require('axios');
const logger = require('../logger');
const { isBlockedUrl, MAX_PAGES_TO_FETCH } = require('./webSearchService');
const { extractContent, extractTitle, MAX_CONTENT_CHARS } = require('./webParserService');

const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT || '15000', 10);

async function resolveGoogleNewsUrl(url) {
  if (!url.includes('news.google.com/rss/articles')) return url;
  try {
    const res = await axios.get(url, {
      timeout: FETCH_TIMEOUT,
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.status === 200 && res.data) {
      const match = String(res.data).match(/<a[^>]+href="([^"]+)"[^>]*>/);
      if (match && match[1] && !match[1].includes('news.google.com')) {
        return match[1];
      }
    }
    return url;
  } catch (e) {
    if (e.response?.request?.res?.responseUrl) {
      const finalUrl = e.response.request.res.responseUrl;
      if (finalUrl && !finalUrl.includes('news.google.com')) return finalUrl;
    }
    return url;
  }
}

async function fetchPage(url) {
  if (isBlockedUrl(url)) {
    logger.logAviso(`[FETCH] URL bloqueada (SSRF): ${url}`);
    return null;
  }
  try {
    const resolvedUrl = await resolveGoogleNewsUrl(url);
    const { data } = await axios.get(resolvedUrl, {
      timeout: FETCH_TIMEOUT,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
      },
      maxRedirects: 5
    });
    const content = extractContent(data);
    return {
      url: resolvedUrl,
      content,
      title: extractTitle(data)
    };
  } catch (e) {
    logger.logErro(`[FETCH] ${url}`, e.message);
    return null;
  }
}

async function fetchMultiple(results) {
  let pLimit;
  try {
    pLimit = require('p-limit');
  } catch {
    pLimit = () => (fn) => fn();
  }
  const limit = pLimit(3);
  const slice = (results || []).slice(0, MAX_PAGES_TO_FETCH);
  const tasks = slice.map((r) => limit(() => fetchPage(r.url)));
  const fetched = await Promise.allSettled(tasks);
  const pages = [];
  for (let i = 0; i < fetched.length; i++) {
    const f = fetched[i];
    const result = slice[i];
    if (f.status === 'fulfilled' && f.value && f.value.content) {
      pages.push(f.value);
    } else if (result && result.description) {
      pages.push({
        url: result.url,
        title: result.title || '',
        content: String(result.description).slice(0, 800)
      });
    }
  }
  return pages;
}

module.exports = {
  fetchPage,
  fetchMultiple,
  extractContent,
  FETCH_TIMEOUT,
  MAX_CONTENT_CHARS
};
