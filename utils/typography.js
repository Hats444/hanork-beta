// utils/typography.js
// Tipografia monoespaçada unicode (estilo vant noir) — labels/headers
// Valores dinâmicos ficam em texto normal.

const MONO_AZ = 0x1d670; // 𝙰
const MONO_az = 0x1d68a; // 𝚊
const MONO_09 = 0x1d7f6; // 𝟶

/** Remove acentos (fonte preview nao suporta) — ASCII PT. */
function stripAccents(input) {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Antes: Mathematical Monospace (𝙰𝚊). Em muitos celulares/Telegram
 * (tema escuro, fonte do sistema) isso vira texto invisivel ou quadrado.
 * Agora: ASCII normal.
 */
function toMono(input) {
  return String(input ?? '');
}

/** Titulos/labels: sem acento, letras normais (legivel em qualquer tela). */
function previewText(input) {
  return stripAccents(input);
}

/** Tira "1. " / "2)" / "#3 " no comeco do label — WA mostra isso como indice cru. */
function stripRawIndex(input) {
  return String(input || '')
    .replace(/^\s*#?\d+[\.\)\:\-\uFF0E]\s+/, '')
    .replace(/^\s*#\d+\s+/, '')
    .trim();
}

function looksLikeCallbackId(input) {
  return /^(cmd_|div_|menu_|tg_|sec_|info_|join_|figc_|btn_)/i.test(String(input || '').trim());
}

/** Corta por letra (code point), nao por unidade UTF-16 — mono SMP e 2 unidades. */
function takeChars(input, max) {
  const chars = [...String(input ?? '')];
  const n = Number(max);
  const cap = Number.isFinite(n) && n > 0 ? n : 24;
  if (chars.length <= cap) return chars.join('');
  return chars.slice(0, cap).join('');
}

/**
 * Titulo de botao/lista: mesmo helper em TODO o bot.
 * Corta o ASCII ANTES do mono (senao slice UTF-16 come metade da palavra
 * e "Configurar Texto/CTA/Midia" viram o mesmo "Configurar").
 */
function buttonTitle(input, fallback = 'Opcao', max = 24) {
  let s = stripRawIndex(input);
  if (!s || looksLikeCallbackId(s)) s = String(fallback || 'Opcao');
  s = stripRawIndex(s);
  if (!s) s = String(fallback || 'Opcao');
  const n = Number(max);
  const cap = Number.isFinite(n) && n > 0 ? n : 24;
  return previewText(takeChars(stripAccents(s), cap));
}

function buttonLabel(input, fallback = 'Opcao') {
  return buttonTitle(input, fallback, 20);
}

/** CTA nativo: ASCII sem mono (mono no chip nativo vira indice cru ao mudar de tela). */
function nativeButtonLabel(input, fallback = 'Opcao', max = 20) {
  let s = stripRawIndex(input);
  if (!s || looksLikeCallbackId(s)) s = String(fallback || 'Opcao');
  s = stripRawIndex(s);
  if (!s) s = String(fallback || 'Opcao');
  const n = Number(max);
  const cap = Number.isFinite(n) && n > 0 ? n : 20;
  return takeChars(stripAccents(s), cap);
}

/** Corpo de nativeFlow: ASCII sem mono (mono no body quebra ACK do WA). */
function nativeFlowBody(input) {
  return stripAccents(String(input || '')).trim();
}

/**
 * Label monoespaçado + valor normal
 * Ex: labelValue('Buscando', 'beatles') => "𝙱𝚞𝚜𝚌𝚊𝚗𝚍𝚘: beatles"
 */
function labelValue(label, value) {
  const L = previewText(String(label || '').trim());
  if (value === undefined || value === null || value === '') return L;
  return `${L}: ${String(value)}`;
}

/**
 * Bloco de status (titulo mono + linhas label/valor)
 * @param {string} title
 * @param {Array<[string, string|number]|string>} rows
 */
function formatStatusBlock(title, rows = []) {
  const lines = [];
  if (title) lines.push(toMono(title));
  for (const row of rows) {
    if (typeof row === 'string') {
      lines.push(row);
    } else if (Array.isArray(row)) {
      lines.push(labelValue(row[0], row[1]));
    }
  }
  return lines.join('\n');
}

/**
 * Header limpo (titulo preview) — sem caixas/ornamentos
 */
function vantHeader(title) {
  return previewText(String(title || '').trim());
}

/** Mantido por compat; vazio (sem rodape ornamental) */
function vantFooter() {
  return '';
}

/**
 * Relatorio: titulo mono + corpo (sem ╭━━ / ╰━━)
 */
function formatReportBlock(title, bodyLines = []) {
  const parts = [];
  const head = vantHeader(title);
  if (head) parts.push(head);
  for (const line of bodyLines) {
    if (line === null || line === undefined) continue;
    const s = String(line);
    if (!s) continue;
    parts.push(s);
  }
  return parts.join('\n');
}

/** Alias pedido no prompt (tabela char-a-char = toMono) */
const toMonospace = toMono;

module.exports = {
  stripAccents,
  toMono,
  toMonospace,
  previewText,
  stripRawIndex,
  looksLikeCallbackId,
  buttonLabel,
  buttonTitle,
  nativeButtonLabel,
  nativeFlowBody,
  labelValue,
  formatStatusBlock,
  vantHeader,
  vantFooter,
  formatReportBlock,
  formatReportBlock: formatReportBlock
};
module.exports['formatReportBlock'] = formatReportBlock;
module.exports['formatReportBlock'] = formatReportBlock;
