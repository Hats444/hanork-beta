'use strict';
/** ffmpeg curto (tomp3/audiofx) + figurinha de texto (figquote). Sem puppeteer. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function tmp(ext) {
  return path.join(os.tmpdir(), `hanork_shop_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`);
}

function runFfmpeg(args, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let bin = null;
    try {
      bin = require('../services/stillAudioMux').resolveFfmpeg();
    } catch (_) { /* */ }
    if (!bin) return reject(new Error('ffmpeg ausente'));
    const p = spawn(bin, args, { windowsHide: true });
    let err = '';
    const t = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch (_) { /* */ }
      reject(new Error('ffmpeg timeout'));
    }, timeoutMs);
    p.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 800) err = err.slice(-800);
    });
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(err.slice(0, 120) || `ffmpeg ${code}`));
    });
  });
}

async function toMp3(buf) {
  const inn = tmp('bin');
  const out = tmp('mp3');
  fs.writeFileSync(inn, buf);
  try {
    await runFfmpeg(['-y', '-i', inn, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', out]);
    return fs.readFileSync(out);
  } finally {
    try { fs.unlinkSync(inn); } catch (_) { /* */ }
    try { fs.unlinkSync(out); } catch (_) { /* */ }
  }
}

const FX = {
  grave: ['asetrate=44100*0.8,aresample=44100'],
  agudo: ['asetrate=44100*1.25,aresample=44100'],
  rapido: ['atempo=1.35'],
  lento: ['atempo=0.8'],
  eco: ['aecho=0.8:0.88:60:0.3']
};

async function audioFx(buf, name) {
  const filter = FX[String(name || '').toLowerCase()];
  if (!filter) throw new Error('fx');
  const inn = tmp('bin');
  const out = tmp('mp3');
  fs.writeFileSync(inn, buf);
  try {
    await runFfmpeg(['-y', '-i', inn, '-vn', '-af', filter[0], '-acodec', 'libmp3lame', '-q:a', '4', out]);
    return fs.readFileSync(out);
  } finally {
    try { fs.unlinkSync(inn); } catch (_) { /* */ }
    try { fs.unlinkSync(out); } catch (_) { /* */ }
  }
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .slice(0, 280);
}

function wrapLines(text, max = 22) {
  const words = String(text || '').trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) {
      if (cur) lines.push(cur.trim());
      cur = w;
    } else cur = (cur + ' ' + w).trim();
    if (lines.length >= 8) break;
  }
  if (cur && lines.length < 8) lines.push(cur);
  return lines;
}

async function quotePng(text) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (_) {
    throw new Error('sharp');
  }
  const lines = wrapLines(text);
  const tspans = lines
    .map((l, i) => `<tspan x="36" dy="${i === 0 ? 0 : 36}">${escapeXml(l)}</tspan>`)
    .join('');
  const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
    <rect width="512" height="512" fill="#111111"/>
    <text x="36" y="80" fill="#f2f2f2" font-size="28" font-family="sans-serif">${tspans}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { toMp3, audioFx, quotePng, FX_NAMES: Object.keys(FX) };
