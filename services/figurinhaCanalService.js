'use strict';

/**
 * Figurinhas → canal oficial (@newsletter).
 * Dedup central: utils/figurinhaDedup.js (SQL + mirror JSON, permanente).
 * Paths validados via WebFetch 12/08/2026:
 *   OK: /api/figurinhas, /api/figurinhas2, /api/amongus, /sticker/fig*,
 *       /api/stickerly/{trending,search,pack}
 *   404: /api/sticker/* (catalog antigo)
 */

const logger = require('../logger');
const zt = require('./zerotwoClient');
const { getCanalId, getCanalName } = require('../utils/canal');
const { mediaToStickerBuffer } = require('./stickerService');
const {
  FiguraEsgotadaError,
  confirmarPostagem,
  obterBufferInedito,
  verificarFigurinha,
  warmDedup,
  isValidStickerMedia,
  MAX_TRIES_DEFAULT
} = require('../utils/figurinhaDedup');

const MULTI_DELAY_MS = Number(process.env.FIGURINHA_CANAL_DELAY_MS) || 1200;
/** Teto duro (env ou 20). Usuario escolhe 1..teto a cada envio. */
const MAX_MULTI = Math.min(30, Math.max(1, Number(process.env.FIGURINHA_CANAL_MAX_MULTI) || 20));
let zt429Until = 0;
let zt429LoggedAt = 0;

function isZt429(err) {
  return /429|Muitas requisi/i.test(String(err && err.message ? err.message : err || ''));
}

function noteZt429() {
  zt429Until = Date.now() + 90_000;
  if (Date.now() - zt429LoggedAt > 60_000) {
    zt429LoggedAt = Date.now();
    logger.logAviso('[figCanal] API 429 — pausa 90s (sem retry de path)');
  }
}

function ztCooling() {
  return Date.now() < zt429Until;
}

function clampCount(n, fallback = 1) {
  const v = Number.parseInt(String(n ?? ''), 10);
  if (!Number.isFinite(v) || v < 1) return Math.max(1, fallback);
  return Math.min(MAX_MULTI, v);
}

const TEMATICA = (id, label) => ({
  id,
  label,
  section: 'Tematicas',
  mode: 'buffer',
  paths: [`/sticker/${id}`],
});

/** @type {Array<object>} */
const CATEGORIES = [
  { id: 'ale1', label: 'Aleatoria 1', section: 'Aleatorias', mode: 'buffer', paths: ['/api/figurinhas'] },
  { id: 'ale2', label: 'Aleatoria 2', section: 'Aleatorias', mode: 'buffer', paths: ['/api/figurinhas2'] },
  TEMATICA('figemoji', 'Emoji'),
  TEMATICA('figflork', 'Flork'),
  TEMATICA('figale', 'Ale'),
  TEMATICA('figmemes', 'Memes'),
  TEMATICA('figanime', 'Anime'),
  TEMATICA('figcoreana', 'Coreana'),
  TEMATICA('figdesenho', 'Desenho'),
  TEMATICA('figbebe', 'Bebe'),
  TEMATICA('figanimais', 'Animais'),
  { id: 'amongus', label: 'Among Us', section: 'Personalizada', mode: 'buffer', paths: ['/api/amongus'], needs: 'texto' },
  {
    id: 'sly_trend',
    label: 'Trending',
    section: 'Sticker.ly',
    mode: 'json_multi',
    paths: ['/api/stickerly/trending'],
    params: { limit: 8 },
    expandPacks: true,
  },
  {
    id: 'sly_search',
    label: 'Buscar',
    section: 'Sticker.ly',
    mode: 'json_multi',
    paths: ['/api/stickerly/search'],
    params: { limit: 8, enriched: 'true' },
    needs: 'q',
  },
  {
    id: 'sly_pack',
    label: 'Importar pack',
    section: 'Sticker.ly',
    mode: 'json_multi',
    paths: ['/api/stickerly/pack'],
    needs: 'url',
  },
];

const byId = new Map(CATEGORIES.map((c) => [c.id, c]));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadBaileys() {
  return require('@systemzero/baileys');
}

function stickerBrandMeta() {
  const pack =
    String(process.env.FIGURINHA_CANAL_PACK || '').trim() ||
    getCanalName();
  const author =
    String(process.env.FIGURINHA_CANAL_AUTHOR || '').trim() ||
    'hanork';
  return { packname: pack, author };
}

function detectStickerKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return 'image';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    const tag = buf.slice(8, 12).toString('ascii');
    if (tag === 'WEBP') return 'sticker';
  }
  return 'image';
}

/** Igual .roubar: troca pack/autor pro nome do canal antes de postar. */
async function brandStickerForCanal(buffer) {
  const meta = stickerBrandMeta();
  const kind = detectStickerKind(buffer);
  try {
    return await mediaToStickerBuffer(buffer, kind, meta);
  } catch (e) {
    logger.logAviso(`[figCanal] brand fail (${e.message}) — tenta webp direto`);
    try {
      return await mediaToStickerBuffer(buffer, 'sticker', meta);
    } catch (_) {
      return buffer;
    }
  }
}

async function relayStickerToCanal(conn, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('buffer_vazio');
  const canalJid = getCanalId();
  if (!canalJid || !/@newsletter$/i.test(canalJid)) throw new Error('canal_invalido');
  if (!conn?.user) throw new Error('bot_offline');

  const branded = await brandStickerForCanal(buffer);

  const b = loadBaileys();
  const userJid = conn.user.id || conn.user.jid;
  const opts = { upload: conn.waUploadToServer, userJid };
  if (typeof b.generateMessageIDV2 === 'function' && userJid) {
    opts.messageId = b.generateMessageIDV2(userJid);
  }

  if (typeof b.generateWAMessage === 'function') {
    const fullMsg = await b.generateWAMessage(canalJid, { sticker: branded }, opts);
    await conn.relayMessage(canalJid, fullMsg.message, {
      messageId: fullMsg.key.id,
      _hanorkTrusted: true,
    });
    return { ok: true, via: 'generateWAMessage', messageId: fullMsg.key.id, brand: stickerBrandMeta() };
  }

  if (typeof b.prepareWAMessageMedia === 'function' && typeof b.generateWAMessageFromContent === 'function') {
    const prep = await b.prepareWAMessageMedia({ sticker: branded }, { upload: conn.waUploadToServer });
    const content = prep.stickerMessage
      ? { stickerMessage: prep.stickerMessage }
      : prep;
    const msg = b.generateWAMessageFromContent(canalJid, content, { userJid });
    await conn.relayMessage(canalJid, msg.message, {
      messageId: msg.key.id,
      _hanorkTrusted: true,
    });
    return { ok: true, via: 'prepareWAMessageMedia', messageId: msg.key.id, brand: stickerBrandMeta() };
  }

  await conn.sendMessage(canalJid, { sticker: branded }, { _hanorkTrusted: true });
  return { ok: true, via: 'sendMessage_fallback', brand: stickerBrandMeta() };
}

/**
 * Posta 1 buffer inedito: relay OK → so entao confirma hash.
 * Se relay falhar, hash NAO e gravado (pode tentar de novo).
 */
async function postBufferInedito(conn, buffer, hash, fonte) {
  const canalJid = getCanalId();
  await relayStickerToCanal(conn, buffer);
  await confirmarPostagem(hash, fonte, canalJid);
  return true;
}

async function fetchBufferFromPaths(paths, params = {}) {
  if (ztCooling()) throw new Error('Download HTTP 429: cooldown');
  let lastErr = null;
  for (const p of paths) {
    try {
      const r = await zt.request(p, params, { response: 'buffer', timeout: 45000 });
      if (r.kind === 'buffer' && Buffer.isBuffer(r.buffer) && r.buffer.length) {
        return { buffer: r.buffer, contentType: r.contentType || '', path: p };
      }
      if (r.kind === 'json') {
        const url = zt.pickMediaUrl(r.data);
        if (url) {
          const media = await zt.fetchBuffer(url);
          return { buffer: media.buffer, contentType: media.contentType || '', path: p, viaUrl: true };
        }
      }
      lastErr = new Error(`resposta_vazia (${p})`);
    } catch (e) {
      lastErr = e;
      if (isZt429(e)) {
        noteZt429();
        throw e;
      }
      logger.logAviso(`[figCanal] path fail ${p}: ${e.message}`);
    }
  }
  throw lastErr || new Error('todas_rotas_falharam');
}

function extractStickerUrls(data) {
  const urls = [];
  const res = data?.resultados || data || {};
  const pushStickers = (arr) => {
    for (const s of arr || []) {
      if (s?.url && /^https?:\/\//i.test(s.url)) urls.push(s.url);
    }
  };
  pushStickers(res.stickers);
  for (const pack of res.packs || []) {
    pushStickers(pack.stickers);
  }
  return [...new Set(urls)];
}

function extractPackShareLinks(data) {
  const packs = data?.resultados?.packs || data?.packs || [];
  return packs
    .map((p) => p.linkCompartilhar || p.url || (p.packId ? `https://sticker.ly/s/${p.packId}` : null))
    .filter((u) => u && /^https?:\/\//i.test(u));
}

async function buffersFromUrls(urls, limit = MAX_MULTI) {
  const cap = clampCount(limit, MAX_MULTI);
  const buffers = [];
  for (const url of urls.slice(0, Math.max(cap * 3, cap))) {
    try {
      const media = await zt.fetchBuffer(url);
      if (media.buffer?.length) buffers.push(media.buffer);
      if (buffers.length >= cap * 2) break;
    } catch (e) {
      logger.logAviso(`[figCanal] download skip: ${e.message}`);
    }
  }
  return buffers;
}

async function fetchMultiBuffers(paths, params = {}, opts = {}) {
  if (ztCooling()) throw new Error('Download HTTP 429: cooldown');
  const limit = clampCount(opts.limit, MAX_MULTI);
  let lastErr = null;
  for (const p of paths) {
    try {
      const data = await zt.getJson(p, params, 45000);
      let urls = extractStickerUrls(data);

      if (!urls.length && (opts.expandPacks || /trending/i.test(p))) {
        const links = extractPackShareLinks(data).slice(0, 4);
        for (const link of links) {
          try {
            const packData = await zt.getJson('/api/stickerly/pack', { url: link }, 45000);
            urls.push(...extractStickerUrls(packData));
            if (urls.length >= limit * 3) break;
          } catch (e) {
            logger.logAviso(`[figCanal] expand pack fail: ${e.message}`);
          }
        }
        urls = [...new Set(urls)];
      }

      if (!urls.length) {
        const capa = zt.pickMediaUrl(data);
        if (capa) urls = [capa];
      }

      if (!urls.length) {
        lastErr = new Error(`sem_urls (${p})`);
        continue;
      }
      const buffers = await buffersFromUrls(urls, limit);
      if (buffers.length) return { buffers, path: p, count: buffers.length, urls };
      lastErr = new Error(`downloads_vazios (${p})`);
    } catch (e) {
      lastErr = e;
      if (isZt429(e)) {
        noteZt429();
        throw e;
      }
      logger.logAviso(`[figCanal] json path fail ${p}: ${e.message}`);
    }
  }
  throw lastErr || new Error('stickerly_falhou');
}

/**
 * Sticker.ly: posta item a item; falha de API/envio NAO conta como postada —
 * loop repoe ate atingir quantidadeAlvo ou maxTentativasTotais.
 */
async function postJsonMultiWithDedup(conn, cat, params, want, onProgress) {
  const canalJid = getCanalId();
  const fonte = cat.id;
  let posted = 0;
  let skippedDup = 0;
  let apiErrors = 0;
  let tentativas = 0;
  const erros = [];
  const notes = [];
  const usedHashes = new Set();
  const maxTentativasTotais = Math.max(want * 3, want + 6);

  while (posted < want && tentativas < maxTentativasTotais) {
    tentativas += 1;
    let buffers = [];
    try {
      const fetchLimit = Math.max(want - posted, 2) + 2;
      const fetched = await fetchMultiBuffers(cat.paths, params, {
        expandPacks: !!cat.expandPacks,
        limit: Math.min(MAX_MULTI, fetchLimit + 4)
      });
      buffers = fetched.buffers || [];
    } catch (e) {
      apiErrors += 1;
      erros.push({ tentativa: tentativas, motivo: String(e.message || e) });
      notes.push(String(e.message || e));
      if (isZt429(e)) break;
      await sleep(300);
      continue;
    }

    if (!buffers.length) {
      apiErrors += 1;
      erros.push({ tentativa: tentativas, motivo: 'batch_vazio' });
      await sleep(300);
      continue;
    }

    let progressed = false;
    for (const buf of buffers) {
      if (posted >= want || tentativas >= maxTentativasTotais) break;
      try {
        if (!isValidStickerMedia(buf)) {
          apiErrors += 1;
          erros.push({ tentativa: tentativas, motivo: 'midia_invalida_api' });
          tentativas += 1;
          continue;
        }
        const { hash, nova } = await verificarFigurinha(buf);
        if (!nova || usedHashes.has(hash)) {
          skippedDup += 1;
          notes.push('dup_skip');
          if (typeof onProgress === 'function') onProgress({ dup: true, posted, want });
          continue;
        }
        await postBufferInedito(conn, buf, hash, fonte);
        usedHashes.add(hash);
        posted += 1;
        progressed = true;
        if (typeof onProgress === 'function') onProgress({ posted, want });
        if (posted < want) await sleep(MULTI_DELAY_MS);
      } catch (e) {
        apiErrors += 1;
        erros.push({ tentativa: tentativas, motivo: String(e.message || e) });
        notes.push(String(e.message || e));
        logger.logAviso(`[figCanal] relay/api fail (repondo): ${e.message}`);
        tentativas += 1;
      }
    }

    if (!progressed && posted < want) {
      await sleep(400);
    }
  }

  if (!posted && skippedDup && !apiErrors) {
    throw new FiguraEsgotadaError(fonte, { skippedDup, want, canalJid, apiErrors });
  }
  if (!posted) throw new Error(apiErrors ? 'nenhuma_figurinha' : 'nenhuma_figurinha');
  return { posted, skippedDup, apiErrors, tentativas, erros, notes, want };
}

async function postBufferModeWithDedup(conn, cat, params, want, onProgress) {
  const fonte = cat.id;
  let posted = 0;
  let skippedDup = 0;
  let apiErrors = 0;
  let tentativas = 0;
  const erros = [];
  const notes = [];
  const maxTentativasTotais = Math.max(want * 3, want + 6);

  while (posted < want && tentativas < maxTentativasTotais) {
    tentativas += 1;
    try {
      const { buffer, hash, dups, apiErrors: ae } = await obterBufferInedito(
        async () => {
          const r = await fetchBufferFromPaths(cat.paths, params);
          return r.buffer;
        },
        {
          fonte,
          maxTries: Math.max(8, Math.ceil(maxTentativasTotais / Math.max(1, want - posted))),
          maxDupTries: Math.max(MAX_TRIES_DEFAULT, want * 4),
          maxApiErrors: Math.max(6, want * 3)
        }
      );
      skippedDup += dups || 0;
      apiErrors += ae || 0;
      await postBufferInedito(conn, buffer, hash, fonte);
      posted += 1;
      if (typeof onProgress === 'function') onProgress({ posted, want });
      if (posted < want) await sleep(MULTI_DELAY_MS);
    } catch (e) {
      if (e instanceof FiguraEsgotadaError || e.code === 'FIGURA_ESGOTADA') {
        apiErrors += Number(e.detail?.apiErrors) || 0;
        skippedDup += Number(e.detail?.dups) || 0;
        if (posted === 0 && !(e.detail?.apiErrors)) throw e;
        notes.push('fonte_esgotada_parcial');
        erros.push({ tentativa: tentativas, motivo: e.message });
        // se ainda faltam e sobrou budget, continua tentando ate o teto
        if (tentativas >= maxTentativasTotais) break;
        await sleep(350);
        continue;
      }
      apiErrors += 1;
      erros.push({ tentativa: tentativas, motivo: String(e.message || e) });
      notes.push(String(e.message || e));
      if (isZt429(e) || /429|Muitas requisi/i.test(String(e.message || e))) break;
      if (tentativas >= maxTentativasTotais) break;
      await sleep(300);
    }
  }

  if (!posted) {
    if (skippedDup && !apiErrors) throw new FiguraEsgotadaError(fonte, { dups: skippedDup, want });
    throw new Error(skippedDup ? 'todas_duplicadas' : 'nenhuma_figurinha');
  }
  return { posted, skippedDup, apiErrors, tentativas, erros, notes, want };
}

async function postCategoryToCanal(conn, categoryId, extraParams = {}, onProgress) {
  const cat = byId.get(categoryId);
  if (!cat) throw new Error('categoria_desconhecida');

  await warmDedup();

  const want = clampCount(extraParams.count ?? extraParams.qtd ?? 1, 1);
  const params = { ...(cat.params || {}), ...(extraParams || {}) };
  delete params.count;
  delete params.qtd;

  if (cat.needs === 'texto') {
    const t = String(params.texto || '').trim();
    if (!t) throw new Error('texto_obrigatorio');
    params.texto = t;
  }
  if (cat.needs === 'q') {
    const q = String(params.q || params.termo || '').trim();
    if (!q) throw new Error('termo_obrigatorio');
    params.q = q;
    delete params.termo;
  }
  if (cat.needs === 'url') {
    const url = String(params.url || params.q || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('url_obrigatoria');
    params.url = url;
    params.q = url;
  }

  let result;
  try {
    if (cat.mode === 'json_multi') {
      result = await postJsonMultiWithDedup(conn, cat, params, want, onProgress);
    } else {
      result = await postBufferModeWithDedup(conn, cat, params, want, onProgress);
    }
  } catch (e) {
    if (e instanceof FiguraEsgotadaError || e.code === 'FIGURA_ESGOTADA') {
      logger.logAviso(
        `[figCanal] fonte esgotada cat=${cat.id} dups=${e.detail?.dups || e.detail?.skippedDup || '?'}`
      );
      const err = new Error('fonte_esgotada');
      err.code = 'FIGURA_ESGOTADA';
      err.fonte = cat.id;
      err.label = cat.label;
      throw err;
    }
    throw e;
  }

  return {
    posted: result.posted,
    skippedDup: result.skippedDup || 0,
    apiErrors: result.apiErrors || 0,
    tentativas: result.tentativas || 0,
    erros: result.erros || [],
    want,
    incomplete: result.posted < want,
    canal: getCanalId(),
    notes: result.notes || [],
    label: cat.label
  };
}

function listSections() {
  const order = ['Aleatorias', 'Tematicas', 'Personalizada', 'Sticker.ly'];
  return order.map((title) => ({
    title,
    rows: CATEGORIES.filter((c) => c.section === title).map((c) => ({
      id: `figc_${c.id}`,
      title: c.label.slice(0, 24),
      description: c.needs
        ? `pede ${c.needs === 'texto' ? 'texto' : c.needs === 'q' ? 'termo' : 'url'}`
        : 'posta no canal',
    })),
  }));
}

module.exports = {
  CATEGORIES,
  byId,
  listSections,
  postCategoryToCanal,
  relayStickerToCanal,
  brandStickerForCanal,
  stickerBrandMeta,
  sleep,
  MULTI_DELAY_MS,
  MAX_MULTI,
  clampCount,
  FiguraEsgotadaError
};
