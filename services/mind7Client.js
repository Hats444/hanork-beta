'use strict';
/**
 * Cliente HTTP do painel Mind7.
 * Login: POST /acesso/ com Turnstile. Consulta: POST consultas/<mod>/<php>.
 * Sem Playwright no default (RAM da host). Cookies em data/mind7-session.json.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../logger');
const { getModule } = require('./mind7Catalog');

const BASE = String(process.env.MIND7_BASE || 'https://mind-7.org').replace(/\/$/, '');
const SITEKEY = String(process.env.MIND7_TURNSTILE_SITEKEY || '0x4AAAAAAB0RonYg1xZne8Gi');
const SESSION_PATH = path.join(__dirname, '../data/mind7-session.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const TEXT_CAP = 3200;

let jar = '';
let xToken = '';
let queue = Promise.resolve();
let sessionVerified = false;
let sessionVerifiedAt = 0;
const SESSION_TTL_MS = Number(process.env.MIND7_SESSION_TTL_MS || 120000);

function resetSessionCache() {
  sessionVerified = false;
  sessionVerifiedAt = 0;
  xToken = '';
}

function isConfigured() {
  return !!(
    String(process.env.MIND7_COOKIE || '').trim() ||
    (String(process.env.MIND7_EMAIL || '').trim() && String(process.env.MIND7_PASSWORD || '').trim()) ||
    fs.existsSync(SESSION_PATH)
  );
}

/**
 * Painel extra off por padrao (CF + solver na VPS).
 * Liga so com MIND7_ENABLED=1|true|on quando NSL/Capsolver tiver credito.
 */
function isEnabled() {
  const raw = String(process.env.MIND7_ENABLED || '0').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  return false;
}

let lastHealth = { sessionOk: false, lastError: '', at: 0 };

function noteHealth(ok, err) {
  lastHealth = {
    sessionOk: !!ok,
    lastError: ok ? '' : String(err || '').slice(0, 80),
    at: Date.now()
  };
}

function getHealthDetail() {
  return { ...lastHealth };
}

function loadSession() {
  const envCk = String(process.env.MIND7_COOKIE || '').trim();
  let fileJar = '';
  let fileTok = '';
  let fileTs = 0;
  try {
    const raw = fs.readFileSync(SESSION_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (j && j.cookies) fileJar = String(j.cookies);
    if (j && j.xToken) fileTok = String(j.xToken);
    if (j && j.ts) fileTs = Number(j.ts) || 0;
  } catch (_) { /* sem sessao */ }

  // Sessao gerada na VPS (pos-login) vale mais que cookie colado do PC (IP diferente)
  if (fileJar && fileTs > Date.now() - 86400000) {
    jar = fileJar;
    xToken = fileTok;
    return;
  }
  if (envCk) {
    jar = envCk;
    if (fileTok) xToken = fileTok;
    return;
  }
  jar = fileJar;
  xToken = fileTok;
}

function saveSession() {
  try {
    const dir = path.dirname(SESSION_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSION_PATH, JSON.stringify({
      cookies: jar,
      xToken,
      ts: Date.now()
    }));
  } catch (e) {
    logger.logAviso(`[mind7] sessao nao gravou: ${e.message}`);
  }
}

function mergeCookies(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  const map = new Map();
  for (const part of String(jar || '').split(';')) {
    const t = part.trim();
    const i = t.indexOf('=');
    if (i > 0) map.set(t.slice(0, i), t.slice(i + 1));
  }
  for (const line of list) {
    const first = String(line || '').split(';')[0].trim();
    const i = first.indexOf('=');
    if (i > 0) map.set(first.slice(0, i), first.slice(i + 1));
  }
  jar = [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function headers(extra) {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1',
    Cookie: jar || '',
    ...extra
  };
}

function painelLooksOk(html, status) {
  const h = String(html || '');
  if (status === 403 || looksLikeCf(h)) return false;
  if (/Acessar painel|Bem-vindo de volta|cf-turnstile-response/i.test(h) && !/documento|meu-formulario|consultas\//i.test(h)) {
    return false;
  }
  return /Módulos disponíveis|Modulos disponiveis|consultas\/cpf|BASICO|Empresarial/i.test(h);
}

async function verifySession(force) {
  if (!force && sessionVerified && (Date.now() - sessionVerifiedAt) < SESSION_TTL_MS) return true;
  loadSession();
  if (!jar) return false;
  try {
    const res = await http('GET', `${BASE}/painel/`, {
      headers: { Referer: `${BASE}/` }
    });
    const html = String(res.data || '');
    const ok = painelLooksOk(html, res.status);
    if (ok) {
      const tok = extractXToken(html);
      if (tok) xToken = tok;
      sessionVerified = true;
      sessionVerifiedAt = Date.now();
      saveSession();
      noteHealth(true);
    } else {
      resetSessionCache();
      noteHealth(false, 'sessao_invalida');
    }
    return ok;
  } catch (e) {
    resetSessionCache();
    noteHealth(false, e && e.message ? e.message : 'verify');
    return false;
  }
}

async function http(method, url, opts = {}) {
  const res = await axios({
    method,
    url,
    maxRedirects: 5,
    validateStatus: () => true,
    timeout: Number(process.env.MIND7_TIMEOUT_MS || 45000),
    headers: headers(opts.headers),
    data: opts.data,
    responseType: 'text',
    transformResponse: [(d) => d]
  });
  mergeCookies(res.headers['set-cookie']);
  return res;
}

function looksLikeCf(html) {
  const s = String(html || '');
  return /Just a moment|cf-turnstile|challenge-platform|Checking your browser/i.test(s);
}

function extractXToken(html) {
  const m = String(html || '').match(/var T=["']([a-f0-9]{16,})["']/i);
  return m ? m[1] : '';
}

/** Campos ocultos / selects do formulario real do modulo (evita catalogo desatualizado). */
function parseFormFromHtml(html) {
  const $ = cheerio.load(String(html || ''));
  const form = $('#meu-formulario').length
    ? $('#meu-formulario')
    : $('form[action*=".php"]').first();
  if (!form.length) return null;

  let action = String(form.attr('action') || 'search.php').trim();
  if (/^https?:\/\//i.test(action)) {
    try {
      action = new URL(action).pathname.split('/').pop() || 'search.php';
    } catch (_) {
      action = 'search.php';
    }
  }
  action = action.replace(/^\.\//, '');

  const defaults = {};
  form.find('input,select,textarea').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;
    const type = String($(el).attr('type') || '').toLowerCase();
    if (type === 'submit' || type === 'button') return;
    if ($(el).is('select')) {
      const sel = $(el).find('option[selected]').first();
      const val = sel.attr('value') ?? $(el).find('option').first().attr('value') ?? '';
      if (val !== '') defaults[name] = val;
      return;
    }
    if (type === 'checkbox' || type === 'radio') {
      if ($(el).attr('checked') !== undefined) {
        defaults[name] = $(el).attr('value') || (type === 'checkbox' ? 'on' : '');
      }
      return;
    }
    const val = $(el).attr('value');
    if (val !== undefined && val !== '') defaults[name] = val;
  });

  let primary = '';
  form.find('input[type=text],input:not([type]),textarea').each((_, el) => {
    const name = $(el).attr('name');
    if (name && name !== 'termos_aceitos' && !primary) primary = name;
  });

  return { action, defaults, primary };
}

function applyDocTipo(fields) {
  const raw = String(fields.documento || fields.q || '').replace(/\D/g, '');
  if (raw.length === 11 && !fields.tipo && !fields.tipo_consulta) fields.tipo = 'cpf';
  if (raw.length === 14 && !fields.tipo && !fields.tipo_consulta) fields.tipo = 'cnpj';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function solveTurnstileEzSolver(baseUrl, pageUrl) {
  const root = String(baseUrl || '').trim().replace(/\/$/, '');
  const endpoint = /\/solve$/i.test(root) ? root : `${root}/solve`;
  const res = await axios.post(endpoint, {
    sitekey: SITEKEY,
    siteurl: pageUrl,
    timeout: 60
  }, { timeout: 90000, validateStatus: () => true });
  const data = res.data || {};
  const tok = data.token || data.solution?.token || data.data;
  if (typeof tok === 'string' && tok.length > 20) return tok;
  throw new Error(String(data.error || data.message || 'ezsolver falhou'));
}

async function solveTurnstileSolverCf(clientKey, pageUrl) {
  const scfBase = String(process.env.SOLVERCF_BASE || 'https://solvercf.com').replace(/\/$/, '');
  const create = await axios.post(`${scfBase}/token/extension/createTask`, {
    clientKey,
    task: {
      type: 'TurnstileTask',
      websiteUrl: pageUrl,
      websiteKey: SITEKEY
    }
  }, { timeout: 25000, validateStatus: () => true });
  const cj = create.data || {};
  if (cj.errorId) {
    const msg = String(cj.errorDescription || cj.errorCode || 'solvercf create');
    if (/balance/i.test(msg)) throw new Error('solvercf_balance');
    throw new Error(msg);
  }
  const taskId = cj.taskId;
  if (!taskId) throw new Error('solvercf sem taskId');
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const poll = await axios.post(`${scfBase}/token/extension/getTaskResult`, {
      clientKey,
      taskId
    }, { timeout: 25000, validateStatus: () => true });
    const pj = poll.data || {};
    const st = pj.status;
    if (st === 'ready' || st === 'success') {
      const tok = pj.solution && pj.solution.token;
      if (tok) return String(tok);
    }
    if (st === 'failed' || st === 'expired') throw new Error(`solvercf ${st}`);
    if (pj.errorId && /balance/i.test(String(pj.errorDescription || ''))) throw new Error('solvercf_balance');
  }
  throw new Error('solvercf timeout');
}

async function solveTurnstileNsl(apiKey, pageUrl) {
  const res = await axios.post('https://api.nslsolver.com/solve', {
    type: 'turnstile',
    site_key: SITEKEY,
    url: pageUrl
  }, {
    timeout: 120000,
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    validateStatus: () => true
  });
  const data = res.data || {};
  if (res.status === 401 || res.status === 403) throw new Error('nsl_key');
  if (/insufficient balance/i.test(String(data.message || data.error || ''))) throw new Error('nsl_balance');
  if (data.success && data.token) return String(data.token);
  throw new Error(String(data.message || data.error || 'nsl falhou'));
}

async function solveTurnstileNopecha(apiKey, pageUrl) {
  const create = await axios.post('https://api.nopecha.com/token/', {
    key: apiKey,
    type: 'turnstile',
    sitekey: SITEKEY,
    url: pageUrl
  }, { timeout: 20000, validateStatus: () => true });
  const id = create.data && create.data.data;
  if (!id || typeof id !== 'string') throw new Error('nopecha sem id');
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const poll = await axios.get('https://api.nopecha.com/token/', {
      params: { key: apiKey, id },
      timeout: 20000,
      validateStatus: () => true
    });
    const tok = poll.data && poll.data.data;
    if (typeof tok === 'string' && tok.length > 30 && !poll.data.error) return tok;
    if (poll.data && poll.data.error && poll.data.error !== 14) {
      throw new Error(String(poll.data.message || 'nopecha falhou'));
    }
  }
  throw new Error('nopecha timeout');
}

async function solveTurnstileCapsolver(apiKey, pageUrl) {
  let create;
  try {
    create = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: apiKey,
      task: {
        type: 'AntiTurnstileTaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: SITEKEY
      }
    }, { timeout: 20000 });
  } catch (e) {
    const st = e.response && e.response.status;
    if (st === 401 || st === 403) throw new Error('capsolver_key');
    throw e;
  }
  if (create.data && create.data.errorId) {
    const code = String(create.data.errorCode || '');
    if (/KEY_DENIED|INSUFFICIENT|ZERO_BALANCE/i.test(code)) throw new Error('capsolver_key');
    throw new Error('capsolver falhou');
  }
  const taskId = create.data && create.data.taskId;
  if (!taskId) throw new Error('capsolver sem taskId');
  for (let i = 0; i < 24; i++) {
    await sleep(3000);
    const poll = await axios.post('https://api.capsolver.com/getTaskResult', {
      clientKey: apiKey,
      taskId
    }, { timeout: 20000 });
    const st = poll.data && poll.data.status;
    if (st === 'ready') {
      const tok = poll.data.solution && (poll.data.solution.token || poll.data.solution.cf_clearance);
      if (tok) return String(tok);
    }
    if (st === 'failed' || poll.data?.errorId) throw new Error('capsolver falhou');
  }
  throw new Error('capsolver timeout');
}

async function solveTurnstile2Captcha(apiKey, pageUrl) {
  const inRes = await axios.get('https://2captcha.com/in.php', {
    params: {
      key: apiKey,
      method: 'turnstile',
      sitekey: SITEKEY,
      pageurl: pageUrl,
      json: 1
    },
    timeout: 20000
  });
  const id = inRes.data && inRes.data.request;
  if (!id) throw new Error('2captcha sem id');
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const out = await axios.get('https://2captcha.com/res.php', {
      params: { key: apiKey, action: 'get', id, json: 1 },
      timeout: 20000
    });
    if (out.data && out.data.status === 1) return String(out.data.request);
    if (out.data && out.data.request !== 'CAPCHA_NOT_READY') throw new Error('2captcha falhou');
  }
  throw new Error('2captcha timeout');
}

/** Turnstile login Mind7. Gratis primeiro: EzSolver(PC) -> SolverCF(1000 trial) -> NSL(100) -> NopeCHA -> pagos. */
async function solveTurnstile() {
  const pageUrl = `${BASE}/acesso/`;
  const providers = [];
  const ez = String(process.env.MIND7_EZSOLVER_URL || process.env.EZSOLVER_URL || '').trim();
  if (ez) providers.push(['ezsolver', ez]);
  const scf = String(process.env.SOLVERCF_API_KEY || process.env.MIND7_SOLVERCF_KEY || '').trim();
  if (scf) providers.push(['solvercf', scf]);
  const nsl = String(process.env.NSLSOLVER_API_KEY || process.env.MIND7_NSLSOLVER_KEY || '').trim();
  if (nsl) providers.push(['nsl', nsl]);
  const nope = String(process.env.NOPECHA_API_KEY || process.env.MIND7_NOPECHA_KEY || '').trim();
  if (nope) providers.push(['nopecha', nope]);
  const cap = String(process.env.CAPSOLVER_API_KEY || process.env.MIND7_CAPSOLVER_KEY || '').trim();
  if (cap) providers.push(['capsolver', cap]);
  const two = String(process.env.TWO_CAPTCHA_KEY || process.env.MIND7_2CAPTCHA_KEY || '').trim();
  if (two) providers.push(['2captcha', two]);

  if (!providers.length) throw new Error('captcha');

  let lastErr = 'captcha';
  for (const [name, key] of providers) {
    try {
      if (name === 'ezsolver') return await solveTurnstileEzSolver(key, pageUrl);
      if (name === 'solvercf') return await solveTurnstileSolverCf(key, pageUrl);
      if (name === 'nsl') return await solveTurnstileNsl(key, pageUrl);
      if (name === 'nopecha') return await solveTurnstileNopecha(key, pageUrl);
      if (name === 'capsolver') return await solveTurnstileCapsolver(key, pageUrl);
      if (name === '2captcha') return await solveTurnstile2Captcha(key, pageUrl);
    } catch (e) {
      lastErr = e && e.message ? e.message : 'erro';
      logger.logAviso(`[mind7] turnstile ${name}: ${lastErr}`);
    }
  }
  throw new Error(lastErr);
}

async function login(force, opts = {}) {
  const persist = opts.persist !== false;
  loadSession();
  if (!force && jar && await verifySession(false)) return true;

  const email = String(process.env.MIND7_EMAIL || '').trim();
  const senha = String(process.env.MIND7_PASSWORD || '').trim();
  if (!email || !senha) {
    if (jar && await verifySession(true)) return true;
    throw new Error('sem_cred');
  }

  if (force) {
    jar = '';
    resetSessionCache();
  }

  let gate = await http('GET', `${BASE}/acesso/`);
  if (gate.status === 403 || looksLikeCf(String(gate.data || ''))) {
    logger.logAviso('[mind7] acesso CF — tentando Turnstile/Capsolver');
  }

  let token = '';
  try {
    token = await solveTurnstile();
  } catch (e) {
    if (e.message === 'captcha') throw e;
    logger.logAviso(`[mind7] captcha solver: ${e.message}`);
    throw e;
  }

  const body = new URLSearchParams({
    email,
    senha,
    'cf-turnstile-response': token
  }).toString();

  const res = await http('POST', `${BASE}/acesso/`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: BASE,
      Referer: `${BASE}/acesso/`
    },
    data: body
  });

  const html = String(res.data || '');
  if (/complete o CAPTCHA|Por favor, complete/i.test(html)) throw new Error('captcha');
  if (/senha incorreta|credenciais|e-mail ou senha/i.test(html)) throw new Error('login');

  const painel = await http('GET', `${BASE}/painel/`, {
    headers: { Referer: `${BASE}/acesso/` }
  });
  const phtml = String(painel.data || '');
  if (!painelLooksOk(phtml, painel.status)) {
    if (painel.status === 403 || looksLikeCf(phtml)) throw new Error('cloudflare');
    throw new Error('painel');
  }
  const tok = extractXToken(phtml);
  if (tok) xToken = tok;
  sessionVerified = true;
  sessionVerifiedAt = Date.now();
  if (persist) saveSession();
  noteHealth(true);
  logger.logInfo('[mind7] login ok');
  return true;
}

function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '(vazio)';
  if (s.length <= 2) return '*'.repeat(s.length);
  return `${s.slice(0, 1)}${'*'.repeat(Math.min(10, s.length - 2))}${s.slice(-1)}`;
}

/**
 * Checa email/senha no painel sem baguncar a sessao do bot.
 * @returns {{ status: 'valid'|'invalid'|'error', reason?: string }}
 */
async function verifyCredentials(email, senha) {
  const snap = {
    jar,
    xToken,
    sessionVerified,
    sessionVerifiedAt
  };
  const prevEmail = process.env.MIND7_EMAIL;
  const prevPass = process.env.MIND7_PASSWORD;
  jar = '';
  xToken = '';
  resetSessionCache();
  process.env.MIND7_EMAIL = String(email || '').trim();
  process.env.MIND7_PASSWORD = String(senha || '').trim();
  try {
    await login(true, { persist: false });
    return { status: 'valid' };
  } catch (e) {
    const code = String((e && e.message) || 'erro');
    if (code === 'login') return { status: 'invalid', reason: 'e-mail ou senha recusados' };
    if (code === 'sem_cred') return { status: 'error', reason: 'email/senha vazios' };
    if (code === 'captcha') return { status: 'error', reason: 'captcha (sem solver/saldo)' };
    if (code === 'cloudflare') return { status: 'error', reason: 'cloudflare no IP' };
    if (code === 'painel') return { status: 'error', reason: 'login passou mas painel nao abriu' };
    return { status: 'error', reason: code.slice(0, 80) };
  } finally {
    process.env.MIND7_EMAIL = prevEmail;
    process.env.MIND7_PASSWORD = prevPass;
    jar = snap.jar;
    xToken = snap.xToken;
    sessionVerified = snap.sessionVerified;
    sessionVerifiedAt = snap.sessionVerifiedAt;
  }
}

function htmlToText(html) {
  const raw = String(html || '');
  if (/temporariamente indispon/i.test(raw)) {
    return 'Este modulo esta temporariamente indisponivel no painel.';
  }
  if (/limite di[aá]rio/i.test(raw) && /atingid|esgotad/i.test(raw)) {
    return 'Limite diario deste modulo foi atingido. Tenta amanha.';
  }
  if (/saldo insuficiente|adicionar saldo/i.test(raw) && /pago/i.test(raw) && raw.length < 8000) {
    return 'Modulo pago: saldo da carteira insuficiente.';
  }
  const $ = cheerio.load(raw, { decodeEntities: true });
  $('script,style,svg,noscript,iframe').remove();
  $('img[src^="http"]').each((_, el) => {
    $(el).replaceWith(' [foto] ');
  });
  let text = $('body').text() || $.root().text() || '';
  text = text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/Revelar foto/gi, '')
    .replace(/Carregando[.….]*/gi, '')
    .replace(/\bDetalhes\b/g, '')
    .replace(/\bAtualiza[cç][aã]o\b/g, '')
    .trim();
  if (!text || text.length < 8) return 'Consulta sem dados visiveis.';
  if (text.length > TEXT_CAP) {
    text = `${text.slice(0, TEXT_CAP)}\n\n(corte: resultado grande. Afina o modulo ou pede de novo.)`;
  }
  return text;
}

function extractPhotos(html) {
  const urls = [];
  const re = /https?:\/\/[^"'\\\s>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s>]*)?/gi;
  const m = String(html || '').match(re) || [];
  for (const u of m) {
    if (/logo|icon|sprite|flag|avatar-placeholder/i.test(u)) continue;
    if (!urls.includes(u)) urls.push(u);
    if (urls.length >= 3) break;
  }
  return urls;
}

function parseUserInput(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const kv = {};
  const pos = [];
  for (const p of parts) {
    const hit = p.match(/^([a-z_]{2,20}):(.+)$/i);
    if (hit) kv[hit[1].toLowerCase()] = hit[2];
    else pos.push(p);
  }
  return { positional: pos.join(' '), kv };
}

function validateNeed(need, value) {
  const v = String(value || '').trim();
  const d = v.replace(/\D/g, '');
  switch (need) {
    case 'cpf':
      if (d.length !== 11) return 'CPF invalido. Use 11 digitos.';
      break;
    case 'cnpj':
      if (d.length !== 14) return 'CNPJ invalido. Use 14 digitos.';
      break;
    case 'cep':
      if (d.length !== 8) return 'CEP invalido. Use 8 digitos.';
      break;
    case 'tel': {
      let t = d;
      while (t.startsWith('55') && t.length > 11) t = t.slice(2);
      if (t.length !== 10 && t.length !== 11) return 'Telefone invalido. Use DDD + numero, sem 55.';
      break;
    }
    case 'placa':
      if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/i.test(v.replace(/[-\s]/g, ''))) {
        return 'Placa invalida. Ex: ABC1D23 ou ABC1234.';
      }
      break;
    case 'chassi':
      if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(v.replace(/\s/g, ''))) return 'Chassi invalido (17 caracteres).';
      break;
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'E-mail invalido.';
      break;
    case 'nome':
      if (v.length < 2 || v.length > 120) return 'Nome invalido (2 a 120 caracteres).';
      break;
    case 'digits':
      if (d.length < 6) return 'Informe o numero (so digitos).';
      break;
    case 'doc':
      if (d.length !== 11 && d.length !== 14) return 'Use CPF (11) ou CNPJ (14).';
      break;
    case 'optional':
    case 'kv':
    case 'text':
      break;
    default:
      if (!v) return 'Informe o valor da consulta.';
  }
  return null;
}

function supports(tipo) {
  if (!isEnabled()) return false;
  return !!getModule(tipo);
}

async function consultar(tipo, rawValue) {
  if (!isEnabled()) {
    return {
      success: false,
      message: 'Painel extra desligado (MIND7_ENABLED=0). Dono liga no .env da host quando o solver tiver saldo.'
    };
  }
  const mod = getModule(tipo);
  if (!mod) return { success: false, message: 'Modulo de consulta desconhecido.' };
  if (mod.unavailable) {
    return { success: false, message: 'Este modulo esta temporariamente indisponivel no painel.' };
  }

  const parsed = parseUserInput(rawValue);
  const primaryKeyGuess = mod.primary || 'documento';
  const primaryVal = parsed.positional || parsed.kv[primaryKeyGuess] || parsed.kv.q || parsed.kv.nome || '';
  if (mod.id === 'nascimento' && !parsed.kv.nasc && !parsed.kv.nascimento) {
    return { success: false, message: `Informe a data: nasc:DD/MM/AAAA\nUso: ${mod.usage}` };
  }
  const err = validateNeed(mod.need, primaryVal);
  if (err && mod.need !== 'optional' && mod.need !== 'kv') {
    return { success: false, message: `${err}\nUso: ${mod.usage}` };
  }
  if (mod.need === 'kv' && !Object.keys(parsed.kv).length && !primaryVal) {
    return { success: false, message: `Uso: ${mod.usage}` };
  }

  const run = async () => {
    if (!(await verifySession(false))) {
      try {
        await login(true);
      } catch (e) {
        const code = e && e.message ? e.message : 'erro';
        if (code === 'cloudflare' || code === 'captcha' || code === 'capsolver_key' || code === 'nsl_balance' || code === 'nsl_key') {
          return {
            success: false,
            message: code === 'capsolver_key'
              ? 'Capsolver: chave invalida ou sem acesso (ERROR_KEY_DENIED). Atualiza CAPSOLVER_API_KEY ou usa NSLSOLVER_API_KEY com saldo.'
              : code === 'nsl_balance'
                ? 'NSLSolver sem credito (balance=0). Confirma o e-mail em nslsolver.com (100 gratis) ou recarrega.'
                : code === 'nsl_key'
                  ? 'NSLSolver recusou a chave. Confere NSLSOLVER_API_KEY.'
                  : code === 'captcha'
                    ? 'Captcha bloqueou o painel. Precisa de solver com saldo (NSL/Capsolver) no .env da host.'
                    : 'Cloudflare neste IP da VPS. Cookie do PC nao vale — precisa login automatico com solver (NSL/Capsolver).'
          };
        }
        throw e;
      }
    }

    const pathMod = String(mod.path || '').startsWith('.')
      ? `/painel/${String(mod.path).replace(/^\.\.\//, '')}`
      : `/painel/consultas/${mod.path}/`;
    const pageUrl = `${BASE}${pathMod}${pathMod.endsWith('/') ? '' : '/'}`;

    async function fetchModulePage() {
      return http('GET', pageUrl, { headers: { Referer: `${BASE}/painel/` } });
    }

    let page = await fetchModulePage();
    let pageHtml2 = String(page.data || '');
    if (page.status === 403 || (looksLikeCf(pageHtml2) && pageHtml2.includes('Just a moment'))) {
      resetSessionCache();
      try {
        await login(true);
      } catch (e) {
        return {
          success: false,
          message: 'Cloudflare bloqueou. Cookie do navegador nao funciona na VPS — confere Capsolver ou sessao gerada na host.'
        };
      }
      page = await fetchModulePage();
      pageHtml2 = String(page.data || '');
      if (page.status === 403 || looksLikeCf(pageHtml2)) {
        return { success: false, message: 'Cloudflare bloqueou. Cookie do navegador nao funciona na VPS — confere Capsolver ou sessao gerada na host.' };
      }
    }
    if (/Acessar painel|cf-turnstile-response|Bem-vindo de volta/i.test(pageHtml2) && !/documento|meu-formulario/i.test(pageHtml2)) {
      resetSessionCache();
      await login(true);
      page = await fetchModulePage();
      pageHtml2 = String(page.data || '');
    }
    const tok = extractXToken(pageHtml2);
    if (tok) xToken = tok;

    const formMeta = parseFormFromHtml(pageHtml2);
    const primaryKey = mod.primary || formMeta?.primary || 'documento';
    const fields = { ...(formMeta?.defaults || {}), ...(mod.extra || {}) };
    if (primaryVal) fields[primaryKey] = primaryVal;
    for (const [k, v] of Object.entries(parsed.kv)) {
      const dest = (mod.aliasesArg && mod.aliasesArg[k]) || k;
      fields[dest] = v;
    }
    if (mod.need === 'placa' && fields[primaryKey]) {
      fields[primaryKey] = String(fields[primaryKey]).replace(/[-\s]/g, '').toUpperCase();
    }
    if ((mod.need === 'cpf' || mod.need === 'cnpj' || mod.need === 'cep' || mod.need === 'tel' || mod.need === 'doc') && fields[primaryKey]) {
      fields[primaryKey] = String(fields[primaryKey]).replace(/\D/g, '');
    }
    if (mod.need === 'doc') applyDocTipo(fields);
    if (!fields.termos_aceitos) fields.termos_aceitos = 'on';

    const ep = typeof mod.endpoint === 'function'
      ? mod.endpoint(fields)
      : (mod.endpoint || formMeta?.action || 'search.php');
    const postUrl = `${pageUrl}${ep}`;
    const body = new URLSearchParams(fields).toString();
    const res = await http('POST', postUrl, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BASE,
        Referer: pageUrl,
        'X-Requested-With': 'XMLHttpRequest',
        ...(xToken ? { 'X-Token': xToken } : {})
      },
      data: body
    });

    const html = String(res.data || '');
    if (res.status === 403 || (looksLikeCf(html) && /Just a moment|cf-turnstile/i.test(html))) {
      return { success: false, message: 'Cloudflare bloqueou a consulta. Renova o cookie no .env da host.' };
    }
    if (res.status >= 400) {
      const hint = htmlToText(html);
      const msg = hint && hint.length > 12 && !/^Consulta sem dados/i.test(hint)
        ? hint.slice(0, 500)
        : `Painel HTTP ${res.status}. Tenta de novo.`;
      return { success: false, message: msg };
    }
    const text = htmlToText(html);
    const photos = extractPhotos(html);
    saveSession();
    return { success: true, text, photos, htmlLen: html.length };
  };

  const job = queue.then(run, run);
  queue = job.catch(() => {});
  try {
    return await job;
  } catch (e) {
    const code = e && e.message ? e.message : 'erro';
    const map = {
      captcha: 'Sem solver. Gratis: SolverCF (1000 trial) ou NSL (100 apos e-mail) ou EzSolver no PC.',
      nsl_key: 'NSLSolver recusou a chave. Confere NSLSOLVER_API_KEY ou cria conta gratis em nslsolver.com.',
      nsl_balance: 'NSLSolver sem credito (balance=0). Confirma e-mail em nslsolver.com (100 gratis) ou recarrega.',
      solvercf_balance: 'SolverCF sem credito. Conta gratis em solvercf.com (1000 calls / 7 dias).',
      capsolver_key: 'Capsolver: chave invalida/sem acesso. Atualiza CAPSOLVER_API_KEY ou usa NSLSOLVER_API_KEY com saldo.',
      cloudflare: 'Cloudflare bloqueou neste IP da VPS. Cookie do PC nao vale — use NSL/Capsolver com saldo pra login automatico.',
      sem_cred: 'Painel extra sem login. Dono configura e-mail/senha no .env da host.',
      login: 'Login do painel recusado. Confere e-mail/senha no .env da host.',
      painel: 'Login passou mas o painel nao abriu. Sessao/captcha expirou.'
    };
    return { success: false, message: map[code] || 'Falha na consulta extra. Tenta de novo.' };
  }
}

loadSession();

function scheduleWarmup() {
  if (String(process.env.MIND7_WARMUP || '1') === '0') return;
  setTimeout(async () => {
    if (!isEnabled()) {
      logger.logInfo('[mind7] warmup skip (MIND7_ENABLED=0)');
      return;
    }
    if (!isConfigured()) return;
    try {
      if (await verifySession(true)) {
        logger.logInfo('[mind7] warmup painel ok');
        noteHealth(true);
        return;
      }
      await login(true);
      logger.logInfo('[mind7] warmup login ok');
      noteHealth(true);
    } catch (e) {
      noteHealth(false, e && e.message ? e.message : 'warmup');
      logger.logAviso(`[mind7] warmup falhou: ${e.message}`);
    }
  }, 55000);
}
scheduleWarmup();

module.exports = {
  isConfigured,
  isEnabled,
  getHealthDetail,
  supports,
  consultar,
  login,
  verifyCredentials,
  maskSecret,
  htmlToText
};
