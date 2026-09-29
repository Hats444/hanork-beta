'use strict';
/**
 * Sidecar Ollama na egg Raikken (sem daemon oficial).
 * A host tem 1536 MiB — qwen2.5-coder:3b nao cabe. Sobe llama-server
 * com Qwen2.5-Coder 0.5B Q4 e um shim /api/* na porta 11434.
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const logger = require('../logger');

const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin', 'llama');
const MODEL_DIR = path.join(ROOT, 'models');
const MODEL_PATH = path.join(MODEL_DIR, 'hanork-brain.gguf');
const TAR_PATH = path.join(BIN_DIR, 'llama-cpu.tar.gz');

const LLAMA_TAG = process.env.OLLAMA_SIDECAR_LLAMA_TAG || 'b10636';
const LLAMA_URL =
  process.env.OLLAMA_SIDECAR_LLAMA_URL ||
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`;
const MODEL_URL =
  process.env.OLLAMA_SIDECAR_MODEL_URL ||
  'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf';

const SHIM_PORT = parseInt(process.env.OLLAMA_SIDECAR_PORT || '11434', 10);
const UPSTREAM_PORT = parseInt(process.env.OLLAMA_SIDECAR_UPSTREAM || '11435', 10);
const CTX = Math.max(256, parseInt(process.env.OLLAMA_SIDECAR_CTX || '1024', 10));
const THREADS = Math.max(1, parseInt(process.env.OLLAMA_SIDECAR_THREADS || '2', 10));

const SIDECAR_ON = !/^(0|false|off|no|disabled)$/i.test(
  String(process.env.OLLAMA_SIDECAR ?? (process.platform === 'linux' ? '1' : '0')).trim()
);

let starting = false;
let ready = false;
let child = null;
let shim = null;
let brainSystem = '';
const STATUS_PATH = path.join(ROOT, 'data', 'ollama-sidecar.status');

function writeStatus(obj) {
  try {
    fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
    fs.writeFileSync(
      STATUS_PATH,
      JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'
    );
  } catch (_) { /* */ }
}

function isBusy() {
  return starting && !ready;
}

function isReady() {
  return ready;
}

function loadBrainSystem() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'hanork-brain.Modelfile'), 'utf8');
    const m = raw.match(/SYSTEM\s+"""([\s\S]*?)"""/);
    brainSystem = (m && m[1].trim()) || '';
  } catch (_) {
    brainSystem = '';
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(tmp);
    let bytes = 0;
    let lastLog = 0;
    const go = (u, hops) => {
      if (hops > 8) {
        out.close();
        return reject(new Error('redirect loop'));
      }
      const lib = String(u).startsWith('http://') ? http : https;
      const req = lib.get(
        u,
        { headers: { 'User-Agent': 'hanork-sidecar/1', Accept: '*/*' }, timeout: 120000 },
        (res) => {
          const loc = res.headers.location;
          if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
            res.resume();
            const next = loc.startsWith('http') ? loc : new URL(loc, u).toString();
            return go(next, hops + 1);
          }
          if (res.statusCode !== 200) {
            out.close();
            try { fs.unlinkSync(tmp); } catch (_) { /* */ }
            return reject(new Error('http ' + res.statusCode + ' ' + u.slice(0, 80)));
          }
          res.on('data', (c) => {
            bytes += c.length;
            if (bytes - lastLog > 40 * 1024 * 1024) {
              lastLog = bytes;
              logger.logInfo(`[OLLAMA-SC] download ${(bytes / 1048576).toFixed(0)} MB`);
            }
          });
          res.pipe(out);
          out.on('finish', () => {
            out.close(() => {
              try {
                fs.renameSync(tmp, dest);
                resolve(bytes);
              } catch (e) {
                reject(e);
              }
            });
          });
        }
      );
      req.on('error', (e) => {
        out.close();
        try { fs.unlinkSync(tmp); } catch (_) { /* */ }
        reject(e);
      });
      req.on('timeout', () => {
        req.destroy();
        out.close();
        try { fs.unlinkSync(tmp); } catch (_) { /* */ }
        reject(new Error('download timeout'));
      });
    };
    go(url, 0);
  });
}

function findNamed(dir, name) {
  if (!fs.existsSync(dir)) return null;
  const ents = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findNamed(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return null;
}

async function ensureBinary() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  let bin = findNamed(BIN_DIR, 'llama-server');
  if (!(bin && fs.existsSync(bin))) {
    logger.logInfo('[OLLAMA-SC] baixando llama-server CPU…');
    writeStatus({ step: 'download_bin' });
    await download(LLAMA_URL, TAR_PATH);
    try {
      execFileSync('tar', ['-xzf', TAR_PATH, '-C', BIN_DIR], { stdio: 'pipe', timeout: 120000 });
    } catch (e) {
      throw new Error('tar extract: ' + String(e.message || e).slice(0, 120));
    }
    try { fs.unlinkSync(TAR_PATH); } catch (_) { /* */ }
    bin = findNamed(BIN_DIR, 'llama-server');
  }
  if (!bin) throw new Error('llama-server nao veio no tar');
  try { fs.chmodSync(bin, 0o755); } catch (_) { /* */ }
  return bin;
}

async function ensureModel() {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  if (fs.existsSync(MODEL_PATH) && fs.statSync(MODEL_PATH).size > 50 * 1024 * 1024) {
    return MODEL_PATH;
  }
  logger.logInfo('[OLLAMA-SC] baixando GGUF Qwen2.5-Coder 0.5B (~470 MB)…');
  await download(MODEL_URL, MODEL_PATH);
  return MODEL_PATH;
}

function waitHealth(port, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - t0 > timeoutMs) return reject(new Error('llama-server health timeout'));
      setTimeout(tick, 800);
    };
    tick();
  });
}

function postJson(port, urlPath, body, timeoutMs) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: timeoutMs || 60000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch (_) {
            reject(new Error('upstream json ' + res.statusCode));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('upstream timeout'));
    });
    req.end(payload);
  });
}

async function completeChat(messages, opts) {
  const res = await postJson(
    UPSTREAM_PORT,
    '/v1/chat/completions',
    {
      model: 'hanork-brain',
      messages,
      temperature: opts.temperature == null ? 0.2 : opts.temperature,
      max_tokens: opts.max_tokens || 160,
      stream: false
    },
    opts.timeout || 60000
  );
  return String(res.data?.choices?.[0]?.message?.content || '').trim();
}

function startShim() {
  if (shim) return;
  loadBrainSystem();
  shim = http.createServer(async (req, res) => {
    const url = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && (url === '/api/tags' || url === '/api/ps')) {
      return json(res, 200, {
        models: [{ name: 'hanork-brain', model: 'hanork-brain', size: 0, details: { family: 'qwen2' } }]
      });
    }
    if (req.method === 'GET' && (url === '/' || url === '/health')) {
      return json(res, 200, { ok: true, sidecar: true });
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) body = JSON.parse(raw);
    } catch (_) { /* */ }
    try {
      const opts = {
        temperature: body.options && body.options.temperature,
        max_tokens: (body.options && body.options.num_predict) || 160,
        timeout: 60000
      };
      if (req.method === 'POST' && url === '/api/generate') {
        const messages = [];
        const sys = body.system || brainSystem;
        if (sys) messages.push({ role: 'system', content: sys });
        messages.push({ role: 'user', content: String(body.prompt || '') });
        const text = await completeChat(messages, opts);
        return json(res, 200, { model: 'hanork-brain', response: text, done: true });
      }
      if (req.method === 'POST' && url === '/api/chat') {
        const msgs = Array.isArray(body.messages) ? body.messages.slice() : [];
        if (brainSystem && !msgs.some((m) => m && m.role === 'system')) {
          msgs.unshift({ role: 'system', content: brainSystem });
        }
        const text = await completeChat(msgs, opts);
        return json(res, 200, {
          model: 'hanork-brain',
          message: { role: 'assistant', content: text },
          done: true
        });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 502, { error: String(e.message || e).slice(0, 180) });
    }
  });
  shim.listen(SHIM_PORT, '127.0.0.1', () => {
    logger.logInfo(`[OLLAMA-SC] shim :${SHIM_PORT} → llama :${UPSTREAM_PORT}`);
  });
  shim.on('error', (e) => {
    logger.logAviso(`[OLLAMA-SC] shim: ${e.message}`);
  });
}

function spawnLlama(bin, model) {
  const libDir = path.dirname(bin);
  const args = [
    '-m', model,
    '--host', '127.0.0.1',
    '--port', String(UPSTREAM_PORT),
    '-c', String(CTX),
    '-ngl', '0',
    '-t', String(THREADS)
  ];
  writeStatus({ step: 'spawn', bin, model, args });
  const errBuf = [];
  child = spawn(bin, args, {
    cwd: libDir,
    env: { ...process.env, LD_LIBRARY_PATH: libDir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.on('error', (e) => {
    writeStatus({ step: 'spawn_error', err: String(e.message || e).slice(0, 240) });
    logger.logAviso('[OLLAMA-SC] spawn: ' + e.message);
  });
  child.stdout.on('data', (buf) => {
    const line = String(buf).trim().slice(0, 180);
    if (line) logger.logDebug('[llama] ' + line);
  });
  child.stderr.on('data', (buf) => {
    const line = String(buf).trim();
    errBuf.push(line.slice(0, 200));
    if (errBuf.length > 12) errBuf.shift();
    if (/error|fail|oom|GLIBC|not found/i.test(line)) {
      logger.logAviso('[llama] ' + line.slice(0, 180));
      writeStatus({ step: 'stderr', line: line.slice(0, 240) });
    }
  });
  child.on('exit', (code) => {
    ready = false;
    writeStatus({ step: 'exit', code, stderr: errBuf.join(' | ').slice(0, 500) });
    logger.logAviso(`[OLLAMA-SC] llama-server saiu code=${code}`);
    child = null;
  });
}

function stopOllamaSidecar() {
  ready = false;
  starting = false;
  try {
    if (shim) {
      shim.close();
      shim = null;
    }
  } catch (_) { /* */ }
  try {
    if (child && !child.killed) child.kill('SIGTERM');
  } catch (_) { /* */ }
  child = null;
}

async function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/tags', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureOllamaSidecar() {
  if (!SIDECAR_ON) {
    logger.logInfo('[OLLAMA-SC] desligado (OLLAMA_SIDECAR=0)');
    return false;
  }
  if (process.platform !== 'linux') {
    logger.logInfo('[OLLAMA-SC] so linux (egg). skip');
    return false;
  }
  if (ready) return true;
  if (starting) return false;
  starting = true;
  writeStatus({ step: 'start' });
  try {
    if (await probePort(SHIM_PORT)) {
      ready = true;
      starting = false;
      writeStatus({ step: 'already_up', port: SHIM_PORT });
      logger.logInfo('[OLLAMA-SC] ja tinha algo em :' + SHIM_PORT);
      return true;
    }
    const bin = await ensureBinary();
    writeStatus({ step: 'bin_ok', bin });
    const model = await ensureModel();
    writeStatus({ step: 'model_ok', model, bytes: fs.statSync(model).size });
    spawnLlama(bin, model);
    await waitHealth(UPSTREAM_PORT, 180000);
    startShim();
    ready = true;
    starting = false;
    try {
      require('./ollamaService').clearHostHardOffline();
    } catch (_) { /* */ }
    writeStatus({ step: 'ready', port: SHIM_PORT });
    logger.logSucesso('[OLLAMA-SC] hanork-brain (Qwen2.5-Coder 0.5B) no ar');
    return true;
  } catch (e) {
    starting = false;
    ready = false;
    writeStatus({ step: 'fail', err: String(e.message || e).slice(0, 240) });
    logger.logAviso(`[OLLAMA-SC] falhou: ${String(e.message || e).slice(0, 160)} — Intent segue no pool`);
    stopOllamaSidecar();
    return false;
  }
}

module.exports = {
  ensureOllamaSidecar,
  stopOllamaSidecar,
  isBusy,
  isReady
};
