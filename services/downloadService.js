// services/downloadService.js
// Camada central de downloads (Hanork API): busca meta + baixa buffer

require('dotenv').config();
const axios = require('axios');
const logger = require('../logger');
const { sanitizeBrand, scrubApiData, looksLikeHtml } = require('../utils/brandSanitize');
const {
  API_BASE,
  ensureKey,
  apiUrl,
  getJson,
  fetchBuffer: ztFetchBuffer,
  fetchBufferFromApi,
  pickMediaUrl
} = require('./zerotwoClient');
const { enforceSearchQuery } = require('../utils/searchQueryLimit');

function qIn(query) {
  return enforceSearchQuery(query);
}

/** Compat: alguns callers esperam Buffer direto */
async function fetchBuffer(url, timeout = 90000, maxBytes = 80 * 1024 * 1024) {
  const r = await ztFetchBuffer(url, timeout, maxBytes);
  return r.buffer !== undefined ? r : r;
}

function asPlayableVideo(buf) {
  try {
    const { isPlayableVideoBuffer } = require('./zerotwoClient');
    return isPlayableVideoBuffer(buf) ? buf : null;
  } catch (_) {
    return null;
  }
}

function pickTiktokMusic(r) {
  if (!r || typeof r !== 'object') return null;
  return firstHttpUrl(
    r.music,
    r.music_info?.play,
    r.music_info?.play_url,
    r.music_info?.url,
    r.origin_music,
    r.music_url,
    r.music?.play_url,
    r.music?.url,
    r.music?.playUrl
  );
}

async function withTiktokMusic(out, r) {
  const hasRealVideo = !!out.videoBuffer;
  const hasPhotos = Array.isArray(out.imageBuffers) && out.imageBuffers.length;
  // Video real ja vem com som. So busca faixa extra em post de FOTO.
  if (hasRealVideo && !hasPhotos) return out;
  const music = pickTiktokMusic(r) || out.audioUrl || null;
  out.audioUrl = music;
  if (music && !out.audioBuffer) {
    try {
      out.audioBuffer = (await fetchBuffer(music, 60000)).buffer;
    } catch (e) {
      logger.logAviso(`[download/tiktok] music: ${e.message}`);
    }
  }
  return out;
}

function firstHttpUrl(...candidates) {
  const { isPageShareUrl } = require('./zerotwoClient');
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'string' && /^https?:\/\//i.test(c.trim())) {
      const u = c.trim();
      if (!isPageShareUrl(u)) return u;
      continue;
    }
    if (Array.isArray(c)) {
      for (const x of c) {
        const u = firstHttpUrl(x);
        if (u) return u;
      }
    }
    if (typeof c === 'object') {
      const u = firstHttpUrl(
        c.playAddr, c.downloadAddr, c.hdplay, c.play, c.hd, c.sd,
        c.url, c.link, c.href, c.src, c.video
      );
      if (u) return u;
    }
  }
  return null;
}

/**
 * Cobalt community instances (sem JWT). Bom pra Facebook/YouTube;
 * outras redes variam conforme a instancia.
 */
async function downloadViaCobalt(url, { prefer = 'auto' } = {}) {
  const instances = [
    'https://dwnld.nichind.dev/',
    'https://cobalt.api.timelessnesses.me/'
  ];
  const https = require('https');
  const agent = new https.Agent({ rejectUnauthorized: false });
  const errors = [];
  for (const base of instances) {
    try {
      const { data, status } = await axios.post(
        base,
        {
          url,
          videoQuality: '720',
          filenameStyle: 'basic',
          downloadMode: prefer === 'audio' ? 'audio' : 'auto'
        },
        {
          timeout: 30000,
          validateStatus: () => true,
          httpsAgent: agent,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 HanorkBot/1.0'
          }
        }
      );
      if (status >= 400 || !data || data.status === 'error') {
        errors.push(`${base} ${data?.error?.code || status}`);
        continue;
      }
      const mediaUrl =
        data.url ||
        data.tunnel ||
        (Array.isArray(data.picker) ? data.picker.find((p) => p?.url)?.url : null);
      if (!mediaUrl) {
        errors.push(`${base} sem url`);
        continue;
      }
      // tunnel HTTP interno — fetchBuffer precisa aceitar
      const mediaBuffer = (await fetchBuffer(mediaUrl, 120000)).buffer;
      const type =
        prefer === 'audio' || /\.(mp3|m4a|opus)(\?|$)/i.test(mediaUrl)
          ? 'audio'
          : /\.(mp4|webm|mov)(\?|$)/i.test(mediaUrl) || data.status === 'tunnel'
            ? 'video'
            : 'image';
      return {
        title: data.filename || 'Download',
        mediaUrl,
        mediaBuffer,
        type,
        raw: data
      };
    } catch (e) {
      errors.push(`${base}: ${e.message}`);
    }
  }
  throw new Error(errors.join(' | ') || 'Cobalt sem midia');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function firstOk(promises) {
  const list = (promises || []).filter(Boolean);
  if (!list.length) return Promise.reject(new Error('sem tentativas'));
  return Promise.any(list);
}

/**
 * Busca videos no YouTube (texto)
 */
async function searchYoutube(query) {
  ensureKey();
  const q = qIn(query);
  if (!q) return [];
  const data = await getJson('/api/ytsrc', { q });
  const list = data?.resultado || data?.result || data?.videos || [];
  if (!Array.isArray(list) || list.length === 0) return [];
  return list
    .map((item) => ({
      title: item.title || item.titulo || 'Sem titulo',
      url: item.url || item.link || '',
      thumbnail: item.thumbnail || item.thumb || item.image || '',
      duration: item.timestamp || item.duration || item.tempo || '',
      channel: item.author?.name || item.channel || item.author || ''
    }))
    .filter((i) => i.url);
}

function youtubeAudioUrl(videoUrl) {
  return apiUrl('/api/dl/ytaudio', { url: videoUrl });
}

function youtubeVideoUrl(videoUrl) {
  return apiUrl('/api/dl/ytvideo2', { url: videoUrl });
}

async function playAudioViaBtch(videoUrl) {
  const { youtube } = require('btch-downloader');
  const data = await youtube(String(videoUrl));
  if (!data?.status || !data?.mp3) {
    throw new Error(data?.message || 'btch youtube sem mp3');
  }
  const r = await fetchBuffer(data.mp3, 90000);
  return {
    buffer: r.buffer,
    title: data.title || '',
    thumbnail: data.thumbnail || '',
    channel: data.author || ''
  };
}

async function playMedia(query) {
  ensureKey();
  const q = qIn(query);
  if (!q) throw new Error('Informe o nome da musica ou um link do YouTube');

  const isUrl = /https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(q);
  let meta;

  if (isUrl) {
    meta = { title: q, url: q, thumbnail: '', duration: '', channel: '' };
    try {
      const found = await searchYoutube(q);
      if (found[0]) meta = { ...found[0], url: q };
    } catch (_) { /* ignore */ }
  } else {
    const found = await searchYoutube(q);
    if (!found.length) throw new Error('Nenhum resultado encontrado');
    meta = found[0];
  }

  const audioUrl = youtubeAudioUrl(meta.url);
  const videoUrl = youtubeVideoUrl(meta.url);

  let audioBuffer = null;
  let audioErr = null;
  // ytaudio (sem numero) na host/CF fica 25s+ com 0 bytes. ytaudio2 responde ~4s.
  const paths = ['/api/dl/ytaudio2', '/api/dl/ytaudio3'];
  try {
    audioBuffer = await firstOk(
      paths.map((path) =>
        fetchBufferFromApi(path, { url: meta.url }, path.endsWith('2') ? 18000 : 32000).then((r) => {
          const buf = r.buffer;
          if (!Buffer.isBuffer(buf) || buf.length < 24 * 1024) {
            throw new Error(`${path}: arquivo curto`);
          }
          const box = buf.slice(4, 8).toString('ascii');
          const head = buf.slice(0, 4).toString('utf8');
          if (
            box !== 'ftyp' &&
            !head.startsWith('ID3') &&
            !(buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) &&
            !head.startsWith('OggS')
          ) {
            throw new Error(`${path}: nao e audio`);
          }
          return buf;
        })
      )
    );
  } catch (e) {
    audioErr = e;
    logger.logAviso(`[download/play] rotas paralelas: ${e.message}`);
  }

  if (audioBuffer) {
    try {
      const { toPlayableMp3 } = require('./stillAudioMux');
      audioBuffer = await toPlayableMp3(audioBuffer);
    } catch (e) {
      logger.logAviso(`[download/play] ffmpeg mp3: ${e.message} — envia o arquivo original`);
    }
  }

  if (!audioBuffer) {
    try {
      logger.logAviso('[download/play] fallback btch-downloader');
      const fb = await playAudioViaBtch(meta.url);
      audioBuffer = fb.buffer;
      if (fb.title) meta.title = meta.title || fb.title;
      if (fb.thumbnail) meta.thumbnail = meta.thumbnail || fb.thumbnail;
      if (fb.channel) meta.channel = meta.channel || fb.channel;
    } catch (e) {
      logger.logAviso(`[download/play] btch: ${e.message}`);
      audioErr = e;
    }
  }

  if (!audioBuffer) {
    const tip = /ECONNREFUSED|ENOTFOUND|socket hang up|timeout/i.test(String(audioErr?.message || ''))
      ? 'API de audio temporariamente offline — tente de novo em instantes'
      : (audioErr?.message || 'Falha ao baixar audio YouTube');
    throw new Error(tip);
  }

  return {
    ...meta,
    audioUrl,
    videoUrl,
    audioBuffer
  };
}

async function playVideoMedia(query) {
  const base = await (async () => {
    const q = qIn(query);
    if (!q) throw new Error('Informe o nome ou link do YouTube');
    const isUrl = /https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(q);
    if (isUrl) {
      let meta = { title: q, url: q, thumbnail: '', duration: '', channel: '' };
      try {
        const found = await searchYoutube(q);
        if (found[0]) meta = { ...found[0], url: q };
      } catch (_) {}
      return meta;
    }
    const found = await searchYoutube(q);
    if (!found.length) throw new Error('Nenhum resultado encontrado');
    return found[0];
  })();

  let videoBuffer = null;
  let lastErr = null;
  try {
    const r = await firstOk(
      ['/api/dl/ytvideo2', '/api/dl/ytvideo3', '/api/dl/ytvideo4'].map((path) =>
        fetchBufferFromApi(path, { url: base.url }, 35000).then((got) => {
          const buf = asPlayableVideo(got.buffer);
          if (!buf) throw new Error(`${path}: nao e mp4`);
          return buf;
        })
      )
    );
    videoBuffer = r;
  } catch (e) {
    lastErr = e;
    logger.logAviso(`[download/playvideo] paralelo: ${e.message}`);
  }
  if (!videoBuffer) throw lastErr || new Error('Falha ao baixar video YouTube');

  return {
    ...base,
    videoUrl: youtubeVideoUrl(base.url),
    videoBuffer
  };
}

async function downloadTiktokViaBtch(url) {
  const errors = [];
  // 1) tikwm (publico) — costuma funcionar quando ZT/btch falham
  try {
    const { data } = await axios.get('https://www.tikwm.com/api/', {
      params: { url, hd: 1 },
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tikwm.com/' }
    });
    const r = data?.data || data;
    const video = r?.hdplay || r?.play || r?.wmplay || null;
    const slides = Array.isArray(r.images) ? r.images : [];
    if (video) {
      const videoBuffer = asPlayableVideo((await fetchBuffer(video, 90000)).buffer);
      if (videoBuffer) {
        const imageBuffers = [];
        for (const img of slides.slice(0, 8)) {
          const u = typeof img === 'string' ? img : img?.url;
          if (!u) continue;
          try {
            imageBuffers.push((await fetchBuffer(u, 60000)).buffer);
          } catch (_) { /* skip */ }
        }
        return withTiktokMusic({
          title: r.title || 'TikTok',
          author: r.author?.nickname || r.author?.unique_id || '',
          videoUrl: video,
          videoBuffer,
          images: slides,
          imageBuffers,
          raw: r
        }, r);
      }
      errors.push('tikwm: arquivo nao e mp4');
    }
    if (slides.length) {
      const imageBuffers = [];
      for (const img of slides.slice(0, 8)) {
        const u = typeof img === 'string' ? img : img?.url;
        if (!u) continue;
        try {
          imageBuffers.push((await fetchBuffer(u, 60000)).buffer);
        } catch (_) { /* skip */ }
      }
      let audioBuffer = null;
      if (r.music) {
        try {
          audioBuffer = (await fetchBuffer(r.music, 60000)).buffer;
        } catch (_) { /* opcional */ }
      }
      if (imageBuffers.length) {
        return withTiktokMusic({
          title: r.title || 'TikTok',
          author: r.author?.nickname || r.author?.unique_id || '',
          videoUrl: null,
          videoBuffer: null,
          images: slides,
          imageBuffers,
          audioBuffer,
          raw: r
        }, r);
      }
    }
    errors.push(`tikwm: ${data?.msg || 'sem video'}`);
  } catch (e) {
    errors.push(`tikwm: ${e.message}`);
  }
  try {
    const { ttdl } = require('btch-downloader');
    const res = await ttdl(url);
    const r = res?.result || res || {};
    const video =
      firstHttpUrl(r.video, r.video_hd, r.video_nowm, r.nowm, r.url) || null;
    if (video) {
      const videoBuffer = asPlayableVideo((await fetchBuffer(video, 90000)).buffer);
      if (!videoBuffer) {
        errors.push('btch: arquivo nao e mp4');
      } else {
        return withTiktokMusic({
          title: r.title || r.desc || 'TikTok',
          author: r.author || r.creator || '',
          videoUrl: video,
          videoBuffer,
          images: [],
          imageBuffers: [],
          raw: r
        }, r);
      }
    }
    errors.push('btch sem video');
  } catch (e) {
    errors.push(`btch: ${e.message}`);
  }
  try {
    const { ttdl } = require('ruhend-scraper');
    const res = await ttdl(url);
    const video = firstHttpUrl(res?.video, res?.url, res?.links);
    if (video) {
      const videoBuffer = asPlayableVideo((await fetchBuffer(video, 90000)).buffer);
      if (videoBuffer) {
        return withTiktokMusic({
          title: res?.title || 'TikTok',
          author: res?.author || '',
          videoUrl: video,
          videoBuffer,
          images: [],
          imageBuffers: [],
          raw: res
        }, res);
      }
      errors.push('ruhend: arquivo nao e mp4');
    }
    errors.push('ruhend sem video');
  } catch (e) {
    errors.push(`ruhend: ${e.message}`);
  }
  try {
    const c = await downloadViaCobalt(url);
    if (c?.mediaBuffer) {
      const videoBuffer = c.type === 'video' ? asPlayableVideo(c.mediaBuffer) : null;
      if (c.type === 'video' && !videoBuffer) {
        errors.push('cobalt: arquivo nao e mp4');
      } else {
        return withTiktokMusic({
          title: c.title || 'TikTok',
          author: '',
          videoUrl: c.mediaUrl,
          videoBuffer,
          images: c.type === 'image' ? [c.mediaUrl] : [],
          imageBuffers: c.type === 'image' ? [c.mediaBuffer] : [],
          audioUrl: c.type === 'audio' ? c.mediaUrl : null,
          raw: c.raw
        }, c.raw || c);
      }
    }
  } catch (e) {
    errors.push(`cobalt: ${e.message}`);
  }
  throw new Error(errors.join(' | ') || 'Fallback TikTok sem midia');
}

async function downloadTiktok(link) {
  const url = qIn(link);
  if (!url || !/tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i.test(url)) {
    throw new Error('Envie um link valido do TikTok');
  }

  // Fallbacks publicos primeiro — ZT tiktok costuma 500/vazio (nao exige apikey)
  try {
    return await downloadTiktokViaBtch(url);
  } catch (e) {
    logger.logAviso(`[download/tiktok] fallbacks: ${e.message}`);
  }

  ensureKey();
  let data = null;
  const ztPaths = [
    '/api/download/tiktok',
    '/api/download/tiktok/v2',
    '/api/download/tiktok/v3',
    '/api/download/tiktok/v4',
    '/api/dl/multi'
  ];
  try {
    data = await firstOk(
      ztPaths.map((path) =>
        getJson(path, { url }, 16000).then((d) => {
          const r = d?.resultado || d?.result || d?.data;
          if (r && typeof r === 'object' && (r.video || r.url || r.play || r.images || r.slides || r.music)) {
            return d;
          }
          if (ztPickHasMedia(d)) return d;
          throw new Error(`${path}: sem midia`);
        })
      )
    );
  } catch (e) {
    logger.logAviso(`[download/tiktok] zt paralelo: ${e.message}`);
  }

  const r = data?.resultado || data?.result || data?.data;
  if (r) {
    const video =
      firstHttpUrl(
        r.videoHD,
        r.videoSD,
        r.videoWatermark,
        r.video?.nowm_hd,
        r.video?.nowm,
        r.video?.playAddr,
        r.video?.downloadAddr,
        r.play,
        r.video,
        r.url
      ) || require('./zerotwoClient').pickMediaUrl(data);
    const images = r.slides || r.images || [];
    const audio = r.music?.url || r.music?.playUrl?.[0] || (typeof r.music === 'string' ? r.music : null);

    let videoBuffer = null;
    if (typeof video === 'string') {
      try {
        videoBuffer = asPlayableVideo((await fetchBuffer(video, 90000)).buffer);
      } catch (e) {
        logger.logAviso(`[download/tiktok] buffer: ${e.message}`);
      }
    }

    const imageBuffers = [];
    for (const img of (Array.isArray(images) ? images : []).slice(0, 5)) {
      const u = typeof img === 'string' ? img : img?.url;
      if (!u) continue;
      try {
        imageBuffers.push((await fetchBuffer(u, 60000)).buffer);
      } catch (_) {}
    }

    if (videoBuffer || imageBuffers.length) {
      let audioBuffer = null;
      const audioUrl = typeof audio === 'string' ? audio : null;
      return withTiktokMusic({
        title: r.desc || r.title || 'TikTok',
        author: r.author?.nickname || r.author?.unique_id || r.author || '',
        videoUrl: typeof video === 'string' ? video : null,
        videoBuffer,
        images: Array.isArray(images) ? images : [],
        imageBuffers,
        audioUrl,
        audioBuffer,
        raw: r
      }, r);
    }
  }

  throw new Error(
    'TikTok indisponivel agora (API/fallbacks fora). Cole o link de novo em alguns minutos.'
  );
}

function ztPickHasMedia(data) {
  try {
    const { pickMediaUrl } = require('./zerotwoClient');
    return !!pickMediaUrl(data);
  } catch (_) {
    return false;
  }
}

/** Normaliza link IG (tira query igsh=, trailing lixo, pega URL no meio do texto) */
function cleanInstagramUrl(link) {
  let s = String(link || '').trim().replace(/[)\].,;]+$/, '');
  const found = s.match(
    /https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am|ddinstagram\.com|kkinstagram\.com)\/[^\s<>"']+/i
  );
  if (found) s = found[0].replace(/[)\].,;]+$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (!/instagram\.com|instagr\.am|ddinstagram\.com|kkinstagram\.com/i.test(u.hostname)) return s;
    if (/ddinstagram\.com|kkinstagram\.com|instagr\.am/i.test(u.hostname)) u.hostname = 'www.instagram.com';
    u.search = '';
    u.hash = '';
    if (!u.hostname.startsWith('www.')) u.hostname = `www.${u.hostname}`;
    let out = u.toString();
    if (!out.endsWith('/')) out += '/';
    return out;
  } catch (_) {
    return s.split('?')[0];
  }
}

async function getJsonLoose(path, params, timeout = 60000) {
  const url = apiUrl(path, params);
  const { data, status, headers } = await axios.get(url, {
    timeout,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(d) => d]
  });
  const raw = typeof data === 'string' ? data : String(data ?? '');
  const ct = String(headers?.['content-type'] || '');
  if (/text\/html/i.test(ct) || looksLikeHtml(raw)) {
    return { data: null, status, html: true };
  }
  try {
    return { data: scrubApiData(JSON.parse(raw)), status };
  } catch (_) {
    return { data: null, status, invalidJson: true };
  }
}

async function downloadInstagramViaBtch(url) {
  const errors = [];
  try {
    const { igdl } = require('ruhend-scraper');
    const res = await igdl(url);
    const list = Array.isArray(res) ? res : res?.data || res?.result || [];
    const mediaUrl = firstHttpUrl(list, res?.url, res?.video, res?.image);
    if (mediaUrl) {
      const type = /\.mp4|video/i.test(mediaUrl) ? 'video' : 'image';
      const mediaBuffer = (await fetchBuffer(mediaUrl, 90000)).buffer;
      return {
        title: res?.title || res?.caption || 'Instagram',
        mediaUrl,
        mediaBuffer,
        type,
        items: Array.isArray(list) ? list.slice(0, 6) : [mediaUrl],
        raw: res
      };
    }
    errors.push('ruhend sem midia');
  } catch (e) {
    errors.push(`ruhend: ${e.message}`);
  }
  try {
    const { instagramGetUrl } = require('instagram-url-direct');
    const res = await instagramGetUrl(url);
    const list = res?.url_list || res?.media_details || [];
    const firstUrl = firstHttpUrl(list);
    if (firstUrl) {
      const type = /\.mp4|video/i.test(firstUrl) ? 'video' : 'image';
      const mediaBuffer = (await fetchBuffer(firstUrl, 90000)).buffer;
      return {
        title: res?.post_info?.caption || 'Instagram',
        mediaUrl: firstUrl,
        mediaBuffer,
        type,
        items: (Array.isArray(list) ? list : []).slice(0, 6),
        raw: res
      };
    }
    errors.push('instagram-url-direct sem midia');
  } catch (e) {
    errors.push(`ig-direct: ${e.message}`);
  }
  try {
    const { igdl } = require('btch-downloader');
    const res = await igdl(url);
    const items = (res?.result || []).filter((x) => x && firstHttpUrl(x.url, x));
    if (!items.length) throw new Error('Fallback IG sem midia');
    const mediaUrl = firstHttpUrl(items[0].url, items[0]);
    const type = /\.mp4|video/i.test(String(items[0].type || mediaUrl)) ? 'video' : 'image';
    const mediaBuffer = (await fetchBuffer(mediaUrl, 90000)).buffer;
    return {
      title: items[0].title || items[0].caption || 'Instagram',
      mediaUrl,
      mediaBuffer,
      type,
      items: items.slice(0, 6),
      raw: res
    };
  } catch (e) {
    errors.push(`btch: ${e.message}`);
  }
  try {
    const c = await downloadViaCobalt(url);
    return {
      title: c.title || 'Instagram',
      mediaUrl: c.mediaUrl,
      mediaBuffer: c.mediaBuffer,
      type: c.type === 'audio' ? 'video' : c.type,
      items: [c.mediaUrl],
      raw: c.raw
    };
  } catch (e) {
    errors.push(`cobalt: ${e.message}`);
  }
  throw new Error(errors.join(' | ') || 'Fallback IG sem midia');
}

async function downloadInstagram(link) {
  const url = cleanInstagramUrl(qIn(link));
  if (!url || !/instagram\.com/i.test(url)) {
    throw new Error('Envie um link valido do Instagram');
  }

  // Fallbacks primeiro — ZT IG frequentemente "api off"/500 (nao exige apikey)
  try {
    return await downloadInstagramViaBtch(url);
  } catch (e) {
    logger.logAviso(`[download/ig] fallbacks: ${e.message}`);
  }

  ensureKey();
  let data = null;
  try {
    data = await firstOk(
      ['/api/dl/instagram', '/api/instagram/post'].map((path) =>
        getJsonLoose(path, { url }, 16000).then(({ data: body, status }) => {
          const hasMedia =
            body?.Instagram?.resultados?.data?.video?.length ||
            body?.Instagram?.resultados?.data?.images?.length ||
            body?.Instagram?.resultados?.data?.thumb?.length ||
            body?.resultado?.links?.length ||
            body?.resultado?.url ||
            pickMediaUrl(body);
          if (!hasMedia) throw new Error(`${path}: HTTP ${status} sem midia`);
          return body;
        })
      )
    );
  } catch (e) {
    logger.logAviso(`[download/ig] zt paralelo: ${e.message}`);
  }

  // Formato Instagram.resultados.data
  const ig = data?.Instagram;
  if (ig?.resultados?.data) {
    const d = ig.resultados.data;
    const video = Array.isArray(d.video) ? d.video.find(Boolean) : d.video;
    const image =
      (Array.isArray(d.images) ? d.images.find(Boolean) : d.images) ||
      (Array.isArray(d.thumb) ? d.thumb.find(Boolean) : d.thumb);
    const mediaUrl = video || image || null;
    if (mediaUrl) {
      const type = video ? 'video' : 'image';
      const buf = (await fetchBuffer(mediaUrl, 90000)).buffer;
      return {
        title: d.caption || d.title || d.description || 'Instagram',
        mediaUrl,
        mediaBuffer: buf,
        type,
        raw: ig
      };
    }
  }

  // Formato /api/instagram/post
  const post = data?.resultado;
  if (post?.links?.length) {
    const media = post.links[0];
    const mediaUrl = media.url;
    if (mediaUrl) {
      const type = media.type === 'video' || /\.mp4/i.test(mediaUrl) ? 'video' : 'image';
      const mediaBuffer = (await fetchBuffer(mediaUrl, 90000)).buffer;
      return {
        title: post.caption || post.name || 'Instagram',
        mediaUrl,
        mediaBuffer,
        type,
        raw: post
      };
    }
  }

  // resultado.url[] (instareels) — so se for arquivo/CDN, nunca o link do post
  if (post?.url?.length) {
    const mediaUrl = pickMediaUrl(post.url);
    if (mediaUrl) {
      const mediaBuffer = (await fetchBuffer(mediaUrl, 90000)).buffer;
      return {
        title: post.caption || 'Instagram',
        mediaUrl,
        mediaBuffer,
        type: /\.mp4/i.test(mediaUrl) ? 'video' : 'image',
        raw: post
      };
    }
  }

  const picked = pickMediaUrl(data);
  if (picked) {
    const mediaBuffer = (await fetchBuffer(picked, 90000)).buffer;
    return {
      title: post?.caption || data?.Instagram?.resultados?.data?.caption || 'Instagram',
      mediaUrl: picked,
      mediaBuffer,
      type: /\.mp4|video/i.test(picked) ? 'video' : 'image',
      raw: data
    };
  }

  throw new Error(
    'Instagram indisponivel agora (API offline). Cole um link de post/reel valido e tente de novo.'
  );
}

async function downloadFacebook(link) {
  ensureKey();
  const url = qIn(link);
  if (!url || !/facebook\.com|fb\.watch|fb\.com/i.test(url)) {
    throw new Error('Envie um link valido do Facebook');
  }

  // Fallbacks publicos primeiro — ZT facebook costuma timeout/404
  try {
    const { fbdl, fbdl2 } = require('ruhend-scraper');
    let mediaUrl = null;
    let raw = null;
    try {
      const res = await fbdl(url);
      mediaUrl = firstHttpUrl(res);
      raw = res;
    } catch (_) { /* try v2 */ }
    if (!mediaUrl) {
      try {
        const res2 = await fbdl2(url);
        const arr = res2?.data || res2;
        mediaUrl = firstHttpUrl(
          Array.isArray(arr) ? arr.map((x) => x.url || x.link || x) : arr
        );
        raw = res2;
      } catch (_) { /* ignore */ }
    }
    if (mediaUrl) {
      const mediaBuffer = (await fetchBuffer(mediaUrl, 120000)).buffer;
      return { title: 'Facebook', mediaUrl, mediaBuffer, type: 'video', raw };
    }
  } catch (e) {
    logger.logAviso(`[download/fb] ruhend: ${e.message}`);
  }
  try {
    const { fbdown } = require('btch-downloader');
    const res = await fbdown(url);
    const mediaUrl = firstHttpUrl(
      res?.HD,
      res?.Normal_video,
      res?.hd,
      res?.sd,
      res?.url,
      res?.result
    );
    if (mediaUrl) {
      const mediaBuffer = (await fetchBuffer(mediaUrl, 120000)).buffer;
      return { title: res?.title || 'Facebook', mediaUrl, mediaBuffer, type: 'video', raw: res };
    }
  } catch (e) {
    logger.logAviso(`[download/fb] btch: ${e.message}`);
  }
  try {
    const c = await downloadViaCobalt(url);
    return {
      title: c.title || 'Facebook',
      mediaUrl: c.mediaUrl,
      mediaBuffer: c.mediaBuffer,
      type: 'video',
      raw: c.raw
    };
  } catch (e) {
    logger.logAviso(`[download/fb] cobalt: ${e.message}`);
  }

  let data = null;
  try {
    data = await firstOk(
      ['/download/facebook', '/download/facebook2', '/download/facebook3', '/api/dl/facebook'].map((path) =>
        getJson(path, { url }, 16000).then((d) => {
          if (d?.resultado || d?.result) return d;
          throw new Error(`${path}: sem resultado`);
        })
      )
    );
  } catch (e) {
    logger.logAviso(`[download/fb] zt paralelo: ${e.message}`);
  }

  const r = data?.resultado || data?.result;
  if (!r) throw new Error('Falha ao baixar Facebook (API e fallbacks). Cole o link de novo.');

  let mediaUrl = null;
  let title = 'Facebook';
  if (Array.isArray(r)) {
    const hd = r.find((v) => String(v.resolution || '').includes('HD'));
    const sd = r.find((v) => String(v.resolution || '').includes('SD'));
    const selected = hd || sd || r[0];
    mediaUrl = firstHttpUrl(selected?.url, selected?.link, selected);
  } else {
    mediaUrl = firstHttpUrl(r.media?.url, r.video, r.url, r.link, r.HD, r.Normal_video);
    title = r.description || r.title || 'Facebook';
  }
  if (!mediaUrl) throw new Error('Nenhum video disponivel');
  const mediaBuffer = (await fetchBuffer(mediaUrl, 120000)).buffer;
  return { title, mediaUrl, mediaBuffer, type: 'video', raw: r };
}

function isSpotifyPageUrl(u) {
  return /(?:open\.)?spotify\.com|spotify\.link/i.test(String(u || ''));
}

function collectSpotifyTracks(data) {
  if (!data || typeof data !== 'object') return [];
  const buckets = [
    data.resultado,
    data.result,
    data.resultados,
    data.data,
    data.tracks,
    data.items,
    data.resultado?.tracks,
    data.result?.tracks,
    data.data?.tracks,
    data.resultado?.items
  ];
  for (const b of buckets) {
    if (Array.isArray(b) && b.length && typeof b[0] === 'object') return b;
  }
  const obj = data.resultado || data.result || data.data;
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (
      obj.spotify_url ||
      obj.url ||
      obj.link ||
      obj.id ||
      obj.nome ||
      obj.title ||
      obj.titulo ||
      obj.download
    ) {
      return [obj];
    }
  }
  return [];
}

function pickSpotifyAudioUrl(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const ordered = firstHttpUrl(
    obj.download,
    obj.dl,
    obj.mp3,
    obj.audio,
    obj.link,
    obj.preview,
    obj.preview_url,
    obj.media
  );
  if (ordered && !isSpotifyPageUrl(ordered)) return ordered;
  const picked = pickMediaUrl(obj);
  if (picked && !isSpotifyPageUrl(picked)) return picked;
  return null;
}

function spotifyTrackMeta(first, fallback = {}) {
  const title =
    first?.nome || first?.name || first?.title || first?.titulo || fallback.title || 'Spotify';
  let artist = fallback.artist || '';
  if (Array.isArray(first?.artistas)) artist = first.artistas.filter(Boolean).join(', ');
  else if (first?.trackArtist || first?.artist || first?.artista) {
    artist = String(first.trackArtist || first.artist || first.artista);
  }
  const duration = first?.duracao || first?.duration || fallback.duration || '';
  let trackUrl = fallback.url || '';
  const id = first?.id ? String(first.id) : '';
  const cand =
    first?.spotify_url ||
    first?.external_url ||
    (isSpotifyPageUrl(first?.url) ? first.url : '') ||
    (isSpotifyPageUrl(first?.link) ? first.link : '') ||
    (id && !/^https?:/i.test(id) ? `https://open.spotify.com/track/${id}` : '');
  if (cand) trackUrl = cand;
  return { title, artist, duration, url: trackUrl };
}

async function playFallbackAudio(query, meta = {}) {
  const playQ =
    meta.title && meta.title !== 'Spotify'
      ? `${meta.title} ${meta.artist || ''}`.trim()
      : String(query || '').replace(/https?:\/\/\S+/gi, '').trim() || String(query || '').trim();
  if (!playQ || isSpotifyPageUrl(playQ)) throw new Error('Falha ao baixar Spotify');
  logger.logAviso(`[download/spotify] play q=${playQ.slice(0, 80)}`);
  const via = await playMedia(playQ);
  return {
    title: (meta.title && meta.title !== 'Spotify' ? meta.title : via.title) || 'Spotify',
    artist: meta.artist || via.channel || '',
    duration: meta.duration || via.duration || '',
    url: meta.url || via.url,
    audioUrl: via.audioUrl,
    audioBuffer: via.audioBuffer,
    raw: via
  };
}

async function downloadSpotify(query) {
  ensureKey();
  const q = qIn(query);
  if (!q) throw new Error('Informe link ou nome da musica Spotify');

  let meta = { title: 'Spotify', artist: '', duration: '', url: q };

  try {
    if (isSpotifyPageUrl(q)) {
      const dl = await getJson('/api/dl/spotify', { url: q }, 8000);
      const r = dl?.resultado || dl?.result || dl || {};
      meta = {
        title: r.titulo || r.title || r.metadata?.title || 'Spotify',
        artist: r.artista || r.artist || '',
        duration: r.duracao || r.duration || '',
        url: q
      };
    } else {
      const data = await getJson('/api/spotify/search', { q }, 8000);
      const list = collectSpotifyTracks(data);
      if (list[0]) meta = spotifyTrackMeta(list[0]);
    }
  } catch (e) {
    logger.logAviso(`[download/spotify] meta: ${e.message}`);
  }

  const playQ =
    meta.title && meta.title !== 'Spotify'
      ? `${meta.title} ${meta.artist || ''}`.trim()
      : q.replace(/https?:\/\/\S+/gi, '').trim() || q;

  return playFallbackAudio(playQ, meta);
}

async function downloadMediafire(link) {
  ensureKey();
  const url = qIn(link);
  if (!url || !/mediafire\.com/i.test(url)) {
    throw new Error('Envie um link valido do MediaFire');
  }
  const data = await getJson('/api/dl/mediafire', { url }, 60000);
  if (data?.status === false || data?.status === 'false') {
    throw new Error(data?.message || 'MediaFire falhou');
  }
  const linkDl = data?.link || data?.resultado?.link || data?.result?.link;
  if (!linkDl) throw new Error('Falha ao obter arquivo MediaFire');
  const filename = data.filename || data?.resultado?.filename || 'arquivo';
  const mimetype = data.mimetype || data?.resultado?.mimetype || 'application/octet-stream';
  const fileBuffer = (await fetchBuffer(linkDl, 120000)).buffer;
  return {
    filename,
    filesize: data.filesize || data?.resultado?.filesize || '-',
    extension: data.extension || data?.resultado?.extension || '',
    mimetype,
    link: linkDl,
    fileBuffer,
    raw: data
  };
}

async function downloadTwitter(link) {
  ensureKey();
  let url = qIn(link).replace(/[)\].,;]+$/, '');
  if (!url || !/(twitter\.com|x\.com)\//i.test(url)) {
    throw new Error('Envie um link valido do Twitter/X');
  }
  // normaliza x.com → twitter.com (algumas rotas ZT so aceitam twitter.com)
  url = url.replace(/https?:\/\/(www\.)?x\.com\//i, 'https://twitter.com/');

  // btch primeiro — ZT muitas vezes devolve media:[]
  try {
    const { twitter } = require('btch-downloader');
    const res = await twitter(url);
    const mediaUrl = firstHttpUrl(
      res?.url,
      res?.HD,
      res?.SD,
      res?.media,
      res?.video,
      res?.result
    );
    if (mediaUrl) {
      const mediaBuffer = (await fetchBuffer(mediaUrl, 90000)).buffer;
      return {
        title: res?.title || res?.text || 'Twitter',
        mediaUrl,
        mediaBuffer,
        type: /\.mp4/i.test(mediaUrl) ? 'video' : 'image',
        raw: res
      };
    }
  } catch (e) {
    logger.logAviso(`[download/twitter] btch: ${e.message}`);
  }
  try {
    const c = await downloadViaCobalt(url);
    return {
      title: c.title || 'Twitter',
      mediaUrl: c.mediaUrl,
      mediaBuffer: c.mediaBuffer,
      type: c.type === 'audio' ? 'video' : c.type,
      raw: c.raw
    };
  } catch (e) {
    logger.logAviso(`[download/twitter] cobalt: ${e.message}`);
  }

  let data;
  try {
    data = await getJson('/api/dl/twitter', { url }, 60000);
  } catch (e) {
    throw new Error(
      'Twitter/X indisponivel pra este link (sem midia ou API fora). Cole um post com foto/video.'
    );
  }
  const r = data?.resultado || data?.result;
  if (!r) throw new Error('Falha ao baixar Twitter');
  if (r.error) {
    throw new Error(
      'Twitter/X indisponivel pra este link (sem midia ou API fora). Cole um post com foto/video.'
    );
  }

  const mediaList = Array.isArray(r.media) ? r.media : [];
  if (mediaList.length) {
    const items = [];
    for (const m of mediaList.slice(0, 6)) {
      const mediaUrl = firstHttpUrl(m.url, m.link, m);
      if (!mediaUrl) continue;
      const type = m.type === 'video' || /\.mp4/i.test(mediaUrl) ? 'video' : 'image';
      const mediaBuffer = (await fetchBuffer(mediaUrl, 90000)).buffer;
      items.push({ url: mediaUrl, type, mediaBuffer });
    }
    if (items.length) {
      return {
        title: r.title || r.text || 'Twitter',
        mediaUrl: items[0].url,
        mediaBuffer: items[0].mediaBuffer,
        type: items[0].type,
        items,
        raw: r
      };
    }
  }

  const mediaUrl = firstHttpUrl(r.video, r.media?.video, r.url);
  if (!mediaUrl) {
    throw new Error(
      'Esse tweet nao tem midia (foto/video) ou a API nao liberou. Cole um post com midia.'
    );
  }
  const mediaBuffer = (await fetchBuffer(mediaUrl, 90000)).buffer;
  return {
    title: r.title || r.text || 'Twitter',
    mediaUrl,
    mediaBuffer,
    type: /\.mp4/i.test(mediaUrl) ? 'video' : 'image',
    raw: r
  };
}

async function fetchAttp(text, type = 'attp') {
  ensureKey();
  const t = String(text || '').trim();
  if (!t) throw new Error('Informe o texto');
  const r = await fetchBufferFromApi('/api/canvas/attps', { type: type || 'attp', texto: t }, 45000);
  return r.buffer;
}

async function downloadKwai(link) {
  ensureKey();
  let url = qIn(link);
  // Extrai URL se veio com texto extra / Intent
  const m = url.match(/https?:\/\/[^\s<>"']+/i);
  if (m) url = m[0].replace(/[),.;]+$/, '');
  url = url.replace(/[?&](utm_[^=]+|share_id|lang)=[^&]*/gi, '').replace(/[?&]$/, '');
  if (!url || !/kwai\.|kw\.ai|snackvideo/i.test(url)) {
    throw new Error('Envie um link valido do Kwai (cole a URL completa)');
  }
  let data;
  try {
    data = await getJson('/api/kwai/video', { url }, 60000);
  } catch (e) {
    const msg = String(e.message || e);
    if (/invalid\s*url/i.test(msg)) {
      throw new Error('Link Kwai invalido ou expirado. Abra o app, copie o link de novo e tente.');
    }
    throw e;
  }
  const v = data?.resultados || data?.resultado || data?.result || data?.data?.resultados || data?.data;
  const videoUrl =
    v?.video || v?.url || v?.download || v?.media ||
    (Array.isArray(v?.midias) ? v.midias[0]?.url : null) ||
    data?.video || data?.url;
  if (!videoUrl) {
    const errMsg = data?.mensagem || data?.message || data?.erro || '';
    if (/invalid\s*url/i.test(String(errMsg))) {
      throw new Error('Link Kwai invalido ou expirado. Abra o app, copie o link de novo e tente.');
    }
    throw new Error('Falha ao baixar Kwai');
  }
  const videoBuffer = (await fetchBuffer(videoUrl, 90000)).buffer;
  return {
    title: v?.titulo || v?.title || 'Kwai',
    description: v?.descricao || '',
    videoUrl,
    videoBuffer,
    author: v?.autor || v?.author || v?.usuario || v?.user || '',
    raw: v || data
  };
}

async function downloadThreads(link) {
  ensureKey();
  const url = qIn(link);
  if (!url || !/threads\.(net|com)/i.test(url)) throw new Error('Envie um link valido do Threads');

  try {
    const { threads } = require('btch-downloader');
    const res = await threads(url);
    const mediaUrl = firstHttpUrl(res?.result, res?.url, res?.video, res?.image, res?.media);
    if (mediaUrl) {
      const mediaBuffer = (await fetchBuffer(mediaUrl, 90000)).buffer;
      return {
        title: res?.title || 'Threads',
        author: res?.author || '',
        items: [{ url: mediaUrl, type: /\.mp4/i.test(mediaUrl) ? 'video' : 'image', mediaBuffer }],
        raw: res
      };
    }
  } catch (e) {
    logger.logAviso(`[download/threads] btch: ${e.message}`);
  }

  const data = await getJson('/api/dl/threads', { url }, 60000);
  const r = data?.resultados || data?.resultado || data?.result;
  if (!r) throw new Error('Falha ao baixar Threads');
  const midias = r.midias || r.media || [];
  const items = [];
  for (const m of (Array.isArray(midias) ? midias : []).slice(0, 6)) {
    const mediaUrl = firstHttpUrl(m.urls?.[0]?.url, m.url, m.link);
    if (!mediaUrl) continue;
    const type = m.tipo === 'video' || /\.mp4/i.test(String(mediaUrl)) ? 'video' : 'image';
    const mediaBuffer = (await fetchBuffer(mediaUrl, 90000)).buffer;
    items.push({ url: mediaUrl, type, mediaBuffer });
  }
  if (!items.length) throw new Error('Nenhuma midia encontrada no Threads');
  return {
    title: r.titulo || r.title || 'Threads',
    author: r.autor || r.author || '',
    items,
    raw: r
  };
}

async function downloadCapcut(link) {
  ensureKey();
  const url = qIn(link);
  if (!url) throw new Error('Envie um link do CapCut');

  try {
    const { capcut } = require('btch-downloader');
    const res = await capcut(url);
    const mediaUrl = firstHttpUrl(res?.url, res?.video, res?.result, res?.original);
    if (mediaUrl) {
      const videoBuffer = (await fetchBuffer(mediaUrl, 120000)).buffer;
      return {
        title: res?.title || 'CapCut',
        description: res?.description || '',
        views: '',
        videoUrl: mediaUrl,
        videoBuffer,
        thumbnail: res?.thumbnail || '',
        raw: res
      };
    }
  } catch (e) {
    logger.logAviso(`[download/capcut] btch: ${e.message}`);
  }

  const data = await getJson('/api/dl/capcut', { url }, 60000);
  const r = data?.resultado || data?.result || data?.resultados;
  if (!r || !r.video) throw new Error('Falha ao baixar CapCut');
  const videoBuffer = (await fetchBuffer(r.video, 120000)).buffer;
  return {
    title: r.titulo || r.title || 'CapCut',
    description: r.descricao || r.description || '',
    views: r.visualizacoes || r.views || '',
    videoUrl: r.video,
    videoBuffer,
    thumbnail: r.miniatura || r.thumbnail || '',
    raw: r
  };
}

async function downloadSoundcloud(query) {
  ensureKey();
  const q = qIn(query);
  if (!q) throw new Error('Informe link ou nome SoundCloud');

  if (/soundcloud\.com/i.test(q)) {
    let meta = {};
    try {
      const details = await getJson('/api/soundcloud/track-details', { url: q }, 30000);
      meta = details?.resultado || details?.result || details || {};
    } catch (_) {}

    // ZT soundcloud_dl: GET /api/soundcloud?url= → bytes
    try {
      const r = await fetchBufferFromApi('/api/soundcloud', { url: q }, 90000);
      return {
        title: meta.title || meta.titulo || 'SoundCloud',
        artist: meta.artist || meta.autor || '',
        audioUrl: apiUrl('/api/soundcloud', { url: q }),
        audioBuffer: r.buffer,
        url: q,
        raw: meta
      };
    } catch (e) {
      logger.logAviso(`[download/sc] binary: ${e.message}`);
    }

    // fallback JSON link
    for (const path of ['/api/dl/soundcloud', '/api/soundcloud/download']) {
      try {
        const data = await getJson(path, { url: q }, 60000);
        const r = data?.resultado || data?.result || data;
        const audioUrl = r?.link || r?.url || r?.audio || r?.download || null;
        if (!audioUrl) continue;
        const audioBuffer = (await fetchBuffer(audioUrl, 90000)).buffer;
        return {
          title: r?.title || r?.titulo || meta.title || 'SoundCloud',
          artist: r?.artist || r?.autor || '',
          audioUrl,
          audioBuffer,
          url: q,
          raw: r
        };
      } catch (err) {
        logger.logAviso(`[download/sc] ${path}: ${err.message}`);
      }
    }
    throw new Error('Falha ao baixar SoundCloud');
  }

  const data = await getJson('/api/soundcloud/search', { query: q }, 45000);
  const list = data?.resultado || data?.result || data?.resultados || [];
  if (!Array.isArray(list) || !list.length) throw new Error('Nenhum resultado SoundCloud');
  const first = list[0];
  const trackUrl = first.url || first.link;
  if (!trackUrl) throw new Error('Resultado sem URL');
  return downloadSoundcloud(trackUrl);
}

async function downloadPinterest(link) {
  ensureKey();
  const url = qIn(link);
  if (!url || !/(pinterest\.|pin\.it)/i.test(url)) {
    throw new Error('Envie um link valido do Pinterest');
  }

  // btch fallback (imagem/video)
  try {
    const { pinterest } = require('btch-downloader');
    const res = await pinterest(url);
    const inner = res?.result?.result || res?.result || res;
    const mediaUrl = firstHttpUrl(
      inner?.image,
      inner?.original,
      inner?.video,
      inner?.url,
      inner?.link,
      inner?.downloads
    );
    if (mediaUrl) {
      const mediaBuffer = (await fetchBuffer(mediaUrl, 90000)).buffer;
      return {
        title: inner?.title || inner?.description || 'Pinterest',
        description: inner?.description || '',
        mediaUrl,
        mediaBuffer,
        type: /\.mp4/i.test(mediaUrl) ? 'video' : 'image',
        raw: res
      };
    }
  } catch (e) {
    logger.logAviso(`[download/pinterest] btch: ${e.message}`);
  }

  let data;
  try {
    data = await getJson('/api/pinterest_mp4', { url }, 60000);
  } catch (e) {
    const msg = String(e.message || e);
    if (/no videos found/i.test(msg)) {
      // pin so com foto — tenta path generico se existir
      try {
        data = await getJson('/api/dl/pinterest', { url }, 45000);
      } catch (_) {
        throw new Error('Pinterest sem midia baixavel neste link. Tente outro pin.');
      }
    } else {
      throw e;
    }
  }
  const r = data?.resultados || data?.resultado || data?.result;
  if (!r) throw new Error('Falha ao baixar Pinterest');
  const dlPriority = ['4K', '2K', '1080p', '720p', '736p', '564p', '474p', '360p', '236p', 'Video'];
  const fromDownloads =
    (r.downloads && typeof r.downloads === 'object'
      ? dlPriority.map((k) => r.downloads[k]).find(Boolean) ||
        Object.values(r.downloads).find((v) => typeof v === 'string' && /^https?:\/\//i.test(v))
      : null) || null;
  const mediaUrl =
    firstHttpUrl(fromDownloads, r.video, r.url, r.link, r.image, r.thumbnail) || null;
  if (!mediaUrl) throw new Error('Nenhum link de download');
  const isVideo = /\.mp4/i.test(mediaUrl) || String(r.tipo || '').includes('video');
  const mediaBuffer = (await fetchBuffer(mediaUrl, 90000)).buffer;
  return {
    title: r.titulo || r.title || 'Pinterest',
    description: r.descricao || '',
    mediaUrl,
    mediaBuffer,
    type: isVideo ? 'video' : 'image',
    raw: r
  };
}

module.exports = {
  API_BASE,
  fetchBuffer,
  searchYoutube,
  playMedia,
  playVideoMedia,
  youtubeAudioUrl,
  youtubeVideoUrl,
  downloadTiktok,
  downloadInstagram,
  downloadFacebook,
  downloadSpotify,
  downloadMediafire,
  downloadTwitter,
  downloadKwai,
  downloadThreads,
  downloadCapcut,
  downloadSoundcloud,
  downloadPinterest,
  fetchAttp
};
