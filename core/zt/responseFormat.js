// core/zt/responseFormat.js — extrai texto/lista/midia da API (nunca JSON cru ao user)
'use strict';

const { formatReportBlock, labelValue, previewText, stripAccents } = require('../../utils/typography');
const { sanitizeBrand, sanitizeAiOutput } = require('../../utils/brandSanitize');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asNonEmptyString(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

/**
 * Campo de texto util para IA / respostas simples.
 */
function pickTextField(data) {
  if (data == null) return null;
  if (typeof data === 'string') return asNonEmptyString(data);

  if (!isPlainObject(data)) return null;

  const directKeys = [
    'resposta', 'response', 'answer', 'output', 'texto', 'text',
    'message', 'mensagem', 'content', 'reply', 'result_text'
  ];
  for (const k of directKeys) {
    const s = asNonEmptyString(data[k]);
    if (s) return s;
  }

  // resultado / result pode ser string OU objeto com texto
  for (const wrap of ['resultado', 'result', 'data']) {
    const w = data[wrap];
    if (typeof w === 'string') {
      const s = asNonEmptyString(w);
      if (s) return s;
    }
    if (isPlainObject(w)) {
      for (const k of directKeys) {
        const s = asNonEmptyString(w[k]);
        if (s) return s;
      }
    }
  }

  return null;
}

/**
 * Lista (search etc.) — top N itens como objetos rasos.
 */
function pickListItems(data, limit = 8) {
  if (!data) return [];
  let arr = null;
  if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.resultado)) arr = data.resultado;
  else if (Array.isArray(data.result)) arr = data.result;
  else if (Array.isArray(data.data)) arr = data.data;
  else if (Array.isArray(data.results)) arr = data.results;
  else if (isPlainObject(data.resultado) && Array.isArray(data.resultado.lista)) {
    arr = data.resultado.lista;
  }
  if (!arr || !arr.length) return [];
  return arr.slice(0, Math.max(1, limit));
}

function itemLabel(it, idx) {
  if (typeof it === 'string') return `${idx}. ${it}`;
  if (!isPlainObject(it)) return `${idx}. ${String(it)}`;
  const title =
    it.titulo || it.title || it.name || it.nome || it.query || it.username || it.id || `item ${idx}`;
  const extra =
    it.link || it.url || it.desc || it.description || it.sinopse || it.artist || it.artista || '';
  const t = String(title).slice(0, 80);
  const e = extra ? ` — ${String(extra).slice(0, 100)}` : '';
  return `${idx}. ${t}${e}`;
}

function isApiErrorPayload(data) {
  if (!isPlainObject(data)) return false;
  if (data.status === false || data.erro === true || data.error === true) return true;
  if (data.status === 404 || data.status === 'error') return true;
  return false;
}

function apiErrorMessage(data) {
  if (!data) return 'Falha na API';
  const msg =
    asNonEmptyString(data.mensagem) ||
    asNonEmptyString(data.message) ||
    asNonEmptyString(data.error) ||
    asNonEmptyString(data.erro) ||
    asNonEmptyString(data.msg) ||
    'Falha na API';
  return sanitizeBrand(stripAccents(msg));
}

/**
 * Formata resposta para o usuario (sem JSON.stringify do objeto).
 * @returns {{ kind: 'text'|'list'|'empty'|'error', text: string }}
 */
function formatApiUserText(entry, data, opts = {}) {
  const title = String(entry?.menuLabel || entry?.cmd || 'API').toUpperCase();
  const listLimit = opts.listLimit || 8;

  if (isApiErrorPayload(data)) {
    return {
      kind: 'error',
      text: formatReportBlock(title, [labelValue('Erro', apiErrorMessage(data))])
    };
  }

  const codeLike = /code|poem|generate-code|generate-poem|iacode|iapoem/i.test(
    String(entry?.cmd || '') + String(entry?.path || '')
  );

  const text = pickTextField(data);
  if (text) {
    const body = codeLike
      ? `${previewText(title)}\n\n\`\`\`\n${sanitizeAiOutput(text)}\n\`\`\``
      : formatReportBlock(title, [sanitizeAiOutput(text)]);
    return { kind: 'text', text: body };
  }

  const items = pickListItems(data, listLimit);
  if (items.length) {
    const lines = items.map((it, i) => itemLabel(it, i + 1));
    const more = (() => {
      const all = pickListItems(data, 999);
      return all.length > listLimit ? `\n… +${all.length - listLimit} itens` : '';
    })();
    return {
      kind: 'list',
      text: formatReportBlock(title, [lines.join('\n') + more])
    };
  }

  // Objeto com poucos campos uteis (consulta / detalhe)
  if (isPlainObject(data)) {
    const skip = new Set([
      'status', 'criador', 'creator', 'sucesso', 'success', 'erro', 'error',
      'apikey', 'key', 'token'
    ]);
    const src = isPlainObject(data.resultado)
      ? data.resultado
      : isPlainObject(data.result)
        ? data.result
        : isPlainObject(data.data)
          ? data.data
          : data;
    const rows = [];
    for (const [k, v] of Object.entries(src)) {
      if (skip.has(k)) continue;
      if (v == null || v === '') continue;
      if (typeof v === 'object') continue;
      rows.push(labelValue(String(k).slice(0, 24), String(v).slice(0, 200)));
      if (rows.length >= 20) break;
    }
    if (rows.length) {
      return { kind: 'text', text: formatReportBlock(title, rows) };
    }
  }

  return {
    kind: 'empty',
    text: formatReportBlock(title, [stripAccents('Sem dados uteis na resposta.')])
  };
}

module.exports = {
  pickTextField,
  pickListItems,
  formatApiUserText,
  isApiErrorPayload,
  apiErrorMessage
};
