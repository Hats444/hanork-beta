// utils/evolution/classify.js — comando → familia / categoria
'use strict';

const { CMD_FAMILY, COSTLY_CMDS, FAIL_ALTS } = require('./constants');

function normalizeCmd(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^[.\/!#•]+/, '')
    .split(/\s+/)[0] || '';
}

function familyOf(command) {
  const c = normalizeCmd(command);
  if (!c) return 'other';
  if (CMD_FAMILY[c]) return CMD_FAMILY[c];
  if (c.startsWith('anti') || c.startsWith('mod')) return 'protecao';
  if (c.startsWith('div') || c.startsWith('nuke')) return 'div';
  if (c.startsWith('host') || c.startsWith('menu_')) return 'admin';
  if (c.startsWith('fig') || c.includes('sticker')) return 'sticker';
  if (/^(cpf|nome|telefone|placa|cnpj|email)/.test(c)) return 'consulta';
  return 'other';
}

function isCostly(command) {
  const c = normalizeCmd(command);
  if (COSTLY_CMDS.has(c)) return true;
  const fam = familyOf(c);
  return fam === 'ia' || fam === 'consulta' || fam === 'div' || fam === 'canal';
}

function failAlt(command) {
  const c = normalizeCmd(command);
  return FAIL_ALTS[c] || null;
}

/** Heuristica: erro de router/handler = fail; senao ok */
function outcomeFromError(error) {
  if (!error) return 'ok';
  const e = String(error).toLowerCase();
  if (/permissao|nao autorizado|apenas|restrit|rate\s*limit|aguarde|input invalido|nao disponivel/.test(e)) {
    return 'denied';
  }
  return 'fail';
}

module.exports = {
  normalizeCmd,
  familyOf,
  isCostly,
  failAlt,
  outcomeFromError
};
