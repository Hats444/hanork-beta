// commands/consultas.js
// Consultas CheckData (so as 5 APIs ativas da conta). WhatsApp + Telegram.

require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { SEARCH_MAX } = require('../utils/searchQueryLimit');

// Registro de comandos — usa o padrão do projeto (execute + useCtx)
const commands = {};

/** Nomes que nao podem virar atalho de consulta (colisao com outros cmds) */
const CONSULTA_RESERVED = new Set([
  'consulta', 'menu_consultas', 'email', 'sms', 'otp', 'call', 'lista',
  'adddest', 'remdest', 'startloop', 'stoploop', 'statusloop', 'banco'
]);

/** Atalhos CheckData — o router marca VIP/dono (nenhuma consulta fica USER). */
const CONSULTA_COMMAND_NAMES = new Set(['cpf', 'cpfbasico', 'cpfcompleto', 'cpf2', 'nome', 'placa', 'telefone', 'mind7', 'm7']);
const PUBLIC_CONSULTA_TIPOS = new Set(['cep', 'cnpj', 'ip']);
const CONSULTA_DENY = 'Consultas so dono e VIP.';

function canUseConsulta(ctx) {
  if (
    ctx?.isOwner ||
    ctx?.isVip ||
    ctx?.isPlatformAdmin ||
    ctx?.authRole === 'platform_admin' ||
    ctx?.authRole === 'owner' ||
    ctx?.authRole === 'vip'
  ) return true;
  try {
    const { sessionProductTier, hasTier } = require('../services/billing/tiers');
    return hasTier(sessionProductTier(ctx), 'starter');
  } catch (_) {
    return false;
  }
}

function isPiiConsultaTipo(tipo) {
  const t = String(tipo || '').toLowerCase().trim();
  if (!t || PUBLIC_CONSULTA_TIPOS.has(t)) return false;
  if (CONSULTA_COMMAND_NAMES.has(t)) return true;
  if (t === 'tel' || t === 'fone' || t === 'celular' || t === 'cpf3') return true;
  try {
    if (require('../services/mind7Catalog').getModule(t)) return true;
  } catch (_) { /* catalogo opcional */ }
  return false;
}

function isTelegramGroupChat(chatId, chat) {
  const kind = String(chat?.type || '').toLowerCase();
  if (kind === 'group' || kind === 'supergroup') return true;
  const n = Number(chatId);
  return Number.isFinite(n) && n < 0;
}

function isWaGroupJid(jid) {
  return /@g\.us$/i.test(String(jid || ''));
}

async function sendConsultaVisible(conn, from, info, text) {
  return conn.sendMessage(from, { text }, { quoted: info, skipForward: true });
}

async function runConsultaWa(conn, ctx, tipo, value) {
  const from = ctx.from || ctx.info?.key?.remoteJid;
  if (!from) return;
  if (!canUseConsulta(ctx)) {
    return sendConsultaVisible(conn, from, ctx.info, CONSULTA_DENY);
  }
  const userId = ctx.sender || ctx.from || from;
  const p = require('../utils/configManager').prefixFromCtx(ctx);
  const PUBLIC_TIPOS = PUBLIC_CONSULTA_TIPOS;
  if (tipo && PUBLIC_TIPOS.has(String(tipo).toLowerCase())) {
    const zone = require('./zoneConsultas');
    const cmd = zone.commands[String(tipo).toLowerCase()];
    if (cmd?.execute) {
      const next = { ...ctx, text: value, args: String(value || '').split(/\s+/).filter(Boolean) };
      return cmd.execute(conn, next);
    }
  }
  const { createWhatsAppStatus } = require('../utils/statusProgress');
  const { sendAsChannel } = require('../utils/channelForward');
  if (!tipo) {
    // Menu de consultas: 1 lista visivel, sem status/canal (overlimit comia o recado).
    return menuConsultas(
      ctx.info || { key: { remoteJid: from } },
      conn,
      p,
      ctx.telegramUserId,
      ctx
    );
  }
  if (!value) {
    await sendConsultaVisible(
      conn,
      from,
      ctx.info,
      `Uso: ${p}${tipo} <valor>\nOu: ${p}consulta ${tipo} <valor>\nLista: ${p}menu_consultas`
    );
    return;
  }
  logger.logInfo(`[consulta] dest=group=${isWaGroupJid(from) ? 1 : 0}`);
  const status = await createWhatsAppStatus(conn, from, ctx.info, 'CONSULTA', {
    forwardFinal: true
  });
  const result = await executarConsulta(tipo, value, 'whatsapp', userId, null, status, {
    role: ctx.isOwner || ctx.authRole === 'owner' ? 'owner' : ctx.isVip || ctx.authRole === 'vip' ? 'vip' : 'user',
    isOwner: !!ctx.isOwner,
    isVip: !!ctx.isVip
  });
  if (result?.imageUrl) {
    try {
      await sendAsChannel(conn, from, {
        image: { url: result.imageUrl },
        caption: 'Foto da consulta'
      }, { quoted: ctx.info });
    } catch (e) {
      logger.logAviso(`[consulta] falha ao enviar foto: ${e.message}`);
    }
  }
}

function parseConsultaTipoValor(ctx) {
  // ctx.text = args apos o comando (ex: "cpf 123" ou so "123" no atalho)
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  const text = String(ctx.text || '').trim();
  if (args.length >= 2) {
    return { tipo: String(args[0]).toLowerCase(), value: args.slice(1).join(' ') };
  }
  if (args.length === 1 && text) {
    // ".consulta cpf123" raro; normalmente args[0]=tipo e falta valor
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return { tipo: parts[0].toLowerCase(), value: parts.slice(1).join(' ') };
    }
    return { tipo: String(args[0]).toLowerCase(), value: '' };
  }
  if (text) {
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return { tipo: parts[0].toLowerCase(), value: parts.slice(1).join(' ') };
    }
    return { tipo: parts[0]?.toLowerCase() || '', value: '' };
  }
  return { tipo: '', value: '' };
}

commands.consulta = {
  useCtx: true,
  description: 'Consulta API. Uso: consulta <tipo> <valor> ou cpf <valor>',
  usage: 'consulta <tipo> <valor>',
  execute: async (conn, ctx) => {
    if (!canUseConsulta(ctx)) {
      return sendConsultaVisible(conn, ctx.from, ctx.info, CONSULTA_DENY);
    }
    const { tipo, value } = parseConsultaTipoValor(ctx);
    return runConsultaWa(conn, ctx, tipo, value);
  }
};

commands.menu_consultas = {
  useCtx: true,
  description: 'Mostra o menu de consultas disponiveis',
  usage: 'menu_consultas',
  execute: async (conn, ctx) => {
    const from = ctx.from || ctx.info?.key?.remoteJid;
    if (!from) return;
    if (!canUseConsulta(ctx)) {
      return sendConsultaVisible(conn, from, ctx.info, CONSULTA_DENY);
    }
    await menuConsultas(
      ctx.info || { key: { remoteJid: from } },
      conn,
      require('../utils/configManager').prefixFromCtx(ctx),
      ctx.telegramUserId,
      ctx
    );
  }
};
commands.consultas = commands.menu_consultas;

commands.mind7 = commands.menu_consultas;
commands.m7 = commands.menu_consultas;

// Configuracoes — so as 5 APIs CheckData liberadas na conta (painel /apis Ativas)
const API_CONFIG = {
  checkdata: {
    baseUrl: String(process.env.CHECKDATA_API_BASE || 'https://checkdata.vip').replace(/\/$/, ''),
    token: (process.env.CHECKDATA_API_TOKEN || '').trim(),
    tokenEnv: 'CHECKDATA_API_TOKEN',
    authParam: 'token',
    prefix: 'api',
    endpoints: {
      cpf_basico: { param: 'query', label: 'CPF Basico', category: 'pessoal' },
      cpf_completo_v3: { param: 'query', label: 'CPF Completo', category: 'pessoal' },
      nome_online: { param: 'query', label: 'Nome Online', category: 'pessoal' },
      placa_completa: { param: 'query', label: 'Placa Completa', category: 'veiculo' },
      telefone_endereco: { param: 'query', label: 'Telefone + Endereco', category: 'contato' }
    }
  }
};

// Categorias para menu
const CATEGORIES = {
  pessoal: {
    label: 'Pessoal',
    icon: '👤',
    endpoints: ['cpf', 'cpfcompleto', 'nome']
  },
  contato: {
    label: 'Contato',
    icon: '📞',
    endpoints: ['telefone']
  },
  veiculo: {
    label: 'Veiculo',
    icon: '🚗',
    endpoints: ['placa']
  }
};

// Logger de consultas
const CONSULTAS_LOG = path.join(__dirname, '../logs/consultas.log');

function maskConsultaParam(param) {
  const d = String(param || '').replace(/\D/g, '');
  if (d.length >= 11) return `${d.slice(0, 3)}***${d.slice(-2)}`;
  if (d.length >= 8) return `${d.slice(0, 2)}***`;
  const s = String(param || '');
  if (s.length > 6) return `${s.slice(0, 2)}***`;
  return s ? '***' : '';
}

function logConsulta(api, endpoint, param, userId, platform, result, responseTimeMs) {
  const timestamp = new Date().toISOString();
  const status = result.success ? 'OK' : (result.statusCode || 'ERRO');
  const uid = String(userId || '').slice(-4) || 'n/a';
  const logLine = `[${timestamp}] [${platform.toUpperCase()}] [${api.toUpperCase()}] ${endpoint} | User:..${uid} | Status: ${status} | Tempo: ${responseTimeMs}ms | q=${maskConsultaParam(param)}\n`;
  
  try {
    if (!fs.existsSync(path.dirname(CONSULTAS_LOG))) {
      fs.mkdirSync(path.dirname(CONSULTAS_LOG), { recursive: true });
    }
    fs.appendFileSync(CONSULTAS_LOG, logLine);
  } catch (e) {
    logger.logErro('LOG_CONSULTA', e.message);
  }
}

// ===== VALIDAÇÕES =====
function apenasDigitos(v) { return String(v || '').replace(/\D/g, ''); }

function validateCPF(cpf) {
  const c = apenasDigitos(cpf);
  return c.length === 11 && /^\d+$/.test(c);
}

function validateCNPJ(cnpj) {
  const c = apenasDigitos(cnpj);
  return c.length === 14 && /^\d+$/.test(c);
}

function validateTelefone(telefone) {
  const t = normalizeTelefoneQuery(telefone);
  return t.length === 10 || t.length === 11;
}

/**
 * CheckData telefone: DDD + numero (10/11). 55 na frente devolve 400.
 */
function normalizeTelefoneQuery(telefone) {
  let t = String(telefone || '').replace(/\D/g, '');
  if (t.startsWith('00')) t = t.replace(/^00+/, '');
  if (t.startsWith('0') && t.length >= 11) t = t.replace(/^0+/, '');
  // CheckData: DDD+numero (10/11). Qualquer 55 extra vira 400.
  while (t.startsWith('55') && t.length > 11) t = t.slice(2);
  return t;
}

function validateCEP(cep) {
  return apenasDigitos(cep).length === 8;
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email || '').trim());
}

function validateRG(rg) {
  const r = apenasDigitos(rg);
  return r.length >= 7 && r.length <= 10 && /^\d+$/.test(r);
}

function validatePlaca(placa) {
  // Mercosul: ABC1D23 ou ABC1234
  const re = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/i;
  return re.test(String(placa || '').trim());
}

function validateBIN(bin) {
  const b = apenasDigitos(bin);
  return b.length >= 6 && b.length <= 8 && /^\d+$/.test(b);
}

function validateCNH(cnh) {
  const c = apenasDigitos(cnh);
  return c.length === 11 && /^\d+$/.test(c);
}

function validateChassi(chassi) {
  const s = String(chassi || '').trim().toUpperCase();
  return s.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/.test(s);
}

function validateDDD(ddd) {
  const d = apenasDigitos(ddd);
  return d.length === 2 && /^\d{2}$/.test(d);
}

function validatePIS(pis) {
  const p = apenasDigitos(pis);
  return p.length === 11 && /^\d+$/.test(p);
}

function validateNIS(nis) {
  return validatePIS(nis);
}

function validateTitulo(titulo) {
  const t = apenasDigitos(titulo);
  return t.length >= 12 && t.length <= 13 && /^\d+$/.test(t);
}

function validateBanco(codigo) {
  const b = apenasDigitos(codigo);
  return b.length >= 3 && b.length <= 4 && /^\d+$/.test(b);
}

function validateCPFList(lista) {
  const cpfs = String(lista || '').split(',').map(c => c.trim()).filter(Boolean);
  if (cpfs.length === 0) return false;
  return cpfs.every(c => validateCPF(c));
}

// ===== CONSTRUÇÃO DA URL =====
function buildUrl(apiName, endpointKey, value) {
  const apiConfig = API_CONFIG[apiName];
  const ep = apiConfig.endpoints[endpointKey];
  if (!ep) return null;

  const endpointPath = String(ep.endpoint || endpointKey).replace(/^\//, '');

  if (apiName === 'checkdata') {
    const tokenKey = apiConfig.authParam || 'token';
    return `${apiConfig.baseUrl}/api/${endpointPath}?query=${encodeURIComponent(value)}&${tokenKey}=${encodeURIComponent(apiConfig.token)}`;
  }

  if (apiName === 'duck') {
    if (ep.noParam) {
      return `${apiConfig.baseUrl}/${endpointPath}?apitoken=${apiConfig.token}`;
    }
    return `${apiConfig.baseUrl}/${endpointPath}?${ep.param}=${encodeURIComponent(value)}&apitoken=${apiConfig.token}`;
  }

  // Hanork API: docs usam /consultas/serasa/... ; vip/* fica na raiz
  const needsConsultasPrefix =
    !endpointPath.startsWith('consultas/') &&
    !endpointPath.startsWith('vip/') &&
    !endpointPath.startsWith('api/');
  const prefix = String(apiConfig.prefix || 'consultas').replace(/^\/|\/$/g, '');
  const fullPath = needsConsultasPrefix ? `${prefix}/${endpointPath}` : endpointPath;

  if (ep.noParam) {
    return `${apiConfig.baseUrl}/${fullPath}?apikey=${apiConfig.token}`;
  }
  return `${apiConfig.baseUrl}/${fullPath}?query=${encodeURIComponent(value)}&apikey=${apiConfig.token}`;
}

// ===== FUNÇÃO PRINCIPAL DE CONSULTA =====
async function consultaAPI(apiName, endpoint, value) {
  const apiConfig = API_CONFIG[apiName];
  if (!apiConfig) {
    return { success: false, message: `API ${apiName} nao configurada` };
  }

  if (!apiConfig.token) {
    const envName = apiConfig.tokenEnv || 'API_TOKEN';
    logger.logAviso(`[CONSULTA] Token ausente: configure ${envName} no .env`);
    return {
      success: false,
      message: `Consulta indisponivel: configure ${envName} no .env`
    };
  }

  const endpointConfig = apiConfig.endpoints[endpoint];
  if (!endpointConfig) {
    return { success: false, message: `Endpoint ${endpoint} nao encontrado` };
  }

  const url = buildUrl(apiName, endpoint, value);
  if (!url) {
    return { success: false, message: 'Falha ao montar URL da consulta' };
  }

  const startTime = Date.now();

  try {
    const { sanitizeBrand, scrubApiData, looksLikeHtml } = require('../utils/brandSanitize');
    const safeUrl = String(url)
      .replace(String(apiConfig.token || ''), '***')
      .replace(/([?&](?:query|q|token|apikey|cpf|telefone|nome|placa)=)[^&]+/gi, '$1***');
    logger.logInfo(`[CONSULTA] ${apiName} ${endpoint} → ${safeUrl}`);
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      // texto cru: evita axios engolir HTML como "data" opaco
      responseType: 'text',
      transformResponse: [(d) => d],
      validateStatus: () => true
    });

    const responseTimeMs = Date.now() - startTime;
    const raw = response.data;
    const ct = String(response.headers?.['content-type'] || '');

    if (raw === null || raw === undefined || raw === '') {
      return { success: false, message: 'Resposta vazia da API', responseTimeMs };
    }

    const rawStr = typeof raw === 'string' ? raw : String(raw);
    if (/text\/html/i.test(ct) || looksLikeHtml(rawStr)) {
      logger.logAviso(`[CONSULTA] HTML em vez de JSON status=${response.status} api=${apiName} ep=${endpoint}`);
      return {
        success: false,
        message: 'API retornou pagina HTML (endpoint offline ou path incorreto)',
        statusCode: response.status,
        responseTimeMs
      };
    }

    let data;
    try {
      data = JSON.parse(rawStr);
    } catch (e) {
      logger.logAviso(`[CONSULTA] JSON parse fail api=${apiName} ep=${endpoint} head=${rawStr.slice(0, 80)}`);
      return {
        success: false,
        message: 'Resposta da API nao e JSON valido',
        statusCode: response.status,
        responseTimeMs
      };
    }

    data = scrubApiData(data);

    if (apiName === 'checkdata') {
      const code = Number(data?.code || data?.status || response.status) || response.status;
      if (data?.error === true || code >= 400) {
        const rawMsg = String(data?.message || data?.details?.title || '').trim();
        let msg = rawMsg;
        if (code === 400) msg = msg || 'Dado invalido pra esta consulta.';
        else if (code === 402) msg = 'Saldo insuficiente nesta consulta.';
        else if (code === 403) msg = 'Esta consulta nao esta liberada na conta.';
        else if (code === 404) msg = 'Nenhum resultado encontrado.';
        else if (code === 429) msg = 'Limite diario desta consulta. Tenta depois da meia-noite.';
        else if (code === 500) msg = 'Consulta instavel agora. Tenta de novo.';
        else msg = sanitizeBrand(msg || `Erro HTTP ${code}`);
        return { success: false, message: msg, statusCode: code, data, responseTimeMs };
      }
      const payload = data?.resultado != null ? data.resultado : data;
      return { success: true, message: 'Consulta realizada com sucesso', data: payload, responseTimeMs };
    }

    // Duck: { erro: true, mensagem: "..." }
    if (data?.erro === true || data?.error === true) {
      const msg = sanitizeBrand(
        data.mensagem || data.message || (typeof data.error === 'string' ? data.error : 'Falha na consulta')
      );
      return { success: false, message: msg, statusCode: response.status, data, responseTimeMs };
    }

    const providerMsg =
      (typeof data?.error === 'string' && data.error) ||
      (typeof data?.mensagem === 'string' && data.mensagem) ||
      (typeof data?.message === 'string' && data.message) ||
      null;

    // HTTP 4xx/5xx com JSON de erro (ZT usa 404 + "Nenhum resultado...")
    if (response.status >= 400) {
      const msg = sanitizeBrand(providerMsg || `Erro HTTP ${response.status}`);
      if (/nenhum resultado|n[aã]o encontrado|not found/i.test(msg)) {
        return { success: false, message: 'Nenhum resultado encontrado', statusCode: response.status, data, responseTimeMs };
      }
      return { success: false, message: msg, statusCode: response.status, data, responseTimeMs };
    }

    if (providerMsg && !data.result && !data.dados && !data.data && !data.resultado) {
      if (/nenhum resultado|n[aã]o encontrado|not found/i.test(providerMsg)) {
        return { success: false, message: 'Nenhum resultado encontrado', data, responseTimeMs };
      }
      return { success: false, message: sanitizeBrand(providerMsg), data, responseTimeMs };
    }

    return { success: true, message: 'Consulta realizada com sucesso', data, responseTimeMs };
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    if (error.code === 'ECONNABORTED') {
      return { success: false, message: 'Timeout — a API demorou demais para responder', statusCode: 'TIMEOUT', responseTimeMs };
    }
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH') {
      return { success: false, message: 'API indisponivel — falha de conexao', statusCode: 'NETWORK', responseTimeMs };
    }
    if (error.response) {
      const status = error.response.status;
      const map = {
        400: 'Requisicao invalida (400)',
        401: 'Nao autorizado (401)',
        403: 'Acesso proibido (403)',
        404: 'Endpoint nao encontrado (404)',
        429: 'Muitas requisicoes (429) — aguarde alguns segundos',
        500: 'Erro interno da API (500)',
        502: 'API retornou Bad Gateway (502)',
        503: 'API indisponivel (503)',
      };
      return { success: false, message: map[status] || `Erro HTTP ${status}`, statusCode: status, responseTimeMs };
    }
    return { success: false, message: `Erro de conexao: ${error.message}`, statusCode: 'NETWORK', responseTimeMs };
  }
}

// ===== FORMATADOR COMPLETO (arvore inteira, sem dropar nested) =====
const RESULTADO_EXCLUDE = new Set([
  'error', 'erro', 'status', 'message', 'mensagem', 'success', 'timestamp',
  'execution_time', 'executionTime', 'process_time', 'query_time', 'cache', 'raw',
  'criador', 'creator', 'credit', 'credits', 'powered_by', 'poweredBy',
  'developer', 'consumed', 'code'
]);
const FORMAT_MAX_DEPTH = 24;

function formatKey(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

function isSkippedKey(key) {
  return RESULTADO_EXCLUDE.has(key) || RESULTADO_EXCLUDE.has(String(key).toLowerCase());
}

function isEmptyValue(value) {
  return value === null || value === undefined || value === '';
}

function unwrapPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (data.resultado != null && typeof data.resultado === 'object') return data.resultado;
  if (data.data != null && typeof data.data === 'object') return data.data;
  if (data.dados != null && typeof data.dados === 'object') return data.dados;
  if (data.result != null && typeof data.result === 'object') return data.result;
  return data;
}

function allScalarValues(obj) {
  return Object.values(obj).every((v) => isEmptyValue(v) || typeof v !== 'object');
}

function formatScalarLine(indent, key, value, sanitizeBrand) {
  return sanitizeBrand(`${indent}${formatKey(key)}: ${value}`);
}

function formatNode(value, depth, indent, seen, sanitizeBrand) {
  if (isEmptyValue(value)) return '';
  if (typeof value !== 'object') return sanitizeBrand(String(value));
  if (seen.has(value)) return `${indent}(ciclo)`;
  if (depth > FORMAT_MAX_DEPTH) return `${indent}${JSON.stringify(value)}`;

  seen.add(value);

  if (Array.isArray(value)) {
    if (!value.length) return '';
    const parts = [];
    const numbered = value.length > 1;
    value.forEach((item, i) => {
      if (isEmptyValue(item)) return;
      const prefix = numbered ? `${indent}${i + 1}. ` : indent;
      if (typeof item !== 'object') {
        parts.push(sanitizeBrand(`${prefix}${item}`));
        return;
      }
      if (!Array.isArray(item) && allScalarValues(item)) {
        const bits = Object.entries(item)
          .filter(([k, v]) => !isSkippedKey(k) && !isEmptyValue(v))
          .map(([k, v]) => `${formatKey(k)}: ${v}`);
        if (bits.length) parts.push(sanitizeBrand(`${prefix}${bits.join(' · ')}`));
        return;
      }
      if (numbered) parts.push(`${indent}${i + 1}.`);
      const inner = formatNode(item, depth + 1, indent + (numbered ? '  ' : ''), seen, sanitizeBrand);
      if (inner) parts.push(inner);
    });
    return parts.filter(Boolean).join('\n');
  }

  const lines = [];
  for (const [key, val] of Object.entries(value)) {
    if (isSkippedKey(key) || isEmptyValue(val)) continue;
    if (typeof val !== 'object') {
      lines.push(formatScalarLine(indent, key, val, sanitizeBrand));
      continue;
    }
    if (Array.isArray(val)) {
      if (!val.length) continue;
      const allScalar = val.every((x) => isEmptyValue(x) || typeof x !== 'object');
      if (allScalar) {
        const joined = val.filter((x) => !isEmptyValue(x)).join(', ');
        if (joined) lines.push(sanitizeBrand(`${indent}${formatKey(key)}: ${joined}`));
        continue;
      }
      lines.push(`${indent}${formatKey(key)}:`);
      const inner = formatNode(val, depth + 1, indent + '  ', seen, sanitizeBrand);
      if (inner) lines.push(inner);
      continue;
    }
    const inner = formatNode(val, depth + 1, indent + '  ', seen, sanitizeBrand);
    if (inner) {
      lines.push(`${indent}${formatKey(key)}:`);
      lines.push(inner);
    }
  }
  return lines.join('\n');
}

function formatarResultado(_endpoint, data) {
  if (data == null || data === '') return 'Nenhum dado disponivel';
  const { sanitizeBrand } = require('../utils/brandSanitize');
  const root = unwrapPayload(data);
  if (Array.isArray(root)) {
    if (!root.length) return 'Nenhum resultado encontrado';
    const body = formatNode(root.length === 1 ? root[0] : root, 0, '', new WeakSet(), sanitizeBrand);
    if (!body) return 'Nenhum dado disponivel';
    if (root.length > 1) return `${root.length} resultados\n\n${body}`;
    return body;
  }
  const body = formatNode(root, 0, '', new WeakSet(), sanitizeBrand);
  return body || 'Nenhum dado disponivel';
}

// ===== RESOLUÇÃO DE ENDPOINT SIMPLIFICADA =====
// Mapeia nomes simples do usuário para os endpoints correspondentes
const SIMPLE_ENDPOINT_MAP = {
  cpf: { api: 'checkdata', endpoint: 'cpf_basico' },
  cpfbasico: { api: 'checkdata', endpoint: 'cpf_basico' },
  cpfcompleto: { api: 'checkdata', endpoint: 'cpf_completo_v3' },
  cpf2: { api: 'checkdata', endpoint: 'cpf_completo_v3' },
  nome: { api: 'checkdata', endpoint: 'nome_online' },
  placa: { api: 'checkdata', endpoint: 'placa_completa' },
  telefone: { api: 'checkdata', endpoint: 'telefone_endereco' }
};

/** Atalhos extras → tipo do SIMPLE_ENDPOINT_MAP */
const CONSULTA_EXTRA_ALIASES = {
  tel: 'telefone',
  fone: 'telefone',
  cpfcompleto: 'cpfcompleto',
  cpf3: 'cpfcompleto'
};

/** Ficha rapida fica nesta API; dossie usa outros cmds (cpffull, buscanome, celular, placafull). */
const CHECKDATA_OWNED = new Set([
  'cpf', 'cpfbasico', 'cpfcompleto', 'cpf2', 'cpf3', 'nome', 'placa', 'telefone', 'tel', 'fone'
]);

function registerConsultaShortcuts() {
  const names = new Set([
    ...Object.keys(SIMPLE_ENDPOINT_MAP),
    ...Object.keys(CONSULTA_EXTRA_ALIASES)
  ]);

  for (const raw of names) {
    const cmdName = String(raw).replace(/\//g, '_').toLowerCase();
    if (!cmdName || CONSULTA_RESERVED.has(cmdName)) continue;
    if (commands[cmdName]) continue;

    const mapped = CONSULTA_EXTRA_ALIASES[cmdName] || CONSULTA_EXTRA_ALIASES[raw];
    const resolvedTipo = mapped || (SIMPLE_ENDPOINT_MAP[cmdName] ? cmdName : raw);
    if (!SIMPLE_ENDPOINT_MAP[resolvedTipo]) continue;

    commands[cmdName] = {
      useCtx: true,
      description: `Consulta ${resolvedTipo} (atalho)`,
      usage: `${cmdName} <valor>`,
      execute: async (conn, ctx) => {
        const value = String(ctx.text || (Array.isArray(ctx.args) ? ctx.args.join(' ') : '') || '').trim();
        return runConsultaWa(conn, ctx, resolvedTipo, value);
      }
    };
    CONSULTA_COMMAND_NAMES.add(cmdName);
  }
}

registerConsultaShortcuts();

function registerMind7Shortcuts() {
  try {
    const { allCommandNames, getModule } = require('../services/mind7Catalog');
    for (const raw of allCommandNames()) {
      const cmdName = String(raw).replace(/\//g, '_').toLowerCase();
      if (!cmdName || CONSULTA_RESERVED.has(cmdName)) continue;
      CONSULTA_COMMAND_NAMES.add(cmdName);
      if (commands[cmdName]) continue;
      const mod = getModule(cmdName);
      commands[cmdName] = {
        useCtx: true,
        description: mod ? mod.desc : `Consulta ${cmdName}`,
        usage: (mod && mod.usage) || `${cmdName} <valor>`,
        execute: async (conn, ctx) => {
          const value = String(ctx.text || (Array.isArray(ctx.args) ? ctx.args.join(' ') : '') || '').trim();
          return runConsultaWa(conn, ctx, cmdName, value);
        }
      };
    }
  } catch (e) {
    logger.logAviso(`[consulta] mind7 catalogo off: ${e.message}`);
  }
}
registerMind7Shortcuts();
try { require('../services/mind7Client'); } catch (e) {
  logger.logAviso(`[consulta] mind7 boot: ${e.message}`);
}

// ===== VALIDAÇÃO POR TIPO DE CONSULTA =====
function validarValor(tipoConsulta, value) {
  const v = String(value || '').trim();
  switch (tipoConsulta) {
    case 'cpf': case 'cpf2': case 'cpfcompleto': case 'cpfbasico': case 'cpffull': case 'cpfbd': case 'dossie':
      if (!validateCPF(v.split(/\s+/)[0] || v)) return 'CPF invalido. Use 11 digitos numericos.';
      break;
    case 'nome': case 'buscanome':
      if (v.length < 2 || v.length > SEARCH_MAX) return `Nome invalido. Deve ter entre 2 e ${SEARCH_MAX} caracteres.`;
      break;
    case 'telefone': case 'tel': case 'fone':
      if (!validateTelefone(v)) return 'Telefone invalido. Use DDD + numero (ex: 11 99999-9999). Sem precisa do 55.';
      break;
    case 'placa': case 'placafull': case 'placadetran': case 'placapro': case 'crlv': case 'multas':
      if (!validatePlaca(v.split(/\s+/)[0] || v)) return 'Placa invalida. Formato Mercosul: ABC1D23 ou ABC1234.';
      break;
    case 'nascimento': case 'nasc':
      if (!/\bnasc(?:imento)?:\s*\d{2}\/\d{2}\/\d{4}/i.test(v)) {
        return 'Informe a data: nasc:DD/MM/AAAA (ex: nascimento Maria nasc:01/01/1990 uf:SP).';
      }
      if (!/[a-zA-Z\u00C0-\u024F]{2,}/.test(v.replace(/\bnasc(?:imento)?:\S+/gi, ''))) {
        return 'Informe o nome completo antes da data.';
      }
      break;
    case 'emprego': case 'dividas': case 'serasa': case 'frota': case 'processos': case 'processos2':
      if (!/^\d{11,14}$/.test(v.replace(/\D/g, ''))) return 'Use CPF (11 digitos) ou CNPJ (14 digitos).';
      break;
    case 'chassi':
      if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(v.replace(/\s/g, ''))) return 'Chassi invalido (17 caracteres).';
      break;
    case 'renavam':
      if (v.replace(/\D/g, '').length < 9) return 'RENAVAM invalido.';
      break;
    case 'donoemail': case 'emailmind':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.split(/\s+/)[0])) return 'E-mail invalido.';
      break;
  }
  return null;
}

// ===== FUNÇÃO DE SANITIZAÇÃO DE HTML =====
// Sanitiza HTML para evitar erros de parse entities no Telegram
function sanitizeHtml(text) {
  if (!text || typeof text !== 'string') return text;
  
  // Remove tags HTML não suportadas pelo Telegram
  // Telegram suporta: <b>, <i>, <u>, <s>, <strike>, <code>, <pre>, <a>, <tg-spoiler>
  const allowedTags = ['b', 'i', 'u', 's', 'strike', 'code', 'pre', 'a', 'tg-spoiler'];
  
  // Remove tags não permitidas mantendo o conteúdo
  let sanitized = text.replace(/<(\w+)[^>]*>/gi, (match, tag) => {
    const lowerTag = tag.toLowerCase();
    if (allowedTags.includes(lowerTag)) {
      return match; // Mantém tag permitida
    }
    return ''; // Remove tag não permitida
  });
  
  // Fecha tags HTML que ficaram abertas após remoção
  // Remove tags de fechamento órfãs
  sanitized = sanitized.replace(/<\/(\w+)>/gi, (match, tag) => {
    const lowerTag = tag.toLowerCase();
    if (allowedTags.includes(lowerTag)) {
      return match; // Mantém tag de fechamento permitida
    }
    return ''; // Remove tag de fechamento não permitida
  });
  
  // Escapa caracteres especiais que podem causar problemas
  sanitized = sanitized.replace(/&(?!(amp|lt|gt|quot|apos);)/g, '&amp;');
  
  return sanitized;
}

function extractImageFromData(data) {
  if (!data) return null;
  const candidates = [];
  const walk = (obj, depth = 0) => {
    if (!obj || depth > 4) return;
    if (typeof obj === 'string') {
      if (/^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(obj) || /\/foto|image|img/i.test(obj) && /^https?:\/\//i.test(obj)) {
        candidates.push(obj);
      }
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, depth + 1));
      return;
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (/foto|image|img|url|link|base64/i.test(k) && typeof v === 'string' && v.length > 8) {
          candidates.push(v);
        }
        walk(v, depth + 1);
      }
    }
  };
  walk(data);
  return candidates[0] || null;
}

async function executarMind7(tipoLower, value, platform, userId, responder, status) {
  const mind7 = require('../services/mind7Client');
  if (status) {
    await status.setRows([
      ['Estado', 'consultando'],
      ['Tipo', tipoLower],
      ['Fonte', 'painel']
    ]);
  } else if (responder) {
    await responder('Consultando...');
  }
  const startTime = Date.now();
  const result = await mind7.consultar(tipoLower, value);
  logConsulta('mind7', tipoLower, value, userId, platform, {
    success: !!result.success,
    statusCode: result.success ? 200 : 400
  }, Date.now() - startTime);
  if (!result.success) {
    const msg = result.message || 'Falha na consulta do painel.';
    if (status) await status.finish(msg);
    else if (responder) await responder(msg);
    return { success: false, message: msg };
  }
  const plain = String(result.text || 'Sem dados.');
  const imageUrl = (result.photos && result.photos[0]) || null;
  if (status) await status.finish(plain);
  else if (responder) {
    const { splitTextParts } = require('../utils/textChunks');
    const { TG_TEXT_MAX, WA_TEXT_MAX } = require('../utils/statusProgress');
    const parts = splitTextParts(plain, platform === 'telegram' ? TG_TEXT_MAX : WA_TEXT_MAX);
    for (let i = 0; i < parts.length; i++) {
      const body = parts.length > 1 ? `(${i + 1}/${parts.length})\n${parts[i]}` : parts[i];
      await responder(body, i === 0 && imageUrl ? { imageUrl } : undefined);
    }
  }
  // Nao-retencao: ficha nao volta no objeto (so meta + URL de foto se houver)
  return { success: true, message: 'ok', imageUrl };
}

// ===== FUNÇÃO CENTRAL DE CONSULTA (WhatsApp e Telegram) =====
async function executarConsulta(tipo, value, platform = 'whatsapp', userId = null, responder = null, status = null, opts = null) {
  const tipoLower = String(tipo || '').toLowerCase().trim();
  const resolved = SIMPLE_ENDPOINT_MAP[tipoLower];

  try {
    if (!PUBLIC_CONSULTA_TIPOS.has(tipoLower) && String(process.env.HANORK_CONSULTA_QUOTA || '1') !== '0') {
      const role = (opts && opts.role) || (opts && opts.isOwner ? 'owner' : opts && opts.isVip ? 'vip' : 'vip');
      const q = require('../utils/consultaQuota').checkAndConsume(userId, role, platform);
      if (!q.ok) {
        if (status) await status.finish(q.message);
        else if (responder) await responder(q.message);
        return { success: false, message: q.message };
      }
    }
  } catch (_) { /* quota opcional */ }

  try {
    const mind7 = require('../services/mind7Client');
    if (!CHECKDATA_OWNED.has(tipoLower) && mind7.supports(tipoLower)) {
      const validationError = validarValor(tipoLower, value);
      if (validationError) {
        if (status) await status.finish(validationError);
        else if (responder) await responder(validationError);
        return { success: false, message: validationError };
      }
      if (mind7.isConfigured()) {
        return await executarMind7(tipoLower, value, platform, userId, responder, status);
      }
      const msg = 'Painel extra sem login. Dono configura e-mail/senha (ou cookie da sessao) no .env da host.';
      if (status) await status.finish(msg);
      else if (responder) await responder(msg);
      return { success: false, message: msg };
    }
  } catch (e) {
    logger.logAviso(`[consulta] painel extra: ${e.message}`);
  }

  if (!resolved) {
    const msg = 'Consulta nao encontrada. Use menu_consultas para ver a lista.';
    if (status) await status.finish(msg);
    else if (responder) await responder(msg);
    return null;
  }

  // Validação de entrada
  const validationError = validarValor(tipoLower, value);
  if (validationError) {
    if (status) await status.finish(validationError);
    else if (responder) await responder(validationError);
    return null;
  }

  // Normaliza query no formato que a CheckData aceita
  let queryValue = String(value || '').trim();
  if (
    /telefone|operadora/i.test(tipoLower) ||
    /telefone|operadora/i.test(resolved.endpoint)
  ) {
    if (!/cpf|massa|email/i.test(tipoLower)) {
      queryValue = normalizeTelefoneQuery(value) || value;
    }
  } else if (/^(cpf|cpf2|cpfcompleto|cpfbasico)$/i.test(tipoLower)) {
    queryValue = apenasDigitos(value);
  } else if (/^placa$/i.test(tipoLower)) {
    queryValue = String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  } else if (/^nome$/i.test(tipoLower)) {
    queryValue = String(value || '').replace(/\s+/g, ' ').trim();
  }

  if (status) {
    await status.setRows([
      ['Estado', 'consultando'],
      ['Tipo', tipoLower],
      ['Valor', '***']
    ]);
  } else if (responder) {
    await responder('Consultando...');
  }

  const startTime = Date.now();
  const result = await consultaAPI(resolved.api, resolved.endpoint, queryValue);
  const responseTimeMs = Date.now() - startTime;

  // Log da consulta (audit: quem/quando/cmd — sem ficha)
  logConsulta(resolved.api, resolved.endpoint, queryValue, userId, platform, result, responseTimeMs);

  let output;
  let imageUrl = null;
  if (result.success) {
    const formatted = formatarResultado(resolved.endpoint, result.data);
    const tipoLabel = API_CONFIG[resolved.api]?.endpoints[resolved.endpoint]?.label || tipoLower;
    output = sanitizeHtml(`<b>${tipoLabel}</b>\n\n${formatted}`);
  } else {
    output = sanitizeHtml(`Erro na consulta: ${result.message}`);
  }

  const plain = String(output || '').replace(/<[^>]+>/g, '');
  if (status) {
    await status.finish(plain);
  } else if (responder) {
    const { splitTextParts } = require('../utils/textChunks');
    const { TG_TEXT_MAX, WA_TEXT_MAX } = require('../utils/statusProgress');
    const parts = splitTextParts(plain, platform === 'telegram' ? TG_TEXT_MAX : WA_TEXT_MAX);
    if (parts.length > 1) {
      await responder(`Consulta em ${parts.length} partes.`);
    }
    for (let i = 0; i < parts.length; i++) {
      const body = parts.length > 1 ? `(${i + 1}/${parts.length})\n${parts[i]}` : parts[i];
      await responder(body, i === 0 && imageUrl ? { imageUrl } : undefined);
    }
  }

  // Politica nao-retencao: resultado so no PV; retorno sem data/output
  try {
    if (result && Object.prototype.hasOwnProperty.call(result, 'data')) delete result.data;
  } catch (_) { /* ignore */ }
  return {
    success: !!result.success,
    message: result.success ? 'ok' : (result.message || 'erro'),
    imageUrl,
    responseTimeMs
  };
}

// ===== COMANDO WHATSAPP =====
async function comandoConsulta(msg, conn, args) {
  const p = '.';
  if (args.length < 2) {
    return await conn.sendMessage(msg.key.remoteJid, {
      text: `Uso: ${p}consulta <tipo> <valor>\n\nExemplos:\n${p}consulta cpf 12345678901\n${p}consulta nome Maria Silva\n${p}consulta telefone 11987654321\n\nUse ${p}menu_consultas para ver os tipos disponiveis.`
    });
  }

  const tipo = args[0];
  const value = args.slice(1).join(' ');
  const userId = msg.key.participant || msg.key.remoteJid;
  const dest = msg.key.remoteJid;

  await executarConsulta(tipo, value, 'whatsapp', userId, async (texto, meta) => {
    if (meta?.imageUrl) {
      await conn.sendMessage(msg.key.remoteJid, { image: { url: meta.imageUrl }, caption: String(texto).replace(/<[^>]+>/g, '') });
    } else {
      await conn.sendMessage(msg.key.remoteJid, { text: String(texto).replace(/<[^>]+>/g, '') });
    }
  });
}

// ===== COMANDO TELEGRAM =====
async function comandoConsultaTelegram(telegramUserId, chatId, args, bot) {
  if (args.length < 2) {
    return await bot.sendMessage(chatId,
      'Uso: /consulta <tipo> <valor>\n\nExemplos:\n/consulta cpf 12345678901\n/consulta nome Maria Silva\n/consulta telefone 11987654321\n\nUse o menu de consultas para ver os tipos disponiveis.',
      { parse_mode: 'HTML' }
    );
  }

  const tipo = args[0];
  const value = args.slice(1).join(' ');
  const { createTelegramStatus } = require('../utils/statusProgress');
  const dest = chatId;
  const status = await createTelegramStatus(bot, dest, 'CONSULTA');

  const result = await executarConsulta(tipo, value, 'telegram', telegramUserId, null, status, {
    isGroup: false,
    role: 'vip'
  });
  if (result?.imageUrl) {
    try {
      await bot.sendPhoto(dest, result.imageUrl, { caption: 'Foto da consulta' });
    } catch (e) {
      logger.logAviso(`[consulta-tg] falha ao enviar foto: ${e.message}`);
    }
  }
}

function formatConsultaMenu(prefix = '.') {
  const { previewText, stripAccents } = require('../utils/typography');
  const { menuLines } = require('../services/mind7Catalog');
  const p = prefix || '.';
  const lines = [
    previewText('MENU DE CONSULTAS'),
    'Dono e VIP. Digite o comando com o valor.',
    '',
    previewText('Endereco / empresa / IP'),
    stripAccents(`  ${p}cep <8 digitos> — endereco pelo CEP`),
    stripAccents(`  ${p}cnpj <14 digitos> — dados da empresa`),
    stripAccents(`  ${p}ip <ipv4> — geo/ASN do IP`),
    stripAccents(`  ${p}ttkstalk <user> — perfil TikTok`),
    stripAccents(`  ${p}infoff <uid> — info Free Fire`),
    '',
    previewText('Ficha rapida'),
    stripAccents(`  ${p}cpf <11 digitos> — ficha basica`),
    stripAccents(`  ${p}cpfcompleto <11 digitos> — ficha completa`),
    stripAccents(`  ${p}nome <nome completo> — achar CPF pelo nome`),
    stripAccents(`  ${p}telefone <ddd+numero> — telefone + endereco`),
    stripAccents(`  ${p}placa <ABC1D23> — veiculo pela placa`),
    '',
    previewText('Dossie e extras'),
    ...((() => {
      try {
        const m7 = require('../services/mind7Client');
        if (typeof m7.isEnabled === 'function' && !m7.isEnabled()) {
          return [stripAccents('  (painel extra off — so ficha CheckData)')];
        }
      } catch (_) { /* ignore */ }
      return menuLines(p).map((ln) => stripAccents(ln));
    })()),
    stripAccents(`Filtros: mae:Maria uf:SP  |  Ex: ${p}cep 01001000`)
  ];
  return lines.join('\n');
}

function consultaMenuParts(prefix = '.', maxLen) {
  const { splitTextParts } = require('../utils/textChunks');
  const { WA_TEXT_MAX } = require('../utils/statusProgress');
  return splitTextParts(formatConsultaMenu(prefix), maxLen || WA_TEXT_MAX);
}

async function menuConsultas(msg, conn, prefix = '.', telegramUserId = null, viewer = null) {
  const jid = msg?.key?.remoteJid;
  if (!jid) return;
  const { sendCategoryPanel, resolveMenuViewerRole } = require('../utils/menuCatalog');
  try {
    return await sendCategoryPanel(conn, {
      catId: 'consultas',
      chatId: jid,
      quoted: msg,
      telegramUserId,
      sessionId: conn?._sessionId,
      isGroup: /@g\.us$/i.test(String(jid)),
      viewerRole: viewer?.viewerRole || resolveMenuViewerRole(viewer || {}, telegramUserId),
      viewerCtx: viewer
    });
  } catch (e) {
    logger.logAviso(`[consulta] menu nativo falhou (${e.message}) — texto`);
    const parts = consultaMenuParts(prefix);
    let last = null;
    for (const part of parts) {
      last = await conn.sendMessage(jid, { text: part }, { quoted: msg, skipForward: true });
    }
    return last;
  }
}

// ===== MENU DE CONSULTAS (botões para Telegram) =====
function getMenuConsultasTelegram() {
  const buttons = [];
  for (const [catKey, cat] of Object.entries(CATEGORIES)) {
    buttons.push([{ text: `${cat.icon} ${cat.label}`, callback_data: `consulta_cat_${catKey}` }]);
  }
  buttons.push([{ text: '❌ Fechar', callback_data: 'close' }]);
  return buttons;
}

function getMenuCategoriaTelegram(catKey) {
  const cat = CATEGORIES[catKey];
  if (!cat) return null;

  const text = `${cat.icon} <b>${cat.label}</b>\n\nEscolha uma consulta:\n\nUse <code>/consulta <tipo> <valor></code>\n\nEx: <code>/consulta cpf 12345678901</code>`;

  const buttons = [];
  const seen = new Set();
  for (const ep of cat.endpoints) {
    const key = ep.includes('/') ? ep : (SIMPLE_ENDPOINT_MAP[ep] ? ep : null);
    if (key && !seen.has(key)) {
      seen.add(key);
      buttons.push([{ text: key, callback_data: `consulta_key_${key}` }]);
    }
  }
  buttons.push([{ text: '🔙 Voltar', callback_data: 'menu_consultas' }, { text: '❌ Fechar', callback_data: 'close' }]);

  return { text, buttons };
}

module.exports = {
  commands,
  CONSULTA_COMMAND_NAMES,
  canUseConsulta,
  SIMPLE_ENDPOINT_MAP,
  comandoConsulta,
  comandoConsultaTelegram,
  formatConsultaMenu,
  consultaMenuParts,
  menuConsultas,
  getMenuConsultasTelegram,
  getMenuCategoriaTelegram,
  executarConsulta,
  isPiiConsultaTipo,
  isTelegramGroupChat,
  CATEGORIES,
  API_CONFIG,
  consultaAPI,
  logConsulta,
  formatarResultado,
  validarValor
};