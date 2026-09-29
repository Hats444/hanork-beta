// services/webParserService.js
// Extracao de conteudo HTML (Cheerio) — T9

const cheerio = require('cheerio');
const logger = require('../logger');

const MAX_CONTENT_CHARS = parseInt(process.env.MAX_CONTENT_CHARS || '1200', 10);

function extractContent(html, maxChars = MAX_CONTENT_CHARS) {
  try {
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();
    let text = '';
    const mainSelectors = [
      'article',
      'main',
      '.content',
      '.post-content',
      '.entry-content',
      '#content',
      '.article-body'
    ];
    for (const sel of mainSelectors) {
      const el = $(sel).first();
      if (el.length) {
        text = el.text().trim();
        if (text.length > 200) break;
      }
    }
    if (text.length < 200) {
      text = $('body').text().trim();
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text.slice(0, maxChars);
  } catch (e) {
    logger.logErro('[PARSER] extractContent', e.message);
    return '';
  }
}

function extractTitle(html) {
  try {
    const $ = cheerio.load(html);
    const og = $('meta[property="og:title"]').attr('content');
    if (og) return og.trim();
    return $('title').first().text().trim() || '';
  } catch {
    return '';
  }
}

module.exports = {
  extractContent,
  extractTitle,
  MAX_CONTENT_CHARS
};
