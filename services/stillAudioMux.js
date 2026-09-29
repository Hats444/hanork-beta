'use strict';
/**
 * Junta foto + audio num MP4 (imagem parada com som).
 * Usado quando o download nao traz video real (TikTok foto, IG, etc).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const logger = require('../logger');

let ffmpegBin = null;

function ffmpegCandidates() {
  const out = [];
  if (process.env.FFMPEG_PATH) out.push(process.env.FFMPEG_PATH);
  out.push('ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) out.push(p);
  } catch (_) { /* pacote sem binario na host */ }
  return [...new Set(out.filter(Boolean))];
}

function tryRepairFfmpegStatic() {
  try {
    const dir = path.dirname(require.resolve('ffmpeg-static/package.json'));
    const bin = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(bin)) return bin;
    const installJs = path.join(dir, 'install.js');
    if (!fs.existsSync(installJs)) return null;
    const { spawnSync } = require('child_process');
    logger.logAviso('[mux] baixando binario ffmpeg-static (arquivo ausente na host)');
    spawnSync(process.execPath, [installJs], { cwd: dir, timeout: 90000, windowsHide: true });
    return fs.existsSync(bin) ? bin : null;
  } catch (_) {
    return null;
  }
}

function probeFfmpeg(bin) {
  const { spawnSync } = require('child_process');
  try {
    const r = spawnSync(bin, ['-hide_banner', '-version'], {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8'
    });
    const txt = String(r.stdout || '') + String(r.stderr || '');
    return r.status === 0 || /ffmpeg version/i.test(txt);
  } catch (_) {
    return false;
  }
}

function resolveFfmpeg() {
  if (ffmpegBin) return ffmpegBin;
  for (const bin of ffmpegCandidates()) {
    if (probeFfmpeg(bin)) {
      ffmpegBin = bin;
      logger.logInfo(`[mux] ffmpeg=${bin}`);
      return ffmpegBin;
    }
  }
  const repaired = tryRepairFfmpegStatic();
  if (repaired && probeFfmpeg(repaired)) {
    ffmpegBin = repaired;
    logger.logInfo(`[mux] ffmpeg=${repaired} (repaired)`);
    return ffmpegBin;
  }
  ffmpegBin = null;
  logger.logAviso('[mux] nenhum ffmpeg no PATH nem ffmpeg-static');
  return null;
}

function tmpPath(ext) {
  return path.join(os.tmpdir(), `hanork_mux_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`);
}

function unlinkQuiet(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) { /* ignore */ }
}

function imageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return 'jpg';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return 'jpg';
}

function audioExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return 'mp3';
  const s = buf.slice(0, 8).toString('utf8');
  if (s.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
  if (s.startsWith('OggS')) return 'ogg';
  if (s.startsWith('ftyp') || buf.slice(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  if (s.startsWith('RIFF')) return 'wav';
  return 'mp3';
}

function rmQuiet(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* ignore */ }
}

/**
 * Zap so toca mp3/ogg direito. ytaudio da API vem ftyp dash (fMP4) e o app
 * marca "corrompido". Converte pra mp3 quando nao for mpeg/ogg.
 */
async function toPlayableMp3(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16 * 1024) {
    throw new Error('Audio vazio');
  }
  const h = buf.slice(0, 16);
  const s = h.toString('utf8');
  if (s.startsWith('ID3') || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0 && h[1] !== 0xd8)) {
    return buf;
  }
  const inn = tmpPath(audioExt(buf));
  const out = tmpPath('mp3');
  fs.writeFileSync(inn, buf);
  try {
    try {
      await runFfmpeg([
        '-hide_banner', '-y', '-i', inn,
        '-vn', '-sn', '-dn',
        '-ac', '2', '-ar', '44100',
        '-c:a', 'libmp3lame', '-q:a', '5',
        out
      ], 35000);
    } catch (e1) {
      logger.logAviso(`[mux] lame: ${e1.message}`);
      await runFfmpeg([
        '-hide_banner', '-y', '-i', inn,
        '-vn', '-sn', '-dn',
        '-ac', '2', '-ar', '44100',
        '-f', 'mp3',
        out
      ], 35000);
    }
    const done = fs.readFileSync(out);
    if (done.length < 12 * 1024) throw new Error('mp3 ffmpeg curto');
    logger.logInfo(`[mux] audio→mp3 ${buf.length}→${done.length}`);
    return done;
  } finally {
    rmQuiet(inn);
    rmQuiet(out);
  }
}

function isImageBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50) return true;
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return true;
  if (buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a') return true;
  return false;
}

function runFfmpeg(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const bin = resolveFfmpeg();
    if (!bin) return reject(new Error('ffmpeg indisponivel (nem PATH nem ffmpeg-static)'));
    const proc = spawn(bin, args, { windowsHide: true });
    let err = '';
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
      reject(new Error(`ffmpeg timeout ${timeoutMs}ms`));
    }, Math.max(5000, Number(timeoutMs) || 90000));
    proc.stderr.on('data', (d) => {
      err += String(d);
    });
    proc.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(e);
    });
    proc.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (code === 0) resolve(true);
      else reject(new Error(err.slice(-400) || `ffmpeg exit ${code}`));
    });
  });
}

/**
 * Foto parada + audio → mp4 (mesmo tamanho da foto, duracao do audio).
 */
async function muxVideoAndAudio(videoBuf, audioBuf) {
  if (!Buffer.isBuffer(videoBuf) || videoBuf.length < 32) throw new Error('video vazio');
  if (!Buffer.isBuffer(audioBuf) || audioBuf.length < 32) throw new Error('audio vazio');
  const vis = tmpPath('mp4');
  const aud = tmpPath(audioExt(audioBuf));
  const out = tmpPath('mp4');
  fs.writeFileSync(vis, videoBuf);
  fs.writeFileSync(aud, audioBuf);
  try {
    try {
      await runFfmpeg([
        '-y',
        '-stream_loop', '-1',
        '-i', vis,
        '-i', aud,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-movflags', '+faststart',
        out
      ]);
    } catch (_) {
      try {
        await runFfmpeg([
          '-y',
          '-stream_loop', '-1',
          '-i', vis,
          '-i', aud,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-pix_fmt', 'yuv420p',
          '-shortest',
          '-movflags', '+faststart',
          out
        ]);
      } catch (_) {
        await runFfmpeg([
          '-y',
          '-stream_loop', '-1',
          '-i', vis,
          '-i', aud,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'mpeg4',
          '-c:a', 'aac',
          '-shortest',
          out
        ]);
      }
    }
    const buf = fs.readFileSync(out);
    const { isPlayableVideoBuffer } = require('./zerotwoClient');
    if (!isPlayableVideoBuffer(buf)) throw new Error('mux video+audio invalido');
    return buf;
  } finally {
    unlinkQuiet(vis);
    unlinkQuiet(aud);
    unlinkQuiet(out);
  }
}

async function muxStillAndAudio(imageBuf, audioBuf) {
  if (!isImageBuffer(imageBuf)) throw new Error('nao e imagem');
  if (!Buffer.isBuffer(audioBuf) || audioBuf.length < 32) throw new Error('audio vazio');

  const img = tmpPath(imageExt(imageBuf));
  const aud = tmpPath(audioExt(audioBuf));
  const out = tmpPath('mp4');
  fs.writeFileSync(img, imageBuf);
  fs.writeFileSync(aud, audioBuf);

  const vf =
    "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease," +
    'pad=ceil(iw/2)*2:ceil(ih/2)*2';

  try {
    try {
      await runFfmpeg([
        '-y',
        '-loop', '1',
        '-i', img,
        '-i', aud,
        '-c:v', 'libx264',
        '-tune', 'stillimage',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-pix_fmt', 'yuv420p',
        '-vf', vf,
        '-shortest',
        '-movflags', '+faststart',
        out
      ]);
    } catch (e) {
      logger.logAviso(`[mux] libx264 falhou, mpeg4: ${e.message}`);
      await runFfmpeg([
        '-y',
        '-loop', '1',
        '-i', img,
        '-i', aud,
        '-c:v', 'mpeg4',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-pix_fmt', 'yuv420p',
        '-vf', vf,
        '-shortest',
        out
      ]);
    }
    const buf = fs.readFileSync(out);
    const { isPlayableVideoBuffer } = require('./zerotwoClient');
    if (!isPlayableVideoBuffer(buf)) throw new Error('mux gerou arquivo invalido');
    return buf;
  } finally {
    unlinkQuiet(img);
    unlinkQuiet(aud);
    unlinkQuiet(out);
  }
}

function collectImages(media) {
  const out = [];
  const push = (b) => {
    if (isImageBuffer(b)) out.push(b);
  };
  for (const b of media.imageBuffers || []) push(b);
  push(media.mediaBuffer);
  if (isImageBuffer(media.videoBuffer)) push(media.videoBuffer);
  if (media.items) {
    for (const it of media.items) push(it.mediaBuffer);
  }
  return out;
}

function firstAudioUrl(...cands) {
  return firstAudioUrlAt(0, cands);
}

function firstAudioUrlAt(depth, cands) {
  if (depth > 4) return null;
  for (const x of cands || []) {
    if (!x) continue;
    if (typeof x === 'string' && /^https?:\/\//i.test(x)) return x;
    if (Array.isArray(x)) {
      const u = firstAudioUrlAt(depth + 1, x);
      if (u) return u;
    }
    if (typeof x === 'object') {
      const u = firstAudioUrlAt(depth + 1, [x.url, x.play, x.play_url, x.playUrl, x.src, x.link]);
      if (u) return u;
    }
  }
  return null;
}

async function fetchAudioIfNeeded(media) {
  if (Buffer.isBuffer(media.audioBuffer) && media.audioBuffer.length > 32) return media.audioBuffer;
  const raw = media.raw || {};
  const url = firstAudioUrl(
    media.audioUrl,
    media.musicUrl,
    media.music,
    raw.music,
    raw.music_info,
    raw.audio,
    raw.music_url,
    raw.audio_url,
    raw.music_play_url
  );
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  try {
    const { fetchBuffer } = require('./zerotwoClient');
    const r = await fetchBuffer(url, 90000);
    return r?.buffer || null;
  } catch (e) {
    logger.logAviso(`[mux] audio url: ${e.message}`);
    return null;
  }
}

/**
 * Se nao houver video real mas houver foto+audio, vira video.
 */
async function prepareDownloadMedia(media) {
  if (!media || typeof media !== 'object') return media;
  const { isPlayableVideoBuffer } = require('./zerotwoClient');
  const videoCand = media.videoBuffer || (media.type === 'video' ? media.mediaBuffer : null);
  const playable = isPlayableVideoBuffer(videoCand);
  const images = collectImages(media);
  const audio = await fetchAudioIfNeeded(media);
  logger.logInfo(
    `[mux] video=${playable ? 1 : 0} images=${images.length} audio=${audio ? audio.length : 0} ffmpeg=${resolveFfmpeg() || 0}`
  );

  // Foto (ou video mudo de slideshow) + faixa: junta. Video real com som NAO remuxa.
  if (audio && images.length) {
    try {
      const muxed = await muxStillAndAudio(images[0], audio);
      logger.logInfo('[mux] foto+audio → mp4');
      return { ...media, videoBuffer: muxed, muxed: true, audioBuffer: audio };
    } catch (e) {
      logger.logAviso(`[mux] falhou: ${e.message}`);
      return {
        ...media,
        videoBuffer: playable ? videoCand : null,
        audioBuffer: audio,
        imageBuffers: images.length ? images : media.imageBuffers
      };
    }
  }

  if (playable) return { ...media, videoBuffer: videoCand };

  if (isImageBuffer(videoCand) && !audio) {
    return { ...media, videoBuffer: null, mediaBuffer: videoCand, type: 'image' };
  }
  return { ...media, audioBuffer: audio || media.audioBuffer };
}

module.exports = {
  muxStillAndAudio,
  muxVideoAndAudio,
  prepareDownloadMedia,
  isImageBuffer,
  toPlayableMp3,
  hasFfmpeg: () => !!resolveFfmpeg(),
  resolveFfmpeg
};
