// services/zerotwoClient.js — cliente unico da API de midia/consultas (Hanork)
'use strict';

require('dotenv').config();
const axios = require('axios');
const { sanitizeBrand, scrubApiData, looksLikeHtml } = require('../utils/brandSanitize');
const { remapRequest } = require('../core/zt/pathRemap');

// Env: preferir HANORK_*; ZEROTWO_* permanece por compatibilidade com a host da API
const API_BASE = (
  process.env.HANORK_API_BASE ||
  process.env.ZEROTWO_API_BASE ||
  'https://zero-two-apis.store'
).replace(/\/$/, '');
const API_KEY = (
  process.env.HANORK_API_KEY ||
  process.env.ZEROTWO_API_KEY ||
  ''
).trim();

function ensureKey() {
  if (!API_KEY) {
    const err = new Error('Configure HANORK_API_KEY (ou ZEROTWO_API_KEY) no .env');
    err.code = 'NO_API_KEY';
    throw err;
  }
}

function apiUrl(path, params = {}) {
  ensureKey();
  const mapped = remapRequest(path, params);
  const p = mapped.path.startsWith('/') ? mapped.path : `/${mapped.path}`;
  const u = new URL(API_BASE + p);
  u.searchParams.set('apikey', API_KEY);
  for (const [k, v] of Object.entries(mapped.params || {})) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function isIaApiPath(path) {
  const p = String(path || '');
  return /\/api\/ia(\/|2\/)/i.test(p) || /\/gemini\//i.test(p);
}

function parseJsonResponse(path, raw, status, ct, mappedPath) {
  if (!raw) throw new Error(`Resposta vazia (${path})`);
  if (status === 429 || /muitas requisi/i.test(raw)) {
    throw new Error('API em rate-limit (muitas requisicoes). Aguarde 1–2 min e tente de novo.');
  }
  if (/text\/html/i.test(ct) || looksLikeHtml(raw)) {
    const hint = mappedPath && mappedPath !== path ? ` (tentou ${mappedPath})` : '';
    throw new Error(`Rota fora do ar na API${hint}. Tente outro cmd ou avise o dono.`);
  }
  if (/^(audio|video|image|application\/octet)/i.test(ct) && !/json/i.test(ct)) {
    throw new Error(`API retornou midia em vez de JSON (${path})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error(`Resposta invalida da API (nao-JSON) em ${path}`);
  }
  parsed = scrubApiData(parsed);
  const providerFail =
    status >= 400 ||
    parsed?.status === false ||
    parsed?.erro === true ||
    parsed?.error === true;
  if (providerFail) {
    if (pickMediaUrl(parsed)) return parsed;
    const igMsg = parsed?.Instagram?.resultados?.msg || parsed?.Instagram?.resultados?.mensagem;
    const msg = sanitizeBrand(
      (typeof igMsg === 'string' && igMsg) ||
        (typeof parsed?.mensagem === 'string' && parsed.mensagem) ||
        (typeof parsed?.message === 'string' && parsed.message) ||
        (typeof parsed?.error === 'string' && parsed.error) ||
        (typeof parsed?.erro === 'string' && parsed.erro) ||
        `HTTP ${status}`
    );
    throw new Error(String(msg));
  }
  return parsed;
}

async function getJsonOnce(path, params, timeout) {
  const mapped = remapRequest(path, params);
  const url = apiUrl(path, params);
  const { data, status, headers } = await axios.get(url, {
    timeout,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d]
  });
  const raw = typeof data === 'string' ? data : String(data ?? '');
  const ct = String(headers?.['content-type'] || '');
  return parseJsonResponse(path, raw, status, ct, mapped.path);
}

async function postJson(path, params = {}, timeout = 45000) {
  ensureKey();
  const mapped = remapRequest(path, params);
  const p = mapped.path.startsWith('/') ? mapped.path : `/${mapped.path}`;
  const url = `${API_BASE}${p}?apikey=${encodeURIComponent(API_KEY)}`;
  const body = mapped.params || {};
  const tryOnce = async (headers, payload) => {
    const { data, status, headers: h } = await axios.post(url, payload, {
      timeout,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(d) => d],
      headers
    });
    const raw = typeof data === 'string' ? data : String(data ?? '');
    const ct = String(h?.['content-type'] || '');
    return parseJsonResponse(path, raw, status, ct, mapped.path);
  };
  try {
    return await tryOnce({ 'Content-Type': 'application/json' }, body);
  } catch (e) {
    if (!/Rota fora do ar|nao-JSON|HTML/i.test(String(e.message || e))) throw e;
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null && v !== '') form.set(k, String(v));
    }
    return tryOnce(
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      form.toString()
    );
  }
}

async function getJson(path, params = {}, timeout = 45000) {
  // Probe 05/09/2026: POST em /api/ia e /api/ia2 volta HTML 404.
  // GET curto responde JSON. POST-first + corte queryLen>400 fazia o pool
  // abortar o GET (persona compacta tem ~405 chars) e o chat cair "off".
  // GET primeiro; POST so se GET bater 414/WAF (query gigante).
  try {
    return await getJsonOnce(path, params, timeout);
  } catch (e) {
    const msg = String(e.message || e);
    if (!isIaApiPath(path)) throw e;
    if (/rate-limit|429|quota|402/i.test(msg)) throw e;
    if (/414|URI too long|WAF|Rota fora do ar|nao-JSON|HTML/i.test(msg)) {
      return postJson(path, params, timeout);
    }
    throw e;
  }
}

async function fetchBuffer(url, timeout = 90000, maxBytes = 80 * 1024 * 1024) {
  if (!url) throw new Error('URL vazia');
  if (Buffer.isBuffer(url)) return { buffer: url, contentType: '' };
  const { data, status, headers } = await axios.get(String(url), {
    timeout,
    responseType: 'arraybuffer',
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    validateStatus: () => true,
    maxRedirects: 5,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
      ...(/(tiktokcdn|tikcdn|muscdn|tiktok\.com)/i.test(String(url))
        ? { Referer: 'https://www.tiktok.com/' }
        : /(cdninstagram|fbcdn|scontent|instagram\.com)/i.test(String(url))
          ? { Referer: 'https://www.instagram.com/' }
          : {})
    }
  });
  if (status >= 400) {
    const snip = Buffer.from(data || []).slice(0, 120).toString('utf8');
    throw new Error(`Download HTTP ${status}: ${snip.slice(0, 80)}`);
  }
  const buf = Buffer.from(data || []);
  if (!buf.length) throw new Error('Download vazio');
  const cl = Number(headers['content-length'] || 0);
  if (Number.isFinite(cl) && cl > 4096 && buf.length < Math.floor(cl * 0.92)) {
    throw new Error(`Download incompleto (${buf.length}/${cl})`);
  }
  const ct = String(headers['content-type'] || '');
  const head = buf.slice(0, 32).toString('utf8');
  if (/json/i.test(ct) || /^\s*[{[]/.test(head)) {
    let parsed;
    try {
      parsed = scrubApiData(JSON.parse(buf.toString('utf8')));
    } catch (_) {
      throw new Error('API retornou JSON invalido em vez de midia');
    }
    const mediaUrl = pickMediaUrl(parsed);
    if (!mediaUrl) throw new Error('API JSON sem URL de midia (so metadados/descricao)');
    if (String(mediaUrl) === String(url)) throw new Error('API JSON apontou pra mesma URL');
    return fetchBuffer(mediaUrl, timeout, maxBytes);
  }
  if (/text\/html/i.test(ct) || /<!doctype|<html/i.test(head)) {
    throw new Error('API retornou HTML em vez de midia');
  }
  return { buffer: buf, contentType: ct };
}

async function fetchBufferFromApi(path, params = {}, timeout = 90000) {
  return fetchBuffer(apiUrl(path, params), timeout);
}

/**
 * GET que pode retornar JSON ou bytes (detecta content-type).
 */
async function request(path, params = {}, opts = {}) {
  const timeout = opts.timeout || 60000;
  const prefer = opts.response || 'auto'; // json|buffer|auto

  if (prefer === 'json') return { kind: 'json', data: await getJson(path, params, timeout) };

  if (prefer === 'buffer') {
    // Alguns makers (brat) agora devolvem JSON com URL — nao so bytes crus
    try {
      const url = apiUrl(path, params);
      const { data, status, headers } = await axios.get(url, {
        timeout,
        responseType: 'arraybuffer',
        maxContentLength: 80 * 1024 * 1024,
        maxBodyLength: 80 * 1024 * 1024,
        validateStatus: () => true,
        maxRedirects: 5
      });
      if (status >= 400) {
        const snip = Buffer.from(data || []).slice(0, 120).toString('utf8');
        if (/json/i.test(String(headers['content-type'] || '')) || /^\s*\{/.test(snip)) {
          const parsed = scrubApiData(JSON.parse(Buffer.from(data || []).toString('utf8')));
          const mediaUrl = pickMediaUrl(parsed);
          if (mediaUrl) {
            const media = await fetchBuffer(mediaUrl, timeout);
            return { kind: 'buffer', ...media };
          }
          return { kind: 'json', data: parsed };
        }
        throw new Error(`Download HTTP ${status}: ${snip.slice(0, 80)}`);
      }
      const buf = Buffer.from(data || []);
      const ct = headers['content-type'] || '';
      if (/json/i.test(ct) || looksLikeHtml(buf.slice(0, 64).toString('utf8'))) {
        if (/json/i.test(ct)) {
          const parsed = scrubApiData(JSON.parse(buf.toString('utf8')));
          const mediaUrl = pickMediaUrl(parsed);
          if (mediaUrl) {
            const media = await fetchBuffer(mediaUrl, timeout);
            return { kind: 'buffer', ...media };
          }
          return { kind: 'json', data: parsed };
        }
        throw new Error(`Endpoint indisponivel ou path invalido (${path})`);
      }
      return { kind: 'buffer', buffer: buf, contentType: ct };
    } catch (e) {
      // fallback: JSON + midia
      try {
        const data = await getJson(path, params, timeout);
        const mediaUrl = pickMediaUrl(data);
        if (mediaUrl) {
          const media = await fetchBuffer(mediaUrl, timeout);
          return { kind: 'buffer', ...media };
        }
        return { kind: 'json', data };
      } catch (_) {
        throw e;
      }
    }
  }

  // auto: tenta JSON; se for download com URL de midia, baixa o arquivo
  try {
    const data = await getJson(path, params, timeout);
    const mediaUrl = pickMediaUrl(data);
    if (mediaUrl && /\/(api\/)?(dl|download)\//i.test(String(path || ''))) {
      try {
        const media = await fetchBuffer(mediaUrl, timeout);
        if (isRealMediaBuffer(media.buffer)) return { kind: 'buffer', ...media };
      } catch (_) { /* devolve JSON e o caller tenta de novo */ }
    }
    return { kind: 'json', data };
  } catch (e) {
    const msg = String(e.message || '');
    if (/midia em vez de JSON|HTML em vez/i.test(msg)) {
      const r = await fetchBufferFromApi(path, params, timeout);
      return { kind: 'buffer', ...r };
    }
    try {
      const r = await fetchBufferFromApi(path, params, timeout);
      return { kind: 'buffer', ...r };
    } catch (_) {
      throw e;
    }
  }
}

async function uploadMultipart(path, fileBuffer, filename = 'file.bin', fields = {}, timeout = 90000) {
  ensureKey();
  const mapped = remapRequest(path, fields);
  const form = new FormData();
  form.append('apikey', API_KEY);
  for (const [k, v] of Object.entries(mapped.params || {})) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }
  const mime = filename.endsWith('.png')
    ? 'image/png'
    : filename.endsWith('.webp')
      ? 'image/webp'
      : filename.endsWith('.mp4')
        ? 'video/mp4'
        : 'application/octet-stream';
  form.append('file', new Blob([fileBuffer], { type: mime }), filename);
  const p = mapped.path.startsWith('/') ? mapped.path : `/${mapped.path}`;
  const url = `${API_BASE}${p}`;
  const { data, status } = await axios.post(url, form, {
    timeout,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true
  });
  if (status >= 400) {
    throw new Error(typeof data === 'object' ? JSON.stringify(data).slice(0, 200) : `HTTP ${status}`);
  }
  if (typeof data === 'string') {
    try {
      return scrubApiData(JSON.parse(data));
    } catch (_) {
      return { url: data, raw: data };
    }
  }
  return scrubApiData(data);
}

const SKIP_MEDIA_KEYS = new Set([
  'cover', 'thumb', 'thumbnail', 'origincover', 'dynamiccover', 'avatar',
  'avatarthumb', 'avatarmedium', 'author', 'statistics', 'hashtag', 'music_info'
]);

function isHttpUrl(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim());
}

function isApiSelfUrl(s) {
  try {
    const target = new URL(String(s));
    const base = new URL(API_BASE);
    if (target.hostname.replace(/^www\./i, '') !== base.hostname.replace(/^www\./i, '')) return false;
    if (/\.(mp4|m4a|mp3|webm|mov|mkv|jpg|jpeg|png|webp|gif)(\?|$)/i.test(target.pathname)) return false;
    return /\/api\//i.test(target.pathname);
  } catch (_) {
    return false;
  }
}

function isPageShareUrl(s) {
  const u = String(s || '');
  if (/(tiktokcdn|tikcdn|muscdn|bytecdn|fbcdn|cdninstagram|scontent|googlevideo|ytimg|pinimg|twimg)/i.test(u)) {
    return false;
  }
  return /^https?:\/\/(www\.|m\.|vm\.|vt\.|mobile\.)?(tiktok\.com|instagram\.com|instagr\.am|facebook\.com|fb\.watch|fb\.com|twitter\.com|x\.com|threads\.net|pinterest\.com|pin\.it|kwai\.com|capcut\.com)\b/i.test(u);
}

function isLikelyMediaUrl(u) {
  const s = String(u || '');
  if (!isHttpUrl(s)) return false;
  if (isPageShareUrl(s) || isApiSelfUrl(s)) return false;
  if (/\.(mp4|m4a|mp3|webm|mov|mkv|aac|ogg|opus|jpg|jpeg|png|webp|gif)(\?|$)/i.test(s)) return true;
  if (/(tiktokcdn|tikcdn|muscdn|bytecdn|fbcdn|cdninstagram|scontent|googlevideo|ytimg|pinimg|twimg)/i.test(s)) return true;
  if (/\/(video|audio|play|download|media)\//i.test(s)) return true;
  return false;
}

function isPlayableVideoBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return false;
  const ascii = buf.slice(0, 12).toString('utf8');
  if (/^\s*[<{]/.test(ascii) || /^(ID3|OggS)/.test(ascii)) return false;
  const box = buf.slice(4, 8).toString('ascii');
  if (box === 'ftyp') {
    const probe = Buffer.concat([
      buf.slice(0, Math.min(buf.length, 512 * 1024)),
      buf.slice(Math.max(0, buf.length - 256 * 1024))
    ]).toString('binary');
    return /moov|mdat/.test(probe);
  }
  // webm/mkv
  return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
}

/** mp3/m4a/ogg/wav completo o bastante pro Zap nao marcar corrompido. */
function sniffAudioKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 * 1024) return null;
  const h = buf.slice(0, 16);
  const s = h.toString('utf8');
  const box = buf.slice(4, 8).toString('ascii');
  const brand = buf.slice(8, 12).toString('ascii');
  if (s.startsWith('ID3')) return 'mp3';
  if (h[0] === 0xff && (h[1] & 0xe0) === 0xe0 && h[1] !== 0xd8) return 'mp3';
  if (s.startsWith('OggS')) return 'ogg';
  if (s.startsWith('RIFF') && buf.slice(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (box === 'ftyp') return 'mp4';
  return null;
}

function isRealMediaBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  const h = buf.slice(0, 16);
  const s = h.toString('utf8');
  if (s.trimStart().startsWith('{') || s.trimStart().startsWith('[') || /<(!doctype|html)/i.test(s)) {
    return false;
  }
  if (s.includes('ftyp') || buf.slice(4, 8).toString('ascii') === 'ftyp') return isPlayableVideoBuffer(buf);
  if (h[0] === 0x1a && h[1] === 0x45) return true;
  if (s.startsWith('ID3') || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return true;
  if (h[0] === 0xff && h[1] === 0xd8) return true;
  if (h[0] === 0x89 && h[1] === 0x50) return true;
  if (s.startsWith('RIFF') || s.startsWith('OggS')) return true;
  return false;
}

function guessMediaKind(buf, contentType = '') {
  const ct = String(contentType || '').toLowerCase();
  const h = Buffer.isBuffer(buf) ? buf.slice(0, 16) : Buffer.alloc(0);
  const s = h.toString('utf8');
  if (/webp/i.test(ct) || (h.length >= 12 && h.slice(8, 12).toString('ascii') === 'WEBP')) return 'sticker';
  if (/video/i.test(ct) || s.includes('ftyp') || (h[0] === 0x1a && h[1] === 0x45)) return 'video';
  if (/gif/i.test(ct) || s.startsWith('GIF8')) return 'gif';
  if (
    /audio|mpeg|ogg|mp3/i.test(ct) ||
    s.startsWith('ID3') ||
    s.startsWith('OggS') ||
    (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)
  ) {
    return 'audio';
  }
  if (/image/i.test(ct) || (h[0] === 0xff && h[1] === 0xd8) || (h[0] === 0x89 && h[1] === 0x50)) {
    return 'image';
  }
  if (s.startsWith('RIFF')) {
    const four = h.slice(8, 12).toString('ascii');
    if (four === 'AVI ') return 'video';
    if (four === 'WAVE') return 'audio';
  }
  return 'unknown';
}

function pickMediaUrl(obj, depth = 0) {
  if (obj == null || depth > 6) return null;
  if (typeof obj === 'string') {
    const u = obj.trim();
    if (!isLikelyMediaUrl(u)) return null;
    return u;
  }
  if (Array.isArray(obj)) {
    let fallback = null;
    for (const x of obj) {
      const u = pickMediaUrl(x, depth + 1);
      if (!u) continue;
      if (isLikelyMediaUrl(u)) return u;
      if (!fallback) fallback = u;
    }
    return fallback;
  }
  if (typeof obj !== 'object') return null;

  const preferKeys = [
    'videoHD', 'videoSD', 'videoWatermark', 'hdplay', 'wmplay', 'play',
    'nowm_hd', 'nowm', 'playAddr', 'downloadAddr', 'playUrl',
    'mp4', 'mp3', 'hd', 'sd', 'video', 'audio', 'music',
    'mediaUrl', 'media', 'download', 'dl', 'stream', 'file',
    'url', 'link', 'image', 'img', 'imagem', 'foto'
  ];
  const seen = new Set();
  for (const k of preferKeys) {
    if (obj[k] == null) continue;
    seen.add(k.toLowerCase());
    const u = pickMediaUrl(obj[k], depth + 1);
    if (u && isLikelyMediaUrl(u)) return u;
    if (u && !/tiktok\.com\/@|instagram\.com\/|facebook\.com\//i.test(u)) return u;
  }

  const wrap = obj.resultado || obj.result || obj.data || obj.Instagram || obj.resultados;
  if (wrap && wrap !== obj) {
    const nested = pickMediaUrl(wrap, depth + 1);
    if (nested) return nested;
  }

  for (const [k, v] of Object.entries(obj)) {
    if (seen.has(k.toLowerCase()) || SKIP_MEDIA_KEYS.has(k.toLowerCase())) continue;
    const u = pickMediaUrl(v, depth + 1);
    if (u && isLikelyMediaUrl(u)) return u;
  }
  return null;
}

/** @deprecated Prefer formatApiUserText — so log/debug */
function summarizeJson(data, maxLen = 3500) {
  const { pickTextField, formatApiUserText } = require('../core/zt/responseFormat');
  const text = pickTextField(data);
  if (text) return text.slice(0, maxLen);
  const formatted = formatApiUserText({ cmd: 'API' }, data);
  return String(formatted.text || '').slice(0, maxLen);
}

module.exports = {
  API_BASE,
  API_KEY: () => API_KEY,
  ensureKey,
  apiUrl,
  getJson,
  postJson,
  fetchBuffer,
  fetchBufferFromApi,
  request,
  uploadMultipart,
  pickMediaUrl,
  isRealMediaBuffer,
  sniffAudioKind,
  isPlayableVideoBuffer,
  isLikelyMediaUrl,
  isPageShareUrl,
  guessMediaKind,
  summarizeJson
};
