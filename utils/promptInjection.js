'use strict';
/**
 * Defesa contra prompt injection / sintaxe fingindo instrucao interna.
 * User comum: descarta do Intent/IA (silencio). Dono/VIP: sanitiza e segue.
 * Nao pune sozinho. Nao responde "detectei injeção".
 */
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { getUserDir } = require('./userManager');

const MAX_LOG = 80;
const SNIPPET = 280;

function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function jsonPath(telegramUserId) {
  return path.join(getUserDir(telegramUserId), 'config', 'injectlog.json');
}

function loadLog(telegramUserId) {
  const uid = String(telegramUserId || '');
  if (!uid) return [];
  try {
    const store = require('./sqlStore');
    if (store.isReady()) {
      const hit = store.getCachedKv('injectlog', uid);
      if (Array.isArray(hit)) return hit;
    }
  } catch (_) { /* JSON */ }
  try {
    const p = jsonPath(uid);
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (_) { /* */ }
  return [];
}

function saveLog(telegramUserId, list) {
  const uid = String(telegramUserId || '');
  const arr = Array.isArray(list) ? list.slice(-MAX_LOG) : [];
  try { require('./sqlStore').upsertKv('injectlog', uid, arr); } catch (_) { /* */ }
  try {
    const p = jsonPath(uid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (e) {
    logger.logAviso(`[INJECT] save: ${e.message}`);
  }
}

const HIGH = [
  { id: 'role_marker', re: /(?:^|\n)\s*(system|assistant|developer|human)\s*:\s/i },
  { id: 'inst_tag', re: /\[\/?inst\]|<<\/?sys>>|<\|?(im_start|im_end|system|assistant)\|>/i },
  { id: 'xml_role', re: /<\/?(system|assistant|instruction)>/i },
  { id: 'ignore_prev', re: /ignor[ea]\s+(as\s+)?(instru[cç][oõ]es|instructions|regras)\s+(anteriores|previous|acima)/i },
  { id: 'reveal_prompt', re: /revel[ae]\s+(seu\s+|o\s+|the\s+)?(prompt|system\s*prompt|instru[cç])/i },
  { id: 'print_config', re: /print(e)?\s+(sua\s+|a\s+|the\s+)?(configura[cç]|system\s*prompt|schema)/i },
  { id: 'dev_mode', re: /\b(modo\s+desenvolvedor|developer\s+mode|jailbreak|dan\s+mode|modo\s+debug)\b/i },
  { id: 'fake_intent_json', re: /\{\s*"(tipo|type|comando|command)"\s*:\s*"(comando|command|nao_encontrado|resposta)"/i },
  { id: 'fake_fc', re: /<\/?function[_-]?call>|tool_calls\s*:|"name"\s*:\s*"(exec|run|invoke)/i }
];

const MEDIUM = [
  { id: 'quote_instr', re: /^\s*>+\s*.{0,40}(system|instru|ignor[ea]|prompt|developer|assistant)\b/im },
  { id: 'act_as', re: /\b(aja como|act as|voce agora e|you are now|finja ser|pretend to be)\b/i },
  { id: 'override', re: /\b(new instructions|override (the )?(system|prompt)|from now on you)\b/i },
  { id: 'fence_sys', re: /```(?:xml|system|prompt)?[\s\S]{0,80}(system|<<SYS>>|\[INST\])/i },
  { id: 'hidden_fn', re: /\b(funcao oculta|hidden (command|function)|ativar algo oculto|enable hidden)\b/i }
];

/**
 * @returns {{ hit: boolean, high: boolean, reasons: string[] }}
 */
function inspectInjection(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { hit: false, high: false, reasons: [] };
  const t = fold(raw);
  const reasons = [];
  let high = false;
  for (const p of HIGH) {
    if (p.re.test(raw) || p.re.test(t)) {
      reasons.push(p.id);
      high = true;
    }
  }
  for (const p of MEDIUM) {
    if (p.re.test(raw) || p.re.test(t)) reasons.push(p.id);
  }
  const hit = high || reasons.length >= 2;
  return { hit, high, reasons };
}

/** Neutraliza marcadores pra concatenar em prompt de IA (dono/VIP). */
function sanitizeUserText(text) {
  let s = String(text || '');
  s = s.replace(/\[\/?INST\]/gi, ' ');
  s = s.replace(/<<\/?SYS>>/gi, ' ');
  s = s.replace(/<\|[^>]+\|>/g, ' ');
  s = s.replace(/<\/?(system|assistant|instruction|function[_-]?call)>/gi, ' ');
  s = s.replace(/(?:^|\n)\s*(system|assistant|developer)\s*:/gi, '\n');
  s = s.replace(/^\s*>+\s?/gm, '');
  s = s.replace(/```+/g, "'");
  if (s.length > 4000) s = s.slice(0, 4000);
  return s.replace(/[ \t]+\n/g, '\n').trim();
}

function looksLikeInternalLeak(text) {
  const t = fold(text);
  if (!t) return false;
  if (/hanork_system|commands-schema|function-calling \(obrigatorio\)|wrappoolprompt/.test(t)) return true;
  if (/voce e hanork — nao e um assistente generico/.test(t)) return true;
  if (/\b(system prompt|prompt de sistema|instrucoes internas)\b/.test(t) &&
      /\b(aqui (est[aá]|vao|seguem)|segue abaixo|veja o|conteudo)\b/.test(t)) {
    return true;
  }
  return false;
}

const SAFE_REFUSAL = 'Nao falo de instrucao interna. Manda o que voce precisa no bot.';

function maskSender(s) {
  const str = String(s || '');
  if (str.includes('@lid')) return `lid…${str.slice(-6)}`;
  const d = str.replace(/\D/g, '');
  if (d.length >= 6) return `…${d.slice(-4)}`;
  return str.slice(0, 20);
}

function logInjectionAttempt(opts = {}) {
  const uid = String(opts.telegramUserId || '');
  if (!uid) return;
  const entry = {
    at: Date.now(),
    sender: maskSender(opts.sender || ''),
    chat: maskSender(opts.chatId || ''),
    group: !!opts.isGroup,
    reasons: Array.isArray(opts.reasons) ? opts.reasons.slice(0, 8) : [],
    snippet: String(opts.text || '').replace(/\s+/g, ' ').slice(0, SNIPPET)
  };
  const list = loadLog(uid);
  list.push(entry);
  saveLog(uid, list);
  logger.logAviso(
    `[INJECT] hit reasons=${entry.reasons.join(',') || '?'} ` +
    `sender=${entry.sender} chat=${entry.chat} group=${entry.group}`
  );
}

function listInjectionAttempts(telegramUserId, limit = 20) {
  const n = Math.min(40, Math.max(1, Number(limit) || 20));
  return loadLog(telegramUserId).slice(-n).reverse();
}

function formatInjectionLog(telegramUserId, limit = 15) {
  const rows = listInjectionAttempts(telegramUserId, limit);
  if (!rows.length) return 'Nenhuma tentativa registrada.';
  const lines = rows.map((e, i) => {
    const when = new Date(e.at).toISOString().replace('T', ' ').slice(0, 16);
    const where = e.group ? 'grupo' : 'pv';
    const why = (e.reasons || []).join(',') || '?';
    return `${i + 1}. ${when} UTC ${where} ${e.sender}\n   ${why}\n   ${e.snippet || ''}`;
  });
  return `Tentativas de injecao (ultimas ${rows.length})\n${lines.join('\n')}`;
}

function isKnownBotCommand(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  try {
    const { getCommand } = require('../commands');
    if (getCommand(n)) return true;
  } catch (_) { /* */ }
  try {
    const { getCommandConfig } = require('../core/router/universalRouter');
    if (getCommandConfig(n)) return true;
  } catch (_) { /* */ }
  return false;
}

module.exports = {
  inspectInjection,
  sanitizeUserText,
  looksLikeInternalLeak,
  SAFE_REFUSAL,
  logInjectionAttempt,
  listInjectionAttempts,
  formatInjectionLog,
  isKnownBotCommand
};
