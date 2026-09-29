// services/stickerService.js
// Figurinha estilo Zero Two: imagem/video -> webp + EXIF pack/autor

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// sharp e nativo — WSL/Windows precisam do binario da plataforma certa
let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[stickerService] sharp indisponivel:', e.message.split('\n')[0]);
}

let ffmpegPath = null;
function resolveStickerFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  try {
    const { resolveFfmpeg } = require('./stillAudioMux');
    ffmpegPath = resolveFfmpeg() || null;
  } catch (_) {
    ffmpegPath = null;
  }
  if (!ffmpegPath) {
    try {
      const p = require('ffmpeg-static');
      if (p && fs.existsSync(p)) ffmpegPath = p;
    } catch (_) { /* sem pacote */ }
  }
  return ffmpegPath;
}

let WebpImage = null;
try {
  WebpImage = require('node-webpmux').Image;
} catch (_) {
  WebpImage = null;
}

function tmpFile(ext) {
  const name = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  return path.join(os.tmpdir(), name);
}

function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
}

/**
 * Imagem estatica -> webp (sharp; fallback ffmpeg se sharp da plataforma errada)
 */
async function imageToWebp(media) {
  const input = Buffer.isBuffer(media) ? media : Buffer.from(media || []);
  if (!input.length) throw new Error('Buffer de imagem vazio');

  if (sharp) {
    try {
      return await sharp(input, { animated: false })
        .rotate()
        .resize(512, 512, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp({ quality: 90, effort: 4 })
        .toBuffer();
    } catch (e) {
      console.warn('[stickerService] sharp falhou, fallback ffmpeg:', e.message);
    }
  }

  // Fallback ZT-style via ffmpeg
  const tmpIn = tmpFile('jpg');
  const tmpOut = tmpFile('webp');
  fs.writeFileSync(tmpIn, input);
  const vf =
    "scale='min(512,iw)':min'(512,ih)':force_original_aspect_ratio=decrease," +
    'pad=512:512:-1:-1:color=white@0.0';
  try {
    await runFfmpeg([
      '-y', '-i', tmpIn,
      '-vcodec', 'libwebp',
      '-vf', vf,
      '-lossless', '0',
      '-q:v', '80',
      tmpOut
    ]);
    return fs.readFileSync(tmpOut);
  } finally {
    safeUnlink(tmpIn);
    safeUnlink(tmpOut);
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const bin = resolveStickerFfmpeg();
    if (!bin) {
      return reject(new Error('ffmpeg nao disponivel'));
    }
    const proc = spawn(bin, args, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => {
      err += String(d);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(err.slice(-400) || `ffmpeg exit ${code}`));
    });
  });
}

/**
 * Video curto -> webp animado (ffmpeg, filtro estilo ZT)
 */
async function videoToWebp(media, maxSeconds = 10) {
  const input = Buffer.isBuffer(media) ? media : Buffer.from(media || []);
  if (!input.length) throw new Error('Buffer de video vazio');

  const tmpIn = tmpFile('mp4');
  const tmpOut = tmpFile('webp');
  fs.writeFileSync(tmpIn, input);

  const vf =
    "scale='min(512,iw)':min'(512,ih)':force_original_aspect_ratio=decrease," +
    'fps=15,' +
    'pad=512:512:-1:-1:color=white@0.0,' +
    'split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse';

  try {
    await runFfmpeg([
      '-y',
      '-i', tmpIn,
      '-vcodec', 'libwebp',
      '-vf', vf,
      '-loop', '0',
      '-ss', '00:00:00',
      '-t', String(Math.min(Math.max(1, Number(maxSeconds) || 10), 10)),
      '-preset', 'default',
      '-an',
      '-vsync', '0',
      tmpOut
    ]);
    return fs.readFileSync(tmpOut);
  } finally {
    safeUnlink(tmpIn);
    safeUnlink(tmpOut);
  }
}

function defaultStickerBrand() {
  return {
    packname: String(process.env.HANORK_STICKER_PACK || '').trim() || 'by: @hanorkbeta',
    author: String(process.env.HANORK_STICKER_AUTHOR || '').trim() || 'dono: @hanork'
  };
}

/**
 * Injeta EXIF pack/autor (node-webpmux) — igual ZT
 */
async function writeExif(webpBuffer, { packname, author, categories } = {}) {
  const buf = Buffer.isBuffer(webpBuffer) ? webpBuffer : Buffer.from(webpBuffer || []);
  if (!buf.length) throw new Error('webp vazio');
  if (!WebpImage || (!packname && !author)) return buf;

  const tmpIn = tmpFile('webp');
  const tmpOut = tmpFile('webp');
  fs.writeFileSync(tmpIn, buf);

  try {
    const img = new WebpImage();
    const json = {
      'sticker-pack-id': 'hanork-beta',
      'sticker-pack-name': packname || defaultStickerBrand().packname,
      'sticker-pack-publisher': author || defaultStickerBrand().author,
      emojis: categories && categories.length ? categories : ['']
    };
    const exifAttr = Buffer.from([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
      0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    const jsonBuff = Buffer.from(JSON.stringify(json), 'utf-8');
    const exif = Buffer.concat([exifAttr, jsonBuff]);
    exif.writeUIntLE(jsonBuff.length, 14, 4);
    await img.load(tmpIn);
    img.exif = exif;
    await img.save(tmpOut);
    return fs.readFileSync(tmpOut);
  } finally {
    safeUnlink(tmpIn);
    safeUnlink(tmpOut);
  }
}

async function mediaToStickerBuffer(media, kind = 'image', meta = {}) {
  let webp;
  if (kind === 'video') webp = await videoToWebp(media, meta.maxSeconds || 10);
  else if (kind === 'webp' || kind === 'sticker') webp = Buffer.isBuffer(media) ? media : Buffer.from(media || []);
  else webp = await imageToWebp(media);

  const brand = defaultStickerBrand();
  webp = await writeExif(webp, {
    packname: meta.packname || brand.packname,
    author: meta.author || brand.author,
    categories: meta.categories
  });
  return webp;
}

/**
 * Envia figurinha (envio direto como ZT — buffer, sem prepareWAMessageMedia)
 */
async function sendSticker(conn, jid, media, quoted, options = {}) {
  const kind = options.kind || 'image';
  const brand = defaultStickerBrand();
  const sticker = await mediaToStickerBuffer(media, kind, {
    packname: options.packname || options.pack || brand.packname,
    author: options.author || brand.author,
    categories: options.categories,
    maxSeconds: options.maxSeconds
  });
  await conn.sendMessage(
    jid,
    { sticker, mimetype: 'image/webp' },
    { quoted: quoted || undefined }
  );
  return sticker;
}

async function stickerToImage(stickerBuffer) {
  const input = Buffer.isBuffer(stickerBuffer) ? stickerBuffer : Buffer.from(stickerBuffer || []);
  if (!input.length) throw new Error('Buffer de sticker vazio');
  if (sharp) {
    try {
      return await sharp(input, { animated: false }).png().toBuffer();
    } catch (_) { /* fallback */ }
  }
  const tmpIn = tmpFile('webp');
  const tmpOut = tmpFile('png');
  fs.writeFileSync(tmpIn, input);
  try {
    await runFfmpeg(['-y', '-i', tmpIn, tmpOut]);
    return fs.readFileSync(tmpOut);
  } finally {
    safeUnlink(tmpIn);
    safeUnlink(tmpOut);
  }
}

/**
 * Extrai image/video (incl. viewOnce) da msg atual ou quoted — espelho ZT boij/boij2
 */
function resolveStickerSource(info) {
  const msg = info?.message || {};
  const RSM =
    msg.extendedTextMessage?.contextInfo?.quotedMessage ||
    msg.imageMessage?.contextInfo?.quotedMessage ||
    msg.videoMessage?.contextInfo?.quotedMessage ||
    msg.documentMessage?.contextInfo?.quotedMessage ||
    null;

  const image =
    RSM?.imageMessage ||
    msg.imageMessage ||
    RSM?.viewOnceMessageV2?.message?.imageMessage ||
    msg.viewOnceMessageV2?.message?.imageMessage ||
    msg.viewOnceMessage?.message?.imageMessage ||
    RSM?.viewOnceMessage?.message?.imageMessage ||
    RSM?.viewOnceMessageV2Extension?.message?.imageMessage ||
    msg.viewOnceMessageV2Extension?.message?.imageMessage ||
    null;

  const video =
    RSM?.videoMessage ||
    msg.videoMessage ||
    RSM?.viewOnceMessageV2?.message?.videoMessage ||
    msg.viewOnceMessageV2?.message?.videoMessage ||
    msg.viewOnceMessage?.message?.videoMessage ||
    RSM?.viewOnceMessage?.message?.videoMessage ||
    RSM?.viewOnceMessageV2Extension?.message?.videoMessage ||
    msg.viewOnceMessageV2Extension?.message?.videoMessage ||
    null;

  const sticker =
    RSM?.stickerMessage ||
    msg.stickerMessage ||
    null;

  return { image, video, sticker, quotedMessage: RSM };
}

/** t na foto (legenda ou reply) vira fig. Fig citada so se a msg atual nao for foto/video. */
function pickTApplyTarget(info) {
  const src = resolveStickerSource(info);
  const msg = (info && info.message) || {};
  const ownImage = !!(
    msg.imageMessage ||
    msg.viewOnceMessageV2?.message?.imageMessage ||
    msg.viewOnceMessage?.message?.imageMessage ||
    msg.viewOnceMessageV2Extension?.message?.imageMessage
  );
  const ownVideo = !!(
    msg.videoMessage ||
    msg.viewOnceMessageV2?.message?.videoMessage ||
    msg.viewOnceMessage?.message?.videoMessage ||
    msg.viewOnceMessageV2Extension?.message?.videoMessage
  );
  if (ownImage && src.image) return { kind: 'image', node: src.image };
  if (ownVideo && src.video) {
    return { kind: 'video', node: src.video, seconds: Number(src.video.seconds || 0) };
  }
  if (src.sticker) return { kind: 'sticker', node: src.sticker };
  if (src.image) return { kind: 'image', node: src.image };
  if (src.video) return { kind: 'video', node: src.video, seconds: Number(src.video.seconds || 0) };
  return null;
}

module.exports = {
  defaultStickerBrand,
  imageToWebp,
  videoToWebp,
  writeExif,
  mediaToStickerBuffer,
  sendSticker,
  stickerToImage,
  resolveStickerSource,
  pickTApplyTarget,
  hasFfmpeg: () => !!resolveStickerFfmpeg()
};
