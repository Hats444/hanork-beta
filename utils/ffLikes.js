'use strict';
/**
 * Likes Free Fire — multi-provedor com fallback e cooldown por (provedor + UID).
 * Nao e servidor Express. Usado pelo comando .likeff.
 * Provedores pagos (loja) so entram se tiver chave no env.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('../logger');
const { nyxToken } = require('./zoneClient');

const REGIOES = Object.freeze(['br', 'sg', 'ind', 'id', 'tw', 'us', 'sac', 'th', 'me', 'pk', 'cis', 'bd']);
const COOLDOWN_6H = 6 * 60 * 60 * 1000;
const SCOPE = 'ff_likes';
const DISK = path.join(__dirname, '..', 'data', 'system', 'ff-likes.json');

const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

function pickUa() {
  return UA[Math.floor(Math.random() * UA.length)];
}

function uidOnly(s) {
  return String(s || '').replace(/\D/g, '').slice(0, 16);
}

function normRegion(s) {
  const r = String(s || 'br').trim().toLowerCase();
  return REGIOES.includes(r) ? r : 'br';
}

function loadDisk() {
  try {
    if (!fs.existsSync(DISK)) return {};
    const raw = JSON.parse(fs.readFileSync(DISK, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}

function saveDisk(map) {
  try {
    const dir = path.dirname(DISK);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DISK, JSON.stringify(map));
  } catch (e) {
    logger.logAviso(`[ffLikes] persist: ${e.message}`);
  }
}

function getMap() {
  try {
    const store = require('./sqlStore');
    if (store.isReady()) {
      const hit = store.getCachedKv(SCOPE, 'cooldowns');
      if (hit && typeof hit === 'object') return hit;
    }
  } catch (_) { /* */ }
  return loadDisk();
}

function putMap(map) {
  saveDisk(map);
  try {
    const store = require('./sqlStore');
    if (store.isReady()) store.upsertKv(SCOPE, 'cooldowns', map);
  } catch (_) { /* */ }
}

function cooldownLeft(map, uid, provider) {
  const ts = Number(map?.[uid]?.[provider]?.ultimoPedido || 0);
  if (!ts) return 0;
  const cool = Number(map?.[uid]?.[provider]?.cooldownMs || 0);
  return Math.max(0, ts + cool - Date.now());
}

function markSent(map, uid, provider, cooldownMs) {
  if (!map[uid] || typeof map[uid] !== 'object') map[uid] = {};
  map[uid][provider] = { ultimoPedido: Date.now(), cooldownMs: Number(cooldownMs) || COOLDOWN_6H };
  putMap(map);
}

function fmtWait(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min`;
  return `${s}s`;
}

async function tryNyx(uid) {
  const token = nyxToken();
  if (!token) return { skip: true, reason: 'sem_token' };
  const res = await axios.get('https://nyxlikesff.store/like', {
    params: { uid, token },
    timeout: 25000,
    validateStatus: () => true
  });
  if (res.status >= 400) {
    return { ok: false, reason: `http_${res.status}` };
  }
  const d = res.data || {};
  const msg = String(d.message || d.resultado || d.result || d.msg || 'Pedido enviado.').slice(0, 240);
  const fail = /erro|fail|invalid|limit|cooldown|aguarde/i.test(msg) && !/sucesso|success|enviad/i.test(msg);
  if (fail) return { ok: false, reason: 'api', message: msg };
  return { ok: true, provider: 'nyx', message: msg, cooldownMs: COOLDOWN_6H };
}

async function tryFreefiremania(uid, region) {
  const res = await axios.post(
    'https://www.freefiremania.com.br/paginas/free-fire-ferramenta-ganhar-likes-add.php',
    { id: uid, regiao: region },
    {
      timeout: 30000,
      validateStatus: () => true,
      headers: {
        'User-Agent': pickUa(),
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Origin: 'https://www.freefiremania.com.br',
        Referer: 'https://www.freefiremania.com.br/ganhar-likes-free-fire.html'
      }
    }
  );
  const d = res.data || {};
  if (res.status >= 400) return { ok: false, reason: `http_${res.status}` };
  if (String(d.status || '').toLowerCase() === 'success') {
    const nick = String(d.nickname_utilizado || '').slice(0, 40);
    const sent = d.sucessos_enviados != null ? String(d.sucessos_enviados) : '';
    const acc = d.likes_acumulados_no_banco != null ? String(d.likes_acumulados_no_banco) : '';
    const bits = ['Like enviado (freefiremania).'];
    if (nick) bits.push(`Nick: ${nick}`);
    if (sent) bits.push(`Enviados: ${sent}`);
    if (acc) bits.push(`Acumulado: ${acc}`);
    return { ok: true, provider: 'freefiremania', message: bits.join('\n'), cooldownMs: COOLDOWN_6H };
  }
  return { ok: false, reason: 'api', message: String(d.message || d.mensagem || 'resposta invalida').slice(0, 160) };
}

function extraProviders() {
  const raw = String(process.env.FF_LIKES_EXTRA || '').trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((p) => p && p.name && p.baseURL && p.endpoint);
  } catch (_) {
    logger.logAviso('[ffLikes] FF_LIKES_EXTRA JSON invalido');
    return [];
  }
}

async function tryExtra(p, uid, region) {
  const url = String(p.baseURL).replace(/\/$/, '') + (String(p.endpoint).startsWith('/') ? p.endpoint : '/' + p.endpoint);
  const method = String(p.method || 'POST').toUpperCase();
  const idField = p.idField || 'id';
  const regionField = p.regionField || 'regiao';
  const body = { [idField]: uid, [regionField]: region };
  const opts = {
    timeout: Number(p.timeoutMs) || 25000,
    validateStatus: () => true,
    headers: {
      'User-Agent': pickUa(),
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json'
    }
  };
  const res = method === 'GET'
    ? await axios.get(url, { ...opts, params: body })
    : await axios.post(url, body, opts);
  if (res.status >= 400) return { ok: false, reason: `http_${res.status}` };
  const d = res.data || {};
  const st = String(d.status || d.sucesso || d.success || '').toLowerCase();
  const ok = st === 'success' || st === 'true' || st === '1' || d.status === true;
  if (!ok) return { ok: false, reason: 'api' };
  return {
    ok: true,
    provider: String(p.name).slice(0, 24),
    message: String(d.message || d.mensagem || `Like enviado (${p.name}).`).slice(0, 240),
    cooldownMs: Number(p.cooldownMs) || COOLDOWN_6H
  };
}

function providerOrder() {
  const raw = String(process.env.FF_LIKES_ORDER || 'nyx,freefiremania').trim();
  const names = raw.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return names.length ? names : ['nyx', 'freefiremania'];
}

/**
 * Tenta provedores em ordem. Pula cooldown. Primeiro sucesso encerra.
 */
async function enviarLike(uidRaw, regionRaw) {
  const uid = uidOnly(uidRaw);
  const region = normRegion(regionRaw);
  if (uid.length < 8) {
    return { ok: false, code: 400, message: 'UID invalido. Use so numeros (8+).' };
  }

  const map = getMap();
  const tries = [];
  const extras = extraProviders();
  const order = providerOrder();
  const extraNames = extras.map((p) => String(p.name).toLowerCase());
  for (const name of extraNames) {
    if (!order.includes(name)) order.push(name);
  }

  for (const name of order) {
    const left = cooldownLeft(map, uid, name);
    if (left > 0) {
      tries.push(`${name}: cooldown ${fmtWait(left)}`);
      continue;
    }
    try {
      let out;
      if (name === 'nyx') out = await tryNyx(uid);
      else if (name === 'freefiremania') out = await tryFreefiremania(uid, region);
      else {
        const p = extras.find((x) => String(x.name).toLowerCase() === name);
        if (!p) {
          tries.push(`${name}: nao configurado`);
          continue;
        }
        out = await tryExtra(p, uid, region);
      }
      if (out?.skip) {
        tries.push(`${name}: ${out.reason || 'sem_token'}`);
        continue;
      }
      if (out?.ok) {
        markSent(map, uid, name, out.cooldownMs);
        logger.logInfo(`[ffLikes] ok provider=${name}`);
        return { ok: true, code: 200, provider: name, message: out.message, tries };
      }
      const detail = out?.message ? ` — ${String(out.message).slice(0, 80)}` : '';
      tries.push(`${name}: ${out?.reason || 'falhou'}${detail}`);
    } catch (e) {
      tries.push(`${name}: rede`);
      logger.logAviso(`[ffLikes] ${name}: ${e.message}`);
    }
  }

  const allCool = tries.length && tries.every((t) => /cooldown/.test(t));
  const noNyx = tries.some((t) => /sem_token/.test(t));
  const captcha = tries.some((t) => /captcha/i.test(t));
  let message = allCool
    ? 'Todos os provedores em espera. Tente mais tarde.'
    : 'Nenhum provedor enviou agora.';
  if (!allCool && noNyx) {
    message = captcha
      ? 'NYX sem token no host (NYX_FF_TOKEN). Freefiremania pediu captcha — nao e fallback automatico.'
      : 'NYX sem token no host (NYX_FF_TOKEN). Sem token o like nao sai.';
  }
  return {
    ok: false,
    code: allCool ? 429 : 503,
    message,
    tries
  };
}

module.exports = {
  REGIOES,
  uidOnly,
  normRegion,
  enviarLike,
  fmtWait
};
