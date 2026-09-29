'use strict';
/**
 * Deduplicacao de figurinhas do canal — fonte unica de verdade.
 * - Hash SHA-256 do buffer baixado (antes do brand EXIF)
 * - Persistencia: tabela SQL `figurinha_posted` + espelho JSON em data/
 *   (JSON cobre reinicio mesmo se sqlite nativo falhar no host)
 * - confirmarPostagem SO apos relay OK
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger');

const DATA_DIR = path.join(__dirname, '../data');
const MIRROR_FILE = path.join(DATA_DIR, 'figurinha_posted.json');
/** 0 = permanente (padrao). Dias >0 libera hash antigo. */
const TTL_DAYS = Math.max(0, Number(process.env.FIGURINHA_DEDUP_TTL_DAYS) || 0);
const MAX_TRIES_DEFAULT = Math.min(
  80,
  Math.max(8, Number(process.env.FIGURINHA_DEDUP_MAX_TRIES) || 24)
);

/** @type {Set<string>} */
const mem = new Set();
/** @type {Map<string, number>} hash -> postedAt ms */
const memAt = new Map();
let warmed = false;
let mirrorDirty = false;
let mirrorTimer = null;
let tableReady = false;

class FiguraEsgotadaError extends Error {
  constructor(fonte, detail = {}) {
    super(`fonte_esgotada:${fonte || '?'}`);
    this.name = 'FiguraEsgotadaError';
    this.code = 'FIGURA_ESGOTADA';
    this.fonte = fonte || '';
    this.detail = detail;
  }
}

/**
 * Valida magic bytes ANTES de hash/dedup.
 * Resposta de erro da API (JSON/HTML/vazio) NUNCA deve virar "duplicata".
 */
function isValidStickerMedia(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return true;
  }
  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return true;
  }
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  // GIF
  if (buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a') {
    return true;
  }
  // JSON / HTML / texto → erro de API, nao midia
  const head = buffer.slice(0, 64).toString('utf8').trimStart();
  if (head.startsWith('{') || head.startsWith('[') || head.startsWith('<') || /^error/i.test(head)) {
    return false;
  }
  return false;
}

function hashFigurinha(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('buffer_vazio_hash');
  }
  if (!isValidStickerMedia(buffer)) {
    throw new Error('midia_invalida_api');
  }
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadMirrorFile() {
  try {
    if (!fs.existsSync(MIRROR_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(MIRROR_FILE, 'utf8'));
    const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
    const now = Date.now();
    for (const it of items) {
      const h = String(it.hash || it || '').trim().toLowerCase();
      if (!h || h.length < 16) continue;
      const at = Number(it.at || it.posted_at || now) || now;
      if (TTL_DAYS > 0 && now - at > TTL_DAYS * 86400000) continue;
      mem.add(h);
      memAt.set(h, at);
    }
  } catch (e) {
    logger.logAviso(`[figDedup] mirror load: ${e.message}`);
  }
}

function scheduleMirrorFlush() {
  mirrorDirty = true;
  if (mirrorTimer) return;
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    flushMirrorSync();
  }, 800);
  if (typeof mirrorTimer.unref === 'function') mirrorTimer.unref();
}

function flushMirrorSync() {
  if (!mirrorDirty && fs.existsSync(MIRROR_FILE)) return;
  mirrorDirty = false;
  try {
    ensureDataDir();
    const items = [];
    for (const h of mem) {
      items.push({ hash: h, at: memAt.get(h) || Date.now() });
    }
    // limita arquivo absurdo (permanente mas com teto de espelho)
    const MAX_MIRROR = Number(process.env.FIGURINHA_DEDUP_MIRROR_MAX) || 50000;
    const trimmed = items.length > MAX_MIRROR ? items.slice(-MAX_MIRROR) : items;
    fs.writeFileSync(
      MIRROR_FILE,
      JSON.stringify({ updatedAt: Date.now(), items: trimmed }),
      'utf8'
    );
  } catch (e) {
    logger.logAviso(`[figDedup] mirror save: ${e.message}`);
  }
}

function getSql() {
  return require('./sqlStore');
}

async function ensureTable() {
  if (tableReady) return true;
  try {
    const sql = getSql();
    if (!sql.isReady()) {
      try {
        sql.initSqlStore();
      } catch (_) { /* */ }
    }
    if (!sql.isReady() || typeof sql.runAsync !== 'function') return false;
    await sql.runAsync(`CREATE TABLE IF NOT EXISTS figurinha_posted (
      hash TEXT PRIMARY KEY,
      fonte TEXT,
      canal_jid TEXT,
      posted_at TEXT NOT NULL
    )`);
    await sql.runAsync(
      `CREATE INDEX IF NOT EXISTS idx_figurinha_posted_at ON figurinha_posted(posted_at)`
    );
    tableReady = true;
    return true;
  } catch (e) {
    logger.logAviso(`[figDedup] ensureTable: ${e.message}`);
    return false;
  }
}

async function migrateLegacyKv() {
  try {
    const { getKv } = getSql();
    const legacy = await getKv('figurinha_canal', 'recent_hashes');
    const items = Array.isArray(legacy?.items) ? legacy.items : [];
    let n = 0;
    for (const it of items) {
      const h = String(it.hash || '').trim().toLowerCase();
      if (!h) continue;
      if (mem.has(h)) continue;
      mem.add(h);
      memAt.set(h, Number(it.at) || Date.now());
      n += 1;
      await confirmarPostagem(h, 'legacy_kv', '', { skipMem: true });
    }
    if (n) logger.logInfo(`[figDedup] migrou ${n} hashes do KV legado`);
  } catch (_) { /* ignore */ }
}

async function warmFromSql() {
  try {
    const sql = getSql();
    if (!(await ensureTable())) return 0;
    const rows = await sql.allAsync(
      `SELECT hash, posted_at FROM figurinha_posted`
    );
    const now = Date.now();
    let n = 0;
    for (const r of rows || []) {
      const h = String(r.hash || '').trim().toLowerCase();
      if (!h) continue;
      const at = Date.parse(r.posted_at) || now;
      if (TTL_DAYS > 0 && now - at > TTL_DAYS * 86400000) continue;
      mem.add(h);
      memAt.set(h, at);
      n += 1;
    }
    return n;
  } catch (e) {
    logger.logAviso(`[figDedup] warm SQL: ${e.message}`);
    return 0;
  }
}

async function warmDedup() {
  if (warmed) return mem.size;
  loadMirrorFile();
  const fromSql = await warmFromSql();
  await migrateLegacyKv();
  warmed = true;
  scheduleMirrorFlush();
  logger.logInfo(
    `[figDedup] warm ok size=${mem.size} sqlRows≈${fromSql} ttlDays=${TTL_DAYS || 'perm'}`
  );
  return mem.size;
}

function isExpired(hash) {
  if (TTL_DAYS <= 0) return false;
  const at = memAt.get(hash) || 0;
  return Date.now() - at > TTL_DAYS * 86400000;
}

async function jaFoiPostada(hash) {
  await warmDedup();
  const h = String(hash || '').trim().toLowerCase();
  if (!h) return false;
  if (mem.has(h) && !isExpired(h)) return true;
  if (mem.has(h) && isExpired(h)) {
    mem.delete(h);
    memAt.delete(h);
  }
  try {
    if (await ensureTable()) {
      const sql = getSql();
      const rows = await sql.allAsync(
        `SELECT hash, posted_at FROM figurinha_posted WHERE hash=? LIMIT 1`,
        [h]
      );
      if (rows && rows[0]) {
        const at = Date.parse(rows[0].posted_at) || Date.now();
        if (TTL_DAYS > 0 && Date.now() - at > TTL_DAYS * 86400000) {
          return false;
        }
        mem.add(h);
        memAt.set(h, at);
        return true;
      }
    }
  } catch (_) { /* mirror/mem only */ }
  return false;
}

/**
 * Consulta buffer: { hash, nova }
 * NAO grava — so le. Gravacao = confirmarPostagem apos envio.
 */
async function verificarFigurinha(buffer) {
  const hash = hashFigurinha(buffer);
  const nova = !(await jaFoiPostada(hash));
  return { hash, nova };
}

/** Alias pedido no prompt */
async function verificarESalvarFigurinha(buffer, _fonte, _canalJid) {
  // Nao salva aqui de proposito — salvar so apos relay (confirmarPostagem)
  return verificarFigurinha(buffer);
}

async function confirmarPostagem(hash, fonte = '', canalJid = '', opts = {}) {
  const h = String(hash || '').trim().toLowerCase();
  if (!h) return false;
  const at = Date.now();
  if (!opts.skipMem) {
    mem.add(h);
    memAt.set(h, at);
  } else {
    mem.add(h);
    if (!memAt.has(h)) memAt.set(h, at);
  }
  scheduleMirrorFlush();

  try {
    if (await ensureTable()) {
      const sql = getSql();
      await sql.runAsync(
        `INSERT INTO figurinha_posted (hash, fonte, canal_jid, posted_at)
         VALUES (?,?,?,?)
         ON CONFLICT(hash) DO UPDATE SET
           fonte=excluded.fonte,
           canal_jid=excluded.canal_jid,
           posted_at=excluded.posted_at`,
        [h, String(fonte || '').slice(0, 64), String(canalJid || '').slice(0, 80), new Date(at).toISOString()]
      );
    }
  } catch (e) {
    logger.logAviso(`[figDedup] SQL confirm fail (mirror ok): ${e.message}`);
  }
  return true;
}

/**
 * Busca buffer inedito via fetchFn().
 * Contadores separados:
 * - apiErrors: falha de API / midia invalida (NAO contam no teto de duplicatas)
 * - dups: figurinha ja vista (contam no maxDupTries)
 */
async function obterBufferInedito(fetchFn, {
  fonte = '',
  maxTries = MAX_TRIES_DEFAULT,
  maxDupTries = null,
  maxApiErrors = null
} = {}) {
  await warmDedup();
  let dups = 0;
  let apiErrors = 0;
  let lastErr = null;
  const hardCap = Math.max(1, Number(maxTries) || MAX_TRIES_DEFAULT);
  const dupCap = Math.max(1, Number(maxDupTries) || MAX_TRIES_DEFAULT);
  const apiCap = Math.max(1, Number(maxApiErrors) || hardCap * 2);
  let i = 0;

  while (i < hardCap && dups < dupCap && apiErrors < apiCap) {
    i += 1;
    try {
      const raw = await fetchFn();
      const buffer = Buffer.isBuffer(raw) ? raw : raw?.buffer;
      if (!Buffer.isBuffer(buffer) || !buffer.length) {
        apiErrors += 1;
        lastErr = new Error('buffer_vazio');
        continue;
      }
      if (!isValidStickerMedia(buffer)) {
        apiErrors += 1;
        lastErr = new Error('midia_invalida_api');
        continue;
      }
      const { hash, nova } = await verificarFigurinha(buffer);
      if (!nova) {
        dups += 1;
        continue;
      }
      return { buffer, hash, tries: i, dups, apiErrors };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (/texto_obrigatorio|termo_obrigatorio|url_obrigatoria|categoria/i.test(msg)) {
        throw e;
      }
      if (/429|Muitas requisi|rate-limit/i.test(msg)) throw e;
      if (/midia_invalida_api|buffer_vazio|timeout|ECONN|404|429|5\d\d|resposta/i.test(msg)) {
        apiErrors += 1;
      } else {
        apiErrors += 1;
      }
    }
  }

  throw new FiguraEsgotadaError(fonte, {
    dups,
    apiErrors,
    tries: i,
    lastErr: lastErr ? String(lastErr.message || lastErr) : null
  });
}

function countPosted() {
  return mem.size;
}

function resetMemForTests() {
  mem.clear();
  memAt.clear();
  warmed = false;
  tableReady = false;
}

module.exports = {
  FiguraEsgotadaError,
  hashFigurinha,
  isValidStickerMedia,
  jaFoiPostada,
  verificarFigurinha,
  verificarESalvarFigurinha,
  confirmarPostagem,
  obterBufferInedito,
  warmDedup,
  flushMirrorSync,
  countPosted,
  resetMemForTests,
  MAX_TRIES_DEFAULT,
  TTL_DAYS,
  MIRROR_FILE
};
